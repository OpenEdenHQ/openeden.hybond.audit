import { ethers, upgrades } from 'hardhat';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

export interface CoreDeployment {
  oem: any;
  admin: HardhatEthersSigner;
  minter: HardhatEthersSigner;
  burner: HardhatEthersSigner;
  pauser: HardhatEthersSigner;
  banlistManager: HardhatEthersSigner;
  maintainer: HardhatEthersSigner;
  user1: HardhatEthersSigner;
  user2: HardhatEthersSigner;
  user3: HardhatEthersSigner;
}

export async function deployCoreContracts(): Promise<CoreDeployment> {
  const [admin, minter, burner, pauser, banlistManager, maintainer, user1, user2, user3] =
    await ethers.getSigners();

  // Deploy OEM token
  const OEMFactory = await ethers.getContractFactory('Token');
  const oem = await upgrades.deployProxy(
    OEMFactory,
    ['OEM Multi Strategy Yield', 'OEM', admin.address, ethers.parseUnits('1000000', 18)],
    { kind: 'uups', initializer: 'initialize' }
  );
  await oem.waitForDeployment();

  // Grant roles
  const MINTER_ROLE = await oem.MINTER_ROLE();
  const BURNER_ROLE = await oem.BURNER_ROLE();
  const PAUSE_ROLE = await oem.PAUSE_ROLE();
  const BANLIST_ROLE = await oem.BANLIST_ROLE();
  const UPGRADE_ROLE = await oem.UPGRADE_ROLE();

  await oem.connect(admin).grantRole(MINTER_ROLE, minter.address);
  await oem.connect(admin).grantRole(BURNER_ROLE, burner.address);
  await oem.connect(admin).grantRole(PAUSE_ROLE, pauser.address);
  await oem.connect(admin).grantRole(BANLIST_ROLE, banlistManager.address);
  await oem.connect(admin).grantRole(UPGRADE_ROLE, admin.address);

  // Mint some OEM to users for testing
  const mintAmount = ethers.parseUnits('10000', 18);
  await oem.connect(minter).mint(user1.address, mintAmount);
  await oem.connect(minter).mint(user2.address, mintAmount);
  await oem.connect(minter).mint(user3.address, mintAmount);

  return {
    oem,
    admin,
    minter,
    burner,
    pauser,
    banlistManager,
    maintainer,
    user1,
    user2,
    user3,
  };
}
