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

  console.log('🚀 Deploying KycManager');
  console.log('📌 Deployer address:', deployer);

  try {
    const existing = await get('KycManager');
    console.log('📌 KycManager already deployed at:', existing.address);
    console.log('⏭️  Skipping deployment. Use --reset to redeploy.');
    return;
  } catch {
    // not yet deployed — proceed
  }

  const adminConfig = getConfigValue<string>(commonConfig, 'admin');
  const admin = adminConfig === ethers.ZeroAddress ? deployer : adminConfig;

  console.log('\n1️⃣ Deploying KycManager...');
  const KycManagerFactory = await ethers.getContractFactory('KycManager');
  const kycManager = await upgrades.deployProxy(KycManagerFactory, [admin], {
    initializer: 'initialize',
    kind: 'uups',
  });
  await kycManager.waitForDeployment();
  const address = await kycManager.getAddress();
  console.log('✅ KycManager deployed to:', address);
  console.log('📌 Admin:', admin);

  await deployerDeployments.save('KycManager', {
    address,
    abi: KycManagerFactory.interface.format() as any,
  });

  if (network.name !== 'hardhat' && network.name !== 'localhost') {
    console.log('\n⏳ Waiting for Etherscan to index the contract...');
    await new Promise((r) => setTimeout(r, 30_000));

    const impl = await upgrades.erc1967.getImplementationAddress(address);
    console.log('\n🔍 Implementation address:', impl);

    console.log('\n🔍 Verifying implementation on Etherscan...');
    try {
      await run('verify:verify', { address: impl, constructorArguments: [] });
      console.log('✅ KycManager implementation verified');
    } catch (e: any) {
      console.log('❌ KycManager implementation verification failed:', e.message);
    }
  } else {
    console.log('\n🛑 Skipping verification on local network.');
  }

  console.log('\n✅ KycManager deployment completed successfully!');
};

func.tags = ['kyc_manager', 'hybond', 'core'];
export default func;
