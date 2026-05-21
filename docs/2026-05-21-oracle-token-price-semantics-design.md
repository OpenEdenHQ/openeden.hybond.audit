# Design: Oracle Returns Token Price (Semantic Migration)

**Date:** 2026-05-21
**Status:** Approved — ready for implementation plan
**Author:** brainstorming session with duke.du

## Summary

The price oracle (`priceOracle`) now returns the **token price** — assets-per-HYBOND-token — instead of the **share price** (assets-per-offchain-share) it was originally designed around. This change is operator-driven and external to the contract; this spec propagates the new semantics through `Express.sol` and updates the corresponding test suite.

Storage layout, the `offchainShares` accounting model, queue entry encoding, and the `sharesPerToken` invariance contract all remain unchanged. The change is **semantic**, not structural.

## Motivation

Earlier audit feedback and operational practice converged on quoting prices in token units: the off-chain net-asset-value report already expresses one HYBOND token's worth in underlying assets, so the oracle's published value matches that directly. Continuing to interpret the oracle as a share price requires the operator to publish a derived number (token-price × sharesPerToken_inverse), which is error-prone and duplicates state the contract already holds (`sharesPerToken`).

## Non-Goals

- Removing the `offchainShares` / `sharesPerToken` abstraction. Shares remain the bookkeeping unit for fund-level accounting; only the oracle's reported unit changes.
- Changing the queue entry ABI. `shareAmount` continues to be stored in pending/final redeem queue entries to preserve the "ratio at request time is locked in" guarantee.
- Reworking deposit/redeem invariance proofs. The `sharesPerToken` invariance during deposit and redeem (per `docs/2026-04-24-sharespertoken-invariance-design.md`) holds independently of oracle units.
- Rotating or upgrading `PriceOracle` itself. This spec only touches `Express.sol`. The oracle contract is treated as a black box whose return value is reinterpreted.

## Change Surface

### Unchanged

| Site | Reason |
|---|---|
| `requestRedeem` | Still records `shareAmount = tokenAmount × sharesPerToken()` for queue entries. Unaffected. |
| `offchainShares` increments/decrements | Bookkeeping unit unchanged. |
| Pro-rata distribution in `processPendingRedeems` | Pro-rata is unit-agnostic. Keeping it on stored `shareAmount` preserves request-time ratio locking. |
| Storage layout / events ABI | No new state, no event signature changes. |

> **Correction (Task 10, post-merge):** an earlier version of this spec listed `_calculateMintAmount` as unchanged based on a misread of the function body. The function actually derived `tokenPrice = price × sharesPerToken / 1e18` from the oracle's share-price output before computing `mint = assets / tokenPrice`. Under token-price oracle semantics that derivation is exactly the redundant conversion the original prompt called out. The fix is documented below in section 5.

### Changed

#### 1. `processDepositQueue` (Express.sol:759, deviation gate at :788)

**Before:**
```solidity
if (address(priceOracle) != address(0)) {
    uint256 oracleShares = Math.mulDiv(batchTotalNetAssets, 1e18, getPrice());
    _checkDeviation(_newShares, oracleShares, depositMaxDeviationBps);
}
```

**After:**
```solidity
if (address(priceOracle) != address(0)) {
    uint256 oracleTokens = Math.mulDiv(batchTotalNetAssets, 1e18, getPrice());
    uint256 oracleShares = Math.mulDiv(oracleTokens, _sharesPerToken(), 1e18);
    _checkDeviation(_newShares, oracleShares, depositMaxDeviationBps);
}
```

Rationale: `_newShares` (operator input) and `offchainShares` accumulation are unchanged. The deviation gate flips from `oracleShares = assets / sharePrice` to `oracleShares = (assets / tokenPrice) × sharesPerToken`. Algebraically equivalent under the substitution `sharePrice = tokenPrice / sharesPerToken`, so behavior is identical when the oracle is updated consistently with the new semantics.

`mintTotal = Math.mulDiv(_newShares, 1e18, currentRatio)` is **unchanged** — `_newShares` still means shares.

#### 2. `previewRedeem` (Express.sol:995)

**Before:**
```solidity
uint256 price = getPrice();
uint256 ratio = _sharesPerToken();
uint256 shareAmount = Math.mulDiv(_tokenAmount, ratio, 1e18);
redeemAssetAmt = _redeemAssetAmount(shareAmount, price);
feeAmt = txsFee(redeemAssetAmt, TxType.REDEEM);
netRedeemAssetAmt = redeemAssetAmt - feeAmt;
```

**After:**
```solidity
uint256 price = getPrice();
redeemAssetAmt = _redeemAssetAmount(_tokenAmount, price);
feeAmt = txsFee(redeemAssetAmt, TxType.REDEEM);
netRedeemAssetAmt = redeemAssetAmt - feeAmt;
```

Rationale: `tokens × tokenPrice = assets` directly. The intermediate share conversion was needed only when `price = sharePrice`. The `ratio` variable is dead.

#### 3. `processPendingRedeems` expected-total accumulation (Express.sol:1059)

**Before:**
```solidity
if (useOracle) {
    expectedTotal += _redeemAssetAmount(shareAmount, oraclePrice);
}
```

**After:**
```solidity
if (useOracle) {
    expectedTotal += _redeemAssetAmount(tokenAmount, oraclePrice);
}
```

Rationale: queue entries carry both `tokenAmount` and `shareAmount`. With token-price semantics, the expected redeem-asset payout is `tokens × tokenPrice`, so we read `tokenAmount` from the decoded entry instead of `shareAmount`.

**Important:** the Pass 2 pro-rata distribution (Express.sol:1085) continues to use `shareAmounts[i] / batchTotalShares`. Switching to `tokenAmount`-based pro-rata would change per-entry payouts whenever entries were enqueued under different `sharesPerToken` snapshots. Preserving the existing pro-rata weights honors the "request-time ratio is locked" property that the `shareAmount` field exists to provide.

#### 4. `_calculateMintAmount` (Express.sol:690)

**Before:**
```solidity
function _calculateMintAmount(address _asset, uint256 _netAssets) internal view returns (uint256 mintAmount) {
    uint256 amount = convertFromUnderlying(_asset, _netAssets);
    uint256 price = getPrice();
    uint256 tokenPrice = Math.mulDiv(price, _sharesPerToken(), 1e18);
    mintAmount = _trim(Math.mulDiv(amount, 1e18, tokenPrice));
}
```

**After:**
```solidity
function _calculateMintAmount(address _asset, uint256 _netAssets) internal view returns (uint256 mintAmount) {
    uint256 amount = convertFromUnderlying(_asset, _netAssets);
    uint256 price = getPrice();
    mintAmount = _trim(Math.mulDiv(amount, 1e18, price));
}
```

Rationale: when the oracle returned share-price, deriving token-price as `sharePrice × sharesPerToken` was necessary to divide assets correctly. Under the new semantics `getPrice()` already returns token-price, so the intermediate derivation produces the wrong divisor (`tokenPrice_buggy = tokenPrice × sharesPerToken`) and inflates `mintAmount` by `1 / sharesPerToken`.

Only `previewDeposit` calls this function — a `view` helper for UI / off-chain consumers. The on-chain deposit settlement path (`processDepositQueue`) does its own pro-rata mint based on operator-supplied `_newShares` and is unaffected. No accounting was corrupted on-chain; previews were just wrong.

#### 5. `_redeemAssetAmount` parameter rename (Express.sol:1743)

**Before:**
```solidity
function _redeemAssetAmount(uint256 _shareAmount, uint256 _price) internal view returns (uint256) { ... }
```

**After:**
```solidity
function _redeemAssetAmount(uint256 _amount18, uint256 _price) internal view returns (uint256) { ... }
```

Body unchanged. Callers now pass either shares (legacy callsite, but only one survives the changes above and the surviving callsite passes `tokenAmount`) or tokens (`previewRedeem`, `processPendingRedeems` expected-total). The body is unit-agnostic — it just multiplies an 18-decimal value by an 18-decimal price and converts to the asset's native decimals — so the parameter name should reflect that.

#### 6. Doc / comment updates

- `Express.sol` block comment on `priceOracle` declaration (around :121): note that the oracle reports **token price** (assets per HYBOND token), not share price.
- The mgtFeeTo invariant list (`Express.sol:80` block, item 7) already lists `priceOracle` among the "do not change while queues non-empty" parameters. No edit needed there — the constraint stands.
- `CLAUDE.md` ### Management Fee Accounting section, the bullet describing `_sharesPerToken` formula stays as-is. Add a one-liner under "Express Contract Queue Flow" noting oracle semantics:
  > Oracle returns token price (assets per HYBOND token). `sharesPerToken` is used to derive the equivalent share count when needed for `offchainShares` accounting.

### Events

`ProcessPendingRedeem` emits `oraclePrice` (Express.sol:1120). Field semantics change from share-price to token-price. No ABI change; only the off-chain interpretation of the field flips. Subgraph/indexer consumers must be informed.

## Test Plan

### Strategy

Tests fall into three buckets by how they currently configure the oracle mock:

**Bucket A — oracle disabled (priceOracle = address(0)).** `getPrice()` returns the 1e18 fallback. Under either semantic interpretation 1e18 is the same value (1:1 ratio = 1 asset per token = 1 asset per share when ratio is 1e18). **No test change needed.**

**Bucket B — oracle = 1e18 with `sharesPerToken = 1e18` (bootstrap state).** Same as above: under both old and new semantics the oracle returns 1e18 and the deviation/payout math produces identical results. **No test change needed.**

**Bucket C — oracle ≠ 1e18 OR `sharesPerToken ≠ 1e18`.** These are the tests that observe the semantic change. The mock oracle value must be converted from share-price to token-price: `tokenPrice = sharePrice × sharesPerToken / 1e18`. Assertions on intermediate values (`oracleShares` derivation, `expectedTotal` accumulation) must be updated.

### Files to audit and update

Run `grep -rn "priceOracle\|getPrice\|MockPriceFeed\|setPrice\|latestRoundData" test/` and triage each test against the bucket rules above. Anticipated touch points:

- `test/unit/Express.comprehensive.test.ts` — deposit-queue deviation tests, preview-redeem tests, processPendingRedeems deviation tests.
- `test/unit/Express.deviation.test.ts` (if exists) or equivalent — symmetric deviation gate coverage.
- `test/unit/Express.preview.test.ts` (if exists) — `previewRedeem` exact-value assertions.
- Any fixture under `test/fixtures/` that constructs a non-1e18 mock price.

### New test cases to add

1. **Oracle = token price under non-1e18 sharesPerToken (deposit deviation).** Set `sharesPerToken = 1.05e18`, mock oracle at exactly `1.05e18` (one HYBOND = 1.05 underlying). A batch depositing 1000 underlying should derive `oracleTokens ≈ 952.38`, `oracleShares ≈ 1000`. Verify deviation passes when operator supplies `_newShares = 1000`.

2. **Oracle = token price for `previewRedeem`.** Same ratio config. Verify `previewRedeem(1 HYBOND)` returns `redeemAssetAmt = 1.05` underlying (minus fee).

3. **`processPendingRedeems` expected-total uses tokenAmount.** Enqueue redeems at one `sharesPerToken`, then `updateEpoch` shifts the ratio before processing. Verify `expectedTotal` accumulator uses each entry's stored `tokenAmount` (not `shareAmount`), so a single-entry batch with `tokenAmount = T` produces `expectedTotal = T × tokenPrice / 1e18` regardless of stored `shareAmount`.

4. **Pro-rata distribution still honors stored shareAmount.** Two entries enqueued at different `sharesPerToken` snapshots. After `processPendingRedeems` with operator-supplied `_totalAsset`, each entry receives `_totalAsset × shareAmount_i / Σ shareAmount` — verified by reconstructing the snapshot ratios.

5. **Regression: bootstrap path (oracle = 1e18, sharesPerToken = 1e18).** Existing test should pass without modification. Add an explicit assertion that this combination behaves identically before and after the migration.

### Coverage gates

- `npm run coverage:unit` must not regress on `Express.sol` line coverage.
- `npm run test:express` must pass with zero modifications to the `getPrice()` mock harness (only mock *values* may change).

## Risks and Open Questions

1. **Operator coordination.** The oracle's external feed must publish token-price values starting at the same block the contract is upgraded. A mismatch (e.g., operator still publishes share-price after the upgrade) is silent — math still type-checks but produces wrong deposit/redeem amounts scaled by `sharesPerToken`. The on-chain deviation gate would mask this when `sharesPerToken ≈ 1e18` but flag it otherwise. **Mitigation:** stage upgrade with `sharesPerToken = 1e18` (no queued epochs) or pause queues during cutover.

2. **`updateEpoch` interaction.** Epoch minting dilutes `sharesPerToken`. Since the deviation gate now computes `oracleShares = oracleTokens × sharesPerToken`, an epoch update between request enqueue and processing changes the gate's derived shares — but `_newShares` (operator input) reflects post-epoch reality. This is correct and matches the pre-migration behavior; documenting for the audit reviewers.

3. **Subgraph/indexer consumers** of `ProcessPendingRedeem.oraclePrice` need to update their interpretation. This is out-of-scope for this PR but must be communicated.

4. **`_redeemAssetAmount` parameter rename and any external tooling.** Function is `internal`, so no ABI impact, but TypeChain regenerates if signatures change. Parameter names don't affect TypeChain output for internal functions. **No action.**

## Acceptance Criteria

- `_calculateMintAmount` simplified to drop the redundant share-to-token-price derivation; covered by an exact-value `previewDeposit` test under non-1e18 ratio.
- The four call sites above updated per the diffs in this spec.
- `priceOracle` declaration comment notes token-price semantics.
- All existing tests pass; new tests 1–5 above added and passing.
- Coverage non-regression on `Express.sol`.
- `CLAUDE.md` queue-flow section updated with the one-liner above.
