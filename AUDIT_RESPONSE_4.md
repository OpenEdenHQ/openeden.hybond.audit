# Hybond Remediation #4

---

## [WP-L1] The `RoundData.updatedAt` in PriceOracle Should Represent the Timestamp Corresponding to `RoundData.answer`, Rather Than the Transaction Execution Time `block.timestamp`

**Status: Fixed**

Commits:

- [5ed47ee](https://github.com/OpenEdenHQ/openeden.hybond.audit/commit/5ed47ee)

**Changes made:**

Added an `observedAt` field to the `PendingPrice` struct and a `_priceTimestamp` parameter to both `proposePrice()` and `initialize()`. This timestamp represents when the price was actually observed off-chain and must be non-zero and in the past (`< block.timestamp`). In `confirmPrice()`, both `startedAt` and `updatedAt` on the `RoundData` are now set to `pendingPriceValue.observedAt` instead of `proposedAt` or `block.timestamp`, ensuring round timestamps reflect the actual price observation time rather than on-chain transaction timing. The `pendingPrice()` view and `PriceProposed` event were updated to expose the new field. The storage gap was reduced from 40 to 39 to account for the new struct field.

---

## [WP-L2] `DoubleQueueModified` Derives from an Older Version of the OpenZeppelin `DoubleEndedQueue` and Inherits Some of Its Original Issues

**Status: Fixed**

Commits:

- [36f3eb6](https://github.com/OpenEdenHQ/openeden.hybond.audit/commit/36f3eb6)

**Changes made:**

Rewrote `DoubleQueueModified` based on OpenZeppelin v5.6.0's `DoubleEndedQueue.sol` (upgraded from v5.4.0 to v5.6.1). Key improvements:

- **Indices changed from `int128` to `uint128`**: Eliminates signed-integer edge cases and removes the hand-rolled `_toInt128`/`_toInt256` SafeCast helpers.
- **Overflow protection via `QueueFull` revert**: `pushBack()` and `pushFront()` now check for wraparound before writing, preventing silent corruption when the queue reaches capacity.
- **Consistent `unchecked` scoping**: All arithmetic that was previously partially unchecked is now fully wrapped, matching the upstream pattern.
- **Simplified `empty()` and `length()`**: `empty()` uses `==` instead of `<=`, and `length()` uses direct `uint128` subtraction, both safe under the unsigned index model.
- **Removed dead code**: Eliminated inline SafeCast functions (`_toInt128`, `_toInt256`) that are no longer needed.
- A copy of the upstream `DoubleEndedQueue.sol` was added under `reference/` for auditor comparison.
