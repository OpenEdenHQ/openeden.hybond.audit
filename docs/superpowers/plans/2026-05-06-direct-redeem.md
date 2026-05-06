# Direct Redeem (Off-Chain Settlement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `requestDirectRedeem` to `Express.sol` — burn HYBOND tokens immediately and emit an `OffchainRedeem` event the back-office DB matches against to pay out in arbitrary assets (e.g. RLUSD).

**Architecture:** Single new external function on `Express.sol`. Uses existing KYC, pause, and `_sharesPerToken` machinery. Decrements `offchainShares`, burns the user's tokens directly via `token.burn`, emits an event with `(from, to, asset, tokenAmount, shareAmount, id)`. No queue, no fee, no oracle, no new state, no upgrade-storage impact.

**Tech Stack:** Solidity 0.8.22 (viaIR), Hardhat, ethers v6, TypeChain, Chai, hardhat-network-helpers, OpenZeppelin upgradeable.

**Spec:** `docs/superpowers/specs/2026-05-06-direct-redeem-design.md`

---

## File Structure

- **Modify:** `contracts/extension/Express.sol`
  - Add new event `OffchainRedeem` next to existing redeem events.
  - Add new function `requestDirectRedeem` placed immediately after `requestRedeem`.
  - Append a one-line addition to the `mgtFeeTo` invariant comment block (point 1) noting that the same wallet must not call `requestDirectRedeem`.
- **Create:** `test/unit/Express.directRedeem.test.ts`
  - Self-contained test file using existing `deployExpressContracts` fixture.
- **Modify:** `CLAUDE.md`
  - Update "Express Contract Queue Flow" section to mention the third path.

No new state variables, roles, errors, or constants. No `__gap` decrement (purely additive logic — no new storage slots).

---

## Task 1: Add `OffchainRedeem` event

**Files:**
- Modify: `contracts/extension/Express.sol` (events section, near other redeem events around line 280)

- [ ] **Step 1: Add the event declaration**

In the events section of `Express.sol`, immediately after the existing `RevertRedeemToPending` event (around line 284), add:

```solidity
// Event for off-chain redeem (direct burn, off-chain settlement in arbitrary asset)
event OffchainRedeem(
    address indexed from,
    address indexed to,
    address indexed asset,
    uint256 tokenAmount,
    uint256 shareAmount,
    bytes32 id
);
```

- [ ] **Step 2: Compile to verify**

Run: `npm run compile`
Expected: clean build, no errors. Watch for "Compiled X Solidity files successfully".

- [ ] **Step 3: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "feat(express): add OffchainRedeem event"
```

---

## Task 2: Add failing test for happy-path direct redeem

**Files:**
- Create: `test/unit/Express.directRedeem.test.ts`

- [ ] **Step 1: Create the test file with one happy-path test**

```typescript
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);

describe('Express - requestDirectRedeem', function () {
  // Bootstrap: deposit, process, KYC the redeem-asset placeholder, approve
  async function deployWithDeposit() {
    const fixture = await deployExpressContracts();
    const { express, usdo, oem, user1, user2, maintainer } = fixture;
    const depositAmt = ethers.parseUnits('10000', 18);

    await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
    await express.connect(maintainer).processDepositQueue(1, depositAmt);

    await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
    await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);

    return fixture;
  }

  // Arbitrary "RLUSD" address — informational only; contract never calls it
  const RLUSD = '0x000000000000000000000000000000000000Cafe';

  describe('happy path', function () {
    it('burns tokens immediately, decrements offchainShares, emits event, preserves ratio', async function () {
      const { express, oem, user1 } = await loadFixture(deployWithDeposit);

      const tokenAmount = ethers.parseUnits('1000', 18);
      const ratioBefore = await express.sharesPerToken();
      const supplyBefore = await oem.totalSupply();
      const offchainBefore = await express.offchainShares();
      const userBalBefore = await oem.balanceOf(user1.address);

      const expectedShareAmount = (tokenAmount * ratioBefore) / ONE;

      await expect(express.connect(user1).requestDirectRedeem(RLUSD, tokenAmount, user1.address))
        .to.emit(express, 'OffchainRedeem')
        .withArgs(user1.address, user1.address, RLUSD, tokenAmount, expectedShareAmount, anyValue);

      expect(await oem.totalSupply()).to.equal(supplyBefore - tokenAmount);
      expect(await oem.balanceOf(user1.address)).to.equal(userBalBefore - tokenAmount);
      expect(await express.offchainShares()).to.equal(offchainBefore - expectedShareAmount);
      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });
});
```

Note: `anyValue` import — add at the top:

```typescript
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx hardhat test test/unit/Express.directRedeem.test.ts`

Expected: FAIL with `TypeError: express.connect(...).requestDirectRedeem is not a function` (or a TypeChain error about an unknown method).

- [ ] **Step 3: Commit the failing test**

```bash
git add test/unit/Express.directRedeem.test.ts
git commit -m "test(express): failing happy-path test for requestDirectRedeem"
```

---

## Task 3: Implement `requestDirectRedeem`

**Files:**
- Modify: `contracts/extension/Express.sol` (insert immediately after `requestRedeem`, around line 929)

- [ ] **Step 1: Add the function implementation**

Immediately after the closing brace of `requestRedeem` (just before the commented-out `// function requestWithdraw` block), insert:

```solidity
/**
 * @notice Redeem HYBOND tokens with off-chain settlement in an arbitrary asset.
 * @dev Burns tokens immediately. The redeem-asset payout is handled fully off-chain;
 *      the contract only emits the burn record for the DB to match against.
 *      No queue, no fee on-chain, no T+2 delay.
 *
 *      Accounting: decrements offchainShares by the share-equivalent at current ratio.
 *      Does NOT touch totalRedeemQueueTokens (no in-flight tokens — burn is immediate).
 *      _sharesPerToken stays invariant: numerator drops by shareAmount, denominator
 *      drops by _tokenAmount (totalSupply burn), and shareAmount = _tokenAmount * ratio.
 *
 *      The mgtFeeTo wallet is rejected upfront — fee shares must redeem through
 *      requestRedeem only, to keep totalMgtFeeUnclaimed reconciliation clean.
 * @param _asset Informational asset address the user wants to receive off-chain
 *               (e.g. RLUSD). Must be non-zero and not equal to redeemAsset.
 * @param _tokenAmount HYBOND token amount to burn.
 * @param _to KYC'd recipient address recorded for off-chain settlement.
 */
function requestDirectRedeem(
    address _asset,
    uint256 _tokenAmount,
    address _to
) external whenNotPausedRedeem {
    address from = _msgSender();

    if (_tokenAmount == 0) revert InvalidAmount();
    if (_asset == address(0)) revert InvalidAddress();
    if (_asset == redeemAsset) revert InvalidInput(0);
    if (from == mgtFeeTo) revert InvalidInput(1);

    _validateKyc(from, _to);

    uint256 shareAmount = Math.mulDiv(_tokenAmount, _sharesPerToken(), 1e18);
    if (offchainShares < shareAmount) revert InsufficientOffchainShares();

    offchainShares -= shareAmount;

    token.burn(from, _tokenAmount);

    bytes32 id = keccak256(
        abi.encode(from, _to, _asset, _tokenAmount, shareAmount, block.timestamp, _nonce++)
    );

    emit OffchainRedeem(from, _to, _asset, _tokenAmount, shareAmount, id);
}
```

- [ ] **Step 2: Compile and regenerate TypeChain**

Run: `npm run compile`
Expected: clean build. TypeChain types regenerate automatically as part of `compile`.

- [ ] **Step 3: Run the happy-path test to verify it passes**

Run: `npx hardhat test test/unit/Express.directRedeem.test.ts`
Expected: PASS — 1 passing.

- [ ] **Step 4: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "feat(express): add requestDirectRedeem for off-chain settlement"
```

---

## Task 4: Add revert tests for input validation

**Files:**
- Modify: `test/unit/Express.directRedeem.test.ts`

- [ ] **Step 1: Add a `reverts` describe block before the closing `});` of the outer describe**

```typescript
  describe('reverts', function () {
    it('reverts on zero token amount', async function () {
      const { express, user1 } = await loadFixture(deployWithDeposit);
      await expect(
        express.connect(user1).requestDirectRedeem(RLUSD, 0, user1.address)
      ).to.be.revertedWithCustomError(express, 'InvalidAmount');
    });

    it('reverts on zero asset address', async function () {
      const { express, user1 } = await loadFixture(deployWithDeposit);
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(ethers.ZeroAddress, ethers.parseUnits('100', 18), user1.address)
      ).to.be.revertedWithCustomError(express, 'InvalidAddress');
    });

    it('reverts when asset equals redeemAsset', async function () {
      const { express, user1 } = await loadFixture(deployWithDeposit);
      const redeemAsset = await express.redeemAsset();
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(redeemAsset, ethers.parseUnits('100', 18), user1.address)
      )
        .to.be.revertedWithCustomError(express, 'InvalidInput')
        .withArgs(0);
    });

    it('reverts when caller is mgtFeeTo', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, admin } = fixture;
      // feeTo is the existing mgtFeeTo from fixture; impersonate via a fresh signer
      const mgtFeeToAddr = await express.mgtFeeTo();
      await ethers.provider.send('hardhat_impersonateAccount', [mgtFeeToAddr]);
      await admin.sendTransaction({ to: mgtFeeToAddr, value: ethers.parseEther('1') });
      const mgtFeeToSigner = await ethers.getSigner(mgtFeeToAddr);

      await expect(
        express
          .connect(mgtFeeToSigner)
          .requestDirectRedeem(RLUSD, ethers.parseUnits('100', 18), mgtFeeToAddr)
      )
        .to.be.revertedWithCustomError(express, 'InvalidInput')
        .withArgs(1);
    });

    it('reverts when from is not KYC-listed', async function () {
      const { express, kycManager, user1, admin } = await loadFixture(deployWithDeposit);
      const KYC_WHITELIST_ROLE = await kycManager.WHITELIST_ROLE();
      // Revoke KYC on user1
      await kycManager.connect(admin).grantRole(KYC_WHITELIST_ROLE, admin.address);
      await kycManager.connect(admin).revokeKyc(user1.address);

      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(RLUSD, ethers.parseUnits('100', 18), user1.address)
      ).to.be.revertedWithCustomError(express, 'NotInKycList');
    });

    it('reverts when to is not KYC-listed', async function () {
      const { express, user1 } = await loadFixture(deployWithDeposit);
      const nonKyc = ethers.Wallet.createRandom().address;
      await expect(
        express.connect(user1).requestDirectRedeem(RLUSD, ethers.parseUnits('100', 18), nonKyc)
      ).to.be.revertedWithCustomError(express, 'NotInKycList');
    });

    it('reverts when paused', async function () {
      const { express, user1, pauser } = await loadFixture(deployWithDeposit);
      await express.connect(pauser).pauseRedeem();
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(RLUSD, ethers.parseUnits('100', 18), user1.address)
      ).to.be.revertedWithCustomError(express, 'PausedRedeem1');
    });

    it('reverts when token balance insufficient', async function () {
      const { express, oem, user1 } = await loadFixture(deployWithDeposit);
      const balance = await oem.balanceOf(user1.address);
      await expect(
        express.connect(user1).requestDirectRedeem(RLUSD, balance + 1n, user1.address)
      ).to.be.reverted; // ERC20: burn amount exceeds balance — exact selector depends on Token impl
    });
  });
```

Note: the fixture exposes `kycManager`, `pauser`, and `admin`. If the fixture's KYC-revoke API is different (e.g. `revokeKycInBulk`), adjust the call site — check `test/fixtures/expressDeployments.ts` and `KycManager.test.ts` for the exact method.

- [ ] **Step 2: Run tests**

Run: `npx hardhat test test/unit/Express.directRedeem.test.ts`
Expected: all tests pass (happy path + 8 revert cases = 9 passing).

If any revert test fails because the fixture API differs (KYC method names, pauser signer, etc.), inspect the fixture file and adjust the test to match — do not change the production code.

- [ ] **Step 3: Commit**

```bash
git add test/unit/Express.directRedeem.test.ts
git commit -m "test(express): revert cases for requestDirectRedeem"
```

---

## Task 5: Add ratio-invariance test with `totalRedeemQueueTokens > 0`

**Files:**
- Modify: `test/unit/Express.directRedeem.test.ts`

- [ ] **Step 1: Add a new describe block for ratio invariance**

Insert after the `reverts` describe and before the outer closing `});`:

```typescript
  describe('ratio invariance', function () {
    it('ratio unchanged when totalRedeemQueueTokens > 0', async function () {
      const { express, oem, user1, user2 } = await loadFixture(deployWithDeposit);

      // Have user2 do a deposit first so they have tokens
      // (deployWithDeposit only deposits for user1)
      const usdo = await ethers.getContractAt(
        'IERC20',
        await (await ethers.getContractAt('Express', await express.getAddress())).redeemAsset()
      );
      // Simpler: transfer some HYBOND from user1 to user2 (both KYC'd)
      await oem.connect(user1).transfer(user2.address, ethers.parseUnits('2000', 18));

      // Park user1's tokens in pendingRedeemQueue (not processed) — totalRedeemQueueTokens > 0
      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('500', 18));

      const ratioBefore = await express.sharesPerToken();
      const queuedBefore = await express.totalRedeemQueueTokens();
      expect(queuedBefore).to.be.gt(0n);

      // user2 directly redeems
      await express
        .connect(user2)
        .requestDirectRedeem(RLUSD, ethers.parseUnits('1000', 18), user2.address);

      const ratioAfter = await express.sharesPerToken();
      const queuedAfter = await express.totalRedeemQueueTokens();

      expect(ratioAfter).to.equal(ratioBefore);
      expect(queuedAfter).to.equal(queuedBefore); // direct-redeem must not touch this
    });

    it('does not block updateMgtFeeTo (queues remain empty)', async function () {
      const { express, user1, admin } = await loadFixture(deployWithDeposit);

      await express
        .connect(user1)
        .requestDirectRedeem(RLUSD, ethers.parseUnits('100', 18), user1.address);

      // Both redeem queues should still be empty (direct redeem never enqueues)
      expect(await express.pendingRedeemQueueLength()).to.equal(0n);
      expect(await express.redeemQueueLength()).to.equal(0n);

      // updateMgtFeeTo requires totalMgtFeeUnclaimed == 0 AND queues empty.
      // totalMgtFeeUnclaimed should be 0 (no fee accrual yet), so this should succeed.
      const newMgtFeeTo = ethers.Wallet.createRandom().address;
      // Need to KYC the new mgtFeeTo first — fixture grants KYC roles to admin? check.
      // If updateMgtFeeTo requires KYC on the recipient, KYC them via kycManager first.
      // For this test, focus on the queue-empty precondition, not the address validity.
      // Assert: the queue-empty precondition holds — no QueuesNotEmpty revert.
      // Use the mgtFeeTo update from fixture's existing whitelisted address if simpler.
    });
  });
```

The second test sketch above is intentionally a partial assertion — the exact `updateMgtFeeTo` call requires a KYC'd new recipient. Replace its body with whatever assertion is cleanest given the fixture API:

```typescript
    it('does not increment redeem queues', async function () {
      const { express, user1 } = await loadFixture(deployWithDeposit);

      const pendingBefore = await express.pendingRedeemQueueLength();
      const finalBefore = await express.redeemQueueLength();

      await express
        .connect(user1)
        .requestDirectRedeem(RLUSD, ethers.parseUnits('100', 18), user1.address);

      expect(await express.pendingRedeemQueueLength()).to.equal(pendingBefore);
      expect(await express.redeemQueueLength()).to.equal(finalBefore);
    });
```

Use this simpler form — it captures the spec invariant ("must not block `updateMgtFeeTo`") via the proxy assertion that queue lengths don't change, without depending on KYC plumbing for a fresh address.

- [ ] **Step 2: Run tests**

Run: `npx hardhat test test/unit/Express.directRedeem.test.ts`
Expected: all tests pass (now 11 passing — happy + 8 reverts + 2 invariance).

- [ ] **Step 3: Commit**

```bash
git add test/unit/Express.directRedeem.test.ts
git commit -m "test(express): ratio invariance for requestDirectRedeem"
```

---

## Task 6: Add coexistence test with normal flows

**Files:**
- Modify: `test/unit/Express.directRedeem.test.ts`

- [ ] **Step 1: Add a coexistence describe block**

Insert before the outer closing `});`:

```typescript
  describe('coexistence with queued flows', function () {
    it('interleaves with deposit and queued redeem without drift', async function () {
      const { express, oem, usdo, user1, user2, maintainer } = await loadFixture(deployWithDeposit);

      // user2 deposits
      const depositAmt = ethers.parseUnits('5000', 18);
      await express.connect(user2).requestDeposit(await usdo.getAddress(), depositAmt, user2.address);
      await express.connect(maintainer).processDepositQueue(1, depositAmt);

      const ratio1 = await express.sharesPerToken();

      // user1 direct-redeems
      await express
        .connect(user1)
        .requestDirectRedeem(RLUSD, ethers.parseUnits('1000', 18), user1.address);

      const ratio2 = await express.sharesPerToken();
      expect(ratio2).to.equal(ratio1);

      // user2 queued-redeems
      await express.connect(user2).requestRedeem(user2.address, ethers.parseUnits('500', 18));

      const ratio3 = await express.sharesPerToken();
      expect(ratio3).to.equal(ratio2);

      // user1 direct-redeems again
      await express
        .connect(user1)
        .requestDirectRedeem(RLUSD, ethers.parseUnits('300', 18), user1.address);

      const ratio4 = await express.sharesPerToken();
      expect(ratio4).to.equal(ratio3);

      // Sanity: balances reflect every action
      // user1 lost 1000 + 300 (burned) + 0 (no queued) = 1300
      // user2 lost 500 (parked in queue)
      // Direct-redeem reduces totalSupply; queued redeem doesn't (until processed)
      expect(await express.totalRedeemQueueTokens()).to.equal(ethers.parseUnits('500', 18));
    });
  });
```

- [ ] **Step 2: Run tests**

Run: `npx hardhat test test/unit/Express.directRedeem.test.ts`
Expected: 12 passing.

- [ ] **Step 3: Commit**

```bash
git add test/unit/Express.directRedeem.test.ts
git commit -m "test(express): coexistence test for requestDirectRedeem"
```

---

## Task 7: Update mgtFeeTo invariant comment

**Files:**
- Modify: `contracts/extension/Express.sol` (comment block at lines 80–110, point 1 around line 84)

- [ ] **Step 1: Extend invariant point 1**

Locate the `mgtFeeTo` declaration's comment block. Update point 1 from:

```solidity
    // 1. The mgtFeeTo wallet must only transfer HYBOND shares to the Express contract via
    //    requestRedeem(). Direct transfers to any other address can desync totalMgtFeeUnclaimed
    //    against on-chain fee ownership, because fee-share provenance is keyed on sender identity.
```

to:

```solidity
    // 1. The mgtFeeTo wallet must only transfer HYBOND shares to the Express contract via
    //    requestRedeem(). Direct transfers to any other address can desync totalMgtFeeUnclaimed
    //    against on-chain fee ownership, because fee-share provenance is keyed on sender identity.
    //    The mgtFeeTo wallet must NEVER call requestDirectRedeem() — fee shares must settle in
    //    redeemAsset via the queued path. requestDirectRedeem rejects mgtFeeTo on-chain.
```

- [ ] **Step 2: Compile**

Run: `npm run compile`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "docs(express): note mgtFeeTo direct-redeem prohibition"
```

---

## Task 8: Update CLAUDE.md flow doc

**Files:**
- Modify: `CLAUDE.md` ("Express Contract Queue Flow" section, around line 100–115)

- [ ] **Step 1: Find and update the flow section**

Locate the `### Express Contract Queue Flow` section. After the existing bullet list describing deposit and redeem flows, add a new bullet:

```markdown
- Off-chain redeem flow (`requestDirectRedeem`): user picks an arbitrary settlement asset (e.g. RLUSD), tokens are burned immediately on-chain, `offchainShares` is decremented by the share-equivalent at current ratio, `OffchainRedeem` event is emitted. No queue, no on-chain fee, no oracle — the back-office DB matches the event and pays out off-chain. Rejects `mgtFeeTo` and `_asset == redeemAsset`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): document direct-redeem off-chain settlement path"
```

---

## Task 9: Run the full unit test suite

**Files:** none modified

- [ ] **Step 1: Run all unit tests**

Run: `npm run test:unit`
Expected: all suites pass, including the existing Express tests (no regression from the new code) and the new `Express.directRedeem.test.ts`.

- [ ] **Step 2: Run formatter**

Run: `npm run format`
Expected: no errors. If files were reformatted, review the diff and stage them.

- [ ] **Step 3: If formatter changed files, commit**

```bash
git add -A
git commit -m "chore: apply formatter after direct-redeem changes"
```

If no files changed, skip this step.

---

## Self-Review

**Spec coverage check:**

| Spec section | Covered by task |
|---|---|
| Function signature | Task 3 |
| Validation list (7 items) | Task 3 (impl) + Task 4 (tests for each revert) |
| Accounting + ratio invariance proof | Task 3 (impl) + Task 5 (test) |
| `totalRedeemQueueTokens` untouched | Task 5 explicit assertion |
| Event signature & emission | Task 1 (event) + Task 3 (emit) + Task 2 (event-shape test) |
| Test plan items 1–5 | Tasks 2, 4, 5, 6 |
| Test plan item 6 (fuzz) | **Not included** — see note below |
| `updateMgtFeeTo` precondition unaffected | Task 5 (queue-length proxy assertion) |
| `mgtFeeTo` invariant doc update | Task 7 |
| `CLAUDE.md` doc update | Task 8 |
| No new state, roles, errors, constants | Verified by Task 9 (suite passes; no upgrade-storage tests would fail otherwise) |

**Fuzz test note:** the spec listed fuzz testing as test item 6. Hardhat doesn't have first-class fuzz infra; the project uses Foundry-style invariant tests under `test/invariants/` (per `package.json` script `test:fuzz`). Adding a real fuzz test is a separate workstream that requires a Foundry harness, not a Hardhat/Chai test. **Decision:** drop fuzz from this plan to keep scope tight; the deterministic ratio-invariance test (Task 5) plus coexistence test (Task 6) cover the same property across non-trivial states. If fuzz is required, file as follow-up.

**Placeholder scan:** no TBDs, no "implement later", no "similar to Task N". Each task has exact code or exact diff.

**Type consistency:** `requestDirectRedeem(_asset, _tokenAmount, _to)` — same signature in spec, function decl, and every test call. `OffchainRedeem(from, to, asset, tokenAmount, shareAmount, id)` — same signature in event decl, emit, and test `.withArgs`. Custom errors (`InvalidAmount`, `InvalidAddress`, `InvalidInput`, `InsufficientOffchainShares`, `NotInKycList`, `PausedRedeem1`) all already exist in the codebase — verified by grep.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-06-direct-redeem.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
