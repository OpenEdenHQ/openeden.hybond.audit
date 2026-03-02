import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deploy new Express implementation (without upgrading proxy)
 *
 * This script deploys a new implementation contract that can be used
 * for manual upgrade later using the upgrade helper script.
 *
 * Usage:
 *   npx hardhat deploy --network <network> --tags upgrade_express_impl
 *
 * After deployment, use scripts/upgrade-proxy.ts to upgrade the proxy
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, get } = deployments;
  const { deployer } = await getNamedAccounts();

  console.log("\n=== Deploying New Express Implementation ===");
  console.log("Deployer:", deployer);

  // Get existing proxy address
  let proxyAddress: string;
  try {
    const existingDeployment = await get("Express");
    proxyAddress = existingDeployment.address;
    console.log("Existing Proxy Address:", proxyAddress);
  } catch (error) {
    console.log("Warning: No existing Express proxy found");
    proxyAddress = "Not deployed yet";
  }

  // Deploy new implementation
  const implementation = await deploy("Express_Implementation", {
    contract: "Express",
    from: deployer,
    args: [],
    log: true,
    skipIfAlreadyDeployed: false, // Always deploy new implementation
  });

  console.log("\n=== Deployment Summary ===");
  console.log("New Implementation Address:", implementation.address);
  console.log("Proxy Address:", proxyAddress);

  if (implementation.newlyDeployed) {
    console.log("\n✅ New implementation deployed successfully!");
    console.log("\n⚠️  NEXT STEPS:");
    console.log("1. Verify the implementation contract:");
    console.log(`   npx hardhat verify --network ${hre.network.name} ${implementation.address}`);
    console.log("\n2. Test the implementation thoroughly on testnet");
    console.log("\n3. Upgrade the proxy using the upgrade script:");
    console.log(`   npx hardhat run scripts/upgrade-proxy.ts --network ${hre.network.name}`);
    console.log("   or use the manual upgrade process with multisig");
  } else {
    console.log("\n⚠️  Implementation already exists at this address");
  }

  return true;
};

export default func;
func.id = "upgrade_express_impl"; // Unique identifier for this deployment
func.tags = ["upgrade_express_impl", "upgrade"];
func.dependencies = []; // No dependencies - can deploy standalone
