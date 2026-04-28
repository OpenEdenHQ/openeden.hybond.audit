import { ethers, upgrades } from 'hardhat';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

export interface ExpressDeployment {
  oem: any;
  usdo: any;
  express: any;
  assetRegistry: any;
  priceOracle: any;
  admin: HardhatEthersSigner;
  operator: HardhatEthersSigner;
  maintainer: HardhatEthersSigner;
  whitelister: HardhatEthersSigner;
  pauser: HardhatEthersSigner;
  treasury: HardhatEthersSigner;
  feeTo: HardhatEthersSigner;
  user1: HardhatEthersSigner;
  user2: HardhatEthersSigner;
  user3: HardhatEthersSigner;
}

export const DEFAULT_MAX_STALE_PERIOD = 365 * 24 * 60 * 60; // 365 days — long enough for time-skipping tests

export async function deployExpressContracts(): Promise<ExpressDeployment> {
  const [admin, operator, maintainer, whitelister, pauser, treasury, feeTo, user1, user2, user3] =
    await ethers.getSigners();

  // Deploy mock USDO (ERC20)
  const MockERC20Factory = await ethers.getContractFactory('MockERC20');
  const usdo = await MockERC20Factory.deploy('USDO Token', 'USDO', 18);
  await usdo.waitForDeployment();

  // Deploy OEM token
  const OEMFactory = await ethers.getContractFactory('Token');
  const oem = await upgrades.deployProxy(
    OEMFactory,
    [
      'OEM Multi Strategy Yield',
      'OEM',
      admin.address,
      ethers.parseUnits('10000000', 18),
      ethers.ZeroAddress,
    ],
    { kind: 'uups', initializer: 'initialize' }
  );
  await oem.waitForDeployment();

  // Deploy AssetRegistry
  const AssetRegistryFactory = await ethers.getContractFactory('AssetRegistry');
  const assetRegistry = await upgrades.deployProxy(AssetRegistryFactory, [admin.address], {
    kind: 'uups',
    initializer: 'initialize',
  });
  await assetRegistry.waitForDeployment();

  // Configure USDO asset in registry (1:1 with OEM, no price feed)
  await assetRegistry.connect(admin).setAssetConfig({
    asset: await usdo.getAddress(),
    priceFeed: ethers.ZeroAddress,
    isSupported: true,
    maxStalePeriod: 0,
  });

  // Deploy PriceOracle (price = 1e18 → 1:1 ratio so existing tests behave as before)
  const latestBlock = await ethers.provider.getBlock('latest');
  const observedAt = BigInt(latestBlock!.timestamp - 1);
  const PriceOracleFactory = await ethers.getContractFactory('PriceOracle');
  const priceOracle = await upgrades.deployProxy(
    PriceOracleFactory,
    [100, 100, ethers.parseUnits('1', 18), ethers.parseUnits('1', 18), admin.address, observedAt],
    {
      kind: 'uups',
      initializer: 'initialize',
      constructorArgs: [18],
      unsafeAllow: ['state-variable-immutable'],
    }
  );
  await priceOracle.waitForDeployment();

  // Deploy Express
  const ExpressFactory = await ethers.getContractFactory('contracts/extension/Express.sol:Express');
  const express = await upgrades.deployProxy(
    ExpressFactory,
    [
      await oem.getAddress(),
      await usdo.getAddress(),
      treasury.address,
      feeTo.address,
      treasury.address, // mgtFeeTo (using treasury for simplicity)
      admin.address,
      await assetRegistry.getAddress(),
      await priceOracle.getAddress(),
      DEFAULT_MAX_STALE_PERIOD,
      {
        depositMinimum: ethers.parseUnits('100', 18), // 100 OEM minimum
        redeemMinimum: ethers.parseUnits('50', 18), // 50 OEM minimum
        firstDepositAmount: ethers.parseUnits('1000', 18), // 1000 OEM first deposit
      },
    ],
    { kind: 'uups', initializer: 'initialize' }
  );
  await express.waitForDeployment();

  // Grant roles to express contract
  const MINTER_ROLE = await oem.MINTER_ROLE();
  const BURNER_ROLE = await oem.BURNER_ROLE();
  await oem.connect(admin).grantRole(MINTER_ROLE, await express.getAddress());
  await oem.connect(admin).grantRole(BURNER_ROLE, await express.getAddress());

  // Grant roles to designated accounts
  const OPERATOR_ROLE = await express.OPERATOR_ROLE();
  const MAINTAINER_ROLE = await express.MAINTAINER_ROLE();
  const WHITELIST_ROLE = await express.WHITELIST_ROLE();
  const PAUSE_ROLE = await express.PAUSE_ROLE();
  const UPGRADE_ROLE = await express.UPGRADE_ROLE();

  await express.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
  await express.connect(admin).grantRole(MAINTAINER_ROLE, maintainer.address);
  await express.connect(admin).grantRole(WHITELIST_ROLE, whitelister.address);
  await express.connect(admin).grantRole(PAUSE_ROLE, pauser.address);
  await express.connect(admin).grantRole(UPGRADE_ROLE, admin.address);

  // Mint USDO to users for testing
  const mintAmount = ethers.parseUnits('100000', 18);
  await usdo.mint(user1.address, mintAmount);
  await usdo.mint(user2.address, mintAmount);
  await usdo.mint(user3.address, mintAmount);
  await usdo.mint(await express.getAddress(), mintAmount); // For redemptions liquidity

  // Approve express contract to spend USDO
  await usdo.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
  await usdo.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);
  await usdo.connect(user3).approve(await express.getAddress(), ethers.MaxUint256);

  // Set convertRedeemRequestsDelay (T+2 = 2 days) and timeBuffer (20 hours)
  await express.connect(maintainer).updateConvertRedeemRequestsDelay(2 * 24 * 60 * 60); // 2 days
  await express.connect(maintainer).updateTimeBuffer(72000); // 20 hours

  // Grant KYC to test users
  await express
    .connect(whitelister)
    .grantKycInBulk([user1.address, user2.address, user3.address, treasury.address, feeTo.address]);

  return {
    oem,
    usdo,
    express,
    assetRegistry,
    priceOracle,
    admin,
    operator,
    maintainer,
    whitelister,
    pauser,
    treasury,
    feeTo,
    user1,
    user2,
    user3,
  };
}

/**
 * Seeds offchainShares after a bootstrap deposit so downstream tests can
 * do additional deposits priced against a real offchainShares value.
 *
 * Flow:
 *   1. User1 deposits firstDepositAmount (totalSupply == 0 → bootstrap allowed)
 *   2. Maintainer processes the queue with newShares = firstDepositAmount
 *      (mints HYBOND at 1:1 via fallback ratio, sets offchainShares automatically)
 *
 * After this helper, subsequent tests see:
 *   - user1 holds `firstDepositAmount` HYBOND
 *   - offchainShares == totalSupply → sharesPerToken == 1e18
 */
export async function bootstrapAndSeedOffchainShares(
  deployment: ExpressDeployment
): Promise<{ depositedAmount: bigint }> {
  const { express, usdo, user1, maintainer } = deployment;

  const firstDepositAmount = await express.firstDepositAmount();

  // Bootstrap deposit
  await express
    .connect(user1)
    .requestDeposit(await usdo.getAddress(), firstDepositAmount, user1.address);

  // Process with newShares = firstDepositAmount (1:1 at bootstrap, ratio fallback is 1e18)
  await express.connect(maintainer).processDepositQueue(1, firstDepositAmount);

  return { depositedAmount: firstDepositAmount };
}
