import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);
const DEPOSIT_A = ethers.parseUnits('10000', 18);
const DEPOSIT_B = ethers.parseUnits('5000', 18);
const DEPOSIT_C = ethers.parseUnits('2000', 18);
const ONE_DAY = 24 * 60 * 60;

describe('Daily Routine — end-to-end integration', function () {
  async function deployFixture() {
    const base = await deployExpressContracts();
    const signers = await ethers.getSigners();
    const confirmer = signers[10];

    const CONFIRM_ROLE = await base.express.CONFIRM_ROLE();
    await base.express.connect(base.admin).grantRole(CONFIRM_ROLE, confirmer.address);

    // Enable 1% annual management fee
    await base.express.connect(base.maintainer).updateMgtFeeRate(100);

    // Zero time buffer so updateEpoch never reverts UpdateTooEarly in tests
    await base.express.connect(base.maintainer).updateTimeBuffer(0);

    return { ...base, confirmer };
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

  // Helper: propose + confirm offchainShares equal to current totalSupply
  async function syncOffchainShares() {
    const { express, oem, operator, confirmer } = ctx;
    const supply = await oem.totalSupply();
    await express.connect(operator).proposeOffchainShares(supply);
    await express.connect(confirmer).confirmOffchainShares(supply);
  }

  describe('Day 0 — bootstrap and first epoch', function () {
    it('user A and user B both request deposits', async function () {
      const { express, usdo, user1, user2 } = ctx;
      const usdoAddr = await usdo.getAddress();

      // Both users request deposits while totalSupply == 0 (bootstrap window)
      await express.connect(user1).requestDeposit(usdoAddr, DEPOSIT_A, user1.address);
      await express.connect(user2).requestDeposit(usdoAddr, DEPOSIT_B, user2.address);

      expect(await express.getDepositQueueLength()).to.equal(2n);
    });

    it('step 1: processDepositQueue(1) mints for user A via bootstrap path', async function () {
      const { express, oem, maintainer, user1 } = ctx;

      // Before bootstrap, ratio fallback == 1e18 (totalSupply == 0)
      expect(await express.sharesPerToken()).to.equal(ONE);

      await express.connect(maintainer).processDepositQueue(1);

      expect(await oem.balanceOf(user1.address)).to.be.gt(0n);
      expect(await express.getDepositQueueLength()).to.equal(1n);
    });

    it('step 2: propose + confirm offchainShares (ratio = 1e18)', async function () {
      const { express } = ctx;

      await syncOffchainShares();

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

    it('step 4: processDepositQueue(1) mints for user B', async function () {
      const { express, oem, maintainer, user2 } = ctx;

      await express.connect(maintainer).processDepositQueue(1);

      expect(await oem.balanceOf(user2.address)).to.be.gt(0n);
      expect(await express.getDepositQueueLength()).to.equal(0n);
    });

    it('step 5: sync offchainShares to new totalSupply after B deposit', async function () {
      const { express } = ctx;
      await syncOffchainShares();

      // Ratio should still be close to 1e18 (one small epoch of dilution)
      const ratio = await express.sharesPerToken();
      expect(ratio).to.be.lte(ONE);
      // Within 0.01% of 1e18 (1% annual / 365 days << 0.01%)
      expect(ratio).to.be.gte((ONE * 9999n) / 10000n);
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

    it('step 1: processDepositQueue(1) mints for user C', async function () {
      const { express, oem, maintainer, user3 } = ctx;

      await express.connect(maintainer).processDepositQueue(1);

      expect(await oem.balanceOf(user3.address)).to.be.gt(0n);
    });

    it('step 2: sync offchainShares to new total', async function () {
      await syncOffchainShares();
    });

    it('step 3: updateEpoch mints another daily fee', async function () {
      const { express, oem, operator, treasury } = ctx;

      const treasuryBefore = await oem.balanceOf(treasury.address);
      await express.connect(operator).updateEpoch();
      const dayFee = (await oem.balanceOf(treasury.address)) - treasuryBefore;
      mgtFeeDay1 = await express.totalMgtFeeUnclaimed();

      expect(dayFee).to.be.gt(0n);
      expect(mgtFeeDay1).to.be.gt(mgtFeeDay0);
    });

    it('step 4: processPendingRedeems reverts NoPendingRedeemsReady (delay not elapsed)', async function () {
      const { express, operator } = ctx;

      // User A's pending entry is fresh — convertRedeemRequestsDelay hasn't elapsed, so
      // _processSinglePendingRedeem returns false and the outer loop reverts NoPendingRedeemsReady.
      await expect(
        express.connect(operator).processPendingRedeems(1)
      ).to.be.revertedWithCustomError(express, 'NoPendingRedeemsReady');
    });

    it('step 5: processRedeemQueue reverts EmptyQueue (nothing in final queue)', async function () {
      const { express, operator } = ctx;

      await expect(express.connect(operator).processRedeemQueue(0)).to.be.revertedWithCustomError(
        express,
        'EmptyQueue'
      );
    });

    it('step 6: snapshotPendingRedeemRatio snapshots user A entry', async function () {
      const { express, operator } = ctx;

      const ratioNow = await express.sharesPerToken();
      const len = await express.getPendingRedeemQueueLength();
      await express.connect(operator).snapshotPendingRedeemRatio(0, len);

      // Pending queue has 1 entry: user A's redeem
      expect(await express.getPendingRedeemQueueLength()).to.equal(1n);

      // Retrieve the pending ID from the queue front and check the snapshot
      const data = await express.getPendingRedeemQueueInfo(0);
      const pendingId = data[4]; // id is 5th field
      expect(await express.snapshotRatios(pendingId)).to.equal(ratioNow);
    });

    it('end-of-day: user A HYBOND balance unchanged (redeem not settled)', async function () {
      const { oem, user1 } = ctx;
      // Tokens were transferred to Express at requestRedeem; balance = before - redeemShares
      expect(await oem.balanceOf(user1.address)).to.equal(user1HybondBefore - user1RedeemShares);
    });
  });

  describe('Day 2 — T+2 elapsed; user A redeem settles', function () {
    it('advance time by 48 hours (T+2 from request on Day 1)', async function () {
      // User A's redeem was requested at Day 1. T+2 is operator-enforced (2 days).
      // Day 2 starts 24h after Day 1, so we need one more full day to clear T+2.
      await time.increase(ONE_DAY * 2);
    });

    it('step 1: processDepositQueue reverts EmptyQueue (no deposits today)', async function () {
      const { express, maintainer } = ctx;

      await expect(
        express.connect(maintainer).processDepositQueue(0)
      ).to.be.revertedWithCustomError(express, 'EmptyQueue');
    });

    it('step 2: no offchainShares sync needed (no deposits processed today)', async function () {
      // No new deposits were processed on Day 2, so totalSupply has not changed from new mints.
      // offchainShares remains consistent with the last confirmed value — no re-sync required.
      const { express } = ctx;
      expect(await express.offchainShares()).to.be.gt(0n);
    });

    it('step 3: updateEpoch mints another daily fee', async function () {
      const { express, operator } = ctx;

      await expect(express.connect(operator).updateEpoch()).to.not.be.reverted;

      // totalMgtFeeUnclaimed grows monotonically
      expect(await express.totalMgtFeeUnclaimed()).to.be.gt(mgtFeeDay1);
    });

    it('step 4: processPendingRedeems processes user A (T+2 elapsed)', async function () {
      const { express, operator } = ctx;

      const len = await express.getPendingRedeemQueueLength();
      await expect(express.connect(operator).processPendingRedeems(len)).to.emit(
        express,
        'ProcessPendingRedeem'
      );

      expect(await express.getPendingRedeemQueueLength()).to.equal(0n);
      expect(await express.getRedeemQueueLength()).to.equal(1n);
    });

    it('step 5: processRedeemQueue(0) burns tokens and pays user A USDO', async function () {
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

    it('step 6: snapshotPendingRedeemRatio reverts EmptyQueue (pending queue empty)', async function () {
      const { express, operator } = ctx;

      await expect(
        express.connect(operator).snapshotPendingRedeemRatio(0, 1)
      ).to.be.revertedWithCustomError(express, 'EmptyQueue');
    });

    it('end-of-day: user A USDO increased, both queues empty, totalMgtFeeUnclaimed monotonic', async function () {
      const { express, usdo, oem, user1 } = ctx;

      // User A's USDO went up (received redeemAsset net of fee)
      // We already verified the increase in step 5; just confirm final balance > initial
      const startingUsdo = ethers.parseUnits('100000', 18);
      const user1Usdo = await usdo.balanceOf(user1.address);
      // user1 started with 100k, deposited 10k, so should be around 90k + redeem proceeds
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
