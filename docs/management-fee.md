# Overview

Hybond is a token issued via `Token.sol`, used to tokenize real-world assets: a BNY ETF Fund. The Express contract manages deposits, redeems, and the daily management fee.

## Key state

- `offchainShares` — the normalized fund share balance (18-decimal), updated automatically by `processDepositQueue` (increment) and `requestRedeem` (decrement). Admin override via `updateOffchainShares` for rare reconciliation.
- `totalRedeemQueueTokens` — token amount committed to both pending and final redeem queues. Incremented at `requestRedeem` time, decremented at `processRedeemQueue` (burn) or cancel time.
- `totalMgtFeeUnclaimed` — live (unredeemed) fee tokens held by `mgtFeeTo`. Zeroed at `requestRedeem` time when `mgtFeeTo` redeems.

## sharesPerToken formula

```
sharesPerToken = offchainShares / (totalSupply - totalRedeemQueueTokens)
```

- Denominator excludes tokens committed to both pending and final redeem queues.
- Returns the `1e18` fallback when either the denominator is zero (bootstrap / full exit) or `offchainShares == 0` (pre-sync). In the pre-sync window, deposits and redeems settle at 1:1 — economically fair and safe because `updateEpoch` is a no-op when `offchainShares == 0`.
- **The ratio is invariant during deposit and redeem operations.** It only changes on `updateEpoch` (fee dilution) or `updateOffchainShares` (rare admin override).

## Roles

- `OPERATOR_ROLE` — processes pending/final redeem queues, calls `updateEpoch`.
- `MAINTAINER_ROLE` — config updates, `processDepositQueue`, `updateOffchainShares`.

## Token Mint Workflow (`Express.sol::requestDeposit`)

1. User calls `requestDeposit` to deposit asset to the contract at T+0.
2. Fund operator transfers the asset to buy fund shares off-chain at T+0 EOD.
3. At T+2, fund custodian provides the share price and share amount.
4. Fund operator updates the share price in `PriceOracle.sol` via `proposePrice` and `confirmPrice`.
5. Fund operator calls `processDepositQueue(_len, _newShares)` (MAINTAINER_ROLE) to mint Hybond tokens to users. `_newShares` is the actual fund shares acquired for this batch. Tokens are minted pro-rata to preserve the `sharesPerToken` ratio.
6. `offchainShares` is automatically incremented by `_newShares`.
7. User receives Hybond tokens in their wallet.

## Token Redeem Workflow (`Express.sol::requestRedeem`)

1. User calls `requestRedeem` to redeem Hybond at T+0. `offchainShares` is immediately decremented by the equivalent fund shares (calculated from `sharesPerToken`). `totalRedeemQueueTokens` is incremented.
2. Fund operator sells fund shares off-chain at T+0 EOD.
3. At T+2, fund custodian provides the sell price and asset amount received.
4. Fund operator updates the price in `PriceOracle.sol` via `proposePrice` and `confirmPrice`.
5. Fund operator calls `processPendingRedeems(_len, _totalAsset)` (OPERATOR_ROLE) to lock in redeem asset amounts using the oracle price. `_totalAsset` is the actual asset received (sanity bound). Requests move from `pendingRedeemQueue` to `redeemQueue`.
6. At T+4, the asset is received from the fund custodian.
7. Fund operator calls `processRedeemQueue` (OPERATOR_ROLE) to burn Hybond tokens and transfer asset to users (FIFO).

## Management Fee

1. Fund operator calls `updateEpoch` (OPERATOR_ROLE) daily to calculate and mint that day's management fee to `mgtFeeTo`.
2. Fee base is `offchainShares` (the real AUM), not circulating HYBOND. Matches how real-world funds charge management fees on AUM rather than on issued shares.
3. Formula: `dailyFee = offchainShares * mgtFeeRate / (365 * BPS_BASE)`, trimmed to `trimDecimals` precision.
4. `updateEpoch` reverts when `mgtFeeRate == 0` (`MgtFeeDisabled`) or when `timeBuffer` hasn't elapsed since the last call (`UpdateTooEarly`).

## Combined Daily Workflow

### 1. User Side (T+0)

1.1. User calls `requestDeposit` to deposit asset.
1.2. User calls `requestRedeem` to redeem Hybond. `offchainShares` and `totalRedeemQueueTokens` adjust immediately.

### 2. Fund Operator Side (T+0 EOD)

2.1. Transfer asset to buy fund shares off-chain.
2.2. Sell fund shares for redeem requests.

### 3. Fund Operator Side (T+2)

3.1. Receive share price and share amount from fund custodian.

### 4. Fund Operator Side (T+2, Daily Batch)

Each step has its own trigger — the ordering below is the required sequence **when a step runs**, not a requirement that every step runs every day.

| Step | Function                       | Role              | When to run                                                                    | Why this order / notes                                                       |
| ---- | ------------------------------ | ----------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 4.1  | `proposePrice`                 | OPERATOR_ROLE     | **Business days only** (fund publishes price)                                  | Oracle price must be fresh before any mint/redeem arithmetic                 |
| 4.2  | `confirmPrice`                 | CONFIRM_ROLE      | **Business days only** (pairs with 4.1)                                        | Echo-confirm the proposed price                                              |
| 4.3  | `processDepositQueue`          | MAINTAINER_ROLE   | **Only if T+2 deposit requests are ready**                                     | Mint priced pro-rata from operator-supplied `_newShares`. `offchainShares` incremented automatically |
| 4.4  | `updateEpoch`                  | OPERATOR_ROLE     | **Daily**                                                                      | Accrue daily fee on current `offchainShares`                                 |
| 4.5  | `processPendingRedeems`        | OPERATOR_ROLE     | **Only if T+2 redeem requests are ready**                                      | Move delay-ripe entries into the final queue. Oracle price used for asset amount. `_totalAsset` sanity bound validated |
| 4.6  | `processRedeemQueue`           | OPERATOR_ROLE     | **Only if T+4 asset has arrived** for that batch                               | Burn Hybond and pay asset (FIFO, liquidity-gated)                            |

**Rationale:**

- Steps 4.1-4.2 (oracle price) must precede any step that reads `getPrice()` — `processPendingRedeems` (redeem pricing).
- Step 4.3 before 4.4 so deposits are processed before fee accrual. `offchainShares` is updated automatically by `processDepositQueue`.
- Step 4.4 (`updateEpoch`) accrues fees on the current `offchainShares` (which already reflects today's deposits from step 4.3).
- Step 4.5 (`processPendingRedeems`) uses the `shareAmount` baked into each queue entry at `requestRedeem` time — no snapshot needed.

**Non-business days:** only step 4.4 (`updateEpoch`) runs, accruing the daily fee against the current `offchainShares`. All other steps are conditional on market activity (price publication, T+2/T+4 settlement, fresh requests).

### 5. Settlement (T+4)

5.1. Receive asset from fund custodian for the batch.
5.2. Fund operator calls `processRedeemQueue` to settle any remaining redeems that were liquidity-gated on T+2.

## Design Decision: Immediate Minting vs Accumulation

### Why accumulation fails

An earlier design had `updateEpoch` accumulate fees in a counter (`unclaimedMgtFee += dailyFee`) without minting, with a separate `claimMgtFee()` to mint later. This is fundamentally broken: if no tokens are minted for fees, `totalSupply` never changes. The pricing formula sees no dilution, so redeemers get paid at the pre-fee ratio.

The current design mints fee tokens immediately to `mgtFeeTo`. `totalSupply` grows; `offchainShares` stays constant; `sharesPerToken` drops. Redeemers are priced at the correct post-fee ratio.

### Numeric example

**Setup:** `offchainShares = totalSupply = 100,000e18`; 3% annual management fee; 30 days elapsed; fund balance unchanged.

| | Accumulate (broken) | Mint daily (current) |
|---|---|---|
| `totalSupply` after 30 days | 100,000 (unchanged) | 100,246.6 (fee tokens minted) |
| `mgtFeeTo` balance | 0 | 246.6 |
| `offchainShares` | 100,000 | 100,000 |
| `sharesPerToken` | 100,000 / 100,000 = **1.0** | 100,000 / 100,246.6 = **0.99754** |
| Redeemer with 10,000 tokens receives | 10,000 x 1.0 = 10,000 (overpaid) | 10,000 x 0.99754 = **9,975.4** (correct) |

Daily fee = `offchainShares x 0.03 / 365 = 8.22` tokens/day. Over 30 days = 246.6 tokens minted to `mgtFeeTo`.

### Edge case: `mgtFeeTo` transfers

Operational invariant: **`mgtFeeTo` must only move tokens to Express via `requestRedeem`**. Direct transfers to other addresses desync `totalMgtFeeUnclaimed` against on-chain fee ownership, since fee-share provenance is keyed on sender identity.

When `mgtFeeTo` calls `requestRedeem`, the contract **overrides** the caller-supplied `_tokenAmount` to `totalMgtFeeUnclaimed` (full live balance) and zeroes it immediately to prevent double-redeem. The `redeemMinimum` check is also skipped so small daily fee balances can be claimed.

See the comment block at `Express.sol:80` for the full list of operational invariants.
