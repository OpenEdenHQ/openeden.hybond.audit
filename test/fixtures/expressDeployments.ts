import { ethers, upgrades } from 'hardhat';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

export interface ExpressDeployment {
  oem: any;
  usdo: any;
  express: any;
  assetRegistry: any;
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
    ['OEM Multi Strategy Yield', 'OEM', admin.address, ethers.parseUnits('10000000', 18)],
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

  // Deploy Express
  const ExpressFactory = await ethers.getContractFactory('Express');
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
      ethers.ZeroAddress, // priceOracle (not used for testing, 1:1 ratio)
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
