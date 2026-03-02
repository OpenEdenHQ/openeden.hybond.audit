import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const hreAny = hre as any;
  const { deployments: deployerDeployments, getNamedAccounts, network } = hreAny;
  const ethers = hreAny.ethers;
  const run = hreAny.run;
  const { deployer } = await getNamedAccounts();

  console.log('🚀 Deploying MockERC20 (USDO)');
  console.log('📌 Deployer address:', deployer);

  // Check if already deployed
  let mockERC20Address: string;
  try {
    const existing = await deployerDeployments.get('MockERC20');
    console.log('📌 MockERC20 already deployed at:', existing.address);
    console.log('⏭️  Skipping deployment. Use --reset to redeploy.');
    return;
  } catch (error) {
    // Not deployed yet, proceed
  }

  // Configuration
  const name = 'USDO Token';
  const symbol = 'USDO';
  const decimals = 18;

  // Deploy MockERC20
  console.log('\n1️⃣ Deploying MockERC20...');
  const MockERC20 = await ethers.getContractFactory('MockERC20');
  const mockERC20 = await MockERC20.deploy(name, symbol, decimals);
  await mockERC20.waitForDeployment();
  mockERC20Address = await mockERC20.getAddress();
  console.log('✅ MockERC20 deployed to:', mockERC20Address);

  // Save deployment info
  await deployerDeployments.save('MockERC20', {
    address: mockERC20Address,
    abi: MockERC20.interface.format() as any,
  });

  // Summary
  console.log('\n📋 Deployment Summary:');
  console.log('MockERC20:', mockERC20Address);
  console.log('Name:', name);
  console.log('Symbol:', symbol);
  console.log('Decimals:', decimals);

  // Verify on Etherscan
  if (network.name !== 'hardhat' && network.name !== 'localhost') {
    console.log('\n⏳ Waiting for Etherscan to index the contract...');
    await new Promise((resolve) => setTimeout(resolve, 30000)); // 30 seconds

    console.log('\n🔍 Verifying contract on Etherscan...');
    try {
      await run('verify:verify', {
        address: mockERC20Address,
        constructorArguments: [name, symbol, decimals],
      });
      console.log('✅ MockERC20 verified');
    } catch (error: any) {
      console.log('❌ MockERC20 verification failed:', error.message);
    }
  } else {
    console.log('\n🛑 Skipping verification on local network.');
  }

  console.log('\n✅ Deployment completed successfully!');
};

func.tags = ['mock_erc20', 'oem'];
export default func;
