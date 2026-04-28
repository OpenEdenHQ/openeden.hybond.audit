import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { deployKycManager } from '../fixtures/kycManagerDeployments';

describe('KycManager', () => {
  describe('initialize', () => {
    it('grants DEFAULT_ADMIN_ROLE to admin', async () => {
      const { kycManager, admin } = await loadFixture(deployKycManager);
      const DEFAULT_ADMIN_ROLE = await kycManager.DEFAULT_ADMIN_ROLE();
      expect(await kycManager.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
    });

    it('rejects zero admin', async () => {
      const KycManagerFactory = await ethers.getContractFactory('KycManager');
      await expect(
        upgrades.deployProxy(KycManagerFactory, [ethers.ZeroAddress], {
          kind: 'uups',
          initializer: 'initialize',
        })
      ).to.be.revertedWithCustomError(KycManagerFactory, 'InvalidAddress');
    });

    it('cannot be re-initialized', async () => {
      const { kycManager, admin } = await loadFixture(deployKycManager);
      await expect(kycManager.initialize(admin.address)).to.be.revertedWithCustomError(
        kycManager,
        'InvalidInitialization'
      );
    });
  });

  describe('grantKyc / revokeKyc', () => {
    it('grants KYC and emits event', async () => {
      const { kycManager, whitelister, user1 } = await loadFixture(deployKycManager);
      await expect(kycManager.connect(whitelister).grantKyc(user1.address))
        .to.emit(kycManager, 'KycGranted')
        .withArgs(user1.address);
      expect(await kycManager.isKyced(user1.address)).to.equal(true);
    });

    it('reverts AlreadyKyced when granting twice', async () => {
      const { kycManager, whitelister, user1 } = await loadFixture(deployKycManager);
      await kycManager.connect(whitelister).grantKyc(user1.address);
      await expect(kycManager.connect(whitelister).grantKyc(user1.address))
        .to.be.revertedWithCustomError(kycManager, 'AlreadyKyced')
        .withArgs(user1.address);
    });

    it('revokes KYC and emits event', async () => {
      const { kycManager, whitelister, user1 } = await loadFixture(deployKycManager);
      await kycManager.connect(whitelister).grantKyc(user1.address);
      await expect(kycManager.connect(whitelister).revokeKyc(user1.address))
        .to.emit(kycManager, 'KycRevoked')
        .withArgs(user1.address);
      expect(await kycManager.isKyced(user1.address)).to.equal(false);
    });

    it('reverts NotKyced when revoking a non-KYC address', async () => {
      const { kycManager, whitelister, user1 } = await loadFixture(deployKycManager);
      await expect(kycManager.connect(whitelister).revokeKyc(user1.address))
        .to.be.revertedWithCustomError(kycManager, 'NotKyced')
        .withArgs(user1.address);
    });

    it('rejects zero address on grant', async () => {
      const { kycManager, whitelister } = await loadFixture(deployKycManager);
      await expect(
        kycManager.connect(whitelister).grantKyc(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(kycManager, 'InvalidAddress');
    });

    it('only WHITELIST_ROLE can grant', async () => {
      const { kycManager, outsider, user1 } = await loadFixture(deployKycManager);
      await expect(
        kycManager.connect(outsider).grantKyc(user1.address)
      ).to.be.revertedWithCustomError(kycManager, 'AccessControlUnauthorizedAccount');
    });

    it('only WHITELIST_ROLE can revoke', async () => {
      const { kycManager, whitelister, outsider, user1 } = await loadFixture(deployKycManager);
      await kycManager.connect(whitelister).grantKyc(user1.address);
      await expect(
        kycManager.connect(outsider).revokeKyc(user1.address)
      ).to.be.revertedWithCustomError(kycManager, 'AccessControlUnauthorizedAccount');
    });
  });

  describe('grantKycBulk / revokeKycBulk', () => {
    it('grants multiple addresses and emits one event each', async () => {
      const { kycManager, whitelister, user1, user2, user3 } = await loadFixture(deployKycManager);
      const addrs = [user1.address, user2.address, user3.address];
      const tx = await kycManager.connect(whitelister).grantKycBulk(addrs);
      const receipt = await tx.wait();

      const granted = receipt.logs
        .map((log: any) => {
          try {
            return kycManager.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .filter((p: any) => p && p.name === 'KycGranted')
        .map((p: any) => p.args[0]);
      expect(granted).to.deep.equal(addrs);

      for (const a of addrs) expect(await kycManager.isKyced(a)).to.equal(true);
    });

    it('revokes multiple addresses', async () => {
      const { kycManager, whitelister, user1, user2 } = await loadFixture(deployKycManager);
      await kycManager.connect(whitelister).grantKycBulk([user1.address, user2.address]);
      await kycManager.connect(whitelister).revokeKycBulk([user1.address, user2.address]);
      expect(await kycManager.isKyced(user1.address)).to.equal(false);
      expect(await kycManager.isKyced(user2.address)).to.equal(false);
    });

    it('reverts the whole grantKycBulk batch on a duplicate', async () => {
      const { kycManager, whitelister, user1, user2 } = await loadFixture(deployKycManager);
      await kycManager.connect(whitelister).grantKyc(user1.address);
      await expect(
        kycManager.connect(whitelister).grantKycBulk([user2.address, user1.address])
      ).to.be.revertedWithCustomError(kycManager, 'AlreadyKyced').withArgs(user1.address);
      // user2 should NOT have been granted (whole batch reverted)
      expect(await kycManager.isKyced(user2.address)).to.equal(false);
    });

    it('only WHITELIST_ROLE can call bulk variants', async () => {
      const { kycManager, outsider, user1 } = await loadFixture(deployKycManager);
      await expect(
        kycManager.connect(outsider).grantKycBulk([user1.address])
      ).to.be.revertedWithCustomError(kycManager, 'AccessControlUnauthorizedAccount');
      await expect(
        kycManager.connect(outsider).revokeKycBulk([user1.address])
      ).to.be.revertedWithCustomError(kycManager, 'AccessControlUnauthorizedAccount');
    });
  });

  describe('upgrade', () => {
    it('only DEFAULT_ADMIN_ROLE can authorize upgrade', async () => {
      const { kycManager, admin, outsider } = await loadFixture(deployKycManager);
      const KycManagerFactory = await ethers.getContractFactory('KycManager');

      const newImpl = await KycManagerFactory.deploy();
      await newImpl.waitForDeployment();
      await expect(
        kycManager.connect(outsider).upgradeToAndCall(await newImpl.getAddress(), '0x')
      ).to.be.revertedWithCustomError(kycManager, 'AccessControlUnauthorizedAccount');

      await expect(kycManager.connect(admin).upgradeToAndCall(await newImpl.getAddress(), '0x'))
        .to.not.be.reverted;
    });
  });
});
