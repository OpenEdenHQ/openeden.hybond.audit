# Overview

Hybond is a token issued via `Token.sol`, used to tokenize real-world assets: a BNY ETF Fund. The Express contract manages deposits, redeems, and the daily management fee.

## Key state

- `offchainShares` — the normalized BNY share balance (18-decimal), set via a two-step propose+confirm flow. This is the numerator of `sharesPerToken`.
- `proposedOffchainShares` — pending value awaiting confirmation. Zero means no pending proposal.
- `totalRedeemQueueShares` — shares in the final redeem queue (already priced at their snapshot).
- `totalMgtFeeUnclaimed` — live (unredeemed) fee shares held by `mgtFeeTo`.

## sharesPerToken formula

```
sharesPerToken = offchainShares / (totalSupply - totalRedeemQueueShares)
```

- Denominator excludes the final redeem queue (those shares are locked at their snapshot ratio).
- Returns the `1e18` fallback when either the denominator is zero (bootstrap / full exit) or `offchainShares == 0` (pre-sync). In the pre-sync window, deposits and redeems settle at 1:1 — economically fair (users get the asset-value of their shares) and safe because `updateEpoch` is a no-op when `offchainShares == 0`.

## Roles

- `OPERATOR_ROLE` — processes queues, proposes `offchainShares`, calls `updateEpoch`.
- `CONFIRM_ROLE` — echo-confirms the proposed `offchainShares` value.
- `MAINTAINER_ROLE` — config updates, `processDepositQueue`.

## Token Mint Workflow (`Express.sol::requestDeposit`)

1. User calls `requestDeposit` to deposit USDC to the contract at T+0.
2. Fund operator transfers the USDC to buy BNY ETF Fund off-chain at T+0 EOD.
3. At T+2, BNY emails us the share price and share amount of the BNY ETF Fund.
4. Fund operator updates the share price in `PriceOracle.sol` via `proposePrice` and `confirmPrice`.
5. Fund operator calls `processDepositQueue` (MAINTAINER_ROLE) to mint Hybond tokens to users.
6. Fund operator calls `proposeOffchainShares` (OPERATOR_ROLE) and CONFIRM_ROLE calls `confirmOffchainShares` to sync the new BNY share balance.
7. User receives Hybond tokens in their wallet.

## Token Redeem Workflow (`Express.sol::requestRedeem`)

1. User calls `requestRedeem` to redeem Hybond for USDC at T+0.
2. Fund operator reads `sharesPerToken` to calculate the off-chain BNY shares to sell.
3. Fund operator sells BNY ETF Fund shares off-chain at T+0 EOD.
4. At T+2, BNY emails us the sell price and USDC amount we will receive.
5. Fund operator updates the price in `PriceOracle.sol` via `proposePrice` and `confirmPrice`.
6. Fund operator calls `processPendingRedeems` (OPERATOR_ROLE) to lock in USDC amounts using the current price and `sharesPerToken` ratio. Requests move from `pendingRedeemQueue` to `redeemQueue`.
7. At T+4, we receive the USDC from BNY.
8. Fund operator calls `processRedeemQueue` (OPERATOR_ROLE) to burn Hybond tokens and transfer USDC to users (FIFO).

## Management Fee

1. Fund operator calls `updateEpoch` (OPERATOR_ROLE) daily to calculate and mint that day's management fee to `mgtFeeTo`.
2. Fee base is `offchainShares` (the real AUM), not circulating HYBOND. Matches how real-world funds charge management fees on AUM rather than on issued shares.
3. Formula: `dailyFee = offchainShares * mgtFeeRate / (365 * BPS_BASE)`, trimmed to `trimDecimals` precision.
4. `updateEpoch` reverts when `mgtFeeRate == 0` (`MgtFeeDisabled`), when a proposal is pending and unconfirmed (`PendingProposalExists`), or when `timeBuffer` hasn't elapsed since the last call (`UpdateTooEarly`).
5. The `PendingProposalExists` guard forces the bot to confirm `offchainShares` before accruing fees — prevents fee mint against stale AUM.

## Combined Daily Workflow

### 1. User Side (T+0)

1.1. User calls `requestDeposit` to deposit USDC.
1.2. User calls `requestRedeem` to redeem Hybond for USDC.

### 2. Fund Operator Side (T+0 EOD)

2.1. Transfer USDC to buy BNY ETF Fund off-chain.
2.2. Call `sharesPerToken` to calculate off-chain shares to sell, then sell.

### 3. Fund Operator Side (T+2)

3.1. Receive share price and share amount from BNY.

### 4. Fund Operator Side (T+2, Daily Batch)

Each step has its own trigger — the ordering below is the required sequence **when a step runs**, not a requirement that every step runs every day.

| Step | Function                       | Role              | When to run                                                                    | Why this order / notes                                                       |
| ---- | ------------------------------ | ----------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 4.1  | `proposePrice`                 | OPERATOR_ROLE     | **Business days only** (BNY publishes price)                                   | Oracle price must be fresh before any mint/redeem arithmetic                 |
| 4.2  | `confirmPrice`                 | CONFIRM_ROLE      | **Business days only** (pairs with 4.1)                                        | Echo-confirm the proposed price                                              |
| 4.3  | `processDepositQueue`          | MAINTAINER_ROLE   | **Only if T+2 deposit requests are ready** (deposits made 2 business days ago) | Mint priced against previous-day's `offchainShares` and fresh oracle price   |
| 4.4  | `proposeOffchainShares`        | OPERATOR_ROLE     | **Only when BNY balance changed** (claimed mgt fee, buys, sells), **T+2**      | Sync new AUM before any fee accrual or new snapshot                          |
| 4.5  | `confirmOffchainShares`        | CONFIRM_ROLE      | **Only when 4.4 was run** (pairs with it)                                      | Echo-confirm; clears `proposedOffchainShares`                                |
| 4.6  | `updateEpoch`                  | OPERATOR_ROLE     | **Daily**                                                                      | Accrue daily fee on `offchainShares`. Reverts if a proposal from 4.4 is unconfirmed |
| 4.7  | `processPendingRedeems`        | OPERATOR_ROLE     | **Only if T+2 redeem requests are ready**                                      | Move delay-ripe entries into the final queue at their snapshot ratio         |
| 4.8  | `processRedeemQueue`           | OPERATOR_ROLE     | **Only if T+4 USDC has arrived** for that batch                                | Burn Hybond and pay USDC (FIFO, liquidity-gated)                             |
| 4.9  | `snapshotPendingRedeemRatio`   | OPERATOR_ROLE     | **Only if there were fresh redeem requests today** (new pending entries)       | Freeze end-of-day ratio for today's fresh pending entries (consumed ~2 days later) |

**Rationale:**

- Steps 4.1–4.2 (oracle price) must precede any step that reads `getPrice()` — `processDepositQueue` (mint pricing) and `processPendingRedeems` (redeem pricing).
- Step 4.3 before 4.4/4.5 so deposits mint at the previous day's `offchainShares`; *then* the bot syncs the new BNY balance that includes today's deposits' purchases.
- Step 4.6 (`updateEpoch`) reverts `PendingProposalExists` unless the `offchainShares` proposal from 4.4 has been confirmed — this hard-gates fee accrual on a fresh AUM value.
- Step 4.7 after 4.6 so today's pending entries snapshot at the post-fee ratio.
- Step 4.9 last because steps 4.7 and 4.8 both mutate `totalRedeemQueueShares`; snapshotting after step 4.8 captures the settled end-of-day state.

After step 4.8, if USDC was paid out to redeemers, the fund operator runs a second `proposeOffchainShares` + `confirmOffchainShares` round to reflect the BNY reduction. This is operational only — no dedicated on-chain step.

**Non-business days:** only step 4.6 (`updateEpoch`) runs, accruing the daily fee against the last known `offchainShares`. All other steps are conditional on market activity (price publication, T+2/T+4 settlement, fresh requests).

### 5. Settlement (T+4)

5.1. Receive USDC from BNY for yesterday's batch.
5.2. Fund operator calls `processRedeemQueue` to settle any remaining redeems that were liquidity-gated on T+2.

## Design Decision: Immediate Minting vs Accumulation

### Why accumulation fails

An earlier design had `updateEpoch` accumulate fees in a counter (`unclaimedMgtFee += dailyFee`) without minting, with a separate `claimMgtFee()` to mint later. This is fundamentally broken: if no tokens are minted for fees, `totalSupply` never changes. The pricing formula sees no dilution, so redeemers get paid at the pre-fee ratio.

The current design mints fee tokens immediately to `mgtFeeTo`. `totalSupply` grows; `offchainShares` stays constant; `sharesPerToken` drops. Redeemers are priced at the correct post-fee ratio.

### Numeric example

**Setup:** `offchainShares = totalSupply = 100,000e18`; 3% annual management fee; 30 days elapsed; BNY balance unchanged.

| | Accumulate (broken) | Mint daily (current) |
|---|---|---|
| `totalSupply` after 30 days | 100,000 (unchanged) | 100,246.6 (fee tokens minted) |
| `mgtFeeTo` balance | 0 | 246.6 |
| `offchainShares` | 100,000 | 100,000 |
| `sharesPerToken` | 100,000 / 100,000 = **1.0** | 100,000 / 100,246.6 = **0.99754** |
| Redeemer with 10,000 tokens receives | 10,000 × 1.0 = 10,000 (overpaid) | 10,000 × 0.99754 = **9,975.4** (correct) |

Daily fee = `offchainShares × 0.03 / 365 ≈ 8.22` tokens/day. Over 30 days ≈ 246.6 tokens minted to `mgtFeeTo`.

### Three specific flaws of the old accumulate-then-claim design

1. **`sharesPerToken` blindness** — The ratio cannot reflect owed-but-unminted fees. It only sees tokens that actually exist. A counter is invisible to the formula.
2. **Insolvency risk** — Redeemers drain more USDC than the off-chain shares backing their tokens. Over time, total USDC payouts exceed what BNY returns, and `processRedeemQueue` reverts on insufficient liquidity.
3. **`previewRedeem` misleads users** — Without the dilution, preview functions show inflated USDC amounts that the system cannot honor.

### Edge case: `mgtFeeTo` transfers

Operational invariant: **`mgtFeeTo` must only move shares to Express via `requestRedeem`**. Direct transfers to other addresses desync `totalMgtFeeUnclaimed` against on-chain fee ownership, since fee-share provenance is keyed on sender identity.

When `mgtFeeTo` calls `requestRedeem`, the contract **overrides** the caller-supplied `_shareAmount` to `totalMgtFeeUnclaimed` (full live balance) to prevent provenance desync. The `redeemMinimum` check is also skipped so small daily fee balances can be claimed.

See the comment block at `Express.sol:80` for the full list of operational invariants.
