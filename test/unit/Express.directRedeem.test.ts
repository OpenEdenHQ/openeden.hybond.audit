import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);

describe('Express - requestDirectRedeem', function () {
  // Bootstrap: deposit, process, KYC the redeem-asset placeholder, approve
  async function deployWithDeposit() {
    const fixture = await deployExpressContracts();
    const { express, usdo, oem, user1, user2, maintainer } = fixture;
    const depositAmt = ethers.parseUnits('10000', 18);

    await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
    await express.connect(maintainer).processDepositQueue(1, depositAmt);

    await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
    await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);

    return fixture;
  }

  // Arbitrary "RLUSD" address — informational only; contract never calls it
  const RLUSD = ethers.getAddress('0x000000000000000000000000000000000000cafe');

  describe('happy path', function () {
    it('burns tokens immediately, decrements offchainShares, emits event, preserves ratio', async function () {
      const { express, oem, user1 } = await loadFixture(deployWithDeposit);

      const tokenAmount = ethers.parseUnits('1000', 18);
      const ratioBefore = await express.sharesPerToken();
      const supplyBefore = await oem.totalSupply();
      const offchainBefore = await express.offchainShares();
      const userBalBefore = await oem.balanceOf(user1.address);

      const expectedShareAmount = (tokenAmount * ratioBefore) / ONE;

      await expect(express.connect(user1).requestDirectRedeem(RLUSD, tokenAmount, user1.address))
        .to.emit(express, 'OffchainRedeem')
        .withArgs(user1.address, user1.address, RLUSD, tokenAmount, expectedShareAmount);

      expect(await oem.totalSupply()).to.equal(supplyBefore - tokenAmount);
      expect(await oem.balanceOf(user1.address)).to.equal(userBalBefore - tokenAmount);
      expect(await express.offchainShares()).to.equal(offchainBefore - expectedShareAmount);
      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });

  describe('reverts', function () {
    it('reverts on zero token amount', async function () {
      const { express, user1 } = await loadFixture(deployWithDeposit);
      await expect(
        express.connect(user1).requestDirectRedeem(RLUSD, 0, user1.address)
      ).to.be.revertedWithCustomError(express, 'InvalidAmount');
    });

    it('reverts on zero asset address', async function () {
      const { express, user1 } = await loadFixture(deployWithDeposit);
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(ethers.ZeroAddress, ethers.parseUnits('100', 18), user1.address)
      ).to.be.revertedWithCustomError(express, 'InvalidAddress');
    });

    it('reverts when asset equals redeemAsset', async function () {
      const { express, user1 } = await loadFixture(deployWithDeposit);
      const redeemAsset = await express.redeemAsset();
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(redeemAsset, ethers.parseUnits('100', 18), user1.address)
      ).to.be.revertedWithCustomError(express, 'RedeemAssetNotAllowed');
    });

    it('reverts when caller is mgtFeeTo', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, admin } = fixture;
      const mgtFeeToAddr = await express.mgtFeeTo();
      await ethers.provider.send('hardhat_impersonateAccount', [mgtFeeToAddr]);
      await admin.sendTransaction({ to: mgtFeeToAddr, value: ethers.parseEther('1') });
      const mgtFeeToSigner = await ethers.getSigner(mgtFeeToAddr);

      await expect(
        express
          .connect(mgtFeeToSigner)
          .requestDirectRedeem(RLUSD, ethers.parseUnits('100', 18), mgtFeeToAddr)
      ).to.be.revertedWithCustomError(express, 'MgtFeeToCannotDirectRedeem');
    });

    it('reverts when from is not KYC-listed', async function () {
      const { express, kycManager, whitelister, user1 } = await loadFixture(deployWithDeposit);
      await kycManager.connect(whitelister).revokeKyc(user1.address);
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(RLUSD, ethers.parseUnits('100', 18), user1.address)
      ).to.be.revertedWithCustomError(express, 'NotInKycList');
    });

    it('reverts when to is not KYC-listed', async function () {
      const { express, user1 } = await loadFixture(deployWithDeposit);
      const nonKyc = ethers.Wallet.createRandom().address;
      await expect(
        express.connect(user1).requestDirectRedeem(RLUSD, ethers.parseUnits('100', 18), nonKyc)
      ).to.be.revertedWithCustomError(express, 'NotInKycList');
    });

    it('reverts when paused', async function () {
      const { express, pauser, user1 } = await loadFixture(deployWithDeposit);
      await express.connect(pauser).pauseRedeem();
      await expect(
        express
          .connect(user1)
          .requestDirectRedeem(RLUSD, ethers.parseUnits('100', 18), user1.address)
      ).to.be.revertedWithCustomError(express, 'PausedRedeem1');
    });

    it('reverts when token balance insufficient', async function () {
      const { express, oem, user1 } = await loadFixture(deployWithDeposit);
      const balance = await oem.balanceOf(user1.address);
      await expect(express.connect(user1).requestDirectRedeem(RLUSD, balance + 1n, user1.address))
        .to.be.reverted;
    });
  });

  describe('ratio invariance', function () {
    it('ratio unchanged when totalRedeemQueueTokens > 0', async function () {
      const { express, oem, user1, user2 } = await loadFixture(deployWithDeposit);

      // user2 also needs HYBOND tokens — transfer some from user1 (both KYC'd)
      await oem.connect(user1).transfer(user2.address, ethers.parseUnits('2000', 18));

      // Park user1 tokens in pendingRedeemQueue (not processed) — totalRedeemQueueTokens > 0
      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('500', 18));

      const ratioBefore = await express.sharesPerToken();
      const queuedBefore = await express.totalRedeemQueueTokens();
      expect(queuedBefore).to.be.gt(0n);

      // user2 directly redeems
      await express
        .connect(user2)
        .requestDirectRedeem(RLUSD, ethers.parseUnits('1000', 18), user2.address);

      const ratioAfter = await express.sharesPerToken();
      const queuedAfter = await express.totalRedeemQueueTokens();

      expect(ratioAfter).to.equal(ratioBefore);
      expect(queuedAfter).to.equal(queuedBefore); // direct-redeem must not touch this
    });

    it('does not increment redeem queues', async function () {
      const { express, user1 } = await loadFixture(deployWithDeposit);

      const pendingBefore = await express.getPendingRedeemQueueLength();
      const finalBefore = await express.getRedeemQueueLength();

      await express
        .connect(user1)
        .requestDirectRedeem(RLUSD, ethers.parseUnits('100', 18), user1.address);

      expect(await express.getPendingRedeemQueueLength()).to.equal(pendingBefore);
      expect(await express.getRedeemQueueLength()).to.equal(finalBefore);
    });
  });

  describe('coexistence with queued flows', function () {
    it('interleaves with deposit and queued redeem without drift', async function () {
      const { express, oem, usdo, user1, user2, maintainer } = await loadFixture(deployWithDeposit);

      // user2 deposits
      const depositAmt = ethers.parseUnits('5000', 18);
      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), depositAmt, user2.address);
      await express.connect(maintainer).processDepositQueue(1, depositAmt);

      const ratio1 = await express.sharesPerToken();

      // user1 direct-redeems
      await express
        .connect(user1)
        .requestDirectRedeem(RLUSD, ethers.parseUnits('1000', 18), user1.address);

      const ratio2 = await express.sharesPerToken();
      expect(ratio2).to.equal(ratio1);

      // user2 queued-redeems
      await express.connect(user2).requestRedeem(user2.address, ethers.parseUnits('500', 18));

      const ratio3 = await express.sharesPerToken();
      expect(ratio3).to.equal(ratio2);

      // user1 direct-redeems again
      await express
        .connect(user1)
        .requestDirectRedeem(RLUSD, ethers.parseUnits('300', 18), user1.address);

      const ratio4 = await express.sharesPerToken();
      expect(ratio4).to.equal(ratio3);

      // Sanity: only the queued redeem (500) is parked in totalRedeemQueueTokens.
      // Direct redeems burn immediately and don't touch totalRedeemQueueTokens.
      expect(await express.totalRedeemQueueTokens()).to.equal(ethers.parseUnits('500', 18));
    });
  });
});
