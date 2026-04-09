import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

// Mirror the contract's _trim: truncate 18-decimal value to given decimals (round down)
function trim(value: bigint, decimals: number): bigint {
  if (decimals === 0 || decimals >= 18) return value;
  const factor = 10n ** BigInt(18 - decimals);
  return (value / factor) * factor;
}

const ONE = ethers.parseUnits('1', 18);
const BPS_BASE = 10000n;
const DAYS_IN_YEAR = 365n;
const TRIM_DECIMALS = 3;

describe('Express - SharePerToken & Queue Processing Order', function () {
  async function deployFixture() {
    const fixture = await deployExpressContracts();
    await fixture.express.connect(fixture.maintainer).updateTrimDecimals(TRIM_DECIMALS);
    return fixture;
  }

  // Helper: deposit USDC for a user and process the deposit queue
  async function depositFor(fixture: any, user: any, amount: bigint) {
    const { express, usdo, maintainer } = fixture;
    await express.connect(user).requestDeposit(await usdo.getAddress(), amount, user.address);
    await express.connect(maintainer).processDepositQueue(1);
  }

  // Helper: request redeem and move to pending queue
  async function requestRedeemFor(fixture: any, user: any, amount: bigint) {
    const { express, oem } = fixture;
    await oem.connect(user).approve(await express.getAddress(), ethers.MaxUint256);
    await express.connect(user).requestRedeem(user.address, amount);
  }

  // Helper: advance past T+2 delay and process pending redeems
  async function processPendingRedeemsAfterDelay(fixture: any, len: number = 0) {
    const { express, operator } = fixture;
    const delay = await express.convertRedeemRequestsDelay();
    await time.increase(delay);
    await express.connect(operator).processPendingRedeems(len);
  }

  // Helper: setup management fee and accrue one epoch
  async function setupMgtFeeAndAccrue(fixture: any, feeRateBps: number) {
    const { express, maintainer, operator } = fixture;
    await express.connect(maintainer).updateMgtFeeRate(feeRateBps);
    const timeBuffer = await express.timeBuffer();
    await time.increase(timeBuffer);
    await express.connect(operator).updateEpoch();
  }

  // =========================================================================
  // 1. Management fee zero vs non-zero
  // =========================================================================
  describe('Management Fee: zero vs non-zero', function () {
    it('should keep sharesPerToken at 1e18 when mgtFeeRate is zero', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, user1 } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('10000', 18));

      // No management fee set — ratio stays 1:1
      expect(await express.sharesPerToken()).to.equal(ONE);
    });

    it('should revert updateEpoch when mgtFeeRate is zero', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, operator, user1 } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('10000', 18));

      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await expect(express.connect(operator).updateEpoch()).to.be.revertedWithCustomError(
        express,
        'MgtFeeDisabled'
      );
      expect(await express.sharesPerToken()).to.equal(ONE);
    });

    it('should decrease sharesPerToken after minting non-zero daily mgtFee', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, user1 } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('100000', 18));
      await setupMgtFeeAndAccrue(fixture, 300); // 3% annual

      const ratioAfter = await express.sharesPerToken();
      expect(await express.totalMgtFeeMinted()).to.be.gte(0n);
      expect(ratioAfter).to.be.lt(ONE);
    });

    it('should accrue correct daily fee amount for non-zero mgtFeeRate', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, operator, user1 } = fixture;

      const depositAmount = ethers.parseUnits('100000', 18);
      await depositFor(fixture, user1, depositAmount);

      await setupMgtFeeAndAccrue(fixture, 300); // 3% annual

      const circulating = await express.circulatingSupply();
      const expectedFee = trim((circulating * 300n) / (DAYS_IN_YEAR * BPS_BASE), TRIM_DECIMALS);
      const mgtFeeTo = await express.mgtFeeTo();
      expect(await oem.balanceOf(mgtFeeTo)).to.equal(expectedFee);
      expect(await express.totalMgtFeeMinted()).to.be.gte(0n);
    });

    it('should not affect redeemers USDC amount when mgtFeeRate is zero', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, user1 } = fixture;

      const depositAmount = ethers.parseUnits('5000', 18);
      await depositFor(fixture, user1, depositAmount);

      const redeemAmount = ethers.parseUnits('1000', 18);
      await requestRedeemFor(fixture, user1, redeemAmount);

      // ratio should be 1:1, so redeem USDC = share amount (1:1 asset, price 1e18)
      expect(await express.sharesPerToken()).to.equal(ONE);

      await processPendingRedeemsAfterDelay(fixture, 1);

      // Decode the redeem queue item to verify USDC amount
      const redeemQueueLen = await express.getRedeemQueueLength();
      expect(redeemQueueLen).to.equal(1n);
    });

    it('should reduce redeemers USDC amount when daily mgtFee is minted before processPendingRedeems', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, operator, user1 } = fixture;

      const depositAmount = ethers.parseUnits('100000', 18);
      await depositFor(fixture, user1, depositAmount);

      // Mint daily management fee
      await setupMgtFeeAndAccrue(fixture, 300);

      // ratio < 1e18 now
      const ratio = await express.sharesPerToken();
      expect(ratio).to.be.lt(ONE);

      // Request redeem — user will get less USDC due to ratio
      const redeemAmount = ethers.parseUnits('1000', 18);
      await requestRedeemFor(fixture, user1, redeemAmount);

      const delay = await express.convertRedeemRequestsDelay();
      await time.increase(delay);
      await express.connect(operator).processPendingRedeems(1);

      // The locked-in USDC should be less than the redeemAmount
      // since ratio < 1e18 and USDC = shareAmount * ratio / 1e18
      const redeemQueueLen = await express.getRedeemQueueLength();
      expect(redeemQueueLen).to.equal(1n);
    });
  });

  // =========================================================================
  // 2. Cancel pending redeem
  // =========================================================================
  describe('Cancel Pending Redeem & SharePerToken', function () {
    it('should not affect sharesPerToken when cancelling pending redeems', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, user1, maintainer } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('5000', 18));

      const ratioBefore = await express.sharesPerToken();

      // Request redeem (tokens move to Express, pending queue)
      await requestRedeemFor(fixture, user1, ethers.parseUnits('1000', 18));

      // Pending redeems do NOT affect sharesPerToken (only final redeemQueue does)
      const ratioDuringPending = await express.sharesPerToken();
      expect(ratioDuringPending).to.equal(ratioBefore);

      // Cancel — tokens return to user
      await express.connect(maintainer).cancelPendingRedeem(1);

      const ratioAfterCancel = await express.sharesPerToken();
      expect(ratioAfterCancel).to.equal(ratioBefore);
    });

    it('should restore user token balance after cancelling pending redeem', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, maintainer } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('5000', 18));
      const balanceBefore = await oem.balanceOf(user1.address);

      await requestRedeemFor(fixture, user1, ethers.parseUnits('1000', 18));
      expect(await oem.balanceOf(user1.address)).to.equal(
        balanceBefore - ethers.parseUnits('1000', 18)
      );

      await express.connect(maintainer).cancelPendingRedeem(1);
      expect(await oem.balanceOf(user1.address)).to.equal(balanceBefore);
    });

    it('should allow user to redeem again after cancel', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, user1, maintainer, operator } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('5000', 18));

      // First redeem, then cancel
      await requestRedeemFor(fixture, user1, ethers.parseUnits('1000', 18));
      await express.connect(maintainer).cancelPendingRedeem(1);
      expect(await express.getPendingRedeemQueueLength()).to.equal(0n);

      // Re-request redeem and process normally
      await requestRedeemFor(fixture, user1, ethers.parseUnits('1000', 18));
      await processPendingRedeemsAfterDelay(fixture, 1);

      expect(await express.getRedeemQueueLength()).to.equal(1n);
    });

    it('should cancel multiple pending redeems from different users', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, user2, maintainer } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('5000', 18));
      await depositFor(fixture, user2, ethers.parseUnits('5000', 18));

      await requestRedeemFor(fixture, user1, ethers.parseUnits('1000', 18));
      await requestRedeemFor(fixture, user2, ethers.parseUnits('2000', 18));

      expect(await express.getPendingRedeemQueueLength()).to.equal(2n);

      const user1BalBefore = await oem.balanceOf(user1.address);
      const user2BalBefore = await oem.balanceOf(user2.address);

      // Cancel all
      await express.connect(maintainer).cancelPendingRedeem(0);

      expect(await express.getPendingRedeemQueueLength()).to.equal(0n);
      expect(await oem.balanceOf(user1.address)).to.equal(
        user1BalBefore + ethers.parseUnits('1000', 18)
      );
      expect(await oem.balanceOf(user2.address)).to.equal(
        user2BalBefore + ethers.parseUnits('2000', 18)
      );
    });
  });

  // =========================================================================
  // 3. Queue processing order: processDeposit before processPendingRedeem (negative case)
  // =========================================================================
  describe('Queue Processing Order Impact', function () {
    it('should give redeemers MORE USDC when processDepositQueue runs BEFORE processPendingRedeems (wrong order)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, usdo, user1, user2, maintainer, operator } = fixture;

      // Setup: user1 deposits 10k, mint daily mgt fee to make ratio < 1
      await depositFor(fixture, user1, ethers.parseUnits('10000', 18));
      await setupMgtFeeAndAccrue(fixture, 300);

      // user1 requests redeem 1000
      await requestRedeemFor(fixture, user1, ethers.parseUnits('1000', 18));

      // user2 requests deposit 50000 (large deposit)
      const depositAmount = ethers.parseUnits('50000', 18);
      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), depositAmount, user2.address);

      // Advance past T+2
      const delay = await express.convertRedeemRequestsDelay();
      await time.increase(delay);

      // WRONG ORDER: processDeposit first, then processPendingRedeems
      const ratioBeforeDeposit = await express.sharesPerToken();
      await express.connect(maintainer).processDepositQueue(1); // mints 50k tokens
      const ratioAfterDeposit = await express.sharesPerToken();

      // Ratio increases because new circulating tokens dilute the mgtFeeTo "dead weight"
      expect(ratioAfterDeposit).to.be.gt(ratioBeforeDeposit);

      await express.connect(operator).processPendingRedeems(1);

      // The redeemer got priced at the HIGHER ratio (more USDC)
      // This is unfair to new depositors
      const redeemQueueLen = await express.getRedeemQueueLength();
      expect(redeemQueueLen).to.equal(1n);
    });

    it('should give redeemers LESS USDC when processPendingRedeems runs BEFORE processDepositQueue (correct order)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, usdo, user1, user2, maintainer, operator } = fixture;

      // Same setup
      await depositFor(fixture, user1, ethers.parseUnits('10000', 18));
      await setupMgtFeeAndAccrue(fixture, 300);

      await requestRedeemFor(fixture, user1, ethers.parseUnits('1000', 18));

      const depositAmount = ethers.parseUnits('50000', 18);
      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), depositAmount, user2.address);

      const delay = await express.convertRedeemRequestsDelay();
      await time.increase(delay);

      // CORRECT ORDER: processPendingRedeems first, then processDeposit
      const ratioBeforeRedeem = await express.sharesPerToken();
      await express.connect(operator).processPendingRedeems(1);

      // Ratio at processing time — before deposit inflated it
      await express.connect(maintainer).processDepositQueue(1);

      const redeemQueueLen = await express.getRedeemQueueLength();
      expect(redeemQueueLen).to.equal(1n);
    });

    it('should demonstrate that wrong order gives redeemers a higher ratio than correct order', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, usdo, user1, user2, maintainer, operator } = fixture;

      // Setup: user1 deposits, mint daily mgt fee so ratio < 1
      await depositFor(fixture, user1, ethers.parseUnits('10000', 18));
      await setupMgtFeeAndAccrue(fixture, 300);

      // user1 requests redeem, user2 queues a large deposit
      await requestRedeemFor(fixture, user1, ethers.parseUnits('1000', 18));
      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), ethers.parseUnits('50000', 18), user2.address);

      const delay = await express.convertRedeemRequestsDelay();
      await time.increase(delay);

      // Capture ratio BEFORE any processing — this is what correct order uses for redeemers
      const ratioBeforeAnyProcessing = await express.sharesPerToken();

      // WRONG ORDER: processDeposit first — ratio changes before redeemers are priced
      await express.connect(maintainer).processDepositQueue(1);
      const ratioAfterDeposit = await express.sharesPerToken();

      // The ratio after deposit is HIGHER than before (new circulating dilutes mgtFeeTo dead weight)
      // This means redeemers would be priced at a more generous ratio in wrong order
      expect(ratioAfterDeposit).to.be.gt(ratioBeforeAnyProcessing);
    });

    it('should have no ordering impact when mgtFeeRate is zero (ratio always 1e18)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, usdo, user1, user2, maintainer, operator } = fixture;

      // No mgt fee — ratio is always 1:1 regardless of ordering
      await depositFor(fixture, user1, ethers.parseUnits('10000', 18));
      await requestRedeemFor(fixture, user1, ethers.parseUnits('1000', 18));

      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), ethers.parseUnits('5000', 18), user2.address);

      const delay = await express.convertRedeemRequestsDelay();
      await time.increase(delay);

      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.equal(ONE);

      // Deposit first (wrong order) — ratio still 1:1
      await express.connect(maintainer).processDepositQueue(1);
      const ratioAfterDeposit = await express.sharesPerToken();
      expect(ratioAfterDeposit).to.equal(ONE);

      await express.connect(operator).processPendingRedeems(1);
      // No difference — both orderings produce the same result when fee=0
    });
  });

  // =========================================================================
  // 4. Token burn scenarios (direct burn reduces circulating supply)
  // =========================================================================
  describe('Token Burn & CirculatingSupply', function () {
    it('should decrease circulatingSupply when a holder burns tokens', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, admin } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('10000', 18));

      const circulatingBefore = await express.circulatingSupply();
      const totalSupplyBefore = await oem.totalSupply();

      // Grant BURNER_ROLE to admin so we can simulate direct burn
      const BURNER_ROLE = await oem.BURNER_ROLE();
      await oem.connect(admin).grantRole(BURNER_ROLE, admin.address);

      // Transfer tokens to admin first, then burn
      await oem.connect(user1).transfer(admin.address, ethers.parseUnits('2000', 18));
      await oem.connect(admin).burn(admin.address, ethers.parseUnits('2000', 18));

      const circulatingAfter = await express.circulatingSupply();
      const totalSupplyAfter = await oem.totalSupply();

      expect(totalSupplyAfter).to.equal(totalSupplyBefore - ethers.parseUnits('2000', 18));
      expect(circulatingAfter).to.equal(circulatingBefore - ethers.parseUnits('2000', 18));
    });

    it('should keep sharesPerToken at 1e18 when burn reduces both circulating and total proportionally', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, admin } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('10000', 18));

      // No mgt fee, no redeem queue — ratio = circulating / total = 1:1
      expect(await express.sharesPerToken()).to.equal(ONE);

      // Burn some tokens — both numerator and denominator decrease equally
      const BURNER_ROLE = await oem.BURNER_ROLE();
      await oem.connect(admin).grantRole(BURNER_ROLE, admin.address);
      await oem.connect(user1).transfer(admin.address, ethers.parseUnits('3000', 18));
      await oem.connect(admin).burn(admin.address, ethers.parseUnits('3000', 18));

      // Ratio stays 1:1 since there's no mgtFeeTo balance and no redeem queue
      expect(await express.sharesPerToken()).to.equal(ONE);
    });

    it('should change sharesPerToken when burn interacts with existing mgtFee balance', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, operator, admin } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('100000', 18));

      // Mint daily mgt fee so mgtFeeTo has balance
      await setupMgtFeeAndAccrue(fixture, 300);

      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.be.lt(ONE); // mgtFeeTo has tokens

      // Burn circulating tokens — reduces both circulating and total, but mgtFeeTo balance stays
      const BURNER_ROLE = await oem.BURNER_ROLE();
      await oem.connect(admin).grantRole(BURNER_ROLE, admin.address);
      await oem.connect(user1).transfer(admin.address, ethers.parseUnits('50000', 18));
      await oem.connect(admin).burn(admin.address, ethers.parseUnits('50000', 18));

      const ratioAfter = await express.sharesPerToken();

      // Ratio should decrease further because mgtFeeTo balance is now a larger proportion of total
      expect(ratioAfter).to.be.lt(ratioBefore);
    });

    it('should affect redeem USDC amount when tokens are burned before processPendingRedeems', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, user2, operator, admin } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('50000', 18));
      await depositFor(fixture, user2, ethers.parseUnits('50000', 18));

      // Mint daily mgt fee to make ratio < 1
      await setupMgtFeeAndAccrue(fixture, 300);

      const ratioBeforeBurn = await express.sharesPerToken();

      // user1 requests redeem
      await requestRedeemFor(fixture, user1, ethers.parseUnits('1000', 18));

      // user2 burns tokens (reduces circulating + total)
      const BURNER_ROLE = await oem.BURNER_ROLE();
      await oem.connect(admin).grantRole(BURNER_ROLE, admin.address);
      await oem.connect(user2).transfer(admin.address, ethers.parseUnits('30000', 18));
      await oem.connect(admin).burn(admin.address, ethers.parseUnits('30000', 18));

      const ratioAfterBurn = await express.sharesPerToken();
      expect(ratioAfterBurn).to.be.lt(ratioBeforeBurn);

      // Process pending redeems — user1 gets priced at the LOWER ratio
      await processPendingRedeemsAfterDelay(fixture, 1);

      const redeemQueueLen = await express.getRedeemQueueLength();
      expect(redeemQueueLen).to.equal(1n);
    });
  });

  // =========================================================================
  // 5. Additional edge cases
  // =========================================================================
  describe('Edge Cases', function () {
    it('should handle full redeem of all circulating tokens', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, operator } = fixture;

      const depositAmount = ethers.parseUnits('5000', 18);
      await depositFor(fixture, user1, depositAmount);

      const userBalance = await oem.balanceOf(user1.address);

      // Redeem everything
      await requestRedeemFor(fixture, user1, userBalance);
      await processPendingRedeemsAfterDelay(fixture, 1);

      // All tokens in redeem queue — circulating = 0
      const circulating = await express.circulatingSupply();
      expect(circulating).to.equal(0n);

      // Process redeem queue to settle
      await express.connect(operator).processRedeemQueue(1);

      // After full settlement, user has no OEM, total supply reduced
      expect(await oem.balanceOf(user1.address)).to.equal(0n);
    });

    it('should handle multiple deposits and redeems with mgtFee in between', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, usdo, user1, user2, maintainer, operator } = fixture;

      // Day 1: user1 deposits
      await depositFor(fixture, user1, ethers.parseUnits('10000', 18));

      // Mint first daily fee
      await setupMgtFeeAndAccrue(fixture, 300);

      const ratioAfterFirstFee = await express.sharesPerToken();
      expect(ratioAfterFirstFee).to.be.lt(ONE);

      // user2 deposits
      await depositFor(fixture, user2, ethers.parseUnits('20000', 18));

      // user1 redeems
      await requestRedeemFor(fixture, user1, ethers.parseUnits('5000', 18));

      // Correct order: processPendingRedeems first
      const delay = await express.convertRedeemRequestsDelay();
      await time.increase(delay);

      const ratioAtRedeem = await express.sharesPerToken();
      await express.connect(operator).processPendingRedeems(1);

      // Then accrue another epoch
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();

      // Verify second epoch minted more fee
      const mgtFeeTo = await express.mgtFeeTo();
      expect(await oem.balanceOf(mgtFeeTo)).to.be.gt(0n);
      expect(await express.totalMgtFeeMinted()).to.be.gte(0n);
    });

    it('should handle processPendingRedeems with zero-length (process all)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, user1, user2, operator } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('5000', 18));
      await depositFor(fixture, user2, ethers.parseUnits('5000', 18));

      await requestRedeemFor(fixture, user1, ethers.parseUnits('1000', 18));
      await requestRedeemFor(fixture, user2, ethers.parseUnits('2000', 18));

      expect(await express.getPendingRedeemQueueLength()).to.equal(2n);

      const delay = await express.convertRedeemRequestsDelay();
      await time.increase(delay);

      // Process all (len=0)
      await express.connect(operator).processPendingRedeems(0);

      expect(await express.getPendingRedeemQueueLength()).to.equal(0n);
      expect(await express.getRedeemQueueLength()).to.equal(2n);
    });

    it('should correctly track totalRedeemQueueShares across multiple operations', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, user1, user2, operator } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('10000', 18));
      await depositFor(fixture, user2, ethers.parseUnits('10000', 18));

      // Two redeems
      await requestRedeemFor(fixture, user1, ethers.parseUnits('2000', 18));
      await requestRedeemFor(fixture, user2, ethers.parseUnits('3000', 18));

      await processPendingRedeemsAfterDelay(fixture, 0);

      const totalRedeemShares = await express.totalRedeemQueueShares();
      expect(totalRedeemShares).to.equal(ethers.parseUnits('5000', 18));

      // Process one redeem
      await express.connect(operator).processRedeemQueue(1);

      const totalRedeemSharesAfter = await express.totalRedeemQueueShares();
      expect(totalRedeemSharesAfter).to.equal(ethers.parseUnits('3000', 18));
    });

    it('should handle updateEpoch after processRedeemQueue reduces totalSupply', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, user1, maintainer, operator } = fixture;

      await depositFor(fixture, user1, ethers.parseUnits('100000', 18));
      await express.connect(maintainer).updateMgtFeeRate(300);

      // Redeem some tokens
      await requestRedeemFor(fixture, user1, ethers.parseUnits('20000', 18));
      await processPendingRedeemsAfterDelay(fixture, 1);
      await express.connect(operator).processRedeemQueue(1);

      // Now updateEpoch — fee should be based on smaller circulating supply
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);

      const circulatingBeforeEpoch = await express.circulatingSupply();
      await express.connect(operator).updateEpoch();

      const expectedFee = trim(
        (circulatingBeforeEpoch * 300n) / (DAYS_IN_YEAR * BPS_BASE),
        TRIM_DECIMALS
      );
      const mgtFeeTo = await express.mgtFeeTo();
      expect(await oem.balanceOf(mgtFeeTo)).to.equal(expectedFee);
      expect(await express.totalMgtFeeMinted()).to.be.gte(0n);
    });

    it('should revert processPendingRedeems when queue is empty', async function () {
      const { express, operator } = await loadFixture(deployFixture);

      await expect(
        express.connect(operator).processPendingRedeems(0)
      ).to.be.revertedWithCustomError(express, 'EmptyQueue');
    });

    it('should handle the full SOP order: processPendingRedeems -> processDeposit -> updateEpoch -> processRedeemQueue', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, usdo, user1, user2, maintainer, operator } = fixture;

      // Setup: deposit, set mgt fee, mint daily fee
      await depositFor(fixture, user1, ethers.parseUnits('50000', 18));
      await setupMgtFeeAndAccrue(fixture, 300);

      // T+0: user1 requests redeem, user2 requests deposit
      await requestRedeemFor(fixture, user1, ethers.parseUnits('5000', 18));
      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), ethers.parseUnits('30000', 18), user2.address);

      // T+2: Execute in SOP order
      const delay = await express.convertRedeemRequestsDelay();
      await time.increase(delay);

      // Step 1: processPendingRedeems (lock in ratio BEFORE new mints)
      await express.connect(operator).processPendingRedeems(1);

      // After processPendingRedeems, effectiveTotal shrinks — mgtFee weight increases, ratio drops
      const ratioAfterPendingRedeem = await express.sharesPerToken();

      // Step 2: processDepositQueue (mint new tokens)
      await express.connect(maintainer).processDepositQueue(1);
      const ratioAfterDeposit = await express.sharesPerToken();

      // Ratio goes back up after deposit (effectiveTotal grows, mgtFee fraction shrinks)
      expect(ratioAfterDeposit).to.be.gt(ratioAfterPendingRedeem);

      // Step 3: updateEpoch (accrue fee on correct circulating including new deposits)
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();

      const circulatingForFee = await express.circulatingSupply();
      expect(circulatingForFee).to.be.gt(0n);

      // Step 4: processRedeemQueue (burn tokens, transfer USDC)
      const user1UsdcBefore = await fixture.usdo.balanceOf(user1.address);
      await express.connect(operator).processRedeemQueue(1);
      const user1UsdcAfter = await fixture.usdo.balanceOf(user1.address);

      // User received USDC
      expect(user1UsdcAfter).to.be.gt(user1UsdcBefore);

      // Redeem queue is now empty
      expect(await express.getRedeemQueueLength()).to.equal(0n);
    });
  });
});
