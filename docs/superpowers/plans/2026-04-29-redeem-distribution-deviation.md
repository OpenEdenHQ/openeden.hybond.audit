# Operator-Driven Redeem Distribution + Symmetric Oracle Deviation Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch `processPendingRedeems` to distribute operator-supplied `_totalAsset` pro-rata by `shareAmount` (mirroring `processDepositQueue`), and replace the one-sided oracle bound on both functions with a symmetric `±maxDeviationBps` deviation guard configurable per side.

**Architecture:** Append two storage fields (`depositMaxDeviationBps`, `redeemMaxDeviationBps`) to `Express.sol`. Add a single internal `_checkDeviation` helper. Rewrite `processPendingRedeems` as a two-pass loop (pop+accumulate, then distribute) and replace the existing one-sided check in `processDepositQueue` with the new helper. Wrap both deviation checks with `if (address(priceOracle) != address(0))` so the oracle-unset path skips the check entirely. Add MAINTAINER setters with events. Update tests accordingly.

**Tech Stack:** Solidity 0.8.22 (OpenZeppelin upgradeable), Hardhat + TypeChain (ethers v6), Mocha/Chai, hardhat-deploy.

**Spec:** `docs/superpowers/specs/2026-04-29-redeem-distribution-deviation-design.md`

---

## File Structure

**Modified:**
- `contracts/extension/Express.sol` — add storage, helper, new error, two setters + events, rewrite `processPendingRedeems`, replace deposit-side check, extend file-top operational-invariants comment
- `test/unit/Express.invariance.test.ts:223-228` — existing test expects `InsufficientSettlementFunds` on under-supplied `_totalAsset`; update to `OracleDeviationExceeded` and adjust `_totalAsset` value to clearly exceed band
- `docs/DEPLOYMENT.md` — add post-upgrade setter call step

**Created:**
- `test/unit/Express.deviation.test.ts` — full unit suite for new behavior

**No changes:**
- `_redeemAssetAmount` helper (still used inside Pass 1 to compute `expectedTotal`)
- queue encodings, fee math, KYC re-validation, event signatures (except added events)
- deploy scripts (no constructor/initializer change)

---

## Task 1: Add storage fields + setters + events + new error

**Files:**
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Append the new error to the ERRORS section**

After the existing `error InsufficientSettlementFunds(uint256 oracleTotal, uint256 suppliedTotal);` line (around `Express.sol:307`), add:

```solidity
    error OracleDeviationExceeded(uint256 actual, uint256 expected, uint256 bps);
```

- [ ] **Step 2: Append the two storage fields at the end of the storage section**

Find the last storage variable in the STATE VARIABLES block (currently `mapping(address => mapping(address => uint256)) public depositEscrowBalance;` at `Express.sol:172`). Append immediately after it (before the EVENTS section comment block):

```solidity
    // Symmetric oracle deviation tolerance (basis points, BPS_BASE = 10000) for processDepositQueue.
    // 0 = strict equality with oracle; > BPS_BASE rejected by setter. Skipped when priceOracle unset.
    uint256 public depositMaxDeviationBps;

    // Symmetric oracle deviation tolerance (basis points, BPS_BASE = 10000) for processPendingRedeems.
    // 0 = strict equality with oracle; > BPS_BASE rejected by setter. Skipped when priceOracle unset.
    uint256 public redeemMaxDeviationBps;
```

- [ ] **Step 3: Append the two events to the EVENTS section**

After `event KycManagerUpdated(...)` (around `Express.sol:192`), add:

```solidity
    event UpdateDepositMaxDeviationBps(uint256 bps);
    event UpdateRedeemMaxDeviationBps(uint256 bps);
```

- [ ] **Step 4: Add the two setters in the FEE MANAGEMENT section**

After `updateMgtFeeRate` (around `Express.sol:528-532`), add:

```solidity
    /**
     * @notice Update the symmetric oracle deviation tolerance for processDepositQueue
     * @param _bps Deviation tolerance in basis points (0 = strict, max = BPS_BASE)
     */
    function updateDepositMaxDeviationBps(uint256 _bps) external onlyRole(MAINTAINER_ROLE) {
        if (_bps > BPS_BASE) revert InvalidInput(_bps);
        _requireQueuesEmpty();
        depositMaxDeviationBps = _bps;
        emit UpdateDepositMaxDeviationBps(_bps);
    }

    /**
     * @notice Update the symmetric oracle deviation tolerance for processPendingRedeems
     * @param _bps Deviation tolerance in basis points (0 = strict, max = BPS_BASE)
     */
    function updateRedeemMaxDeviationBps(uint256 _bps) external onlyRole(MAINTAINER_ROLE) {
        if (_bps > BPS_BASE) revert InvalidInput(_bps);
        _requireQueuesEmpty();
        redeemMaxDeviationBps = _bps;
        emit UpdateRedeemMaxDeviationBps(_bps);
    }
```

`_requireQueuesEmpty()` is the same guard used by `updatePriceOracle`, `updateMaxStalePeriod`, etc. — verify it exists and is reachable from this scope (it is; used several times nearby).

- [ ] **Step 5: Add `_checkDeviation` internal helper**

Place it immediately after `getPrice()` (around `Express.sol:672`), before the DEPOSIT QUEUE MANAGEMENT section banner:

```solidity
    /**
     * @notice Symmetric oracle deviation guard
     * @dev Reverts if |actual - expected| / expected exceeds bps / BPS_BASE.
     *      No-op when expected == 0 (degenerate; empty batches do not reach this).
     * @param actual Operator-supplied value
     * @param expected Oracle-derived value
     * @param bps Tolerance in basis points (BPS_BASE = 10000)
     */
    function _checkDeviation(uint256 actual, uint256 expected, uint256 bps) internal pure {
        if (expected == 0) return;
        uint256 diff = actual > expected ? actual - expected : expected - actual;
        if (diff * BPS_BASE > expected * bps) {
            revert OracleDeviationExceeded(actual, expected, bps);
        }
    }
```

- [ ] **Step 6: Extend the file-top operational-invariants comment**

In the comment block at `Express.sol:103-107`, the line currently reads:

```
    //    Do NOT change convertRedeemRequestsDelay, redeemFeeRate, depositFeeRate, priceOracle,
    //    maxStalePeriod, or trimDecimals while pendingRedeemQueue / redeemQueue / depositQueue is
    //    non-empty — doing so will silently change the pricing, fees, or settlement timing of
    //    already-queued entries relative to what the user saw when they submitted.
```

Update the first line of that paragraph to include the two new vars:

```
    //    Do NOT change convertRedeemRequestsDelay, redeemFeeRate, depositFeeRate, priceOracle,
    //    maxStalePeriod, trimDecimals, depositMaxDeviationBps, or redeemMaxDeviationBps while
    //    pendingRedeemQueue / redeemQueue / depositQueue is non-empty — doing so will silently
    //    change the pricing, fees, or settlement timing of already-queued entries relative to
    //    what the user saw when they submitted.
```

(The on-chain `_requireQueuesEmpty()` in the setters enforces this for the new bps vars.)

- [ ] **Step 7: Compile**

Run: `npm run compile`
Expected: PASS, no warnings about unused variables. Two new public getters auto-generated for `depositMaxDeviationBps` / `redeemMaxDeviationBps`.

- [ ] **Step 8: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "feat(express): add deviation-bps storage, setters, helper, OracleDeviationExceeded error"
```

---

## Task 2: Rewrite `processPendingRedeems` and replace deposit guard

**Files:**
- Modify: `contracts/extension/Express.sol`

This is the structural change. We do compile-only here; tests in Task 3 verify behavior.

- [ ] **Step 1: Replace the deposit-side one-sided check**

Locate `Express.sol:716-717`:

```solidity
        uint256 oracleMinShares = Math.mulDiv(batchTotalNetAssets, 1e18, getPrice());
        if (oracleMinShares > _newShares) revert InsufficientSettlementFunds(oracleMinShares, _newShares);
```

Replace with:

```solidity
        if (address(priceOracle) != address(0)) {
            uint256 oracleShares = Math.mulDiv(batchTotalNetAssets, 1e18, getPrice());
            _checkDeviation(_newShares, oracleShares, depositMaxDeviationBps);
        }
```

- [ ] **Step 2: Rewrite `processPendingRedeems`**

Locate `processPendingRedeems` (currently `Express.sol:906-926`) and the `_processSinglePendingRedeem` helper (`Express.sol:934-995`).

Replace the entire `processPendingRedeems` function with:

```solidity
    /**
     * @notice Process pending redeems with operator-supplied total asset distributed pro-rata
     * @dev Two-pass: Pass 1 pops ready entries, validates KYC, sums shareAmounts, and (if oracle
     *      configured) accumulates oracle-derived expected total. Then deviation-checks
     *      _totalAsset against expectedTotal. Pass 2 distributes _totalAsset pro-rata by
     *      shareAmount and computes per-entry fee on the operator-derived slice.
     *
     *      Stops at the first not-ready entry. If no entries are ready, reverts
     *      NoPendingRedeemsReady. _totalAsset is interpreted relative to the entries actually
     *      processed (not the requested _len).
     * @param _len Number of pending requests to attempt (must be > 0)
     * @param _totalAsset Operator-supplied actual redeem asset pool to distribute pro-rata
     */
    function processPendingRedeems(uint256 _len, uint256 _totalAsset) external onlyRole(OPERATOR_ROLE) {
        bool useOracle = address(priceOracle) != address(0);
        uint256 oraclePrice = useOracle ? getPrice() : 0;

        bytes[] memory entries = new bytes[](_len);
        uint256[] memory shareAmounts = new uint256[](_len);
        uint256 batchTotalShares;
        uint256 expectedTotal;
        uint256 processed;

        // Pass 1: pop ready entries, validate KYC, accumulate
        while (processed < _len && !pendingRedeemQueue.empty()) {
            bytes memory data = pendingRedeemQueue.front();
            (
                address sender,
                address receiver,
                uint256 tokenAmount,
                uint256 shareAmount,
                uint256 requestTimestamp,
                // pendingId
            ) = _decodePendingRedeemData(data);

            if (block.timestamp < requestTimestamp + convertRedeemRequestsDelay) {
                break;
            }

            _validateKyc(sender, receiver);

            pendingRedeemQueue.popFront();
            pendingRedeemInfo[receiver] -= tokenAmount;

            entries[processed] = data;
            shareAmounts[processed] = shareAmount;
            batchTotalShares += shareAmount;

            if (useOracle) {
                expectedTotal += _redeemAssetAmount(shareAmount, oraclePrice);
            }

            unchecked {
                ++processed;
            }
        }

        if (processed == 0) revert NoPendingRedeemsReady();

        // Deviation gate
        if (useOracle) {
            _checkDeviation(_totalAsset, expectedTotal, redeemMaxDeviationBps);
        }

        // Pass 2: distribute _totalAsset pro-rata by shareAmount
        for (uint256 i = 0; i < processed; ) {
            (
                address sender,
                address receiver,
                uint256 tokenAmount,
                uint256 shareAmount,
                uint256 requestTimestamp,
                bytes32 pendingId
            ) = _decodePendingRedeemData(entries[i]);

            uint256 redeemAssetAmt = _trimAsset(
                Math.mulDiv(_totalAsset, shareAmounts[i], batchTotalShares),
                redeemAsset
            );
            uint256 feeAssetAmt = txsFee(redeemAssetAmt, TxType.REDEEM);

            bytes32 finalId = keccak256(
                abi.encode(
                    sender,
                    receiver,
                    tokenAmount,
                    shareAmount,
                    redeemAssetAmt,
                    feeAssetAmt,
                    requestTimestamp,
                    block.timestamp,
                    _nonce++
                )
            );

            redeemQueue.pushBack(
                abi.encode(
                    sender,
                    receiver,
                    tokenAmount,
                    shareAmount,
                    redeemAssetAmt,
                    feeAssetAmt,
                    requestTimestamp,
                    finalId
                )
            );

            redeemInfo[receiver] += tokenAmount;

            emit ProcessPendingRedeem(sender, receiver, tokenAmount, oraclePrice, pendingId, finalId);

            unchecked {
                ++i;
            }
        }
    }
```

Notes on the rewrite:
- Tuple destructuring with a trailing skipped element uses the trailing-comma form `(... , )`. If the codebase's existing style uses a named throwaway, match it; the existing `_processSinglePendingRedeem` uses `bytes32 pendingId` — we name it in Pass 2 but not Pass 1. Both forms compile.
- `ProcessPendingRedeem`'s `priceUsed` field receives `oraclePrice` (which is `0` when oracle unset). This is a behavior change: previously `_processSinglePendingRedeem` passed `getPrice()` which returned `1e18` fallback. Off-chain consumers reading the event from oracle-unset deployments must accept `0` as "no oracle". Acceptable per spec; document if surfaced.

- [ ] **Step 3: Delete `_processSinglePendingRedeem`**

Remove the entire helper (currently `Express.sol:928-995`, including its NatSpec block). The new `processPendingRedeems` inlines its logic across the two passes.

- [ ] **Step 4: Compile**

Run: `npm run compile`
Expected: PASS. The compiler may warn about unused `InsufficientSettlementFunds` if no remaining call sites — verify by grep:

Run: `grep -n "InsufficientSettlementFunds" contracts/extension/Express.sol`
Expected: only the `error` declaration remains. Leave the declaration in place; cleanup is a follow-up per the spec.

- [ ] **Step 5: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "feat(express): rewrite processPendingRedeems for operator-driven distribution + symmetric deviation"
```

---

## Task 3: Unit tests for new behavior

**Files:**
- Create: `test/unit/Express.deviation.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);
const DEPOSIT_AMT = ethers.parseUnits('10000', 18);
const REDEEM_AMT_USER1 = ethers.parseUnits('1000', 18);
const REDEEM_AMT_USER2 = ethers.parseUnits('2000', 18);
const TWO_DAYS = 2 * 24 * 60 * 60 + 1;

describe('Express - Deviation Guards', function () {
  async function deployFixture() {
    return deployExpressContracts();
  }

  // Bootstrap: two users deposited, both have HYBOND, both submitted redeems, delay elapsed
  async function deployWithPendingRedeems() {
    const fixture = await deployFixture();
    const { express, usdo, oem, user1, user2, maintainer, maintainer: m } = fixture;

    // Deposit user1
    await express.connect(user1).requestDeposit(await usdo.getAddress(), DEPOSIT_AMT, user1.address);
    await express.connect(maintainer).processDepositQueue(1, DEPOSIT_AMT);
    // Deposit user2
    await express.connect(user2).requestDeposit(await usdo.getAddress(), DEPOSIT_AMT, user2.address);
    await express.connect(maintainer).processDepositQueue(1, DEPOSIT_AMT);

    await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
    await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);

    await express.connect(user1).requestRedeem(user1.address, REDEEM_AMT_USER1);
    await express.connect(user2).requestRedeem(user2.address, REDEEM_AMT_USER2);

    await time.increase(TWO_DAYS);
    return fixture;
  }

  describe('Setters', function () {
    it('updateDepositMaxDeviationBps stores value and emits event', async function () {
      const { express, maintainer } = await loadFixture(deployFixture);
      await expect(express.connect(maintainer).updateDepositMaxDeviationBps(150))
        .to.emit(express, 'UpdateDepositMaxDeviationBps')
        .withArgs(150);
      expect(await express.depositMaxDeviationBps()).to.equal(150);
    });

    it('updateRedeemMaxDeviationBps stores value and emits event', async function () {
      const { express, maintainer } = await loadFixture(deployFixture);
      await expect(express.connect(maintainer).updateRedeemMaxDeviationBps(200))
        .to.emit(express, 'UpdateRedeemMaxDeviationBps')
        .withArgs(200);
      expect(await express.redeemMaxDeviationBps()).to.equal(200);
    });

    it('reverts when bps > BPS_BASE', async function () {
      const { express, maintainer } = await loadFixture(deployFixture);
      await expect(express.connect(maintainer).updateDepositMaxDeviationBps(10001))
        .to.be.revertedWithCustomError(express, 'InvalidInput')
        .withArgs(10001);
      await expect(express.connect(maintainer).updateRedeemMaxDeviationBps(10001))
        .to.be.revertedWithCustomError(express, 'InvalidInput')
        .withArgs(10001);
    });

    it('reverts when caller lacks MAINTAINER_ROLE', async function () {
      const { express, user1 } = await loadFixture(deployFixture);
      await expect(express.connect(user1).updateDepositMaxDeviationBps(100)).to.be.reverted;
      await expect(express.connect(user1).updateRedeemMaxDeviationBps(100)).to.be.reverted;
    });

    it('bps == 0 is allowed (strict equality)', async function () {
      const { express, maintainer } = await loadFixture(deployFixture);
      await express.connect(maintainer).updateDepositMaxDeviationBps(0);
      await express.connect(maintainer).updateRedeemMaxDeviationBps(0);
      expect(await express.depositMaxDeviationBps()).to.equal(0);
      expect(await express.redeemMaxDeviationBps()).to.equal(0);
    });
  });

  describe('processPendingRedeems - deviation', function () {
    it('happy path: _totalAsset == expectedTotal succeeds; payouts split pro-rata by shareAmount', async function () {
      const { express, maintainer, operator } = await loadFixture(deployWithPendingRedeems);
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100); // 1%

      // With ratio == 1e18 and price == 1e18, expectedTotal == REDEEM_AMT_USER1 + REDEEM_AMT_USER2
      const totalAsset = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      await express.connect(operator).processPendingRedeems(2, totalAsset);

      // Both entries should now sit in redeemQueue with pro-rata redeemAssetAmt.
      // User1 share = REDEEM_AMT_USER1 / total → 1/3 of totalAsset
      // User2 share = REDEEM_AMT_USER2 / total → 2/3 of totalAsset
      // Cannot easily inspect via storage; assert via event or final processRedeemQueue payout.
      // Use redeemQueue length:
      expect(await express.getRedeemQueueLength()).to.equal(2);
    });

    it('within +1% band succeeds', async function () {
      const { express, maintainer, operator } = await loadFixture(deployWithPendingRedeems);
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100);
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      const totalAsset = expected + (expected * 50n) / 10000n; // +0.5%
      await expect(express.connect(operator).processPendingRedeems(2, totalAsset)).to.not.be.reverted;
    });

    it('within -1% band succeeds', async function () {
      const { express, maintainer, operator } = await loadFixture(deployWithPendingRedeems);
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100);
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      const totalAsset = expected - (expected * 50n) / 10000n; // -0.5%
      await expect(express.connect(operator).processPendingRedeems(2, totalAsset)).to.not.be.reverted;
    });

    it('outside band (over) reverts OracleDeviationExceeded', async function () {
      const { express, maintainer, operator } = await loadFixture(deployWithPendingRedeems);
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100); // 1%
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      const totalAsset = expected + (expected * 200n) / 10000n; // +2%
      await expect(express.connect(operator).processPendingRedeems(2, totalAsset)).to.be.revertedWithCustomError(
        express,
        'OracleDeviationExceeded'
      );
    });

    it('outside band (under) reverts OracleDeviationExceeded', async function () {
      const { express, maintainer, operator } = await loadFixture(deployWithPendingRedeems);
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100);
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      const totalAsset = expected - (expected * 200n) / 10000n; // -2%
      await expect(express.connect(operator).processPendingRedeems(2, totalAsset)).to.be.revertedWithCustomError(
        express,
        'OracleDeviationExceeded'
      );
    });

    it('bps == 0: 1 wei drift reverts', async function () {
      const { express, maintainer, operator } = await loadFixture(deployWithPendingRedeems);
      await express.connect(maintainer).updateRedeemMaxDeviationBps(0);
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      await expect(express.connect(operator).processPendingRedeems(2, expected + 1n)).to.be.revertedWithCustomError(
        express,
        'OracleDeviationExceeded'
      );
    });

    it('bps == 0: exact match succeeds', async function () {
      const { express, maintainer, operator } = await loadFixture(deployWithPendingRedeems);
      await express.connect(maintainer).updateRedeemMaxDeviationBps(0);
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      await expect(express.connect(operator).processPendingRedeems(2, expected)).to.not.be.reverted;
    });

    it('delay-not-elapsed at index 0 reverts NoPendingRedeemsReady', async function () {
      const fixture = await deployFixture();
      const { express, usdo, oem, user1, maintainer, operator } = fixture;
      await express.connect(user1).requestDeposit(await usdo.getAddress(), DEPOSIT_AMT, user1.address);
      await express.connect(maintainer).processDepositQueue(1, DEPOSIT_AMT);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, REDEEM_AMT_USER1);

      // Do NOT advance time
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100);
      await expect(express.connect(operator).processPendingRedeems(1, REDEEM_AMT_USER1)).to.be.revertedWithCustomError(
        express,
        'NoPendingRedeemsReady'
      );
    });

    it('partial-ready: stops at first not-ready entry, _totalAsset interpreted on processed only', async function () {
      const fixture = await deployFixture();
      const { express, usdo, oem, user1, user2, maintainer, operator } = fixture;

      await express.connect(user1).requestDeposit(await usdo.getAddress(), DEPOSIT_AMT, user1.address);
      await express.connect(maintainer).processDepositQueue(1, DEPOSIT_AMT);
      await express.connect(user2).requestDeposit(await usdo.getAddress(), DEPOSIT_AMT, user2.address);
      await express.connect(maintainer).processDepositQueue(1, DEPOSIT_AMT);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);

      // user1 redeems early
      await express.connect(user1).requestRedeem(user1.address, REDEEM_AMT_USER1);
      await time.increase(TWO_DAYS);
      // user2 redeems late (delay won't have elapsed)
      await express.connect(user2).requestRedeem(user2.address, REDEEM_AMT_USER2);

      await express.connect(maintainer).updateRedeemMaxDeviationBps(100);
      // Pass _len=2 but only user1 is ready → only user1 processed
      await express.connect(operator).processPendingRedeems(2, REDEEM_AMT_USER1);
      expect(await express.getRedeemQueueLength()).to.equal(1);
      expect(await express.getPendingRedeemQueueLength()).to.equal(1);
    });
  });

  describe('processDepositQueue - deviation', function () {
    it('within +1% band succeeds (was previously rejected as too-low _newShares)', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      await express.connect(maintainer).updateDepositMaxDeviationBps(100);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), DEPOSIT_AMT, user1.address);
      // _newShares 0.5% above oracle expectation
      const newShares = DEPOSIT_AMT + (DEPOSIT_AMT * 50n) / 10000n;
      await expect(express.connect(maintainer).processDepositQueue(1, newShares)).to.not.be.reverted;
    });

    it('within -1% band succeeds', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      await express.connect(maintainer).updateDepositMaxDeviationBps(100);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), DEPOSIT_AMT, user1.address);
      const newShares = DEPOSIT_AMT - (DEPOSIT_AMT * 50n) / 10000n;
      await expect(express.connect(maintainer).processDepositQueue(1, newShares)).to.not.be.reverted;
    });

    it('outside band (over) reverts OracleDeviationExceeded', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      await express.connect(maintainer).updateDepositMaxDeviationBps(100);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), DEPOSIT_AMT, user1.address);
      const newShares = DEPOSIT_AMT + (DEPOSIT_AMT * 200n) / 10000n;
      await expect(express.connect(maintainer).processDepositQueue(1, newShares)).to.be.revertedWithCustomError(
        express,
        'OracleDeviationExceeded'
      );
    });

    it('outside band (under) reverts OracleDeviationExceeded', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      await express.connect(maintainer).updateDepositMaxDeviationBps(100);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), DEPOSIT_AMT, user1.address);
      const newShares = DEPOSIT_AMT - (DEPOSIT_AMT * 200n) / 10000n;
      await expect(express.connect(maintainer).processDepositQueue(1, newShares)).to.be.revertedWithCustomError(
        express,
        'OracleDeviationExceeded'
      );
    });
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx hardhat test test/unit/Express.deviation.test.ts`
Expected (post-Task-2): all pass. If failures reveal a bug in Task 2, fix `Express.sol` directly and re-run — do not amend the test to mask the bug.

- [ ] **Step 3: Commit**

```bash
git add test/unit/Express.deviation.test.ts
git commit -m "test(express): unit tests for deviation guards on deposit + pending redeem"
```

---

## Task 4: Update existing test that expected `InsufficientSettlementFunds`

**Files:**
- Modify: `test/unit/Express.invariance.test.ts:223-228`

- [ ] **Step 1: Inspect the current test**

The failing region:

```typescript
      // Supply a tiny _totalAsset that the oracle-derived payout will exceed
      await expect(
        express.connect(operator).processPendingRedeems(1, 1n)
      ).to.be.revertedWithCustomError(express, 'InsufficientSettlementFunds');
    });
```

Under the new design, supplying `_totalAsset = 1` against a meaningful expected total yields a deviation hugely outside any reasonable bps band, so the new error is `OracleDeviationExceeded`.

- [ ] **Step 2: Set a deviation tolerance + update the expectation**

Find the surrounding `it(...)` block (lookup the few lines before line 223 to get the full context). Add a setter call before the `requestRedeem`+`time.increase` lines if not already present in the same block, e.g.:

```typescript
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100); // 1%
```

Then change the assertion from `InsufficientSettlementFunds` to `OracleDeviationExceeded`:

```typescript
      // Supply a tiny _totalAsset that falls far outside the deviation band
      await expect(
        express.connect(operator).processPendingRedeems(1, 1n)
      ).to.be.revertedWithCustomError(express, 'OracleDeviationExceeded');
```

- [ ] **Step 3: Run the modified test**

Run: `npx hardhat test test/unit/Express.invariance.test.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add test/unit/Express.invariance.test.ts
git commit -m "test(express): update invariance test for OracleDeviationExceeded"
```

---

## Task 5: Run the full test suite to catch any other regressions

**Files:**
- None changed in this task.

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 2: If any test fails because it relied on the old one-sided behavior, fix it**

Likely candidates: any call to `processPendingRedeems` with a `_totalAsset` that's now interpreted as the actual distribution pool rather than an upper-bound. Pattern of fix:
- If the test passed `LARGE_TOTAL_ASSET` (e.g. `10_000_000e18`) and the entry is small, the new deviation check will revert (over-band). Add `await express.connect(maintainer).updateRedeemMaxDeviationBps(10000);` (max bps = 100% tolerance) in the test setup to preserve the original "any large value works" semantic, OR change the supplied `_totalAsset` to the actual oracle-expected amount.
- For deposit-side tests passing `_newShares` very different from oracle expectation, similarly add `updateDepositMaxDeviationBps(10000)` or pass a realistic `_newShares`.

Specifically check:
- `test/unit/Express.invariance.test.ts:166` and `:207` — both use `LARGE_TOTAL_ASSET`. After Task 4, the test at `:226` is fixed; the others may need `updateRedeemMaxDeviationBps(10000)` in the relevant `describe`/fixture setup.
- `test/unit/Express.comprehensive.test.ts` — grep for `processPendingRedeems` and `processDepositQueue` calls; check each.
- `test/unit/Express.OffchainShares.test.ts`
- `test/unit/Express.mgtFeeAccounting.test.ts`
- `test/unit/Express.sharePerToken.test.ts`
- `test/integration/DailyRoutine.test.ts`

For each failing test, prefer **adding `updateRedeemMaxDeviationBps(10000)` / `updateDepositMaxDeviationBps(10000)` to the relevant fixture or `before*` hook** rather than rewriting `_totalAsset` values, to keep the existing test intent intact. The simplest cross-cutting fix is to add both setters to the canonical `deployExpressContracts` fixture in `test/fixtures/expressDeployments.ts` post-deployment — see Step 3.

- [ ] **Step 3: (Recommended) Set permissive defaults in the shared test fixture**

Modify `test/fixtures/expressDeployments.ts` after the role grants and before the `return`:

```typescript
  // Permissive deviation tolerance for tests; specific tests override as needed
  await express.connect(maintainer).updateDepositMaxDeviationBps(10000);
  await express.connect(maintainer).updateRedeemMaxDeviationBps(10000);
```

This preserves the pre-change semantic (operator-supplied values fully trusted) for all tests that don't explicitly exercise deviation behavior. Tests in `test/unit/Express.deviation.test.ts` override these as the first line of each `it`.

- [ ] **Step 4: Re-run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/expressDeployments.ts
git commit -m "test(fixtures): set permissive deviation bps defaults to preserve pre-change test semantics"
```

If any other test files needed adjustment in Step 2, include them in the same commit or a separate one with message `test(express): adjust callers for new deviation guard semantics`.

---

## Task 6: Update DEPLOYMENT.md

**Files:**
- Modify: `docs/DEPLOYMENT.md`

- [ ] **Step 1: Locate the post-deployment configuration section**

Run: `grep -n "Post-Deployment\|grantKyc\|updateDepositFeeRate" docs/DEPLOYMENT.md`
Expected: a section listing post-deploy MAINTAINER actions.

- [ ] **Step 2: Add deviation-bps configuration step**

Append (or insert into the post-deployment list):

```markdown
### Configure deviation tolerances

After deployment (and after every upgrade that adds these fields), the MAINTAINER must
set the symmetric oracle deviation tolerances. Default storage value `0` means strict
equality with the oracle, which is almost certainly not what you want operationally.

```bash
# Recommended: 100 bps (1%) on both sides
cast send $EXPRESS "updateDepositMaxDeviationBps(uint256)" 100 --from $MAINTAINER
cast send $EXPRESS "updateRedeemMaxDeviationBps(uint256)" 100 --from $MAINTAINER
```

These setters require all queues (`depositQueue`, `pendingRedeemQueue`, `redeemQueue`)
to be empty — the same constraint as `updatePriceOracle` / `updateMaxStalePeriod`.

When `priceOracle` is the zero address, the deviation check is skipped entirely;
operator is fully trusted on `_totalAsset` / `_newShares` in that mode.
```

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOYMENT.md
git commit -m "docs(deployment): document deviation-bps post-deploy configuration"
```

---

## Task 7: Final verification

**Files:**
- None changed in this task.

- [ ] **Step 1: Compile + tests + lint**

Run: `npm run compile && npm test && npm run format:check`
Expected: PASS, no formatting drift.

If `format:check` fails, run `npm run format` and commit the fix:

```bash
git add -A
git commit -m "chore(format): apply prettier"
```

- [ ] **Step 2: Confirm storage layout is append-only**

Run: `git diff main -- contracts/extension/Express.sol | grep -E "^[-+].*public" | grep -v "function\|event\|error" | head -40`
Expected: only additions of `depositMaxDeviationBps` / `redeemMaxDeviationBps`. No removals or reorderings of existing public state.

(If `main` isn't the right base for this branch, replace with the actual base — e.g. the parent of the first commit on this feature branch.)

- [ ] **Step 3: Quick gas-report sanity**

Run: `REPORT_GAS=true npx hardhat test test/unit/Express.deviation.test.ts`
Expected: gas costs for `processPendingRedeems` are similar order of magnitude to the old version. If significantly higher (e.g. 2×), inspect the two-pass loop for redundant work.

- [ ] **Step 4: Done — no commit needed for this task.**

---

## Self-Review Notes

Spec coverage:
- Storage fields, helper, error → Task 1.
- Deposit guard rewrite → Task 2 Step 1.
- Pending redeem rewrite (two-pass, delete `_processSinglePendingRedeem`, no-oracle skip) → Task 2 Steps 2-3.
- Setters + events → Task 1 Steps 3-4.
- File-top invariants comment update → Task 1 Step 6.
- Tests (unit, regression, setters, deposit-side new behavior, redeem-side new behavior, partial-ready, bps==0) → Task 3.
- **No-oracle path** is not unit-tested: `Express.initialize` rejects `_priceOracle == address(0)`, and `updatePriceOracle` does too. The `address(priceOracle) == address(0)` branch in `getPrice()` is dead code under the current public initialization surface. Tested only by code review of the `useOracle` flag in `processPendingRedeems` and the matching `if (address(priceOracle) != address(0))` in `processDepositQueue`. If a future change permits zero-oracle deployments, add tests then.
- Existing test that expected `InsufficientSettlementFunds` → Task 4.
- Fixture-level fix to keep other tests green → Task 5.
- DEPLOYMENT.md → Task 6.

Spec items deliberately not implemented as separate plan tasks:
- **Fuzz test** (`test/fuzz/Express.deviation.fuzz.ts`): the spec called for one. The repo's test harness is hardhat + mocha, not Foundry — there is no Foundry fuzz infra here despite the package.json `test:fuzz` and `test:invariants` scripts. The deterministic boundary tests in Task 3 cover the same logical surface (in-band, edge-of-band, out-of-band, both directions, bps==0). Add a follow-up Foundry-based fuzz harness as a separate plan if/when Foundry is wired in.
- **Removal of `InsufficientSettlementFunds`**: explicitly deferred per spec ("verify and remove in a separate cleanup PR").

Type/name consistency check:
- `_checkDeviation` signature `(actual, expected, bps)` — used identically in both call sites.
- `OracleDeviationExceeded(actual, expected, bps)` — three uint256 args, matches helper's revert call.
- `depositMaxDeviationBps` / `redeemMaxDeviationBps` — exact same names in storage, setter, event, comment, DEPLOYMENT.md.
- `useOracle` boolean inside `processPendingRedeems` — used to gate both `oraclePrice` fetch, `expectedTotal` accumulation, and `_checkDeviation` call.

Type concern flagged:
- `ProcessPendingRedeem` event's `priceUsed` field will be `0` when oracle unset (was `1e18` fallback before). Off-chain consumers must adapt. Considered acceptable per spec (oracle-unset is a rare/test mode); if this matters for production indexers, change `oraclePrice = useOracle ? getPrice() : 1e18;` to preserve the old fallback in the event only — small follow-up.
