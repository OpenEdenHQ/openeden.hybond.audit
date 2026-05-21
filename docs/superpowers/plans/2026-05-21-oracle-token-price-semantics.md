# Oracle Returns Token Price — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propagate the new oracle semantics (`priceOracle` returns assets-per-HYBOND-token instead of assets-per-offchain-share) through `Express.sol` and the test suite, with zero storage / queue / event ABI changes.

**Architecture:** Three production code edits to `Express.sol`: (1) `processDepositQueue` deviation gate adds a `× sharesPerToken` step on the oracle-derived value, (2) `previewRedeem` drops its `× sharesPerToken` step (price already gives the final answer), (3) `processPendingRedeems` expected-total accumulator switches from stored `shareAmount` to stored `tokenAmount`. Plus one cosmetic parameter rename in `_redeemAssetAmount` and two comment updates. Test fixture `expectedRedeemAssetTotal` must be updated in lock-step or every Express test that uses it breaks the moment a non-1e18 oracle is introduced. Five new tests lock in the new semantics under non-trivial price/ratio combinations.

**Tech Stack:** Solidity 0.8.22, hardhat, TypeChain (ethers-v6), chai+mocha. Tests under `test/unit/`, fixtures under `test/fixtures/`.

**Spec:** `docs/2026-05-21-oracle-token-price-semantics-design.md`

---

## File Structure

**Production code (modify only):**
- `contracts/extension/Express.sol` — three logic edits + one parameter rename + one comment update
- `CLAUDE.md` — one-liner under "Express Contract Queue Flow"

**Test code:**
- `test/fixtures/expressDeployments.ts` — modify `expectedRedeemAssetTotal` helper
- `test/unit/Express.oracleTokenPrice.test.ts` — **create**, holds the five new tests for the migrated semantics

No new contracts. No storage layout change. No event ABI change.

---

## Task 1: Update `_redeemAssetAmount` parameter name (cosmetic, no behavior change)

This is the safest edit first — pure rename of an internal function parameter. Lands the smallest possible commit so subsequent diffs are easier to read.

**Files:**
- Modify: `contracts/extension/Express.sol:1743`

- [ ] **Step 1: Make the edit**

Change the function signature and any internal usage of `_shareAmount`:

```solidity
// Before
function _redeemAssetAmount(uint256 _shareAmount, uint256 _price) internal view returns (uint256 redeemAssetAmt) {
    redeemAssetAmt = _trimAsset(
        Math.mulDiv(convertToUnderlying(redeemAsset, _shareAmount), _price, 1e18),
        redeemAsset
    );
}

// After
function _redeemAssetAmount(uint256 _amount18, uint256 _price) internal view returns (uint256 redeemAssetAmt) {
    redeemAssetAmt = _trimAsset(
        Math.mulDiv(convertToUnderlying(redeemAsset, _amount18), _price, 1e18),
        redeemAsset
    );
}
```

Also update the NatSpec line just above (Express.sol around :1740) — change `@param _shareAmount Offchain share amount (ratio already applied)` to `@param _amount18 18-decimal HYBOND-denominated amount (tokens or shares, depending on caller)`.

- [ ] **Step 2: Compile**

Run: `npm run compile`
Expected: success, no warnings about `_redeemAssetAmount`.

- [ ] **Step 3: Run the full unit suite as a no-op regression**

Run: `npm run test:unit`
Expected: all tests pass — this rename is cosmetic.

- [ ] **Step 4: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "refactor(express): rename _redeemAssetAmount param to _amount18"
```

---

## Task 2: New test file with a failing test (TDD anchor for Task 3)

We add the test that exercises the *new* `previewRedeem` semantics first. It will fail against the current implementation, proving the migration is necessary and giving Task 3 a green-light criterion.

**Files:**
- Create: `test/unit/Express.oracleTokenPrice.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/Express.oracleTokenPrice.test.ts`:

```typescript
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import {
  deployExpressContracts,
  bootstrapAndSeedOffchainShares,
} from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);

// Move the oracle's published price to `tokenPriceE18` via the propose/confirm flow.
// PriceOracle decimals = 18, so the value passes straight through to getPrice().
async function setOraclePrice(
  priceOracle: any,
  admin: any,
  operator: any,
  confirmer: any,
  tokenPriceE18: bigint
) {
  const OPERATOR_ROLE = await priceOracle.OPERATOR_ROLE();
  const CONFIRMER_ROLE = await priceOracle.CONFIRMER_ROLE();
  if (!(await priceOracle.hasRole(OPERATOR_ROLE, operator.address))) {
    await priceOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
  }
  if (!(await priceOracle.hasRole(CONFIRMER_ROLE, confirmer.address))) {
    await priceOracle.connect(admin).grantRole(CONFIRMER_ROLE, confirmer.address);
  }
  // Widen deviation gates on the oracle so we can move the price freely in tests.
  await priceOracle.connect(admin).updateRelativeMaxDeviation(10000);
  await priceOracle.connect(admin).updateAbsoluteMaxDeviation(10000);

  const latest = await ethers.provider.getBlock('latest');
  await priceOracle
    .connect(operator)
    .proposePrice(tokenPriceE18, BigInt(latest!.timestamp - 1));
  await priceOracle.connect(confirmer).confirmPrice(tokenPriceE18);
}

describe('Express — oracle returns token price (assets per HYBOND token)', function () {
  describe('previewRedeem', function () {
    it('returns tokens × tokenPrice when sharesPerToken == 1e18', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const { express, priceOracle, admin, operator, maintainer } = fixture;

      // Bootstrap so sharesPerToken == 1e18.
      await bootstrapAndSeedOffchainShares(fixture);

      // Oracle says 1 HYBOND = 1.05 USDO.
      const tokenPrice = (ONE * 105n) / 100n;
      await setOraclePrice(priceOracle, admin, operator, operator, tokenPrice);

      // Zero out redeemFeeRate so we can assert raw payout.
      await express.connect(maintainer).updateRedeemFeeRate(0);

      const oneHybond = ONE;
      const [, redeemAssetAmt, netRedeemAssetAmt] = await express.previewRedeem(oneHybond);

      // Expected: 1 × 1.05 = 1.05 (USDO has 18 decimals in fixture).
      expect(redeemAssetAmt).to.equal(tokenPrice);
      expect(netRedeemAssetAmt).to.equal(tokenPrice);
    });
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx hardhat test test/unit/Express.oracleTokenPrice.test.ts`
Expected: FAIL. The current `previewRedeem` computes `shareAmount = tokens × sharesPerToken / 1e18 = tokens`, then `_redeemAssetAmount(shareAmount, price)` which yields `1 × 1.05 = 1.05`. **Wait** — when `sharesPerToken == 1e18` the share step is a no-op, so this specific test will accidentally pass. We need a stronger anchor.

Replace the body of the test with a version that perturbs `sharesPerToken`:

```typescript
    it('returns tokens × tokenPrice independently of sharesPerToken', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const { express, priceOracle, admin, operator, maintainer } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);

      // Skew the ratio: bootstrap left offchainShares == totalSupply.
      // Halve offchainShares → sharesPerToken = 0.5e18.
      const offchainBefore = await express.offchainShares();
      await express.connect(maintainer).updateOffchainShares(offchainBefore / 2n);
      expect(await express.sharesPerToken()).to.equal(ONE / 2n);

      // Oracle: 1 HYBOND = 1.05 USDO (token price, not share price).
      const tokenPrice = (ONE * 105n) / 100n;
      await setOraclePrice(priceOracle, admin, operator, operator, tokenPrice);

      await express.connect(maintainer).updateRedeemFeeRate(0);

      const oneHybond = ONE;
      const [, redeemAssetAmt] = await express.previewRedeem(oneHybond);

      // Under NEW semantics: 1 token × 1.05 token-price = 1.05.
      // Under OLD semantics: shareAmount = 1 × 0.5 = 0.5; 0.5 × 1.05 = 0.525.
      expect(redeemAssetAmt).to.equal(tokenPrice);
    });
```

Re-run: `npx hardhat test test/unit/Express.oracleTokenPrice.test.ts`
Expected: FAIL with `AssertionError: expected 525000000000000000 to equal 1050000000000000000` (old code produces 0.525, new spec requires 1.05).

- [ ] **Step 3: Commit (failing test, locked in for the next task)**

```bash
git add test/unit/Express.oracleTokenPrice.test.ts
git commit -m "test(express): failing test for previewRedeem under token-price oracle"
```

---

## Task 3: Update `previewRedeem` to use tokenPrice directly

**Files:**
- Modify: `contracts/extension/Express.sol:995-1004`

- [ ] **Step 1: Apply the edit**

```solidity
// Before
function previewRedeem(
    uint256 _tokenAmount
) public view returns (uint256 feeAmt, uint256 redeemAssetAmt, uint256 netRedeemAssetAmt) {
    uint256 price = getPrice();
    uint256 ratio = _sharesPerToken();
    uint256 shareAmount = Math.mulDiv(_tokenAmount, ratio, 1e18);
    redeemAssetAmt = _redeemAssetAmount(shareAmount, price);
    feeAmt = txsFee(redeemAssetAmt, TxType.REDEEM);
    netRedeemAssetAmt = redeemAssetAmt - feeAmt;
}

// After
function previewRedeem(
    uint256 _tokenAmount
) public view returns (uint256 feeAmt, uint256 redeemAssetAmt, uint256 netRedeemAssetAmt) {
    uint256 price = getPrice();
    redeemAssetAmt = _redeemAssetAmount(_tokenAmount, price);
    feeAmt = txsFee(redeemAssetAmt, TxType.REDEEM);
    netRedeemAssetAmt = redeemAssetAmt - feeAmt;
}
```

- [ ] **Step 2: Run the new test, expect green**

Run: `npx hardhat test test/unit/Express.oracleTokenPrice.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full unit suite**

Run: `npm run test:unit`
Expected: all PASS. Existing tests run against oracle = 1e18 in the deployment fixture, where `shareAmount × price == tokens × price`, so they remain green.

- [ ] **Step 4: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "fix(express): previewRedeem uses tokenPrice oracle directly"
```

---

## Task 4: Update `processDepositQueue` deviation gate

The operator still passes `_newShares`. The deviation gate must now convert the oracle's token-price result through `sharesPerToken` to land in the same units before comparing.

**Files:**
- Modify: `contracts/extension/Express.sol:788-791`

- [ ] **Step 1: Add the failing test**

Append to `test/unit/Express.oracleTokenPrice.test.ts` inside the top-level `describe`:

```typescript
  describe('processDepositQueue deviation gate', function () {
    it('derives oracleShares as (oracleTokens × sharesPerToken) and accepts matching _newShares', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const {
        express,
        priceOracle,
        usdo,
        user1,
        admin,
        operator,
        maintainer,
      } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);

      // Skew ratio: sharesPerToken = 0.5e18.
      const offchainBefore = await express.offchainShares();
      await express.connect(maintainer).updateOffchainShares(offchainBefore / 2n);
      expect(await express.sharesPerToken()).to.equal(ONE / 2n);

      // Oracle: 1 HYBOND = 1.05 USDO.
      const tokenPrice = (ONE * 105n) / 100n;
      await setOraclePrice(priceOracle, admin, operator, operator, tokenPrice);

      // Tighten the deposit deviation gate to 1% so we actually test the path.
      await express.connect(maintainer).updateDepositMaxDeviationBps(100);
      await express.connect(maintainer).updateDepositFeeRate(0);

      // user1 deposits 1050 USDO. Net = 1050 (fee 0).
      const depositAmt = ethers.parseUnits('1050', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      // Operator-derived oracleTokens = 1050 / 1.05 = 1000 HYBOND.
      // oracleShares = 1000 × 0.5 = 500 shares.
      const expectedShares = ethers.parseUnits('500', 18);

      // Pass exactly the oracle-implied shares — deviation gate passes.
      await expect(
        express.connect(maintainer).processDepositQueue(1, expectedShares)
      ).to.not.be.reverted;
    });

    it('reverts when _newShares deviates >1% from (oracleTokens × sharesPerToken)', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const {
        express,
        priceOracle,
        usdo,
        user1,
        admin,
        operator,
        maintainer,
      } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);
      const offchainBefore = await express.offchainShares();
      await express.connect(maintainer).updateOffchainShares(offchainBefore / 2n);

      const tokenPrice = (ONE * 105n) / 100n;
      await setOraclePrice(priceOracle, admin, operator, operator, tokenPrice);

      await express.connect(maintainer).updateDepositMaxDeviationBps(100);
      await express.connect(maintainer).updateDepositFeeRate(0);

      const depositAmt = ethers.parseUnits('1050', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      // 10% off expectedShares = 500 → 550 → must revert.
      const wrong = ethers.parseUnits('550', 18);
      await expect(
        express.connect(maintainer).processDepositQueue(1, wrong)
      ).to.be.revertedWithCustomError(express, 'OracleDeviationExceeded');
    });
  });
```

- [ ] **Step 2: Confirm the new tests fail**

Run: `npx hardhat test test/unit/Express.oracleTokenPrice.test.ts --grep "processDepositQueue deviation gate"`
Expected: FAIL. With current code, `oracleShares` (misnamed) = `1050 / 1.05 = 1000`, so the gate expects `_newShares ≈ 1000`. Passing 500 reverts; passing 550 passes — the inverse of the assertions.

- [ ] **Step 3: Apply the production edit**

```solidity
// Before (around Express.sol:788)
if (address(priceOracle) != address(0)) {
    uint256 oracleShares = Math.mulDiv(batchTotalNetAssets, 1e18, getPrice());
    _checkDeviation(_newShares, oracleShares, depositMaxDeviationBps);
}

// After
if (address(priceOracle) != address(0)) {
    uint256 oracleTokens = Math.mulDiv(batchTotalNetAssets, 1e18, getPrice());
    uint256 oracleShares = Math.mulDiv(oracleTokens, _sharesPerToken(), 1e18);
    _checkDeviation(_newShares, oracleShares, depositMaxDeviationBps);
}
```

- [ ] **Step 4: Re-run the targeted tests**

Run: `npx hardhat test test/unit/Express.oracleTokenPrice.test.ts --grep "processDepositQueue deviation gate"`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: all PASS. Existing tests run with `sharesPerToken = 1e18` after bootstrap and oracle = 1e18, where `oracleShares = oracleTokens × 1 = oracleTokens` — identical to old behavior.

- [ ] **Step 6: Commit**

```bash
git add contracts/extension/Express.sol test/unit/Express.oracleTokenPrice.test.ts
git commit -m "fix(express): processDepositQueue derives oracleShares via sharesPerToken"
```

---

## Task 5: Update `processPendingRedeems` expected-total accumulator

Switch the per-entry `_redeemAssetAmount` call from stored `shareAmount` to stored `tokenAmount`. Pass-2 pro-rata distribution stays on `shareAmount` (deliberately — preserves request-time ratio fidelity per the spec).

**Files:**
- Modify: `contracts/extension/Express.sol:1036-1060` (the destructure on :1036 needs `tokenAmount` reachable, then :1059 changes)

- [ ] **Step 1: Add a failing test that distinguishes the two formulations**

Append to `test/unit/Express.oracleTokenPrice.test.ts`:

```typescript
  describe('processPendingRedeems expected-total', function () {
    it('uses stored tokenAmount × tokenPrice (not shareAmount × tokenPrice)', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const {
        express,
        priceOracle,
        user1,
        admin,
        operator,
        maintainer,
      } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);

      // Move ratio to 0.5 BEFORE the redeem so the stored shareAmount differs from tokenAmount.
      const offchainBefore = await express.offchainShares();
      await express.connect(maintainer).updateOffchainShares(offchainBefore / 2n);
      expect(await express.sharesPerToken()).to.equal(ONE / 2n);

      // Oracle: 1 HYBOND = 1.05 USDO.
      const tokenPrice = (ONE * 105n) / 100n;
      await setOraclePrice(priceOracle, admin, operator, operator, tokenPrice);

      // Tighten redeem deviation gate.
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100);
      await express.connect(maintainer).updateRedeemFeeRate(0);

      // user1 holds firstDepositAmount HYBOND from bootstrap. Redeem 100.
      const redeemAmt = ethers.parseUnits('100', 18);
      await express.connect(user1).requestRedeem(user1.address, redeemAmt);

      // Stored on the queued entry:
      //   tokenAmount = 100
      //   shareAmount = 100 × 0.5 = 50
      // NEW expected-total: tokenAmount × tokenPrice = 100 × 1.05 = 105.
      // OLD expected-total would be: 50 × 1.05 = 52.5.
      const newExpected = ethers.parseUnits('105', 18);

      // Advance past the T+2 delay.
      await ethers.provider.send('evm_increaseTime', [2 * 24 * 60 * 60 + 1]);
      await ethers.provider.send('evm_mine', []);

      // Pass exactly the NEW expected total — deviation gate passes.
      await expect(
        express.connect(operator).processPendingRedeems(1, newExpected)
      ).to.not.be.reverted;
    });

    it('Pass-2 pro-rata distribution still honors stored shareAmount, not tokenAmount', async function () {
      // Two redeems at different sharesPerToken snapshots should split _totalAsset
      // by stored shareAmount, not by tokenAmount. We enqueue redeem A under ratio=1,
      // then move ratio to 0.5 and enqueue redeem B under ratio=0.5. Both for 100 HYBOND.
      // shareAmounts: A=100, B=50. Total=150. _totalAsset=150 USDO. Expected payouts:
      //   A gets 150 × 100/150 = 100; B gets 150 × 50/150 = 50.
      const fixture = await loadFixture(deployExpressContracts);
      const {
        express,
        usdo,
        user1,
        user2,
        admin,
        operator,
        maintainer,
        priceOracle,
      } = fixture;

      // Bootstrap with user1.
      await bootstrapAndSeedOffchainShares(fixture);

      // user1 has firstDepositAmount HYBOND. Transfer 100 to user2 so both can redeem.
      const oem = await ethers.getContractAt(
        'contracts/Token.sol:Token',
        await express.oem()
      );
      // grant KYC was done in fixture for user1 & user2, so transfer is allowed
      await oem.connect(user1).transfer(user2.address, ethers.parseUnits('100', 18));

      // Redeem A: user1 at sharesPerToken=1e18. shareAmount = 100.
      await express
        .connect(user1)
        .requestRedeem(user1.address, ethers.parseUnits('100', 18));

      // Now skew ratio to 0.5.
      const offchainBefore = await express.offchainShares();
      await express.connect(maintainer).updateOffchainShares(offchainBefore / 2n);

      // Redeem B: user2 at sharesPerToken=0.5e18. shareAmount = 50.
      await express
        .connect(user2)
        .requestRedeem(user2.address, ethers.parseUnits('100', 18));

      // Oracle = 1.0 token-price so expected-total derives cleanly.
      await setOraclePrice(priceOracle, admin, operator, operator, ONE);
      await express.connect(maintainer).updateRedeemMaxDeviationBps(10000);
      await express.connect(maintainer).updateRedeemFeeRate(0);

      // Wait T+2.
      await ethers.provider.send('evm_increaseTime', [2 * 24 * 60 * 60 + 1]);
      await ethers.provider.send('evm_mine', []);

      // Total expected under NEW semantics: A=100, B=100 → 200.
      // But the pro-rata weights still use shareAmount: A=100, B=50 → A:B = 2:1.
      // If operator passes _totalAsset=200: A gets 200×100/150 ≈ 133.33; B gets ≈ 66.67.
      const totalAsset = ethers.parseUnits('200', 18);

      const balUser1Before = await usdo.balanceOf(user1.address);
      const balUser2Before = await usdo.balanceOf(user2.address);

      await express.connect(operator).processPendingRedeems(2, totalAsset);

      // Process the final redeemQueue to actually transfer USDO.
      await express.connect(operator).processRedeemQueue(2);

      const balUser1After = await usdo.balanceOf(user1.address);
      const balUser2After = await usdo.balanceOf(user2.address);

      // user1 (shareAmount=100) gets 2× user2's (shareAmount=50) payout.
      // Allow ±1 wei for trim rounding.
      const payA = balUser1After - balUser1Before;
      const payB = balUser2After - balUser2Before;
      expect(payA).to.be.closeTo(ethers.parseUnits('400', 18) / 3n, 2n);
      expect(payB).to.be.closeTo(ethers.parseUnits('200', 18) / 3n, 2n);
    });
  });
```

- [ ] **Step 2: Confirm both tests fail**

Run: `npx hardhat test test/unit/Express.oracleTokenPrice.test.ts --grep "processPendingRedeems expected-total"`
Expected: First test FAILS — current code derives `expectedTotal` from `shareAmount × price = 52.5`, so operator-supplied `105` deviates ~100% and the gate reverts with `OracleDeviationExceeded`. Second test depends on the `expectedRedeemAssetTotal` helper consistency (Task 6); it may pass *or* fail depending on tolerance, but the assertions on shareAmount-weighted pro-rata are correct regardless.

If the second test fails on the deviation gate, that means we also need to update the fixture helper before this task lands. That's Task 6 — but to keep the TDD anchor green-by-green, just confirm the first test fails and move on; the second will land once Task 6 lands.

- [ ] **Step 3: Apply the production edit**

The current Pass-1 already destructures `tokenAmount` (look at Express.sol:1037-1043 — `tokenAmount` is the third tuple element). The change is just on the line that calls `_redeemAssetAmount`:

```solidity
// Before (Express.sol around :1058)
if (useOracle) {
    expectedTotal += _redeemAssetAmount(shareAmount, oraclePrice);
}

// After
if (useOracle) {
    expectedTotal += _redeemAssetAmount(tokenAmount, oraclePrice);
}
```

No other lines in the `while` loop change. Pass-2 (Express.sol:1075-1125) is unchanged — pro-rata still uses `shareAmounts[i] / batchTotalShares`.

- [ ] **Step 4: Re-run the first targeted test**

Run: `npx hardhat test test/unit/Express.oracleTokenPrice.test.ts --grep "uses stored tokenAmount"`
Expected: PASS.

- [ ] **Step 5: Commit (the helper update + second test green-light comes in Task 6)**

```bash
git add contracts/extension/Express.sol test/unit/Express.oracleTokenPrice.test.ts
git commit -m "fix(express): processPendingRedeems expectedTotal uses tokenAmount"
```

---

## Task 6: Update `expectedRedeemAssetTotal` fixture helper

This helper mirrors the contract's expected-total math. Now that the contract uses `tokenAmount × price`, the helper must too — otherwise every existing test that calls it under a non-trivial price/ratio drifts into a `OracleDeviationExceeded` revert.

**Files:**
- Modify: `test/fixtures/expressDeployments.ts:198-225`

- [ ] **Step 1: Apply the edit**

```typescript
// Before (test/fixtures/expressDeployments.ts:212-214)
  for (let i = 0; i < len; i++) {
    const info = await express.getPendingRedeemQueueInfo(i);
    const shareAmount: bigint = info[3];
    const raw = (shareAmount * price) / ONE_E18;
    // ... trim ...
  }

// After
  for (let i = 0; i < len; i++) {
    const info = await express.getPendingRedeemQueueInfo(i);
    const tokenAmount: bigint = info[2];
    const raw = (tokenAmount * price) / ONE_E18;
    // ... trim ...
  }
```

Verify the tuple index: `getPendingRedeemQueueInfo` returns `(sender, receiver, tokenAmount, shareAmount, requestTimestamp, id)` — so `info[2]` is `tokenAmount`, `info[3]` is `shareAmount`. Double-check before saving by grepping the contract:

```bash
grep -n "getPendingRedeemQueueInfo" contracts/extension/Express.sol
```

Update the NatSpec at the top of the helper to match:

```typescript
/**
 * Compute the oracle-implied total redeem asset payout for the next `_len` pending
 * redeem entries. Mirrors `processPendingRedeems`'s expected-total accumulation
 * under the token-price oracle semantics:
 *   sum_i _redeemAssetAmount(tokenAmount_i, oraclePrice)
 * where _redeemAssetAmount = trim(amount * price / 1e18, redeemAsset decimals).
 *
 * Pass the returned value as `_totalAsset` to keep the deviation check happy when
 * a test only cares that processing succeeds (not the precise distribution amount).
 */
```

- [ ] **Step 2: Run full unit suite**

Run: `npm run test:unit`
Expected: all PASS. Most call sites still run with `sharesPerToken = 1e18` so the formula change is a no-op there. Any site that perturbs the ratio (e.g. `Express.sharePerToken.test.ts`) now gets a consistent helper output.

- [ ] **Step 3: Re-run the second processPendingRedeems test from Task 5**

Run: `npx hardhat test test/unit/Express.oracleTokenPrice.test.ts --grep "Pass-2 pro-rata"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/expressDeployments.ts
git commit -m "test(fixtures): expectedRedeemAssetTotal uses tokenAmount under token-price oracle"
```

---

## Task 7: Bootstrap regression test

Lock in the property that an oracle price of `1e18` with `sharesPerToken == 1e18` (bootstrap path) behaves identically before and after the migration. This is the test that protects future-you from a silent regression if anyone touches `_calculateMintAmount` or `previewRedeem` again.

**Files:**
- Modify: `test/unit/Express.oracleTokenPrice.test.ts` (append)

- [ ] **Step 1: Write the test**

Append to the top-level `describe`:

```typescript
  describe('regression — bootstrap path (oracle=1e18, ratio=1e18)', function () {
    it('previewRedeem returns _tokenAmount net of fee at bootstrap', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const { express, maintainer } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);
      // Oracle stays at the fixture default (1e18). Ratio is 1e18.

      await express.connect(maintainer).updateRedeemFeeRate(0);

      const amt = ethers.parseUnits('1', 18);
      const [, redeemAssetAmt] = await express.previewRedeem(amt);
      expect(redeemAssetAmt).to.equal(amt);
    });

    it('processDepositQueue deviation gate is permissive when oracle=1e18 and ratio=1e18', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const { express, usdo, user1, maintainer } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);

      await express.connect(maintainer).updateDepositMaxDeviationBps(100);
      await express.connect(maintainer).updateDepositFeeRate(0);

      const depositAmt = ethers.parseUnits('1000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      // 1000 / 1.0 = 1000 oracleTokens; × 1.0 = 1000 oracleShares.
      await expect(
        express.connect(maintainer).processDepositQueue(1, ethers.parseUnits('1000', 18))
      ).to.not.be.reverted;
    });
  });
```

- [ ] **Step 2: Run**

Run: `npx hardhat test test/unit/Express.oracleTokenPrice.test.ts --grep "regression"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/unit/Express.oracleTokenPrice.test.ts
git commit -m "test(express): bootstrap regression for token-price oracle migration"
```

---

## Task 8: Documentation updates

**Files:**
- Modify: `contracts/extension/Express.sol` (comment near `priceOracle` declaration, around :121)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the priceOracle declaration comment**

In `Express.sol` around line 121, the declaration is `IPriceFeed public priceOracle;`. Add or update the immediately-preceding comment block to read:

```solidity
/// @notice External price feed reporting the token price of HYBOND (assets per
///         HYBOND token, normalized to 1e18). When unset, getPrice() falls back
///         to 1e18 (1:1 ratio). Note: this changed from share-price semantics —
///         see docs/2026-05-21-oracle-token-price-semantics-design.md.
IPriceFeed public priceOracle;
```

- [ ] **Step 2: Update CLAUDE.md**

Under the "Express Contract Queue Flow" section in `CLAUDE.md`, add a single bullet after the existing flow description:

```markdown
- **Oracle semantics**: `priceOracle` returns the **token price** (assets per HYBOND token, 1e18). `sharesPerToken` is used inside the contract to convert oracleTokens ↔ oracleShares whenever the operator-supplied parameter is in share units (e.g. `processDepositQueue(_newShares)`).
```

- [ ] **Step 3: Compile and run full suite**

Run: `npm run compile && npm run test:unit`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add contracts/extension/Express.sol CLAUDE.md
git commit -m "docs(express): document oracle = token price semantics"
```

---

## Task 9: Full validation sweep

Final gate. Run integration tests, gas report sanity check, and coverage.

- [ ] **Step 1: Integration suite**

Run: `npm run test:integration`
Expected: all PASS. Integration tests under `test/integration/DailyRoutine.test.ts` run with the deployment fixture's default oracle (1e18) — no behavioral change.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: every test passes.

- [ ] **Step 3: Coverage**

Run: `npm run coverage:unit`
Expected: `Express.sol` line and branch coverage is at or above the pre-migration baseline. The new test file adds branch coverage on the deviation gates under non-trivial price/ratio combinations.

- [ ] **Step 4: Gas report sanity check**

Run: `REPORT_GAS=true npx hardhat test test/unit/Express.comprehensive.test.ts`
Expected: gas for `processDepositQueue` rises by ~one `mulDiv` (≈600 gas) due to the added `oracleTokens × sharesPerToken` step; gas for `previewRedeem` drops slightly (one `mulDiv` removed); gas for `processPendingRedeems` unchanged (substituted operand, no extra op). Document the deltas in the commit message if material; otherwise note "within noise."

- [ ] **Step 5: Lint and format**

Run: `npm run format:check`
Expected: clean. If anything reformats, run `npm run format` and commit.

- [ ] **Step 6: Final commit (only if format changed anything)**

```bash
git add -A
git commit -m "chore: format after oracle token-price migration"
```

---

## Self-Review

**1. Spec coverage:** Each section of `docs/2026-05-21-oracle-token-price-semantics-design.md`:
- `_calculateMintAmount` unchanged → no task, confirmed by spec and by `Task 9` regression run.
- `processDepositQueue` deviation gate → **Task 4**.
- `previewRedeem` → **Task 3**.
- `processPendingRedeems` expected-total → **Task 5**.
- `_redeemAssetAmount` rename → **Task 1**.
- Doc updates (Express.sol comment + CLAUDE.md) → **Task 8**.
- Test buckets: Bucket A/B existing tests untouched (`Task 9` validation); Bucket C new tests → **Tasks 2, 4, 5, 7**.
- Fixture helper drift → **Task 6**.
- Five new test cases enumerated in spec → covered (previewRedeem under non-trivial ratio in Task 2; deposit deviation pass/fail in Task 4; expected-total uses tokenAmount + pro-rata uses shareAmount in Task 5; bootstrap regression in Task 7).

No gaps.

**2. Placeholder scan:** No TBDs, no "implement later," no naked "add tests for the above," no "similar to Task N" — every step ships full code blocks or full commands.

**3. Type consistency:** `_newShares` referenced consistently as the share-denominated operator input across Tasks 4 and the spec. `tokenAmount`/`shareAmount` field names match the existing queue entry encoding (verified against Express.sol:1037-1043). `getPendingRedeemQueueInfo` return-tuple indices (`info[2]` = tokenAmount, `info[3]` = shareAmount) flagged for double-check in Task 6 Step 1.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-21-oracle-token-price-semantics.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Strong fit here because tasks are small and the spec leaves no design judgment to make — purely mechanical work with verifiable acceptance criteria at each step.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Lower overhead but you lose the per-task review cadence.

**Which approach?**
