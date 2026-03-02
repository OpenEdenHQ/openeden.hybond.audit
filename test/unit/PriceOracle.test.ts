import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

describe('PriceOracle', function () {
  async function deployFixture() {
    const [admin, operator, confirmer, user] = await ethers.getSigners();

    const PriceOracleFactory = await ethers.getContractFactory('PriceOracle');
    const priceOracle = await upgrades.deployProxy(
      PriceOracleFactory,
      [18, 100, 100, ethers.parseUnits('1', 18), ethers.parseUnits('1', 18), admin.address],
      { kind: 'uups', initializer: 'initialize' }
    );
    await priceOracle.waitForDeployment();

    const OPERATOR_ROLE = await priceOracle.OPERATOR_ROLE();
    const CONFIRMER_ROLE = await priceOracle.CONFIRMER_ROLE();

    await priceOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
    await priceOracle.connect(admin).grantRole(CONFIRMER_ROLE, confirmer.address);

    return {
      priceOracle,
      admin,
      operator,
      confirmer,
      user,
    };
  }

  describe('Initialization', function () {
    it('should grant only the admin role to admin during initialization', async function () {
      const { priceOracle, admin } = await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await priceOracle.DEFAULT_ADMIN_ROLE();
      const OPERATOR_ROLE = await priceOracle.OPERATOR_ROLE();
      const CONFIRMER_ROLE = await priceOracle.CONFIRMER_ROLE();
      const UPGRADE_ROLE = await priceOracle.UPGRADE_ROLE();

      expect(await priceOracle.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await priceOracle.hasRole(OPERATOR_ROLE, admin.address)).to.be.false;
      expect(await priceOracle.hasRole(CONFIRMER_ROLE, admin.address)).to.be.false;
      expect(await priceOracle.hasRole(UPGRADE_ROLE, admin.address)).to.be.false;
    });

    it('should initialize the first round and reference price correctly', async function () {
      const { priceOracle } = await loadFixture(deployFixture);

      const [roundId, answer, , , answeredInRound] = await priceOracle.latestRoundData();

      expect(roundId).to.equal(1);
      expect(answer).to.equal(ethers.parseUnits('1', 18));
      expect(answeredInRound).to.equal(1);
      expect(await priceOracle.referencePrice()).to.equal(ethers.parseUnits('1', 18));
      expect(await priceOracle.relativeMaxDeviation()).to.equal(100);
      expect(await priceOracle.absoluteMaxDeviation()).to.equal(100);
      expect(await priceOracle.PENDING_PRICE_TTL()).to.equal(24 * 60 * 60);
    });
  });

  describe('Price Updates', function () {
    it('should revert if caller does not have OPERATOR_ROLE when proposing', async function () {
      const { priceOracle, user } = await loadFixture(deployFixture);

      await expect(
        priceOracle.connect(user).proposePrice(ethers.parseUnits('1.005', 18))
      ).to.be.revertedWithCustomError(priceOracle, 'AccessControlUnauthorizedAccount');
    });

    it('should keep the old price active until confirmation', async function () {
      const { priceOracle, operator, confirmer } = await loadFixture(deployFixture);

      await expect(priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.005', 18)))
        .to.emit(priceOracle, 'PriceProposed')
        .withArgs(ethers.parseUnits('1', 18), ethers.parseUnits('1.005', 18), operator.address);

      expect(await priceOracle.latestAnswer()).to.equal(ethers.parseUnits('1', 18));

      const [pendingPrice, , proposer, exists] = await priceOracle.pendingPrice();
      expect(pendingPrice).to.equal(ethers.parseUnits('1.005', 18));
      expect(proposer).to.equal(operator.address);
      expect(exists).to.equal(true);

      await expect(priceOracle.connect(confirmer).confirmPrice())
        .to.emit(priceOracle, 'UpdatePrice')
        .withArgs(ethers.parseUnits('1', 18), ethers.parseUnits('1.005', 18));

      expect(await priceOracle.latestAnswer()).to.equal(ethers.parseUnits('1.005', 18));
      expect((await priceOracle.pendingPrice())[3]).to.equal(false);
    });

    it('should revert when the new price exceeds the last answer deviation threshold', async function () {
      const { priceOracle, operator } = await loadFixture(deployFixture);

      await expect(
        priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.02', 18))
      ).to.be.revertedWithCustomError(priceOracle, 'RelativeDeviationTooLarge');
    });

    it('should revert when the new price exceeds the reference price deviation threshold', async function () {
      const { priceOracle, admin, operator } = await loadFixture(deployFixture);

      await priceOracle.connect(admin).updateRelativeMaxDeviation(1000);

      await expect(
        priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.05', 18))
      ).to.be.revertedWithCustomError(priceOracle, 'AbsoluteDeviationTooLarge');
    });

    it('should allow updating the reference-based safeguard independently', async function () {
      const { priceOracle, admin, operator } = await loadFixture(deployFixture);

      await priceOracle.connect(admin).updateRelativeMaxDeviation(1000);
      await priceOracle.connect(admin).updateAbsoluteMaxDeviation(1000);
      await priceOracle.connect(admin).updateReferencePrice(ethers.parseUnits('1.05', 18));

      await expect(priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.05', 18)))
        .to.emit(priceOracle, 'PriceProposed')
        .withArgs(ethers.parseUnits('1', 18), ethers.parseUnits('1.05', 18), operator.address);
    });

    it('should allow the operator to cancel a pending price', async function () {
      const { priceOracle, operator } = await loadFixture(deployFixture);

      await priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.005', 18));

      await expect(priceOracle.connect(operator).cancelPendingPrice())
        .to.emit(priceOracle, 'PendingPriceCancelled')
        .withArgs(ethers.parseUnits('1.005', 18), operator.address);

      expect((await priceOracle.pendingPrice())[3]).to.equal(false);
    });

    it('should block guardrail config changes while a pending price exists', async function () {
      const { priceOracle, admin, operator } = await loadFixture(deployFixture);

      await priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.005', 18));

      await expect(
        priceOracle.connect(admin).updateRelativeMaxDeviation(200)
      ).to.be.revertedWithCustomError(priceOracle, 'PendingPriceExists');
      await expect(
        priceOracle.connect(admin).updateAbsoluteMaxDeviation(200)
      ).to.be.revertedWithCustomError(priceOracle, 'PendingPriceExists');
      await expect(
        priceOracle.connect(admin).updateReferencePrice(ethers.parseUnits('1.01', 18))
      ).to.be.revertedWithCustomError(priceOracle, 'PendingPriceExists');
    });

    it('should revert when confirming an expired pending price', async function () {
      const { priceOracle, operator, confirmer } = await loadFixture(deployFixture);

      await priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.005', 18));

      const [, proposedAt] = await priceOracle.pendingPrice();
      const ttl = await priceOracle.PENDING_PRICE_TTL();
      await time.increaseTo(proposedAt + ttl + 1n);

      await expect(priceOracle.connect(confirmer).confirmPrice()).to.be.revertedWithCustomError(
        priceOracle,
        'PendingPriceExpired'
      );

      expect(await priceOracle.latestAnswer()).to.equal(ethers.parseUnits('1', 18));
    });
  });
});
