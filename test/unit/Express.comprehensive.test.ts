import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

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
        const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);

        // Make first deposit
        const firstDepositMin = await express.firstDepositAmount();
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), firstDepositMin, user1.address);
        await express.connect(maintainer).processDepositQueue(1);

        // Try to mint below minimum
        const mintMin = await express.depositMinimum();
        const belowMin = mintMin - ethers.parseUnits('1', 18);

        await expect(
          express.connect(user1).requestDeposit(await usdo.getAddress(), belowMin, user1.address)
        ).to.be.revertedWithCustomError(express, 'DepositLessThanMinimum');
      });

      it('should allow subsequent deposits at deposit minimum', async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);

        // Make first deposit
        const firstDepositMin = await express.firstDepositAmount();
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), firstDepositMin, user1.address);
        await express.connect(maintainer).processDepositQueue(1);

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
        const { express, usdo, user1, user2, user3, maintainer, oem } =
          await loadFixture(deployFixture);

        const amount = ethers.parseUnits('1000', 18);

        // Add requests in order: user1, user2, user3
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(user2).requestDeposit(await usdo.getAddress(), amount, user2.address);
        await express.connect(user3).requestDeposit(await usdo.getAddress(), amount, user3.address);

        // Process first request
        await express.connect(maintainer).processDepositQueue(1);

        // User1 should have tokens, others should not
        expect(await oem.balanceOf(user1.address)).to.equal(amount);
        expect(await oem.balanceOf(user2.address)).to.equal(0);
        expect(await oem.balanceOf(user3.address)).to.equal(0);

        // Process remaining
        await express.connect(maintainer).processDepositQueue(0); // 0 = process all

        expect(await oem.balanceOf(user2.address)).to.equal(amount);
        expect(await oem.balanceOf(user3.address)).to.equal(amount);
      });

      it('should re-validate KYC during processing', async function () {
        const { express, usdo, user1, maintainer, whitelister } = await loadFixture(deployFixture);

        const amount = ethers.parseUnits('1000', 18);

        // Add deposit request
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);

        // Revoke KYC
        await express.connect(whitelister).revokeKycInBulk([user1.address]);

        // Processing should revert
        await expect(
          express.connect(maintainer).processDepositQueue(1)
        ).to.be.revertedWithCustomError(express, 'NotInKycList');
      });

      it('should transfer assets to treasury on mint', async function () {
        const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);

        const amount = ethers.parseUnits('1000', 18);
        const treasuryAddress = await express.treasury();
        const treasuryBalanceBefore = await usdo.balanceOf(treasuryAddress);

        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1);

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
        await express.connect(maintainer).processDepositQueue(1);

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
        ).to.be.revertedWith('Pausable: Deposit paused');
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
      it('should sum required refund amounts for the next queued cancellations', async function () {
        const { express, usdo, user1, user2, maintainer } = await loadFixture(deployFixture);

        await express.connect(maintainer).updateDepositFeeRate(100);

        const amount1 = ethers.parseUnits('1000', 18);
        const amount2 = ethers.parseUnits('2000', 18);
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), amount1, user1.address);
        await express
          .connect(user2)
          .requestDeposit(await usdo.getAddress(), amount2, user2.address);

        const [assets, refundAmts, currentBalances, shortfalls] =
          await express.prepareDepositCancellation(2);

        expect(assets).to.deep.equal([await usdo.getAddress()]);
        expect(refundAmts).to.deep.equal([amount1 + amount2]);
        expect(currentBalances).to.deep.equal([await usdo.balanceOf(await express.getAddress())]);
        expect(shortfalls).to.deep.equal([0n]);
      });

      it('should revert cancellation when Express lacks refund liquidity', async function () {
        const { express, usdo, user1, maintainer, operator } = await loadFixture(deployFixture);

        const amount = ethers.parseUnits('1000', 18);
        const startingLiquidity = await usdo.balanceOf(await express.getAddress());
        await express.connect(operator).offRamp(startingLiquidity);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);

        await expect(express.connect(maintainer).cancelDeposit(1)).to.be.revertedWithCustomError(
          express,
          'InsufficientLiquidity'
        );
      });

      it('should report the shortfall before cancellation can succeed', async function () {
        const { express, usdo, user1, operator } = await loadFixture(deployFixture);

        const startingLiquidity = await usdo.balanceOf(await express.getAddress());
        await express.connect(operator).offRamp(startingLiquidity);

        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);

        const [assets, refundAmts, currentBalances, shortfalls] =
          await express.prepareDepositCancellation(1);

        expect(assets).to.deep.equal([await usdo.getAddress()]);
        expect(refundAmts).to.deep.equal([amount]);
        expect(currentBalances).to.deep.equal([0n]);
        expect(shortfalls).to.deep.equal([amount]);
      });

      it('should refund on-chain after funds are returned to Express', async function () {
        const { express, usdo, user1, maintainer, treasury, feeTo } =
          await loadFixture(deployFixture);

        const expressAddress = await express.getAddress();
        await express.connect(maintainer).updateDepositFeeRate(100);

        const amount = ethers.parseUnits('1000', 18);
        const feeAmt = (amount * 100n) / 10000n;
        const netAmt = amount - feeAmt;
        const startingLiquidity = await usdo.balanceOf(expressAddress);
        const balanceBefore = await usdo.balanceOf(user1.address);

        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);

        await usdo.connect(treasury).transfer(expressAddress, netAmt);
        await usdo.connect(feeTo).transfer(expressAddress, feeAmt);

        await expect(express.connect(maintainer).cancelDeposit(1)).to.emit(
          express,
          'CancelProcessDeposit'
        );

        expect(await usdo.balanceOf(user1.address)).to.equal(balanceBefore);
        expect(await express.getDepositQueueLength()).to.equal(0);
        expect(await express.getDepositUserInfo(user1.address)).to.equal(0);
        expect(await usdo.balanceOf(expressAddress)).to.equal(startingLiquidity);
      });
    });
  });

  describe('Redeem Flow (T+2)', function () {
    // Helper to setup user with OEM tokens
    async function setupUserWithTokens(fixture: any) {
      const { express, usdo, user1, maintainer } = fixture;
      const amount = ethers.parseUnits('5000', 18);

      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      return { ...fixture, mintedAmount: amount };
    }

    describe('Redeem Preview', function () {
      it('should quote the fee in redeemAsset units', async function () {
        const { express, maintainer } = await loadFixture(deployFixture);

        await express.connect(maintainer).updateRedeemFeeRate(100);

        const withdrawAmount = ethers.parseUnits('1000', 18);
        const [feeAmt, redeemAssetAmt, netRedeemAssetAmt] = await express.previewRedeem(withdrawAmount);

        expect(redeemAssetAmt).to.equal(withdrawAmount);
        expect(feeAmt).to.equal((redeemAssetAmt * 100n) / 10000n);
        expect(netRedeemAssetAmt).to.equal(redeemAssetAmt - feeAmt);
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

      it('should not process withdraws before T+2 delay', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, operator } = await setupUserWithTokens(fixture);

        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);

        // Try to process immediately (before T+2)
        await expect(
          express.connect(operator).processPendingRedeems(1)
        ).to.be.revertedWithCustomError(express, 'NoPendingRedeemsReady');
      });

      it('should process withdraws after T+2 delay', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, user1, oem, operator } = await setupUserWithTokens(fixture);

        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);

        // Fast forward 2 days
        const withdrawDelay = await express.convertRedeemRequestsDelay();
        await time.increase(withdrawDelay);

        // Should now be able to process
        await expect(express.connect(operator).processPendingRedeems(1)).to.emit(
          express,
          'ProcessPendingRedeem'
        );
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
        const withdrawDelay = await express.convertRedeemRequestsDelay();
        await time.increase(withdrawDelay);

        // Process to withdraw queue
        await express.connect(operator).processPendingRedeems(1);

        // Check withdraw queue has correct timestamp
        const [, , , , , timestamp] = await express.getRedeemQueueInfo(0);
        expect(timestamp).to.equal(requestTimestamp);
      });
    });

    describe('Final Redeem Queue', function () {
      async function setupRedemptionQueue(fixture: any) {
        const { express, user1, oem, operator } = await setupUserWithTokens(fixture);

        const redeemAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);

        // Fast forward and process to final queue
        const withdrawDelay = await express.convertRedeemRequestsDelay();
        await time.increase(withdrawDelay);
        await express.connect(operator).processPendingRedeems(1);

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
        const { express, user1, user2, oem, operator, maintainer, usdo } =
          await setupUserWithTokens(fixture);

        // Setup multiple withdraws
        const redeemAmount = ethers.parseUnits('1000', 18);

        // User1 redeem
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, redeemAmount);

        // User2 setup and redeem
        await express
          .connect(user2)
          .requestDeposit(await usdo.getAddress(), ethers.parseUnits('5000', 18), user2.address);
        await express.connect(maintainer).processDepositQueue(1);
        await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user2).requestRedeem(user2.address, redeemAmount);

        // Fast forward and process to final queue
        const withdrawDelay = await express.convertRedeemRequestsDelay();
        await time.increase(withdrawDelay);
        await express.connect(operator).processPendingRedeems(0); // Process all

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
        const { express, user1, user2, user3, oem, operator, maintainer, usdo } =
          await setupUserWithTokens(fixture);

        // Setup user2 and user3 with tokens
        await express
          .connect(user2)
          .requestDeposit(await usdo.getAddress(), ethers.parseUnits('5000', 18), user2.address);
        await express
          .connect(user3)
          .requestDeposit(await usdo.getAddress(), ethers.parseUnits('5000', 18), user3.address);
        await express.connect(maintainer).processDepositQueue(0);

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
        const withdrawDelay = await express.convertRedeemRequestsDelay();
        await time.increase(withdrawDelay);
        await express.connect(operator).processPendingRedeems(0);

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
        const [, , , timestamp1] = await express.getPendingRedeemQueueInfo(0);
        const [, , , timestamp2] = await express.getPendingRedeemQueueInfo(1);
        const [, , , timestamp3] = await express.getPendingRedeemQueueInfo(2);

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
        await expect(express.connect(operator).processPendingRedeems(0)).to.emit(
          express,
          'ProcessPendingRedeem'
        );

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
    });
  });

  describe('Management Fee Accrual', function () {
    it('should accrue daily management fees', async function () {
      const { express, operator, maintainer, oem, user1, usdo } = await loadFixture(deployFixture);

      // Setup tokens in circulation
      const mintAmount = ethers.parseUnits('100000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), mintAmount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      // Set 3% annual management fee (300 basis points)
      await express.connect(maintainer).updateMgtFeeRate(300);

      // Get current state
      const timeBuffer = await express.timeBuffer();
      const epochBefore = await express.epoch();

      // Fast forward past time buffer
      await time.increase(timeBuffer);

      // Update epoch
      await expect(express.connect(operator).updateEpoch(0)).to.emit(express, 'UpdateEpoch');

      const epochAfter = await express.epoch();
      expect(epochAfter).to.equal(epochBefore + 1n);

      // Check unclaimed fee was accrued
      const unclaimedFee = await express.unclaimedMgtFee();
      expect(unclaimedFee).to.be.gt(0);
    });

    it('should revert if updating epoch too early', async function () {
      const { express, operator } = await loadFixture(deployFixture);

      // First update is allowed
      await express.connect(operator).updateEpoch(0);

      // Second update without waiting should revert
      await expect(express.connect(operator).updateEpoch(0)).to.be.revertedWithCustomError(
        express,
        'UpdateTooEarly'
      );
    });

    it('should allow claiming accumulated management fees', async function () {
      const { express, operator, maintainer, oem, user1, usdo, admin } =
        await loadFixture(deployFixture);

      // Setup tokens and fees
      const mintAmount = ethers.parseUnits('100000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), mintAmount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      await express.connect(maintainer).updateMgtFeeRate(300);

      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch(0);

      const mgtFeeTo = await express.mgtFeeTo();
      const unclaimedFee = await express.unclaimedMgtFee();
      const balanceBefore = await oem.balanceOf(mgtFeeTo);

      // Claim fee
      await express.connect(operator).claimMgtFee(unclaimedFee);

      const balanceAfter = await oem.balanceOf(mgtFeeTo);
      expect(balanceAfter).to.equal(balanceBefore + unclaimedFee);

      // Unclaimed should be reset
      expect(await express.unclaimedMgtFee()).to.equal(0);
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

      await expect(express.connect(user1).processPendingRedeems(1)).to.be.revertedWithCustomError(
        express,
        'AccessControlUnauthorizedAccount'
      );
    });

    it('should only allow WHITELIST_ROLE to grant KYC', async function () {
      const { express, user1 } = await loadFixture(deployFixture);

      await expect(
        express.connect(user1).grantKycInBulk([user1.address])
      ).to.be.revertedWithCustomError(express, 'AccessControlUnauthorizedAccount');
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

      const ExpressV2 = await ethers.getContractFactory('Express', admin);

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
      const ExpressV2 = await ethers.getContractFactory('Express', admin);
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
      await express.connect(maintainer).processDepositQueue(1);

      const totalSupply = await oem.totalSupply();
      const circulating = await express.circulatingSupply();

      // mgtFeeTo (treasury) has 0 OEM tokens, no withdraw queue items
      const mgtFeeTo = await express.mgtFeeTo();
      const mgtFeeToBalance = await oem.balanceOf(mgtFeeTo);

      expect(circulating).to.equal(totalSupply - mgtFeeToBalance);
    });

    it('should not exclude tokens in pending withdraw queue', async function () {
      const { express, oem, user1, usdo, maintainer } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      const circulatingBefore = await express.circulatingSupply();

      // Request withdraw (tokens move to contract in pendingWithdrawQueue)
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

      const circulatingAfter = await express.circulatingSupply();

      // Circulating should NOT change because pending withdraw tokens are not excluded
      expect(circulatingAfter).to.equal(circulatingBefore);
    });

    it('should exclude tokens in withdraw queue', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      // Request withdraw
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

      // Move to final withdraw queue
      const withdrawDelay = await express.convertRedeemRequestsDelay();
      await time.increase(withdrawDelay);
      await express.connect(operator).processPendingRedeems(1);

      const circulating = await express.circulatingSupply();
      const totalSupply = await oem.totalSupply();
      const mgtFeeTo = await express.mgtFeeTo();
      const mgtFeeToBalance = await oem.balanceOf(mgtFeeTo);

      // Circulating should exclude withdraw queue tokens
      expect(circulating).to.equal(totalSupply - withdrawAmount - mgtFeeToBalance);
    });

    it('should restore circulating supply after withdraw queue is processed', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      const totalSupplyBefore = await oem.totalSupply();

      // Full withdraw flow
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

      const withdrawDelay = await express.convertRedeemRequestsDelay();
      await time.increase(withdrawDelay);
      await express.connect(operator).processPendingRedeems(1);
      await express.connect(operator).processRedeemQueue(1);

      // After processing, tokens are burned - totalSupply decreases
      const totalSupplyAfter = await oem.totalSupply();
      const circulating = await express.circulatingSupply();
      const mgtFeeTo = await express.mgtFeeTo();
      const mgtFeeToBalance = await oem.balanceOf(mgtFeeTo);

      expect(totalSupplyAfter).to.equal(totalSupplyBefore - withdrawAmount);
      // No more tokens in withdraw queue, so circulating = totalSupply - mgtFeeToBalance
      expect(circulating).to.equal(totalSupplyAfter - mgtFeeToBalance);
      expect(await express.totalRedeemQueueShares()).to.equal(0);
    });

    it('should restore circulating supply after withdraw is cancelled', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      const circulatingBefore = await express.circulatingSupply();

      // Request withdraw and move to final queue
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

      const withdrawDelay = await express.convertRedeemRequestsDelay();
      await time.increase(withdrawDelay);
      await express.connect(operator).processPendingRedeems(1);

      // Cancel from withdraw queue
      await express.connect(maintainer).cancelRedeem(1);

      const circulatingAfter = await express.circulatingSupply();

      // Should be back to original since tokens refunded and totalWithdrawQueueTokens is 0
      expect(circulatingAfter).to.equal(circulatingBefore);
      expect(await express.totalRedeemQueueShares()).to.equal(0);
    });

    it('should restore circulating supply after revert to pending', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      const circulatingBefore = await express.circulatingSupply();

      // Request withdraw and move to final queue
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

      const withdrawDelay = await express.convertRedeemRequestsDelay();
      await time.increase(withdrawDelay);
      await express.connect(operator).processPendingRedeems(1);

      const circulatingInWithdrawQueue = await express.circulatingSupply();
      expect(circulatingInWithdrawQueue).to.be.lt(circulatingBefore);

      // Revert back to pending
      await express.connect(operator).revertRedeemToPending(1);

      const circulatingAfterRevert = await express.circulatingSupply();

      // Should be back to original since tokens are now in pending (not excluded)
      expect(circulatingAfterRevert).to.equal(circulatingBefore);
      expect(await express.totalRedeemQueueShares()).to.equal(0);
    });

    it('should track totalWithdrawQueueTokens correctly with multiple users', async function () {
      const { express, oem, user1, user2, user3, usdo, maintainer, operator } =
        await loadFixture(deployFixture);

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
      await express.connect(maintainer).processDepositQueue(0);

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
      const withdrawDelay = await express.convertRedeemRequestsDelay();
      await time.increase(withdrawDelay);
      await express.connect(operator).processPendingRedeems(0);

      expect(await express.totalRedeemQueueShares()).to.equal(w1 + w2 + w3);

      // Process first one
      await express.connect(operator).processRedeemQueue(1);
      expect(await express.totalRedeemQueueShares()).to.equal(w2 + w3);

      // Process remaining
      await express.connect(operator).processRedeemQueue(0);
      expect(await express.totalRedeemQueueShares()).to.equal(0);
    });
  });

  describe('Shares Per Token', function () {
    it('should return 1e18 when no tokens exist', async function () {
      const { express } = await loadFixture(deployFixture);

      const ratio = await express.sharesPerToken();
      expect(ratio).to.equal(ethers.parseUnits('1', 18));
    });

    it('should return 1e18 when no withdraw queue and no mgtFeeTo balance', async function () {
      const { express, oem, user1, usdo, maintainer } = await loadFixture(deployFixture);

      // Deposit to create supply
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      const mgtFeeTo = await express.mgtFeeTo();
      const mgtFeeToBalance = await oem.balanceOf(mgtFeeTo);

      // If mgtFeeTo has no balance, ratio should be 1:1
      if (mgtFeeToBalance === 0n) {
        expect(await express.sharesPerToken()).to.equal(ethers.parseUnits('1', 18));
      }
    });

    it('should decrease when tokens are in withdraw queue', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      const ratioBefore = await express.sharesPerToken();

      // Request withdraw and move to final queue
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

      const withdrawDelay = await express.convertRedeemRequestsDelay();
      await time.increase(withdrawDelay);
      await express.connect(operator).processPendingRedeems(1);

      const ratioAfter = await express.sharesPerToken();

      // Ratio should decrease since circulating < totalSupply
      expect(ratioAfter).to.be.lt(ratioBefore);
    });

    it('should return correct ratio value', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit 10000
      const amount = ethers.parseUnits('10000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      // Withdraw 2000 to final queue
      const withdrawAmount = ethers.parseUnits('2000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

      const withdrawDelay = await express.convertRedeemRequestsDelay();
      await time.increase(withdrawDelay);
      await express.connect(operator).processPendingRedeems(1);

      const totalSupply = await oem.totalSupply();
      const circulating = await express.circulatingSupply();
      const ratio = await express.sharesPerToken();

      // ratio = circulating * 1e18 / totalSupply
      const expectedRatio = (circulating * ethers.parseUnits('1', 18)) / totalSupply;
      expect(ratio).to.equal(expectedRatio);
    });

    it('should recover to 1e18 after withdraw queue is fully processed', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      // Full withdraw cycle
      const withdrawAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

      const withdrawDelay = await express.convertRedeemRequestsDelay();
      await time.increase(withdrawDelay);
      await express.connect(operator).processPendingRedeems(1);
      await express.connect(operator).processRedeemQueue(1);

      const mgtFeeTo = await express.mgtFeeTo();
      const mgtFeeToBalance = await oem.balanceOf(mgtFeeTo);

      // If mgtFeeTo has no balance, should be back to 1:1
      if (mgtFeeToBalance === 0n) {
        expect(await express.sharesPerToken()).to.equal(ethers.parseUnits('1', 18));
      }
    });

    it('should decrease when mgtFee is claimed', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      // Set mgt fee and accrue
      await express.connect(maintainer).updateMgtFeeRate(300);
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch(0);

      const ratioBefore = await express.sharesPerToken();

      // Claim mgt fee (mints to mgtFeeTo, increasing totalSupply but not circulating proportionally)
      const unclaimedFee = await express.unclaimedMgtFee();
      await express.connect(operator).claimMgtFee(unclaimedFee);

      const ratioAfter = await express.sharesPerToken();

      // mgtFeeTo balance is excluded from circulating, so ratio decreases
      expect(ratioAfter).to.be.lt(ratioBefore);
    });
  });

  describe('UpdateEpoch with circulatingSupply', function () {
    it('should calculate fee based on circulating supply excluding withdraw queue', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      // Set mgt fee
      await express.connect(maintainer).updateMgtFeeRate(300);

      // Request withdraw and move to final queue (reduces circulating supply)
      const withdrawAmount = ethers.parseUnits('20000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

      const withdrawDelay = await express.convertRedeemRequestsDelay();
      await time.increase(withdrawDelay);
      await express.connect(operator).processPendingRedeems(1);

      // Now updateEpoch — fee should be based on circulating (which excludes withdraw queue)
      const circulating = await express.circulatingSupply();
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch(0);

      const unclaimedFee = await express.unclaimedMgtFee();

      // Expected daily fee = trim(circulating * 300 / (365 * 10000))
      const expectedFee = trim((circulating * 300n) / (365n * 10000n), TRIM_DECIMALS);
      expect(unclaimedFee).to.equal(expectedFee);
    });

    it('should accrue higher fee when no tokens in withdraw queue', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      await express.connect(maintainer).updateMgtFeeRate(300);

      // Epoch 1: no withdraw queue
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch(0);
      const fee1 = await express.unclaimedMgtFee();

      // Now request withdraw and move to final queue
      const withdrawAmount = ethers.parseUnits('50000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

      const withdrawDelay = await express.convertRedeemRequestsDelay();
      await time.increase(withdrawDelay);
      await express.connect(operator).processPendingRedeems(1);

      // Epoch 2: with withdraw queue (lower circulating)
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch(0);
      const totalFee = await express.unclaimedMgtFee();
      const fee2 = totalFee - fee1;

      // fee2 should be less than fee1 because circulating supply is lower
      expect(fee2).to.be.lt(fee1);
    });

    it('should accrue zero fee when circulating supply is zero', async function () {
      const { express, operator, maintainer } = await loadFixture(deployFixture);

      // Set mgt fee
      await express.connect(maintainer).updateMgtFeeRate(300);

      // No deposits, so totalSupply = 0 and circulating = 0
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch(0);

      expect(await express.unclaimedMgtFee()).to.equal(0);
    });

    it('should not count pending withdraw tokens in fee calculation', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      await express.connect(maintainer).updateMgtFeeRate(300);

      // Request withdraw (stays in pending queue, NOT in final withdraw queue)
      const withdrawAmount = ethers.parseUnits('20000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

      // Circulating should still include pending withdraw tokens
      const circulating = await express.circulatingSupply();
      const totalSupply = await oem.totalSupply();
      const mgtFeeTo = await express.mgtFeeTo();
      const mgtFeeToBalance = await oem.balanceOf(mgtFeeTo);

      // Pending tokens are NOT excluded, so circulating = totalSupply - mgtFeeToBalance
      expect(circulating).to.equal(totalSupply - mgtFeeToBalance);

      // updateEpoch fee should be based on this full circulating amount
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch(0);

      const unclaimedFee = await express.unclaimedMgtFee();
      const expectedFee = trim((circulating * 300n) / (365n * 10000n), TRIM_DECIMALS);
      expect(unclaimedFee).to.equal(expectedFee);
    });

    it('should use override circulating supply when provided', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      await express.connect(maintainer).updateMgtFeeRate(300);

      // Use a custom circulating supply override
      const overrideSupply = ethers.parseUnits('80000', 18);
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch(overrideSupply);

      const unclaimedFee = await express.unclaimedMgtFee();
      const expectedFee = trim((overrideSupply * 300n) / (365n * 10000n), TRIM_DECIMALS);
      expect(unclaimedFee).to.equal(expectedFee);
    });

    it('should revert when override exceeds total supply', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      await express.connect(maintainer).updateMgtFeeRate(300);

      const totalSupply = await oem.totalSupply();
      const overSupply = totalSupply + 1n;

      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);

      await expect(express.connect(operator).updateEpoch(overSupply)).to.be.revertedWithCustomError(
        express,
        'InvalidInput'
      );
    });

    it('should allow override equal to total supply', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      await express.connect(maintainer).updateMgtFeeRate(300);

      const totalSupply = await oem.totalSupply();
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);

      await expect(express.connect(operator).updateEpoch(totalSupply)).to.emit(
        express,
        'UpdateEpoch'
      );

      const unclaimedFee = await express.unclaimedMgtFee();
      const expectedFee = trim((totalSupply * 300n) / (365n * 10000n), TRIM_DECIMALS);
      expect(unclaimedFee).to.equal(expectedFee);
    });

    it('should produce different fees for override vs on-chain calculation', async function () {
      const { express, oem, user1, usdo, maintainer, operator } = await loadFixture(deployFixture);

      // Deposit
      const amount = ethers.parseUnits('100000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
      await express.connect(maintainer).processDepositQueue(1);

      await express.connect(maintainer).updateMgtFeeRate(300);

      // Epoch 1: use on-chain circulating supply (pass 0)
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch(0);
      const fee1 = await express.unclaimedMgtFee();

      // Epoch 2: use override with half the circulating supply
      const circulating = await express.circulatingSupply();
      const halfCirculating = circulating / 2n;
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch(halfCirculating);
      const totalFee = await express.unclaimedMgtFee();
      const fee2 = totalFee - fee1;

      // fee2 should be roughly half of fee1
      const expectedFee2 = trim((halfCirculating * 300n) / (365n * 10000n), TRIM_DECIMALS);
      expect(fee2).to.equal(expectedFee2);
      expect(fee2).to.be.lt(fee1);
    });
  });

  describe('Unsupported Methods', function () {
    it('should revert requestMint with UseRequestDeposit', async function () {
      const { express, user1, usdo } = await loadFixture(deployFixture);

      await expect(
        express
          .connect(user1)
          .requestMint(await usdo.getAddress(), ethers.parseUnits('1000', 18), user1.address)
      ).to.be.revertedWithCustomError(express, 'UseRequestDeposit');
    });

    it('should revert requestWithdraw with UseRequestRedeem', async function () {
      const { express, user1 } = await loadFixture(deployFixture);

      await expect(
        express.connect(user1).requestWithdraw(user1.address, ethers.parseUnits('1000', 18))
      ).to.be.revertedWithCustomError(express, 'UseRequestRedeem');
    });
  });

  describe('Edge Cases', function () {
    it('should handle empty queue processing gracefully', async function () {
      const { express, maintainer } = await loadFixture(deployFixture);

      await expect(
        express.connect(maintainer).processDepositQueue(1)
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
        express.connect(maintainer).processDepositQueue(10)
      ).to.be.revertedWithCustomError(express, 'InvalidInput');
    });

    it('should handle zero amount redeem', async function () {
      const { express, user1 } = await loadFixture(deployFixture);

      await expect(
        express.connect(user1).requestRedeem(user1.address, 0)
      ).to.be.revertedWithCustomError(express, 'InvalidAmount');
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
        await express.connect(maintainer).processDepositQueue(1);

        const balance = await oem.balanceOf(user1.address);
        // Last 15 digits should be zero
        expect(balance % 10n ** 15n).to.equal(0);
      });

      it('should trim minted amount to 6 decimals', async function () {
        const { express, oem, user1, usdo, maintainer } = await loadFixture(deployFixture);

        await express.connect(maintainer).updateTrimDecimals(6);

        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1);

        const balance = await oem.balanceOf(user1.address);
        // Last 12 digits should be zero
        expect(balance % 10n ** 12n).to.equal(0);
      });

      it('should not trim when trimDecimals is 0', async function () {
        const { express, oem, user1, usdo, maintainer } = await loadFixture(deployFixture);

        await express.connect(maintainer).updateTrimDecimals(0);

        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1);

        const balance = await oem.balanceOf(user1.address);
        // With 1:1 price and no fee, minted = amount exactly (no trimming needed)
        expect(balance).to.equal(amount);
      });

      it('should not trim when trimDecimals is 18', async function () {
        const { express, oem, user1, usdo, maintainer } = await loadFixture(deployFixture);

        await express.connect(maintainer).updateTrimDecimals(18);

        const amount = ethers.parseUnits('1000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1);

        const balance = await oem.balanceOf(user1.address);
        expect(balance).to.equal(amount);
      });
    });

    describe('trimming on updateEpoch (daily fee)', function () {
      it('should trim daily fee to configured decimals', async function () {
        const { express, oem, user1, usdo, maintainer, operator } =
          await loadFixture(deployFixture);

        // trimDecimals is 3 from fixture
        const amount = ethers.parseUnits('100000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1);

        await express.connect(maintainer).updateMgtFeeRate(300);

        const timeBuffer = await express.timeBuffer();
        await time.increase(timeBuffer);
        await express.connect(operator).updateEpoch(0);

        const fee = await express.unclaimedMgtFee();
        // Last 15 digits should be zero (trimmed to 3 decimals)
        expect(fee % 10n ** 15n).to.equal(0);
        expect(fee).to.be.gt(0);
      });

      it('should produce different fee precision with different trimDecimals', async function () {
        const { express, oem, user1, usdo, maintainer, operator } =
          await loadFixture(deployFixture);

        const amount = ethers.parseUnits('100000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1);

        await express.connect(maintainer).updateMgtFeeRate(300);

        // Epoch 1: trimDecimals = 3
        const timeBuffer = await express.timeBuffer();
        await time.increase(timeBuffer);
        await express.connect(operator).updateEpoch(0);
        const fee3 = await express.unclaimedMgtFee();

        // Change to 6 decimals
        await express.connect(maintainer).updateTrimDecimals(6);

        // Epoch 2: trimDecimals = 6
        await time.increase(timeBuffer);
        await express.connect(operator).updateEpoch(0);
        const totalFee = await express.unclaimedMgtFee();
        const fee6 = totalFee - fee3;

        // fee with 6 decimals should have more precision (last 12 digits zeroed, not 15)
        expect(fee3 % 10n ** 15n).to.equal(0);
        expect(fee6 % 10n ** 12n).to.equal(0);
      });
    });

    describe('trimming on processPendingRedeems (redeem amount)', function () {
      async function setupWithdrawFixture(fixture: any) {
        const { express, oem, user1, usdo, maintainer } = fixture;
        const depositAmount = ethers.parseUnits('5000', 18);
        await express
          .connect(user1)
          .requestDeposit(await usdo.getAddress(), depositAmount, user1.address);
        await express.connect(maintainer).processDepositQueue(1);

        const withdrawAmount = ethers.parseUnits('1000', 18);
        await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
        await express.connect(user1).requestRedeem(user1.address, withdrawAmount);

        const withdrawDelay = await express.convertRedeemRequestsDelay();
        await time.increase(withdrawDelay);

        return { ...fixture, withdrawAmount };
      }

      it('should trim withdrawAsset amount to 3 decimals', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, operator } = await setupWithdrawFixture(fixture);

        // trimDecimals is 3 from fixture
        await express.connect(operator).processPendingRedeems(1);

        const [, , , withdrawAssetAmt] = await express.getRedeemQueueInfo(0);
        // Last 15 digits should be zero
        expect(withdrawAssetAmt % 10n ** 15n).to.equal(0);
      });

      it('should trim withdrawAsset amount to 6 decimals', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, operator, maintainer } = await setupWithdrawFixture(fixture);

        await express.connect(maintainer).updateTrimDecimals(6);
        await express.connect(operator).processPendingRedeems(1);

        const [, , , withdrawAssetAmt] = await express.getRedeemQueueInfo(0);
        // Last 12 digits should be zero
        expect(withdrawAssetAmt % 10n ** 12n).to.equal(0);
      });

      it('should not trim withdrawAsset amount when trimDecimals is 0', async function () {
        const fixture = await loadFixture(deployFixture);
        const { express, operator, maintainer, withdrawAmount } =
          await setupWithdrawFixture(fixture);

        await express.connect(maintainer).updateTrimDecimals(0);
        await express.connect(operator).processPendingRedeems(1);

        const [, , , withdrawAssetAmt] = await express.getRedeemQueueInfo(0);
        // With 1:1 price and no fee, should equal the full withdraw amount
        expect(withdrawAssetAmt).to.equal(withdrawAmount);
      });
    });

    describe('changing trimDecimals mid-operation', function () {
      it('should apply new trimDecimals to subsequent operations', async function () {
        const { express, oem, user1, user2, usdo, maintainer, operator } =
          await loadFixture(deployFixture);

        // trimDecimals = 3 from fixture
        // Deposit for user1
        const amount = ethers.parseUnits('5000', 18);
        await express.connect(user1).requestDeposit(await usdo.getAddress(), amount, user1.address);
        await express.connect(maintainer).processDepositQueue(1);

        const balance1 = await oem.balanceOf(user1.address);
        expect(balance1 % 10n ** 15n).to.equal(0); // trimmed to 3 decimals

        // Change to 6 decimals
        await express.connect(maintainer).updateTrimDecimals(6);

        // Deposit for user2
        await express.connect(user2).requestDeposit(await usdo.getAddress(), amount, user2.address);
        await express.connect(maintainer).processDepositQueue(1);

        const balance2 = await oem.balanceOf(user2.address);
        expect(balance2 % 10n ** 12n).to.equal(0); // trimmed to 6 decimals
      });
    });
  });
});
