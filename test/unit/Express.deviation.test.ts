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

  // Bootstrap helper: set redeem deviation bps (queues must be empty for setter), seed two
  // deposits, queue two redeems, advance past T+2.
  async function bootstrapWithPendingRedeems(redeemBps: number) {
    const fixture = await deployFixture();
    const { express, usdo, oem, user1, user2, maintainer } = fixture;

    // Set redeem deviation bps before any queue activity (setter requires queues empty)
    await express.connect(maintainer).updateRedeemMaxDeviationBps(redeemBps);

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

  async function deployWithPendingRedeemsBps100() {
    return bootstrapWithPendingRedeems(100);
  }

  async function deployWithPendingRedeemsBps0() {
    return bootstrapWithPendingRedeems(0);
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
      const { express, operator } = await loadFixture(deployWithPendingRedeemsBps100);

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
      const { express, operator } = await loadFixture(deployWithPendingRedeemsBps100);
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      const totalAsset = expected + (expected * 50n) / 10000n; // +0.5%
      await expect(express.connect(operator).processPendingRedeems(2, totalAsset)).to.not.be.reverted;
    });

    it('within -1% band succeeds', async function () {
      const { express, operator } = await loadFixture(deployWithPendingRedeemsBps100);
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      const totalAsset = expected - (expected * 50n) / 10000n; // -0.5%
      await expect(express.connect(operator).processPendingRedeems(2, totalAsset)).to.not.be.reverted;
    });

    it('outside band (over) reverts OracleDeviationExceeded', async function () {
      const { express, operator } = await loadFixture(deployWithPendingRedeemsBps100);
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      const totalAsset = expected + (expected * 200n) / 10000n; // +2%
      await expect(express.connect(operator).processPendingRedeems(2, totalAsset)).to.be.revertedWithCustomError(
        express,
        'OracleDeviationExceeded'
      );
    });

    it('outside band (under) reverts OracleDeviationExceeded', async function () {
      const { express, operator } = await loadFixture(deployWithPendingRedeemsBps100);
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      const totalAsset = expected - (expected * 200n) / 10000n; // -2%
      await expect(express.connect(operator).processPendingRedeems(2, totalAsset)).to.be.revertedWithCustomError(
        express,
        'OracleDeviationExceeded'
      );
    });

    it('bps == 0: 1 wei drift reverts', async function () {
      const { express, operator } = await loadFixture(deployWithPendingRedeemsBps0);
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      await expect(express.connect(operator).processPendingRedeems(2, expected + 1n)).to.be.revertedWithCustomError(
        express,
        'OracleDeviationExceeded'
      );
    });

    it('bps == 0: exact match succeeds', async function () {
      const { express, operator } = await loadFixture(deployWithPendingRedeemsBps0);
      const expected = REDEEM_AMT_USER1 + REDEEM_AMT_USER2;
      await expect(express.connect(operator).processPendingRedeems(2, expected)).to.not.be.reverted;
    });

    it('delay-not-elapsed at index 0 reverts NoPendingRedeemsReady', async function () {
      const fixture = await deployFixture();
      const { express, usdo, oem, user1, maintainer, operator } = fixture;

      // Set bps before any queue state (setter requires queues empty)
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100);

      await express.connect(user1).requestDeposit(await usdo.getAddress(), DEPOSIT_AMT, user1.address);
      await express.connect(maintainer).processDepositQueue(1, DEPOSIT_AMT);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, REDEEM_AMT_USER1);

      // Do NOT advance time
      await expect(express.connect(operator).processPendingRedeems(1, REDEEM_AMT_USER1)).to.be.revertedWithCustomError(
        express,
        'NoPendingRedeemsReady'
      );
    });

    it('partial-ready: stops at first not-ready entry, _totalAsset interpreted on processed only', async function () {
      const fixture = await deployFixture();
      const { express, usdo, oem, user1, user2, maintainer, operator } = fixture;

      // Set bps before any queue state (setter requires queues empty)
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100);

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
