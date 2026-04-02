import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getConfigSection, getConfigValue, loadNetworkConfig } from "../config";

/**
 * Deploy new PriceOracle implementation (without upgrading proxy)
 *
 * This script deploys a new implementation contract that can be used
 * for manual upgrade later using the upgrade helper script.
 *
 * Usage:
 *   npx hardhat deploy --network <network> --tags upgrade_oracle_impl
 *
 * After deployment, use scripts/upgrade-proxy.ts to upgrade the proxy
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, get } = deployments;
  const { deployer } = await getNamedAccounts();
  const config = loadNetworkConfig(network.name);
  const priceOracleConfig = getConfigSection(config, "PriceOracle");
  const oracleDecimals = getConfigValue<number>(priceOracleConfig, "decimals");

  console.log("\n=== Deploying New PriceOracle Implementation ===");
  console.log("Deployer:", deployer);
  console.log("Decimals (immutable):", oracleDecimals);

  // Get existing proxy address
  let proxyAddress: string;
  try {
    const existingDeployment = await get("PriceOracle");
    proxyAddress = existingDeployment.address;
    console.log("Existing Proxy Address:", proxyAddress);
  } catch (error) {
    console.log("Warning: No existing PriceOracle proxy found");
    proxyAddress = "Not deployed yet";
  }

  // Deploy new implementation (decimals is immutable, set via constructor)
  const implementation = await deploy("PriceOracle_Implementation", {
    contract: "PriceOracle",
    from: deployer,
    args: [oracleDecimals],
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
    console.log(`   npx hardhat verify --network ${hre.network.name} ${implementation.address} ${oracleDecimals}`);
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
func.tags = ["upgrade_oracle_impl", "upgrade"];
func.dependencies = []; // No dependencies - can deploy standalone
