# Overview

Hybond is a token issued via `Token.sol`, used to tokenize real-world assets: a BNY ETF Fund.

## Token Mint Workflow (Express.sol:requestDeposit)

1. User calls `requestDeposit` to deposit USDC to the contract at T+0.
2. Fund operator transfers the USDC to buy BNY ETF Fund off-chain at T+0 EOD.
3. At T+2, BNY emails us the share price and share amount of the BNY ETF Fund.
4. Fund operator updates the share price in `PriceOracle.sol` via `proposePrice` and `confirmPrice`.
5. Fund operator calls `processDepositQueue` (MAINTAINER_ROLE) to mint Hybond tokens to users.
6. User receives Hybond tokens in their wallet.

## Token Redeem Workflow (Express.sol:requestRedeem)

1. User calls `requestRedeem` to redeem Hybond for USDC at T+0.
2. Fund operator calls `sharesPerToken` to calculate the off-chain shares to sell.
3. Fund operator sells BNY ETF Fund shares off-chain at T+0 EOD.
4. At T+2, BNY emails us the sell price and USDC amount we will receive.
5. Fund operator updates the price in `PriceOracle.sol` via `proposePrice` and `confirmPrice`.
6. Fund operator calls `processPendingRedeems` (OPERATOR_ROLE) to lock in USDC amounts using the current price and `sharesPerToken` ratio. Requests move from `pendingRedeemQueue` to `redeemQueue`.
7. At T+4, we receive the USDC from BNY.
8. Fund operator calls `processRedeemQueue` (OPERATOR_ROLE) to burn Hybond tokens and transfer USDC to users (FIFO).

## Management Fee

1. Fund operator calls `updateEpoch` (OPERATOR_ROLE) daily to calculate and mint that day's management fee to `mgtFeeTo` based on `circulatingSupply`.
2. `updateEpoch` / `updateEpochAdjust` revert when `mgtFeeRate == 0`.
3. Off-chain BNY shares correspond to `circulatingSupply`, not `totalSupply`.
4. `totalSupply = circulatingSupply + totalRedeemQueueShares + mgtFeeTo balance`.

## Combined Daily Workflow

### 1. User Side (T+0)

1.1. User calls `requestDeposit` to deposit USDC.
1.2. User calls `requestRedeem` to redeem Hybond for USDC.

### 2. Fund Operator Side (T+0 EOD)

2.1. Transfer USDC to buy BNY ETF Fund off-chain.
2.2. Call `sharesPerToken` to calculate off-chain shares to sell, then sell.

### 3. Fund Operator Side (T+2)

3.1. Receive share price from BNY.
3.2. Update price in `PriceOracle.sol` via `proposePrice` and `confirmPrice`.

### 4. Fund Operator Side (T+2, Queue Processing)

Queue processing **must** follow this exact order:


| Step | Function                | Role            | Why this order                                                                         |
| ---- | ----------------------- | --------------- | -------------------------------------------------------------------------------------- |
| 4.1  | `processPendingRedeems` | OPERATOR_ROLE   | Lock in USDC amounts at current ratio **before** new mints change it                   |
| 4.2  | `processDepositQueue`   | MAINTAINER_ROLE | Mint new tokens (increases `totalSupply` and `circulatingSupply`)                      |
| 4.3  | `updateEpoch`           | OPERATOR_ROLE   | Mint daily management fee on the correct `circulatingSupply` (includes new deposits)    |
| 4.4  | `processRedeemQueue`    | OPERATOR_ROLE   | Burn tokens and transfer USDC to redeemers (FIFO, liquidity-dependent)                 |


**Rationale:** `processPendingRedeems` uses `_sharesPerToken()` to convert Hybond tokens to USDC. If `processDepositQueue` runs first, the new mints change the ratio, and redeemers get a different (potentially unfair) USDC amount. Locking in redeem pricing first ensures redeemers are priced on the state that existed when their tokens were queued.

### 5. Settlement (T+4)

5.1. Receive USDC from BNY.
5.2. Fund operator calls `processRedeemQueue` to settle any remaining redeems from earlier batches.

## The Existing Problem (Resolved)

When the management fee rate is non-zero, `circulatingSupply < totalSupply` because `totalSupply` includes `totalRedeemQueueShares` and `mgtFeeTo` balance. The `processPendingRedeems` function uses `_sharesPerToken()` which returns `circulatingSupply / totalSupply` (a ratio < 1.0). This correctly scales down the USDC amount redeemers receive, reflecting that not all tokens are backed 1:1 by off-chain shares. Without this ratio, the USDC amount in the redeem queue would exceed what BNY returns, causing `processRedeemQueue` to revert on insufficient liquidity.

**Status:** Fixed. The `_sharesPerToken` ratio is now applied in `processPendingRedeems` to correctly convert Hybond tokens to USDC based on the circulating supply. Combined with the enforced queue processing order (Section 4), redeemers are priced fairly before new deposits alter the ratio. Critically, the fix required changing from an accumulate-then-claim model to immediate daily minting (see next section for why).

## Design Decision: Immediate Minting vs Accumulation

### Why accumulation fails

An earlier design had `updateEpoch()` accumulate fees in a counter (`unclaimedMgtFee += dailyFee`) without minting, with a separate `claimMgtFee()` to mint later. This is fundamentally broken because `_sharesPerToken()` depends on `totalSupply`:

```
sharesPerToken = circulatingSupply / totalSupply
```

If `updateEpoch()` only increments a counter, no tokens are minted, so `totalSupply` never changes. Since no tokens exist at `mgtFeeTo`, `circulatingSupply == totalSupply`, and `sharesPerToken` returns `1e18` (1.0). Redeemers receive the full USDC value of their tokens as if no management fee exists.

### Numeric example

**Setup:** 100,000 token supply, 3% annual management fee, 30 days elapsed, 1 USDC per token NAV.

| | Accumulate (broken) | Mint daily (correct) |
|---|---|---|
| `totalSupply` after 30 days | 100,000 (unchanged) | 100,246.6 (fee tokens minted) |
| Tokens at `mgtFeeTo` | 0 | 246.6 |
| `circulatingSupply` | 100,000 | 100,000 |
| `sharesPerToken` | 100,000 / 100,000 = **1.0** | 100,000 / 100,246.6 = **0.99754** |
| Redeemer with 10,000 tokens gets | 10,000 × 1.0 = **10,000 USDC** (overpaid) | 10,000 × 0.99754 = **9,975.4 USDC** (correct) |

Daily fee = 100,000 × 0.03 / 365 ≈ 8.22 tokens/day. Over 30 days ≈ 246.6 tokens minted to `mgtFeeTo`.

### Three specific flaws of accumulation

1. **`sharesPerToken` blindness** — The ratio `circulatingSupply / totalSupply` cannot reflect owed-but-unminted fees. It only sees tokens that actually exist. Accumulating in a counter is invisible to the ratio calculation.

2. **Insolvency risk** — Redeemers drain more USDC than the off-chain shares backing their tokens. In the example above, 10,000 tokens should only be worth 9,975.4 USDC after 30 days of fees, but accumulation pays out 10,000 USDC. Over time, total USDC payouts exceed what BNY returns, and `processRedeemQueue` reverts on insufficient liquidity.

3. **`previewRedeem` misleads users** — Since `sharesPerToken` returns 1.0, any preview function shows inflated USDC amounts that the system cannot actually honor once the accumulated fee is finally claimed.

### Edge case: `mgtFeeTo` transfers tokens out

When `mgtFeeTo` transfers (or sells) its fee tokens, those tokens re-enter `circulatingSupply` (they are no longer at the `mgtFeeTo` address). This pushes the `sharesPerToken` ratio back toward 1.0. This is economically correct — the fee has been "realized" and the tokens are now ordinary circulating tokens backed by off-chain shares.

### Deprecation note

The `unclaimedMgtFee` storage slot (Express.sol line 108) is retained for UUPS upgrade storage layout safety but is always 0 in the current implementation. It must not be removed or reordered.
