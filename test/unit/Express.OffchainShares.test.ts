import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

describe('Express - Offchain Shares', function () {
  async function deployFixture() {
    return deployExpressContracts();
  }

  async function deployAndAttachPriceOracle(express: any, maintainer: any, admin: any) {
    const latestBlock = await ethers.provider.getBlock('latest');
    const observedAt = BigInt(latestBlock!.timestamp - 1);

    const PriceOracleFactory = await ethers.getContractFactory('PriceOracle');
    const priceOracle = await upgrades.deployProxy(
      PriceOracleFactory,
      [100, 100, ethers.parseUnits('2', 18), ethers.parseUnits('2', 18), admin.address, observedAt],
      {
        kind: 'uups',
        initializer: 'initialize',
        constructorArgs: [18],
        unsafeAllow: ['state-variable-immutable'],
      }
    );
    await priceOracle.waitForDeployment();

    await express.connect(maintainer).updateMaxStalePeriod(365 * 24 * 60 * 60);
    await express.connect(maintainer).updatePriceOracle(await priceOracle.getAddress());
    return priceOracle;
  }

  // Bootstrap: deposit and process so offchainShares > 0
  async function deployWithBootstrapFixture() {
    const base = await deployFixture();
    const { express, usdo, user1, maintainer } = base;
    const depositAmt = ethers.parseUnits('2000', 18);
    await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
    await express.connect(maintainer).processDepositQueue(1, depositAmt);
    return base;
  }

  describe('updateOffchainShares', function () {
    it('reverts when called by non-MAINTAINER_ROLE', async function () {
      const { express, user1 } = await loadFixture(deployFixture);
      await expect(
        express.connect(user1).updateOffchainShares(ethers.parseUnits('1000', 18))
      ).to.be.revertedWithCustomError(express, 'AccessControlUnauthorizedAccount');
    });

    it('sets offchainShares and emits UpdateOffchainShares', async function () {
      const { express, maintainer } = await loadFixture(deployWithBootstrapFixture);
      const newValue = ethers.parseUnits('5000', 18);
      const previous = await express.offchainShares();

      await expect(express.connect(maintainer).updateOffchainShares(newValue))
        .to.emit(express, 'UpdateOffchainShares')
        .withArgs(maintainer.address, newValue, previous);

      expect(await express.offchainShares()).to.equal(newValue);
    });

    it('allows setting to zero', async function () {
      const { express, maintainer } = await loadFixture(deployWithBootstrapFixture);
      await express.connect(maintainer).updateOffchainShares(0);
      expect(await express.offchainShares()).to.equal(0n);
    });
  });

  describe('processDepositQueue updates offchainShares', function () {
    it('increments offchainShares by _newShares', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      const depositAmt = ethers.parseUnits('5000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      const sharesBefore = await express.offchainShares();
      const newShares = ethers.parseUnits('5000', 18);
      await express.connect(maintainer).processDepositQueue(1, newShares);

      expect(await express.offchainShares()).to.equal(sharesBefore + newShares);
    });

    it('reverts if _newShares is 0 when _len > 0', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      const depositAmt = ethers.parseUnits('5000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      await expect(
        express.connect(maintainer).processDepositQueue(1, 0)
      ).to.be.revertedWithCustomError(express, 'InvalidAmount');
    });

    it('reverts if queue is empty', async function () {
      const { express, maintainer } = await loadFixture(deployFixture);
      await expect(
        express.connect(maintainer).processDepositQueue(0, ethers.parseUnits('100', 18))
      ).to.be.revertedWithCustomError(express, 'EmptyQueue');
    });

    it('reverts if oracle-implied shares exceed _newShares', async function () {
      const { express, usdo, user1, maintainer, admin } = await loadFixture(deployFixture);
      await deployAndAttachPriceOracle(express, maintainer, admin);

      const depositAmt = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      const expectedMinShares = ethers.parseUnits('2500', 18);
      await expect(express.connect(maintainer).processDepositQueue(1, expectedMinShares - 1n))
        .to.be.revertedWithCustomError(express, 'InsufficientSettlementFunds')
        .withArgs(expectedMinShares, expectedMinShares - 1n);
    });

    it('allows processing when _newShares equals the oracle-implied minimum', async function () {
      const { express, usdo, oem, user1, maintainer, admin } = await loadFixture(deployFixture);
      await deployAndAttachPriceOracle(express, maintainer, admin);

      const depositAmt = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      const expectedMinShares = ethers.parseUnits('2500', 18);
      await expect(express.connect(maintainer).processDepositQueue(1, expectedMinShares)).to.not.be
        .reverted;
      expect(await express.offchainShares()).to.equal(expectedMinShares);
      expect(await oem.balanceOf(user1.address)).to.equal(expectedMinShares);
    });
  });

  describe('Pre-sync behavior (offchainShares == 0)', function () {
    it('_sharesPerToken returns 1e18 fallback before any processDepositQueue', async function () {
      const { express } = await loadFixture(deployFixture);
      expect(await express.sharesPerToken()).to.equal(ethers.parseUnits('1', 18));
    });

    it('first processDepositQueue mints 1:1 at fallback ratio', async function () {
      const { express, oem, usdo, user1, maintainer } = await loadFixture(deployFixture);
      const depositAmt = ethers.parseUnits('2000', 18);

      // Fee is 0 by default, so net = deposit amount
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
      await express.connect(maintainer).processDepositQueue(1, depositAmt);

      // At 1e18 fallback ratio: mintTotal = newShares * 1e18 / 1e18 = newShares = depositAmt
      expect(await oem.balanceOf(user1.address)).to.equal(depositAmt);
      expect(await express.offchainShares()).to.equal(depositAmt);
    });
  });

  describe('redeem after sync', function () {
    it('requestRedeem succeeds once offchainShares > 0 (post-sync)', async function () {
      const { express, oem, user1 } = await loadFixture(deployWithBootstrapFixture);

      const redeemAmt = ethers.parseUnits('100', 18);
      await oem.connect(user1).approve(await express.getAddress(), redeemAmt);

      await expect(express.connect(user1).requestRedeem(user1.address, redeemAmt)).to.not.be
        .reverted;
    });
  });

  describe('pre-sync deposit (offchainShares == 0)', function () {
    it('requestDeposit at totalSupply == 0 (original bootstrap) also succeeds', async function () {
      const { express, usdo, user1 } = await loadFixture(deployFixture);

      const depositAmt = ethers.parseUnits('2000', 18);
      await expect(
        express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address)
      ).to.not.be.reverted;
    });

    it('previewDeposit returns a non-zero mint amount at the 1e18 fallback when offchainShares == 0', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);

      // Bootstrap so totalSupply > 0 but offchainShares == 0 (process without newShares via updateOffchainShares to zero)
      const depositAmt = ethers.parseUnits('2000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
      await express.connect(maintainer).processDepositQueue(1, depositAmt);
      // Reset offchainShares to 0 to test fallback
      await express.connect(maintainer).updateOffchainShares(0);

      const previewAmt = ethers.parseUnits('1000', 18);
      const [, , netMintAmt] = await express.previewDeposit(await usdo.getAddress(), previewAmt);
      expect(netMintAmt).to.be.gt(0n);
    });

    it('concurrent bootstrap deposits can be batched', async function () {
      const { express, usdo, oem, user1, user2, maintainer } = await loadFixture(deployFixture);

      // Both users queue deposits during the pre-sync window
      const depositAmt = ethers.parseUnits('2000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), depositAmt, user2.address);
      expect(await express.getDepositQueueLength()).to.equal(2n);

      // Both mint successfully in a single batch
      const totalNewShares = depositAmt * 2n;
      await expect(express.connect(maintainer).processDepositQueue(2, totalNewShares)).to.not.be
        .reverted;

      expect(await oem.balanceOf(user1.address)).to.be.gt(0n);
      expect(await oem.balanceOf(user2.address)).to.be.gt(0n);
      expect(await express.getDepositQueueLength()).to.equal(0n);
    });
  });
});
