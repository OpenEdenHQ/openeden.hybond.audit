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
  const priceOracleConfig = getConfigSection(config, 'PriceOracle');

  console.log('🚀 Deploying PriceOracle');
  console.log('📌 Deployer address:', deployer);

  // Check if already deployed
  try {
    const existing = await get('PriceOracle');
    console.log('📌 PriceOracle already deployed at:', existing.address);
    console.log('⏭️  Skipping deployment. Use --reset to redeploy.');
    return;
  } catch (error) {
    // Not deployed yet, proceed
  }

  // Configuration
  const decimals = getConfigValue<number>(priceOracleConfig, 'decimals');
  const relativeMaxDeviation = getConfigValue<number>(priceOracleConfig, 'relativeMaxDeviation');
  const absoluteMaxDeviation = getConfigValue<number>(priceOracleConfig, 'absoluteMaxDeviation');
  const initPrice = ethers.parseUnits(
    getConfigValue<string>(priceOracleConfig, 'initPrice'),
    decimals
  );
  const referencePrice = ethers.parseUnits(
    getConfigValue<string>(priceOracleConfig, 'referencePrice'),
    decimals
  );
  const operatorConfig = getConfigValue<string>(priceOracleConfig, 'operator');
  const operator = operatorConfig === ethers.ZeroAddress ? deployer : operatorConfig;
  const confirmerConfig = getConfigValue<string>(priceOracleConfig, 'confirmer');
  const confirmer = confirmerConfig === ethers.ZeroAddress ? deployer : confirmerConfig;
  const adminConfig = getConfigValue<string>(commonConfig, 'admin');
  const admin = adminConfig === ethers.ZeroAddress ? deployer : adminConfig;

  // Deploy PriceOracle (decimals is an immutable set via constructor)
  console.log('\n1️⃣ Deploying PriceOracle...');
  const PriceOracle = await ethers.getContractFactory('PriceOracle', {
    constructorArgs: [decimals],
  });
  const latestBlock = await ethers.provider.getBlock('latest');
  const initPriceTimestamp = latestBlock!.timestamp - 1;

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
      constructorArgs: [decimals],
      unsafeAllow: ['state-variable-immutable'],
    }
  );
  await priceOracle.waitForDeployment();
  const priceOracleAddress = await priceOracle.getAddress();
  console.log('✅ PriceOracle deployed to:', priceOracleAddress);

  if (admin === deployer) {
    console.log('\n2️⃣ Granting OPERATOR_ROLE...');
    const OPERATOR_ROLE = await priceOracle.OPERATOR_ROLE();
    const hasOperatorRole = await priceOracle.hasRole(OPERATOR_ROLE, operator);
    if (!hasOperatorRole) {
      const grantOperatorTx = await priceOracle.grantRole(OPERATOR_ROLE, operator);
      await grantOperatorTx.wait();
      console.log('✅ OPERATOR_ROLE granted to:', operator);
    } else {
      console.log('📌 Operator already has OPERATOR_ROLE:', operator);
    }

    console.log('\n3️⃣ Granting CONFIRMER_ROLE...');
    const CONFIRMER_ROLE = await priceOracle.CONFIRMER_ROLE();
    const hasConfirmerRole = await priceOracle.hasRole(CONFIRMER_ROLE, confirmer);
    if (!hasConfirmerRole) {
      const grantConfirmerTx = await priceOracle.grantRole(CONFIRMER_ROLE, confirmer);
      await grantConfirmerTx.wait();
      console.log('✅ CONFIRMER_ROLE granted to:', confirmer);
    } else {
      console.log('📌 Confirmer already has CONFIRMER_ROLE:', confirmer);
    }
  } else {
    console.log('\n2️⃣ Skipping OPERATOR_ROLE / CONFIRMER_ROLE grants');
    console.log(
      '⚠️  Common.admin is not the deployer. The admin must grant OPERATOR_ROLE manually to:',
      operator
    );
    console.log(
      '⚠️  The admin must grant CONFIRMER_ROLE manually to:',
      confirmer
    );
  }

  // Save deployment info
  await deployerDeployments.save('PriceOracle', {
    address: priceOracleAddress,
    abi: PriceOracle.interface.format() as any,
  });

  // Summary
  console.log('\n📋 Deployment Summary:');
  console.log('PriceOracle:', priceOracleAddress);
  console.log('Decimals:', decimals);
  console.log(
    'Relative Max Deviation:',
    relativeMaxDeviation,
    'bps (',
    relativeMaxDeviation / 100,
    '%)'
  );
  console.log(
    'Absolute Max Deviation:',
    absoluteMaxDeviation,
    'bps (',
    absoluteMaxDeviation / 100,
    '%)'
  );
  console.log('Initial Price:', ethers.formatUnits(initPrice, decimals));
  console.log('Reference Price:', ethers.formatUnits(referencePrice, decimals));
  console.log('Operator:', operator);
  console.log('Confirmer:', confirmer);
  console.log('Admin:', admin);

  // Verify on Etherscan
  if (network.name !== 'hardhat' && network.name !== 'localhost') {
    console.log('\n⏳ Waiting for Etherscan to index the contract...');
    await new Promise((resolve) => setTimeout(resolve, 30000)); // 30 seconds

    const priceOracleImpl = await upgrades.erc1967.getImplementationAddress(priceOracleAddress);
    console.log('\n🔍 Implementation address:', priceOracleImpl);

    console.log('\n🔍 Verifying implementation on Etherscan...');
    try {
      await run('verify:verify', {
        address: priceOracleImpl,
        constructorArguments: [decimals],
      });
      console.log('✅ PriceOracle implementation verified');
    } catch (error: any) {
      console.log('❌ PriceOracle implementation verification failed:', error.message);
    }
  } else {
    console.log('\n🛑 Skipping verification on local network.');
  }

  console.log('\n✅ Deployment completed successfully!');
  console.log('\n💡 Next steps:');
  console.log('   - Update Express contract to use this PriceOracle via updatePriceOracle()');
  console.log('   - Set maxStalePeriod in Express if needed via updateMaxStalePeriod()');
  console.log('   - Grant UPGRADE_ROLE if needed');
  console.log(
    '   - Operator can stage prices via proposePrice(), then confirmer can call confirmPrice()'
  );
};

func.tags = ['price_oracle', 'oracle'];
export default func;
