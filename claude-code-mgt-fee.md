# Fix: Management Fee Dilution in processPendingRedeems

## Context

When `mgtFeeRate > 0`, `claimMgtFee()` mints new tokens to `mgtFeeTo`, inflating `totalSupply` without adding off-chain BNY ETF shares. The off-chain shares only equal `circulatingSupply` (= totalSupply - redeemQueueShares - mgtFeeToShares).

Previously, `_processSinglePendingRedeem` converted the **full token amount** to USDC, but the operator only sells `shareAmount * sharesPerToken` BNY shares off-chain. This caused `processRedeemQueue` to revert due to insufficient USDC.

**Key distinction:** `updateEpoch()` only accrues fees to `unclaimedMgtFee` — it does **not** change `totalSupply` or `_sharesPerToken()`. The actual supply dilution happens when `claimMgtFee()` calls `token.mint(mgtFeeTo, _amount)`. Tests must use `claimMgtFee()` as the trigger for ratio changes, not `updateEpoch()` alone.

## Current State (already implemented)

### 1. `_sharesPerToken()` internal helper — DONE
**File:** `contracts/extension/Express.sol` (line 1474)

```solidity
function _sharesPerToken() internal view returns (uint256 ratio) {
    uint256 totalSupply = IERC20(address(token)).totalSupply();
    if (totalSupply == 0) return 1e18;
    ratio = Math.mulDiv(circulatingSupply(), 1e18, totalSupply);
}
```

External `sharesPerToken()` delegates to it at line 1394.

### 2. `_redeemAssetAmount()` helper — DONE
**File:** `contracts/extension/Express.sol` (line 1486)

Applies ratio and price in a single helper:
```solidity
function _redeemAssetAmount(uint256 _shareAmount, uint256 _ratio, uint256 _price)
    internal view returns (uint256 redeemAssetAmt)
{
    uint256 backedShareAmount = Math.mulDiv(_shareAmount, _ratio, 1e18);
    redeemAssetAmt = _trimAsset(
        Math.mulDiv(convertToUnderlying(redeemAsset, backedShareAmount), _price, 1e18),
        redeemAsset
    );
}
```

### 3. `processPendingRedeems` batch ratio snapshot — DONE
**File:** `contracts/extension/Express.sol` (line 784)

Ratio is captured **once per call** and passed to every item:
```solidity
uint256 currentRatio = _sharesPerToken();  // line 788 — snapshot once
// ...
_processSinglePendingRedeem(currentPrice, currentRatio);  // line 791 — passed, not recomputed
```

`_processSinglePendingRedeem` receives `currentRatio` as a parameter (line 808) — it does **not** call `_sharesPerToken()` itself. This ensures all items in one `processPendingRedeems` call use the same ratio, even though `totalRedeemQueueShares` changes as items are processed.

### 4. `previewRedeem` uses live ratio — DONE
**File:** `contracts/extension/Express.sol` (line 765)

```solidity
uint256 ratio = _sharesPerToken();
redeemAssetAmt = _redeemAssetAmount(_shareAmount, ratio, price);
```

**Note:** `previewRedeem` is inherently **indicative**. Between preview and actual `processPendingRedeems`, the ratio can change via `claimMgtFee()`, deposits, cancels, or reverts altering supply state.

### 5. Cancel/revert functions — No changes needed

**`cancelPendingRedeem` (line 867)**: Refunds full `shareAmount` in tokens — no USDC conversion, no fix needed.

**`revertRedeemToPending` (line 1035)**: Moves items from `redeemQueue` → `pendingRedeemQueue`, discarding old `redeemAssetAmt`/`feeAssetAmt`. Decrements `totalRedeemQueueShares` (increases `circulatingSupply`). When re-processed through `_processSinglePendingRedeem`, the batch-level ratio snapshot applies the updated ratio — correct behavior since the ratio should reflect state at re-processing time.

## Remaining Work: Tests

**File:** `test/unit/Express.comprehensive.test.ts`

| Test | What it verifies |
|------|-----------------|
| Redeem with no mgt fees (regression) | `sharesPerToken == 1e18`, amounts unchanged |
| Redeem after `claimMgtFee` | `claimMgtFee()` mints tokens → `sharesPerToken < 1e18` → `redeemAssetAmt` reduced by dilution ratio |
| `previewRedeem` matches actual (no intervening state changes) | Preview output equals processed event amounts **when no `claimMgtFee`, deposits, cancels, or reverts occur between preview and processing** |
| Batch processing consistency | Multiple redeems in one `processPendingRedeems` call all use the same ratio snapshot (not degraded by earlier items increasing `totalRedeemQueueShares`) |
| Full E2E with mgt fees | deposit → updateEpoch → `claimMgtFee` → requestRedeem → processPending → processRedeemQueue succeeds without revert |
| Revert-then-reprocess | revertRedeemToPending → `claimMgtFee` → processPendingRedeems again → ratio recalculated from current state |
| Cancel pending refunds tokens | cancelPendingRedeem returns full shareAmount, no USDC involved |

## Verification

1. `npm test` — all existing tests pass (no-op when mgtFeeRate is 0)
2. `npm run coverage:unit` — coverage ≥ 80%
3. New tests for management fee scenarios pass
4. No new state variables → UUPS storage layout safe
