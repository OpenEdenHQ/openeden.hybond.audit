# T+2 Ratio-Based Management Fee Redeem Plan

## Summary

Redemption settlement should use the `sharesPerToken()` ratio at T+2 batch processing time, not the request-time ratio.
The operator decides batch timing off-chain based on the 4:00pm SGT cutoff rules.
All redeems processed in one `processPendingRedeems` call should use one shared ratio snapshot captured at the start of that call.

## Intended Behavior

- If a redeem request belongs to the current sale batch, it should be priced using that batch's T+2 ratio.
- If a redeem request belongs to the next sale batch, it should be priced using the later batch's ratio.
- The contract should not enforce the 4:00pm SGT cutoff on-chain.
- The operator decides when the correct batch is ready and then calls `processPendingRedeems`.
- Users still burn the full Hybond token amount originally submitted.

## Core Contract Changes

- Update `processPendingRedeems`:
  - Capture `currentPrice = getPrice()` once per call.
  - Capture `currentRatio = _sharesPerToken()` once per call.
  - Use that same ratio for every redeem request moved from pending queue to redeem queue in that call.
- Update redeem pricing logic:
  - Compute redeem backing from original token units using `tokenAmount * currentRatio / 1e18`.
  - Convert that backed amount to redeem asset using existing conversion helpers and current price.
  - Apply trim only at the final redeem asset output stage.
- Update `previewRedeem`:
  - Use the live `_sharesPerToken()` ratio so preview reflects the current observable batch basis.
  - Document that preview is indicative and may drift before operator processing.

## Concrete Code Changes

### `contracts/extension/Express.sol`

- Add internal helper:
  - `function _sharesPerToken() internal view returns (uint256 ratio)`
  - implementation should match current external `sharesPerToken()` logic:
    - if `totalSupply == 0`, return `1e18`
    - otherwise return `Math.mulDiv(circulatingSupply(), 1e18, totalSupply)`
- Refactor external getter:
  - keep `function sharesPerToken() external view returns (uint256 ratio)`
  - make it delegate to `_sharesPerToken()`
- Add internal pricing helper:
  - `function _redeemAssetAmount(uint256 _tokenAmount, uint256 _ratio, uint256 _price) internal view returns (uint256 redeemAssetAmt)`
  - compute:
    - `backedAmount = Math.mulDiv(_tokenAmount, _ratio, 1e18)`
    - `redeemAssetAmt = _trimAsset(Math.mulDiv(convertToUnderlying(redeemAsset, backedAmount), _price, 1e18), redeemAsset)`
- Change `previewRedeem(uint256 _shareAmount)`:
  - replace raw token conversion with `_redeemAssetAmount(_shareAmount, _sharesPerToken(), getPrice())`
  - keep fee calculation unchanged
- Change `processPendingRedeems(uint256 _len)`:
  - before the loop, read:
    - `uint256 currentPrice = getPrice();`
    - `uint256 currentRatio = _sharesPerToken();`
  - pass both values into the internal per-item processing function
- Change `_processSinglePendingRedeem(...)`:
  - update signature to accept `currentRatio`
  - do not call `_sharesPerToken()` inside the helper
  - compute `redeemAssetAmt` via `_redeemAssetAmount(shareAmount, currentRatio, currentPrice)`
  - keep storing the original `shareAmount` in the final redeem queue
  - keep fee calculation and event flow unchanged

### Functions That Must Not Change Semantics

- `requestRedeem`
  - continue storing the original token amount only
  - do not convert or round at request time
- `processRedeemQueue`
  - continue burning the original token amount
  - continue transferring the precomputed redeem asset amount
- `cancelPendingRedeem`
  - continue refunding the original token amount
  - no ratio logic should be added
- `cancelRedeem`
  - continue refunding the original token amount
  - do not attempt to reverse from priced redeem asset values
- `revertRedeemToPending`
  - continue discarding old `redeemAssetAmt` and `feeAssetAmt`
  - continue restoring the original token amount back into pending
  - reprocessing should use the next call's `currentRatio` and `currentPrice`

## Precision And Reversibility Rules

Original token amount must remain the source of truth for every redeem request.
Derived pricing values must be treated as disposable outputs.

- `pendingRedeemQueue` should store:
  - original `tokenAmount`
  - request metadata
- `redeemQueue` should store:
  - original `tokenAmount`
  - derived `redeemAssetAmt`
  - derived `feeAssetAmt`
  - optional audit metadata such as `ratioUsed` and `priceUsed`

This is required because converting to backed amount or redeem asset amount introduces rounding.
If we later revert or cancel based on converted values, precision loss accumulates and exact user value cannot be restored.

Therefore:

- `cancelPendingRedeem` refunds the original `tokenAmount`
- `cancelRedeem` refunds the original `tokenAmount`
- `revertRedeemToPending` discards the old derived priced values and restores the original `tokenAmount` to pending
- if repriced later, recompute from the original `tokenAmount`, not from any previously rounded converted amount

## Queue Function Requirements

### `processPendingRedeems`

- Must use one ratio snapshot per call, not per item.
- Must not let earlier items in the same batch change the ratio for later items.
- Must compute final redeem asset amount from original token units and the call-level ratio.
- Implementation requirement:
  - read `currentRatio` once in `processPendingRedeems`
  - pass it into `_processSinglePendingRedeem`
  - never recompute `_sharesPerToken()` inside `_processSinglePendingRedeem`

### `cancelPendingRedeem`

- Should remain token-based only.
- No priced redeem asset amount has been finalized yet.
- Refund must equal the original token amount held by the contract.

### `cancelRedeem`

- Should remain token-based only.
- Previously computed redeem asset amount belongs only to that processed batch and should be discarded on cancel.
- Refund must equal the original token amount.

### `revertRedeemToPending`

- Must move the original token amount back to pending queue.
- Must discard old `redeemAssetAmt` and `feeAssetAmt`.
- Repricing later must use the new batch ratio and price.
- Original request timestamp can be preserved unless product later decides reverted items should join a fresh operational batch by timestamp.

## Important Review Points

- Confirm `circulatingSupply()` still matches intended economics when final redeem queue balances are excluded.
- Confirm preview drift is acceptable because final settlement basis is the later operator-selected batch.
- Confirm revert semantics should preserve original request timestamp.
- Confirm optional audit metadata is needed or not.

## Test Plan

- Add test: redeem after management fee claim
  - accrue and claim management fee
  - verify `sharesPerToken() < 1`
  - request redeem
  - process pending redeem
  - assert final queued redeem amount is lower than raw token amount at 1:1 price
- Add test: same-batch consistency
  - multiple pending redeems
  - process all in one call
  - assert all use the same ratio basis captured at the start of the call
- Add test: multi-batch repricing
  - process one batch
  - change supply via mint, burn, or fee claim
  - process later batch
  - assert later batch uses new ratio
- Add test: revert-to-pending repricing
  - process into final queue
  - revert to pending
  - change supply state
  - process again
  - assert repricing uses new ratio, not old derived values
- Add test: cancel pending redeem
  - confirm exact original token amount is refunded
- Add test: cancel final redeem
  - confirm exact original token amount is refunded
- Add test: preview drift is allowed
  - capture preview
  - change supply state via `claimMgtFee()` or queue movement
  - confirm later processed redeem amount may differ from the earlier preview
- Re-run focused tests around:
  - redeem flow
  - management fee claim
  - shares per token
  - cancel and revert queue paths

## Assumptions

- The operator decides batch readiness off-chain.
- One `processPendingRedeems` call corresponds to one operational batch and one ratio.
- Cancellation remains token-based, not price-based.
- Original token units are always preserved to avoid irreversible rounding loss.
