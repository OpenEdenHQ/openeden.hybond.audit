# Offchain Shares Redesign — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cumulative-fee-based `sharesPerToken` formula with an offchain-BNY-share-anchored formula driven by a two-step propose/confirm pipeline. Contract: `contracts/extension/Express.sol`.

**Architecture:** Staged refactor. Additive changes first (new roles, state, events, functions). Formula swap second. Guards third. Dead-code removal fourth. Tests and deploy polish last. Each task leaves the build green.

**Tech Stack:** Solidity 0.8.22, Hardhat, hardhat-deploy, TypeScript tests, UUPS upgradeable (OpenZeppelin), ethers-v6 typechain.

**Spec:** `docs/superpowers/specs/2026-04-19-offchain-shares-design.md` — read this first. Decisions made during brainstorming are locked in that document.

---

## Ground rules

- **TDD.** Write the test, watch it fail, write code, watch it pass, commit.
- **Naming.** The project uses `deposit` / `redeem` terminology (not `mint` / `withdraw`) — see `CLAUDE.md`.
- **No hidden scope.** If you notice something outside the spec that wants fixing, flag it and keep moving.
- **File limit.** Express.sol is already ~1800 lines. Do not add helper files unless a task tells you to.
- **Commit style.** `feat:` / `fix:` / `refactor:` / `test:` — see `~/.claude/rules/common/git-workflow.md`.
- **Global CLAUDE.md rule:** do not commit unless explicitly requested. Each task ends with a `git commit` step; that step IS the explicit request for this plan.
- **Build command:** `npm run compile`. Expected to pass after every task.
- **Test command:** `npx hardhat test <path>` or `npm test` for the full suite.

## File map

**Modified:**
- `contracts/extension/Express.sol` — all contract changes
- `test/unit/Express.comprehensive.test.ts` — swap dead assertions
- `test/unit/Express.sharePerToken.test.ts` — rewrite/update for new formula
- `test/unit/Express.mgtFeeAccounting.test.ts` — remove `totalMgtFeeMinted` references
- `deploy/04_deploy_express.ts` — grant `CONFIRM_ROLE` at deploy

**Created:**
- `test/unit/Express.OffchainShares.test.ts` — new test file for propose/confirm
- `test/integration/DailyRoutine.test.ts` — new end-to-end routine scenario

**Unchanged:**
- `contracts/core/Token.sol`, `contracts/extension/AssetRegistry.sol`, `contracts/extension/PriceOracle.sol`, all other contract files

---

## Task 1: Scaffold new state, roles, errors, events

**Intent:** Additive skeleton. No behavior change. Build and existing tests still pass.

**Files:**
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Add `CONFIRM_ROLE` constant**

In `contracts/extension/Express.sol`, ROLES block (after line ~50), append:

```solidity
bytes32 public constant CONFIRM_ROLE = keccak256("CONFIRM_ROLE");
```

- [ ] **Step 2: Add new state variables**

Near `totalMgtFeeUnclaimed` (around line 177), append:

```solidity
// Active offchain BNY share value in 18-decimal convention.
// Set by proposeOffchainShares + confirmOffchainShares (two-step, two-role).
uint256 public offchainShares;

// Pending proposed value awaiting confirmation. Zero means no pending proposal.
uint256 public proposedOffchainShares;
```

Adjust `uint256[37] private __gap;` at the bottom of the file to `uint256[35] private __gap;` to account for the two new slots.

- [ ] **Step 3: Add new errors**

In the ERRORS block (near line 317), append:

```solidity
error OffchainSharesNotSet();
error PendingProposalExists(uint256 pendingValue);
```

- [ ] **Step 4: Add new events**

In the EVENTS block (near line 290, before `SnapshotPendingRedeemRatio`), append:

```solidity
event ProposeOffchainShares(address indexed proposer, uint256 supply);
event ConfirmOffchainShares(address indexed confirmer, uint256 newSupply, uint256 previousSupply);
```

- [ ] **Step 5: Compile**

Run: `npm run compile`
Expected: clean compile. New state vars are unused for now — allowed.

- [ ] **Step 6: Run existing tests to ensure nothing broke**

Run: `npm test 2>&1 | tail -40`
Expected: all existing tests pass. No behavior changed.

- [ ] **Step 7: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "feat: scaffold offchain-shares state, role, events, errors"
```

---

## Task 2: TDD `proposeOffchainShares`

**Files:**
- Create: `test/unit/Express.OffchainShares.test.ts`
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Create test file with fixture and first failing tests**

Create `test/unit/Express.OffchainShares.test.ts`. Follow the style of existing test files (e.g., `Express.mgtFeeAccounting.test.ts`) for fixtures and imports. Write:

- Test: non-`OPERATOR_ROLE` caller reverts with `AccessControl` role error
- Test: propose with `_supply == 0` reverts `InvalidAmount`
- Test: valid propose sets `proposedOffchainShares` and emits `ProposeOffchainShares`
- Test: propose overwrites prior pending value (latest-wins)

Use `loadFixture` per the project pattern. Grant `OPERATOR_ROLE` in the fixture.

- [ ] **Step 2: Run tests — expect all four to fail**

Run: `npx hardhat test test/unit/Express.OffchainShares.test.ts`
Expected: FAIL — function does not exist.

- [ ] **Step 3: Implement `proposeOffchainShares`**

Add to `Express.sol` in the appropriate management section (near epoch management, around line 1465). Include a clear section header comment.

```solidity
/*//////////////////////////////////////////////////////////////
                    OFFCHAIN SHARES MANAGEMENT
//////////////////////////////////////////////////////////////*/

/**
 * @notice Propose a new offchain BNY share value
 * @dev Latest-wins: overwrites any prior unconfirmed proposal
 * @param _supply Proposed value (18-decimal convention, must match HYBOND totalSupply scale)
 */
function proposeOffchainShares(uint256 _supply) external onlyRole(OPERATOR_ROLE) {
    if (_supply == 0) revert InvalidAmount();
    proposedOffchainShares = _supply;
    emit ProposeOffchainShares(_msgSender(), _supply);
}
```

- [ ] **Step 4: Run tests — all four pass**

Run: `npx hardhat test test/unit/Express.OffchainShares.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/unit/Express.OffchainShares.test.ts contracts/extension/Express.sol
git commit -m "feat: add proposeOffchainShares with OPERATOR role"
```

---

## Task 3: TDD `confirmOffchainShares`

**Files:**
- Modify: `test/unit/Express.OffchainShares.test.ts`
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Add failing tests**

Extend `Express.OffchainShares.test.ts` with:

- Test: non-`CONFIRM_ROLE` caller reverts with `AccessControl` role error
- Test: confirm with `proposedOffchainShares == 0` reverts `InvalidAmount`
- Test: confirm with mismatched `_supply` reverts `InvalidInput(_supply)`
- Test: matching confirm sets `offchainShares`, clears `proposedOffchainShares`, emits `ConfirmOffchainShares` with `(confirmer, newSupply, previousSupply)`
- Test: after confirm, a second matching confirm reverts (pending is cleared)
- Test: re-propose + confirm sequence (recovery path) — end-to-end scenario ends with correct `offchainShares` and empty pending

Grant `CONFIRM_ROLE` in the fixture (to a distinct signer from the operator).

- [ ] **Step 2: Run tests — expect new tests to fail**

Run: `npx hardhat test test/unit/Express.OffchainShares.test.ts`
Expected: FAIL on new tests.

- [ ] **Step 3: Implement `confirmOffchainShares`**

Add to `Express.sol` in the OFFCHAIN SHARES MANAGEMENT section, directly after `proposeOffchainShares`:

```solidity
/**
 * @notice Confirm the pending proposed offchain share value
 * @dev Caller must echo the exact pending value (protects against silent tampering)
 * @param _supply Must equal proposedOffchainShares; anything else reverts
 */
function confirmOffchainShares(uint256 _supply) external onlyRole(CONFIRM_ROLE) {
    uint256 pending = proposedOffchainShares;
    if (pending == 0) revert InvalidAmount();
    if (_supply != pending) revert InvalidInput(_supply);

    uint256 previous = offchainShares;
    offchainShares = pending;
    proposedOffchainShares = 0;
    emit ConfirmOffchainShares(_msgSender(), pending, previous);
}
```

- [ ] **Step 4: Run tests — all pass**

Run: `npx hardhat test test/unit/Express.OffchainShares.test.ts`
Expected: PASS on all tests so far.

- [ ] **Step 5: Commit**

```bash
git add test/unit/Express.OffchainShares.test.ts contracts/extension/Express.sol
git commit -m "feat: add confirmOffchainShares with echo-value check"
```

---

## Task 4: Swap `_sharesPerToken` to the new formula

**Intent:** Replace the cumulative-fee-based formula. `totalMgtFeeMinted` still exists in storage (removed in Task 9) but is no longer read.

**Files:**
- Modify: `contracts/extension/Express.sol`
- Modify: `test/unit/Express.sharePerToken.test.ts`

- [ ] **Step 1: Read existing `Express.sharePerToken.test.ts`**

Open the file. Note the tests expecting the old formula — they will fail after the swap. The whole test file will be rewritten to match the new formula.

- [ ] **Step 2: Rewrite tests for new formula**

Replace the test file body with tests for:

- `sharesPerToken()` returns `1e18` when `totalSupply - totalRedeemQueueShares == 0` (bootstrap / full exit)
- `sharesPerToken()` returns `0` when `offchainShares == 0` and denom `> 0` (natural consequence of `mulDiv(0, 1e18, denom)`; **do not add a dedicated branch in the implementation**)
- `sharesPerToken()` computes `mulDiv(offchainShares, 1e18, denom)` otherwise — verify with at least three scenarios: ratio = 1, ratio < 1 (fee dilution), ratio > 1 (BNY grew faster than supply)
- Ratio drops after `updateEpoch` fee mint (holding `offchainShares` constant) — confirms fee accrual works through the new formula
- Ratio rises after `processPendingRedeems` moves entry pending → final (denom shrinks) — confirms queue movement works
- Ratio unchanged by `processRedeemQueue` burn (both `totalSupply` and `totalRedeemQueueShares` drop by the same amount)

Reuse fixture patterns from the existing file. Where fixtures do not already seed `offchainShares`, add propose+confirm calls in the fixture setup.

- [ ] **Step 3: Run tests — expect failure**

Run: `npx hardhat test test/unit/Express.sharePerToken.test.ts`
Expected: FAIL — existing implementation uses the old formula.

- [ ] **Step 4: Rewrite `_sharesPerToken`**

In `Express.sol`, replace the body of `_sharesPerToken` (around line 1648) with:

```solidity
/**
 * @notice Calculate the current shares-per-token ratio in 1e18 precision
 * @dev Formula: offchainShares / (totalSupply - totalRedeemQueueShares), scaled by 1e18.
 *      Denominator excludes the final redeem queue (those shares are already priced).
 *      Pending-redeem-queue shares are included in the denominator.
 *
 *      Fallback 1e18 when denom is zero (bootstrap: no tokens exist yet, or full exit).
 *      Returns 0 when offchainShares is zero — a natural consequence of mulDiv(0, ...).
 */
function _sharesPerToken() internal view returns (uint256 ratio) {
    uint256 totalSupply = IERC20(address(token)).totalSupply();
    uint256 denom = totalSupply - totalRedeemQueueShares;
    if (denom == 0) return 1e18;
    ratio = Math.mulDiv(offchainShares, 1e18, denom);
}
```

Also update the doc-comment block above it to remove references to `totalMgtFeeMinted`, drained state, and the old formula.

- [ ] **Step 5: Run the updated test file**

Run: `npx hardhat test test/unit/Express.sharePerToken.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite — expect some other tests to fail**

Run: `npm test 2>&1 | tail -80`
Expected: `Express.comprehensive.test.ts` and `Express.mgtFeeAccounting.test.ts` likely have assertions on old-formula ratio values. Note the failures — they will be fixed in Task 10.

- [ ] **Step 7: Commit**

```bash
git add test/unit/Express.sharePerToken.test.ts contracts/extension/Express.sol
git commit -m "refactor: swap sharesPerToken to offchainShares/denom formula"
```

---

## Task 5: Add `OffchainSharesNotSet` guard on deposit path

**Files:**
- Modify: `test/unit/Express.OffchainShares.test.ts`
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Add failing tests for deposit guard**

Extend `Express.OffchainShares.test.ts` (or create a `Deposit` describe block):

- Test: `requestDeposit` reverts `OffchainSharesNotSet` when `offchainShares == 0` and `totalSupply > 0`
- Test: `requestDeposit` succeeds when `offchainShares == 0` and `totalSupply == 0` (bootstrap — first depositor)
- Test: after the bootstrap first deposit, a second deposit without propose+confirm reverts `OffchainSharesNotSet`
- Test: `previewDeposit` returns `netMintAmt = 0` (not revert) when `offchainShares == 0 && totalSupply > 0`
- Test: `_calculateMintAmount` path reverts via `requestDeposit` under the same condition

- [ ] **Step 2: Run — expect failure (no guard yet)**

Run: `npx hardhat test test/unit/Express.OffchainShares.test.ts`

- [ ] **Step 3: Update `requestDeposit` guard**

In `Express.sol` around line 557, **replace**:

```solidity
if (circulatingSupply() == 0 && totalMgtFeeMinted > 0) revert DrainedInstance();
```

with:

```solidity
if (offchainShares == 0 && IERC20(address(token)).totalSupply() > 0) {
    revert OffchainSharesNotSet();
}
```

- [ ] **Step 4: Update `_calculateMintAmount` guard and its preceding comment atomically**

Around lines 626-630 in the current file, there is a drained-state MEV comment block followed by the old guard. Replace the entire block — both the comment and the guard — in a single edit so no dead reasoning is left behind. The replacement:

```solidity
// Block mint if the offchain BNY value has not been confirmed by the bot yet.
// Allows the bootstrap path (totalSupply == 0) where the first depositor mints at 1:1.
if (offchainShares == 0 && IERC20(address(token)).totalSupply() > 0) {
    revert OffchainSharesNotSet();
}
```

- [ ] **Step 5: Update `previewDeposit` soft-preview branch**

Around line 612, **replace**:

```solidity
if (circulatingSupply() == 0 && totalMgtFeeMinted > 0) {
    netMintAmt = 0;
} else {
    netMintAmt = _calculateMintAmount(_asset, netAmt);
}
```

with:

```solidity
if (offchainShares == 0 && IERC20(address(token)).totalSupply() > 0) {
    netMintAmt = 0;
} else {
    netMintAmt = _calculateMintAmount(_asset, netAmt);
}
```

- [ ] **Step 6: Run tests**

Run: `npx hardhat test test/unit/Express.OffchainShares.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add test/unit/Express.OffchainShares.test.ts contracts/extension/Express.sol
git commit -m "feat: add OffchainSharesNotSet guard on deposit path"
```

---

## Task 6: Add `OffchainSharesNotSet` guard on `requestRedeem`

**Files:**
- Modify: `test/unit/Express.OffchainShares.test.ts`
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Add failing test**

Extend the test file:

- Test: `requestRedeem` reverts `OffchainSharesNotSet` when `offchainShares == 0`, regardless of whether the user holds tokens
- Test: `requestRedeem` succeeds when `offchainShares > 0`

- [ ] **Step 2: Run — expect failure**

Run: `npx hardhat test test/unit/Express.OffchainShares.test.ts`

- [ ] **Step 3: Add guard in `requestRedeem`**

Around line 798 (after `_validateKyc`), insert:

```solidity
if (offchainShares == 0) revert OffchainSharesNotSet();
```

- [ ] **Step 4: Run tests**

Run: `npx hardhat test test/unit/Express.OffchainShares.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/unit/Express.OffchainShares.test.ts contracts/extension/Express.sol
git commit -m "feat: add OffchainSharesNotSet guard on requestRedeem"
```

---

## Task 7: Add `PendingProposalExists` guard on `updateEpoch`

**Files:**
- Modify: `test/unit/Express.OffchainShares.test.ts`
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Add failing tests**

Extend the test file:

- Test: `updateEpoch` reverts `PendingProposalExists(pendingValue)` when `proposedOffchainShares != 0`
- Test: after confirming the pending value, `updateEpoch` succeeds
- Test: re-propose + confirm recovery — operator proposes wrong value, re-proposes correct value, confirmer echoes, then `updateEpoch` succeeds

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Add guard in `_updateEpochInternal`**

In `Express.sol` around line 1490 (at the top of `_updateEpochInternal`, after `mgtFeeRate == 0` check), insert:

```solidity
if (proposedOffchainShares != 0) revert PendingProposalExists(proposedOffchainShares);
```

Note: Task 8 later rewrites the entire body of `_updateEpochInternal` and includes this guard in the new body. The two tasks are consistent — Task 7 adds the guard (and tests it in isolation); Task 8 preserves it through a larger function rewrite.

- [ ] **Step 4: Run tests**

Run: `npx hardhat test test/unit/Express.OffchainShares.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/unit/Express.OffchainShares.test.ts contracts/extension/Express.sol
git commit -m "feat: guard updateEpoch against unconfirmed offchain-shares proposal"
```

---

## Task 8: Remove `updateEpochAdjust` and simplify `_updateEpochInternal`

**Files:**
- Modify: `contracts/extension/Express.sol`
- Modify: `test/unit/Express.comprehensive.test.ts` (if it asserts on `updateEpochAdjust`)

- [ ] **Step 1: Search for existing references**

Run: `npx grep -n "updateEpochAdjust" contracts test deploy`
Note all call sites. Expected hits: the function itself, its external wrapper, possibly comprehensive tests.

- [ ] **Step 2: Update any failing tests to remove `updateEpochAdjust` expectations**

In `test/unit/Express.comprehensive.test.ts`, delete any `describe`/`it` blocks exercising `updateEpochAdjust`. Do not leave stub tests.

- [ ] **Step 3: Delete `updateEpochAdjust` external function**

In `Express.sol`, around lines 1474-1481, delete the entire `updateEpochAdjust` function and its doc comment.

- [ ] **Step 4: Simplify `_updateEpochInternal` signature**

Replace the function signature + body. Current (around line 1489):

```solidity
function _updateEpochInternal(uint256 _circulatingSupply, bool _useOverride) internal {
    // ...
    uint256 circulating;
    if (_useOverride) {
        uint256 totalSupply = IERC20(address(token)).totalSupply();
        if (_circulatingSupply > totalSupply) revert InvalidInput(_circulatingSupply);
        circulating = _circulatingSupply;
    } else {
        circulating = circulatingSupply();
    }
    // ...
}
```

New:

```solidity
function _updateEpochInternal() internal {
    if (mgtFeeRate == 0) revert MgtFeeDisabled();
    if (proposedOffchainShares != 0) revert PendingProposalExists(proposedOffchainShares);
    if (lastUpdateTS != 0 && block.timestamp < lastUpdateTS + timeBuffer) {
        revert UpdateTooEarly(block.timestamp);
    }

    epoch++;

    uint256 circulating = circulatingSupply();
    uint256 dailyFee = _trim(_calculateDailyMgtFee(circulating));
    if (dailyFee > 0) {
        if (mgtFeeTo == address(0)) revert InvalidAddress();
        totalMgtFeeUnclaimed += dailyFee;
        token.mint(mgtFeeTo, dailyFee);
    }

    lastUpdateTS = block.timestamp;
    emit UpdateEpoch(dailyFee, epoch, circulating);
}
```

Note: `totalMgtFeeMinted += dailyFee` is gone; the `UpdateEpoch` event drops the `totalMgtFeeMinted` field (event signature change handled in Task 9). If your editor flags `UpdateEpoch` arity mismatch, proceed — Task 9 fixes the event.

- [ ] **Step 5: Update `updateEpoch` external wrapper**

Around line 1470:

```solidity
function updateEpoch() external onlyRole(OPERATOR_ROLE) {
    _updateEpochInternal();
}
```

(No argument change, just the body.)

- [ ] **Step 6: Compile**

Run: `npm run compile`
Expected: one error — `UpdateEpoch` event signature mismatch. Task 9 fixes this. Do NOT commit yet.

- [ ] **Step 7: Proceed to Task 9 before committing**

Do not commit Task 8 alone — the build is broken until Task 9 lands.

---

## Task 9: Remove `totalMgtFeeMinted` and update `UpdateEpoch` event signature

**Intent:** Completes Task 8. After this task, the build is green again.

**Files:**
- Modify: `contracts/extension/Express.sol`
- Modify: `test/unit/Express.comprehensive.test.ts`
- Modify: `test/unit/Express.mgtFeeAccounting.test.ts`

- [ ] **Step 1: Locate all `totalMgtFeeMinted` references**

Run: `npx grep -n "totalMgtFeeMinted" contracts test deploy`
Note every hit. Expected surface to clean:
- State var declaration + its doc comment (lines ~127-129)
- `UpdateEpoch` event field (line ~190)
- Inline comment in `_processSinglePendingRedeem` (~line 944) — "totalMgtFeeMinted stays monotonic (cumulative); only the 'unclaimed' tracker drops"
- Doc-comment references in `updateMgtFeeTo` (lines ~442-451)
- Doc-comment references in `_sharesPerToken` (lines ~1620-1646) — these come out when the function is rewritten in Task 4, but re-verify nothing drifted back
- All test assertions (counts by file are in the Task 9 commit message)

- [ ] **Step 2: Remove state variable and comment**

In `Express.sol`, delete lines ~127-129:

```solidity
// Cumulative management fee tokens ever minted. Monotonically increasing; never decremented.
// Used together with `totalMgtFeeUnclaimed` to compute `_sharesPerToken()`.
uint256 public totalMgtFeeMinted;
```

- [ ] **Step 3: Update `UpdateEpoch` event signature**

Around line 190, change:

```solidity
event UpdateEpoch(uint256 totalMgtFeeMinted, uint256 dailyFee, uint256 epoch, uint256 circulatingSupply);
```

to:

```solidity
event UpdateEpoch(uint256 dailyFee, uint256 epoch, uint256 circulatingSupply);
```

- [ ] **Step 4: Remove comment block referencing `totalMgtFeeMinted`**

Around line 442-451 (the `updateMgtFeeTo` doc block referencing `totalMgtFeeMinted`), rewrite the block to drop that reference. Keep the `totalMgtFeeUnclaimed` and queue-empty preconditions.

- [ ] **Step 5: Compile**

Run: `npm run compile`
Expected: clean.

- [ ] **Step 6: Fix failing tests**

Run: `npm test 2>&1 | tail -100`. Iterate:
- In `test/unit/Express.mgtFeeAccounting.test.ts`, remove any `totalMgtFeeMinted` reads and assertions.
- In `test/unit/Express.comprehensive.test.ts`, remove `totalMgtFeeMinted` assertions; update `UpdateEpoch` event assertions to the new 3-arg signature.

- [ ] **Step 7: Run full suite**

Run: `npm test 2>&1 | tail -40`
Expected: PASS.

- [ ] **Step 8: Commit — both tasks 8 and 9 land together**

```bash
git add contracts/extension/Express.sol test/unit/Express.comprehensive.test.ts test/unit/Express.mgtFeeAccounting.test.ts
git commit -m "refactor: remove totalMgtFeeMinted, updateEpochAdjust, and drained-state tracking from updateEpoch"
```

---

## Task 10: Remove `DrainedInstance` and clean dead comments

**Files:**
- Modify: `contracts/extension/Express.sol`
- Modify: any test file still asserting `DrainedInstance`

- [ ] **Step 1: Locate references**

Run: `npx grep -n "DrainedInstance" contracts test`
Expected: only the error declaration is left (all guard call sites were replaced in Task 5). If test files reference it, update them to expect `OffchainSharesNotSet` instead.

- [ ] **Step 2: Remove error declaration**

In `Express.sol` (errors block near line 316), delete:

```solidity
error DrainedInstance();
```

- [ ] **Step 3: Clean dead doc comments mentioning `totalMgtFeeMinted` / drained state**

Scan for lingering comment fragments (e.g., the doc block above `_calculateMintAmount` at line ~624 talking about MEV / back-run extraction) and prune them. Replace with a one-line comment describing the new guard: *"Reverts if offchain shares are not yet set but tokens already exist — prevents mispricing when the bot has not confirmed a BNY value."*

- [ ] **Step 4: Also check for `circulatingSupply() == 0 && totalMgtFeeMinted > 0` patterns**

Run: `npx grep -n "totalMgtFeeMinted" contracts`
Expected: zero hits.

- [ ] **Step 5: Compile + full test suite**

Run: `npm run compile && npm test 2>&1 | tail -40`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add contracts/extension/Express.sol test
git commit -m "refactor: remove DrainedInstance error and dead drained-state comments"
```

---

## Task 11: Integration test — daily routine end-to-end

**Files:**
- Create: `test/integration/DailyRoutine.test.ts`

- [ ] **Step 1: Sketch the scenario**

One file, one `describe` block. Scenario:

- Day 0: deploy fixture. Three KYC'd users. Operator + Confirmer roles granted to distinct signers.
- Day 0: User A and User B call `requestDeposit`.
- Day 0: bot runs the 6-step routine:
  1. `processDepositQueue(0)` — mints for A and B (bootstrap path: first mint at 1:1).
  2. Operator `proposeOffchainShares(x)` → Confirmer `confirmOffchainShares(x)` — seed offchain shares to match `totalSupply`.
  3. `updateEpoch()` — mints daily fee to `mgtFeeTo`.
  4. `processPendingRedeems(0)` — empty pending queue, expect revert `EmptyQueue` — skip if queue empty (use a try/catch or check length first).
  5. `processRedeemQueue(0)` — empty final queue, same treatment.
  6. `snapshotPendingRedeemRatio()` — empty pending queue, expect revert `EmptyQueue` — skip.
- Day 1: User A calls `requestRedeem` for half her shares. Advance time by `convertRedeemRequestsDelay`.
- Day 1: bot routine. Step 4 now finds A's pending entry not yet ripe (if delay is 2 days). Step 6 snapshots today's ratio for A's entry.
- Day 2: bot routine. A's entry now ripe. Step 4 moves A to final queue with her Day 1 snapshot. Step 5 burns her shares and pays redeemAsset (liquidity must be seeded in the fixture).

Assertions:

- After step 1 Day 0: ratio = `1e18` (bootstrap)
- After step 2 Day 0: ratio = `1e18` (offchainShares == totalSupply)
- After step 3 Day 0: ratio < `1e18` (fee dilution)
- User A's Day 2 redemption payout equals `_redeemAssetAmount(shareAmount, snapshotRatio_Day1, getPrice())` minus redeem fee
- `totalMgtFeeUnclaimed` increases monotonically across epoch mints; drops when `mgtFeeTo` redeems through the queue

Use helpers from the existing unit tests for deposit seeding and advancing time. Fixture should seed sufficient redeem-asset liquidity in Express to cover A's exit.

- [ ] **Step 2: Write the integration test**

Implement as described. Keep it readable — not a stress test. ~200-400 lines is fine.

- [ ] **Step 3: Run — expect pass**

Run: `npx hardhat test test/integration/DailyRoutine.test.ts`

- [ ] **Step 4: Commit**

```bash
git add test/integration/DailyRoutine.test.ts
git commit -m "test: add end-to-end daily-routine integration test"
```

---

## Task 12: Deploy script — grant `CONFIRM_ROLE`

**Files:**
- Modify: `deploy/04_deploy_express.ts`

- [ ] **Step 1: Extend network config files**

Network-specific JSON configs live in `config/` (e.g., `config/sepolia.json`, `config/mainnet.json`). In each file's `Express` section, add a `confirmer` field next to `mgtFeeTo`. Use the zero address `"0x0000000000000000000000000000000000000000"` as the default (the deploy script falls back to `deployer` when the value is zero, matching the existing pattern for `mgtFeeTo`, `treasury`, `txFeeTo`).

The loader in `deploy/config.ts` already accepts arbitrary fields via `getConfigValue`, so no loader changes are needed. Re-verify by searching: `grep -n "mgtFeeTo" deploy/config.ts config/*.json`.

- [ ] **Step 2: Grant `CONFIRM_ROLE` after deploy**

In `deploy/04_deploy_express.ts`, in the block where admin grants roles to Express (or post-deploy role setup), add:

```ts
if (admin === deployer) {
  const CONFIRM_ROLE = await express.CONFIRM_ROLE();
  const confirmerConfig = getConfigValue<string>(expressConfig, 'confirmer');
  const confirmer = confirmerConfig === ethers.ZeroAddress ? deployer : confirmerConfig;
  const grantConfirmTx = await express.grantRole(CONFIRM_ROLE, confirmer);
  await grantConfirmTx.wait();
  console.log('✅ CONFIRM_ROLE granted to', confirmer);
} else {
  console.log('⚠️  CONFIRM_ROLE grant skipped — admin is not deployer.');
}
```

Also grant `OPERATOR_ROLE` if the existing script does not already do so — scan the current script to avoid duplicating grants.

- [ ] **Step 3: Dry-run deploy on hardhat network**

Run: `npx hardhat deploy --network hardhat --tags express --reset 2>&1 | tail -40`
Expected: clean run, log line for `CONFIRM_ROLE granted to <addr>`.

- [ ] **Step 4: Commit**

```bash
git add deploy/
git commit -m "chore: grant CONFIRM_ROLE during Express deploy"
```

---

## Task 13: Final verification

**Files:**
- None (verification only)

- [ ] **Step 1: Full compile**

Run: `npm run clean && npm run compile`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `npm test 2>&1 | tee /tmp/hybond-test.log | tail -60`
Expected: PASS. Review the log for skipped tests or `describe.skip` blocks that slipped in.

- [ ] **Step 3: Coverage check**

Run: `npm run coverage 2>&1 | tail -40`
Expected: project ≥80% line coverage. New offchain-shares surface (propose/confirm/_sharesPerToken/guards) at ≥95%.

- [ ] **Step 4: Gas report**

Run: `REPORT_GAS=true npx hardhat test test/unit/Express.OffchainShares.test.ts 2>&1 | tail -30`
Expected: `proposeOffchainShares` and `confirmOffchainShares` costs are reasonable (under 60k gas each; they're tiny state updates).

- [ ] **Step 5: Contract size check**

Run: `npm run size 2>&1 | grep -i express`
Expected: Express contract below the 24576-byte limit with some margin.

- [ ] **Step 6: Code review**

Dispatch `code-reviewer` agent on the Express.sol diff and new test files. Fix CRITICAL and HIGH issues.

- [ ] **Step 7: Security review**

Dispatch `security-reviewer` agent on the propose/confirm state machine and all new guards. Pay attention to:
- Can `proposedOffchainShares` be griefed (e.g., operator spams propose to block the confirmer)?
- Is there any path to confirm a value the operator never proposed?
- Can the bootstrap carve-out be exploited (first deposit at 1:1 followed by immediate propose to create arbitrage)?

- [ ] **Step 8: Final commit (if reviews flagged anything)**

```bash
git add -A
git commit -m "fix: address code/security review feedback"
```

- [ ] **Step 9: Summarize and stop**

Produce a short summary of the merged changes (file list + task IDs completed). Do not open a PR. Do not push. Wait for the user to decide next steps.

---

## Post-implementation checklist

- [ ] All 13 tasks committed
- [ ] Full test suite green
- [ ] Coverage ≥80% overall, ≥95% on new surface
- [ ] Code review clean
- [ ] Security review clean
- [ ] Spec file unchanged (any deviations from the spec are flagged in commit messages)
- [ ] Deploy script supports `CONFIRM_ROLE` grant

## Out of scope

- Offchain bot implementation for the daily routine
- Reconciliation / drift-alert tooling (see spec §9)
- Price-oracle changes
- Documentation updates beyond in-contract comments (update `CLAUDE.md` if the terminology around `sharesPerToken` changes enough to warrant it, otherwise leave it)

## References

- Spec: `docs/superpowers/specs/2026-04-19-offchain-shares-design.md`
- Current contract: `contracts/extension/Express.sol`
- Project CLAUDE.md (deposit/redeem terminology, operational invariants for `mgtFeeTo`)
