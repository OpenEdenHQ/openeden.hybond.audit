import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts, expectedRedeemAssetTotal } from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);
const DEPOSIT_A = ethers.parseUnits('10000', 18);
const DEPOSIT_B = ethers.parseUnits('5000', 18);
const DEPOSIT_C = ethers.parseUnits('2000', 18);
const ONE_DAY = 24 * 60 * 60;

describe('Daily Routine — end-to-end integration', function () {
  async function deployFixture() {
    const base = await deployExpressContracts();

    // Enable 1% annual management fee
    await base.express.connect(base.maintainer).updateMgtFeeRate(100);

    // Zero time buffer so updateEpoch never reverts UpdateTooEarly in tests
    await base.express.connect(base.maintainer).updateTimeBuffer(0);

    return base;
  }

  // Shared mutable state threaded across the three day-blocks via a single loadFixture call.
  // Each `it` mutates blockchain state via `time.increase` — these must run in order.
  let ctx: Awaited<ReturnType<typeof deployFixture>>;
  let mgtFeeDay0: bigint;
  let mgtFeeDay1: bigint;

  // Approvals and bookkeeping used across days
  let user1RedeemShares: bigint;
  let user1HybondBefore: bigint; // balance before requestRedeem on Day 1

  before(async function () {
    ctx = await loadFixture(deployFixture);
    const { express, oem } = ctx;
    await oem.connect(ctx.user1).approve(await express.getAddress(), ethers.MaxUint256);
    await oem.connect(ctx.user2).approve(await express.getAddress(), ethers.MaxUint256);
    await oem.connect(ctx.user3).approve(await express.getAddress(), ethers.MaxUint256);
    await oem.connect(ctx.treasury).approve(await express.getAddress(), ethers.MaxUint256);
  });

  describe('Day 0 — bootstrap and first epoch', function () {
    it('user A and user B both request deposits', async function () {
      const { express, usdo, user1, user2 } = ctx;
      const usdoAddr = await usdo.getAddress();

      // Both users request deposits while totalSupply == 0 (bootstrap window)
      await express.connect(user1).requestDeposit(usdoAddr, DEPOSIT_A, user1.address);
      await express.connect(user2).requestDeposit(usdoAddr, DEPOSIT_B, user2.address);

      expect(await express.getDepositQueueLength()).to.equal(2n);
    });

    it('step 1: processDepositQueue(2, totalNewShares) mints for users A and B', async function () {
      const { express, oem, maintainer, user1, user2 } = ctx;

      // Before bootstrap, ratio fallback == 1e18 (totalSupply == 0)
      expect(await express.sharesPerToken()).to.equal(ONE);

      // Process both deposits in one batch
      const totalNewShares = DEPOSIT_A + DEPOSIT_B;
      await express.connect(maintainer).processDepositQueue(2, totalNewShares);

      expect(await oem.balanceOf(user1.address)).to.be.gt(0n);
      expect(await oem.balanceOf(user2.address)).to.be.gt(0n);
      expect(await express.getDepositQueueLength()).to.equal(0n);
      // offchainShares automatically set
      expect(await express.offchainShares()).to.equal(totalNewShares);
    });

    it('step 2: ratio == 1e18 after bootstrap deposit', async function () {
      const { express } = ctx;
      expect(await express.sharesPerToken()).to.equal(ONE);
    });

    it('step 3: updateEpoch mints daily fee', async function () {
      const { express, oem, operator, treasury } = ctx;

      const treasuryBefore = await oem.balanceOf(treasury.address);
      await express.connect(operator).updateEpoch();
      mgtFeeDay0 = (await oem.balanceOf(treasury.address)) - treasuryBefore;

      expect(mgtFeeDay0).to.be.gt(0n);
      expect(await express.totalMgtFeeUnclaimed()).to.equal(mgtFeeDay0);
    });

    it('end-of-day assertions: balances non-zero, ratio near 1e18, unclaimed > 0', async function () {
      const { express, oem, user1, user2 } = ctx;

      expect(await oem.balanceOf(user1.address)).to.be.gt(0n);
      expect(await oem.balanceOf(user2.address)).to.be.gt(0n);

      const ratio = await express.sharesPerToken();
      expect(ratio).to.be.lte(ONE);
      expect(ratio).to.be.gte((ONE * 9999n) / 10000n);

      expect(await express.totalMgtFeeUnclaimed()).to.be.gt(0n);
    });
  });

  describe('Day 1 — user A redeems half; user C deposits; no redeem ready yet', function () {
    it('advance time by 24 hours', async function () {
      await time.increase(ONE_DAY);
    });

    it('user A requests redeem for half her shares', async function () {
      const { express, oem, user1 } = ctx;

      user1HybondBefore = await oem.balanceOf(user1.address);
      user1RedeemShares = user1HybondBefore / 2n;

      await express.connect(user1).requestRedeem(user1.address, user1RedeemShares);

      expect(await oem.balanceOf(user1.address)).to.equal(user1HybondBefore - user1RedeemShares);
    });

    it('user C requests deposit', async function () {
      const { express, usdo, user3 } = ctx;
      await express
        .connect(user3)
        .requestDeposit(await usdo.getAddress(), DEPOSIT_C, user3.address);
      expect(await express.getDepositQueueLength()).to.equal(1n);
    });

    it('step 1: processDepositQueue(1, newShares) mints for user C', async function () {
      const { express, oem, maintainer, user3 } = ctx;

      await express.connect(maintainer).processDepositQueue(1, DEPOSIT_C);

      expect(await oem.balanceOf(user3.address)).to.be.gt(0n);
    });

    it('step 2: updateEpoch mints another daily fee', async function () {
      const { express, oem, operator, treasury } = ctx;

      const treasuryBefore = await oem.balanceOf(treasury.address);
      await express.connect(operator).updateEpoch();
      const dayFee = (await oem.balanceOf(treasury.address)) - treasuryBefore;
      mgtFeeDay1 = await express.totalMgtFeeUnclaimed();

      expect(dayFee).to.be.gt(0n);
      expect(mgtFeeDay1).to.be.gt(mgtFeeDay0);
    });

    it('step 3: processPendingRedeems reverts NoPendingRedeemsReady (delay not elapsed)', async function () {
      const { express, operator } = ctx;

      await expect(
        express.connect(operator).processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1))
      ).to.be.revertedWithCustomError(express, 'NoPendingRedeemsReady');
    });

    it('step 4: processRedeemQueue reverts EmptyQueue (nothing in final queue)', async function () {
      const { express, operator } = ctx;

      await expect(express.connect(operator).processRedeemQueue(0)).to.be.revertedWithCustomError(
        express,
        'EmptyQueue'
      );
    });

    it('end-of-day: user A HYBOND balance unchanged (redeem not settled)', async function () {
      const { oem, user1 } = ctx;
      // Tokens were transferred to Express at requestRedeem; balance = before - redeemShares
      expect(await oem.balanceOf(user1.address)).to.equal(user1HybondBefore - user1RedeemShares);
    });
  });

  describe('Day 2 — T+2 elapsed; user A redeem settles', function () {
    it('advance time by 48 hours (T+2 from request on Day 1)', async function () {
      await time.increase(ONE_DAY * 2);
    });

    it('step 1: no deposits today (queue empty)', async function () {
      const { express } = ctx;
      expect(await express.getDepositQueueLength()).to.equal(0n);
    });

    it('step 2: updateEpoch mints another daily fee', async function () {
      const { express, operator } = ctx;

      await expect(express.connect(operator).updateEpoch()).to.not.be.reverted;

      // totalMgtFeeUnclaimed grows monotonically
      expect(await express.totalMgtFeeUnclaimed()).to.be.gt(mgtFeeDay1);
    });

    it('step 3: processPendingRedeems processes user A (T+2 elapsed)', async function () {
      const { express, operator } = ctx;

      const len = await express.getPendingRedeemQueueLength();
      await expect(
        express
          .connect(operator)
          .processPendingRedeems(len, await expectedRedeemAssetTotal(express, Number(len)))
      ).to.emit(express, 'ProcessPendingRedeem');

      expect(await express.getPendingRedeemQueueLength()).to.equal(0n);
      expect(await express.getRedeemQueueLength()).to.equal(1n);
    });

    it('step 4: processRedeemQueue(0) burns tokens and pays user A USDO', async function () {
      const { express, usdo, oem, operator, user1 } = ctx;

      const user1UsdoBefore = await usdo.balanceOf(user1.address);
      const totalSupplyBefore = await oem.totalSupply();

      await expect(express.connect(operator).processRedeemQueue(0)).to.emit(
        express,
        'ProcessRedeem'
      );

      const user1UsdoAfter = await usdo.balanceOf(user1.address);
      const totalSupplyAfter = await oem.totalSupply();

      // User A received USDO
      expect(user1UsdoAfter).to.be.gt(user1UsdoBefore);

      // Token supply decreased by the redeemed share amount
      expect(totalSupplyAfter).to.be.lt(totalSupplyBefore);

      expect(await express.getRedeemQueueLength()).to.equal(0n);
    });

    it('end-of-day: user A USDO increased, both queues empty, totalMgtFeeUnclaimed monotonic', async function () {
      const { express, usdo, oem, user1 } = ctx;

      const startingUsdo = ethers.parseUnits('100000', 18);
      const user1Usdo = await usdo.balanceOf(user1.address);
      expect(user1Usdo).to.be.gt(startingUsdo - DEPOSIT_A);

      // Both queues empty
      expect(await express.getPendingRedeemQueueLength()).to.equal(0n);
      expect(await express.getRedeemQueueLength()).to.equal(0n);

      // totalMgtFeeUnclaimed is strictly greater than Day 1 snapshot
      expect(await express.totalMgtFeeUnclaimed()).to.be.gt(mgtFeeDay1);

      // User A's HYBOND reduced by redeem amount (shares were burned)
      const user1Oem = await oem.balanceOf(user1.address);
      expect(user1Oem).to.equal(user1HybondBefore - user1RedeemShares);
    });
  });
});
