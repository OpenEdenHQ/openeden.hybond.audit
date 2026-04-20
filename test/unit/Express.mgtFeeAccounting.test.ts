import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import {
  bootstrapAndSeedOffchainShares,
  deployExpressContracts,
} from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);

describe('Express - Management Fee Accounting (spreadsheet simulation)', function () {
  it('sharesPerToken and circulatingSupply behave correctly across fee accrual + fee redeem cycle', async function () {
    // 1. Arrange
    const { express, oem, usdo, maintainer, operator, treasury, user1, admin } =
      await loadFixture(deployExpressContracts);
    const signers = await ethers.getSigners();
    const confirmer = signers[10];

    // 10% annual fee: large enough that 3 days of accrual exceed the 50 OEM redeemMinimum
    // from the fixture (100000 * 0.10 / 365 ~= 27.4 OEM/day, 3 days ~= 82.2 OEM > 50).
    await express.connect(maintainer).updateMgtFeeRate(1000);

    const depositAmount = 100000n * ONE;
    const timeBuffer = await express.timeBuffer();

    // 2. Day 1 — user1 deposits 100000 USDO and the deposit queue is processed.
    await express
      .connect(user1)
      .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
    await express.connect(maintainer).processDepositQueue(1);

    // Seed offchainShares so sharesPerToken == 1e18 and subsequent redeems are unblocked.
    const CONFIRM_ROLE = await express.CONFIRM_ROLE();
    await express.connect(admin).grantRole(CONFIRM_ROLE, confirmer.address);
    const supplyAfterDeposit = await oem.totalSupply();
    await express.connect(operator).proposeOffchainShares(supplyAfterDeposit);
    await express.connect(confirmer).confirmOffchainShares(supplyAfterDeposit);

    expect(await oem.totalSupply()).to.equal(depositAmount);
    expect(await express.circulatingSupply()).to.equal(depositAmount);
    expect(await express.sharesPerToken()).to.equal(ONE);
    expect(await express.totalMgtFeeUnclaimed()).to.equal(0n);

    // 3. Day 2 — advance past timeBuffer, accrue first epoch fee.
    await time.increase(timeBuffer);
    const treasuryBalanceBeforeDay2 = await oem.balanceOf(treasury.address);
    await express.connect(operator).updateEpoch();
    const dailyFee = (await oem.balanceOf(treasury.address)) - treasuryBalanceBeforeDay2;

    expect(dailyFee).to.be.gt(0n);
    expect(await express.totalMgtFeeUnclaimed()).to.equal(dailyFee);
    expect(await express.circulatingSupply()).to.equal(depositAmount);

    // 4. Days 3-4 — two more updateEpoch calls with dynamic per-day capture.
    let totalFeesAccruedBeforeRedeem = dailyFee;
    for (let i = 0; i < 2; i++) {
      await time.increase(timeBuffer);
      const balBefore = await oem.balanceOf(treasury.address);
      await express.connect(operator).updateEpoch();
      const balAfter = await oem.balanceOf(treasury.address);
      totalFeesAccruedBeforeRedeem += balAfter - balBefore;
    }

    expect(await express.totalMgtFeeUnclaimed()).to.equal(totalFeesAccruedBeforeRedeem);
    expect(await express.circulatingSupply()).to.equal(depositAmount);

    // 5. Day 5 — treasury (mgtFeeTo) redeems all its fee balance.
    await oem.connect(treasury).approve(await express.getAddress(), ethers.MaxUint256);
    const feeBalance = await oem.balanceOf(treasury.address);
    expect(feeBalance).to.equal(totalFeesAccruedBeforeRedeem);

    await express.connect(treasury).requestRedeem(treasury.address, feeBalance);

    // Advance past T+2.
    await time.increase(2n * 24n * 60n * 60n);

    // Snapshot the pending-redeem ratio.
    await express.connect(operator).snapshotPendingRedeemRatio();

    // Capture the ratio right before processPendingRedeems.
    const ratioBeforePending = await express.sharesPerToken();

    // Process pending → final queue.
    await express.connect(operator).processPendingRedeems(1);

    // Invariant 2: after pending→final, redeem queue excludes the fee shares from denom,
    // restoring ratio to 1e18; unclaimed drops to 0.
    expect(await express.sharesPerToken()).to.equal(ONE);
    expect(await express.totalMgtFeeUnclaimed()).to.equal(0n);

    // Process final queue (burn).
    await express.connect(operator).processRedeemQueue(1);

    // Invariant 3: burn leaves ratio at 1e18 (fees burned, offchainShares == remaining totalSupply).
    expect(await express.sharesPerToken()).to.equal(ONE);
    expect(await express.totalMgtFeeUnclaimed()).to.equal(0n);
    expect(await express.circulatingSupply()).to.equal(depositAmount);
    expect(await oem.totalSupply()).to.equal(depositAmount);

    // 6. Days 6-7 — two more updateEpoch calls.
    let newFees = 0n;
    for (let i = 0; i < 2; i++) {
      await time.increase(timeBuffer);
      const balBefore = await oem.balanceOf(treasury.address);
      await express.connect(operator).updateEpoch();
      const balAfter = await oem.balanceOf(treasury.address);
      newFees += balAfter - balBefore;
    }

    expect(await express.totalMgtFeeUnclaimed()).to.equal(newFees);
    expect(await express.circulatingSupply()).to.equal(depositAmount);
    expect(await oem.totalSupply()).to.equal(depositAmount + newFees);
  });
});
