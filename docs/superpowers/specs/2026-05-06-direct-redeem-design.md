# Direct Redeem (Off-Chain Settlement) — Design Spec

**Status:** Approved
**Date:** 2026-05-06
**Component:** `contracts/extension/Express.sol`

## Problem

The current redeem path (`requestRedeem` → `processPendingRedeems` → `processRedeemQueue`) settles every redemption in a single fixed `redeemAsset` (e.g. USDC). Users who want to off-ramp into a different asset (e.g. RLUSD) cannot be served on-chain.

We need a redeem path that:

1. Lets the user nominate the asset they want to receive (informationally — the contract does not pay it).
2. Burns the user's HYBOND tokens immediately, without queueing or T+2 delay.
3. Records a burn event the off-chain settlement layer (DB + ops) can match against and pay out in the requested asset.

The contract must remain neutral about the settlement asset — it has no oracle for RLUSD or other arbitrary assets, and acquiring oracles per asset is out of scope.

## Non-Goals

- On-chain pricing, fee, or limit logic for the off-chain settlement asset.
- On-chain remediation if off-chain settlement fails (handled by ops/back-office).
- Any whitelist of supported settlement assets (the DB is the source of truth).
- Replacing the existing `requestRedeem` flow — the standard `redeemAsset` continues to use the queued T+2 path.

## Solution Overview

A new external function `requestDirectRedeem` on `Express.sol`:

- Validates KYC + pause state.
- Decrements `offchainShares` by the equivalent share amount at the current ratio.
- Burns the user's HYBOND tokens immediately (no queue, no escrow).
- Emits `OffchainRedeem` with the burn record.
- Does **not** touch `totalRedeemQueueTokens`, `totalMgtFeeUnclaimed`, queues, fees, or oracle.

The off-chain DB matches `OffchainRedeem` events to settlement payouts. The contract is fire-and-forget on the burn side.

## Function Signature

```solidity
/**
 * @notice Redeem HYBOND tokens with off-chain settlement in an arbitrary asset.
 * @dev Burns tokens immediately. The redeem-asset payout is handled fully off-chain;
 *      the contract only emits the burn record for the DB to match against.
 *      No queue, no fee on-chain, no T+2 delay.
 * @param _asset Informational asset address the user wants to receive off-chain
 *               (e.g. RLUSD). Must be non-zero and not equal to redeemAsset.
 * @param _tokenAmount HYBOND token amount to burn.
 * @param _to KYC'd recipient address recorded for off-chain settlement.
 */
function requestDirectRedeem(
    address _asset,
    uint256 _tokenAmount,
    address _to
) external whenNotPausedRedeem;
```

Placement: in `Express.sol` next to `requestRedeem`, in the redemption section.

## Validation & Guards

In order:

1. `whenNotPausedRedeem` modifier (existing pattern).
2. `from = _msgSender()`.
3. `_validateKyc(from, _to)` — same KYC check the rest of the contract uses.
4. `if (_tokenAmount == 0) revert InvalidAmount();`
5. `if (_asset == address(0)) revert InvalidAddress();`
6. `if (_asset == redeemAsset) revert InvalidInput(0);` — force standard asset through queued path.
7. `if (from == mgtFeeTo) revert InvalidInput(1);` — mgt fee shares must go through `requestRedeem` only (keeps `totalMgtFeeUnclaimed` reconciliation clean).

No `redeemMinimum` check. No `firstDeposit` check. Reuses existing errors.

## Accounting

```solidity
uint256 ratio = _sharesPerToken();
uint256 shareAmount = Math.mulDiv(_tokenAmount, ratio, 1e18);

if (offchainShares < shareAmount) revert InsufficientOffchainShares();

offchainShares -= shareAmount;
// totalRedeemQueueTokens NOT touched — burn is immediate, no in-flight tokens.

token.burn(from, _tokenAmount);
```

### Ratio Invariance

`_sharesPerToken = offchainShares / (totalSupply - totalRedeemQueueTokens)`.

After the operation:

- numerator drops by `shareAmount`
- `totalSupply` drops by `_tokenAmount` (direct burn)
- `totalRedeemQueueTokens` unchanged
- denominator drops by `_tokenAmount`

Since `shareAmount = _tokenAmount * ratio / 1e18`, the ratio is preserved exactly (modulo `mulDiv` floor rounding, which favors the pool — same direction as `requestRedeem`).

### Worked Example (with `totalRedeemQueueTokens > 0`)

Before: `totalSupply=1000`, `totalRedeemQueueTokens=200`, `offchainShares=880`, `ratio=1.1e18`.

User calls `requestDirectRedeem(asset, 100, to)`:

- `shareAmount = 110`
- `offchainShares = 770`
- `totalSupply = 900` after burn
- `totalRedeemQueueTokens = 200` (unchanged)
- new `ratio = 770 / (900 - 200) = 1.1e18` ✓

### Edge Cases

- `offchainShares == 0` → `_sharesPerToken` returns `1e18` fallback → `shareAmount == _tokenAmount` → `InsufficientOffchainShares` revert (post-bootstrap, tokens shouldn't exist with zero offchain shares).
- `_tokenAmount > balanceOf(from)` → `token.burn` reverts via underlying ERC20.
- Banned `from` → `token.burn` reverts inside `Token._update`; KYC gate catches earlier.
- Tokens already in the redeem queue cannot be double-burned: `requestRedeem` `safeTransferFrom`'s tokens to the contract, so the user's wallet balance no longer holds them.

## Event

```solidity
event OffchainRedeem(
    address indexed from,
    address indexed to,
    address indexed asset,
    uint256 tokenAmount,
    uint256 shareAmount,
    bytes32 id
);
```

Emission:

```solidity
bytes32 id = keccak256(
    abi.encode(from, _to, _asset, _tokenAmount, shareAmount, block.timestamp, _nonce++)
);
emit OffchainRedeem(from, _to, _asset, _tokenAmount, shareAmount, id);
```

Indexed: `from`, `to`, `asset` (highest-cardinality lookup keys for DB queries). `id` is in the data section.

## Test Plan

Location: new `test/unit/Express.directRedeem.test.ts` (or appended to `Express.comprehensive.test.ts`).

1. **Happy path** — KYC'd user burns N tokens; event fields correct; `totalSupply` drops by N; `offchainShares` drops by `N * ratio / 1e18`; ratio unchanged.
2. **Ratio invariance with `totalRedeemQueueTokens > 0`** — one user in pending queue, another calls `requestDirectRedeem`, assert ratio unchanged.
3. **Reverts:** zero amount, zero asset, asset == redeemAsset, caller is mgtFeeTo, non-KYC `from`, non-KYC `_to`, banned `from`, paused state, insufficient balance, `offchainShares < shareAmount`.
4. **Coexistence** — interleave with `requestDeposit` / `requestRedeem` / `processDepositQueue` / `processPendingRedeems` / `processRedeemQueue` / `updateEpoch`; assert no accounting drift.
5. **`updateMgtFeeTo` precondition** — `requestDirectRedeem` must not block `updateMgtFeeTo` (does not touch queues).
6. **Fuzz** — random `_tokenAmount` in `[1, balance]` against random pre-existing pool state; assert ratio invariant within 1 wei.

## Out-of-Scope / Unchanged

- No new state variables, roles, or constants.
- No changes to `_sharesPerToken`, `requestRedeem`, `processPendingRedeems`, `processRedeemQueue`, `updateEpoch`, `cancelPendingRedeem`, `cancelRedeem`.
- No changes to `AssetRegistry`, `Token`, `DepositRedeemLimiter`, `ExpressPausable`.
- No upgrade-storage concerns: pure logic addition, no new storage slots, no `__gap` decrement.

## Operational Invariants (off-chain)

Add to the mgtFeeTo invariant block (Express.sol:80–110):

- mgtFeeTo MUST NOT call `requestDirectRedeem` (already enforced on-chain).

New invariant for the operator/back-office:

- **Off-chain settlement of `requestDirectRedeem` burns is the operator's responsibility.** Failure to settle = user lost tokens with no on-chain recourse. Operators must monitor `OffchainRedeem` events and reconcile against settlement payouts.

## Documentation Updates

- Update `CLAUDE.md` "Express Contract Queue Flow" section to mention the third path (direct redeem with off-chain settlement).

## Decisions Log

| # | Decision | Chosen | Reasoning |
|---|----------|--------|-----------|
| 1 | Asset model | Free-form address, informational | Contract has no oracle for arbitrary assets; DB is source of truth |
| 2 | Fees | None on-chain | Settlement asset/rate is off-chain; on-chain HYBOND-denominated fees would create dual fee semantics |
| 3 | KYC/limits | KYC + pause only | `redeemMinimum` is sized for `redeemAsset` economics; mgtFeeTo path stays exclusive to `requestRedeem` |
| 4 | Pricing | Re-price at payout | Contract has no oracle for the settlement asset; emitting a `redeemAsset`-denominated price would mislead |
| 5 | Cancel/refund | None | DB owns settlement state; admin re-mint is a separate generic concern |
| 6 | Naming | `requestDirectRedeem` / `OffchainRedeem` | Function uses `request` prefix for surface symmetry; event name describes the settlement leg |
| 7 | Asset validation | `_asset != 0` AND `_asset != redeemAsset` | Cheap foot-gun prevention without imposing a whitelist |
