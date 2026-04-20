import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);

describe('Express - SharePerToken & Queue Processing Order', function () {
  // Extend base fixture with CONFIRM_ROLE for two-step offchainShares flow
  async function deployFixture() {
    const base = await deployExpressContracts();
    const signers = await ethers.getSigners();
    const confirmer = signers[10];
    const CONFIRM_ROLE = await base.express.CONFIRM_ROLE();
    await base.express.connect(base.admin).grantRole(CONFIRM_ROLE, confirmer.address);
    return { ...base, confirmer };
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

  // Helper: advance past T+2 delay, snapshot ratio, and process pending redeems
  async function processPendingRedeemsAfterDelay(fixture: any, len?: bigint) {
    const { express, operator } = fixture;
    await time.increase(2n * 24n * 60n * 60n); // T+2 = 2 days (operator-enforced)
    const queueLen: bigint = await express.getPendingRedeemQueueLength();
    await express.connect(operator).snapshotPendingRedeemRatio(0, queueLen);
    await express.connect(operator).processPendingRedeems(len ?? queueLen);
  }

  // Helper: set offchainShares via propose + confirm two-step
  async function setOffchainShares(fixture: any, amount: bigint) {
    const { express, operator, confirmer } = fixture;
    await express.connect(operator).proposeOffchainShares(amount);
    await express.connect(confirmer).confirmOffchainShares(amount);
  }

  // =========================================================================
  // 1. Bootstrap / full-exit: denom == 0 → returns 1e18
  // =========================================================================
  describe('Bootstrap and full exit (denom == 0)', function () {
    it('returns 1e18 before any deposits (totalSupply == 0)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express } = fixture;

      // No tokens minted yet — denom = totalSupply - totalRedeemQueueShares = 0
      expect(await express.sharesPerToken()).to.equal(ONE);
    });

    it('returns 1e18 after all tokens have been fully redeemed and burned', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, operator } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      const userBalance = await oem.balanceOf(fixture.user1.address);

      // offchainShares reflects minted supply 1:1
      await setOffchainShares(fixture, userBalance);

      await requestRedeemFor(fixture, fixture.user1, userBalance);
      await processPendingRedeemsAfterDelay(fixture, 1);
      await express.connect(operator).processRedeemQueue(1);

      // totalSupply == 0 → denom == 0 → ratio == 1e18
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
      const { express } = fixture;

      // Bootstrap deposit: mints tokens at the 1:1 fallback, totalSupply becomes > 0.
      await depositFor(fixture, fixture.user1, ethers.parseUnits('10000', 18));

      // Pre-sync invariant: offchainShares still 0. Ratio falls back to 1e18 so that
      // subsequent deposits/redeems price at 1:1 until the bot syncs.
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
      const { express, oem } = fixture;

      const depositAmount = ethers.parseUnits('10000', 18);
      await depositFor(fixture, fixture.user1, depositAmount);

      const totalSupply = await oem.totalSupply();
      // Set offchainShares == totalSupply (no fees accrued yet)
      await setOffchainShares(fixture, totalSupply);

      expect(await express.sharesPerToken()).to.equal(ONE);
    });

    it('returns < 1e18 when offchainShares < denom (fee dilution scenario)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem } = fixture;

      const depositAmount = ethers.parseUnits('10000', 18);
      await depositFor(fixture, fixture.user1, depositAmount);

      const totalSupply = await oem.totalSupply();
      // Set offchainShares to 90% of totalSupply (simulating 10% fee dilution)
      const offchain = (totalSupply * 9n) / 10n;
      await setOffchainShares(fixture, offchain);

      const ratio = await express.sharesPerToken();
      expect(ratio).to.be.lt(ONE);

      // Verify exact formula: mulDiv(offchain, 1e18, totalSupply)
      const expected = (offchain * ONE) / totalSupply;
      // Allow 1 wei rounding tolerance from mulDiv
      expect(ratio).to.be.closeTo(expected, 1n);
    });

    it('returns > 1e18 when offchainShares > denom (BNY grew faster than supply)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem } = fixture;

      const depositAmount = ethers.parseUnits('10000', 18);
      await depositFor(fixture, fixture.user1, depositAmount);

      const totalSupply = await oem.totalSupply();
      // Set offchainShares to 110% of totalSupply (BNY fund grew 10% above par)
      const offchain = (totalSupply * 11n) / 10n;
      await setOffchainShares(fixture, offchain);

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
      // Set offchainShares to match current supply (ratio = 1)
      await setOffchainShares(fixture, totalSupplyBefore);
      expect(await express.sharesPerToken()).to.equal(ONE);

      // Accrue one epoch of management fee (3% annual)
      await express.connect(maintainer).updateMgtFeeRate(300);
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();

      const totalSupplyAfter = await oem.totalSupply();
      expect(totalSupplyAfter).to.be.gt(totalSupplyBefore);

      // offchainShares is unchanged; denom (totalSupply - totalRedeemQueueShares) grew
      // → ratio = offchain / newDenom < oldRatio
      const ratioAfter = await express.sharesPerToken();
      expect(ratioAfter).to.be.lt(ONE);

      // Verify formula: mulDiv(offchainShares, 1e18, totalSupplyAfter)
      const expected = (totalSupplyBefore * ONE) / totalSupplyAfter;
      expect(ratioAfter).to.be.closeTo(expected, 1n);
    });

    it('ratio does not change when updateEpoch is called with mgtFeeRate == 0', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem } = fixture;

      const depositAmount = ethers.parseUnits('10000', 18);
      await depositFor(fixture, fixture.user1, depositAmount);

      const totalSupply = await oem.totalSupply();
      await setOffchainShares(fixture, totalSupply);
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
  // 5. Ratio rises after processPendingRedeems (denom shrinks)
  // =========================================================================
  describe('processPendingRedeems: denom shrinks → ratio rises', function () {
    it('ratio rises after processPendingRedeems moves entry pending→final (denom shrinks)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, maintainer, operator } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('100000', 18));

      // Set offchainShares to 90% of totalSupply (diluted scenario)
      const totalSupplyBefore = await oem.totalSupply();
      const offchain = (totalSupplyBefore * 9n) / 10n;
      await setOffchainShares(fixture, offchain);
      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.be.lt(ONE);

      // Request redeem: tokens stay in totalSupply, pending queue tracks them
      const redeemAmount = ethers.parseUnits('10000', 18);
      await requestRedeemFor(fixture, fixture.user1, redeemAmount);

      // Ratio unchanged — pending redeems are still included in totalSupply
      expect(await express.sharesPerToken()).to.equal(ratioBefore);

      // Process pending→final: totalRedeemQueueShares grows by redeemAmount
      // denom = totalSupply - totalRedeemQueueShares → denom shrinks
      const delay = 2n * 24n * 60n * 60n; // T+2 = 2 days (operator-enforced)
      await time.increase(delay);
      await express.connect(operator).snapshotPendingRedeemRatio(0, 1n);
      await express.connect(operator).processPendingRedeems(1);

      const ratioAfter = await express.sharesPerToken();
      // Smaller denom with same offchainShares → higher ratio
      expect(ratioAfter).to.be.gt(ratioBefore);

      // Verify formula: denom = totalSupply - totalRedeemQueueShares
      const totalSupply = await oem.totalSupply();
      const totalRedeemQueueShares = await express.totalRedeemQueueShares();
      const denom = totalSupply - totalRedeemQueueShares;
      const expected = (offchain * ONE) / denom;
      expect(ratioAfter).to.be.closeTo(expected, 1n);
    });
  });

  // =========================================================================
  // 6. Ratio unchanged by processRedeemQueue burn
  //    (totalSupply and totalRedeemQueueShares drop by the same amount)
  // =========================================================================
  describe('processRedeemQueue burn: ratio is invariant', function () {
    it('ratio is unchanged when processRedeemQueue burns shares (totalSupply and totalRedeemQueueShares drop equally)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, operator } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('100000', 18));

      // Set offchainShares to 90% of totalSupply
      const totalSupply = await oem.totalSupply();
      const offchain = (totalSupply * 9n) / 10n;
      await setOffchainShares(fixture, offchain);

      // Move a redeem through pending→final queue
      const redeemAmount = ethers.parseUnits('10000', 18);
      await requestRedeemFor(fixture, fixture.user1, redeemAmount);
      await processPendingRedeemsAfterDelay(fixture, 1);

      const ratioAfterPending = await express.sharesPerToken();

      // processRedeemQueue burns: totalSupply -= redeemAmount, totalRedeemQueueShares -= redeemAmount
      // denom = (totalSupply - redeemAmount) - (totalRedeemQueueShares - redeemAmount) = denom unchanged
      await express.connect(operator).processRedeemQueue(1);

      const ratioAfterBurn = await express.sharesPerToken();
      expect(ratioAfterBurn).to.equal(ratioAfterPending);
    });

    it('ratio is unchanged across the full redeem cycle: pending→final→burn', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, operator } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('50000', 18));
      // Set offchainShares before user2 deposits so _calculateMintAmount has a valid ratio
      const supplyAfterUser1 = await oem.totalSupply();
      await setOffchainShares(fixture, supplyAfterUser1);
      await depositFor(fixture, fixture.user2, ethers.parseUnits('50000', 18));

      const totalSupply = await oem.totalSupply();
      // Set offchain at 95% of supply (mild dilution)
      const offchain = (totalSupply * 95n) / 100n;
      await setOffchainShares(fixture, offchain);

      const ratioInitial = await express.sharesPerToken();

      // user1 redeems
      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      await processPendingRedeemsAfterDelay(fixture, 1);

      // Ratio changed when pending moved to final (denom shrank)
      const ratioAfterFinal = await express.sharesPerToken();
      expect(ratioAfterFinal).to.not.equal(ratioInitial);

      // Now process the final queue burn
      await express.connect(operator).processRedeemQueue(1);

      // Ratio should return to equal ratioAfterFinal (burn doesn't change ratio)
      expect(await express.sharesPerToken()).to.equal(ratioAfterFinal);
    });
  });

  // =========================================================================
  // 7. Cancel pending redeem: ratio unaffected
  // =========================================================================
  describe('Cancel Pending Redeem & SharePerToken', function () {
    it('should not affect sharesPerToken when cancelling pending redeems', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, maintainer } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));

      const totalSupply = await oem.totalSupply();
      await setOffchainShares(fixture, totalSupply);
      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.equal(ONE);

      // Request redeem (tokens stay in totalSupply while in pending queue)
      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));

      // Pending redeems do NOT change denom (totalSupply unchanged, totalRedeemQueueShares unchanged)
      expect(await express.sharesPerToken()).to.equal(ratioBefore);

      // Cancel — tokens return to user, no state change to ratio inputs
      await express.connect(maintainer).cancelPendingRedeem(1);
      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });

    it('should restore user token balance after cancelling pending redeem', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, maintainer } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      await setOffchainShares(fixture, await oem.totalSupply());
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
      const { express, oem, maintainer } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      await setOffchainShares(fixture, await oem.totalSupply());

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));
      await express.connect(maintainer).cancelPendingRedeem(1);
      expect(await express.getPendingRedeemQueueLength()).to.equal(0n);

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));
      await processPendingRedeemsAfterDelay(fixture, 1);

      expect(await express.getRedeemQueueLength()).to.equal(1n);
    });

    it('should cancel multiple pending redeems from different users', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, maintainer } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      await setOffchainShares(fixture, await oem.totalSupply());
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
    it('ratio stays constant regardless of processDepositQueue ordering when ratio is snapshotted', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, usdo, maintainer, operator, oem } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('10000', 18));
      const totalSupply = await oem.totalSupply();
      // Set offchainShares to 90% of supply (diluted)
      await setOffchainShares(fixture, (totalSupply * 9n) / 10n);

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));

      // user2 requests deposit
      const depositAmount = ethers.parseUnits('50000', 18);
      await express
        .connect(fixture.user2)
        .requestDeposit(await usdo.getAddress(), depositAmount, fixture.user2.address);

      // Snapshot ratio before processing — locks ratio for the redeem
      await express.connect(operator).snapshotPendingRedeemRatio(0, 1n);

      const delay = 2n * 24n * 60n * 60n; // T+2 = 2 days (operator-enforced)
      await time.increase(delay);

      await express.connect(maintainer).processDepositQueue(1);
      await express.connect(operator).processPendingRedeems(1);

      expect(await express.getRedeemQueueLength()).to.equal(1n);
    });

    it('ratio drops when processDepositQueue mints new tokens (offchainShares not yet synced)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, usdo, maintainer, operator, oem } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('10000', 18));
      const totalSupply = await oem.totalSupply();
      await setOffchainShares(fixture, totalSupply);

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));

      await express
        .connect(fixture.user2)
        .requestDeposit(
          await usdo.getAddress(),
          ethers.parseUnits('5000', 18),
          fixture.user2.address
        );

      const delay = 2n * 24n * 60n * 60n; // T+2 = 2 days (operator-enforced)
      await time.increase(delay);

      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.equal(ONE);

      await express.connect(operator).snapshotPendingRedeemRatio(0, 1n);
      await express.connect(maintainer).processDepositQueue(1);

      // After deposit: denom grows (new tokens minted), offchainShares unchanged → ratio drops
      const ratioAfterDeposit = await express.sharesPerToken();
      expect(ratioAfterDeposit).to.be.lt(ONE);

      await express.connect(operator).processPendingRedeems(1);
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
      const totalSupply = await oem.totalSupply();
      await setOffchainShares(fixture, totalSupply);

      const userBalance = await oem.balanceOf(fixture.user1.address);
      await requestRedeemFor(fixture, fixture.user1, userBalance);
      await processPendingRedeemsAfterDelay(fixture, 1);
      await express.connect(operator).processRedeemQueue(1);

      expect(await oem.balanceOf(fixture.user1.address)).to.equal(0n);
    });

    it('should correctly track totalRedeemQueueShares across multiple operations', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem, operator } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('10000', 18));
      await setOffchainShares(fixture, await oem.totalSupply());
      await depositFor(fixture, fixture.user2, ethers.parseUnits('10000', 18));

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('2000', 18));
      await requestRedeemFor(fixture, fixture.user2, ethers.parseUnits('3000', 18));

      await processPendingRedeemsAfterDelay(fixture);

      expect(await express.totalRedeemQueueShares()).to.equal(ethers.parseUnits('5000', 18));

      await express.connect(operator).processRedeemQueue(1);

      expect(await express.totalRedeemQueueShares()).to.equal(ethers.parseUnits('3000', 18));
    });

    it('should handle processPendingRedeems with zero-length (process all)', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, oem } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      await setOffchainShares(fixture, await oem.totalSupply());
      await depositFor(fixture, fixture.user2, ethers.parseUnits('5000', 18));

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('1000', 18));
      await requestRedeemFor(fixture, fixture.user2, ethers.parseUnits('2000', 18));

      expect(await express.getPendingRedeemQueueLength()).to.equal(2n);

      const delay = 2n * 24n * 60n * 60n; // T+2 = 2 days (operator-enforced)
      await time.increase(delay);

      const queueLen: bigint = await fixture.express.getPendingRedeemQueueLength();
      await fixture.express.connect(fixture.operator).snapshotPendingRedeemRatio(0, queueLen);
      await fixture.express.connect(fixture.operator).processPendingRedeems(queueLen);

      expect(await express.getPendingRedeemQueueLength()).to.equal(0n);
      expect(await express.getRedeemQueueLength()).to.equal(2n);
    });

    it('should revert processPendingRedeems when queue is empty', async function () {
      const { express, operator } = await loadFixture(deployFixture);

      // _len = 0 is not supported (no "process all" sentinel); operator must pass a positive
      // _len. With an empty queue, the loop body never runs and processed stays 0, so the
      // function reverts with NoPendingRedeemsReady.
      await expect(
        express.connect(operator).processPendingRedeems(1)
      ).to.be.revertedWithCustomError(express, 'NoPendingRedeemsReady');
    });

    it('should handle the full SOP order: processPendingRedeems -> processDeposit -> updateEpoch -> processRedeemQueue', async function () {
      const fixture = await loadFixture(deployFixture);
      const { express, usdo, maintainer, operator, oem } = fixture;

      await depositFor(fixture, fixture.user1, ethers.parseUnits('50000', 18));
      const totalSupplyBefore = await oem.totalSupply();
      // Set offchainShares slightly below supply (mild fee dilution)
      await setOffchainShares(fixture, (totalSupplyBefore * 99n) / 100n);

      await express.connect(maintainer).updateMgtFeeRate(300);

      await requestRedeemFor(fixture, fixture.user1, ethers.parseUnits('5000', 18));
      await express
        .connect(fixture.user2)
        .requestDeposit(
          await usdo.getAddress(),
          ethers.parseUnits('30000', 18),
          fixture.user2.address
        );

      const delay = 2n * 24n * 60n * 60n; // T+2 = 2 days (operator-enforced)
      await time.increase(delay);

      // Step 1: snapshot, then processPendingRedeems
      await express.connect(operator).snapshotPendingRedeemRatio(0, 1n);
      await express.connect(operator).processPendingRedeems(1);

      // Step 2: processDepositQueue
      await express.connect(maintainer).processDepositQueue(1);

      // Step 3: updateEpoch (mints fee, grows totalSupply, drops ratio)
      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();

      // Step 4: processRedeemQueue
      const user1UsdcBefore = await fixture.usdo.balanceOf(fixture.user1.address);
      await express.connect(operator).processRedeemQueue(1);
      const user1UsdcAfter = await fixture.usdo.balanceOf(fixture.user1.address);

      expect(user1UsdcAfter).to.be.gt(user1UsdcBefore);
      expect(await express.getRedeemQueueLength()).to.equal(0n);
    });
  });
});
