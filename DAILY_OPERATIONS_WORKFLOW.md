# HYBOND Daily Operations Workflow

This document illustrates the complete workflow for daily deposit and redeem operations in the HYBOND system.

## Overview

The HYBOND system uses a queued approach for both deposits and redemptions with T+2 settlement for redemptions.

---

## Deposit Workflow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        DEPOSIT WORKFLOW (T+2 Process)
└─────────────────────────────────────────────────────────────────────────┘

Day 0 - User Requests Deposit
═══════════════════════════════════════════════════════════════════════════

┌──────────┐
│  User    │
└────┬─────┘
     │ 1. Calls requestDeposit(asset, amount, receiver)
     │    Express forwards net assets to treasury and fee to txFeeTo
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Express Contract                               │
│                                                                          │
│  Validations:                                                            │
│  ✓ KYC check (sender & receiver)                                        │
│  ✓ First deposit amount check (if first time)                           │
│  ✓ Deposit minimum check                                                │
│  ✓ Asset supported check                                                │
│  ✓ Not paused                                                           │
│                                                                          │
│  Actions:                                                                │
│  • Calculate fee (depositFeeRate)                                        │
│  • Convert asset to token equivalent (18 decimals)                       │
│  • Transfer assets: netAmount → treasury, fee → txFeeTo                 │
│  • Encode: (asset, sender, receiver, netAssets, feeAmt, id)             │
│  • Push to depositQueue                                                 │
│  • Update depositInfo[receiver] += netAssets                             │
│                                                                          │
│  Event: AddToDepositQueue(asset, sender, receiver, amount, fee)         │
└─────────────────────────────────────────────────────────────────────────┘
     │
     │ User's assets now in treasury
     │ Request waiting in depositQueue
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         depositQueue (FIFO)                              │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐                        │
│  │Request1│→ │Request2│→ │Request3│→ │Request4│→ ...                    │
│  └────────┘  └────────┘  └────────┘  └────────┘                        │
└─────────────────────────────────────────────────────────────────────────┘


Day 0 - Operator Processes Queue (Next Day after price update)
═══════════════════════════════════════════════════════════════════════════

┌──────────┐
│ OPERATOR │  (MAINTAINER_ROLE)
└────┬─────┘
     │ 2. Calls processDepositQueue(len)
     │    Processes pending deposit requests
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Express.processDepositQueue()                         │
│                                                                          │
│  For each request in queue:                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐
│  │ 1. Pop from front (FIFO)                                             │
│  │ 2. Decode: (asset, sender, receiver, netAssets, feeAmt, id)         │
│  │ 3. Re-validate KYC (status may have changed)                        │
│  │ 4. Convert to token amount using current price                      │
│  │ 5. Call Token.mint(receiver, mintedAmount)                          │
│  │ 6. Update depositInfo[receiver] -= netAssets                        │
│  │ 7. Emit ProcessDeposit event                                        │
│  └──────────────────────────────────────────────────────────────────────┘
│                                                                          │
│  Event: ProcessDeposit(asset, sender, receiver, netAssets, mintedAmount,│
│                        feeAmt, id)                                       │
└─────────────────────────────────────────────────────────────────────────┘
     │
     │ Token.mint() called
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Token Contract                                 │
│  • Mints HYBOND tokens to receiver                                       │
│  • Checks ban list                                                       │
│  • Checks issue cap                                                      │
│  • Emits Mint event                                                      │
└─────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌──────────┐
│  User    │  Receives HYBOND tokens
└──────────┘

═══════════════════════════════════════════════════════════════════════════
                          DEPOSIT COMPLETE
═══════════════════════════════════════════════════════════════════════════
```

### Deposit Cancellation Workflow (Emergency / Ops)

If a queued deposit must be cancelled after `requestDeposit()` has already forwarded funds to `treasury` and `txFeeTo`, operations should use the following sequence:

1. Call `prepareDepositCancellation(_len)` to inspect the next `_len` queued deposit requests (FIFO order).
2. Review the returned arrays:
   - `assets`: unique assets across the next `_len` cancellations
   - `refundAmts`: total refund needed per asset
   - `currentBalances`: current gross balance of each asset held by `Express`
   - `shortfalls`: additional amount that must be returned to `Express` before cancellation
3. Manually transfer each reported `shortfall` from treasury / fee wallets back to `Express`.
4. Call `cancelDeposit(_len)` immediately after funding `Express`.
5. `Express` refunds each queued sender on-chain in FIFO order.

Operational note:
- `prepareDepositCancellation(_len)` is a public view helper; operations typically use it before `cancelDeposit(_len)`.
- `prepareDepositCancellation(_len)` is a snapshot of the current queue head.
- `currentBalances` are gross on-chain balances and may include liquidity already reserved for redeem requests.
- New deposits or other queue actions can change the first `_len` items.
- Best practice is to run `prepareDepositCancellation(_len)`, fund `Express`, and execute `cancelDeposit(_len)` back-to-back.

---

## Redeem Workflow (T+2 Settlement)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      REDEEM WORKFLOW (T+2 Process)                       │
└─────────────────────────────────────────────────────────────────────────┘

Day 0 (T+0) - User Requests Redeem
═══════════════════════════════════════════════════════════════════════════

┌──────────┐
│  User    │
└────┬─────┘
     │ 1. Calls requestRedeem(to, amount)
     │    Transfers HYBOND tokens to Express contract
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Express Contract                               │
│                                                                          │
│  Validations:                                                            │
│  ✓ KYC check (sender & receiver)                                        │
│  ✓ Redeem minimum check                                                 │
│  ✓ Not paused                                                           │
│  ✓ User has sufficient balance                                          │
│                                                                          │
│  Actions:                                                                │
│  • Transfer tokens from sender to Express contract                       │
│  • Create pending redeem ID                                              │
│  • Encode: (sender, receiver, tokenAmount, requestTimestamp, id)        │
│  • Push to pendingRedeemQueue                                            │
│  • Update pendingRedeemInfo[receiver] += tokenAmount                     │
│                                                                          │
│  Event: AddToPendingRedeemQueue(sender, receiver, tokenAmount, id)      │
└─────────────────────────────────────────────────────────────────────────┘
     │
     │ Tokens held in Express contract
     │ Request waiting in pendingRedeemQueue
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   pendingRedeemQueue (FIFO) -> intermediary              │
│  ┌────────────────────────────────────────────────────────┐             │
│  │ Request: (sender, receiver, tokenAmount,               │             │
│  │           requestTimestamp=Day0, id)                   │             │
│  └────────────────────────────────────────────────────────┘             │
│                          Wait T+2 (convertRedeemRequestsDelay)          │
│                          Default: 1 day (86400 seconds)                 │
└─────────────────────────────────────────────────────────────────────────┘


Day 2 (T+2) - Process Pending Redeems with T+2 Price
═══════════════════════════════════════════════════════════════════════════

┌──────────┐
│ OPERATOR │  (OPERATOR_ROLE)
└────┬─────┘
     │ 2. Calls processPendingRedeems(len)
     │    Applies T+2 price and moves to final queue
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 Express.processPendingRedeems()                          │
│                                                                          │
│  Get current price: getPrice()                                           │
│                                                                          │
│  For each pending request:                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐
│  │ 1. Check front item of pendingRedeemQueue                            │
│  │ 2. Verify: block.timestamp >= requestTimestamp +                     │
│  │            convertRedeemRequestsDelay                                │
│  │    (e.g., Day 2 >= Day 0 + 2 days)                                  │
│  │                                                                      │
│  │ 3. If ready:                                                         │
│  │    a. Pop from pendingRedeemQueue                                    │
│  │    b. Decode: (sender, receiver, tokenAmount, requestTimestamp, id) │
│  │    c. Calculate redeemAssetAmt using T+2 price:                     │
│  │       redeemAssetAmt = tokenAmount * currentPrice / 1e18            │
│  │    d. Calculate feeAssetAmt (in redeemAsset, not tokens!)           │
│  │       feeAssetAmt = redeemAssetAmt * redeemFeeRate / BPS_BASE      │
│  │    e. Create new finalId                                            │
│  │    f. Encode: (sender, receiver, tokenAmount, redeemAssetAmt,       │
│  │                feeAssetAmt, requestTimestamp, finalId)               │
│  │    g. Push to redeemQueue                                            │
│  │    h. Update tracking:                                               │
│  │       • pendingRedeemInfo[receiver] -= tokenAmount                   │
│  │       • redeemInfo[receiver] += tokenAmount                          │
│  │                                                                      │
│  │ 4. If not ready: break (maintain FIFO, stop processing)             │
│  │                                                                      │
│  │ Event: ProcessPendingRedeem(sender, receiver, tokenAmount,           │
│  │        redeemAssetAmt, currentPrice, pendingId, finalId)             │
│  └──────────────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────────┘
     │
     │ Now in final queue with calculated amounts
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        redeemQueue (FIFO)                                │
│  ┌────────────────────────────────────────────────────────┐             │
│  │ Request: (sender, receiver, tokenAmount,               │             │
│  │           redeemAssetAmt=calculated with T+2 price,    │             │
│  │           feeAssetAmt, requestTimestamp=Day0, id)      │             │
│  └────────────────────────────────────────────────────────┘             │
└─────────────────────────────────────────────────────────────────────────┘


Day 4 (T+4) - Final Processing & Asset Transfer
═══════════════════════════════════════════════════════════════════════════

┌──────────┐
│ OPERATOR │  (OPERATOR_ROLE)
└────┬─────┘
     │ 3. Calls processRedeemQueue(len)
     │    Burns tokens and transfers assets
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   Express.processRedeemQueue()                           │
│                                                                          │
│  For each redeem request:                                                │
│  ┌──────────────────────────────────────────────────────────────────────┐
│  │ 1. Pop from front (FIFO)                                             │
│  │ 2. Decode: (sender, receiver, tokenAmount, redeemAssetAmt,          │
│  │            feeAssetAmt, requestTimestamp, id)                        │
│  │ 3. Re-validate KYC (status may have changed)                        │
│  │ 4. Check liquidity: availableLiquidity >= redeemAssetAmt            │
│  │    If insufficient: BREAK (stop processing, maintain FIFO)           │
│  │                                                                      │
│  │ 5. Burn tokens: Token.burn(Express, tokenAmount)                    │
│  │ 6. Transfer assets:                                                  │
│  │    • If feeAssetAmt > 0: transfer fee to txFeeTo                    │
│  │    • Transfer netAmount to receiver                                  │
│  │      netAmount = redeemAssetAmt - feeAssetAmt                        │
│  │ 7. Update redeemInfo[receiver] -= tokenAmount                       │
│  │                                                                      │
│  │ Event: ProcessRedeem(sender, receiver, tokenAmount,                  │
│  │                      netAmount, id)                                  │
│  └──────────────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────────┘
     │
     │ Token.burn() called
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Token Contract                                 │
│  • Burns HYBOND tokens from Express contract                             │
│  • Checks ban list                                                       │
│  • Emits Burn event                                                      │
└─────────────────────────────────────────────────────────────────────────┘
     │
     │ Assets transferred
     │
     ▼
┌──────────┐
│  User    │  Receives USDC (minus fee)
└──────────┘

═══════════════════════════════════════════════════════════════════════════
                          REDEEM COMPLETE
═══════════════════════════════════════════════════════════════════════════
```

---

## Error Correction: Revert Wrong T+2 Price

```
┌─────────────────────────────────────────────────────────────────────────┐
│             REVERT REDEEM TO PENDING (Price Correction)                  │
└─────────────────────────────────────────────────────────────────────────┘

Problem: Wrong T+2 price was used in processPendingRedeems()
═══════════════════════════════════════════════════════════════════════════

┌───────────┐
│ OPERATOR  │  (OPERATOR_ROLE)
└─────┬─────┘
      │ 1. Discovers price error
      │ 2. Calls revertRedeemToPending(len)
      │
      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 Express.revertRedeemToPending()                          │
│                                                                          │
│  Process:                                                                │
│  ┌──────────────────────────────────────────────────────────────────────┐
│  │ 1. Pop _len items from redeemQueue (back, LIFO for order)           │
│  │ 2. For each item:                                                    │
│  │    a. Decode: (sender, receiver, tokenAmount, redeemAssetAmt,       │
│  │               feeAssetAmt, requestTimestamp, oldId)                  │
│  │    b. Discard: redeemAssetAmt, feeAssetAmt (wrong price)            │
│  │    c. Keep: requestTimestamp (original Day 0 timestamp)             │
│  │    d. Push to FRONT of pendingRedeemQueue                            │
│  │    e. Update: redeemInfo[receiver] -= tokenAmount                   │
│  │                                                                      │
│  │ 3. By popping from back and pushing to front, maintains FIFO order! │
│  │                                                                      │
│  │ 4. Update: pendingRedeemInfo[receiver] += tokenAmount               │
│  │                                                                      │
│  │ Event: RevertRedeemToPending(sender, receiver, tokenAmount,          │
│  │                              oldId, newPendingId)                    │
│  └──────────────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   pendingRedeemQueue (FIFO)                              │
│  ┌────────────────────────────────────────────────────────┐             │
│  │ Reverted items (with ORIGINAL timestamp from Day 0!)  │             │
│  │ pushed to FRONT                                        │             │
│  └────────────────────────────────────────────────────────┘             │
│          │                                                               │
│  ┌────────────────────────────────────────────────────────┐             │
│  │ Existing pending items                                 │             │
│  └────────────────────────────────────────────────────────┘             │
└─────────────────────────────────────────────────────────────────────────┘
      │
      │ Wait for T+2 delay from original timestamp
      │ (e.g., if originally requested Day 0, still eligible Day 2)
      │
      ▼
┌───────────┐
│ OPERATOR  │ Calls processPendingRedeems() again with correct price
└───────────┘

═══════════════════════════════════════════════════════════════════════════
                     Items repriced and moved to redeemQueue
═══════════════════════════════════════════════════════════════════════════
```

---

## Daily Management Fee Accrual

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      DAILY MANAGEMENT FEE WORKFLOW                       │
└─────────────────────────────────────────────────────────────────────────┘

Every 24 Hours (After timeBuffer Period)
═══════════════════════════════════════════════════════════════════════════

┌──────────┐
│ OPERATOR │  (OPERATOR_ROLE)
└────┬─────┘
     │ Calls updateEpoch()
     │ (Can only be called after timeBuffer has passed, e.g., 20 hours)
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Express.updateEpoch()                             │
│                                                                          │
│  Validations:                                                            │
│  • block.timestamp >= lastUpdateTS + timeBuffer                          │
│                                                                          │
│  Actions:                                                                │
│  1. Calculate circulating supply:                                        │
│     circulatingSupply = token.totalSupply() - token.balanceOf(Express)  │
│                                                                          │
│  2. Calculate daily management fee:                                      │
│     dailyFee = (circulatingSupply * mgtFeeRate) / (365 * BPS_BASE)     │
│     Example: 3% per year = 300 bps                                       │
│              Daily = (supply * 300) / (365 * 10000)                      │
│                    = supply * 0.00008219 per day                         │
│                                                                          │
│  3. Accrue fee:                                                          │
│     unclaimedMgtFee += dailyFee                                          │
│                                                                          │
│  4. Update state:                                                        │
│     epoch++                                                              │
│     lastUpdateTS = block.timestamp                                       │
│                                                                          │
│  Event: UpdateEpoch(unclaimedMgtFee, epoch)                              │
└─────────────────────────────────────────────────────────────────────────┘
     │
     ▼
Fees accumulate in unclaimedMgtFee


Monthly (or When Ready) - Claim Accumulated Fees
═══════════════════════════════════════════════════════════════════════════

┌────────────┐
│  OPERATOR  │  (OPERATOR_ROLE)
└─────┬──────┘
      │ Calls claimMgtFee()
      │
      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Express.claimMgtFee()                              │
│                                                                          │
│  Actions:                                                                │
│  1. amount = unclaimedMgtFee                                             │
│  2. unclaimedMgtFee = 0 (reset)                                          │
│  3. Mint tokens: Token.mint(mgtFeeTo, amount)                           │
│                                                                          │
│  Event: ClaimMgtFee(mgtFeeTo, amount)                                    │
└─────────────────────────────────────────────────────────────────────────┘
      │
      ▼
Management fee recipient receives minted HYBOND tokens

═══════════════════════════════════════════════════════════════════════════
```

---

## Queue State Diagrams

### Deposit Queue States

```
┌──────────────┐
│ User Request │
└──────┬───────┘
       │
       ▼
┌─────────────────────────────────────────┐
│         depositQueue                    │
│  State: Pending (waiting for operator)  │
│  Data: (asset, sender, receiver,        │
│         netAssets, feeAmt, id)          │
│  Assets: In treasury                    │
│  Tokens: Not minted yet                 │
└──────┬──────────────────────────────────┘
       │ processDepositQueue()
       │ by MAINTAINER
       ▼
┌─────────────────────────────────────────┐
│         Processed                       │
│  State: Complete                        │
│  Assets: In treasury                    │
│  Tokens: Minted to receiver             │
└─────────────────────────────────────────┘
```

### Redeem Queue States (T+2)

```
┌──────────────┐
│ User Request │
└──────┬───────┘
       │
       ▼
┌─────────────────────────────────────────┐
│     pendingRedeemQueue (T+0)            │
│  State: Pending T+2 delay               │
│  Data: (sender, receiver, tokenAmount,  │
│         requestTimestamp, id)           │
│  Tokens: Held in Express contract       │
│  Assets: Not calculated yet             │
│  Wait: convertRedeemRequestsDelay       │
└──────┬──────────────────────────────────┘
       │ After T+2 delay
       │ processPendingRedeems()
       │ by OPERATOR
       ▼
┌─────────────────────────────────────────┐
│        redeemQueue (T+2)                │
│  State: Ready for final processing      │
│  Data: (sender, receiver, tokenAmount,  │
│         redeemAssetAmt, feeAssetAmt,    │
│         requestTimestamp, id)           │
│  Tokens: Still held in Express          │
│  Assets: Calculated with T+2 price      │
└──────┬──────────────────────────────────┘
       │ processRedeemQueue()
       │ by OPERATOR
       ▼
┌─────────────────────────────────────────┐
│         Processed                       │
│  State: Complete                        │
│  Tokens: Burned                         │
│  Assets: Transferred to receiver        │
└─────────────────────────────────────────┘

       ┌─────────────────────────┐
       │ IF WRONG PRICE USED:    │
       │ revertRedeemToPending() │
       │ by OPERATOR             │
       └────────┬────────────────┘
                │
                ▼
       ┌─────────────────────────────────────────┐
       │  Back to pendingRedeemQueue             │
       │  (With ORIGINAL timestamp preserved!)   │
       └─────────────────────────────────────────┘
```

---

## Role Permissions Summary

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ROLE PERMISSIONS                               │
└─────────────────────────────────────────────────────────────────────────┘

DEFAULT_ADMIN_ROLE
├─ Grant/revoke all roles
├─ Update contract addresses
└─ Critical configuration

OPERATOR_ROLE
├─ processPendingRedeems()           ← Apply T+2 price
├─ processRedeemQueue()              ← Final redeem processing
├─ updateEpoch()                     ← Accrue daily management fees
├─ claimMgtFee()                     ← Claim accumulated fees
├─ revertRedeemToPending()           ← Fix wrong price
└─ offRamp()                         ← Emergency asset transfer

MAINTAINER_ROLE
├─ processDepositQueue()             ← Process deposit requests
├─ updateDepositMinimum()
├─ updateRedeemMinimum()
├─ updateFirstDepositAmount()
├─ updateDepositFeeRate()
├─ updateRedeemFeeRate()
├─ updateMgtFeeRate()
├─ updateTrimDecimals()
├─ updateAssetRegistry()
├─ updatePriceOracle()
├─ updateMaxStalePeriod()
├─ updateConvertRedeemRequestsDelay()
├─ updateTimeBuffer()
├─ updateTreasury()
├─ updateTxFeeTo()
├─ updateMgtFeeTo()
├─ updateFirstDeposit()
├─ cancelDeposit()                   ← Emergency cancel
├─ cancelPendingRedeem()             ← Emergency cancel
└─ cancelRedeem()                    ← Emergency cancel

WHITELIST_ROLE
├─ grantKyc()
├─ grantKycInBulk()
├─ revokeKyc()
└─ revokeKycInBulk()

PAUSE_ROLE
├─ pauseDeposit()
├─ unpauseDeposit()
├─ pauseRedeem()
└─ unpauseRedeem()

UPGRADE_ROLE
└─ upgradeTo()                       ← Upgrade contract implementation
```

---

## Typical Daily Operations Schedule

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      TYPICAL DAILY SCHEDULE                              │
└─────────────────────────────────────────────────────────────────────────┘

TIME          ACTION                              ROLE
════════════════════════════════════════════════════════════════════════════

Continuous    Users submit requestDeposit()       Users
              Users submit requestRedeem()        Users
              Requests queue up automatically

────────────────────────────────────────────────────────────────────────────

9:00 AM       Process deposit queue               MAINTAINER
              processDepositQueue(0)
                 • Process all pending deposits
                 • Users receive HYBOND tokens

────────────────────────────────────────────────────────────────────────────

10:00 AM      Accrue daily management fees        OPERATOR
              updateEpoch()
                 • Calculate daily fee (3% APY)
                 • Add to unclaimedMgtFee
                 • Increment epoch counter

────────────────────────────────────────────────────────────────────────────

11:00 AM      Process pending redeems (T+2)       OPERATOR
              processPendingRedeems(0)
                 • Check T+2 delay elapsed
                 • Apply current T+2 price
                 • Move to final redeem queue
                 • Calculate redeemAssetAmt & fees

────────────────────────────────────────────────────────────────────────────

11:30 AM      Process final redeems               OPERATOR
              processRedeemQueue(0)
                 • Check liquidity
                 • Burn tokens
                 • Transfer USDC to users

────────────────────────────────────────────────────────────────────────────

3:00 PM       Second batch processing             OPERATOR/MAINTAINER
              Repeat above steps for new requests
                 accumulated during the day

────────────────────────────────────────────────────────────────────────────

Monthly       Claim accumulated management fees   OPERATOR
(e.g., 1st)   claimMgtFee()
                 • Mint accumulated fees
                 • Transfer to mgtFeeTo address

────────────────────────────────────────────────────────────────────────────

As Needed     Emergency operations                OPERATOR/MAINTAINER
              ├─ pauseDeposit() / pauseRedeem()
              ├─ prepareDepositCancellation(_len)  ← Public view helper
              │  • Review refundAmts / shortfalls by asset
              │  • Treat currentBalances as gross balances only
              │  • Return required assets to Express
              ├─ cancelDeposit(_len)
              │  • Refund queued deposit senders on-chain
              ├─ cancelPendingRedeem()
              ├─ cancelRedeem()
              └─ revertRedeemToPending()           Fix wrong price
```

---

## Key Features & Safeguards

### 1. **FIFO Queue Processing**
- All queues maintain strict first-in-first-out order
- Ensures fairness: earliest requests processed first

### 2. **KYC Enforcement**
- Checked at request time
- **Re-checked at processing time** (status may change)
- Both sender and receiver must be KYC'd

### 3. **Liquidity-Aware Processing**
- Redeem processing breaks if insufficient assets
- Protects against over-redemption
- Maintains system solvency

### 4. **Price Correction Mechanism**
- `revertRedeemToPending()` allows fixing price errors
- Preserves original timestamps (fairness)
- Maintains FIFO order via `popBack()` and `pushFront()`

### 5. **Fee Structure**
- Deposit fee: Charged in underlying asset (USDC)
- Redeem fee: Charged in redeemAsset (not tokens!)
- Management fee: Accrued daily via `updateEpoch()`, claimed via `claimMgtFee()`

### 6. **T+2 Settlement for Redemptions**
- Configurable delay: `convertRedeemRequestsDelay`
- Allows for price stabilization
- Can be adjusted for holidays via MAINTAINER

### 7. **Pause Controls**
- Separate pause for deposits and redeems
- Emergency stop capability
- Granular control per operation type

---

## Important Notes

### Timestamp Preservation
When reverting redemptions with `revertRedeemToPending()`:
- Uses **original timestamp** from when user first requested
- Users don't lose their place in queue
- Fair treatment during price corrections

### Queue Ordering
- Items always processed FIFO within each queue
- Reversion uses `popBack()` + `pushFront()` to maintain FIFO
- Critical for fairness and predictability

### Fee Timing
- **Deposit**: Fee charged upfront (in asset)
- **Redeem**: Fee calculated at T+2 (in redeemAsset)
- **Management**: Accrued daily, claimed periodically (in tokens)

### Liquidity Management
- Treasury receives assets from deposits
- Treasury provides assets for redemptions
- System breaks processing if insufficient liquidity
- Admin must ensure adequate reserves

---

*Generated for HYBOND Smart Contract System*
*Version 1.0.0*
