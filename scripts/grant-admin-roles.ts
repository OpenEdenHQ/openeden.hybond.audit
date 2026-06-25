/**
 * Grant administrative roles on the HYBOND contracts to a target address.
 *
 * Roles granted (only where the contract actually defines them):
 *   - DEFAULT_ADMIN_ROLE  (Token, Express, PriceOracle, KycManager)
 *   - PAUSE_ROLE          (Token, Express)
 *   - BANLIST_ROLE        (Token)
 *   - UPGRADE_ROLE        (Token, Express, PriceOracle)
 *   - MAINTAINER_ROLE     (Express)
 *   - MINTER_ROLE         (Token)
 *   - BURNER_ROLE         (Token)
 *
 * AssetRegistry is Ownable2Step (no roles): this script calls
 * transferOwnership(target). The target must later call acceptOwnership()
 * itself before it becomes owner.
 *
 * DRY-RUN BY DEFAULT. No transactions are broadcast unless EXECUTE=true.
 *
 * Usage:
 *   npx hardhat run scripts/grant-admin-roles.ts --network mainnet
 *   EXECUTE=true npx hardhat run scripts/grant-admin-roles.ts --network bsc_mainnet
 *   GRANTEE=0x... npx hardhat run scripts/grant-admin-roles.ts --network sepolia
 */
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { getConfigSection, getConfigValue, loadNetworkConfig } from '../deploy/config';

const hre = require('hardhat') as HardhatRuntimeEnvironment;
const hreAny = hre as any;
const ethers = hreAny.ethers;
const deployments = hreAny.deployments;
const network = hreAny.network;

const DEFAULT_GRANTEE = '0x72BB750Da96993b2bdA92e41521d4Bf7cE814873';
const EXECUTE = process.env.EXECUTE === 'true';

// Roles to grant per contract. A role is only attempted if the deployed
// contract exposes the matching `<NAME>_ROLE()` public constant getter.
const ROLE_PLAN: Record<string, string[]> = {
  Token: [
    'DEFAULT_ADMIN_ROLE',
    'PAUSE_ROLE',
    'BANLIST_ROLE',
    'UPGRADE_ROLE',
    'MINTER_ROLE',
    'BURNER_ROLE',
  ],
  Express: ['DEFAULT_ADMIN_ROLE', 'PAUSE_ROLE', 'UPGRADE_ROLE', 'MAINTAINER_ROLE'],
  PriceOracle: ['DEFAULT_ADMIN_ROLE', 'UPGRADE_ROLE'],
  KycManager: ['DEFAULT_ADMIN_ROLE'],
};

const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000';

interface ResolvedContract {
  name: string;
  address: string;
  source: string;
}

/**
 * Resolve a deployed contract address from the hardhat-deploy artifacts,
 * trying each candidate artifact name, then falling back to the config file.
 */
async function resolveAddress(
  artifactNames: string[],
  configFallback?: { section: string; key: string }
): Promise<{ address: string; source: string } | null> {
  for (const name of artifactNames) {
    try {
      const d = await deployments.get(name);
      return { address: d.address, source: `deployments/${network.name}/${name}.json` };
    } catch {
      // try next
    }
  }
  if (configFallback) {
    const config = loadNetworkConfig(network.name);
    const section = getConfigSection(config, configFallback.section);
    const addr = getConfigValue<string>(section, configFallback.key);
    if (addr && addr !== ethers.ZeroAddress) {
      return { address: addr, source: `config/${network.name}.json` };
    }
  }
  return null;
}

async function resolveContracts(): Promise<ResolvedContract[]> {
  const resolved: ResolvedContract[] = [];

  // Token: saved as "Token" (eth) or "HYBOND" (bnb); config key hybondTokenAddress.
  const token = await resolveAddress(
    ['Token', 'HYBOND'],
    { section: 'Express', key: 'hybondTokenAddress' }
  );
  if (token) resolved.push({ name: 'Token', address: token.address, source: token.source });

  const express = await resolveAddress(['Express']);
  if (express) resolved.push({ name: 'Express', address: express.address, source: express.source });

  const oracle = await resolveAddress(
    ['PriceOracle'],
    { section: 'Express', key: 'priceOracle' }
  );
  if (oracle) resolved.push({ name: 'PriceOracle', address: oracle.address, source: oracle.source });

  const kyc = await resolveAddress(['KycManager']);
  if (kyc) resolved.push({ name: 'KycManager', address: kyc.address, source: kyc.source });

  return resolved;
}

/** Read a `<NAME>_ROLE()` constant off the contract; null if the getter is absent. */
async function readRoleHash(contract: any, roleName: string): Promise<string | null> {
  if (roleName === 'DEFAULT_ADMIN_ROLE') return DEFAULT_ADMIN_ROLE;
  try {
    return await contract[roleName]();
  } catch {
    return null;
  }
}

async function main() {
  const grantee = ethers.getAddress(process.env.GRANTEE || DEFAULT_GRANTEE);
  const [signer] = await ethers.getSigners();

  console.log('═'.repeat(70));
  console.log(`HYBOND role grant  —  network: ${network.name}`);
  console.log(`Mode:    ${EXECUTE ? '⚡ EXECUTE (broadcasting txs)' : '🔍 DRY-RUN (no txs sent)'}`);
  console.log(`Signer:  ${signer.address}`);
  console.log(`Grantee: ${grantee}`);
  console.log('═'.repeat(70));

  // Generic AccessControl ABI fragment + the role-constant getters we may read.
  const acAbi = [
    'function hasRole(bytes32 role, address account) view returns (bool)',
    'function grantRole(bytes32 role, address account)',
    'function getRoleAdmin(bytes32 role) view returns (bytes32)',
    'function PAUSE_ROLE() view returns (bytes32)',
    'function BANLIST_ROLE() view returns (bytes32)',
    'function UPGRADE_ROLE() view returns (bytes32)',
    'function MAINTAINER_ROLE() view returns (bytes32)',
    'function MINTER_ROLE() view returns (bytes32)',
    'function BURNER_ROLE() view returns (bytes32)',
  ];

  const contracts = await resolveContracts();
  if (contracts.length === 0) {
    throw new Error(`No HYBOND contracts resolved for network ${network.name}.`);
  }

  let planned = 0;
  let skipped = 0;
  let sent = 0;

  for (const c of contracts) {
    console.log(`\n▸ ${c.name}  ${c.address}`);
    console.log(`  (${c.source})`);
    const contract = new ethers.Contract(c.address, acAbi, signer);

    for (const roleName of ROLE_PLAN[c.name]) {
      const roleHash = await readRoleHash(contract, roleName);
      if (roleHash === null) {
        console.log(`  · ${roleName}: not defined on this contract — skip`);
        continue;
      }

      const already = await contract.hasRole(roleHash, grantee);
      if (already) {
        console.log(`  ✓ ${roleName}: already held — skip`);
        skipped++;
        continue;
      }

      // Confirm the signer is allowed to grant this role.
      const adminRole = await contract.getRoleAdmin(roleHash);
      const signerCanGrant = await contract.hasRole(adminRole, signer.address);
      if (!signerCanGrant) {
        console.log(
          `  ⚠ ${roleName}: signer lacks admin (adminRole=${adminRole}) — CANNOT grant`
        );
        continue;
      }

      planned++;
      if (EXECUTE) {
        const tx = await contract.grantRole(roleHash, grantee);
        console.log(`  → ${roleName}: grantRole sent  tx=${tx.hash}`);
        await tx.wait();
        sent++;
      } else {
        console.log(`  → ${roleName}: WOULD grantRole(${roleHash.slice(0, 10)}…, grantee)`);
      }
    }
  }

  // AssetRegistry — Ownable2Step, transferOwnership (2-step).
  const registry = await resolveAddress(
    ['AssetRegistry'],
    { section: 'Express', key: 'assetRegistryAddress' }
  );
  if (registry) {
    console.log(`\n▸ AssetRegistry  ${registry.address}`);
    console.log(`  (${registry.source})`);
    const arAbi = [
      'function owner() view returns (address)',
      'function pendingOwner() view returns (address)',
      'function transferOwnership(address newOwner)',
    ];
    const ar = new ethers.Contract(registry.address, arAbi, signer);
    const owner = await ar.owner();
    const pending = await ar.pendingOwner();
    console.log(`  owner=${owner}  pendingOwner=${pending}`);

    if (ethers.getAddress(owner) === grantee) {
      console.log('  ✓ already owned by grantee — skip');
    } else if (ethers.getAddress(pending) === grantee) {
      console.log('  ✓ transfer already pending to grantee — awaiting acceptOwnership() — skip');
    } else if (ethers.getAddress(owner) !== ethers.getAddress(signer.address)) {
      console.log(`  ⚠ signer is not current owner (${owner}) — CANNOT transferOwnership`);
    } else {
      planned++;
      if (EXECUTE) {
        const tx = await ar.transferOwnership(grantee);
        console.log(`  → transferOwnership sent  tx=${tx.hash}`);
        await tx.wait();
        sent++;
        console.log('  ⚠ NOTE: grantee must call acceptOwnership() to complete the 2-step transfer.');
      } else {
        console.log('  → WOULD transferOwnership(grantee)  [2-step: grantee must acceptOwnership()]');
      }
    }
  } else {
    console.log('\n▸ AssetRegistry: not resolved on this network — skip');
  }

  console.log('\n' + '═'.repeat(70));
  console.log(`Planned actions: ${planned}   already-held/skipped: ${skipped}   broadcast: ${sent}`);
  if (!EXECUTE && planned > 0) {
    console.log('Dry-run only. Re-run with EXECUTE=true to broadcast.');
  }
  console.log('═'.repeat(70));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
