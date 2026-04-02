# Sequencing Note: `processPendingRedeems` vs `processDepositQueue`

## Summary

Under the current design, fund operator sequencing does matter.
If `processDepositQueue` runs before `processPendingRedeems`, the redeem ratio used on-chain can differ from the ratio the operator actually sold against off-chain.

So the statement "process pending redeem first, then process deposit" is directionally correct for the current implementation, but it is still an operational workaround, not a fully robust accounting design.

## Why Sequencing Matters

`processPendingRedeems` uses the live `sharesPerToken()` at execution time.
`processDepositQueue` mints new circulating tokens.

If deposits are processed first, the ratio used for redeems can increase.

Let:

- `C` = current circulating backing
- `T` = current total supply
- `D` = newly deposited and minted amount

Current ratio before deposit:

`C / T`

Ratio after processing deposits first:

`(C + D) / (T + D)`

If `C < T` because of claimed management fees, then:

`(C + D) / (T + D) > C / T`

That means processing deposits first gives redeemers a better ratio than the earlier off-chain sale may have justified.

## When "Redeem First, Deposit Second" Is Correct

This ordering is correct only if the following business rule is true:

- the redeem batch was sold off-chain first
- deposits in the later mint batch should not improve the backing ratio for that redeem batch
- on-chain settlement is intended to reflect that exact sale batch

If that is the intended operating model, then:

- `processPendingRedeems` should be executed first for the redeem batch
- `processDepositQueue` should be executed afterward for deposits belonging to the next batch

## Challenge To The Assumption

The deeper issue is not only call order.
The real question is batch membership.

What must be defined clearly:

- which redeems belong to which cutoff batch
- which deposits belong to which cutoff batch
- whether those deposits should affect the redeem ratio for that batch

If those rules are defined only off-chain, then on-chain payout logic becomes order-dependent.
That is fragile because one wrong operator sequence changes user payouts.

## Design Critique

Relying on call order means the contract is inferring batch economics from mutable state.
That is a design smell.

The current model is acceptable only if the team is willing to enforce strict operator sequencing and document it as a hard operational requirement.

Otherwise, a stronger design would avoid inferring the redeem batch ratio from live state alone.

## Safer Long-Term Options

### Option 1: Strict Operational Rule

Document and enforce off-chain operations so that:

- redeem batches are always processed before deposits that should not affect that batch
- operators understand that the order is economically significant

This is the minimum-change path, but it remains operationally fragile.

### Option 2: Explicit Batch Accounting

Instead of deriving redemption pricing from live on-chain state, use an explicit batch-level economic input.

Examples:

- pass a batch ratio into processing
- pass a batch backing amount into processing
- otherwise bind redeems to a specific accounting batch rather than whatever state exists at call time

This is more robust because payout logic depends on defined batch economics, not execution order.

## Bottom Line

Yes, with the current implementation you are broadly right:

- if the operator sold the redeem batch before the deposit batch should count
- then `processPendingRedeems` should happen before `processDepositQueue`

But that should be treated as an operational constraint, not as a complete solution.
If correct payouts depend on sequencing alone, the design is still under-specified.
