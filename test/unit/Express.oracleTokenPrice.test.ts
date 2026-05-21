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
  await priceOracle.connect(operator).proposePrice(tokenPriceE18, BigInt(latest!.timestamp - 1));
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
      const { express, priceOracle, usdo, user1, admin, operator, maintainer } = fixture;

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
      await expect(express.connect(maintainer).processDepositQueue(1, expectedShares)).to.not.be
        .reverted;
    });

    it('reverts when _newShares deviates >1% from (oracleTokens × sharesPerToken)', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const { express, priceOracle, usdo, user1, admin, operator, maintainer } = fixture;

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

  describe('processPendingRedeems expected-total', function () {
    it('uses stored tokenAmount × tokenPrice (not shareAmount × tokenPrice)', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const { express, oem, priceOracle, user1, admin, operator, maintainer } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);

      // Move ratio to 0.5 BEFORE the redeem so the stored shareAmount differs from tokenAmount.
      const offchainBefore = await express.offchainShares();
      await express.connect(maintainer).updateOffchainShares(offchainBefore / 2n);
      expect(await express.sharesPerToken()).to.equal(ONE / 2n);

      // Oracle: 1 HYBOND = 1.05 USDO.
      const tokenPrice = (ONE * 105n) / 100n;
      await setOraclePrice(priceOracle, admin, operator, operator, tokenPrice);

      // Tighten redeem deviation gate.
      await express.connect(maintainer).updateRedeemMaxDeviationBps(100);
      await express.connect(maintainer).updateRedeemFeeRate(0);

      // user1 holds firstDepositAmount HYBOND from bootstrap. Redeem 100.
      const redeemAmt = ethers.parseUnits('100', 18);
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await express.connect(user1).requestRedeem(user1.address, redeemAmt);

      // Stored on the queued entry:
      //   tokenAmount = 100
      //   shareAmount = 100 × 0.5 = 50
      // NEW expected-total: tokenAmount × tokenPrice = 100 × 1.05 = 105.
      // OLD expected-total would be: 50 × 1.05 = 52.5.
      const newExpected = ethers.parseUnits('105', 18);

      // Advance past the T+2 delay.
      await ethers.provider.send('evm_increaseTime', [2 * 24 * 60 * 60 + 1]);
      await ethers.provider.send('evm_mine', []);

      // Pass exactly the NEW expected total — deviation gate passes.
      await expect(express.connect(operator).processPendingRedeems(1, newExpected)).to.not.be
        .reverted;
    });

    it('Pass-2 pro-rata distributes _totalAsset by shareAmount across multiple redeems', async function () {
      // Pro-rata distribution sanity check. Two redeems with different tokenAmounts under
      // the same ratio (Express._requireQueuesEmpty prevents changing the ratio between
      // redeems, so observing shareAmount-vs-tokenAmount weighting via cross-snapshot
      // queueing is not possible; this test verifies the distribution math runs correctly
      // under the new expected-total semantics).
      const fixture = await loadFixture(deployExpressContracts);
      const { express, oem, usdo, user1, user2, admin, operator, maintainer, priceOracle } =
        fixture;

      await bootstrapAndSeedOffchainShares(fixture);

      // user1 has firstDepositAmount HYBOND. Transfer 100 to user2 so user2 can redeem.
      await oem.connect(user1).transfer(user2.address, ethers.parseUnits('100', 18));
      await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
      await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);

      await setOraclePrice(priceOracle, admin, operator, operator, ONE);
      await express.connect(maintainer).updateRedeemMaxDeviationBps(10000);
      await express.connect(maintainer).updateRedeemFeeRate(0);

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('200', 18));
      await express.connect(user2).requestRedeem(user2.address, ethers.parseUnits('100', 18));

      await ethers.provider.send('evm_increaseTime', [2 * 24 * 60 * 60 + 1]);
      await ethers.provider.send('evm_mine', []);

      // expectedTotal under new semantics: (200 + 100) × 1.0 = 300.
      const totalAsset = ethers.parseUnits('300', 18);
      const balUser1Before = await usdo.balanceOf(user1.address);
      const balUser2Before = await usdo.balanceOf(user2.address);

      await express.connect(operator).processPendingRedeems(2, totalAsset);
      await express.connect(operator).processRedeemQueue(2);

      // 2:1 share-weighted split: user1 gets 200, user2 gets 100.
      const payA = (await usdo.balanceOf(user1.address)) - balUser1Before;
      const payB = (await usdo.balanceOf(user2.address)) - balUser2Before;
      expect(payA).to.equal(ethers.parseUnits('200', 18));
      expect(payB).to.equal(ethers.parseUnits('100', 18));
    });
  });

  describe('regression — bootstrap path (oracle=1e18, ratio=1e18)', function () {
    it('previewRedeem returns _tokenAmount net of fee at bootstrap', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const { express, maintainer } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);
      // Oracle stays at the fixture default (1e18). Ratio is 1e18.

      await express.connect(maintainer).updateRedeemFeeRate(0);

      const amt = ethers.parseUnits('1', 18);
      const [, redeemAssetAmt] = await express.previewRedeem(amt);
      expect(redeemAssetAmt).to.equal(amt);
    });

    it('processDepositQueue deviation gate is permissive when oracle=1e18 and ratio=1e18', async function () {
      const fixture = await loadFixture(deployExpressContracts);
      const { express, usdo, user1, maintainer } = fixture;

      await bootstrapAndSeedOffchainShares(fixture);

      await express.connect(maintainer).updateDepositMaxDeviationBps(100);
      await express.connect(maintainer).updateDepositFeeRate(0);

      const depositAmt = ethers.parseUnits('1000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      // 1000 / 1.0 = 1000 oracleTokens; × 1.0 = 1000 oracleShares.
      await expect(
        express.connect(maintainer).processDepositQueue(1, ethers.parseUnits('1000', 18))
      ).to.not.be.reverted;
    });
  });
});
