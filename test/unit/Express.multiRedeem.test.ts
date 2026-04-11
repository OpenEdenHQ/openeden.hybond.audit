import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('Express - Multi-Asset Redemption', function () {
  async function deployMultiAssetFixture() {
    const fixture = await deployExpressContracts();
    const { admin, assetRegistry, express, maintainer } = fixture;

    // Deploy USDT (6 decimals)
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const usdt = await MockERC20Factory.deploy('Tether USD', 'USDT', 6);
    await usdt.waitForDeployment();

    // Configure USDT in AssetRegistry (supported + redeemable, no price feed)
    await assetRegistry.connect(admin).setAssetConfig({
      asset: await usdt.getAddress(),
      priceFeed: ethers.ZeroAddress,
      isSupported: true,
      isRedeemable: true,
      maxStalePeriod: 0,
    });

    // Mint USDT to Express for redemption liquidity
    const usdtLiquidity = ethers.parseUnits('100000', 6);
    await usdt.mint(await express.getAddress(), usdtLiquidity);

    // Mint USDT to users for deposits (if needed) and approve
    const userUsdtAmount = ethers.parseUnits('100000', 6);
    await usdt.mint(fixture.user1.address, userUsdtAmount);
    await usdt.mint(fixture.user2.address, userUsdtAmount);
    await usdt.mint(fixture.user3.address, userUsdtAmount);
    await usdt.connect(fixture.user1).approve(await express.getAddress(), ethers.MaxUint256);
    await usdt.connect(fixture.user2).approve(await express.getAddress(), ethers.MaxUint256);
    await usdt.connect(fixture.user3).approve(await express.getAddress(), ethers.MaxUint256);

    // Deploy deposit-only asset (supported but NOT redeemable)
    const depositOnlyAsset = await MockERC20Factory.deploy('Deposit Only', 'DONLY', 18);
    await depositOnlyAsset.waitForDeployment();

    await assetRegistry.connect(admin).setAssetConfig({
      asset: await depositOnlyAsset.getAddress(),
      priceFeed: ethers.ZeroAddress,
      isSupported: true,
      isRedeemable: false,
      maxStalePeriod: 0,
    });

    // Set trimDecimals to 3 for consistency with other tests
    await express.connect(maintainer).updateTrimDecimals(3);

    return { ...fixture, usdt, depositOnlyAsset };
  }

  async function depositAndGetTokens(
    express: any,
    usdo: any,
    user: HardhatEthersSigner,
    amount: bigint,
    maintainer: HardhatEthersSigner
  ) {
    await express.connect(user).requestDeposit(await usdo.getAddress(), amount, user.address);
    await express.connect(maintainer).processDepositQueue(1);
  }

  describe('requestRedeem', function () {
    it('should accept a valid redeemable asset (USDO)', async function () {
      const { express, usdo, oem, user1, maintainer } = await loadFixture(deployMultiAssetFixture);

      const depositAmount = ethers.parseUnits('5000', 18);
      await depositAndGetTokens(express, usdo, user1, depositAmount, maintainer);

      const redeemAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);

      const usdoAddr = await usdo.getAddress();
      await expect(express.connect(user1).requestRedeem(user1.address, redeemAmount, usdoAddr))
        .to.emit(express, 'AddToPendingRedeemQueue')
        .withArgs(user1.address, user1.address, redeemAmount, usdoAddr, (id: string) => true);
    });

    it('should accept a different redeemable asset (USDT)', async function () {
      const { express, usdo, usdt, oem, user1, maintainer } =
        await loadFixture(deployMultiAssetFixture);

      const depositAmount = ethers.parseUnits('5000', 18);
      await depositAndGetTokens(express, usdo, user1, depositAmount, maintainer);

      const redeemAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);

      const usdtAddr = await usdt.getAddress();
      await expect(express.connect(user1).requestRedeem(user1.address, redeemAmount, usdtAddr))
        .to.emit(express, 'AddToPendingRedeemQueue')
        .withArgs(user1.address, user1.address, redeemAmount, usdtAddr, (id: string) => true);
    });

    it('should revert with AssetNotRedeemable for deposit-only asset', async function () {
      const { express, usdo, oem, depositOnlyAsset, user1, maintainer } =
        await loadFixture(deployMultiAssetFixture);

      const depositAmount = ethers.parseUnits('5000', 18);
      await depositAndGetTokens(express, usdo, user1, depositAmount, maintainer);

      const redeemAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);

      const depositOnlyAddr = await depositOnlyAsset.getAddress();
      await expect(
        express.connect(user1).requestRedeem(user1.address, redeemAmount, depositOnlyAddr)
      ).to.be.revertedWithCustomError(express, 'AssetNotRedeemable');
    });

    it('should revert with InvalidAddress for unsupported asset', async function () {
      const { express, usdo, oem, user1, maintainer } = await loadFixture(deployMultiAssetFixture);

      const depositAmount = ethers.parseUnits('5000', 18);
      await depositAndGetTokens(express, usdo, user1, depositAmount, maintainer);

      const redeemAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);

      const randomAddr = ethers.Wallet.createRandom().address;
      await expect(
        express.connect(user1).requestRedeem(user1.address, redeemAmount, randomAddr)
      ).to.be.revertedWithCustomError(express, 'InvalidAddress');
    });
  });

  describe('processRedeemQueue with multiple assets', function () {
    async function setupMultiAssetRedeemQueue(fixture: any) {
      const { express, usdo, usdt, oem, user1, user2, maintainer, operator } = fixture;

      const depositAmount = ethers.parseUnits('5000', 18);
      await depositAndGetTokens(express, usdo, user1, depositAmount, maintainer);
      await depositAndGetTokens(express, usdo, user2, depositAmount, maintainer);

      const redeemAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);

      return { redeemAmount };
    }

    it('should process redeems for multiple assets in a single batch', async function () {
      const fixture = await loadFixture(deployMultiAssetFixture);
      const { express, usdo, usdt, oem, user1, user2, operator, maintainer } = fixture;
      const { redeemAmount } = await setupMultiAssetRedeemQueue(fixture);

      const usdoAddr = await usdo.getAddress();
      const usdtAddr = await usdt.getAddress();

      // user1 redeems for USDO, user2 redeems for USDT
      await express.connect(user1).requestRedeem(user1.address, redeemAmount, usdoAddr);
      await express.connect(user2).requestRedeem(user2.address, redeemAmount, usdtAddr);

      // Advance past T+2
      const delay = await express.convertRedeemRequestsDelay();
      await time.increase(delay);

      // Snapshot and process pending to final queue
      await express.connect(operator).snapshotPendingRedeemRatio();
      await express.connect(operator).processPendingRedeems(0);

      const user1UsdoBefore = await usdo.balanceOf(user1.address);
      const user2UsdtBefore = await usdt.balanceOf(user2.address);

      // Process final redeem queue
      await express.connect(operator).processRedeemQueue(0);

      expect(await express.getRedeemQueueLength()).to.equal(0);

      // user1 should have received USDO
      const user1UsdoAfter = await usdo.balanceOf(user1.address);
      expect(user1UsdoAfter).to.be.gt(user1UsdoBefore);

      // user2 should have received USDT
      const user2UsdtAfter = await usdt.balanceOf(user2.address);
      expect(user2UsdtAfter).to.be.gt(user2UsdtBefore);
    });

    it('should stop processing when it hits an illiquid item (break-early)', async function () {
      const fixture = await loadFixture(deployMultiAssetFixture);
      const { express, usdo, usdt, oem, user1, user2, operator, maintainer } = fixture;
      const { redeemAmount } = await setupMultiAssetRedeemQueue(fixture);

      const usdoAddr = await usdo.getAddress();
      const usdtAddr = await usdt.getAddress();

      // user1 redeems for USDT (will be illiquid), user2 redeems for USDO
      await express.connect(user1).requestRedeem(user1.address, redeemAmount, usdtAddr);
      await express.connect(user2).requestRedeem(user2.address, redeemAmount, usdoAddr);

      const delay = await express.convertRedeemRequestsDelay();
      await time.increase(delay);
      await express.connect(operator).snapshotPendingRedeemRatio();
      await express.connect(operator).processPendingRedeems(0);

      // Remove USDT liquidity from Express
      const expressAddr = await express.getAddress();
      const usdtBalance = await usdt.balanceOf(expressAddr);
      await usdt.burn(expressAddr, usdtBalance);

      const user2UsdoBefore = await usdo.balanceOf(user2.address);

      // Process final queue - should STOP at the first illiquid USDT item
      await express.connect(operator).processRedeemQueue(0);

      // USDT item is first in queue, so processing breaks immediately
      // user2's USDO redeem (second in queue) is NOT processed
      const user2UsdoAfter = await usdo.balanceOf(user2.address);
      expect(user2UsdoAfter).to.equal(user2UsdoBefore);

      // Both items remain in queue
      expect(await express.getRedeemQueueLength()).to.equal(2);
    });
  });

  describe('offRamp', function () {
    it('should transfer assets to treasury', async function () {
      const fixture = await loadFixture(deployMultiAssetFixture);
      const { express, usdo, user1, operator, maintainer, treasury } = fixture;

      const depositAmount = ethers.parseUnits('5000', 18);
      await depositAndGetTokens(express, usdo, user1, depositAmount, maintainer);

      const usdoAddr = await usdo.getAddress();
      const offRampAmount = ethers.parseUnits('1000', 18);

      await expect(express.connect(operator).offRamp(usdoAddr, offRampAmount))
        .to.emit(express, 'OffRamp')
        .withArgs(treasury.address, usdoAddr, offRampAmount);
    });

    it('should allow offRamp for different asset', async function () {
      const fixture = await loadFixture(deployMultiAssetFixture);
      const { express, usdt, operator, treasury } = fixture;

      const usdtAddr = await usdt.getAddress();
      const usdtBalance = await usdt.balanceOf(await express.getAddress());

      await expect(express.connect(operator).offRamp(usdtAddr, usdtBalance))
        .to.emit(express, 'OffRamp')
        .withArgs(treasury.address, usdtAddr, usdtBalance);
    });
  });

  describe('revertRedeemToPending', function () {
    async function setupFinalRedeemQueue(fixture: any) {
      const { express, usdo, oem, user1, operator, maintainer } = fixture;

      const depositAmount = ethers.parseUnits('5000', 18);
      await depositAndGetTokens(express, usdo, user1, depositAmount, maintainer);

      const redeemAmount = ethers.parseUnits('1000', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express
        .connect(user1)
        .requestRedeem(user1.address, redeemAmount, await usdo.getAddress());

      const delay = await express.convertRedeemRequestsDelay();
      await time.increase(delay);
      await express.connect(operator).snapshotPendingRedeemRatio();
      await express.connect(operator).processPendingRedeems(0);

      return redeemAmount;
    }

    it('should migrate snapshot ratio on revert', async function () {
      const fixture = await loadFixture(deployMultiAssetFixture);
      const { express, operator } = fixture;
      await setupFinalRedeemQueue(fixture);

      // Get the final queue item's ID and verify it has a snapshot ratio
      const [, , , , , , , oldId] = await express.getRedeemQueueInfo(0);
      const originalRatio = await express.snapshotRatios(oldId);
      expect(originalRatio).to.be.gt(0);

      // Revert to pending
      await express.connect(operator).revertRedeemToPending(1);

      // Old ID ratio should be cleared
      expect(await express.snapshotRatios(oldId)).to.equal(0);

      // New pending item should have the original ratio migrated
      const [, , , , , newPendingId] = await express.getPendingRedeemQueueInfo(0);
      expect(await express.snapshotRatios(newPendingId)).to.equal(originalRatio);
    });
  });
});
