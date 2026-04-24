import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);
const LARGE_TOTAL_ASSET = ethers.parseUnits('10000000', 18);

describe('Express - SharePerToken & Queue Processing Order', function () {
  async function deployFixture() {
    return deployExpressContracts();
  }

  // Helper: deposit USDC for a user and process the deposit queue
  async function depositFor(fixture: any, user: any, amount: bigint) {
    const { express, usdo, maintainer } = fixture;
    await express.connect(user).requestDeposit(await usdo.getAddress(), amount, user.address);
    await express.connect(maintainer).processDepositQueue(1, amount);
  }

  // Helper: request redeem and move to pending queue
  async function requestRedeemFor(fixture: any, user: any, amount: bigint) {
    const { express, oem } = fixture;
    await oem.connect(user).approve(await express.getAddress(), ethers.MaxUint256);
    await express.connect(user).requestRedeem(user.address, amount);
  }

  // Helper: advance past T+2 delay and process pending redeems
  async function processPendingRedeemsAfterDelay(fixture: any, len?: bigint) {
    const { express, operator } = fixture;
    await time.increase(2n * 24n * 60n * 60n); // T+2 = 2 days
    const queueLen: bigint = await express.getPendingRedeemQueueLength();
    await express.connect(operator).processPendingRedeems(len ?? queueLen, LARGE_TOTAL_ASSET);
  }

  // =========================================================================
  // 1. Bootstrap / full-exit: denom == 0 -> returns 1e18
  // =========================================================================
  describe('Bootstrap and full exit (denom == 0)', function () {
    it('returns 1e18 before any deposits (totalSupply == 0)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express } = fixture;

      // No tokens minted yet — denom = totalSupply - totalRedeemQueueTokens = 0
      expect(await express.sharesPerToken()).to.equal(ONE);
    });

    it('returns 1e18 after all tokens have been fully redeemed and burned', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, operator } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      const userBalance = await oem.balanceOf(fixture.user1.address);

      await requestRedeemFor(fixture, fixture.user1, userBalance);
      await processPendingRedeemsAfterDelay(fixture, 1n);
      await express.connect(operator).processRedeemQueue(1);

      // totalSupply == 0 -> denom == 0 -> ratio == 1e18
      expect(await oem.totalSupply()).to.equal(0n);
      expect(await express.sharesPerToken()).to.equal(ONE);
    });
  });

  // =========================================================================
  // 2. offchainShares == 0 (pre-sync): returns the 1e18 fallback
  // =========================================================================
  describe('offchainShares == 0 (pre-sync)', function () {
    it('returns 1e18 fallback when offchainShares is 0, even with denom > 0', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, maintainer } = fixture;

      // Bootstrap deposit: mints tokens at the 1:1 fallback, totalSupply becomes > 0.
      await depositFor(fixture, fixture.user1, ethers.parseUnits('10000', 18));

      // After processDepositQueue, offchainShares > 0 (auto-set by the two-pass logic).
      // Force offchainShares to 0 to test fallback:
      await express.connect(maintainer).updateOffchainShares(0);

      expect(await express.offchainShares()).to.equal(0n);
      expect(await express.sharesPerToken()).to.equal(ONE);
    });
  });

  // =========================================================================
  // 3. Three ratio regimes: ratio == 1, ratio < 1, ratio > 1
  // =========================================================================
  describe('General formula: mulDiv(offchainShares, 1e18, denom)', function () {
    it('returns 1e18 when offchainShares == denom (ratio = 1)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express } = fixture;

      const depositAmount = ethers.parseUnits('10000', 18);
      await depositFor(fixture, fixture.user1, depositAmount);

      // processDepositQueue sets offchainShares = depositAmount, totalSupply = depositAmount
      // ratio = depositAmount / depositAmount = 1e18
      expect(await express.sharesPerToken()).to.equal(ONE);
    });

    it('returns < 1e18 when offchainShares < denom (fee dilution scenario)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, maintainer } = fixture;

      const depositAmount = ethers.parseUnits('10000', 18);
      await depositFor(fixture, fixture.user1, depositAmount);

      const totalSupply = await oem.totalSupply();
      // Set offchainShares to 90% of totalSupply (simulating 10% fee dilution)
      const offchain = (totalSupply * 9n) / 10n;
      await express.connect(maintainer).updateOffchainShares(offchain);

      const ratio = await express.sharesPerToken();
      expect(ratio).to.be.lt(ONE);

      // Verify exact formula: mulDiv(offchain, 1e18, totalSupply)
      const expected = (offchain * ONE) / totalSupply;
      // Allow 1 wei rounding tolerance from mulDiv
      expect(ratio).to.be.closeTo(expected, 1n);
    });

    it('returns > 1e18 when offchainShares > denom (BNY grew faster than supply)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, maintainer } = fixture;

      const depositAmount = ethers.parseUnits('10000', 18);
      await depositFor(fixture, fixture.user1, depositAmount);

      const totalSupply = await oem.totalSupply();
      // Set offchainShares to 110% of totalSupply (BNY fund grew 10% above par)
      const offchain = (totalSupply * 11n) / 10n;
      await express.connect(maintainer).updateOffchainShares(offchain);

      const ratio = await express.sharesPerToken();
      expect(ratio).to.be.gt(ONE);

      // Verify exact formula: mulDiv(offchain, 1e18, totalSupply)
      const expected = (offchain * ONE) / totalSupply;
      expect(ratio).to.be.closeTo(expected, 1n);
    });
  });

  // =========================================================================
  // 4. Ratio drops after updateEpoch fee mint (offchainShares constant)
  // =========================================================================
  describe('Fee accrual via updateEpoch', function () {
    it('ratio drops after updateEpoch mints new HYBOND tokens (denom grows, offchainShares constant)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, maintainer, operator } = fixture;

      const depositAmount = ethers.parseUnits('100000', 18);
      await depositFor(fixture, fixture.user1, depositAmount);

      const totalSupplyBefore = await oem.totalSupply();
      expect(await express.sharesPerToken()).to.equal(ONE);

      // Accrue one epoch of management fee (3% annual)
      await express.connect(maintainer).updateMgtFeeRate(300);
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();

      const totalSupplyAfter = await oem.totalSupply();
      expect(totalSupplyAfter).to.be.gt(totalSupplyBefore);

      // offchainShares is unchanged; denom (totalSupply - totalRedeemQueueTokens) grew
      const ratioAfter = await express.sharesPerToken();
      expect(ratioAfter).to.be.lt(ONE);

      // Verify formula: mulDiv(offchainShares, 1e18, totalSupplyAfter)
      const expected = (totalSupplyBefore * ONE) / totalSupplyAfter;
      expect(ratioAfter).to.be.closeTo(expected, 1n);
    });

    it('ratio does not change when updateEpoch is called with mgtFeeRate == 0', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express } = fixture;

      const depositAmount = ethers.parseUnits('10000', 18);
      await depositFor(fixture, fixture.user1, depositAmount);

      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.equal(ONE);

      // updateEpoch should revert when mgtFeeRate == 0 (no epoch, no ratio change)
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await expect(
        fixture.express.connect(fixture.operator).updateEpoch()
      ).to.be.revertedWithCustomError(express, 'MgtFeeDisabled');

      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });

  // =========================================================================
  // 5. Ratio invariance: requestRedeem preserves ratio
  // =========================================================================
  describe('requestRedeem: ratio is invariant', function () {
    it('ratio unchanged after requestRedeem (offchainShares and totalRedeemQueueTokens both adjusted)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, maintainer } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('100000', 18));

      // Set offchainShares to 90% of totalSupply (diluted scenario)
      const totalSupplyBefore = await oem.totalSupply();
      const offchain = (totalSupplyBefore * 9n) / 10n;
      await express.connect(maintainer).updateOffchainShares(offchain);
      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.be.lt(ONE);

      // Request redeem
      const redeemAmount = ethers.parseUnits('10000', 18);
      await requestRedeemFor(fixture, fixture.user1, redeemAmount);

      // Ratio is invariant — offchainShares decreased proportionally to totalRedeemQueueTokens increase
      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });

  // =========================================================================
  // 6. Ratio unchanged by processRedeemQueue burn
  //    (totalSupply and totalRedeemQueueTokens drop by the same amount)
  // =========================================================================
  describe('processRedeemQueue burn: ratio is invariant', function () {
    it('ratio is unchanged when processRedeemQueue burns tokens (totalSupply and totalRedeemQueueTokens drop equally)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, operator, maintainer } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('100000', 18));

      // Set offchainShares to 90% of totalSupply
      const totalSupply = await oem.totalSupply();
      const offchain = (totalSupply * 9n) / 10n;
      await express.connect(maintainer).updateOffchainShares(offchain);

      // Move a redeem through pending->final queue
      const redeemAmount = ethers.parseUnits('10000', 18);
      await requestRedeemFor(fixture, fixture.user1, redeemAmount);

      const ratioAfterRequest = await express.sharesPerToken();

      await processPendingRedeemsAfterDelay(fixture, 1n);

      const ratioAfterPending = await express.sharesPerToken();
      // Ratio unchanged after pending->final (no accounting changes)
      expect(ratioAfterPending).to.equal(ratioAfterRequest);

      // processRedeemQueue burns: totalSupply -= tokenAmount, totalRedeemQueueTokens -= tokenAmount
      // denom unchanged, ratio unchanged
      await express.connect(operator).processRedeemQueue(1);

      const ratioAfterBurn = await express.sharesPerToken();
      expect(ratioAfterBurn).to.equal(ratioAfterPending);
    });

    it('ratio is unchanged across the full redeem cycle: request->pending->final->burn', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, operator } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('50000', 18));
      await depositFor(fixture, fixture.user2, ethers.parseUnits('50000', 18));

      const ratioInitial = await express.sharesPerToken();

      // user1 redeems
      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));

      // Ratio unchanged after requestRedeem
      expect(await express.sharesPerToken()).to.equal(ratioInitial);

      await processPendingRedeemsAfterDelay(fixture, 1n);

      // Ratio unchanged after pending->final
      expect(await express.sharesPerToken()).to.equal(ratioInitial);

      // Now process the final queue burn
      await express.connect(operator).processRedeemQueue(1);

      // Ratio still unchanged after burn
      expect(await express.sharesPerToken()).to.equal(ratioInitial);
    });
  });

  // =========================================================================
  // 7. Cancel pending redeem: ratio unaffected
  // =========================================================================
  describe('Cancel Pending Redeem & SharePerToken', function () {
    it('should not affect sharesPerToken when cancelling pending redeems', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, maintainer } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));

      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.equal(ONE);

      // Request redeem (ratio unchanged due to invariance)
      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));
      expect(await express.sharesPerToken()).to.equal(ratioBefore);

      // Cancel — reverse of requestRedeem, ratio still unchanged
      await express.connect(maintainer).cancelPendingRedeem(1);
      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });

    it('should restore user token balance after cancelling pending redeem', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, maintainer } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      const balanceBefore = await oem.balanceOf(fixture.user1.address);

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));
      expect(await oem.balanceOf(fixture.user1.address)).to.equal(
        balanceBefore - ethers.parseUnits('1000', 18)
      );

      await express.connect(maintainer).cancelPendingRedeem(1);
      expect(await oem.balanceOf(fixture.user1.address)).to.equal(balanceBefore);
    });

    it('should allow user to redeem again after cancel', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, maintainer } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));
      await express.connect(maintainer).cancelPendingRedeem(1);
      expect(await express.getPendingRedeemQueueLength()).to.equal(0n);

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));
      await processPendingRedeemsAfterDelay(fixture, 1n);

      expect(await express.getRedeemQueueLength()).to.equal(1n);
    });

    it('should cancel multiple pending redeems from different users', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, maintainer } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      await depositFor(fixture, fixture.user2, ethers.parseUnits('5000', 18));

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));
      await requestRedeemFor(fixture, fixture.user2, ethers.parseUnits('2000', 18));

      expect(await express.getPendingRedeemQueueLength()).to.equal(2n);

      const user1BalBefore = await oem.balanceOf(fixture.user1.address);
      const user2BalBefore = await oem.balanceOf(fixture.user2.address);

      await express.connect(maintainer).cancelPendingRedeem(0);

      expect(await express.getPendingRedeemQueueLength()).to.equal(0n);
      expect(await oem.balanceOf(fixture.user1.address)).to.equal(
        user1BalBefore + ethers.parseUnits('1000', 18)
      );
      expect(await oem.balanceOf(fixture.user2.address)).to.equal(
        user2BalBefore + ethers.parseUnits('2000', 18)
      );
    });
  });

  // =========================================================================
  // 8. Queue processing order
  // =========================================================================
  describe('Queue Processing Order Impact', function () {
    it('ratio stays constant after processDepositQueue (ratio invariance)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, usdo, maintainer, operator } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('10000', 18));

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));

      const ratioBefore = await express.sharesPerToken();

      // user2 requests deposit
      const depositAmount = ethers.parseUnits('50000', 18);
      await express
        .connect(fixture.user2)
        .requestDeposit(await usdo.getAddress(), depositAmount, fixture.user2.address);

      const delay = 2n * 24n * 60n * 60n;
      await time.increase(delay);

      await express.connect(maintainer).processDepositQueue(1, depositAmount);

      // Ratio is invariant after processDepositQueue
      expect(await express.sharesPerToken()).to.equal(ratioBefore);

      await express.connect(operator).processPendingRedeems(1, LARGE_TOTAL_ASSET);

      expect(await express.getRedeemQueueLength()).to.equal(1n);
    });

    it('ratio stays constant after processDepositQueue even when offchainShares == denom', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, usdo, maintainer } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('10000', 18));

      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.equal(ONE);

      await express
        .connect(fixture.user2)
        .requestDeposit(
          await usdo.getAddress(),
          ethers.parseUnits('5000', 18),
          fixture.user2.address
        );

      await express.connect(maintainer).processDepositQueue(1, ethers.parseUnits('5000', 18));

      // After deposit: ratio should be invariant
      const ratioAfterDeposit = await express.sharesPerToken();
      expect(ratioAfterDeposit).to.equal(ONE);
    });
  });

  // =========================================================================
  // 9. Additional edge cases
  // =========================================================================
  describe('Edge Cases', function () {
    it('should handle full redeem of all circulating tokens', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, operator } = fixture;

      const depositAmount = ethers.parseUnits('5000', 18);
      await depositFor(fixture, fixture.user1, depositAmount);

      const userBalance = await oem.balanceOf(fixture.user1.address);
      await requestRedeemFor(fixture, fixture.user1, userBalance);
      await processPendingRedeemsAfterDelay(fixture, 1n);
      await express.connect(operator).processRedeemQueue(1);

      expect(await oem.balanceOf(fixture.user1.address)).to.equal(0n);
    });

    it('should correctly track totalRedeemQueueTokens across multiple operations', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, operator } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('10000', 18));
      await depositFor(fixture, fixture.user2, ethers.parseUnits('10000', 18));

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('2000', 18));
      await requestRedeemFor(fixture, fixture.user2, ethers.parseUnits('3000', 18));

      // totalRedeemQueueTokens is incremented at requestRedeem time
      expect(await express.totalRedeemQueueTokens()).to.equal(ethers.parseUnits('5000', 18));

      await processPendingRedeemsAfterDelay(fixture);

      // totalRedeemQueueTokens unchanged after pending->final
      expect(await express.totalRedeemQueueTokens()).to.equal(ethers.parseUnits('5000', 18));

      await express.connect(operator).processRedeemQueue(1);

      // Decremented after processRedeemQueue burn
      expect(await express.totalRedeemQueueTokens()).to.equal(ethers.parseUnits('3000', 18));
    });

    it('should handle processPendingRedeems with queue length (process all)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      await depositFor(fixture, fixture.user2, ethers.parseUnits('5000', 18));

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));
      await requestRedeemFor(fixture, fixture.user2, ethers.parseUnits('2000', 18));

      expect(await express.getPendingRedeemQueueLength()).to.equal(2n);

      const delay = 2n * 24n * 60n * 60n;
      await time.increase(delay);

      const queueLen: bigint = await express.getPendingRedeemQueueLength();
      await express.connect(fixture.operator).processPendingRedeems(queueLen, LARGE_TOTAL_ASSET);

      expect(await express.getPendingRedeemQueueLength()).to.equal(0n);
      expect(await express.getRedeemQueueLength()).to.equal(2n);
    });

    it('should revert processPendingRedeems when queue is empty', async function () {
      const { express, operator } = await loadFixture(deployFixture);

      await expect(
        express.connect(operator).processPendingRedeems(1, LARGE_TOTAL_ASSET)
      ).to.be.revertedWithCustomError(express, 'NoPendingRedeemsReady');
    });

    it('should handle the full SOP order: processDepositQueue -> updateEpoch -> processPendingRedeems -> processRedeemQueue', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, usdo, maintainer, operator, oem } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('50000', 18));

      await express.connect(maintainer).updateMgtFeeRate(300);

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      await express
        .connect(fixture.user2)
        .requestDeposit(
          await usdo.getAddress(),
          ethers.parseUnits('30000', 18),
          fixture.user2.address
        );

      const delay = 2n * 24n * 60n * 60n;
      await time.increase(delay);

      // Step 1: processDepositQueue
      await express.connect(maintainer).processDepositQueue(1, ethers.parseUnits('30000', 18));

      // Step 2: updateEpoch (mints fee, grows totalSupply, drops ratio)
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();

      // Step 3: processPendingRedeems
      await express.connect(operator).processPendingRedeems(1, LARGE_TOTAL_ASSET);

      // Step 4: processRedeemQueue
      const user1UsdcBefore = await fixture.usdo.balanceOf(fixture.user1.address);
      await express.connect(operator).processRedeemQueue(1);
      const user1UsdcAfter = await fixture.usdo.balanceOf(fixture.user1.address);

      expect(user1UsdcAfter).to.be.gt(user1UsdcBefore);
      expect(await express.getRedeemQueueLength()).to.equal(0n);
    });
  });
});
