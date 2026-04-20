# Offchain Shares Redesign — Design Spec

**Date:** 2026-04-19 (updated 2026-04-20)
**Author:** duke.du@openeden.com
**Status:** Implemented on branch `refactor/offchain-shares`
**Target contract:** `contracts/extension/Express.sol`
**Operational reference:** [`docs/management-fee.md`](../../management-fee.md)

## 1. Problem

The previous `_sharesPerToken()` formula was:

```
sharesPerToken = circulating / (circulating + totalMgtFeeMinted)
```

where `totalMgtFeeMinted` was a cumulative, monotonically-increasing counter of all management-fee tokens ever minted. The ratio was derived purely from on-chain state and had no link to the real offchain BNY SDHY Bond Fund share balance that HYBOND is supposed to track.

Consequences of the old design:

- The ratio could not be reconciled with the offchain BNY supply. Any drift between the fund's real share balance and HYBOND's implicit accounting accumulated silently.
- After the first user redeem reached the final queue, the ratio no longer represented a direct "BNY per HYBOND" quantity — it represented cumulative fee dilution spread over the current circulating supply.
- Operators had no way to inject the offchain truth into the on-chain model.

## 2. Goals

1. Make HYBOND's on-chain `sharesPerToken` track the real BNY fund share balance, updated by an offchain bot.
2. Preserve the queued deposit/redeem flow and per-entry T+2 snapshot pricing.
3. Charge management fee on real AUM (`offchainShares`), not on issued HYBOND (`circulating`).
4. No migration burden — the contract is not yet deployed; storage can be restructured freely.

## 3. Non-goals

- Replacing the `priceOracle` used for asset pricing. That stays (USDC/BNY price feed, separate from `offchainShares`).
- Moving `offchainShares` into an external oracle contract. The propose/confirm mechanism lives inside `Express.sol`.

## 4. Approach

**In-place refactor of `Express.sol`.** Remove the cumulative-fee tracker; add a two-step propose/confirm pipeline for the offchain BNY share value; retarget `_sharesPerToken()` and `updateEpoch` at the new formula.

## 5. Design

### 5.1 Formula

```
denom = ERC20.totalSupply - totalRedeemQueueShares
sharesPerToken = offchainShares / denom    (scaled by 1e18)
```

Returns the `1e18` fallback when either the denominator is zero (bootstrap / full exit) or `offchainShares == 0` (pre-first-sync). In the pre-sync window deposits and redeems settle at 1:1 — fair (users get the asset-value of their shares) and safe because `updateEpoch` accrues zero fee while `offchainShares == 0`.

Denominator excludes the final redeem queue (those shares are locked at their snapshot ratio). Pending-redeem-queue shares are included.

**Units:** `offchainShares` is expressed in the same 18-decimal convention as HYBOND's `totalSupply`. The offchain bot normalizes the raw BNY share balance into this unit before calling `proposeOffchainShares`. The contract treats `offchainShares` as a dimensionless 18-decimal quantity directly comparable to `totalSupply`.

### 5.2 State variables

**Removed:**
- `uint256 public totalMgtFeeMinted` — cumulative fee tracker, replaced by the new formula.
- `uint256 public epoch` — counter (off-chain indexers count `UpdateEpoch` events instead).
- `uint256 public convertRedeemRequestsDelay` — on-chain T+N gate (now enforced by operator off-chain).

**Added:**
- `uint256 public offchainShares` — active BNY share value, numerator of `_sharesPerToken()`.
- `uint256 public proposedOffchainShares` — pending value awaiting confirmation. `0` means no pending proposal.

**Retained unchanged:**
- `totalMgtFeeUnclaimed`, `totalRedeemQueueShares`, `snapshotRatios`, `lastUpdateTS`, `timeBuffer`, all queue state.

### 5.3 Roles

**Added:**
- `bytes32 public constant CONFIRM_ROLE = keccak256("CONFIRM_ROLE")`.

**Usage:**
- `OPERATOR_ROLE` — proposes offchain shares, calls `updateEpoch`, processes queues.
- `CONFIRM_ROLE` — echo-confirms the proposed offchain share value.

Two-wallet separation between operator and confirmer is an operational policy, not an on-chain check. `AccessControl` alone gates the calls.

### 5.4 New functions

```solidity
function proposeOffchainShares(uint256 _supply) external onlyRole(OPERATOR_ROLE);
function confirmOffchainShares(uint256 _supply) external onlyRole(CONFIRM_ROLE);
```

**`proposeOffchainShares`:**
- Reverts `InvalidAmount` if `_supply == 0`.
- Writes `proposedOffchainShares = _supply` (overwrites any prior pending value — latest-wins).
- Emits `ProposeOffchainShares(msg.sender, _supply)`.

**`confirmOffchainShares`:**
- Reverts `InvalidAmount` if `proposedOffchainShares == 0`.
- Reverts `InvalidInput(_supply)` if `_supply != proposedOffchainShares` (echo-value check).
- Sets `offchainShares = _supply`, clears `proposedOffchainShares`.
- Emits `ConfirmOffchainShares(msg.sender, _supply, previousOffchainShares)`.

**Recovery from a bad proposal:** no explicit cancel function. If the operator realizes a value is wrong, they re-propose the correct one (latest-wins overwrites the pending slot) and the confirmer echoes the new value. To clear a pending proposal without committing a new value, propose the current `offchainShares` and confirm (no-op).

**Views:** `offchainShares` and `proposedOffchainShares` are public, giving automatic getters. No extra view functions required.

### 5.5 Modified functions

**`_sharesPerToken()`:**

```solidity
function _sharesPerToken() internal view returns (uint256 ratio) {
    uint256 totalSupply = IERC20(address(token)).totalSupply();
    uint256 denom = totalSupply - totalRedeemQueueShares;
    if (offchainShares == 0 || denom == 0) return 1e18;
    ratio = Math.mulDiv(offchainShares, 1e18, denom);
}
```

**Deposit and redeem paths:** no guards on `offchainShares`. The 1e18 fallback in `_sharesPerToken()` means pre-sync deposits and redeems settle at 1:1 — economically fair.

**`updateEpoch` (inlined, no internal helper):**

```solidity
function updateEpoch() external onlyRole(OPERATOR_ROLE) {
    if (mgtFeeRate == 0) revert MgtFeeDisabled();
    if (proposedOffchainShares != 0) revert PendingProposalExists(proposedOffchainShares);
    if (lastUpdateTS != 0 && block.timestamp < lastUpdateTS + timeBuffer) {
        revert UpdateTooEarly(block.timestamp);
    }

    uint256 dailyFee = _trim(_calculateDailyMgtFee(offchainShares));
    if (dailyFee > 0) {
        if (mgtFeeTo == address(0)) revert InvalidAddress();
        totalMgtFeeUnclaimed += dailyFee;
        token.mint(mgtFeeTo, dailyFee);
    }

    lastUpdateTS = block.timestamp;
    emit UpdateEpoch(dailyFee, offchainShares);
}
```

Key properties:
- **Fee base is `offchainShares` (AUM), not `circulating`.** Matches how real-world funds charge management fees.
- **`PendingProposalExists` guard** forces the bot to confirm a fresh `offchainShares` before accruing fees.
- **No-op when `offchainShares == 0`:** `dailyFee = 0 * rate = 0`, no mint, no dilution. Safe in the pre-sync window.
- **No `epoch` counter.** Off-chain indexers count `UpdateEpoch` events.

**Deleted surface (from original contract):**
- `function updateEpochAdjust(uint256)` — emergency override path removed.
- `function _updateEpochInternal(uint256, bool)` — inlined into `updateEpoch`.
- `function updateConvertRedeemRequestsDelay(uint256)` — state variable removed.
- `error DrainedInstance` — replaced by the 1e18 fallback semantics.
- `error OffchainSharesNotSet` — no longer needed after the fallback simplification.
- `event UpdateConvertRedeemRequestsDelay(uint256)`.
- `uint256 public totalMgtFeeMinted` + all references.
- `uint256 public epoch` + all references.
- `uint256 public convertRedeemRequestsDelay` + all references.
- Delay check in `_processSinglePendingRedeem` — operator enforces T+N off-chain.

**`updateMgtFeeTo`:** existing preconditions retained (`totalMgtFeeUnclaimed == 0`, both redeem queues empty).

**`setSnapshotRatio`:** `_ratio > 1e18` upper bound removed. Under the new formula, ratios above 1e18 are valid (BNY can grow faster than supply), so the MAINTAINER manual-override path must accept them.

### 5.6 Events

**Modified:**
```solidity
// Before:
event UpdateEpoch(uint256 totalMgtFeeMinted, uint256 dailyFee, uint256 epoch, uint256 circulatingSupply);
// After:
event UpdateEpoch(uint256 dailyFee, uint256 offchainShares);
```

**Added:**
```solidity
event ProposeOffchainShares(address indexed proposer, uint256 supply);
event ConfirmOffchainShares(address indexed confirmer, uint256 newSupply, uint256 previousSupply);
```

**Removed:**
```solidity
event UpdateConvertRedeemRequestsDelay(uint256 delay);
```

Indexers / subgraphs must update their schemas.

### 5.7 Errors

**Added:**
- `error PendingProposalExists(uint256 pendingValue);`

**Removed:**
- `error DrainedInstance();`
- `error OffchainSharesNotSet();`

**Reused (no changes):**
- `InvalidAmount` — zero supply on propose, empty proposal on confirm.
- `InvalidInput(uint256)` — echo-value mismatch on confirm.

### 5.8 Daily routine

See [`docs/management-fee.md`](../../management-fee.md) for the authoritative operational workflow, including per-step triggers (business-day gating, T+2 / T+4 settlement timing, and fresh-request conditions). The sequence is:

1. `proposePrice` + `confirmPrice` — `PriceOracle.sol`
2. `processDepositQueue` — mint for T+2-ready deposits
3. `proposeOffchainShares` + `confirmOffchainShares` — sync new BNY balance
4. `updateEpoch` — accrue daily fee on fresh `offchainShares`
5. `processPendingRedeems` — move T+2-ready entries pending → final
6. `processRedeemQueue` — burn and pay USDC (T+4 settlement)
7. `snapshotPendingRedeemRatio` — freeze ratio for today's fresh pending entries

**Ordering is operational, not on-chain enforced** (except `PendingProposalExists` in step 4 which gates on step 3's confirm).

### 5.9 Ratio movement summary

| Event | totalSupply | totalRedeemQueueShares | offchainShares | sharesPerToken |
|---|---|---|---|---|
| User deposit mints | ↑ | — | unchanged until bot confirms | drops transiently |
| Confirm offchain shares | — | — | ↑ or ↓ | snaps to new truth |
| updateEpoch (fee mint) | ↑ | — | — | drops (this is the fee dilution) |
| processPendingQueue (pending → final) | — | ↑ | — | rises (denom shrinks) |
| processRedeemQueue (burn) | ↓ | ↓ (same amount) | unchanged until bot confirms | unchanged by burn |

### 5.10 Pre-sync behavior (supersedes "bootstrap and drained" in the original draft)

**Pre-sync window** (`offchainShares == 0`, any `totalSupply`):
- `_sharesPerToken()` returns `1e18` fallback.
- Deposits mint at 1:1 against the asset price. Redeems settle at 1:1.
- `updateEpoch` accrues `dailyFee = 0` — no dilution possible.
- `snapshotPendingRedeemRatio` records `1e18` for any pending entries; later processing settles at that ratio.

**Post-sync** (`offchainShares > 0`):
- Full formula applies.
- The bot is responsible for keeping `offchainShares` synced with the real BNY balance after every deposit-queue process, fee claim, buy, or sell.

There is no distinct "drained" state in the new model. If the fund wound down and `offchainShares` were somehow 0 while tokens still exist, the contract still permits 1:1 deposits/redeems — fair behavior given there's no AUM to price against.

### 5.11 Edge cases

| Scenario | Behavior |
|---|---|
| Operator proposes wrong value, confirmer echoes it | Ratio becomes wrong. Recovery: propose + confirm correct value. |
| Operator proposes, confirmer offline, operator re-proposes | Latest propose wins; pending value overwritten. |
| `updateEpoch` called with pending proposal | Reverts `PendingProposalExists`. Resolve by confirming, or by re-proposing then confirming. |
| `revertRedeemToPending` | Per-entry snapshot migration preserved. Snapshot moves from final ID back to new pending ID. |
| `cancelRedeem` / `cancelPendingRedeem` for `mgtFeeTo` | `totalMgtFeeUnclaimed` re-credit preserved. |
| Concurrent deposits in the pre-sync window | All mint at 1:1 fallback in the same batch — no stuck queue. Bot syncs after the batch. |

### 5.12 Operational invariants

Documented, not enforced on-chain:

- Operator wallet and confirmer wallet are governed independently (two-signer discipline).
- Operator enforces T+N redeem delay — there is no on-chain `convertRedeemRequestsDelay` gate. `processPendingRedeems` must not be called before the intended T+N boundary.
- Bot re-syncs `offchainShares` after every event that changes BNY balance (fee claim, buy, sell).
- Bot must call propose+confirm before `updateEpoch` can run (enforced by `PendingProposalExists`).
- `mgtFeeTo` wallet transfers shares only to Express via `requestRedeem` (see `Express.sol:80` operational invariants block).

## 6. Testing

Current state on branch `refactor/offchain-shares`: **325+ tests passing**, 0 failing.

**New test files:**
- `test/unit/Express.OffchainShares.test.ts` — propose/confirm, pre-sync fallback, concurrent bootstrap, `setSnapshotRatio` bounds, `PendingProposalExists` guard recovery.
- `test/integration/DailyRoutine.test.ts` — 3-day end-to-end scenario covering deposits, fee accrual, T+2 pricing, T+4 settlement.

**Updated test files:**
- `test/unit/Express.sharePerToken.test.ts` — rewritten against new formula.
- `test/unit/Express.comprehensive.test.ts` — seeded `offchainShares` via `seedOffchainShares` helper; retargeted two tests that asserted circulating-based behavior to offchainShares-based.
- `test/unit/Express.mgtFeeAccounting.test.ts` — fixtures updated.
- `test/fixtures/expressDeployments.ts` — adds `bootstrapAndSeedOffchainShares` helper.

## 7. Rollout

1. Implement on feature branch `refactor/offchain-shares`. ✓
2. Run unit + integration + invariant suites. ✓
3. Code review + security review. ✓ (all findings addressed)
4. Deploy to testnet and run the daily routine end-to-end with the offchain bot for at least one cycle.
5. Promote to mainnet once the bot's propose/confirm loop is verified.

## 8. Resolved design decisions

- **No explicit cancel for a pending proposal.** Recovery is via re-propose + echo-confirm. Keeps the external surface minimal.
- **Fee base is `offchainShares`, not `circulating`.** Matches how real-world funds charge on AUM.
- **Pre-sync fallback to 1e18 instead of guard reverts.** Simpler surface; safe because `updateEpoch` is a no-op when `offchainShares == 0`.
- **No on-chain T+N delay gate.** Operator enforces the redeem delay off-chain; snapshot mechanism is the real price-lock.
- **No `epoch` counter on-chain.** Off-chain indexers count `UpdateEpoch` events.
- **`setSnapshotRatio` accepts ratios > 1e18.** Valid under the new formula when BNY grows faster than supply.

## 9. Open operational items (non-contract)

- Minimal automated reconciliation job to verify on-chain `offchainShares` matches the real BNY balance daily and alert on drift.
- Bot implementation for the daily routine with correct step ordering and trigger conditions (see `docs/management-fee.md`).
- Runbook entry: on mainnet deploy, set `Express.confirmer` in network config to a distinct, hardware-secured wallet before first use. The zero-address fallback to deployer is acceptable on testnet only.
