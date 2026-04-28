import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { getConfigSection, getConfigValue, loadNetworkConfig } from './config';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const hreAny = hre as any;
  const { deployments: deployerDeployments, getNamedAccounts, network } = hreAny;
  const ethers = hreAny.ethers;
  const upgrades = hreAny.upgrades;
  const run = hreAny.run;
  const { get } = deployerDeployments;
  const { deployer } = await getNamedAccounts();
  const config = loadNetworkConfig(network.name);
  const commonConfig = getConfigSection(config, 'Common');
  const hybondConfig = getConfigSection(config, 'HYBOND');
  const assetRegistryConfig = getConfigSection(config, 'AssetRegistry');
  const priceOracleConfig = getConfigSection(config, 'PriceOracle');
  const expressConfig = getConfigSection(config, 'Express');
  const adminConfig = getConfigValue<string>(commonConfig, 'admin');
  const admin = adminConfig === ethers.ZeroAddress ? deployer : adminConfig;

  console.log('🚀 Deploying HYBOND System Contracts');
  console.log('📌 Deployer address:', deployer);

  // ============================================
  // Configuration Parameters
  // ============================================

  // HYBOND Token parameters
  const tokenName = getConfigValue<string>(hybondConfig, 'name');
  const tokenSymbol = getConfigValue<string>(hybondConfig, 'symbol');
  const tokenIssueCap = ethers.parseUnits(getConfigValue<string>(hybondConfig, 'issueCap'), 18);
  const tokenPermissioned = getConfigValue<boolean>(commonConfig, 'tokenPermissioned');

  // Express parameters
  const depositMinimum = ethers.parseUnits(
    getConfigValue<string>(expressConfig, 'depositMinimum'),
    18
  );
  const redeemMinimum = ethers.parseUnits(
    getConfigValue<string>(expressConfig, 'redeemMinimum'),
    18
  );
  const firstDepositAmount = ethers.parseUnits(
    getConfigValue<string>(expressConfig, 'firstDepositAmount'),
    18
  );
  const maxStalePeriod = getConfigValue<number>(expressConfig, 'maxStalePeriod');

  // Addresses (set these or use deployer as placeholder)
  const treasuryConfig = getConfigValue<string>(expressConfig, 'treasury');
  const treasury = treasuryConfig === ethers.ZeroAddress ? deployer : treasuryConfig;
  const txFeeToConfig = getConfigValue<string>(expressConfig, 'txFeeTo');
  const txFeeTo = txFeeToConfig === ethers.ZeroAddress ? deployer : txFeeToConfig;
  const mgtFeeToConfig = getConfigValue<string>(expressConfig, 'mgtFeeTo');
  const mgtFeeTo = mgtFeeToConfig === ethers.ZeroAddress ? deployer : mgtFeeToConfig;
  const usdcAddress = getConfigValue<string>(assetRegistryConfig, 'usdcAsset');

  // ============================================
  // 1. Deploy MockERC20 (if needed for testing)
  // ============================================
  let usdc: any;
  let usdcAddressFinal = usdcAddress;

  if (
    usdcAddress === ethers.ZeroAddress &&
    (network.name === 'hardhat' || network.name === 'localhost')
  ) {
    console.log('\n1️⃣ Deploying MockERC20 (USDC) for testing...');
    const MockERC20 = await ethers.getContractFactory('MockERC20');
    usdc = await MockERC20.deploy('USD Coin', 'USDC', 6);
    await usdc.waitForDeployment();
    usdcAddressFinal = await usdc.getAddress();
    console.log('✅ MockERC20 (USDC) deployed to:', usdcAddressFinal);
  } else if (usdcAddress === ethers.ZeroAddress) {
    throw new Error('USDC address must be set for non-local networks');
  } else {
    usdcAddressFinal = usdcAddress;
    console.log('\n1️⃣ Using existing USDC token at:', usdcAddressFinal);
  }

  // ============================================
  // 1.5. Deploy KycManager
  // ============================================
  console.log('\n1️⃣.5️⃣ Deploying KycManager...');
  const KycManagerFactory = await ethers.getContractFactory('KycManager');
  const kycManager = await upgrades.deployProxy(KycManagerFactory, [admin], {
    initializer: 'initialize',
    kind: 'uups',
  });
  await kycManager.waitForDeployment();
  const kycManagerAddress = await kycManager.getAddress();
  console.log('✅ KycManager deployed to:', kycManagerAddress);

  const tokenKycManagerArg = tokenPermissioned ? kycManagerAddress : ethers.ZeroAddress;
  console.log(
    '📌 Token mode:',
    tokenPermissioned ? `permissioned (kycManager=${kycManagerAddress})` : 'permissionless'
  );

  // ============================================
  // 2. Deploy HYBOND Token
  // ============================================
  console.log('\n2️⃣ Deploying HYBOND token...');
  const Token = await ethers.getContractFactory('Token');
  const hybond = await upgrades.deployProxy(
    Token,
    [tokenName, tokenSymbol, admin, tokenIssueCap, tokenKycManagerArg],
    {
      initializer: 'initialize',
      kind: 'uups',
    }
  );
  await hybond.waitForDeployment();
  const hybondTokenAddress = await hybond.getAddress();
  console.log('✅ HYBOND Token deployed to:', hybondTokenAddress);
  console.log('📌 Issue Cap:', tokenIssueCap > 0 ? ethers.formatEther(tokenIssueCap) : 'Unlimited');

  // ============================================
  // 3. Deploy AssetRegistry
  // ============================================
  console.log('\n3️⃣ Deploying AssetRegistry...');
  const AssetRegistry = await ethers.getContractFactory('AssetRegistry');
  const assetRegistry = await upgrades.deployProxy(AssetRegistry, [admin], {
    initializer: 'initialize',
    kind: 'uups',
  });
  await assetRegistry.waitForDeployment();
  const assetRegistryAddress = await assetRegistry.getAddress();
  console.log('✅ AssetRegistry deployed to:', assetRegistryAddress);

  // Configure USDC asset in registry (1:1 with HYBOND, no price feed for now)
  console.log('📌 Configuring USDC asset in registry...');
  await assetRegistry.setAssetConfig({
    asset: usdcAddressFinal,
    priceFeed: getConfigValue<string>(assetRegistryConfig, 'usdcPriceFeed'),
    isSupported: getConfigValue<boolean>(assetRegistryConfig, 'usdcSupported'),
    maxStalePeriod: getConfigValue<number>(assetRegistryConfig, 'usdcMaxStalePeriod'),
  });
  console.log('✅ USDC asset configured in registry');

  // ============================================
  // 4. Deploy PriceOracle
  // ============================================
  console.log('\n4️⃣ Deploying PriceOracle...');
  const PriceOracle = await ethers.getContractFactory('PriceOracle');

  // PriceOracle parameters
  const oracleDecimals = getConfigValue<number>(priceOracleConfig, 'decimals');
  const relativeMaxDeviation = getConfigValue<number>(priceOracleConfig, 'relativeMaxDeviation');
  const absoluteMaxDeviation = getConfigValue<number>(priceOracleConfig, 'absoluteMaxDeviation');
  const initPrice = ethers.parseUnits(
    getConfigValue<string>(priceOracleConfig, 'initPrice'),
    oracleDecimals
  );
  const referencePrice = ethers.parseUnits(
    getConfigValue<string>(priceOracleConfig, 'referencePrice'),
    oracleDecimals
  );
  const operatorConfig = getConfigValue<string>(priceOracleConfig, 'operator');
  const operator = operatorConfig === ethers.ZeroAddress ? deployer : operatorConfig;

  const latestBlock = await ethers.provider.getBlock('latest');
  const initPriceTimestamp = latestBlock!.timestamp;

  const priceOracle = await upgrades.deployProxy(
    PriceOracle,
    [
      relativeMaxDeviation,
      absoluteMaxDeviation,
      initPrice,
      referencePrice,
      admin,
      initPriceTimestamp,
    ],
    {
      initializer: 'initialize',
      kind: 'uups',
      constructorArgs: [oracleDecimals],
      unsafeAllow: ['state-variable-immutable'],
    }
  );
  await priceOracle.waitForDeployment();
  const priceOracleAddress = await priceOracle.getAddress();
  console.log('✅ PriceOracle deployed to:', priceOracleAddress);
  if (admin === deployer) {
    console.log('📌 Granting OPERATOR_ROLE to PriceOracle operator...');
    const OPERATOR_ROLE = await priceOracle.OPERATOR_ROLE();
    const hasOperatorRole = await priceOracle.hasRole(OPERATOR_ROLE, operator);
    if (!hasOperatorRole) {
      const grantOperatorTx = await priceOracle.grantRole(OPERATOR_ROLE, operator);
      await grantOperatorTx.wait();
      console.log('✅ OPERATOR_ROLE granted to:', operator);
    } else {
      console.log('📌 Operator already has OPERATOR_ROLE:', operator);
    }
  } else {
    console.log(
      '⚠️  Common.admin is not the deployer. The PriceOracle admin must grant OPERATOR_ROLE manually.'
    );
  }
  console.log('📌 Initial Price:', ethers.formatUnits(initPrice, oracleDecimals));
  console.log(
    '📌 Relative Max Deviation:',
    relativeMaxDeviation,
    'bps (',
    relativeMaxDeviation / 100,
    '%)'
  );
  console.log(
    '📌 Absolute Max Deviation:',
    absoluteMaxDeviation,
    'bps (',
    absoluteMaxDeviation / 100,
    '%)'
  );

  // ============================================
  // 5. Deploy Express
  // ============================================
  console.log('\n5️⃣ Deploying Express...');
  const Express = await ethers.getContractFactory('Express');
  const express = await upgrades.deployProxy(
    Express,
    [
      hybondTokenAddress,
      usdcAddressFinal,
      treasury,
      txFeeTo,
      mgtFeeTo,
      admin,
      assetRegistryAddress,
      priceOracleAddress, // priceOracle
      maxStalePeriod,
      {
        depositMinimum,
        redeemMinimum,
        firstDepositAmount,
      },
      kycManagerAddress,
    ],
    {
      initializer: 'initialize',
      kind: 'uups',
    }
  );
  await express.waitForDeployment();
  const expressAddress = await express.getAddress();
  console.log('✅ Express deployed to:', expressAddress);

  if (admin === deployer) {
    console.log('📌 Granting MINTER_ROLE to Express...');
    const MINTER_ROLE = await hybond.MINTER_ROLE();
    const grantMinterTx = await hybond.grantRole(MINTER_ROLE, expressAddress);
    await grantMinterTx.wait();
    console.log('✅ MINTER_ROLE granted to Express');

    console.log('📌 Granting BURNER_ROLE to Express...');
    const BURNER_ROLE = await hybond.BURNER_ROLE();
    const grantBurnerTx = await hybond.grantRole(BURNER_ROLE, expressAddress);
    await grantBurnerTx.wait();
    console.log('✅ BURNER_ROLE granted to Express');

    if (tokenPermissioned) {
      console.log('📌 Granting WHITELIST_ROLE on KycManager to deployer (for initial KYC ops)...');
      const WHITELIST_ROLE = await kycManager.WHITELIST_ROLE();
      const grantWhitelistTx = await kycManager.grantRole(WHITELIST_ROLE, deployer);
      await grantWhitelistTx.wait();
      console.log('✅ WHITELIST_ROLE granted to deployer on KycManager');

      console.log('📌 KYC-listing the Express contract address (required for token flows)...');
      const kycExpressTx = await kycManager.grantKyc(expressAddress);
      await kycExpressTx.wait();
      console.log('✅ Express contract KYC-listed on KycManager');
    }
  } else {
    console.log(
      '⚠️  Common.admin is not the deployer. The HYBOND admin must grant MINTER_ROLE and BURNER_ROLE to Express manually.'
    );
    if (tokenPermissioned) {
      console.log(
        '⚠️  In permissioned-Token mode: admin MUST grant WHITELIST_ROLE on KycManager + call kycManager.grantKyc(express) before any token flow.'
      );
    }
  }

  // ============================================
  // Save Deployment Info
  // ============================================
  if (usdc) {
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    await deployerDeployments.save('MockERC20', {
      address: usdcAddressFinal,
      abi: MockERC20Factory.interface.format() as any,
    });
  }

  await deployerDeployments.save('KycManager', {
    address: kycManagerAddress,
    abi: KycManagerFactory.interface.format() as any,
  });

  await deployerDeployments.save('HYBOND', {
    address: hybondTokenAddress,
    abi: Token.interface.format() as any,
  });

  await deployerDeployments.save('AssetRegistry', {
    address: assetRegistryAddress,
    abi: AssetRegistry.interface.format() as any,
  });

  await deployerDeployments.save('PriceOracle', {
    address: priceOracleAddress,
    abi: PriceOracle.interface.format() as any,
  });

  await deployerDeployments.save('Express', {
    address: expressAddress,
    abi: Express.interface.format() as any,
  });

  // ============================================
  // Summary
  // ============================================
  console.log('\n📋 Deployment Summary:');
  if (usdc) {
    console.log('MockERC20 (USDC):', usdcAddressFinal);
  } else {
    console.log('USDC Token:', usdcAddressFinal);
  }
  console.log('KycManager:', kycManagerAddress);
  console.log('HYBOND Token:', hybondTokenAddress);
  console.log('AssetRegistry:', assetRegistryAddress);
  console.log('PriceOracle:', priceOracleAddress);
  console.log('Express:', expressAddress);
  console.log('\n📌 Configuration:');
  console.log(
    '  HYBOND Issue Cap:',
    tokenIssueCap > 0 ? ethers.formatEther(tokenIssueCap) : 'Unlimited'
  );
  console.log('  Deposit Minimum:', ethers.formatEther(depositMinimum), 'HYBOND');
  console.log('  Redeem Minimum:', ethers.formatEther(redeemMinimum), 'HYBOND');
  console.log('  First Deposit Amount:', ethers.formatEther(firstDepositAmount), 'HYBOND');
  console.log('  Max Stale Period:', maxStalePeriod, 'seconds');
  console.log('  Treasury:', treasury);
  console.log('  Transaction Fee To:', txFeeTo);
  console.log('  Management Fee To:', mgtFeeTo);
  console.log('  Admin:', admin);

  // ============================================
  // Verify Contracts on Etherscan
  // ============================================
  if (network.name !== 'hardhat' && network.name !== 'localhost') {
    console.log('\n⏳ Waiting for Etherscan to index the contracts...');
    await new Promise((resolve) => setTimeout(resolve, 30000)); // 30 seconds

    // Get implementation addresses
    const kycManagerImpl = await upgrades.erc1967.getImplementationAddress(kycManagerAddress);
    const hybondImpl = await upgrades.erc1967.getImplementationAddress(hybondTokenAddress);
    const assetRegistryImpl = await upgrades.erc1967.getImplementationAddress(assetRegistryAddress);
    const priceOracleImpl = await upgrades.erc1967.getImplementationAddress(priceOracleAddress);
    const expressImpl = await upgrades.erc1967.getImplementationAddress(expressAddress);

    console.log('\n🔍 Implementation addresses:');
    console.log('KycManager:', kycManagerImpl);
    console.log('HYBOND:', hybondImpl);
    console.log('AssetRegistry:', assetRegistryImpl);
    console.log('PriceOracle:', priceOracleImpl);
    console.log('Express:', expressImpl);

    // Verify implementation contracts
    console.log('\n🔍 Verifying implementations on Etherscan...');

    const verifyContract = async (name: string, address: string, constructorArgs: any[] = []) => {
      try {
        await run('verify:verify', {
          address,
          constructorArguments: constructorArgs,
        });
        console.log(`✅ ${name} implementation verified`);
      } catch (error: any) {
        console.log(`❌ ${name} implementation verification failed:`, error.message);
      }
    };

    if (usdc) {
      await verifyContract('MockERC20', usdcAddressFinal, ['USD Coin', 'USDC', 6]);
    }

    await verifyContract('KycManager', kycManagerImpl);
    await verifyContract('HYBOND', hybondImpl);
    await verifyContract('AssetRegistry', assetRegistryImpl);
    await verifyContract('PriceOracle', priceOracleImpl, [oracleDecimals]);
    await verifyContract('Express', expressImpl);
  } else {
    console.log('\n🛑 Skipping verification on local network.');
  }
};

func.tags = ['hybond_all', 'hybond', 'core'];
func.dependencies = [];
export default func;
