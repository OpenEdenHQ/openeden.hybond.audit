import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import {
  deployExpressContracts,
  DEFAULT_MAX_STALE_PERIOD,
  expectedRedeemAssetTotal,
} from '../fixtures/expressDeployments';
// Mirror the contract's _trim: truncate 18-decimal value to given decimals (round down)
function trim(value: bigint, decimals: number): bigint {
  if (decimals === 0 || decimals >= 18) return value;
  const factor = 10n ** BigInt(18 - decimals);
  return (value / factor) * factor;
}
describe('Express - Comprehensive Tests', function () {
  const TRIM_DECIMALS = 3; // default trimDecimals used in tests
  // Helper to deploy fresh contracts for each test
  async function deployFixture() {
    const fixture = await deployExpressContracts();
    // Set trimDecimals to 3 as default for tests
    await fixture.express.connect(fixture.maintainer).updateTrimDecimals(TRIM_DECIMALS);
    return fixture;
  }
  describe('Deposit Flow', function () {
    describe('First Deposit Requirements', function () {
      it('should enforce first deposit minimum on initial mint', async function () {
        const { express, usdo, user1 } = await loadFixture(deployFixture);
        const firstDepositMin = await express.firstDepositAmount();
        const belowMin = firstDepositMin - ethers.parseUnits('1', 18);
        await expect(
          express.connect(user1).requestDeposit(await usdo.getAddress(), belowMin, user1.address)
        ).to.be.revertedWithCustomError(express, 'FirstDepositLessThanRequired');
      });
      it('should allow first deposit at exact minimum', async function () {
        const { express, usdo, user1 } = await loadFixture(deployFixture);
        const firstDepositMin = await express.firstDepositAmount();
        await expect(
          express
            .connect(user1)
            .requestDeposit(await usdo.getAddress(), firstDepositMin, user1.address)
        ).to.emit(express, 'AddToDepositQueue');
        expect(await express.firstDeposit(user1.address)).to.be.true; // Marked during request
      });
      it('should mark first deposit during deposit request', async function () {
        const { express, usdo, user1 } = await loadFixture(deployFixture);
        const firstDepositMin = await express.firstDepositAmount();
        expect(await express.firstDeposit(user1.address)).to.be.false;
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), firstDepositMin, user1.address);
        expect(await express.firstDeposit(user1.address)).to.be.true;
      });
      it('should enforce deposit minimum after first deposit', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, usdo, user1, maintainer } = fixture;
        // Make first deposit
        const firstDepositMin = await express.firstDepositAmount();
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), firstDepositMin, user1.address);
        await express.connect(maintainer).processDepositQueue(1, firstDepositMin);
        // Try to mint below minimum
        const mintMin = await express.depositMinimum();
        const belowMin = mintMin - ethers.parseUnits('1', 18);
        await expect(
          express.connect(user1).requestDeposit(await usdo.getAddress(), belowMin, user1.address)
        ).to.be.revertedWithCustomError(express, 'DepositLessThanMinimum');
      });
      it('should allow subsequent deposits at deposit minimum', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, usdo, user1, maintainer } = fixture;
        // Make first deposit
        const firstDepositMin = await express.firstDepositAmount();
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), firstDepositMin, user1.address);
        await express.connect(maintainer).processDepositQueue(1, firstDepositMin);
        // Mint at minimum
        const mintMin = await express.depositMinimum();
        await expect(
          express.connect(user1).requestDeposit(await usdo.getAddress(), mintMin, user1.address)
        ).to.emit(express, 'AddToDepositQueue');
      });
    });
    describe('Deposit Queue Processing', function () {
      it('should add deposit request to queue', async function () {
        const { express, usdo, user1 } = await loadFixture(deployFixture);
        const amount = ethers.parseUnits('1000', 18);
        const queueLengthBefore = await express.getDepositQueueLength();
        await expect(
          express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address)
        ).to.emit(express, 'AddToDepositQueue');
        const queueLengthAfter = await express.getDepositQueueLength();
        expect(queueLengthAfter).to.equal(queueLengthBefore + 1n);
      });
      it('should process deposit queue in FIFO order', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, usdo, user1, user2, user3, maintainer, oem } = fixture;
        const amount = ethers.parseUnits('1000', 18);
        // Add requests in order: user1, user2, user3
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(user2).requestDeposit(await usdo.getAddress(), amount, user2.address);
        await express.connect(user3).requestDeposit(await usdo.getAddress(), amount, user3.address);
        // Process first request
        await express.connect(maintainer).processDepositQueue(1, amount);
        // User1 should have tokens, others should not
        expect(await oem.balanceOf(user1.address)).to.equal(amount);
        expect(await oem.balanceOf(user2.address)).to.equal(0);
        expect(await oem.balanceOf(user3.address)).to.equal(0);
        // Process user2
        await express.connect(maintainer).processDepositQueue(1, amount);
        expect(await oem.balanceOf(user2.address)).to.be.gt(0);
        // Process user3
        await express.connect(maintainer).processDepositQueue(1, amount);
        expect(await oem.balanceOf(user3.address)).to.be.gt(0);
      });
      it('should re-validate KYC during processing', async function () {
        const { express, usdo, user1, maintainer, whitelister, kycManager } =
          await loadFixture(deployFixture);
        const amount = ethers.parseUnits('1000', 18);
        // Add deposit request
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        // Revoke KYC
        await kycManager.connect(whitelister).revokeKycBulk([user1.address]);
        // Processing should revert
        await expect(
          express.connect(maintainer).processDepositQueue(1, amount)
        ).to.be.revertedWithCustomError(express, 'NotInKycList');
      });
      it('should transfer assets to treasury on mint', async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
        const amount = ethers.parseUnits('1000', 18);
        const treasuryAddress = await express.treasury();
        const treasuryBalanceBefore = await usdo.balanceOf(treasuryAddress);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, amount);
        const treasuryBalanceAfter = await usdo.balanceOf(treasuryAddress);
        expect(treasuryBalanceAfter).to.equal(treasuryBalanceBefore + amount);
      });
      it('should handle mint fees correctly', async function () {
        const { express, usdo, user1, operator, maintainer } = await loadFixture(deployFixture);
        // Set 1% mint fee (100 basis points)
        await express.connect(maintainer).updateDepositFeeRate(100);
        const amount = ethers.parseUnits('1000', 18);
        const expectedFee = (amount * 100n) / 10000n; // 1%
        const expectedNet = amount - expectedFee;
        const txFeeToAddress = await express.txFeeTo();
        const treasuryAddress = await express.treasury();
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, expectedNet);
        // Check fee went to txFeeTo
        expect(await usdo.balanceOf(txFeeToAddress)).to.equal(expectedFee);
        // Check net went to treasury
        expect(await usdo.balanceOf(treasuryAddress)).to.equal(expectedNet);
      });
    });
    describe('Deposit Pause Controls', function () {
      it('should prevent depositing when paused', async function () {
        const { express, usdo, user1, pauser } = await loadFixture(deployFixture);
        await express.connect(pauser).pauseDeposit();
        const amount = ethers.parseUnits('1000', 18);
        await expect(
          express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address)
        ).to.be.revertedWithCustomError(express, 'PausedDeposit1');
      });
      it('should allow depositing after unpause', async function () {
        const { express, usdo, user1, pauser } = await loadFixture(deployFixture);
        await express.connect(pauser).pauseDeposit();
        await express.connect(pauser).unpauseDeposit();
        const amount = ethers.parseUnits('1000', 18);
        await expect(
          express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address)
        ).to.emit(express, 'AddToDepositQueue');
      });
    });
    describe('Deposit Cancellation Guardrails', function () {
      it('should always escrow refund on cancelDeposit regardless of liquidity', async function () {
        const { express, usdo, user1, maintainer, operator } = await loadFixture(deployFixture);
        const amount = ethers.parseUnits('1000', 18);
        const startingLiquidity = await usdo.balanceOf(await express.getAddress());
        await express.connect(operator).offRamp(startingLiquidity);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        const usdoAddress = await usdo.getAddress();
        const userBalanceBefore = await usdo.balanceOf(user1.address);
        await expect(express.connect(maintainer).cancelDeposit(1))
          .to.emit(express, 'DepositEscrowIn')
          .withArgs(user1.address, usdoAddress, amount);
        expect(await usdo.balanceOf(user1.address)).to.equal(userBalanceBefore);
        expect(await express.depositEscrowBalance(user1.address, usdoAddress)).to.equal(amount);
        expect(await express.getDepositQueueLength()).to.equal(0);
      });
      it('should escrow refund with fees on cancelDeposit', async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
        const expressAddress = await express.getAddress();
        await express.connect(maintainer).updateDepositFeeRate(100);
        const amount = ethers.parseUnits('1000', 18);
        const feeAmt = (amount * 100n) / 10000n;
        const netAmt = amount - feeAmt;
        const userBalanceBefore = await usdo.balanceOf(user1.address);
        const usdoAddress = await usdo.getAddress();
        await express.connect(user1).requestDeposit(usdoAddress, amount, user1.address);
        await expect(express.connect(maintainer).cancelDeposit(1))
          .to.emit(express, 'DepositEscrowIn')
          .withArgs(user1.address, usdoAddress, amount);
        expect(await express.depositEscrowBalance(user1.address, usdoAddress)).to.equal(amount);
        expect(await express.getDepositQueueLength()).to.equal(0);
        expect(await express.depositInfo(user1.address, usdoAddress)).to.equal(0);
      });
      it('should escrow deposit assets when cancelling deposit for any user', async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        const userBalanceBefore = await usdo.balanceOf(user1.address);
        const usdoAddress = await usdo.getAddress();
        await expect(express.connect(maintainer).cancelDeposit(1))
          .to.emit(express, 'DepositEscrowIn')
          .withArgs(user1.address, usdoAddress, amount);
        expect(await usdo.balanceOf(user1.address)).to.equal(userBalanceBefore);
        expect(await express.depositEscrowBalance(user1.address, usdoAddress)).to.equal(amount);
        expect(await express.getDepositQueueLength()).to.equal(0);
      });
      it('should allow user to claim deposit escrow', async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).cancelDeposit(1);
        const usdoAddress = await usdo.getAddress();
        const userBalanceBefore = await usdo.balanceOf(user1.address);
        await expect(express.connect(user1).claimDepositEscrow(user1.address, usdoAddress))
          .to.emit(express, 'DepositEscrowOut')
          .withArgs(user1.address, usdoAddress, amount);
        expect(await usdo.balanceOf(user1.address)).to.equal(userBalanceBefore + amount);
        expect(await express.depositEscrowBalance(user1.address, usdoAddress)).to.equal(0);
      });
      it('should allow operator to claim deposit escrow on behalf of user', async function () {
        const { express, usdo, user1, maintainer, operator } = await loadFixture(deployFixture);
        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).cancelDeposit(1);
        const usdoAddress = await usdo.getAddress();
        const userBalanceBefore = await usdo.balanceOf(user1.address);
        await expect(express.connect(operator).claimDepositEscrow(user1.address, usdoAddress))
          .to.emit(express, 'DepositEscrowOut')
          .withArgs(user1.address, usdoAddress, amount);
        expect(await usdo.balanceOf(user1.address)).to.equal(userBalanceBefore + amount);
        expect(await express.depositEscrowBalance(user1.address, usdoAddress)).to.equal(0);
      });
      it('should revert claimDepositEscrow when no escrowed balance', async function () {
        const { express, usdo, user1 } = await loadFixture(deployFixture);
        await expect(
          express.connect(user1).claimDepositEscrow(user1.address, await usdo.getAddress())
        ).to.be.revertedWithCustomError(express, 'InvalidAmount');
      });
      it('should ignore _account param for non-operator callers on claimDepositEscrow', async function () {
        const { express, usdo, user1, user2, maintainer } = await loadFixture(deployFixture);
        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).cancelDeposit(1);
        // user2 (non-operator) tries to claim user1's deposit escrow
        await expect(
          express.connect(user2).claimDepositEscrow(user1.address, await usdo.getAddress())
        ).to.be.revertedWithCustomError(express, 'InvalidAmount');
      });
    });
  });
  describe('Redeem Flow (T+2)', function () {
    // Helper to setup user with OEM tokens
    async function setupUserWithTokens(fixture: any) {
      const { express, usdo, user1, maintainer } = fixture;
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      return { ...fixture, mintedAmount: amount };
    }
    describe('Redeem Preview', function () {
      it('should quote the fee in redeemAsset units', async function () {
        const { express, maintainer } = await loadFixture(deployFixture);
        await express.connect(maintainer).updateRedeemFeeRate(100);
        const withdrawAmount = ethers.parseUnits('1000', 18);
        const [feeAmt, redeemAssetAmt, netRedeemAssetAmt] =
          await express.previewRedeem(withdrawAmount);
        expect(redeemAssetAmt).to.equal(withdrawAmount);
        expect(feeAmt).to.equal((redeemAssetAmt * 100n) / 10000n);
        expect(netRedeemAssetAmt).to.equal(redeemAssetAmt - feeAmt);
      });
      it('should apply the current shares-per-token ratio after daily management fee mint', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, usdo, maintainer, operator } = await setupUserWithTokens(fixture);
        await express.connect(maintainer).updateMgtFeeRate(300);
        const timeBuffer = await express.timeBuffer();
        await time.increase(timeBuffer);
        await express.connect(operator).updateEpoch();
        const redeemAmount = ethers.parseUnits('1000', 18);
        const ratio = await express.sharesPerToken();
        const expectedRedeemAssetAmt = trim((redeemAmount * ratio) / ethers.parseUnits('1', 18), 3);
        const [, redeemAssetAmt] = await express.previewRedeem(redeemAmount);
        expect(ratio).to.be.lt(ethers.parseUnits('1', 18));
        expect(redeemAssetAmt).to.equal(expectedRedeemAssetAmt);
        expect(redeemAssetAmt).to.be.lt(redeemAmount);
      });
    });
    describe('Pending Redeem Queue', function () {
      it('should add redeem to pending queue', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem } = await setupUserWithTokens(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        // Approve express to spend OEM tokens
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        const queueLengthBefore = await express.getPendingRedeemQueueLength();
        await expect(express.connect(user1).requestRedeem(user1.address, redeemAmount)).to.emit(
          express,
          'AddToPendingRedeemQueue'
        );
        const queueLengthAfter = await express.getPendingRedeemQueueLength();
        expect(queueLengthAfter).to.equal(queueLengthBefore + 1n);
      });
      it('should enforce withdraw minimum', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem } = await setupUserWithTokens(fixture);
        const redeemMin = await express.redeemMinimum();
        const belowMin = redeemMin - ethers.parseUnits('1', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await expect(
          express.connect(user1).requestRedeem(user1.address, belowMin)
        ).to.be.revertedWithCustomError(express, 'RedeemLessThanMinimum');
      });
      it('should process withdraws after T+2 delay', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, operator } = await setupUserWithTokens(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        // Fast forward 2 days
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        // Should now be able to process
        await expect(
          express
            .connect(operator)
            .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1))
        ).to.emit(express, 'ProcessPendingRedeem');
      });
      it('should use the ratio at requestRedeem time for redeem asset calculation', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, maintainer, operator } = await setupUserWithTokens(fixture);
        await express.connect(maintainer).updateMgtFeeRate(300);
        const timeBuffer = await express.timeBuffer();
        await time.increase(timeBuffer);
        await express.connect(operator).updateEpoch();
        const redeemAmount = ethers.parseUnits('1000', 18);
        // Ratio is baked in at requestRedeem time (shareAmount computed then)
        const ratioAtRequest = await express.sharesPerToken();
        const expectedRedeemAssetAmt = trim(
          (redeemAmount * ratioAtRequest) / ethers.parseUnits('1', 18),
          3
        );
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        // getRedeemQueueInfo returns: (sender, receiver, tokenAmount, shareAmount, redeemAssetAmt, feeAssetAmt, requestTimestamp, id)
        const [, , tokenAmount, , redeemAssetAmt] = await express.getRedeemQueueInfo(0);
        expect(tokenAmount).to.equal(redeemAmount);
        expect(redeemAssetAmt).to.equal(expectedRedeemAssetAmt);
        expect(redeemAssetAmt).to.be.lt(redeemAmount);
      });
      it('should preserve original timestamp when processing', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, operator } = await setupUserWithTokens(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        const tx = await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        const receipt = await tx.wait();
        const requestBlock = await ethers.provider.getBlock(receipt!.blockNumber);
        const requestTimestamp = requestBlock!.timestamp;
        // Fast forward 2 days
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        // Process to withdraw queue
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        // Check withdraw queue has correct timestamp
        // getRedeemQueueInfo: (sender, receiver, tokenAmount, shareAmount, redeemAssetAmt, feeAssetAmt, requestTimestamp, id)
        const [, , , , , , timestamp] = await express.getRedeemQueueInfo(0);
        expect(timestamp).to.equal(requestTimestamp);
      });
      it('should apply the same batch ratio to all redeems processed in one call', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, oem, usdo, user1, user2, maintainer, operator } = fixture;
        const depositAmount = ethers.parseUnits('5000', 18);
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
        await express
          .connect(user2)
          .requestDeposit(await usdo.getAddress(), depositAmount, user2.address);
        await express.connect(maintainer).processDepositQueue(1, depositAmount);
        await express.connect(maintainer).processDepositQueue(1, depositAmount);
        await express.connect(maintainer).updateMgtFeeRate(300);
        const timeBuffer = await express.timeBuffer();
        await time.increase(timeBuffer);
        await express.connect(operator).updateEpoch();
        const redeemAmount1 = ethers.parseUnits('1000', 18);
        const redeemAmount2 = ethers.parseUnits('2000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount1);
        await express.connect(user2).requestRedeem(user2.address, redeemAmount2);
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        const queueLen: bigint = await express.getPendingRedeemQueueLength();
        // Pro-rata distribution: each redeem gets trim(_totalAsset * shareAmount_i / batchTotalShares).
        // The batch ratio is encoded in the operator-supplied _totalAsset (= sum of oracle-implied
        // per-entry payouts). Verify the realized payouts are pro-rata to share amounts.
        const totalAsset = await expectedRedeemAssetTotal(express, Number(queueLen));
        const [, , , share1] = await express.getPendingRedeemQueueInfo(0);
        const [, , , share2] = await express.getPendingRedeemQueueInfo(1);
        const totalShares = share1 + share2;
        const expectedRedeemAssetAmt1 = trim((totalAsset * share1) / totalShares, 3);
        const expectedRedeemAssetAmt2 = trim((totalAsset * share2) / totalShares, 3);
        await express.connect(operator).processPendingRedeems(queueLen, totalAsset);
        // getRedeemQueueInfo: (sender, receiver, tokenAmount, shareAmount, redeemAssetAmt, ...)
        const [, , , , redeemAssetAmt1] = await express.getRedeemQueueInfo(0);
        const [, , , , redeemAssetAmt2] = await express.getRedeemQueueInfo(1);
        expect(redeemAssetAmt1).to.equal(expectedRedeemAssetAmt1);
        expect(redeemAssetAmt2).to.equal(expectedRedeemAssetAmt2);
      });
    });
    describe('Final Redeem Queue', function () {
      async function setupRedemptionQueue(fixture: any) {
        const { express, user1, oem, operator } = await setupUserWithTokens(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        // Fast forward and process to final queue
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        return { ...fixture, redeemAmount };
      }
      it('should burn tokens on final withdraw', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, operator, redeemAmount } = await setupRedemptionQueue(fixture);
        const userBalanceBefore = await oem.balanceOf(user1.address);
        const totalSupplyBefore = await oem.totalSupply();
        await express.connect(operator).processRedeemQueue(1);
        const userBalanceAfter = await oem.balanceOf(user1.address);
        const totalSupplyAfter = await oem.totalSupply();
        // User balance should not change (tokens already transferred to Express during withdrawRequest)
        expect(userBalanceAfter).to.equal(userBalanceBefore);
        // Total supply should decrease by redeemed amount
        expect(totalSupplyAfter).to.equal(totalSupplyBefore - redeemAmount);
      });
      it('should transfer underlying assets to user', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, usdo, operator, redeemAmount } =
          await setupRedemptionQueue(fixture);
        const userUsdoBalanceBefore = await usdo.balanceOf(user1.address);
        await express.connect(operator).processRedeemQueue(1);
        const userUsdoBalanceAfter = await usdo.balanceOf(user1.address);
        // User should receive USDO (1:1 ratio, no fees)
        expect(userUsdoBalanceAfter).to.equal(userUsdoBalanceBefore + redeemAmount);
      });
      it('should handle withdraw fees correctly', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, maintainer } = fixture;
        // Set 2% redeem fee (200 basis points)
        await express.connect(maintainer).updateRedeemFeeRate(200);
        const { user1, usdo, operator, redeemAmount } = await setupRedemptionQueue(fixture);
        const expectedFee = (redeemAmount * 200n) / 10000n; // 2%
        const expectedNet = redeemAmount - expectedFee;
        const userUsdoBalanceBefore = await usdo.balanceOf(user1.address);
        const txFeeToAddress = await express.txFeeTo();
        await express.connect(operator).processRedeemQueue(1);
        const userUsdoBalanceAfter = await usdo.balanceOf(user1.address);
        const feeToBalance = await usdo.balanceOf(txFeeToAddress);
        // User should receive net amount
        expect(userUsdoBalanceAfter).to.equal(userUsdoBalanceBefore + expectedNet);
        // txFeeTo should receive fee
        expect(feeToBalance).to.be.gte(expectedFee); // gte because txFeeTo may have received mint fees
      });
      it('should break on insufficient liquidity', async function () {
        const fixture = await loadFixture(deployFixture);
        const fullFixture = await setupUserWithTokens(fixture);
        const { express, user1, user2, oem, operator, maintainer, usdo } = fullFixture;
        // Setup multiple withdraws
        const redeemAmount = ethers.parseUnits('1000', 18);
        // User1 redeem
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        // User2 setup and redeem
        await express
          .connect(user2)
          .requestDeposit(await usdo.getAddress(), ethers.parseUnits('5000', 18), user2.address);
        await express.connect(maintainer).processDepositQueue(1, ethers.parseUnits('5000', 18));
        await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user2).requestRedeem(user2.address, redeemAmount);
        // Fast forward and process to final queue
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        const queueLen: bigint = await express.getPendingRedeemQueueLength();
        await express
          .connect(operator)
          .processPendingRedeems(
            queueLen,
            await expectedRedeemAssetTotal(express, Number(queueLen))
          ); // Process all
        // Remove liquidity from Express
        const expressUsdo = await usdo.balanceOf(await express.getAddress());
        // Leave enough for one withdraw (1000 USDO), burn the rest
        await usdo.burn(await express.getAddress(), expressUsdo - ethers.parseUnits('1000', 18));
        // Try to process both (should only process first one due to liquidity)
        await express.connect(operator).processRedeemQueue(0);
        // Queue should still have 1 item (second withdraw couldn't process)
        const queueLength = await express.getRedeemQueueLength();
        expect(queueLength).to.equal(1);
      });
    });
    describe('Revert Redemption to Pending (Price Correction)', function () {
      async function setupRedemptionQueueMultiple(fixture: any) {
        const fullFixture = await setupUserWithTokens(fixture);
        const { express, user1, user2, user3, oem, operator, maintainer, usdo } = fullFixture;
        // Setup user2 and user3 with tokens
        await express
          .connect(user2)
          .requestDeposit(await usdo.getAddress(), ethers.parseUnits('5000', 18), user2.address);
        await express
          .connect(user3)
          .requestDeposit(await usdo.getAddress(), ethers.parseUnits('5000', 18), user3.address);
        await express.connect(maintainer).processDepositQueue(1, ethers.parseUnits('5000', 18));
        await express.connect(maintainer).processDepositQueue(1, ethers.parseUnits('5000', 18));
        // All users request withdraw
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);
        await oem.connect(user3).approve(await express.getAddress(), ethers.MaxUint256);
        const tx1 = await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        const tx2 = await express.connect(user2).requestRedeem(user2.address, redeemAmount);
        const tx3 = await express.connect(user3).requestRedeem(user3.address, redeemAmount);
        // Get timestamps
        const receipt1 = await tx1.wait();
        const receipt2 = await tx2.wait();
        const receipt3 = await tx3.wait();
        const block1 = await ethers.provider.getBlock(receipt1!.blockNumber);
        const block2 = await ethers.provider.getBlock(receipt2!.blockNumber);
        const block3 = await ethers.provider.getBlock(receipt3!.blockNumber);
        const timestamps = [block1!.timestamp, block2!.timestamp, block3!.timestamp];
        // Fast forward and process to final queue
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        const queueLen: bigint = await express.getPendingRedeemQueueLength();
        await express
          .connect(operator)
          .processPendingRedeems(
            queueLen,
            await expectedRedeemAssetTotal(express, Number(queueLen))
          );
        return { ...fixture, redeemAmount, originalTimestamps: timestamps };
      }
      it('should revert withdraws from final queue to pending queue', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, operator } = await setupRedemptionQueueMultiple(fixture);
        const withdrawQueueLengthBefore = await express.getRedeemQueueLength();
        const pendingQueueLengthBefore = await express.getPendingRedeemQueueLength();
        expect(withdrawQueueLengthBefore).to.equal(3);
        expect(pendingQueueLengthBefore).to.equal(0);
        // Revert 2 withdraws
        await express.connect(operator).revertRedeemToPending(2);
        const withdrawQueueLengthAfter = await express.getRedeemQueueLength();
        const pendingQueueLengthAfter = await express.getPendingRedeemQueueLength();
        expect(withdrawQueueLengthAfter).to.equal(1);
        expect(pendingQueueLengthAfter).to.equal(2);
      });
      it('should preserve original timestamps when reverting', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, operator, originalTimestamps } =
          await setupRedemptionQueueMultiple(fixture);
        // Revert all withdraws
        await express.connect(operator).revertRedeemToPending(0); // 0 = all
        // Check that timestamps are preserved in pending queue
        // getPendingRedeemQueueInfo: (sender, receiver, tokenAmount, shareAmount, requestTimestamp, id)
        const [, , , , timestamp1] = await express.getPendingRedeemQueueInfo(0);
        const [, , , , timestamp2] = await express.getPendingRedeemQueueInfo(1);
        const [, , , , timestamp3] = await express.getPendingRedeemQueueInfo(2);
        expect(timestamp1).to.equal(originalTimestamps[0]);
        expect(timestamp2).to.equal(originalTimestamps[1]);
        expect(timestamp3).to.equal(originalTimestamps[2]);
      });
      it('should maintain FIFO order when reverting', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, user2, operator } = await setupRedemptionQueueMultiple(fixture);
        // Revert all withdraws
        await express.connect(operator).revertRedeemToPending(0);
        // Check that order is preserved (user1 should be first)
        const [sender1] = await express.getPendingRedeemQueueInfo(0);
        const [sender2] = await express.getPendingRedeemQueueInfo(1);
        expect(sender1).to.equal(user1.address);
        expect(sender2).to.equal(user2.address);
      });
      it('should emit RevertWithdrawToPending event', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, operator, redeemAmount } =
          await setupRedemptionQueueMultiple(fixture);
        await expect(express.connect(operator).revertRedeemToPending(1)).to.emit(
          express,
          'RevertRedeemToPending'
        );
      });
      it('should allow reprocessing with correct price after revert', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, operator, maintainer } = await setupRedemptionQueueMultiple(fixture);
        // Simulate wrong price was used (revert everything)
        await express.connect(operator).revertRedeemToPending(0);
        // Items are back in pending queue, but already past T+2 delay (timestamps preserved)
        // Should be able to process immediately
        const queueLen: bigint = await express.getPendingRedeemQueueLength();
        await expect(
          express
            .connect(operator)
            .processPendingRedeems(
              queueLen,
              await expectedRedeemAssetTotal(express, Number(queueLen))
            )
        ).to.emit(express, 'ProcessPendingRedeem');
        // All should be back in withdraw queue
        const withdrawQueueLength = await express.getRedeemQueueLength();
        expect(withdrawQueueLength).to.equal(3);
      });
      it('should only allow MAINTAINER_ROLE to revert', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1 } = await setupRedemptionQueueMultiple(fixture);
        const MAINTAINER_ROLE = await express.MAINTAINER_ROLE();
        await expect(express.connect(user1).revertRedeemToPending(1)).to.be.revertedWithCustomError(
          express,
          'AccessControlUnauthorizedAccount'
        );
      });
    });
    describe('Cancel Redeems', function () {
      async function setupPendingRedemption(fixture: any) {
        const { express, user1, oem } = await setupUserWithTokens(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        return { ...fixture, redeemAmount };
      }
      it('should cancel pending redeems and refund tokens', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, maintainer, redeemAmount } =
          await setupPendingRedemption(fixture);
        const userBalanceBefore = await oem.balanceOf(user1.address);
        await express.connect(maintainer).cancelPendingRedeem(1);
        const userBalanceAfter = await oem.balanceOf(user1.address);
        // User should get tokens back
        expect(userBalanceAfter).to.equal(userBalanceBefore + redeemAmount);
        // Queue should be empty
        expect(await express.getPendingRedeemQueueLength()).to.equal(0);
      });
      it('should escrow tokens when cancelling pending redeem for banned user', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, maintainer, admin, redeemAmount } =
          await setupPendingRedemption(fixture);
        // Ban user1 on the token contract
        const BANLIST_ROLE = await oem.BANLIST_ROLE();
        await oem.connect(admin).grantRole(BANLIST_ROLE, admin.address);
        await oem.connect(admin).banAddresses([user1.address]);
        const userBalanceBefore = await oem.balanceOf(user1.address);
        await expect(express.connect(maintainer).cancelPendingRedeem(1))
          .to.emit(express, 'RedeemEscrowIn')
          .withArgs(user1.address, redeemAmount);
        // User balance unchanged (tokens escrowed, not transferred)
        expect(await oem.balanceOf(user1.address)).to.equal(userBalanceBefore);
        // Escrow balance recorded
        expect(await express.redeemEscrowBalance(user1.address)).to.equal(redeemAmount);
        // Queue should be empty
        expect(await express.getPendingRedeemQueueLength()).to.equal(0);
      });
      it('should escrow tokens when cancelling redeem for banned user', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, maintainer, operator, admin, redeemAmount } =
          await setupPendingRedemption(fixture);
        // Move to final redeem queue
        const redeemDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(redeemDelay);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        // Ban user1
        const BANLIST_ROLE = await oem.BANLIST_ROLE();
        await oem.connect(admin).grantRole(BANLIST_ROLE, admin.address);
        await oem.connect(admin).banAddresses([user1.address]);
        const userBalanceBefore = await oem.balanceOf(user1.address);
        await expect(express.connect(maintainer).cancelRedeem(1))
          .to.emit(express, 'RedeemEscrowIn')
          .withArgs(user1.address, redeemAmount);
        // User balance unchanged
        expect(await oem.balanceOf(user1.address)).to.equal(userBalanceBefore);
        // Escrow balance recorded
        expect(await express.redeemEscrowBalance(user1.address)).to.equal(redeemAmount);
      });
    });
    describe('Claim Escrow', function () {
      async function setupEscrowedUser(fixture: any) {
        const { express, user1, oem, maintainer, admin } = await setupUserWithTokens(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        // Ban user1 and cancel pending redeem to escrow tokens
        const BANLIST_ROLE = await oem.BANLIST_ROLE();
        await oem.connect(admin).grantRole(BANLIST_ROLE, admin.address);
        await oem.connect(admin).banAddresses([user1.address]);
        await express.connect(maintainer).cancelPendingRedeem(1);
        return { ...fixture, redeemAmount };
      }
      it('should allow banned user to claim escrowed tokens after unban', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, admin, redeemAmount } = await setupEscrowedUser(fixture);
        // Unban user1 so they can receive tokens
        await oem.connect(admin).unbanAddresses([user1.address]);
        const userBalanceBefore = await oem.balanceOf(user1.address);
        await expect(express.connect(user1).claimRedeemEscrow(user1.address))
          .to.emit(express, 'RedeemEscrowOut')
          .withArgs(user1.address, redeemAmount);
        expect(await oem.balanceOf(user1.address)).to.equal(userBalanceBefore + redeemAmount);
        expect(await express.redeemEscrowBalance(user1.address)).to.equal(0);
      });
      it('should allow operator to claim escrow on behalf of user', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, admin, operator, redeemAmount } =
          await setupEscrowedUser(fixture);
        // Unban user1 so they can receive tokens
        await oem.connect(admin).unbanAddresses([user1.address]);
        const userBalanceBefore = await oem.balanceOf(user1.address);
        await expect(express.connect(operator).claimRedeemEscrow(user1.address))
          .to.emit(express, 'RedeemEscrowOut')
          .withArgs(user1.address, redeemAmount);
        // Tokens go to user1, not operator
        expect(await oem.balanceOf(user1.address)).to.equal(userBalanceBefore + redeemAmount);
        expect(await express.redeemEscrowBalance(user1.address)).to.equal(0);
      });
      it('should ignore _account param for non-operator callers', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, user2 } = await setupEscrowedUser(fixture);
        // user2 (non-operator) tries to claim user1's escrow by passing user1's address
        await expect(
          express.connect(user2).claimRedeemEscrow(user1.address)
        ).to.be.revertedWithCustomError(express, 'InvalidAmount');
      });
      it('should revert claimRedeemEscrow when no escrowed balance', async function () {
        const { express, user1 } = await loadFixture(deployFixture);
        await expect(
          express.connect(user1).claimRedeemEscrow(user1.address)
        ).to.be.revertedWithCustomError(express, 'InvalidAmount');
      });
      it('should accumulate escrow across multiple cancelled redeems', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, maintainer, admin } = await setupUserWithTokens(fixture);
        const redeemAmount1 = ethers.parseUnits('500', 18);
        const redeemAmount2 = ethers.parseUnits('700', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount1);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount2);
        // Ban user1 and cancel both
        const BANLIST_ROLE = await oem.BANLIST_ROLE();
        await oem.connect(admin).grantRole(BANLIST_ROLE, admin.address);
        await oem.connect(admin).banAddresses([user1.address]);
        await express.connect(maintainer).cancelPendingRedeem(2);
        expect(await express.redeemEscrowBalance(user1.address)).to.equal(
          redeemAmount1 + redeemAmount2
        );
        // Unban and claim all at once
        await oem.connect(admin).unbanAddresses([user1.address]);
        const balanceBefore = await oem.balanceOf(user1.address);
        await express.connect(user1).claimRedeemEscrow(user1.address);
        expect(await oem.balanceOf(user1.address)).to.equal(
          balanceBefore + redeemAmount1 + redeemAmount2
        );
      });
    });
  });
  describe('Management Fee Accrual', function () {
    it('should mint daily management fees during updateEpoch', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, operator, maintainer, oem, user1, usdo } = fixture;
      // Setup tokens in circulation
      const mintAmount = ethers.parseUnits('100000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), mintAmount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, mintAmount);
      // Set 3% annual management fee (300 basis points)
      await express.connect(maintainer).updateMgtFeeRate(300);
      // Get current state
      const timeBuffer = await express.timeBuffer();
      // Fast forward past time buffer
      await time.increase(timeBuffer);
      // Update epoch
      await expect(express.connect(operator).updateEpoch()).to.emit(express, 'UpdateEpoch');
      const mgtFeeTo = await express.mgtFeeTo();
      expect(await oem.balanceOf(mgtFeeTo)).to.be.gt(0);
      expect(await express.totalMgtFeeUnclaimed()).to.equal(await oem.balanceOf(mgtFeeTo));
    });
    it('should revert if updating epoch too early', async function () {
      const { express, usdo, user1, operator, maintainer } = await loadFixture(deployFixture);
      // Need offchainShares > 0 for updateEpoch to proceed
      const depositAmt = ethers.parseUnits('5000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
      await express.connect(maintainer).processDepositQueue(1, depositAmt);
      await express.connect(maintainer).updateMgtFeeRate(300);
      // First update is allowed
      await express.connect(operator).updateEpoch();
      // Second update without waiting should revert
      await expect(express.connect(operator).updateEpoch()).to.be.revertedWithCustomError(
        express,
        'UpdateTooEarly'
      );
    });
    it('should revert updateEpoch when mgtFeeRate is zero', async function () {
      const { express, operator } = await loadFixture(deployFixture);
      await expect(express.connect(operator).updateEpoch()).to.be.revertedWithCustomError(
        express,
        'MgtFeeDisabled'
      );
    });
    it('should track unclaimed fees correctly in the daily mint flow', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, operator, maintainer, oem, user1, usdo } = fixture;
      // Setup tokens and fees
      const mintAmount = ethers.parseUnits('100000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), mintAmount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, mintAmount);
      await express.connect(maintainer).updateMgtFeeRate(300);
      const mgtFeeTo = await express.mgtFeeTo();
      const balanceBefore = await oem.balanceOf(mgtFeeTo);
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();
      const balanceAfter = await oem.balanceOf(mgtFeeTo);
      expect(balanceAfter).to.be.gt(balanceBefore);
      expect(await express.totalMgtFeeUnclaimed()).to.equal(balanceAfter);
    });
  });
  describe('Access Control', function () {
    it('should only allow MAINTAINER to update fee rates', async function () {
      const { express, user1 } = await loadFixture(deployFixture);
      await expect(express.connect(user1).updateDepositFeeRate(100)).to.be.revertedWithCustomError(
        express,
        'AccessControlUnauthorizedAccount'
      );
    });
    it('should only allow OPERATOR to process queues', async function () {
      const { express, user1 } = await loadFixture(deployFixture);
      await expect(
        express.connect(user1).processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1))
      ).to.be.revertedWithCustomError(express, 'AccessControlUnauthorizedAccount');
    });
    it('reads KYC state from the configured KycManager', async function () {
      const { express, kycManager, whitelister, usdo, user1 } = await loadFixture(deployFixture);
      // user1 is KYC'd in fixture — request should succeed
      await expect(
        express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), ethers.parseUnits('1000', 18), user1.address)
      ).to.not.be.reverted;

      // Revoke at the manager and confirm Express now rejects
      await kycManager.connect(whitelister).revokeKyc(user1.address);
      await expect(
        express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), ethers.parseUnits('1000', 18), user1.address)
      ).to.be.revertedWithCustomError(express, 'NotInKycList');
    });
    it('should only allow PAUSE_ROLE to pause', async function () {
      const { express, user1 } = await loadFixture(deployFixture);
      await expect(express.connect(user1).pauseDeposit()).to.be.revertedWithCustomError(
        express,
        'AccessControlUnauthorizedAccount'
      );
    });
  });
  describe('Upgradeability', function () {
    it('should be upgradeable by UPGRADE_ROLE', async function () {
      const { express, admin } = await loadFixture(deployFixture);
      const ExpressV2 = await ethers.getContractFactory(
        'contracts/extension/Express.sol:Express',
        admin
      );
      await expect(upgrades.upgradeProxy(await express.getAddress(), ExpressV2)).to.not.be.reverted;
    });
    it('should preserve state after upgrade', async function () {
      const { express, admin, usdo, user1, operator } = await loadFixture(deployFixture);
      // Setup some state
      const mintAmount = ethers.parseUnits('1000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), mintAmount, user1.address);
      const queueLengthBefore = await express.getDepositQueueLength();
      // Upgrade
      const ExpressV2 = await ethers.getContractFactory(
        'contracts/extension/Express.sol:Express',
        admin
      );
      const upgraded = await upgrades.upgradeProxy(await express.getAddress(), ExpressV2);
      // State should be preserved
      const queueLengthAfter = await upgraded.getDepositQueueLength();
      expect(queueLengthAfter).to.equal(queueLengthBefore);
    });
  });
  describe('Circulating Supply', function () {
    it('should equal total supply when no withdraws queued and no mgtFeeTo balance', async function () {
      const { express, oem, user1, usdo, maintainer } = await loadFixture(deployFixture);
      // Deposit to create some supply
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      const totalSupply = await oem.totalSupply();
      const circulating = await express.circulatingSupply();
      // mgtFeeTo (treasury) has 0 OEM tokens, no withdraw queue items
      const mgtFeeTo = await express.mgtFeeTo();
      const mgtFeeToBalance = await oem.balanceOf(mgtFeeTo);
      expect(circulating).to.equal(totalSupply - mgtFeeToBalance);
    });
    it('should exclude tokens in pending withdraw queue (totalRedeemQueueTokens incremented at requestRedeem)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer } = fixture;
      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      const circulatingBefore = await express.circulatingSupply();
      // Request withdraw (totalRedeemQueueTokens incremented immediately)
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      const circulatingAfter = await express.circulatingSupply();
      // Circulating decreases because totalRedeemQueueTokens is incremented at requestRedeem time
      expect(circulatingAfter).to.equal(circulatingBefore - withdrawAmount);
    });
    it('should exclude tokens in withdraw queue', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      // Request withdraw
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      // Move to final withdraw queue
      const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
      await time.increase(withdrawDelay);
      await express
        .connect(operator)
        .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
      const circulating = await express.circulatingSupply();
      const totalSupply = await oem.totalSupply();
      const mgtFeeTo = await express.mgtFeeTo();
      const mgtFeeToBalance = await oem.balanceOf(mgtFeeTo);
      // Circulating should exclude withdraw queue tokens
      expect(circulating).to.equal(totalSupply - withdrawAmount - mgtFeeToBalance);
    });
    it('should restore circulating supply after withdraw queue is processed', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      const totalSupplyBefore = await oem.totalSupply();
      // Full withdraw flow
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
      await time.increase(withdrawDelay);
      await express
        .connect(operator)
        .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
      await express.connect(operator).processRedeemQueue(1);
      // After processing, tokens are burned - totalSupply decreases
      const totalSupplyAfter = await oem.totalSupply();
      const circulating = await express.circulatingSupply();
      const mgtFeeTo = await express.mgtFeeTo();
      const mgtFeeToBalance = await oem.balanceOf(mgtFeeTo);
      expect(totalSupplyAfter).to.equal(totalSupplyBefore - withdrawAmount);
      // No more tokens in withdraw queue, so circulating = totalSupply - mgtFeeToBalance
      expect(circulating).to.equal(totalSupplyAfter - mgtFeeToBalance);
      expect(await express.totalRedeemQueueTokens()).to.equal(0);
    });
    it('should restore circulating supply after withdraw is cancelled', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      const circulatingBefore = await express.circulatingSupply();
      // Request withdraw and move to final queue
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
      await time.increase(withdrawDelay);
      await express
        .connect(operator)
        .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
      // Cancel from withdraw queue
      await express.connect(maintainer).cancelRedeem(1);
      const circulatingAfter = await express.circulatingSupply();
      // Should be back to original since tokens refunded and totalWithdrawQueueTokens is 0
      expect(circulatingAfter).to.equal(circulatingBefore);
      expect(await express.totalRedeemQueueTokens()).to.equal(0);
    });
    it('should keep circulating supply unchanged through revert to pending', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      const circulatingBefore = await express.circulatingSupply();
      // Request withdraw and move to final queue
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      // Circulating already decreased at requestRedeem time
      const circulatingAfterRequest = await express.circulatingSupply();
      expect(circulatingAfterRequest).to.equal(circulatingBefore - withdrawAmount);
      const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
      await time.increase(withdrawDelay);
      await express
        .connect(operator)
        .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
      // Circulating unchanged after pending->final
      expect(await express.circulatingSupply()).to.equal(circulatingAfterRequest);
      // Revert back to pending — no accounting changes
      await express.connect(operator).revertRedeemToPending(1);
      const circulatingAfterRevert = await express.circulatingSupply();
      // totalRedeemQueueTokens unchanged (covers both queues)
      expect(circulatingAfterRevert).to.equal(circulatingAfterRequest);
      expect(await express.totalRedeemQueueTokens()).to.equal(withdrawAmount);
    });
    it('should track totalWithdrawQueueTokens correctly with multiple users', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, user2, user3, usdo, maintainer, operator } = fixture;
      // Deposit for all users
      const depositAmount = ethers.parseUnits('5000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), depositAmount, user2.address);
      await express
        .connect(user3)
        .requestDeposit(await usdo.getAddress(), depositAmount, user3.address);
      await express.connect(maintainer).processDepositQueue(1, depositAmount);
      await express.connect(maintainer).processDepositQueue(1, depositAmount);
      await express.connect(maintainer).processDepositQueue(1, depositAmount);
      // All users request withdraws of different amounts
      const w1 = ethers.parseUnits('1000', 18);
      const w2 = ethers.parseUnits('2000', 18);
      const w3 = ethers.parseUnits('500', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);
      await oem.connect(user3).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, w1);
      await express.connect(user2).requestRedeem(user2.address, w2);
      await express.connect(user3).requestRedeem(user3.address, w3);
      // Move all to final withdraw queue
      const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
      await time.increase(withdrawDelay);
      const queueLen: bigint = await express.getPendingRedeemQueueLength();
      await express
        .connect(operator)
        .processPendingRedeems(queueLen, await expectedRedeemAssetTotal(express, Number(queueLen)));
      expect(await express.totalRedeemQueueTokens()).to.equal(w1 + w2 + w3);
      // Process first one
      await express.connect(operator).processRedeemQueue(1);
      expect(await express.totalRedeemQueueTokens()).to.equal(w2 + w3);
      // Process remaining
      await express.connect(operator).processRedeemQueue(0);
      expect(await express.totalRedeemQueueTokens()).to.equal(0);
    });
    it('should decrease circulating supply when holders burn tokens outside redeem flow', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, usdo, admin, operator, user1, maintainer } = fixture;
      const depositAmount = ethers.parseUnits('5000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, depositAmount);
      const BURNER_ROLE = await oem.BURNER_ROLE();
      await oem.connect(admin).grantRole(BURNER_ROLE, operator.address);
      const burnAmount = ethers.parseUnits('250', 18);
      const totalSupplyBefore = await oem.totalSupply();
      const circulatingBefore = await express.circulatingSupply();
      await oem.connect(operator).burn(user1.address, burnAmount);
      expect(await oem.totalSupply()).to.equal(totalSupplyBefore - burnAmount);
      expect(await express.circulatingSupply()).to.equal(circulatingBefore - burnAmount);
      expect(await express.sharesPerToken()).to.be.gt(ethers.parseUnits('1', 18));
    });
  });
  describe('Shares Per Token', function () {
    it('should return 1e18 when no tokens exist', async function () {
      const { express } = await loadFixture(deployFixture);
      const ratio = await express.sharesPerToken();
      expect(ratio).to.equal(ethers.parseUnits('1', 18));
    });
    it('should return 1e18 when no withdraw queue and no mgtFeeTo balance', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer } = fixture;
      // Deposit to create supply
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      const mgtFeeTo = await express.mgtFeeTo();
      const mgtFeeToBalance = await oem.balanceOf(mgtFeeTo);
      // If mgtFeeTo has no balance, ratio should be 1:1
      if (mgtFeeToBalance === 0n) {
        expect(await express.sharesPerToken()).to.equal(ethers.parseUnits('1', 18));
      }
    });
    it('should be invariant when tokens move through redeem queue (no mgt fee)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      const ratioBefore = await express.sharesPerToken();
      // Request withdraw and move to final queue
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
      await time.increase(withdrawDelay);
      await express
        .connect(operator)
        .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
      const ratioAfter = await express.sharesPerToken();
      // Ratio is invariant — offchainShares decremented proportionally at requestRedeem time
      expect(ratioAfter).to.equal(ratioBefore);
    });
    it('should be invariant through redeem cycle even WITH mgt fee', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      // Set mgt fee so mgtFeeTo has a balance
      await express.connect(maintainer).updateMgtFeeRate(300);
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();
      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.be.lt(ethers.parseUnits('1', 18));
      // Request withdraw and move to final queue
      const withdrawAmount = ethers.parseUnits('20000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
      await time.increase(withdrawDelay);
      await express
        .connect(operator)
        .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
      const ratioAfter = await express.sharesPerToken();
      // Ratio is invariant — offchainShares decremented proportionally at requestRedeem time
      expect(ratioAfter).to.equal(ratioBefore);
    });
    it('should return correct ratio value', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit 10000
      const amount = ethers.parseUnits('10000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      // Withdraw 2000 to final queue
      const withdrawAmount = ethers.parseUnits('2000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
      await time.increase(withdrawDelay);
      await express
        .connect(operator)
        .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
      const totalSupply = await oem.totalSupply();
      const totalRedeemQueueTokens = await express.totalRedeemQueueTokens();
      const denom = totalSupply - totalRedeemQueueTokens;
      const offchainShares = await express.offchainShares();
      const ratio = await express.sharesPerToken();
      // ratio = offchainShares * 1e18 / (totalSupply - totalRedeemQueueTokens)
      const expectedRatio = (offchainShares * ethers.parseUnits('1', 18)) / denom;
      expect(ratio).to.equal(expectedRatio);
    });
    it('should maintain ratio == 1e18 through a full deposit+redeem cycle', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      // Full withdraw cycle
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
      await time.increase(withdrawDelay);
      await express
        .connect(operator)
        .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
      await express.connect(operator).processRedeemQueue(1);
      // After burn, ratio is invariant — offchainShares was decremented at requestRedeem time
      expect(await express.sharesPerToken()).to.equal(ethers.parseUnits('1', 18));
    });
    it('should decrease when daily mgt fee is minted in updateEpoch', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      // Set mgt fee and accrue
      await express.connect(maintainer).updateMgtFeeRate(300);
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      const ratioBefore = await express.sharesPerToken();
      await express.connect(operator).updateEpoch();
      const ratioAfter = await express.sharesPerToken();
      // mgtFeeTo balance is excluded from circulating, so ratio decreases
      expect(ratioAfter).to.be.lt(ratioBefore);
    });
  });
  describe('UpdateEpoch fee base (offchainShares)', function () {
    it('should calculate fee based on offchainShares (which is reduced by redeems)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      // Set mgt fee
      await express.connect(maintainer).updateMgtFeeRate(300);
      // requestRedeem reduces offchainShares proportionally
      const withdrawAmount = ethers.parseUnits('20000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
      await time.increase(withdrawDelay);
      await express
        .connect(operator)
        .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
      const offchainShares = await express.offchainShares();
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();
      // Expected daily fee = trim(offchainShares * 300 / (365 * 10000))
      const expectedFee = trim((offchainShares * 300n) / (365n * 10000n), TRIM_DECIMALS);
      const mgtFeeTo = await express.mgtFeeTo();
      expect(await oem.balanceOf(mgtFeeTo)).to.equal(expectedFee);
      expect(await express.totalMgtFeeUnclaimed()).to.equal(expectedFee);
    });
    it('should accrue reduced fee after requestRedeem decrements offchainShares', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      await express.connect(maintainer).updateMgtFeeRate(300);
      // Epoch 1: no redeem queue
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();
      const mgtFeeTo = await express.mgtFeeTo();
      const fee1 = await oem.balanceOf(mgtFeeTo);
      // requestRedeem decrements offchainShares
      const withdrawAmount = ethers.parseUnits('50000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      // offchainShares reduced by ~50% (proportional to redeem)
      const offchainSharesAfter = await express.offchainShares();
      expect(offchainSharesAfter).to.be.lt(amount);
      // Epoch 2: offchainShares is smaller, so fee should be smaller
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();
      const totalFee = await oem.balanceOf(mgtFeeTo);
      const fee2 = totalFee - fee1;
      // Fee is charged on offchainShares — which is now smaller
      expect(fee2).to.be.lt(fee1);
    });
    it('should revert updateEpoch when offchainShares is zero', async function () {
      const { express, operator, maintainer } = await loadFixture(deployFixture);
      await express.connect(maintainer).updateMgtFeeRate(300);
      // No deposits, so offchainShares = 0
      await expect(express.connect(operator).updateEpoch()).to.be.revertedWithCustomError(
        express,
        'InvalidAmount'
      );
    });
    it('should base fee on offchainShares which is reduced by pending redeems', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;
      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);
      await express.connect(maintainer).updateMgtFeeRate(300);
      // Request withdraw — offchainShares is decremented immediately
      const withdrawAmount = ethers.parseUnits('20000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
      // offchainShares now reduced, so fee should be based on the reduced offchainShares
      const offchainShares = await express.offchainShares();
      expect(offchainShares).to.equal(amount - withdrawAmount);
      // updateEpoch fee based on offchainShares
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();
      const mgtFeeTo = await express.mgtFeeTo();
      const expectedFee = trim((offchainShares * 300n) / (365n * 10000n), TRIM_DECIMALS);
      const feeMintedToday = await oem.balanceOf(mgtFeeTo);
      expect(feeMintedToday).to.equal(expectedFee);
      expect(await express.totalMgtFeeUnclaimed()).to.equal(expectedFee);
    });

    // WP-M8: dailyFee is computed in offchain-share units, then converted to token
    // units via _sharesPerToken before minting. When the ratio != 1e18, the minted
    // tokens differ from the share-denominated fee.
    it('mints daily fee in token units (shares converted via sharesPerToken)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, usdo, maintainer, operator } = fixture;

      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1, amount);

      // Force ratio = 2e18 (offchainShares == 2 * circulating tokens) via the admin
      // override. Now dailyFeeShares ≠ dailyFeeTokens.
      const inflatedShares = amount * 2n;
      await express.connect(maintainer).updateOffchainShares(inflatedShares);
      expect(await express.sharesPerToken()).to.equal(ethers.parseUnits('2', 18));

      await express.connect(maintainer).updateMgtFeeRate(300);
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);

      const mgtFeeTo = await express.mgtFeeTo();
      const balanceBefore = await oem.balanceOf(mgtFeeTo);

      const expectedFeeShares = (inflatedShares * 300n) / (365n * 10000n);
      // tokens = shares * 1e18 / ratio = shares / 2, then trim
      const expectedFeeTokens = trim(
        (expectedFeeShares * ethers.parseUnits('1', 18)) / ethers.parseUnits('2', 18),
        TRIM_DECIMALS
      );

      await expect(express.connect(operator).updateEpoch())
        .to.emit(express, 'UpdateEpoch')
        .withArgs(expectedFeeShares, expectedFeeTokens, inflatedShares);

      const minted = (await oem.balanceOf(mgtFeeTo)) - balanceBefore;
      expect(minted).to.equal(expectedFeeTokens);
      // Sanity: fee tokens are roughly half the fee shares at ratio 2:1
      expect(expectedFeeTokens).to.be.lt(expectedFeeShares);
    });
  });
  describe('Edge Cases', function () {
    it('should handle empty queue processing gracefully', async function () {
      const { express, maintainer } = await loadFixture(deployFixture);
      await expect(
        express.connect(maintainer).processDepositQueue(1, ethers.parseUnits('1000', 18))
      ).to.be.revertedWithCustomError(express, 'EmptyQueue');
    });
    it('should revert on invalid len parameter', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      // Add one item
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), ethers.parseUnits('1000', 18), user1.address);
      // Try to process more than available
      await expect(
        express.connect(maintainer).processDepositQueue(10, ethers.parseUnits('10000', 18))
      ).to.be.revertedWithCustomError(express, 'InvalidInput');
    });
    it('should handle zero amount redeem', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, usdo, user1, maintainer } = fixture;
      const firstDepositMin = await express.firstDepositAmount();
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), firstDepositMin, user1.address);
      await express.connect(maintainer).processDepositQueue(1, firstDepositMin);
      // Zero is rejected by the redeemMinimum check (operator guarantees redeemMinimum > 0).
      await expect(
        express.connect(user1).requestRedeem(user1.address, 0)
      ).to.be.revertedWithCustomError(express, 'RedeemLessThanMinimum');
    });
  });
  describe('Trim Decimals', function () {
    describe('updateTrimDecimals', function () {
      it('should allow MAINTAINER to update trimDecimals', async function () {
        const { express, maintainer } = await loadFixture(deployFixture);
        await expect(express.connect(maintainer).updateTrimDecimals(6))
          .to.emit(express, 'UpdateTrimDecimals')
          .withArgs(6);
        expect(await express.trimDecimals()).to.equal(6);
      });
      it('should revert when non-MAINTAINER calls updateTrimDecimals', async function () {
        const { express, user1 } = await loadFixture(deployFixture);
        await expect(express.connect(user1).updateTrimDecimals(6)).to.be.revertedWithCustomError(
          express,
          'AccessControlUnauthorizedAccount'
        );
      });
      it('should revert when decimals exceed 18', async function () {
        const { express, maintainer } = await loadFixture(deployFixture);
        await expect(
          express.connect(maintainer).updateTrimDecimals(19)
        ).to.be.revertedWithCustomError(express, 'InvalidInput');
      });
      it('should allow setting to 18', async function () {
        const { express, maintainer } = await loadFixture(deployFixture);
        await expect(express.connect(maintainer).updateTrimDecimals(18)).to.not.be.reverted;
        expect(await express.trimDecimals()).to.equal(18);
      });
    });
    describe('trimming on deposit (mint)', function () {
      it('should trim minted amount to 3 decimals', async function () {
        const { express, oem, user1, usdo, maintainer } = await loadFixture(deployFixture);
        // trimDecimals is already 3 from fixture
        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, amount);
        const balance = await oem.balanceOf(user1.address);
        // Last 15 digits should be zero
        expect(balance % 10n ** 15n).to.equal(0);
      });
      it('should trim minted amount to 6 decimals', async function () {
        const { express, oem, user1, usdo, maintainer } = await loadFixture(deployFixture);
        await express.connect(maintainer).updateTrimDecimals(6);
        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, amount);
        const balance = await oem.balanceOf(user1.address);
        // Last 12 digits should be zero
        expect(balance % 10n ** 12n).to.equal(0);
      });
      it('should not trim when trimDecimals is 0', async function () {
        const { express, oem, user1, usdo, maintainer } = await loadFixture(deployFixture);
        await express.connect(maintainer).updateTrimDecimals(0);
        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, amount);
        const balance = await oem.balanceOf(user1.address);
        // With 1:1 price and no fee, minted = amount exactly (no trimming needed)
        expect(balance).to.equal(amount);
      });
      it('should not trim when trimDecimals is 18', async function () {
        const { express, oem, user1, usdo, maintainer } = await loadFixture(deployFixture);
        await express.connect(maintainer).updateTrimDecimals(18);
        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, amount);
        const balance = await oem.balanceOf(user1.address);
        expect(balance).to.equal(amount);
      });
    });
    describe('trimming on updateEpoch (daily fee)', function () {
      it('should trim daily fee to configured decimals', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, oem, user1, usdo, maintainer, operator } = fixture;
        // trimDecimals is 3 from fixture
        const amount = ethers.parseUnits('100000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, amount);
        await express.connect(maintainer).updateMgtFeeRate(300);
        const timeBuffer = await express.timeBuffer();
        await time.increase(timeBuffer);
        await express.connect(operator).updateEpoch();
        const mgtFeeTo = await express.mgtFeeTo();
        const fee = await oem.balanceOf(mgtFeeTo);
        // Last 15 digits should be zero (trimmed to 3 decimals)
        expect(fee % 10n ** 15n).to.equal(0);
        expect(fee).to.be.gt(0);
        expect(await express.totalMgtFeeUnclaimed()).to.equal(fee);
      });
      it('should produce different fee precision with different trimDecimals', async function () {
        const { express, oem, user1, usdo, maintainer, operator } =
          await loadFixture(deployFixture);
        const amount = ethers.parseUnits('100000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, amount);
        await express.connect(maintainer).updateMgtFeeRate(300);
        // Epoch 1: trimDecimals = 3
        const timeBuffer = await express.timeBuffer();
        await time.increase(timeBuffer);
        await express.connect(operator).updateEpoch();
        const mgtFeeTo = await express.mgtFeeTo();
        const fee3 = await oem.balanceOf(mgtFeeTo);
        // Change to 6 decimals
        await express.connect(maintainer).updateTrimDecimals(6);
        // Epoch 2: trimDecimals = 6
        await time.increase(timeBuffer);
        await express.connect(operator).updateEpoch();
        const totalFee = await oem.balanceOf(mgtFeeTo);
        const fee6 = BigInt(totalFee) - BigInt(fee3);
        // fee with 6 decimals should have more precision (last 12 digits zeroed, not 15)
        const trim3Factor = 10n ** 15n;
        const trim6Factor = 10n ** 12n;
        expect(fee3 % trim3Factor).to.equal(0n);
        expect(fee6 % trim6Factor).to.equal(0n);
        expect(await express.totalMgtFeeUnclaimed()).to.equal(totalFee);
      });
    });
    describe('trimming on processPendingRedeems (redeem amount)', function () {
      async function setupWithdrawFixture(fixture: any) {
        const { express, oem, user1, usdo, maintainer } = fixture;
        const depositAmount = ethers.parseUnits('5000', 18);
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, depositAmount);
        const withdrawAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, withdrawAmount);
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        return { ...fixture, withdrawAmount };
      }
      it('should trim withdrawAsset amount to 3 decimals', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, operator } = await setupWithdrawFixture(fixture);
        // trimDecimals is 3 from fixture
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        const [, , , , withdrawAssetAmt] = await express.getRedeemQueueInfo(0);
        // Last 15 digits should be zero
        expect(withdrawAssetAmt % 10n ** 15n).to.equal(0);
      });
      it('should trim withdrawAsset amount to 6 decimals', async function () {
        const fixture = await loadFixture(deployFixture);
        await fixture.express.connect(fixture.maintainer).updateTrimDecimals(6);
        const { express, operator } = await setupWithdrawFixture(fixture);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        const [, , , , withdrawAssetAmt] = await express.getRedeemQueueInfo(0);
        // Last 12 digits should be zero
        expect(withdrawAssetAmt % 10n ** 12n).to.equal(0);
      });
      it('should not trim withdrawAsset amount when trimDecimals is 0', async function () {
        const fixture = await loadFixture(deployFixture);
        await fixture.express.connect(fixture.maintainer).updateTrimDecimals(0);
        const { express, operator, withdrawAmount } = await setupWithdrawFixture(fixture);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        const [, , , , withdrawAssetAmt] = await express.getRedeemQueueInfo(0);
        // With 1:1 price and no fee, should equal the full withdraw amount
        expect(withdrawAssetAmt).to.equal(withdrawAmount);
      });
    });
    describe('updateRedeemAsset', function () {
      it('should allow maintainer to update redeemAsset when all queues are empty', async function () {
        const { express, usdo, maintainer } = await loadFixture(deployFixture);
        const MockERC20Factory = await ethers.getContractFactory('MockERC20');
        const newAsset = await MockERC20Factory.deploy('New Asset', 'NEW', 18);
        await newAsset.waitForDeployment();
        const oldAsset = await express.redeemAsset();
        expect(oldAsset).to.equal(await usdo.getAddress());
        await expect(express.connect(maintainer).updateRedeemAsset(await newAsset.getAddress()))
          .to.emit(express, 'UpdateRedeemAsset')
          .withArgs(oldAsset, await newAsset.getAddress());
        expect(await express.redeemAsset()).to.equal(await newAsset.getAddress());
      });
      it('should revert when called by non-maintainer', async function () {
        const { express, usdo, user1 } = await loadFixture(deployFixture);
        await expect(
          express.connect(user1).updateRedeemAsset(await usdo.getAddress())
        ).to.be.revertedWithCustomError(express, 'AccessControlUnauthorizedAccount');
      });
      it('should revert when address is zero', async function () {
        const { express, maintainer } = await loadFixture(deployFixture);
        await expect(
          express.connect(maintainer).updateRedeemAsset(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(express, 'InvalidAddress');
      });
      it('should revert when deposit queue is not empty', async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
        const MockERC20Factory = await ethers.getContractFactory('MockERC20');
        const newAsset = await MockERC20Factory.deploy('New Asset', 'NEW', 18);
        // Add a deposit request to make the queue non-empty
        const firstDepositMin = await express.firstDepositAmount();
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), firstDepositMin, user1.address);
        expect(await express.getDepositQueueLength()).to.be.gt(0);
        await expect(
          express.connect(maintainer).updateRedeemAsset(await newAsset.getAddress())
        ).to.be.revertedWithCustomError(express, 'QueuesNotEmpty');
      });
      it('should revert when pending redeem queue is not empty', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, oem, usdo, user1, maintainer } = fixture;
        const MockERC20Factory = await ethers.getContractFactory('MockERC20');
        const newAsset = await MockERC20Factory.deploy('New Asset', 'NEW', 18);
        // Deposit first to get tokens
        const depositAmount = ethers.parseUnits('5000', 18);
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, depositAmount);
        // Request redeem to populate pendingRedeemQueue
        const redeemAmount = await express.redeemMinimum();
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        expect(await express.getPendingRedeemQueueLength()).to.be.gt(0);
        await expect(
          express.connect(maintainer).updateRedeemAsset(await newAsset.getAddress())
        ).to.be.revertedWithCustomError(express, 'QueuesNotEmpty');
      });
      it('should revert when redeem queue is not empty', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, oem, usdo, user1, maintainer, operator } = fixture;
        const MockERC20Factory = await ethers.getContractFactory('MockERC20');
        const newAsset = await MockERC20Factory.deploy('New Asset', 'NEW', 18);
        // Deposit first to get tokens
        const depositAmount = ethers.parseUnits('5000', 18);
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, depositAmount);
        // Request redeem and advance to final redeem queue
        const redeemAmount = await express.redeemMinimum();
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        // Advance time past T+2 delay to allow processing pending redeems
        const delay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(delay + 1n);
        // Process pending redeems into final redeem queue
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        expect(await express.getRedeemQueueLength()).to.be.gt(0);
        await expect(
          express.connect(maintainer).updateRedeemAsset(await newAsset.getAddress())
        ).to.be.revertedWithCustomError(express, 'QueuesNotEmpty');
      });
      it('should succeed after all queues are drained', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, oem, usdo, user1, maintainer, operator } = fixture;
        const MockERC20Factory = await ethers.getContractFactory('MockERC20');
        const newAsset = await MockERC20Factory.deploy('New Asset', 'NEW', 18);
        // Deposit, process, redeem, process all queues to drain them
        const depositAmount = ethers.parseUnits('5000', 18);
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, depositAmount);
        const redeemAmount = await express.redeemMinimum();
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        const delay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(delay + 1n);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        await express.connect(operator).processRedeemQueue(1);
        // All queues should now be empty
        expect(await express.getDepositQueueLength()).to.equal(0);
        expect(await express.getPendingRedeemQueueLength()).to.equal(0);
        expect(await express.getRedeemQueueLength()).to.equal(0);
        // Now updateRedeemAsset should succeed
        await expect(
          express.connect(maintainer).updateRedeemAsset(await newAsset.getAddress())
        ).to.emit(express, 'UpdateRedeemAsset');
        expect(await express.redeemAsset()).to.equal(await newAsset.getAddress());
      });
      it('should not affect redeemEscrowBalance after changing redeemAsset', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, oem, usdo, user1, maintainer, operator, admin } = fixture;
        // Deposit to get tokens
        const depositAmount = ethers.parseUnits('5000', 18);
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, depositAmount);
        // Request redeem
        const redeemAmount = await express.redeemMinimum();
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        // Ban user1 before cancelling so refund goes to escrow
        const BANLIST_ROLE = await oem.BANLIST_ROLE();
        await oem.connect(admin).grantRole(BANLIST_ROLE, admin.address);
        await oem.connect(admin).banAddresses([user1.address]);
        // Cancel redeem — refund should go to escrow since user1 is banned
        const delay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(delay + 1n);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        await express.connect(maintainer).cancelRedeem(1);
        const escrowBalance = await express.redeemEscrowBalance(user1.address);
        expect(escrowBalance).to.be.gt(0);
        // Now change redeemAsset
        const MockERC20Factory = await ethers.getContractFactory('MockERC20');
        const newAsset = await MockERC20Factory.deploy('New Asset', 'NEW', 18);
        await express.connect(maintainer).updateRedeemAsset(await newAsset.getAddress());
        // Escrow balance should be unchanged (it's in HYBOND tokens, not redeemAsset)
        expect(await express.redeemEscrowBalance(user1.address)).to.equal(escrowBalance);
        // Unban and claim — should still work since escrow is in HYBOND tokens
        await oem.connect(admin).unbanAddresses([user1.address]);
        await express.connect(user1).claimRedeemEscrow(user1.address);
        expect(await express.redeemEscrowBalance(user1.address)).to.equal(0);
        expect(await oem.balanceOf(user1.address)).to.be.gt(0);
      });
      it('should not affect depositEscrowBalance after changing redeemAsset', async function () {
        const { express, oem, usdo, user1, maintainer, admin } = await loadFixture(deployFixture);
        // Deposit request
        const firstDepositMin = await express.firstDepositAmount();
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), firstDepositMin, user1.address);
        // Ban user1 before cancelling so refund goes to deposit escrow
        const BANLIST_ROLE = await oem.BANLIST_ROLE();
        await oem.connect(admin).grantRole(BANLIST_ROLE, admin.address);
        await oem.connect(admin).banAddresses([user1.address]);
        // Cancel deposit — refund should go to deposit escrow
        await express.connect(maintainer).cancelDeposit(1);
        const usdoAddr = await usdo.getAddress();
        const depositEscrow = await express.depositEscrowBalance(user1.address, usdoAddr);
        expect(depositEscrow).to.be.gt(0);
        // Change redeemAsset
        const MockERC20Factory = await ethers.getContractFactory('MockERC20');
        const newAsset = await MockERC20Factory.deploy('New Asset', 'NEW', 18);
        await express.connect(maintainer).updateRedeemAsset(await newAsset.getAddress());
        // Deposit escrow balance should be unchanged (keyed by original deposit asset)
        expect(await express.depositEscrowBalance(user1.address, usdoAddr)).to.equal(depositEscrow);
        // Unban and claim
        await oem.connect(admin).unbanAddresses([user1.address]);
        await express.connect(user1).claimDepositEscrow(user1.address, usdoAddr);
        expect(await express.depositEscrowBalance(user1.address, usdoAddr)).to.equal(0);
      });
    });
    describe('Management Fee Dilution on Redeem', function () {
      async function setupWithMgtFee(fixture: any) {
        const { express, usdo, user1, user2, oem, maintainer, operator } = fixture;
        // Deposit for user1 and user2
        const depositAmount = ethers.parseUnits('5000', 18);
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
        await express
          .connect(user2)
          .requestDeposit(await usdo.getAddress(), depositAmount, user2.address);
        await express.connect(maintainer).processDepositQueue(1, depositAmount);
        await express.connect(maintainer).processDepositQueue(1, depositAmount);
        // Set mgt fee rate and mint one daily fee to cause dilution
        await express.connect(maintainer).updateMgtFeeRate(300); // 3% annual
        const timeBuffer = await express.timeBuffer();
        await time.increase(timeBuffer);
        await express.connect(operator).updateEpoch();
        const mgtFeeTo = await express.mgtFeeTo();
        const mintedFee = await oem.balanceOf(mgtFeeTo);
        return { ...fixture, depositAmount, mintedFee };
      }
      it('should not change redeem amounts when no mgt fees exist (regression)', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, usdo, user1, oem, maintainer, operator } = fixture;
        const depositAmount = ethers.parseUnits('5000', 18);
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, depositAmount);
        const ratio = await express.sharesPerToken();
        expect(ratio).to.equal(ethers.parseUnits('1', 18));
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        const [, , , , redeemAssetAmt] = await express.getRedeemQueueInfo(0);
        expect(redeemAssetAmt).to.equal(trim(redeemAmount, TRIM_DECIMALS));
      });
      it('should match previewRedeem with actual processing when no state changes between', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, operator } = await setupWithMgtFee(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        // Preview before requesting
        const [previewFee, previewGross, previewNet] = await express.previewRedeem(redeemAmount);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        // Process immediately after delay (no intervening updateEpoch/deposits/cancels)
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        const [, , , , redeemAssetAmt, feeAssetAmt] = await express.getRedeemQueueInfo(0);
        expect(redeemAssetAmt).to.equal(previewGross);
        expect(feeAssetAmt).to.equal(previewFee);
      });
      it('should complete full E2E flow with mgt fees without revert', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, usdo, oem, operator } = await setupWithMgtFee(fixture);
        const ratio = await express.sharesPerToken();
        expect(ratio).to.be.lt(ethers.parseUnits('1', 18));
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        // redeemAssetAmt should be less than redeemAmount due to dilution
        const [, , , , redeemAssetAmt] = await express.getRedeemQueueInfo(0);
        expect(redeemAssetAmt).to.be.lt(redeemAmount);
        const userUsdoBefore = await usdo.balanceOf(user1.address);
        // processRedeemQueue should NOT revert — USDC requirement matches diluted amount
        await expect(express.connect(operator).processRedeemQueue(1)).to.emit(
          express,
          'ProcessRedeem'
        );
        const userUsdoAfter = await usdo.balanceOf(user1.address);
        expect(userUsdoAfter).to.be.gt(userUsdoBefore);
      });
      it('should calculate the exact diluted redeem amount after daily fee mint', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, operator } = await setupWithMgtFee(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        const ratioAtProcessing = await express.sharesPerToken();
        const expectedRedeemAssetAmt = trim(
          (redeemAmount * ratioAtProcessing) / ethers.parseUnits('1', 18),
          TRIM_DECIMALS
        );
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        const redeemDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(redeemDelay);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        const [, , queuedShareAmount, , redeemAssetAmt] = await express.getRedeemQueueInfo(0);
        expect(queuedShareAmount).to.equal(redeemAmount);
        expect(redeemAssetAmt).to.equal(expectedRedeemAssetAmt);
        expect(redeemAssetAmt).to.be.lt(redeemAmount);
      });
      it('should recalculate ratio on revert-then-reprocess after another daily fee mint', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, maintainer, operator } = await setupWithMgtFee(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        const withdrawDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(withdrawDelay);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        const [, , , , redeemAssetAmtFirst] = await express.getRedeemQueueInfo(0);
        // Revert to pending
        await express.connect(operator).revertRedeemToPending(0);
        // Mint another daily mgt fee to change the ratio further
        const timeBuffer = await express.timeBuffer();
        await time.increase(timeBuffer);
        await express.connect(operator).updateEpoch();
        // Reprocess — ratio should be recalculated from current state
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        const [, , , , redeemAssetAmtSecond] = await express.getRedeemQueueInfo(0);
        // Second processing should use a lower ratio (more dilution)
        expect(redeemAssetAmtSecond).to.be.lte(redeemAssetAmtFirst);
        // Original token amount preserved in queue
        const [, , queuedShareAmount] = await express.getRedeemQueueInfo(0);
        expect(queuedShareAmount).to.equal(redeemAmount);
      });
      it('should refund full token amount on cancelPendingRedeem even with mgt fee dilution', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, maintainer } = await setupWithMgtFee(fixture);
        const ratio = await express.sharesPerToken();
        expect(ratio).to.be.lt(ethers.parseUnits('1', 18));
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        const userBalanceBefore = await oem.balanceOf(user1.address);
        await express.connect(maintainer).cancelPendingRedeem(1);
        const userBalanceAfter = await oem.balanceOf(user1.address);
        // Full token amount refunded regardless of dilution ratio
        expect(userBalanceAfter).to.equal(userBalanceBefore + redeemAmount);
      });
      it('should clear pending redeem accounting on cancelPendingRedeem with mgt fee dilution', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, maintainer } = await setupWithMgtFee(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        const circulatingBefore = await express.circulatingSupply();
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        expect(await express.pendingRedeemInfo(user1.address)).to.equal(redeemAmount);
        expect(await express.getPendingRedeemQueueLength()).to.equal(1);
        // Circulating decreases by redeemAmount (totalRedeemQueueTokens incremented at requestRedeem time)
        expect(await express.circulatingSupply()).to.equal(circulatingBefore - redeemAmount);
        await express.connect(maintainer).cancelPendingRedeem(1);
        expect(await express.pendingRedeemInfo(user1.address)).to.equal(0);
        expect(await express.getPendingRedeemQueueLength()).to.equal(0);
        // Circulating restored after cancel
        expect(await express.circulatingSupply()).to.equal(circulatingBefore);
      });
      it('should refund full token amount and restore final queue accounting on cancelRedeem with mgt fee dilution', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, maintainer, operator } = await setupWithMgtFee(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        const circulatingBefore = await express.circulatingSupply();
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        const redeemDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(redeemDelay);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        const userBalanceBeforeCancel = await oem.balanceOf(user1.address);
        expect(await express.redeemInfo(user1.address)).to.equal(redeemAmount);
        expect(await express.totalRedeemQueueTokens()).to.equal(redeemAmount);
        expect(await express.circulatingSupply()).to.equal(circulatingBefore - redeemAmount);
        await express.connect(maintainer).cancelRedeem(1);
        expect(await express.redeemInfo(user1.address)).to.equal(0);
        expect(await express.totalRedeemQueueTokens()).to.equal(0);
        expect(await express.getRedeemQueueLength()).to.equal(0);
        expect(await express.circulatingSupply()).to.equal(circulatingBefore);
        expect(await oem.balanceOf(user1.address)).to.equal(userBalanceBeforeCancel + redeemAmount);
      });
      it('should NOT reprice pending redeems when a deposit is processed (ratio invariance)', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, usdo, user1, user2, oem, maintainer, operator } =
          await setupWithMgtFee(fixture);
        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        const [, previewBeforeDeposit] = await express.previewRedeem(redeemAmount);
        // Ratio is baked in at requestRedeem time
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);
        const depositAmount = ethers.parseUnits('5000', 18);
        await express
          .connect(user2)
          .requestDeposit(await usdo.getAddress(), depositAmount, user2.address);
        const ratioBeforeDeposit = await express.sharesPerToken();
        await express.connect(maintainer).processDepositQueue(1, depositAmount);
        const ratioAfterDeposit = await express.sharesPerToken();
        // Ratio is invariant after processDepositQueue (within rounding dust from pro-rata mint)
        expect(ratioAfterDeposit).to.be.closeTo(ratioBeforeDeposit, ethers.parseUnits('1', 12));
        const redeemDelay = 2n * 24n * 60n * 60n; // T+2 = 2 days
        await time.increase(redeemDelay);
        await express
          .connect(operator)
          .processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));
        const [, , , , redeemAssetAmtAfterDeposit] = await express.getRedeemQueueInfo(0);
        // Redeem amount matches preview (within rounding tolerance from mulDiv)
        // The ratio was baked in at requestRedeem time, so deposits don't affect it
        expect(redeemAssetAmtAfterDeposit).to.be.closeTo(
          previewBeforeDeposit,
          ethers.parseUnits('1', 12)
        );
      });
    });
    describe('changing trimDecimals mid-operation', function () {
      it('should apply new trimDecimals to subsequent operations', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, oem, user1, user2, usdo, maintainer, operator } = fixture;
        // trimDecimals = 3 from fixture
        // Deposit for user1
        const amount = ethers.parseUnits('5000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1, amount);
        const balance1 = await oem.balanceOf(user1.address);
        expect(balance1 % 10n ** 15n).to.equal(0); // trimmed to 3 decimals
        // Change to 6 decimals
        await express.connect(maintainer).updateTrimDecimals(6);
        // Deposit for user2
        await express.connect(user2).requestDeposit(await usdo.getAddress(), amount, user2.address);
        await express.connect(maintainer).processDepositQueue(1, amount);
        const balance2 = await oem.balanceOf(user2.address);
        expect(balance2 % 10n ** 12n).to.equal(0); // trimmed to 6 decimals
      });
    });
  });

  // WP-M7: queue-empty guards block fee/oracle/trim parameter changes that would
  // retroactively reprice queued requests.
  describe('WP-M7 — queue-empty guards on parameter changes', function () {
    async function makeDepositQueueNonEmpty(express: any, usdo: any, user1: any) {
      const firstDepositMin = await express.firstDepositAmount();
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), firstDepositMin, user1.address);
      expect(await express.getDepositQueueLength()).to.be.gt(0);
    }

    it('updateDepositFeeRate reverts when a queue is non-empty', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      await makeDepositQueueNonEmpty(express, usdo, user1);
      await expect(
        express.connect(maintainer).updateDepositFeeRate(50)
      ).to.be.revertedWithCustomError(express, 'QueuesNotEmpty');
    });

    it('updateRedeemFeeRate reverts when a queue is non-empty', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      await makeDepositQueueNonEmpty(express, usdo, user1);
      await expect(
        express.connect(maintainer).updateRedeemFeeRate(50)
      ).to.be.revertedWithCustomError(express, 'QueuesNotEmpty');
    });

    it('updateTrimDecimals reverts when a queue is non-empty', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      await makeDepositQueueNonEmpty(express, usdo, user1);
      await expect(express.connect(maintainer).updateTrimDecimals(6)).to.be.revertedWithCustomError(
        express,
        'QueuesNotEmpty'
      );
    });

    it('updateMaxStalePeriod reverts when a queue is non-empty', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      await makeDepositQueueNonEmpty(express, usdo, user1);
      await expect(
        express.connect(maintainer).updateMaxStalePeriod(60 * 60)
      ).to.be.revertedWithCustomError(express, 'QueuesNotEmpty');
    });

    it('updatePriceOracle reverts when a queue is non-empty', async function () {
      const { express, usdo, user1, maintainer, priceOracle } = await loadFixture(deployFixture);
      await makeDepositQueueNonEmpty(express, usdo, user1);
      await expect(
        express.connect(maintainer).updatePriceOracle(await priceOracle.getAddress())
      ).to.be.revertedWithCustomError(express, 'QueuesNotEmpty');
    });

    it('updateMgtFeeTo reverts when a queue is non-empty (queue check before fee check)', async function () {
      const { express, usdo, user1, user2, maintainer } = await loadFixture(deployFixture);
      await makeDepositQueueNonEmpty(express, usdo, user1);
      // totalMgtFeeUnclaimed == 0 here, so the queue guard is what trips
      await expect(
        express.connect(maintainer).updateMgtFeeTo(user2.address)
      ).to.be.revertedWithCustomError(express, 'QueuesNotEmpty');
    });
  });

  describe('Express <-> KycManager wiring', () => {
    it('initialize rejects zero kycManager', async () => {
      const fx = await loadFixture(deployExpressContracts);
      const ExpressFactory = await ethers.getContractFactory(
        'contracts/extension/Express.sol:Express'
      );

      await expect(
        upgrades.deployProxy(
          ExpressFactory,
          [
            await fx.oem.getAddress(),
            await fx.usdo.getAddress(),
            fx.treasury.address,
            fx.feeTo.address,
            fx.treasury.address, // mgtFeeTo
            fx.admin.address,
            await fx.assetRegistry.getAddress(),
            await fx.priceOracle.getAddress(),
            DEFAULT_MAX_STALE_PERIOD,
            {
              depositMinimum: ethers.parseUnits('100', 18),
              redeemMinimum: ethers.parseUnits('50', 18),
              firstDepositAmount: ethers.parseUnits('1000', 18),
            },
            ethers.ZeroAddress,
          ],
          { kind: 'uups', initializer: 'initialize' }
        )
      ).to.be.revertedWithCustomError(ExpressFactory, 'InvalidAddress');
    });

    it('exposes kycManager() and no longer has kycList/grantKycInBulk/revokeKycInBulk/WHITELIST_ROLE', async () => {
      const { express } = await loadFixture(deployExpressContracts);
      // Positive: kycManager view exists
      expect(typeof express.kycManager).to.equal('function');
      // Negative: removed selectors are gone from the ABI
      const fragments = express.interface.fragments as any[];
      expect(fragments.find((f) => f.name === 'kycList')).to.equal(undefined);
      expect(fragments.find((f) => f.name === 'grantKycInBulk')).to.equal(undefined);
      expect(fragments.find((f) => f.name === 'revokeKycInBulk')).to.equal(undefined);
      expect(fragments.find((f) => f.name === 'WHITELIST_ROLE')).to.equal(undefined);
    });

    it('setKycManager: requires DEFAULT_ADMIN_ROLE, rejects zero, emits event', async () => {
      const { express, admin, user1 } = await loadFixture(deployExpressContracts);
      const KycManagerFactory = await ethers.getContractFactory('KycManager');
      const newMgr = await upgrades.deployProxy(KycManagerFactory, [admin.address], {
        kind: 'uups',
        initializer: 'initialize',
      });
      await newMgr.waitForDeployment();

      await expect(
        express.connect(user1).setKycManager(await newMgr.getAddress())
      ).to.be.revertedWithCustomError(express, 'AccessControlUnauthorizedAccount');

      await expect(
        express.connect(admin).setKycManager(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(express, 'InvalidAddress');

      const old = await express.kycManager();
      await expect(express.connect(admin).setKycManager(await newMgr.getAddress()))
        .to.emit(express, 'KycManagerUpdated')
        .withArgs(old, await newMgr.getAddress());
    });

    it('setKycManager rotation is gated by empty queues (QueuesNotEmpty)', async () => {
      const { express, usdo, admin, user1, maintainer } = await loadFixture(deployExpressContracts);
      const KycManagerFactory = await ethers.getContractFactory('KycManager');
      const newMgr = await upgrades.deployProxy(KycManagerFactory, [admin.address], {
        kind: 'uups',
        initializer: 'initialize',
      });
      await newMgr.waitForDeployment();

      // depositQueue not empty -> rotation reverts QueuesNotEmpty
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), ethers.parseUnits('1000', 18), user1.address);

      await expect(
        express.connect(admin).setKycManager(await newMgr.getAddress())
      ).to.be.revertedWithCustomError(express, 'QueuesNotEmpty');

      // Drain queue
      await express.connect(maintainer).processDepositQueue(1, ethers.parseUnits('1000', 18));

      await expect(express.connect(admin).setKycManager(await newMgr.getAddress())).to.emit(
        express,
        'KycManagerUpdated'
      );
    });
  });
});
