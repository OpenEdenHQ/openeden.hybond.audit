import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts, expectedRedeemAssetTotal } from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);

describe('Express - Ratio Invariance', function () {
  async function deployFixture() {
    return deployExpressContracts();
  }

  // Helper: bootstrap with a deposit so we have a real ratio
  async function deployWithDeposit() {
    const fixture = await deployFixture();
    const { express, usdo, oem, user1, user2, maintainer } = fixture;
    const depositAmt = ethers.parseUnits('10000', 18);

    await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
    await express.connect(maintainer).processDepositQueue(1, depositAmt);

    // Approve for user1 and user2 redeems
    await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
    await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);

    return fixture;
  }

  // Helper: bootstrap + fee accrual so ratio < 1e18
  async function deployWithDepositAndFees() {
    const fixture = await deployWithDeposit();
    const { express, maintainer, operator } = fixture;

    // Set fee rate and accrue fees
    await express.connect(maintainer).updateMgtFeeRate(1000); // 10% annual
    const timeBuffer = await express.timeBuffer();
    await time.increase(timeBuffer);
    await express.connect(operator).updateEpoch();

    return fixture;
  }

  describe('processDepositQueue preserves ratio', function () {
    it('ratio unchanged after deposit when ratio == 1e18', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, usdo, user2, maintainer } = fixture;

      const ratioBefore = await express.sharesPerToken();

      const depositAmt = ethers.parseUnits('3000', 18);
      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), depositAmt, user2.address);
      await express.connect(maintainer).processDepositQueue(1, depositAmt);

      const ratioAfter = await express.sharesPerToken();
      expect(ratioAfter).to.equal(ratioBefore);
    });

    it('ratio unchanged after deposit when ratio < 1e18 (post-fee)', async function () {
      const fixture = await loadFixture(deployWithDepositAndFees);
      const { express, usdo, user2, maintainer } = fixture;

      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.be.lt(ONE); // Verify fees diluted the ratio

      const depositAmt = ethers.parseUnits('5000', 18);
      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), depositAmt, user2.address);
      // newShares should be proportional to maintain ratio
      const newShares = ethers.parseUnits('5000', 18);
      await express.connect(maintainer).processDepositQueue(1, newShares);

      const ratioAfter = await express.sharesPerToken();
      expect(ratioAfter).to.equal(ratioBefore);
    });

    it('ratio unchanged with multiple depositors in a batch', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, usdo, user1, user2, maintainer } = fixture;

      const ratioBefore = await express.sharesPerToken();

      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), ethers.parseUnits('2000', 18), user1.address);
      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), ethers.parseUnits('3000', 18), user2.address);

      const totalNewShares = ethers.parseUnits('5000', 18);
      await express.connect(maintainer).processDepositQueue(2, totalNewShares);

      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });

  describe('requestRedeem preserves ratio', function () {
    it('ratio unchanged after redeem when ratio == 1e18', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, user1 } = fixture;

      const ratioBefore = await express.sharesPerToken();

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18));

      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });

    it('ratio unchanged after redeem when ratio < 1e18 (post-fee)', async function () {
      const fixture = await loadFixture(deployWithDepositAndFees);
      const { express, user1 } = fixture;

      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.be.lt(ONE);

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18));

      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });

    it('reverts with InsufficientOffchainShares when offchainShares cannot cover', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, oem, user1, user2, usdo, maintainer } = fixture;

      // Create a second deposit so we have more tokens than offchainShares covers
      const deposit2 = ethers.parseUnits('5000', 18);
      await express.connect(user2).requestDeposit(await usdo.getAddress(), deposit2, user2.address);
      await express.connect(maintainer).processDepositQueue(1, deposit2);

      // Now set offchainShares to a small value that can't cover a large redeem
      // shareAmount = tokenAmount * offchainShares / denom
      // If offchainShares = 100 and user redeems 10000 tokens from denom of 15000:
      // shareAmount = 10000 * 100 / 15000 = 66.67, which is less than 100
      // We need shareAmount > offchainShares. This happens when tokenAmount > denom.
      // That's impossible for a single user.

      // Alternative: set offchainShares to 0 via admin override, then any redeem should revert
      // because shareAmount > 0 but offchainShares == 0
      await express.connect(maintainer).updateOffchainShares(0);

      // With offchainShares == 0, ratio fallback is 1e18
      // shareAmount = tokenAmount * 1e18 / 1e18 = tokenAmount
      // offchainShares (0) < shareAmount (tokenAmount > 0) => revert
      await expect(
        express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18))
      ).to.be.revertedWithCustomError(express, 'InsufficientOffchainShares');
    });
  });

  describe('processRedeemQueue (burn) preserves ratio', function () {
    it('ratio unchanged after burn', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, user1, operator } = fixture;

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18));

      const ratioBefore = await express.sharesPerToken();

      // Advance past T+2
      await time.increase(2 * 24 * 60 * 60 + 1);

      // Process pending -> final (supply _totalAsset high enough to pass sanity check)
      await express.connect(operator).processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));

      // Ratio should still be same (pending->final doesn't change ratio-relevant state)
      expect(await express.sharesPerToken()).to.equal(ratioBefore);

      // Process final (burn)
      await express.connect(operator).processRedeemQueue(1);

      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });

  describe('cancelPendingRedeem preserves ratio', function () {
    it('ratio unchanged after cancel (reverse of requestRedeem)', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, user1, maintainer } = fixture;

      const ratioBefore = await express.sharesPerToken();

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18));

      // Ratio should be unchanged after requestRedeem
      expect(await express.sharesPerToken()).to.equal(ratioBefore);

      // Cancel
      await express.connect(maintainer).cancelPendingRedeem(1);

      // Ratio should still be unchanged
      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });

  describe('cancelRedeem preserves ratio', function () {
    it('ratio unchanged after cancelRedeem', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, user1, operator, maintainer } = fixture;

      const ratioBefore = await express.sharesPerToken();

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18));
      await time.increase(2 * 24 * 60 * 60 + 1);
      await express.connect(operator).processPendingRedeems(1, await expectedRedeemAssetTotal(express, 1));

      // Cancel from final queue
      await express.connect(maintainer).cancelRedeem(1);

      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });

  describe('OracleDeviationExceeded revert', function () {
    it('reverts when _totalAsset is far outside the deviation band', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, user1, operator, maintainer } = fixture;

      // Set a non-zero deviation tolerance before any redeem queueing
      // (setter requires queues to be empty)
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100); // 1%

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18));
      await time.increase(2 * 24 * 60 * 60 + 1);

      // Supply a tiny _totalAsset that falls far outside the deviation band
      await expect(
        express.connect(operator).processPendingRedeems(1, 1n)
      ).to.be.revertedWithCustomError(express, 'OracleDeviationExceeded');
    });
  });

  describe('updateEpoch changes ratio (intended dilution)', function () {
    it('ratio drops after fee mint', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, maintainer, operator } = fixture;

      await express.connect(maintainer).updateMgtFeeRate(1000);

      const ratioBefore = await express.sharesPerToken();

      const timeBuffer = await express.timeBuffer();
      await time.increase(timeBuffer);
      await express.connect(operator).updateEpoch();

      const ratioAfter = await express.sharesPerToken();
      expect(ratioAfter).to.be.lt(ratioBefore);
    });
  });
});
