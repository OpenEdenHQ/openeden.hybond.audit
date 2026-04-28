import { ethers, upgrades } from 'hardhat';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

export interface KycManagerDeployment {
  kycManager: any;
  admin: HardhatEthersSigner;
  whitelister: HardhatEthersSigner;
  user1: HardhatEthersSigner;
  user2: HardhatEthersSigner;
  user3: HardhatEthersSigner;
  outsider: HardhatEthersSigner;
}

export async function deployKycManager(): Promise<KycManagerDeployment> {
  const [admin, whitelister, user1, user2, user3, outsider] = await ethers.getSigners();

  const KycManagerFactory = await ethers.getContractFactory('KycManager');
  const kycManager = await upgrades.deployProxy(KycManagerFactory, [admin.address], {
    kind: 'uups',
    initializer: 'initialize',
  });
  await kycManager.waitForDeployment();

  const WHITELIST_ROLE = await kycManager.WHITELIST_ROLE();
  await kycManager.connect(admin).grantRole(WHITELIST_ROLE, whitelister.address);

  return { kycManager, admin, whitelister, user1, user2, user3, outsider };
}
