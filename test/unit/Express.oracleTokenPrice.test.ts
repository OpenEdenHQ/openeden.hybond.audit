import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import {
  deployExpressContracts,
  bootstrapAndSeedOffchainShares,
} from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);

// Move the oracle's published price to `tokenPriceE18` via the propose/confirm flow.
// PriceOracle decimals = 18, so the value passes straight through to getPrice().
async function setOraclePrice(
  priceOracle: any,
  admin: any,
  operator: any,
  confirmer: any,
  tokenPriceE18: bigint
) {
  const OPERATOR_ROLE = await priceOracle.OPERATOR_ROLE();
  const CONFIRMER_ROLE = await priceOracle.CONFIRMER_ROLE();
  if (!(await priceOracle.hasRole(OPERATOR_ROLE, operator.address))) {
    await priceOracle.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
  }
  if (!(await priceOracle.hasRole(CONFIRMER_ROLE, confirmer.address))) {
    await priceOracle.connect(admin).grantRole(CONFIRMER_ROLE, confirmer.address);
  }
  // Widen deviation gates on the oracle so we can move the price freely in tests.
  await priceOracle.connect(admin).updateRelativeMaxDeviation(10000);
  await priceOracle.connect(admin).updateAbsoluteMaxDeviation(10000);

  const latest = await ethers.provider.getBlock('latest');
  await priceOracle
    .connect(operator)
    .proposePrice(tokenPriceE18, BigInt(latest!.timestamp - 1));
  await priceOracle.connect(confirmer).confirmPrice(tokenPriceE18);
}

describe('Express — oracle returns token price (assets per HYBOND token)', function () {
  describe('previewRedeem', function () {
    it('returns tokens × tokenPrice independently of sharesPerToken', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const { express, priceOracle, admin, operator, maintainer } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);

      // Skew the ratio: bootstrap left offchainShares == totalSupply.
      // Halve offchainShares → sharesPerToken = 0.5e18.
      const offchainBefore = await express.offchainShares();
      await express.connect(maintainer).updateOffchainShares(offchainBefore / 2n);
      expect(await express.sharesPerToken()).to.equal(ONE / 2n);

      // Oracle: 1 HYBOND = 1.05 USDO (token price, not share price).
      const tokenPrice = (ONE * 105n) / 100n;
      await setOraclePrice(priceOracle, admin, operator, operator, tokenPrice);

      await express.connect(maintainer).updateRedeemFeeRate(0);

      const oneHybond = ONE;
      const [, redeemAssetAmt] = await express.previewRedeem(oneHybond);

      // Under NEW semantics: 1 token × 1.05 token-price = 1.05.
      // Under OLD semantics: shareAmount = 1 × 0.5 = 0.5; 0.5 × 1.05 = 0.525.
      expect(redeemAssetAmt).to.equal(tokenPrice);
    });
  });

  describe('processDepositQueue deviation gate', function () {
    it('derives oracleShares as (oracleTokens × sharesPerToken) and accepts matching _newShares', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const {
        express,
        priceOracle,
        usdo,
        user1,
        admin,
        operator,
        maintainer,
      } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);

      // Skew ratio: sharesPerToken = 0.5e18.
      const offchainBefore = await express.offchainShares();
      await express.connect(maintainer).updateOffchainShares(offchainBefore / 2n);
      expect(await express.sharesPerToken()).to.equal(ONE / 2n);

      // Oracle: 1 HYBOND = 1.05 USDO.
      const tokenPrice = (ONE * 105n) / 100n;
      await setOraclePrice(priceOracle, admin, operator, operator, tokenPrice);

      // Tighten the deposit deviation gate to 1% so we actually test the path.
      await express.connect(maintainer).updateDepositMaxDeviationBps(100);
      await express.connect(maintainer).updateDepositFeeRate(0);

      // user1 deposits 1050 USDO. Net = 1050 (fee 0).
      const depositAmt = ethers.parseUnits('1050', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      // Operator-derived oracleTokens = 1050 / 1.05 = 1000 HYBOND.
      // oracleShares = 1000 × 0.5 = 500 shares.
      const expectedShares = ethers.parseUnits('500', 18);

      // Pass exactly the oracle-implied shares — deviation gate passes.
      await expect(
        express.connect(maintainer).processDepositQueue(1, expectedShares)
      ).to.not.be.reverted;
    });

    it('reverts when _newShares deviates >1% from (oracleTokens × sharesPerToken)', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const {
        express,
        priceOracle,
        usdo,
        user1,
        admin,
        operator,
        maintainer,
      } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);
      const offchainBefore = await express.offchainShares();
      await express.connect(maintainer).updateOffchainShares(offchainBefore / 2n);

      const tokenPrice = (ONE * 105n) / 100n;
      await setOraclePrice(priceOracle, admin, operator, operator, tokenPrice);

      await express.connect(maintainer).updateDepositMaxDeviationBps(100);
      await express.connect(maintainer).updateDepositFeeRate(0);

      const depositAmt = ethers.parseUnits('1050', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      // 10% off expectedShares = 500 → 550 → must revert.
      const wrong = ethers.parseUnits('550', 18);
      await expect(
        express.connect(maintainer).processDepositQueue(1, wrong)
      ).to.be.revertedWithCustomError(express, 'OracleDeviationExceeded');
    });
  });
});
