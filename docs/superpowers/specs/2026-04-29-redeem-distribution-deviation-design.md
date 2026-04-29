# Operator-Driven Redeem Distribution + Symmetric Oracle Deviation Guard

**Date:** 2026-04-29
**Component:** `contracts/extension/Express.sol`
**Origin:** Auditor feedback — "Using Oracle as a guard is fine, but it should be more like a deviation check."

## Problem

Two related asymmetries between deposit and redeem processing:

1. **Distribution source.** `processDepositQueue(_len, _newShares)` uses the operator-supplied `_newShares` to drive pro-rata token minting; the oracle is only a one-sided sanity floor. `processPendingRedeems(_len, _totalAsset)` does the opposite — the oracle drives per-entry payout via `_redeemAssetAmount(shareAmount, oraclePrice)`, and `_totalAsset` is only an upper-bound sanity ceiling. The redeem path is effectively oracle-driven, not operator-driven.

2. **Guard shape.** Both checks today are one-sided bounds (`oracleMinShares > _newShares` reverts; `runningTotal > _totalAsset` reverts). The auditor's recommendation is a symmetric deviation band on each side: oracle defines the expected value, operator-supplied value must be within `±maxDeviationBps`.

## Goals

- Redeem distribution mirrors deposit: operator-supplied `_totalAsset` is the pool, distributed pro-rata across entries by `shareAmount`.
- Both functions use a symmetric oracle deviation guard with a per-side configurable bps tolerance.
- `priceOracle == address(0)` continues to mean "no oracle"; the deviation guard is skipped in that case.
- Storage-safe upgrade (append-only).
- No change to `_sharesPerToken` invariance properties.

## Non-Goals

- Changing the queue encoding, fee model, or KYC re-validation logic.
- Per-entry deviation checks (rejected — redundant given fixed `shareAmount` weights).
- Operator-supplied per-entry payout overrides (rejected — defeats the queue's mechanical-fairness model).

## Design

### State (Express.sol — appended)

```solidity
uint256 public depositMaxDeviationBps;
uint256 public redeemMaxDeviationBps;
```

- Both bounded `<= BPS_BASE` (10000).
- `0` allowed (means strict equality with oracle).
- Append at end of storage layout (verify against existing `__gap`; consume one gap slot per var if available, otherwise append).
- Add to the file-top operational-invariants comment: do not change while any queue is non-empty (changes retroactively affect in-flight settlements).

### Internal helper

```solidity
error OracleDeviationExceeded(uint256 actual, uint256 expected, uint256 bps);

function _checkDeviation(uint256 actual, uint256 expected, uint256 bps) internal pure {
    if (expected == 0) return; // degenerate; empty batches don't reach this
    uint256 diff = actual > expected ? actual - expected : expected - actual;
    if (diff * BPS_BASE > expected * bps) {
        revert OracleDeviationExceeded(actual, expected, bps);
    }
}
```

### `processPendingRedeems(uint256 _len, uint256 _totalAsset)` rewrite

Two-pass structure mirroring `processDepositQueue`. Replaces today's `_processSinglePendingRedeem` per-entry oracle-driven payout.

**Pass 1 — pop, validate, accumulate:**

For up to `_len` entries from the front of `pendingRedeemQueue`:
- Decode entry. If `block.timestamp < requestTimestamp + convertRedeemRequestsDelay`, **break** (preserves current "stop at first not-ready" semantic).
- `pendingRedeemQueue.popFront()`; `_validateKyc(sender, receiver)`; decrement `pendingRedeemInfo[receiver]`.
- Buffer: `entries[i] = data`, `shareAmounts[i] = shareAmount`.
- Accumulate: `batchTotalShares += shareAmount`. If `priceOracle != address(0)`, also `expectedTotal += _redeemAssetAmount(shareAmount, oraclePrice)`. `oraclePrice` is fetched via `getPrice()` once before Pass 1 and only when oracle is set; when unset, `expectedTotal` stays 0 and Pass 1 skips the per-entry oracle math.

If `processed == 0`, revert `NoPendingRedeemsReady` (preserves current behavior).

**Deviation gate:**

```solidity
if (address(priceOracle) != address(0)) {
    _checkDeviation(_totalAsset, expectedTotal, redeemMaxDeviationBps);
}
```

Skipped entirely when oracle unset. The old `if (runningTotal > _totalAsset) revert InsufficientSettlementFunds(...)` is removed.

**Pass 2 — distribute pro-rata:**

For each of the `processed` entries:
```solidity
redeemAssetAmt = _trimAsset(
    Math.mulDiv(_totalAsset, shareAmounts[i], batchTotalShares),
    redeemAsset
);
feeAssetAmt = txsFee(redeemAssetAmt, TxType.REDEEM);
```

Push to `redeemQueue` with the existing encoding, `redeemInfo[receiver] += tokenAmount`, emit `ProcessPendingRedeem`.

**Rounding & dust.** `Math.mulDiv` floors and `_trimAsset` truncates, so `Σ redeemAssetAmt_i ≤ _totalAsset`. Residual dust remains in the contract's `redeemAsset` balance and joins the next batch's liquidity. Floor is correct: paying out more than `_totalAsset` would over-promise on the subsequent `processRedeemQueue` transfer.

**Removals:**
- `_processSinglePendingRedeem` deleted (its logic splits across passes).
- `InsufficientSettlementFunds` is no longer thrown by the redeem path (still defined; deposit path no longer throws it either after this change — verify call sites and consider removal in a follow-up).

### `processDepositQueue(uint256 _len, uint256 _newShares)` symmetric guard

Surgical change. Two-pass structure unchanged. Replace lines around Express.sol:716-717:

**Today:**
```solidity
uint256 oracleMinShares = Math.mulDiv(batchTotalNetAssets, 1e18, getPrice());
if (oracleMinShares > _newShares) revert InsufficientSettlementFunds(oracleMinShares, _newShares);
```

**New:**
```solidity
if (address(priceOracle) != address(0)) {
    uint256 oracleShares = Math.mulDiv(batchTotalNetAssets, 1e18, getPrice());
    _checkDeviation(_newShares, oracleShares, depositMaxDeviationBps);
}
```

Distribution math (`mintTotal = _newShares * 1e18 / currentRatio`, pro-rata by `normalizedAmounts[i]`) is unchanged.

**Behavior change.** Today the no-oracle path uses `getPrice()`'s `1e18` fallback in the floor check. The new design skips the check entirely when oracle is unset — operator is fully trusted. Consistent with the redeem path and explicitly chosen during brainstorming.

### Setters & events

```solidity
event UpdateDepositMaxDeviationBps(uint256 bps);
event UpdateRedeemMaxDeviationBps(uint256 bps);

function updateDepositMaxDeviationBps(uint256 _bps) external onlyRole(MAINTAINER_ROLE) {
    if (_bps > BPS_BASE) revert InvalidInput(_bps);
    depositMaxDeviationBps = _bps;
    emit UpdateDepositMaxDeviationBps(_bps);
}

function updateRedeemMaxDeviationBps(uint256 _bps) external onlyRole(MAINTAINER_ROLE) {
    if (_bps > BPS_BASE) revert InvalidInput(_bps);
    redeemMaxDeviationBps = _bps;
    emit UpdateRedeemMaxDeviationBps(_bps);
}
```

### Initialization

Fresh deployments: initialize both bps fields to `100` (1%) in `initialize` alongside other operational params. Existing deployments: set via the new setter calls post-upgrade. Default storage value of `0` would mean strict equality with oracle — we explicitly avoid that as a silent default by requiring the post-upgrade setter call.

## Migration

Per-network upgrade procedure (MAINTAINER):

1. Deploy new Express implementation.
2. Validate storage layout against the old implementation.
3. Pause deposit and redeem processing.
4. Drain `depositQueue`, `pendingRedeemQueue`, and `redeemQueue` to empty.
5. Upgrade proxy.
6. Call `updateDepositMaxDeviationBps(100)` and `updateRedeemMaxDeviationBps(100)`.
7. Unpause.

Step 4 is required because the new bps fields fall under the same "do not change while queues non-empty" rule as `priceOracle` / `maxStalePeriod` / fee rates.

### Operator pipeline changes

- Off-chain code that previously caught `InsufficientSettlementFunds` on the `processDepositQueue` floor must instead handle `OracleDeviationExceeded`.
- `_totalAsset` and `_newShares` should now be the actual settled values; small drift from the oracle is allowed in both directions, bounded by the configured bps.
- Symmetric band means the operator can no longer freely overshoot `_newShares` — any value outside `±depositMaxDeviationBps` of the oracle expectation reverts.

### Documentation

- Update `docs/DEPLOYMENT.md` with the post-upgrade setter step.
- Update the file-top operational-invariants comment in `Express.sol` to include both new bps vars.

## Testing

### Unit — `test/unit/Express.deviation.test.ts`

Setup helper deploys Express with oracle configured and seeds two pending redeem entries across two `sharesPerToken` epochs (forces cross-epoch fairness validation).

**processPendingRedeems:**
- Happy path: `_totalAsset == expectedTotal` exact; payouts split pro-rata by `shareAmount`; `Σ payouts ≤ _totalAsset`; per-entry fees correct; `redeemQueue` populated; events emitted.
- `_totalAsset` within `+redeemMaxDeviationBps` band → succeeds; payouts scale up.
- `_totalAsset` within `-redeemMaxDeviationBps` band → succeeds; payouts scale down.
- `_totalAsset` outside band, both directions → reverts `OracleDeviationExceeded`.
- `bps == 0` + 1 wei drift → reverts; `bps == 0` + exact match → succeeds.
- `priceOracle == address(0)` → deviation skipped; any `_totalAsset > 0` accepted; pro-rata distribution still correct.
- Delay-not-elapsed at index 0 → reverts `NoPendingRedeemsReady`.
- Delay-not-elapsed at index 2 with 0 and 1 ready → processes 2, `_totalAsset` interpreted relative to processed entries.
- KYC revoked between request and processing → reverts.
- `mgtFeeTo` entry mixed with regular entries → `totalMgtFeeUnclaimed` accounting unchanged.

**processDepositQueue (regression + new):**
- Happy path unchanged.
- `_newShares` within `±depositMaxDeviationBps` (both sides) → succeeds. Old behavior rejected the under-side.
- `_newShares` outside band, both directions → reverts `OracleDeviationExceeded`.
- `priceOracle == address(0)` → deviation skipped; any `_newShares > 0` accepted.
- `sharesPerToken` invariance re-verified.

**Setters:**
- Non-MAINTAINER → AccessControl revert.
- `_bps > BPS_BASE` → `InvalidInput`.
- Valid set → event emitted, storage updated.

### Integration

End-to-end deposit→redeem cycle with deviation tolerances at 1%, multi-user multi-epoch redeems, payouts asserted against expected pro-rata split of operator-supplied `_totalAsset`.

### Fuzz — `test/fuzz/Express.deviation.fuzz.ts`

Fuzz `_totalAsset` and `_newShares` over `[0.5×, 2×]` of oracle expectation against fuzzed `bps ∈ [0, 5000]`.

- Property: revert iff `|actual - expected| * BPS_BASE > expected * bps`.
- Property: when accepted, `Σ per-entry-payouts ≤ _totalAsset` (no over-distribution).

### Invariants

`sharesPerToken` invariant across `processPendingRedeems` calls (existing invariant test re-runs against new code path).

## Open Questions / Follow-Ups

- After this change, `InsufficientSettlementFunds` may have no remaining callers. Verify and remove in a separate cleanup PR.
- Consider whether `mgtFeeTo` redeems (which override `_tokenAmount` to `totalMgtFeeUnclaimed`) deserve a special-case path through the deviation check — current design treats them uniformly with regular entries, which is correct because they share the same `shareAmount` weighting.
