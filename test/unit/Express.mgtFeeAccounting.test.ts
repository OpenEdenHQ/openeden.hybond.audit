import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);
const LARGE_TOTAL_ASSET = ethers.parseUnits('10000000', 18);

describe('Express - Management Fee Accounting (spreadsheet simulation)', function () {
  it('sharesPerToken and circulatingSupply behave correctly across fee accrual + fee redeem cycle', async function () {
    // 1. Arrange
    const { express, oem, usdo, maintainer, operator, treasury, user1 } =
      await loadFixture(deployExpressContracts);

    // 10% annual fee: large enough that 3 days of accrual exceed the 50 OEM redeemMinimum
    // from the fixture (100000 * 0.10 / 365 ~= 27.4 OEM/day, 3 days ~= 82.2 OEM > 50).
    await express.connect(maintainer).updateMgtFeeRate(1000);

    const depositAmount = 100000n * ONE;
    const timeBuffer = await express.timeBuffer();

    // 2. Day 1 — user1 deposits 100000 USDO and the deposit queue is processed.
    await express
      .connect(user1)
      .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
    await express.connect(maintainer).processDepositQueue(1, depositAmount);

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

    // mgtFeeTo requestRedeem with amount 0 (overridden to totalMgtFeeUnclaimed)
    await express.connect(treasury).requestRedeem(treasury.address, 0);

    // totalMgtFeeUnclaimed zeroed immediately at request time
    expect(await express.totalMgtFeeUnclaimed()).to.equal(0n);

    // Advance past T+2.
    await time.increase(2n * 24n * 60n * 60n);

    // Capture the ratio right before processPendingRedeems.
    const ratioBeforePending = await express.sharesPerToken();

    // Process pending -> final queue.
    await express.connect(operator).processPendingRedeems(1, LARGE_TOTAL_ASSET);

    // Ratio unchanged after pending->final (invariance)
    expect(await express.sharesPerToken()).to.equal(ratioBeforePending);
    expect(await express.totalMgtFeeUnclaimed()).to.equal(0n);

    // Process final queue (burn).
    await express.connect(operator).processRedeemQueue(1);

    // Ratio unchanged after burn (invariance)
    expect(await express.sharesPerToken()).to.equal(ratioBeforePending);
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

  it('mgtFeeTo cannot double-redeem', async function () {
    const { express, oem, usdo, maintainer, operator, treasury, user1 } =
      await loadFixture(deployExpressContracts);

    await express.connect(maintainer).updateMgtFeeRate(1000);
    const depositAmount = 100000n * ONE;

    await express
      .connect(user1)
      .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
    await express.connect(maintainer).processDepositQueue(1, depositAmount);

    // Accrue fees
    const timeBuffer = await express.timeBuffer();
    await time.increase(timeBuffer);
    await express.connect(operator).updateEpoch();

    const feeBalance = await express.totalMgtFeeUnclaimed();
    expect(feeBalance).to.be.gt(0n);

    // user1 transfers some tokens to treasury (accidental non-fee shares)
    await oem.connect(user1).transfer(treasury.address, ethers.parseUnits('1000', 18));

    await oem.connect(treasury).approve(await express.getAddress(), ethers.MaxUint256);

    // First requestRedeem succeeds — zeroes totalMgtFeeUnclaimed
    await express.connect(treasury).requestRedeem(treasury.address, 0);
    expect(await express.totalMgtFeeUnclaimed()).to.equal(0n);

    // Second requestRedeem MUST revert — totalMgtFeeUnclaimed is now 0
    await expect(
      express.connect(treasury).requestRedeem(treasury.address, 0)
    ).to.be.revertedWithCustomError(express, 'InvalidAmount');
  });

  it('cancelPendingRedeem restores totalMgtFeeUnclaimed for mgtFeeTo entries', async function () {
    const { express, oem, usdo, maintainer, operator, treasury, user1 } =
      await loadFixture(deployExpressContracts);

    await express.connect(maintainer).updateMgtFeeRate(1000);
    const depositAmount = 100000n * ONE;

    await express
      .connect(user1)
      .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
    await express.connect(maintainer).processDepositQueue(1, depositAmount);

    const timeBuffer = await express.timeBuffer();
    await time.increase(timeBuffer);
    await express.connect(operator).updateEpoch();

    const totalFees = await express.totalMgtFeeUnclaimed();

    await oem.connect(treasury).approve(await express.getAddress(), ethers.MaxUint256);
    await express.connect(treasury).requestRedeem(treasury.address, 0);
    expect(await express.totalMgtFeeUnclaimed()).to.equal(0n);

    // Cancel restores
    await express.connect(maintainer).cancelPendingRedeem(1);
    expect(await express.totalMgtFeeUnclaimed()).to.equal(totalFees);
  });

  it('blocks mgtFeeTo rotation while live management fees are unclaimed', async function () {
    const { express, usdo, maintainer, operator, user1, user2 } =
      await loadFixture(deployExpressContracts);

    await express.connect(maintainer).updateMgtFeeRate(1000);
    const depositAmount = 100000n * ONE;

    await express
      .connect(user1)
      .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
    await express.connect(maintainer).processDepositQueue(1, depositAmount);

    const timeBuffer = await express.timeBuffer();
    await time.increase(timeBuffer);
    await express.connect(operator).updateEpoch();

    expect(await express.totalMgtFeeUnclaimed()).to.be.gt(0n);
    await expect(
      express.connect(maintainer).updateMgtFeeTo(user2.address)
    ).to.be.revertedWithCustomError(express, 'InvalidAmount');
  });
});
