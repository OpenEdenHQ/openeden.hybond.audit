import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-chai-matchers';
import '@openzeppelin/hardhat-upgrades';
import 'hardhat-deploy';
import 'hardhat-deploy-ethers';
import 'hardhat-gas-reporter';
import 'solidity-coverage';
import '@typechain/hardhat';
import 'hardhat-storage-layout';
import 'hardhat-contract-sizer';
import * as dotenv from 'dotenv';

const LOCAL_COMMANDS = ['test', 'compile', 'coverage', 'clean', 'typechain', 'size-contracts'];
if (!LOCAL_COMMANDS.some((cmd) => process.argv.includes(cmd))) dotenv.config();

const {
  NODE_ENV,
  REPORT_GAS,
  ETHERSCAN_KEY,
  ARBSCAN_KEY,
  BASESCAN_KEY,
  BSCSCAN_KEY,
  KAIASCAN_KEY,
  PRIVATE_KEY,

  ALCHEMY_KEY,
  QUICK_NODE_RPC,
} = process.env;

const isTestEnv = NODE_ENV === 'test';
const gasReport = REPORT_GAS === 'true';

const testConfig: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
      allowBlocksWithSameTimestamp: true,
    },
  },
};

const config: HardhatUserConfig = {
  typechain: {
    outDir: 'typechain-types',
    target: 'ethers-v6',
  },
  solidity: {
    version: '0.8.22',
    settings: {
      optimizer: {
        enabled: true,
        runs: 100,
      },
      viaIR: true,
      // evmVersion: 'paris',
    },
  },
  sourcify: {
    enabled: false,
  },
  etherscan: {
    // Etherscan V2 API - single unified API key for Etherscan
    apiKey: ETHERSCAN_KEY || '',
    customChains: [
      {
        network: 'arbi_sepolia',
        chainId: 421614,
        urls: {
          apiURL: 'https://api-sepolia.arbiscan.io/api',
          browserURL: 'https://sepolia.arbiscan.io',
        },
      },
      {
        network: 'base_sepolia',
        chainId: 84532,
        urls: {
          apiURL: 'https://api-sepolia.basescan.org/api',
          browserURL: 'https://sepolia.basescan.org',
        },
      },
      {
        network: 'bsc_testnet',
        chainId: 97,
        urls: {
          apiURL: 'https://api-testnet.bscscan.com/api',
          browserURL: 'https://testnet.bscscan.com/',
        },
      },
      {
        network: 'base_mainnet',
        chainId: 8453,
        urls: {
          apiURL: 'https://api.basescan.org/api',
          browserURL: 'https://basescan.org',
        },
      },
      {
        network: 'bsc_mainnet',
        chainId: 56,
        urls: {
          apiURL: 'https://api.bscscan.com/api',
          browserURL: 'https://bscscan.com/',
        },
      },
      {
        network: 'kairos',
        chainId: 1001,
        urls: {
          apiURL: 'https://kairos-api.kaiascan.io/hardhat-verify',
          browserURL: 'https://kairos.kaiascan.io',
        },
      },
    ],
  },
  defaultNetwork: 'hardhat',
  networks: {
    sepolia: {
      url: `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      chainId: 11155111,
      // Only add account if the PK is provided
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    base_sepolia: {
      url: `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      gasPrice: 1000000000,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    arbi_sepolia: {
      url: `https://arb-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      chainId: 421614,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    bsc_testnet: {
      url: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
      chainId: 97,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    mainnet: {
      url: QUICK_NODE_RPC || `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` || '',
      chainId: 1,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    base_mainnet: {
      url: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      gasPrice: 1000000000,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    arb_mainnet: {
      url: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      chainId: 42161,
      // Only add account if the PK is provided
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    bsc_mainnet: {
      url: `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      chainId: 56,
      // Only add account if the PK is provided
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    kairos: {
      url: 'https://public-en-kairos.node.kaia.io',
      chainId: 1001,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    hardhat: {
      chainId: 31337,
      allowBlocksWithSameTimestamp: true,
    },
  },
  mocha: {
    timeout: 120000,
  },
  namedAccounts: {
    deployer: {
      default: 0, // Use the first account as deployer by default
    },
  },
};

export default isTestEnv
  ? {
      ...config,
      ...testConfig,
    }
  : config;
