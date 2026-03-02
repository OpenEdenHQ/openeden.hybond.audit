import { readFileSync } from 'fs';
import { join } from 'path';

type ConfigLeaf = boolean | number | string;
type ConfigSection = Record<string, ConfigLeaf>;
type NetworkConfig = Record<string, ConfigSection>;

const LOCAL_CONFIG_FALLBACK = 'sepolia';

function resolveConfigName(networkName: string): string {
  if (networkName === 'hardhat' || networkName === 'localhost') {
    return LOCAL_CONFIG_FALLBACK;
  }

  return networkName;
}

export function loadNetworkConfig(networkName: string): NetworkConfig {
  const configName = resolveConfigName(networkName);
  const configPath = join(__dirname, '..', 'config', `${configName}.json`);

  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as NetworkConfig;
  } catch (error) {
    throw new Error(`Missing network config file: ${configPath}`);
  }
}

export function getConfigSection(config: NetworkConfig, section: string): ConfigSection {
  const value = config[section];
  if (value === undefined) {
    throw new Error(`Missing config section: ${section}`);
  }

  return value;
}

export function getConfigValue<T extends ConfigLeaf>(section: ConfigSection, key: string): T {
  const value = section[key];
  if (value === undefined) {
    throw new Error(`Missing config value: ${key}`);
  }

  return value as T;
}
