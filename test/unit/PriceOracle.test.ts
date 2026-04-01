import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

describe('PriceOracle', function () {
  const ORACLE_DECIMALS = 18;

  async function deployFixture() {
    const [admin, operator, confirmer, user] = await ethers.getSigners();

    const PriceOracleFactory = await ethers.getContractFactory('PriceOracle');
    const priceOracle = await upgrades.deployProxy(
      PriceOracleFactory,
      [100, 100, ethers.parseUnits('1', ORACLE_DECIMALS), ethers.parseUnits('1', ORACLE_DECIMALS), admin.address],
      {
        kind: 'uups',
        initializer: 'initialize',
        constructorArgs: [ORACLE_DECIMALS],
        unsafeAllow: ['state-variable-immutable'],
      }
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
      expect(answer).to.equal(ethers.parseUnits('1', ORACLE_DECIMALS));
      expect(answeredInRound).to.equal(1);
      expect(await priceOracle.referencePrice()).to.equal(ethers.parseUnits('1', ORACLE_DECIMALS));
      expect(await priceOracle.relativeMaxDeviation()).to.equal(100);
      expect(await priceOracle.absoluteMaxDeviation()).to.equal(100);
      expect(await priceOracle.PENDING_PRICE_TTL()).to.equal(24 * 60 * 60);
    });

    it('should set decimals as immutable via constructor', async function () {
      const { priceOracle } = await loadFixture(deployFixture);
      expect(await priceOracle.decimals()).to.equal(ORACLE_DECIMALS);
    });
  });

  describe('Price Updates', function () {
    it('should revert if caller does not have OPERATOR_ROLE when proposing', async function () {
      const { priceOracle, user } = await loadFixture(deployFixture);

      await expect(
        priceOracle.connect(user).proposePrice(ethers.parseUnits('1.005', ORACLE_DECIMALS))
      ).to.be.revertedWithCustomError(priceOracle, 'AccessControlUnauthorizedAccount');
    });

    it('should keep the old price active until confirmation', async function () {
      const { priceOracle, operator, confirmer } = await loadFixture(deployFixture);

      await expect(priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.005', ORACLE_DECIMALS)))
        .to.emit(priceOracle, 'PriceProposed')
        .withArgs(ethers.parseUnits('1', ORACLE_DECIMALS), ethers.parseUnits('1.005', ORACLE_DECIMALS), operator.address);

      expect(await priceOracle.latestAnswer()).to.equal(ethers.parseUnits('1', ORACLE_DECIMALS));

      const [pendingPrice, , proposer, exists] = await priceOracle.pendingPrice();
      expect(pendingPrice).to.equal(ethers.parseUnits('1.005', ORACLE_DECIMALS));
      expect(proposer).to.equal(operator.address);
      expect(exists).to.equal(true);

      await expect(priceOracle.connect(confirmer).confirmPrice(ethers.parseUnits('1.005', ORACLE_DECIMALS)))
        .to.emit(priceOracle, 'UpdatePrice')
        .withArgs(ethers.parseUnits('1', ORACLE_DECIMALS), ethers.parseUnits('1.005', ORACLE_DECIMALS));

      expect(await priceOracle.latestAnswer()).to.equal(ethers.parseUnits('1.005', ORACLE_DECIMALS));
      expect((await priceOracle.pendingPrice())[3]).to.equal(false);
    });

    it('should revert when the new price exceeds the last answer deviation threshold', async function () {
      const { priceOracle, operator } = await loadFixture(deployFixture);

      await expect(
        priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.02', ORACLE_DECIMALS))
      ).to.be.revertedWithCustomError(priceOracle, 'RelativeDeviationTooLarge');
    });

    it('should revert when the new price exceeds the reference price deviation threshold', async function () {
      const { priceOracle, admin, operator } = await loadFixture(deployFixture);

      await priceOracle.connect(admin).updateRelativeMaxDeviation(1000);

      await expect(
        priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.05', ORACLE_DECIMALS))
      ).to.be.revertedWithCustomError(priceOracle, 'AbsoluteDeviationTooLarge');
    });

    it('should allow updating the reference-based safeguard independently', async function () {
      const { priceOracle, admin, operator } = await loadFixture(deployFixture);

      await priceOracle.connect(admin).updateRelativeMaxDeviation(1000);
      await priceOracle.connect(admin).updateAbsoluteMaxDeviation(1000);
      await priceOracle.connect(admin).updateReferencePrice(ethers.parseUnits('1.05', ORACLE_DECIMALS));

      await expect(priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.05', ORACLE_DECIMALS)))
        .to.emit(priceOracle, 'PriceProposed')
        .withArgs(ethers.parseUnits('1', ORACLE_DECIMALS), ethers.parseUnits('1.05', ORACLE_DECIMALS), operator.address);
    });

    it('should allow the operator to cancel a pending price', async function () {
      const { priceOracle, operator } = await loadFixture(deployFixture);

      await priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.005', ORACLE_DECIMALS));

      await expect(priceOracle.connect(operator).cancelPendingPrice())
        .to.emit(priceOracle, 'PendingPriceCancelled')
        .withArgs(ethers.parseUnits('1.005', ORACLE_DECIMALS), operator.address);

      expect((await priceOracle.pendingPrice())[3]).to.equal(false);
    });

    it('should block guardrail config changes while a pending price exists', async function () {
      const { priceOracle, admin, operator } = await loadFixture(deployFixture);

      await priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.005', ORACLE_DECIMALS));

      await expect(
        priceOracle.connect(admin).updateRelativeMaxDeviation(200)
      ).to.be.revertedWithCustomError(priceOracle, 'PendingPriceExists');
      await expect(
        priceOracle.connect(admin).updateAbsoluteMaxDeviation(200)
      ).to.be.revertedWithCustomError(priceOracle, 'PendingPriceExists');
      await expect(
        priceOracle.connect(admin).updateReferencePrice(ethers.parseUnits('1.01', ORACLE_DECIMALS))
      ).to.be.revertedWithCustomError(priceOracle, 'PendingPriceExists');
    });

    it('should revert when confirmed price does not match pending price', async function () {
      const { priceOracle, operator, confirmer } = await loadFixture(deployFixture);

      await priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.005', ORACLE_DECIMALS));

      await expect(priceOracle.connect(confirmer).confirmPrice(ethers.parseUnits('1.003', ORACLE_DECIMALS)))
        .to.be.revertedWithCustomError(priceOracle, 'PriceMismatch')
        .withArgs(ethers.parseUnits('1.003', ORACLE_DECIMALS), ethers.parseUnits('1.005', ORACLE_DECIMALS));
    });

    it('should revert when confirming an expired pending price', async function () {
      const { priceOracle, operator, confirmer } = await loadFixture(deployFixture);

      await priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.005', ORACLE_DECIMALS));

      const [, proposedAt] = await priceOracle.pendingPrice();
      const ttl = await priceOracle.PENDING_PRICE_TTL();
      await time.increaseTo(proposedAt + ttl + 1n);

      await expect(
        priceOracle.connect(confirmer).confirmPrice(ethers.parseUnits('1.005', ORACLE_DECIMALS))
      ).to.be.revertedWithCustomError(priceOracle, 'PendingPriceExpired');

      expect(await priceOracle.latestAnswer()).to.equal(ethers.parseUnits('1', ORACLE_DECIMALS));
    });
  });

  describe('getRoundData (WP-L2)', function () {
    it('should return historical round data', async function () {
      const { priceOracle, operator, confirmer } = await loadFixture(deployFixture);

      const [roundId1, answer1, , , answeredInRound1] = await priceOracle.getRoundData(1);
      expect(roundId1).to.equal(1);
      expect(answer1).to.equal(ethers.parseUnits('1', ORACLE_DECIMALS));
      expect(answeredInRound1).to.equal(1);

      await priceOracle.connect(operator).proposePrice(ethers.parseUnits('1.005', ORACLE_DECIMALS));
      await priceOracle.connect(confirmer).confirmPrice(ethers.parseUnits('1.005', ORACLE_DECIMALS));

      const [roundId2, answer2, , , answeredInRound2] = await priceOracle.getRoundData(2);
      expect(roundId2).to.equal(2);
      expect(answer2).to.equal(ethers.parseUnits('1.005', ORACLE_DECIMALS));
      expect(answeredInRound2).to.equal(2);

      const [, answer1After] = await priceOracle.getRoundData(1);
      expect(answer1After).to.equal(ethers.parseUnits('1', ORACLE_DECIMALS));
    });

    it('should revert for invalid round IDs', async function () {
      const { priceOracle } = await loadFixture(deployFixture);

      await expect(priceOracle.getRoundData(0)).to.be.revertedWithCustomError(priceOracle, 'InvalidRoundId');
      await expect(priceOracle.getRoundData(2)).to.be.revertedWithCustomError(priceOracle, 'InvalidRoundId');
    });
  });

  describe('Chainlink compatibility (WP-I4)', function () {
    it('should return int256 from latestAnswer', async function () {
      const { priceOracle } = await loadFixture(deployFixture);
      const answer = await priceOracle.latestAnswer();
      expect(answer).to.equal(ethers.parseUnits('1', ORACLE_DECIMALS));
    });

    it('should return int256 answer from latestRoundData', async function () {
      const { priceOracle } = await loadFixture(deployFixture);
      const [, answer] = await priceOracle.latestRoundData();
      expect(answer).to.equal(ethers.parseUnits('1', ORACLE_DECIMALS));
    });

    it('should return uint256 from version()', async function () {
      const { priceOracle } = await loadFixture(deployFixture);
      expect(await priceOracle.version()).to.equal(2);
    });
  });
});
