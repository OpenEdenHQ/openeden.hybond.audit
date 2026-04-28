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

  console.log('🚀 Deploying HYBOND Token');
  console.log('📌 Deployer address:', deployer);

  // Check if already deployed
  try {
    const existing = await get('HYBOND');
    console.log('📌 HYBOND already deployed at:', existing.address);
    console.log('⏭️  Skipping deployment. Use --reset to redeploy.');
    return;
  } catch (error) {
    // Not deployed yet, proceed
  }

  // Configuration
  const name = getConfigValue<string>(hybondConfig, 'name');
  const symbol = getConfigValue<string>(hybondConfig, 'symbol');
  const issueCap = ethers.parseUnits(getConfigValue<string>(hybondConfig, 'issueCap'), 18);
  const adminConfig = getConfigValue<string>(commonConfig, 'admin');
  const admin = adminConfig === ethers.ZeroAddress ? deployer : adminConfig;

  // Resolve KycManager (permissioned mode only)
  const tokenPermissioned = getConfigValue<boolean>(commonConfig, 'tokenPermissioned');
  let kycManagerAddress: string = ethers.ZeroAddress;
  if (tokenPermissioned) {
    try {
      const km = await get('KycManager');
      kycManagerAddress = km.address;
    } catch {
      throw new Error(
        'tokenPermissioned=true but KycManager not deployed. Run 02a_deploy_kyc_manager.ts first.'
      );
    }
  }
  console.log(
    '📌 KycManager:',
    kycManagerAddress,
    tokenPermissioned ? '(permissioned)' : '(permissionless)'
  );

  // Deploy HYBOND
  console.log('\n1️⃣ Deploying HYBOND token...');
  const Token = await ethers.getContractFactory('Token');
  const hybond = await upgrades.deployProxy(
    Token,
    [name, symbol, admin, issueCap, kycManagerAddress],
    {
      initializer: 'initialize',
      kind: 'uups',
    }
  );
  await hybond.waitForDeployment();
  const hybondTokenAddress = await hybond.getAddress();
  console.log('✅ HYBOND Token deployed to:', hybondTokenAddress);
  console.log('📌 Issue Cap:', issueCap > 0 ? ethers.formatEther(issueCap) : 'Unlimited');

  // Save deployment info
  await deployerDeployments.save('HYBOND', {
    address: hybondTokenAddress,
    abi: Token.interface.format() as any,
  });

  // Summary
  console.log('\n📋 Deployment Summary:');
  console.log('HYBOND Token:', hybondTokenAddress);
  console.log('Name:', name);
  console.log('Symbol:', symbol);
  console.log('Issue Cap:', issueCap > 0 ? ethers.formatEther(issueCap) : 'Unlimited');
  console.log('Admin:', admin);

  // Verify on Etherscan
  if (network.name !== 'hardhat' && network.name !== 'localhost') {
    console.log('\n⏳ Waiting for Etherscan to index the contract...');
    await new Promise((resolve) => setTimeout(resolve, 30000)); // 30 seconds

    const hybondImpl = await upgrades.erc1967.getImplementationAddress(hybondTokenAddress);
    console.log('\n🔍 Implementation address:', hybondImpl);

    console.log('\n🔍 Verifying implementation on Etherscan...');
    try {
      await run('verify:verify', {
        address: hybondImpl,
        constructorArguments: [],
      });
      console.log('✅ HYBOND implementation verified');
    } catch (error: any) {
      console.log('❌ HYBOND implementation verification failed:', error.message);
    }
  } else {
    console.log('\n🛑 Skipping verification on local network.');
  }

  console.log('\n✅ Deployment completed successfully!');
};

func.tags = ['hybond', 'token', 'core'];
export default func;
