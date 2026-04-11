# Multi-Asset Redemption Support

**Date:** 2026-04-11
**Status:** Draft
**Scope:** Express.sol, IAssetRegistry.sol, AssetRegistry.sol

## Problem

Express currently supports a single `redeemAsset` (e.g., USDC) for all redemptions. Users need the ability to choose which asset they receive when redeeming (e.g., USDC, USDT, DAI).

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Who chooses the redeem asset? | User, at `requestRedeem` time | User control over payout asset |
| Asset eligibility source | AssetRegistry with `isRedeemable` flag | Reuses existing infra, avoids parallel allowlist |
| Liquidity model | Per-asset, break-early (FIFO) | Consistent with original single-asset design; simple and predictable |
| offRamp | `offRamp(address _asset, uint256 _amount)` — no guards | Operator needs full flexibility to move funds; responsibility is operational |
| Queue upgrade safety | Admin guarantees all queues are empty before upgrade | Operational guarantee; no on-chain version gating needed |
| Asset registry stability | Operator guarantees registry won't change during pending redeems | If price is stale, operator waits for fresh price rather than skipping |
| Approach | Encode asset in queue data | Mirrors deposit-side pattern; minimal structural change |

## Operational Assumptions

These assumptions underpin the simplified design. They are enforced operationally, not on-chain:

1. **Queue emptiness before upgrade:** The admin will drain all three queues (deposit, pendingRedeem, redeem) before upgrading the Express implementation. This prevents the new decoders from encountering old-format queue data. The `reinitializeV2()` function includes queue-emptiness assertions as a safety net, but the primary guarantee is operational.

2. **offRamp flexibility:** The operator has full discretion to move any asset to treasury via `offRamp`. There are no on-chain guards against sweeping assets that have pending redeems. The operator is trusted (OPERATOR_ROLE) and is responsible for ensuring sufficient liquidity before calling `processRedeemQueue`. This keeps the contract simple and avoids unnecessary bookkeeping.

3. **AssetRegistry stability during redeems:** The operator will not remove assets or let price feeds go stale while there are pending redeem requests for those assets. If a price feed becomes stale, the operator waits for a fresh price rather than processing. If an asset must be removed, the operator cancels affected pending redeems first.

4. **FIFO ordering:** The redeem queue follows strict FIFO. If the front item's asset has insufficient liquidity, processing stops (break-early). This is consistent with the original single-asset behavior. The operator manages liquidity per asset to avoid head-of-line blocking.

## Changes

### 1. AssetRegistry: Add `isRedeemable` Flag

Update `AssetConfig` struct in `IAssetRegistry.sol`:

```solidity
struct AssetConfig {
    address asset;
    bool isSupported;
    bool isRedeemable;       // NEW
    address priceFeed;
    uint256 maxStalePeriod;
}
```

Add convenience view to `IAssetRegistry`:

```solidity
function isAssetRedeemable(address asset) external view returns (bool);
```

`setAssetConfig()` already accepts the full struct, so no new admin function is needed. Deposit flow only checks `isSupported` and is unaffected.

### 2. Express State Variable Changes

- **Deprecate** `address public redeemAsset` (slot 79): keep for storage layout safety, stop reading it. Add comment: `// Deprecated: legacy single redeem asset slot`.
- **Remove** `updateRedeemAsset()`: no longer needed.
- **Remove** `UpdateRedeemAsset` event.
- `pendingRedeemInfo` and `redeemInfo` remain `mapping(address => uint256)` — they track share amounts, which are asset-agnostic.

### 3. Queue Encoding Changes

**Pending redeem queue** (5 fields -> 6 fields):

```
Before: (sender, receiver, shareAmount, requestTimestamp, id)
After:  (sender, receiver, shareAmount, redeemAsset, requestTimestamp, id)
```

**Final redeem queue** (7 fields -> 8 fields):

```
Before: (sender, receiver, shareAmount, redeemAssetAmt, feeAssetAmt, requestTimestamp, id)
After:  (sender, receiver, shareAmount, redeemAsset, redeemAssetAmt, feeAssetAmt, requestTimestamp, id)
```

**Upgrade constraint:** All three queues (deposit, pendingRedeem, redeem) must be empty before activating the new implementation. The old encoding is incompatible with the new decoding.

**On-chain safety net via reinitializer:**

```solidity
function reinitializeV2() external reinitializer(2) {
    if (depositQueue.length() != 0) revert QueuesNotEmpty();
    if (pendingRedeemQueue.length() != 0) revert QueuesNotEmpty();
    if (redeemQueue.length() != 0) revert QueuesNotEmpty();
}
```

This is a safety net, not the primary guarantee. The admin drains queues before upgrading. The reinitializer catches mistakes.

### 4. Function Changes

#### Modified signatures

| Function | Change |
|----------|--------|
| `requestRedeem` | Add `address _redeemAsset` parameter |
| `previewRedeem` | Add `address _redeemAsset` parameter |
| `offRamp` | Add `address _asset` parameter; remove all guards except zero-amount check |
| `_redeemAssetAmount` | Add `address _redeemAsset` parameter (replaces reading global state) |

#### Modified internal logic (signature unchanged)

| Function | Change |
|----------|--------|
| `processPendingRedeems` | Decode `redeemAsset` from each item; pass to `_redeemAssetAmount`; encode into final queue |
| `processRedeemQueue` | Decode `redeemAsset` from each item; per-asset liquidity check; per-asset transfers; break-early on insufficient liquidity |
| `cancelPendingRedeem` | Decode extra field (no behavioral change — refunds shares) |
| `cancelRedeem` | Decode extra field (no behavioral change — refunds shares) |
| `revertRedeemToPending` | Decode `redeemAsset` from final queue; carry into pending queue encoding; **migrate** snapshot ratio from old ID to new pending ID (ratio is preserved, repricing comes from `getPrice()` at next `processPendingRedeems` call) |
| `getRedeemQueueInfo` | Return `redeemAsset` as additional field |
| `getPendingRedeemQueueInfo` | Return `redeemAsset` as additional field |
| `_decodePendingRedeemData` | Decode 6 fields instead of 5 |
| `_decodeRedeemData` | Decode 8 fields instead of 7 |

### 5. Validation in `requestRedeem`

```solidity
function requestRedeem(address _to, uint256 _shareAmount, address _redeemAsset) external whenNotPausedRedeem {
    // Validate redeem asset is supported and redeemable
    if (!assetRegistry.isAssetSupported(_redeemAsset)) revert InvalidAddress();
    if (!assetRegistry.isAssetRedeemable(_redeemAsset)) revert AssetNotRedeemable(_redeemAsset);
    // ... rest of existing logic, encode _redeemAsset into queue
}
```

### 6. Liquidity Check in `processRedeemQueue`

The queue follows strict FIFO with break-early on insufficient liquidity, consistent with the original single-asset design:

```solidity
function processRedeemQueue(uint256 _len) external onlyRole(OPERATOR_ROLE) {
    _len = _validateQueueProcessing(redeemQueue.length(), _len);

    for (uint256 count = 0; count < _len; ) {
        bytes memory data = redeemQueue.front();
        // decode fields including redeemAssetAddr...

        _validateKyc(sender, receiver);

        uint256 availableLiquidity = IERC20(redeemAssetAddr).balanceOf(address(this));
        if (redeemAssetAmt > availableLiquidity) {
            break;
        }

        redeemQueue.popFront();
        redeemInfo[receiver] -= shareAmount;
        totalRedeemQueueShares -= shareAmount;
        delete snapshotRatios[id];
        unchecked { ++count; }

        token.burn(address(this), shareAmount);

        if (feeAssetAmt > 0) {
            IERC20(redeemAssetAddr).safeTransfer(txFeeTo, feeAssetAmt);
        }

        uint256 netAssetAmt = redeemAssetAmt - feeAssetAmt;
        IERC20(redeemAssetAddr).safeTransfer(receiver, netAssetAmt);

        emit ProcessRedeem(sender, receiver, shareAmount, redeemAssetAddr, netAssetAmt, id);
    }
}
```

**Why break-early, not skip-and-continue:** The operator manages per-asset liquidity. If the front item's asset is illiquid, the operator either funds the contract or cancels the item. Skip-and-continue adds complexity (re-enqueue logic, gas bounds, ordering invariants) without meaningful benefit given trusted operators.

### 7. Pending Queue Processing

`processPendingRedeems` follows the same break-early pattern. Asset pricing is expected to succeed because the operator guarantees registry stability:

```solidity
function processPendingRedeems(uint256 _len) external onlyRole(OPERATOR_ROLE) {
    _len = _validateQueueProcessing(pendingRedeemQueue.length(), _len);
    uint256 currentPrice = getPrice();

    for (uint256 count = 0; count < _len; ) {
        bytes memory data = pendingRedeemQueue.front();
        // decode: sender, receiver, shareAmount, redeemAsset, requestTimestamp, id

        if (block.timestamp < requestTimestamp + convertRedeemRequestsDelay) {
            break; // Pending queue is time-ordered; if this isn't ready, none after it are
        }

        // ... KYC validation, snapshot ratio lookup, asset amount calculation
        // All expected to succeed given operational guarantees

        pendingRedeemQueue.popFront();
        // ... encode into final redeem queue with redeemAsset
        unchecked { ++count; }
    }
}
```

### 8. offRamp

`offRamp` is a trusted operator function with no on-chain guards beyond zero-amount validation. The operator has full flexibility to move any asset to treasury:

```solidity
function offRamp(address _asset, uint256 _amount) external onlyRole(OPERATOR_ROLE) {
    if (_amount == 0) revert InvalidAmount();
    IERC20(_asset).safeTransfer(treasury, _amount);
    emit OffRamp(treasury, _asset, _amount);
}
```

**Design rationale:** The operator (OPERATOR_ROLE) is trusted to manage contract liquidity. Adding on-chain guards (liability tracking, pending-count checks) would add storage overhead and bookkeeping complexity across multiple functions without meaningful safety improvement — a malicious or negligent operator could cause harm through other privileged operations regardless. The operator is responsible for:
- Ensuring sufficient liquidity before calling `processRedeemQueue`
- Not sweeping assets that are owed to queued redeemers
- Coordinating `offRamp` calls with queue processing

### 9. Events & Errors

**Updated events** (add `address redeemAsset`):

- `AddToPendingRedeemQueue(address indexed from, address indexed to, uint256 shareAmount, address redeemAsset, bytes32 indexed id)`
- `ProcessPendingRedeem(address indexed from, address indexed to, uint256 shareAmount, address redeemAsset, uint256 priceUsed, bytes32 indexed pendingId, bytes32 finalId)`
- `ProcessRedeem(address indexed from, address indexed to, uint256 burnedAmount, address redeemAsset, uint256 redeemAssetOut, bytes32 indexed id)`
- `OffRamp(address indexed to, address indexed asset, uint256 amount)`

**Removed events:**

- `UpdateRedeemAsset`

**New error:**

- `AssetNotRedeemable(address asset)`

## Edge Cases

### `isRedeemable` toggled off while requests are in queue

Validation happens at `requestRedeem` time only. Once a request is queued, it will be honored during processing regardless of whether `isRedeemable` is later toggled off. This is intentional: the user made their choice when the asset was eligible, and their shares are already escrowed. The operator should drain queues before toggling `isRedeemable` off if they want to prevent further payouts in that asset.

### Decimal differences between redeem assets

Different assets have different decimals (USDC: 6, DAI: 18). This is already handled by `convertToUnderlying()` in AssetRegistry and `_trimAsset()` in Express. The `_redeemAssetAmount` function receives the decoded `redeemAsset` address and passes it to both functions, so decimal conversion is per-item.

### `offRamp` and non-redeemable assets

`offRamp` does not check `isAssetSupported` or `isRedeemable`. The operator may need to sweep any asset held by the contract (e.g., accidental transfers, deposit-only assets). This is a privileged operation (OPERATOR_ROLE only) with no on-chain restrictions beyond zero-amount validation.

### Head-of-line blocking with multiple assets

With break-early FIFO, an illiquid asset at the front of the queue blocks all subsequent items regardless of their asset. This is accepted by design:
- The operator manages per-asset liquidity and is responsible for funding the contract before processing
- If a specific item cannot be processed, the operator can cancel it via `cancelRedeem` or `cancelPendingRedeem`
- Skip-and-continue was considered and rejected as unnecessary complexity given trusted operators

### `revertRedeemToPending` preserves snapshot ratio

When an item is reverted from the final redeem queue back to pending, the snapshot ratio is migrated from the old ID to the new pending ID (`snapshotRatios[newPendingId] = snapshotRatios[oldId]`). The ratio captures the user's share entitlement at the original snapshot time and must not change. Repricing happens because `processPendingRedeems` calls `getPrice()` at processing time — the new price, combined with the preserved ratio, produces the updated redeem asset amount.

### `initialize` for new deployments

The `_redeemAsset` parameter in `initialize()` still sets the deprecated storage slot. For new deployments, pass any valid address (e.g., USDC) to satisfy the non-zero check. The value is never read by the new logic. Alternatively, a future version can remove this parameter entirely.

## What's NOT Changing

- Deposit flow (entirely untouched)
- Fee logic (same BPS, applied to decoded asset)
- KYC/compliance checks
- First deposit tracking
- Escrow mechanisms (`redeemEscrowBalance` holds HYBOND tokens; `depositEscrowBalance` is deposit-side)
- `totalRedeemQueueShares` (tracks shares, asset-agnostic)
- Rate limiting (`DepositRedeemLimiter`) — operates on share amounts
- Epoch / management fee
- Price oracle (single oracle for HYBOND price)

## Upgrade Procedure

1. Process all pending and final redeem queues to empty
2. Process all deposit queues to empty
3. Deploy new AssetRegistry implementation with `isRedeemable` field
4. Configure existing assets: `setAssetConfig(...)` with `isRedeemable: true` for eligible assets
5. Deploy new Express implementation
6. Upgrade Express proxy via `upgradeToAndCall(newImpl, abi.encodeCall(reinitializeV2, ()))` — reinitializer asserts queue emptiness as safety net
7. Verify: old `redeemAsset` slot is ignored, new flow works end-to-end

## Blast Radius Summary

| Layer | Changes |
|-------|---------|
| AssetRegistry | Add `isRedeemable` to `AssetConfig` + view function |
| Express state | Deprecate `redeemAsset` slot, remove `updateRedeemAsset()` |
| Queue encoding | +1 field in both pending and final redeem queues |
| Functions modified | ~10 functions (signatures or internal logic) |
| Functions removed | `updateRedeemAsset()` |
| Events | 3 updated, 1 removed, 1 new error |
| Unchanged | Entire deposit side, escrow, epoch, KYC, rate limiting |
