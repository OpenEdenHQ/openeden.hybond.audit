# sharesPerToken Invariance Redesign — Design Spec

**Date:** 2026-04-24
**Author:** duke.du@openeden.com
**Status:** Implemented
**Target contract:** `contracts/extension/Express.sol`
**Supersedes:** `docs/superpowers/specs/2026-04-19-offchain-shares-design.md` (the propose/confirm design)

## 1. Problem

The previous `_sharesPerToken()` formula tracked offchain fund shares via an operator-driven propose/confirm flow. While correct, it had structural issues:

1. **Ratio was NOT invariant during deposits and redeems.** Deposits temporarily deflated the ratio until the bot synced `offchainShares`. User redeems caused permanent ratio drift because `offchainShares` was only updated externally.
2. **Propose/confirm added latency and complexity.** Two roles, two transactions, a `PendingProposalExists` guard — all for a value that should track automatically.
3. **Snapshot ratios were a workaround.** The `snapshotRatios` mapping existed solely because the ratio moved between request and processing. If the ratio were invariant, no snapshot would be needed.
4. **`revertRedeemToPending` had unnecessary complexity** for snapshot migration between queue IDs.
5. **Double-redeem window** existed because `totalMgtFeeUnclaimed` was decremented at process time, not request time.

## 2. Goals

1. Make `sharesPerToken` invariant during deposit and redeem operations.
2. Remove the propose/confirm flow — `offchainShares` is updated automatically by deposit and redeem processing.
3. Eliminate snapshot ratios — the ratio is locked in at `requestRedeem` time by deducting from `offchainShares` immediately.
4. Simplify `revertRedeemToPending` — no snapshot migration needed.
5. Close double-redeem window by decrementing `totalMgtFeeUnclaimed` at request time.
6. Keep the price oracle for redeem-side asset calculations.
7. Retain a rare admin override for `offchainShares` (share splits, reconciliation).

## 3. Non-goals

- Removing the price oracle entirely. It stays for `processPendingRedeems` redeem asset computation and sanity checking.
- Changing the management fee accrual model. `updateEpoch` still mints fee tokens based on `offchainShares`.
- Changing the queue data structure (`DoubleQueueModified`). FIFO processing remains.

## 4. Approach

In-place refactor of `Express.sol`. Remove propose/confirm and snapshot machinery. Modify `processDepositQueue`, `requestRedeem`, `processPendingRedeems`, and `processRedeemQueue` to maintain `offchainShares` automatically. Rename `totalRedeemQueueShares` to `totalRedeemQueueTokens` and update it at request time (not process time).

## 5. Design

### 5.1 Formula (unchanged)

```
denom = totalSupply - totalRedeemQueueTokens
sharesPerToken = offchainShares / denom    (scaled by 1e18)
```

Returns `1e18` fallback when `offchainShares == 0` or `denom == 0`.

The key change is not in the formula — it's in WHEN `offchainShares` and `totalRedeemQueueTokens` are updated, ensuring proportional changes that keep the ratio constant.

### 5.2 State variables

**Removed (storage slots preserved with `__reserved` prefix):**
- `uint256 public proposedOffchainShares` — no more propose/confirm.
- `mapping(bytes32 => uint256) public snapshotRatios` — ratio locked at request time via `offchainShares` deduction.

**Renamed:**
- `totalRedeemQueueShares` -> `totalRedeemQueueTokens` — now incremented at `requestRedeem` (covers both pending and final queue), not at `processPendingRedeems`.

**Retained:**
- `uint256 public offchainShares` — still the numerator, but now updated automatically by `processDepositQueue` (increment) and `requestRedeem` (decrement).
- `uint256 public totalMgtFeeUnclaimed` — decrement moved from process time to request time for `mgtFeeTo`.
- `uint256 public convertRedeemRequestsDelay` — kept for on-chain T+N enforcement.
- All queue state (`depositQueue`, `pendingRedeemQueue`, `redeemQueue`), `depositInfo`, `pendingRedeemInfo`, `redeemInfo`.

### 5.3 Roles

**Removed:**
- `CONFIRM_ROLE` — no more confirm step.

**Unchanged:**
- `OPERATOR_ROLE` — processes queues, calls `updateEpoch`.
- `MAINTAINER_ROLE` — processes deposit queue, cancels queue entries, admin overrides.

### 5.4 Removed functions

- `proposeOffchainShares(uint256)` — replaced by automatic update in `processDepositQueue`.
- `confirmOffchainShares(uint256)` — removed entirely.
- `snapshotPendingRedeemRatio(uint256, uint256)` — no snapshots needed.
- `setSnapshotRatio(bytes32, uint256)` — no snapshots needed.

### 5.5 New functions

```solidity
function updateOffchainShares(uint256 _newValue) external onlyRole(MAINTAINER_ROLE);
```

Admin override for rare events (share splits, reconciliation). Sets `offchainShares = _newValue`. Emits `UpdateOffchainShares(msg.sender, _newValue, previousValue)`. Should almost never be called.

### 5.6 Modified functions

#### 5.6.1 `processDepositQueue(uint256 _len, uint256 _newShares)`

**Signature change:** Added `_newShares` parameter — the actual offchain fund shares acquired for this batch.

**Logic:**

```
1. Revert if _newShares == 0.
2. Validate _len via _validateQueueProcessing (reverts EmptyQueue if queue empty).
3. Capture currentRatio = _sharesPerToken() before any state changes.
4. Pop all entries into memory arrays, validate KYC, sum batchTotalNetAssets
   from normalized netAssets values (using convertFromUnderlying).
   Revert entire batch on KYC failure (operator must cancelDeposit offending entries first).
5. Compute: mintTotal = _newShares * 1e18 / currentRatio
6. offchainShares += _newShares
7. For each entry, compute pro-rata mint:
   mintAmount = _trim(mintTotal * normalizedAssets / batchTotalNetAssets)
8. Mint tokens to receiver.
9. Emit ProcessDeposit per entry.
```

**Invariance proof:**

```
Before: ratio = offchainShares / denom  (where denom = totalSupply - totalRedeemQueueTokens)

mintTotal = _newShares * 1e18 / ratio
          = _newShares * denom / offchainShares

After:
  offchainShares' = offchainShares + _newShares
  totalSupply' = totalSupply + mintTotal = totalSupply + _newShares * denom / offchainShares
  denom' = totalSupply' - totalRedeemQueueTokens
         = denom + _newShares * denom / offchainShares
         = denom * (offchainShares + _newShares) / offchainShares

  ratio' = offchainShares' / denom'
         = (offchainShares + _newShares) / (denom * (offchainShares + _newShares) / offchainShares)
         = offchainShares / denom
         = ratio  ✓
```

**Pre-sync edge case (`offchainShares == 0`):** `currentRatio` returns `1e18` fallback, so `mintTotal = _newShares * 1e18 / 1e18 = _newShares`. First batch mints 1:1, then `offchainShares` becomes `_newShares` and the real ratio takes over.

#### 5.6.2 `requestRedeem(address _to, uint256 _tokenAmount)`

**Parameter rename:** `_shareAmount` -> `_tokenAmount` to clarify this is a HYBOND token amount.

**Logic changes:**

```solidity
// mgtFeeTo override: force full unclaimed amount, decrement immediately
if (from == mgtFeeTo) {
    if (totalMgtFeeUnclaimed == 0) revert InvalidAmount();
    _tokenAmount = totalMgtFeeUnclaimed;
    totalMgtFeeUnclaimed = 0;
}

// Convert token amount to offchain shares at current ratio
uint256 shareAmount = Math.mulDiv(_tokenAmount, _sharesPerToken(), 1e18);

// Guard: offchainShares must cover the deduction
if (offchainShares < shareAmount) revert InsufficientOffchainShares();

// Update accounting — BOTH numerator and denominator change proportionally
offchainShares -= shareAmount;
totalRedeemQueueTokens += _tokenAmount;

// Encode BOTH tokenAmount and shareAmount in queue entry
```

**Invariance proof:**
```
Before: ratio = offchainShares / (totalSupply - totalRedeemQueueTokens)
After:
  offchainShares' = offchainShares - shareAmount
  totalRedeemQueueTokens' = totalRedeemQueueTokens + _tokenAmount
  totalSupply unchanged (tokens transferred to Express, not burned yet)

  shareAmount = _tokenAmount * offchainShares / denom

  ratio' = (offchainShares - shareAmount) / (denom - _tokenAmount)
         = offchainShares * (denom - _tokenAmount) / denom / (denom - _tokenAmount)
         = offchainShares / denom
         = ratio  ✓
```

#### 5.6.3 `processPendingRedeems(uint256 _len, uint256 _totalAsset)`

**Signature change:** Added `_totalAsset` parameter — the actual redeem asset amount received from selling offchain fund shares for this batch.

**Logic changes:**

```
1. Process entries (same FIFO, same convertRedeemRequestsDelay check, same KYC check)
2. For each entry:
   a. Decode shareAmount from queue entry
   b. Compute redeemAssetAmt = _redeemAssetAmount(shareAmount, currentPrice)
   c. Compute feeAssetAmt = txsFee(redeemAssetAmt, TxType.REDEEM)
   d. Accumulate runningTotal += redeemAssetAmt
   e. Push to final redeemQueue with (sender, receiver, tokenAmount, shareAmount, redeemAssetAmt, feeAssetAmt, ...)
3. After loop: if runningTotal > _totalAsset, revert InsufficientSettlementFunds()
4. No changes to offchainShares or totalRedeemQueueTokens (already adjusted at request time)
```

**`_redeemAssetAmount` simplification:**
```solidity
// shareAmount already has the sharesPerToken ratio baked in (computed at requestRedeem time)
function _redeemAssetAmount(uint256 _shareAmount, uint256 _price) internal view returns (uint256) {
    return _trimAsset(
        Math.mulDiv(convertToUnderlying(redeemAsset, _shareAmount), _price, 1e18),
        redeemAsset
    );
}
```

#### 5.6.4 `processRedeemQueue(uint256 _len)`

**Signature:** No `_totalAsset` parameter. Amounts already locked in by `processPendingRedeems`.

**Logic changes:**
- Burns `tokenAmount` tokens
- `totalRedeemQueueTokens -= tokenAmount`
- `totalSupply` decreases by `tokenAmount` (via burn)
- Pays out locked-in `redeemAssetAmt - feeAssetAmt` to receiver

**Invariance proof:**
```
totalSupply decreases by tokenAmount
totalRedeemQueueTokens decreases by tokenAmount
denom = totalSupply - totalRedeemQueueTokens -> unchanged
offchainShares unchanged
ratio unchanged ✓
```

#### 5.6.5 `updateEpoch()`

**Changes:**
- Remove `PendingProposalExists` guard.
- Keep `mgtFeeRate > 0`, `timeBuffer` checks.
- Fee base remains `offchainShares`.
- `token.mint(mgtFeeTo, dailyFee)` increases `totalSupply`, which increases denominator, which decreases `sharesPerToken`. This is the intended fee dilution.

#### 5.6.6 `cancelPendingRedeem(uint256 _len)`

**Changes:**
- Decode `shareAmount` from pending queue entry.
- Restore `offchainShares += shareAmount`.
- Restore `totalRedeemQueueTokens -= tokenAmount`.
- If `sender == mgtFeeTo`: restore `totalMgtFeeUnclaimed += tokenAmount`.
- Refund tokens to sender.

**Invariance:** reverse of `requestRedeem`, ratio unchanged.

#### 5.6.7 `cancelRedeem(uint256 _len)`

**Changes:**
- Decode `shareAmount` from final queue entry (carried through from pending encoding).
- Restore `offchainShares += shareAmount`.
- `totalRedeemQueueTokens -= tokenAmount`.
- If `sender == mgtFeeTo`: restore `totalMgtFeeUnclaimed += tokenAmount`.
- Refund tokens to sender.

**Note:** Final queue entry encoding includes `shareAmount` for cancel to restore correctly.

#### 5.6.8 `revertRedeemToPending(uint256 _len)`

**Kept but simplified.** Recovery path when operator processes `processPendingRedeems` with wrong parameters (bad `_totalAsset`, wrong `_len`, stale oracle). Moves entries from the final redeem queue back to the pending redeem queue.

**What changed vs. previous implementation:**
- **Removed:** Snapshot ratio migration. No snapshots exist.
- **Removed:** `totalMgtFeeUnclaimed` restoration. Fee counter was already decremented at `requestRedeem` time.
- **Unchanged:** `totalRedeemQueueTokens` is NOT modified — it was incremented at `requestRedeem` and covers both pending and final entries.
- **Unchanged:** `offchainShares` is NOT modified — it was decremented at `requestRedeem` and is unaffected by pending<->final transitions.

**Invariance:** No changes to `offchainShares` or `totalRedeemQueueTokens`. Ratio unchanged.

#### 5.6.9 `_sharesPerToken()`

```solidity
function _sharesPerToken() internal view returns (uint256 ratio) {
    uint256 totalSupply = IERC20(address(token)).totalSupply();
    uint256 denom = totalSupply - totalRedeemQueueTokens;
    if (offchainShares == 0 || denom == 0) return 1e18;
    ratio = Math.mulDiv(offchainShares, 1e18, denom);
}
```

Identical logic, references the renamed `totalRedeemQueueTokens`.

### 5.7 Queue entry encoding changes

**Pending redeem queue (new format):**
```solidity
abi.encode(sender, receiver, tokenAmount, shareAmount, requestTimestamp, id)
// Added: shareAmount (uint256)
// Renamed: shareAmount field represents offchain shares (ratio baked in at request time)
```

**Final redeem queue (new format):**
```solidity
abi.encode(sender, receiver, tokenAmount, shareAmount, redeemAssetAmt, feeAssetAmt, requestTimestamp, id)
// Added: shareAmount (uint256)
// No snapshot ratio references
```

### 5.8 Events

**Removed:**
- `ProposeOffchainShares(address indexed proposer, uint256 supply)`
- `ConfirmOffchainShares(address indexed confirmer, uint256 newSupply, uint256 previousSupply)`
- `SnapshotPendingRedeemRatio(bytes32 indexed id, uint256 ratio)`
- `SetSnapshotRatio(bytes32 indexed id, uint256 ratio)`

**Added:**
- `UpdateOffchainShares(address indexed caller, uint256 newValue, uint256 previousValue)` — for the admin override function.

**Modified:**
- `AddToPendingRedeemQueue(address indexed from, address indexed to, uint256 tokenAmount, uint256 shareAmount, bytes32 indexed id)` — added `shareAmount`.

**Retained:**
- `RevertRedeemToPending` — kept (function retained, simplified).

### 5.9 Errors

**Removed:**
- `PendingProposalExists(uint256)`
- `RatioNotSnapshotted(bytes32)`

**Added:**
- `InsufficientOffchainShares()` — `requestRedeem` reverts when `offchainShares < shareAmount`.
- `InsufficientSettlementFunds(uint256 oracleTotal, uint256 suppliedTotal)` — `processPendingRedeems` reverts when oracle-derived total > `_totalAsset`.

### 5.10 Ratio movement summary

| Event | offchainShares | totalSupply | totalRedeemQueueTokens | sharesPerToken |
|---|---|---|---|---|
| processDepositQueue | +newShares | +mintTotal | unchanged | **unchanged** |
| requestRedeem | -shareAmt | unchanged | +tokenAmount | **unchanged** |
| processPendingRedeems (pending->final) | unchanged | unchanged | unchanged | **unchanged** |
| processRedeemQueue (burn) | unchanged | -tokenAmount | -tokenAmount | **unchanged** |
| updateEpoch (fee mint) | unchanged | +dailyFee | unchanged | **drops** (intended dilution) |
| cancelPendingRedeem | +shareAmt | unchanged | -tokenAmount | **unchanged** |
| cancelRedeem | +shareAmt | unchanged | -tokenAmount | **unchanged** |
| revertRedeemToPending | unchanged | unchanged | unchanged | **unchanged** |
| updateOffchainShares (admin) | set to new value | unchanged | unchanged | **changes** (rare, intentional) |

### 5.11 Daily operational routine

1. `processDepositQueue(len, newShares)` — mint for settled deposits, update `offchainShares`
2. `updateEpoch()` — accrue daily fee on current `offchainShares`
3. `processPendingRedeems(len, totalAsset)` — move T+2-ready entries to final queue, lock in redeem asset amounts
4. `processRedeemQueue(len)` — burn tokens and pay out redeem asset

Ordering is operational, not on-chain enforced (except `convertRedeemRequestsDelay` gate in step 3).

`requestRedeem` can happen at any time (user-initiated). It immediately adjusts `offchainShares` and `totalRedeemQueueTokens`.

### 5.12 Edge cases

| Scenario | Behavior |
|---|---|
| `offchainShares == 0` (pre-sync) | `_sharesPerToken()` returns `1e18`. Deposits at 1:1. Redeems revert `InsufficientOffchainShares` if no shares exist. Safe: can't redeem what hasn't been deposited through `processDepositQueue`. |
| `processDepositQueue` with empty queue | `_validateQueueProcessing` reverts `EmptyQueue`. |
| All tokens redeemed | `offchainShares` drops to 0, `totalRedeemQueueTokens == totalSupply`, `denom == 0`, ratio returns `1e18` fallback. |
| `mgtFeeTo` calls `requestRedeem` twice before processing | Second call reverts: `totalMgtFeeUnclaimed` was zeroed on first call. |
| `cancelPendingRedeem` after fee accrual | `offchainShares` restored, ratio returns to pre-redeem value. Correct, because the offchain shares weren't actually sold. |
| Rounding in pro-rata mint | Last user in batch may receive slightly fewer tokens due to integer division. Dust is negligible. |
| Oracle price diverges from actual asset received | `processPendingRedeems` reverts `InsufficientSettlementFunds` if oracle-derived total > `_totalAsset`. Operator must supply accurate amount or adjust oracle. |
| Bad `processPendingRedeems` (wrong len/asset/price) | Operator calls `revertRedeemToPending` to move entries back to pending queue. No accounting changes needed. |

### 5.13 Operational invariants

1. Operator supplies accurate `_newShares` in `processDepositQueue` matching the actual offchain fund shares acquired for the batch.
2. Operator supplies accurate `_totalAsset` in `processPendingRedeems` matching the actual redeem asset received from offchain share liquidation.
3. `mgtFeeTo` transfers HYBOND tokens only to Express via `requestRedeem()`.
4. Non-fee tokens accidentally received by `mgtFeeTo` go to quarantine, not redeemed.
5. Don't ban `mgtFeeTo` while it holds fees or has in-flight redeems.
6. `mgtFeeTo` and redeem receivers stay KYC'd through settlement.
7. Don't change `redeemFeeRate`, `depositFeeRate`, `priceOracle`, `maxStalePeriod`, or `trimDecimals` while any queue is non-empty.
8. `updateOffchainShares` is for rare reconciliation only (share splits, error correction). Must not be used as a routine sync mechanism.

### 5.14 Security properties

1. **Ratio invariance:** Mathematically proven for deposit, redeem, burn, cancel, and revert paths.
2. **No double-redeem:** `totalMgtFeeUnclaimed` zeroed at `requestRedeem` time. Second call reverts `InvalidAmount`.
3. **No oracle manipulation for deposits:** Deposit minting uses operator-supplied `_newShares`, not oracle price. Oracle is only used for redeem asset computation.
4. **Sanity bound on redeems:** `_totalAsset` parameter prevents oracle-derived overpayment.
5. **Underflow protection:** `requestRedeem` reverts if `offchainShares < shareAmount`.
6. **Cancel symmetry:** Every accounting change in `requestRedeem` is reversed in `cancelPendingRedeem` / `cancelRedeem`.

## 6. Testing

**319 tests passing.** Key test files:

- `test/unit/Express.invariance.test.ts` — ratio invariance across all operations
- `test/unit/Express.mgtFeeAccounting.test.ts` — fee cycle and double-redeem prevention
- `test/unit/Express.OffchainShares.test.ts` — `updateOffchainShares`, `processDepositQueue` updates, pre-sync behavior
- `test/unit/Express.sharePerToken.test.ts` — sharesPerToken formula and queue processing
- `test/unit/Express.comprehensive.test.ts` — full end-to-end flows
- `test/integration/DailyRoutine.test.ts` — daily operational routine

## 7. Resolved design decisions

1. **Rounding direction in pro-rata mint:** Rounds down per user (Solidity default). Dust is negligible.
2. **Multi-asset deposits in a single batch:** Uses `convertFromUnderlying` to normalize before summing. Different decimal scales handled correctly.
3. **`_newShares` must be > 0:** Reverts `InvalidAmount` if zero. `_validateQueueProcessing` handles empty queue separately with `EmptyQueue`.
4. **`revertRedeemToPending` kept:** Simplified — no snapshot migration, no accounting changes. Recovery path for bad `processPendingRedeems` parameters.
