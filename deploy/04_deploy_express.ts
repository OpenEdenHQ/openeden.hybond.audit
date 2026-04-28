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
  const expressConfig = getConfigSection(config, 'Express');

  console.log('🚀 Deploying Express');
  console.log('📌 Deployer address:', deployer);

  // Check if already deployed
  try {
    const existing = await get('Express');
    console.log('📌 Express already deployed at:', existing.address);
    console.log('⏭️  Skipping deployment. Use --reset to redeploy.');
    return;
  } catch (error) {
    // Not deployed yet, proceed
  }

  // Check dependencies
  // let hybondTokenAddress: string;
  // let assetRegistryAddress: string;
  // let usdcAddress: string;

  const usdcAddress = getConfigValue<string>(expressConfig, 'usdcAddress');
  const hybondTokenAddress = getConfigValue<string>(expressConfig, 'hybondTokenAddress');
  const assetRegistryAddress = getConfigValue<string>(expressConfig, 'assetRegistryAddress');

  let kycManagerAddress: string;
  try {
    const km = await get('KycManager');
    kycManagerAddress = km.address;
  } catch {
    throw new Error('KycManager not deployed. Run 02a_deploy_kyc_manager.ts first.');
  }

  /*
  try {
    const hybondDeployment = await get('HYBOND');
    hybondTokenAddress = hybondDeployment.address;
    console.log('✅ Found HYBOND at:', hybondTokenAddress);
  } catch (error) {
    throw new Error('HYBOND not found. Please deploy HYBOND first using 02_deploy_hybond_token.ts');
  }

  try {
    const assetRegistryDeployment = await get('AssetRegistry');
    assetRegistryAddress = assetRegistryDeployment.address;
    console.log('✅ Found AssetRegistry at:', assetRegistryAddress);
  } catch (error) {
    throw new Error(
      'AssetRegistry not found. Please deploy AssetRegistry first using 03_deploy_asset_registry.ts'
    );
  }
    */

  // Configuration
  const adminConfig = getConfigValue<string>(commonConfig, 'admin');
  const admin = adminConfig === ethers.ZeroAddress ? deployer : adminConfig;
  const treasuryConfig = getConfigValue<string>(expressConfig, 'treasury');
  const treasury = treasuryConfig === ethers.ZeroAddress ? deployer : treasuryConfig;
  const txFeeToConfig = getConfigValue<string>(expressConfig, 'txFeeTo');
  const txFeeTo = txFeeToConfig === ethers.ZeroAddress ? deployer : txFeeToConfig;
  const mgtFeeToConfig = getConfigValue<string>(expressConfig, 'mgtFeeTo');
  const mgtFeeTo = mgtFeeToConfig === ethers.ZeroAddress ? deployer : mgtFeeToConfig;
  // CONFIRM_ROLE removed in sharesPerToken invariance redesign — no confirmer needed
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
  const priceOracle = getConfigValue<string>(expressConfig, 'priceOracle');
  const maxStalePeriod = getConfigValue<number>(expressConfig, 'maxStalePeriod');

  // Deploy Express
  console.log('\n1️⃣ Deploying Express...');
  const Express = await ethers.getContractFactory('Express');
  const express = await upgrades.deployProxy(
    Express,
    [
      hybondTokenAddress,
      usdcAddress,
      treasury,
      txFeeTo,
      mgtFeeTo,
      admin,
      assetRegistryAddress,
      priceOracle,
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

  const Token = await ethers.getContractFactory('Token');
  const hybond = Token.attach(hybondTokenAddress);

  if (admin === deployer) {
    console.log('\n2️⃣ Granting MINTER_ROLE to Express...');
    const MINTER_ROLE = await hybond.MINTER_ROLE();
    const grantMinterTx = await hybond.grantRole(MINTER_ROLE, expressAddress);
    await grantMinterTx.wait();
    console.log('✅ MINTER_ROLE granted to Express');

    console.log('\n3️⃣ Granting BURNER_ROLE to Express...');
    const BURNER_ROLE = await hybond.BURNER_ROLE();
    const grantBurnerTx = await hybond.grantRole(BURNER_ROLE, expressAddress);
    await grantBurnerTx.wait();
    console.log('✅ BURNER_ROLE granted to Express');

    console.log('\n4️⃣ Granting MAINTAINER_ROLE to deployer for initial configuration...');
    const MAINTAINER_ROLE = await express.MAINTAINER_ROLE();
    const grantMaintainerTx = await express.grantRole(MAINTAINER_ROLE, deployer);
    await grantMaintainerTx.wait();
    console.log('✅ MAINTAINER_ROLE granted to deployer');

    // Default timing parameters. Overridable later via MAINTAINER_ROLE.
    const DEFAULT_CONVERT_REDEEM_DELAY = 2 * 24 * 60 * 60; // 2 days (T+2)
    const DEFAULT_TIME_BUFFER = 72000; // 20 hours

    console.log(
      `\n5️⃣ Setting convertRedeemRequestsDelay = ${DEFAULT_CONVERT_REDEEM_DELAY}s (T+2)...`
    );
    const setDelayTx = await express.updateConvertRedeemRequestsDelay(DEFAULT_CONVERT_REDEEM_DELAY);
    await setDelayTx.wait();
    console.log('✅ convertRedeemRequestsDelay set');

    console.log(`\n6️⃣ Setting timeBuffer = ${DEFAULT_TIME_BUFFER}s (20 hours)...`);
    const setTimeBufferTx = await express.updateTimeBuffer(DEFAULT_TIME_BUFFER);
    await setTimeBufferTx.wait();
    console.log('✅ timeBuffer set');
  } else {
    console.log('\n2️⃣ Skipping HYBOND role grants');
    console.log(
      '⚠️  Common.admin is not the deployer. The HYBOND admin must grant MINTER_ROLE and BURNER_ROLE to Express manually.'
    );
    console.log(
      '⚠️  ACTION REQUIRED post-deploy: grant MAINTAINER_ROLE, then call updateConvertRedeemRequestsDelay(172800) and updateTimeBuffer(72000). Without these, the T+N gate is bypassed and epoch rate-limit is absent.'
    );
  }

  // Save deployment info
  await deployerDeployments.save('Express', {
    address: expressAddress,
    abi: Express.interface.format() as any,
  });

  // Summary
  console.log('\n📋 Deployment Summary:');
  console.log('Express:', expressAddress);
  console.log('HYBOND Token:', hybondTokenAddress);
  console.log('USDC Token:', usdcAddress);
  console.log('AssetRegistry:', assetRegistryAddress);
  console.log('Treasury:', treasury);
  console.log('Transaction Fee To:', txFeeTo);
  console.log('Management Fee To:', mgtFeeTo);
  // Confirmer role removed — offchainShares now maintained automatically
  console.log('Deposit Minimum:', ethers.formatEther(depositMinimum), 'HYBOND');
  console.log('Redeem Minimum:', ethers.formatEther(redeemMinimum), 'HYBOND');
  console.log('First Deposit Amount:', ethers.formatEther(firstDepositAmount), 'HYBOND');
  console.log('Price Oracle:', priceOracle);
  console.log('Max Stale Period:', maxStalePeriod, 'seconds');
  console.log('Admin:', admin);

  // Verify on Etherscan
  if (network.name !== 'hardhat' && network.name !== 'localhost') {
    console.log('\n⏳ Waiting for Etherscan to index the contract...');
    await new Promise((resolve) => setTimeout(resolve, 30000)); // 30 seconds

    const expressImpl = await upgrades.erc1967.getImplementationAddress(expressAddress);
    console.log('\n🔍 Implementation address:', expressImpl);

    console.log('\n🔍 Verifying implementation on Etherscan...');
    try {
      await run('verify:verify', {
        address: expressImpl,
        constructorArguments: [],
      });
      console.log('✅ Express implementation verified');
    } catch (error: any) {
      console.log('❌ Express implementation verification failed:', error.message);
    }
  } else {
    console.log('\n🛑 Skipping verification on local network.');
  }

  console.log('\n✅ Deployment completed successfully!');
  console.log('\n🎉 HYBOND system contracts deployed!');
  console.log('\n💡 Next steps:');
  console.log('   - Configure AssetRegistry with asset configurations');
  console.log(
    '   - Grant WHITELIST_ROLE on KycManager to operational signer, then call kycManager.grantKycBulk([...])'
  );
  console.log(
    '   - In permissioned-Token deployments, the Express contract address itself MUST be KYC-listed'
  );
  console.log(
    "     (tokens transit through Express on cancel-refund and mgtFeeTo flows; un-KYC'd Express bricks those paths)"
  );
  console.log('   - Set deposit and redeem fee rates if needed');
};

func.tags = ['express', 'hybond', 'extension'];
export default func;
