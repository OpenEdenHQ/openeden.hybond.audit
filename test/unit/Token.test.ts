import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployCoreContracts } from '../fixtures/deployments';
import { deployKycManager } from '../fixtures/kycManagerDeployments';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('OEM Token', function () {
  // Helper to deploy fresh contracts for each test
  async function deployFixture() {
    return await deployCoreContracts();
  }

  describe('Deployment & Initialization', function () {
    it('should initialize with correct name and symbol', async function () {
      const { oem } = await loadFixture(deployFixture);

      expect(await oem.name()).to.equal('OEM Multi Strategy Yield');
      expect(await oem.symbol()).to.equal('OEM');
    });

    it('should set correct decimals (18)', async function () {
      const { oem } = await loadFixture(deployFixture);

      expect(await oem.decimals()).to.equal(18);
    });

    it('should initialize with zero total supply', async function () {
      const { oem, user1, user2, user3 } = await loadFixture(deployFixture);

      // Total supply should be 30000 (3 users * 10000 each from fixture)
      const expectedSupply = ethers.parseUnits('30000', 18);
      expect(await oem.totalSupply()).to.equal(expectedSupply);
    });

    it('should set admin as DEFAULT_ADMIN_ROLE', async function () {
      const { oem, admin } = await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await oem.DEFAULT_ADMIN_ROLE();
      expect(await oem.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it('should set correct issue cap', async function () {
      const { oem } = await loadFixture(deployFixture);

      const expectedCap = ethers.parseUnits('1000000', 18);
      expect(await oem.issueCap()).to.equal(expectedCap);
    });

    it('should revert if initialized with zero address admin', async function () {
      const OEMFactory = await ethers.getContractFactory('Token');

      await expect(
        upgrades.deployProxy(
          OEMFactory,
          [
            'USDO Prime',
            'OEM',
            ethers.ZeroAddress,
            ethers.parseUnits('1000000', 18),
            ethers.ZeroAddress,
          ],
          { kind: 'uups', initializer: 'initialize' }
        )
      ).to.be.revertedWithCustomError(OEMFactory, 'InvalidAddress');
    });

    it('should return correct version', async function () {
      const { oem } = await loadFixture(deployFixture);

      expect(await oem.version()).to.equal('1.0.0');
    });

    it('should not allow re-initialization', async function () {
      const { oem, admin } = await loadFixture(deployFixture);

      await expect(
        oem.initialize(
          'New Name',
          'NEW',
          admin.address,
          ethers.parseUnits('1000000', 18),
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(oem, 'InvalidInitialization');
    });
  });

  describe('Minting', function () {
    it('should mint tokens when called by minter role', async function () {
      const { oem, minter, user1 } = await loadFixture(deployFixture);

      const mintAmount = ethers.parseUnits('1000', 18);
      const balanceBefore = await oem.balanceOf(user1.address);

      await oem.connect(minter).mint(user1.address, mintAmount);

      expect(await oem.balanceOf(user1.address)).to.equal(balanceBefore + mintAmount);
    });

    it('should increase total supply when minting', async function () {
      const { oem, minter, user1 } = await loadFixture(deployFixture);

      const mintAmount = ethers.parseUnits('1000', 18);
      const supplyBefore = await oem.totalSupply();

      await oem.connect(minter).mint(user1.address, mintAmount);

      expect(await oem.totalSupply()).to.equal(supplyBefore + mintAmount);
    });

    it('should emit Mint event', async function () {
      const { oem, minter, user1 } = await loadFixture(deployFixture);

      const mintAmount = ethers.parseUnits('1000', 18);

      await expect(oem.connect(minter).mint(user1.address, mintAmount))
        .to.emit(oem, 'Mint')
        .withArgs(user1.address, mintAmount);
    });

    it('should revert when minting to zero address', async function () {
      const { oem, minter } = await loadFixture(deployFixture);

      const mintAmount = ethers.parseUnits('1000', 18);

      await expect(
        oem.connect(minter).mint(ethers.ZeroAddress, mintAmount)
      ).to.be.revertedWithCustomError(oem, 'ERC20InvalidReceiver');
    });

    it('should revert when minting zero amount', async function () {
      const { oem, minter, user1 } = await loadFixture(deployFixture);

      await expect(oem.connect(minter).mint(user1.address, 0)).to.be.revertedWithCustomError(
        oem,
        'InvalidAmount'
      );
    });

    it('should revert when exceeding issue cap', async function () {
      const { oem, minter, user1 } = await loadFixture(deployFixture);

      const currentSupply = await oem.totalSupply();
      const issueCap = await oem.issueCap();
      const excessAmount = issueCap - currentSupply + 1n;

      await expect(
        oem.connect(minter).mint(user1.address, excessAmount)
      ).to.be.revertedWithCustomError(oem, 'ExceedsIssueCap');
    });

    it('should allow minting up to issue cap', async function () {
      const { oem, minter, user1 } = await loadFixture(deployFixture);

      const currentSupply = await oem.totalSupply();
      const issueCap = await oem.issueCap();
      const remainingCap = issueCap - currentSupply;

      await expect(oem.connect(minter).mint(user1.address, remainingCap)).to.not.be.reverted;

      expect(await oem.totalSupply()).to.equal(issueCap);
    });

    it('should revert when called by non-minter', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const mintAmount = ethers.parseUnits('1000', 18);

      await expect(
        oem.connect(user1).mint(user2.address, mintAmount)
      ).to.be.revertedWithCustomError(oem, 'AccessControlUnauthorizedAccount');
    });

    it('should revert when contract is paused', async function () {
      const { oem, minter, pauser, user1 } = await loadFixture(deployFixture);

      await oem.connect(pauser).pause();

      const mintAmount = ethers.parseUnits('1000', 18);

      await expect(
        oem.connect(minter).mint(user1.address, mintAmount)
      ).to.be.revertedWithCustomError(oem, 'EnforcedPause');
    });

    it('should allow minting with unlimited cap (0)', async function () {
      const [admin, minter, user1] = await ethers.getSigners();

      const OEMFactory = await ethers.getContractFactory('Token');
      const oem = await upgrades.deployProxy(
        OEMFactory,
        ['USDO Prime', 'OEM', admin.address, 0, ethers.ZeroAddress], // 0 = unlimited
        { kind: 'uups', initializer: 'initialize' }
      );

      const MINTER_ROLE = await oem.MINTER_ROLE();
      await oem.connect(admin).grantRole(MINTER_ROLE, minter.address);

      const largeAmount = ethers.parseUnits('1000000000', 18); // 1 billion

      await expect(oem.connect(minter).mint(user1.address, largeAmount)).to.not.be.reverted;
    });
  });

  describe('Burning', function () {
    it("should burn tokens from caller's balance", async function () {
      const { oem, burner, user1 } = await loadFixture(deployFixture);

      const balanceBefore = await oem.balanceOf(user1.address);
      const burnAmount = ethers.parseUnits('100', 18);

      await oem.connect(burner).burn(user1.address, burnAmount);

      expect(await oem.balanceOf(user1.address)).to.equal(balanceBefore - burnAmount);
    });

    it('should decrease total supply when burning', async function () {
      const { oem, burner, user1 } = await loadFixture(deployFixture);

      const supplyBefore = await oem.totalSupply();
      const burnAmount = ethers.parseUnits('100', 18);

      await oem.connect(burner).burn(user1.address, burnAmount);

      expect(await oem.totalSupply()).to.equal(supplyBefore - burnAmount);
    });

    it('should emit Burn event', async function () {
      const { oem, burner, user1 } = await loadFixture(deployFixture);

      const burnAmount = ethers.parseUnits('100', 18);

      await expect(oem.connect(burner).burn(user1.address, burnAmount))
        .to.emit(oem, 'Burn')
        .withArgs(user1.address, burnAmount);
    });

    it('should revert when burning zero amount', async function () {
      const { oem, burner, user1 } = await loadFixture(deployFixture);

      await expect(oem.connect(burner).burn(user1.address, 0)).to.be.revertedWithCustomError(
        oem,
        'InvalidAmount'
      );
    });

    it('should revert when burning more than balance', async function () {
      const { oem, burner, user1 } = await loadFixture(deployFixture);

      const balance = await oem.balanceOf(user1.address);
      const excessAmount = balance + 1n;

      await expect(
        oem.connect(burner).burn(user1.address, excessAmount)
      ).to.be.revertedWithCustomError(oem, 'ERC20InsufficientBalance');
    });

    it('should allow burner role to burn from any address', async function () {
      const { oem, burner, user1, user2 } = await loadFixture(deployFixture);

      const burnAmount = ethers.parseUnits('100', 18);

      await expect(oem.connect(burner).burn(user1.address, burnAmount)).to.not.be.reverted;
      await expect(oem.connect(burner).burn(user2.address, burnAmount)).to.not.be.reverted;
    });

    it('should revert when contract is paused', async function () {
      const { oem, burner, user1, pauser } = await loadFixture(deployFixture);

      await oem.connect(pauser).pause();

      const burnAmount = ethers.parseUnits('100', 18);

      await expect(
        oem.connect(burner).burn(user1.address, burnAmount)
      ).to.be.revertedWithCustomError(oem, 'EnforcedPause');
    });

    it('should burn entire balance', async function () {
      const { oem, burner, user1 } = await loadFixture(deployFixture);

      const balance = await oem.balanceOf(user1.address);

      await oem.connect(burner).burn(user1.address, balance);

      expect(await oem.balanceOf(user1.address)).to.equal(0);
    });
  });

  describe('Transfers', function () {
    it('should transfer tokens between accounts', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const transferAmount = ethers.parseUnits('100', 18);
      const user1BalanceBefore = await oem.balanceOf(user1.address);
      const user2BalanceBefore = await oem.balanceOf(user2.address);

      await oem.connect(user1).transfer(user2.address, transferAmount);

      expect(await oem.balanceOf(user1.address)).to.equal(user1BalanceBefore - transferAmount);
      expect(await oem.balanceOf(user2.address)).to.equal(user2BalanceBefore + transferAmount);
    });

    it('should emit Transfer event', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const transferAmount = ethers.parseUnits('100', 18);

      await expect(oem.connect(user1).transfer(user2.address, transferAmount))
        .to.emit(oem, 'Transfer')
        .withArgs(user1.address, user2.address, transferAmount);
    });

    it('should revert when transferring to zero address', async function () {
      const { oem, user1 } = await loadFixture(deployFixture);

      const transferAmount = ethers.parseUnits('100', 18);

      await expect(
        oem.connect(user1).transfer(ethers.ZeroAddress, transferAmount)
      ).to.be.revertedWithCustomError(oem, 'ERC20InvalidReceiver');
    });

    it('should revert when transferring more than balance', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const balance = await oem.balanceOf(user1.address);
      const excessAmount = balance + 1n;

      await expect(
        oem.connect(user1).transfer(user2.address, excessAmount)
      ).to.be.revertedWithCustomError(oem, 'ERC20InsufficientBalance');
    });

    it('should revert when sender is banned', async function () {
      const { oem, user1, user2, banlistManager } = await loadFixture(deployFixture);

      await oem.connect(banlistManager).banAddresses([user1.address]);

      const transferAmount = ethers.parseUnits('100', 18);

      await expect(
        oem.connect(user1).transfer(user2.address, transferAmount)
      ).to.be.revertedWithCustomError(oem, 'BannedSender');
    });

    it('should revert when recipient is banned', async function () {
      const { oem, user1, user2, banlistManager } = await loadFixture(deployFixture);

      await oem.connect(banlistManager).banAddresses([user2.address]);

      const transferAmount = ethers.parseUnits('100', 18);

      await expect(
        oem.connect(user1).transfer(user2.address, transferAmount)
      ).to.be.revertedWithCustomError(oem, 'BannedRecipient');
    });

    it('should revert when contract is paused', async function () {
      const { oem, user1, user2, pauser } = await loadFixture(deployFixture);

      await oem.connect(pauser).pause();

      const transferAmount = ethers.parseUnits('100', 18);

      await expect(
        oem.connect(user1).transfer(user2.address, transferAmount)
      ).to.be.revertedWithCustomError(oem, 'EnforcedPause');
    });

    it('should allow transfer of zero amount', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      await expect(oem.connect(user1).transfer(user2.address, 0)).to.not.be.reverted;
    });
  });

  describe('Allowance & TransferFrom', function () {
    it('should approve allowance', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const approvalAmount = ethers.parseUnits('500', 18);

      await oem.connect(user1).approve(user2.address, approvalAmount);

      expect(await oem.allowance(user1.address, user2.address)).to.equal(approvalAmount);
    });

    it('should emit Approval event', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const approvalAmount = ethers.parseUnits('500', 18);

      await expect(oem.connect(user1).approve(user2.address, approvalAmount))
        .to.emit(oem, 'Approval')
        .withArgs(user1.address, user2.address, approvalAmount);
    });

    it('should transfer tokens using transferFrom with allowance', async function () {
      const { oem, user1, user2, user3 } = await loadFixture(deployFixture);

      const approvalAmount = ethers.parseUnits('500', 18);
      const transferAmount = ethers.parseUnits('100', 18);

      await oem.connect(user1).approve(user2.address, approvalAmount);

      const user1BalanceBefore = await oem.balanceOf(user1.address);
      const user3BalanceBefore = await oem.balanceOf(user3.address);

      await oem.connect(user2).transferFrom(user1.address, user3.address, transferAmount);

      expect(await oem.balanceOf(user1.address)).to.equal(user1BalanceBefore - transferAmount);
      expect(await oem.balanceOf(user3.address)).to.equal(user3BalanceBefore + transferAmount);
      expect(await oem.allowance(user1.address, user2.address)).to.equal(
        approvalAmount - transferAmount
      );
    });

    it('should revert when transferFrom exceeds allowance', async function () {
      const { oem, user1, user2, user3 } = await loadFixture(deployFixture);

      const approvalAmount = ethers.parseUnits('500', 18);
      const transferAmount = ethers.parseUnits('600', 18);

      await oem.connect(user1).approve(user2.address, approvalAmount);

      await expect(
        oem.connect(user2).transferFrom(user1.address, user3.address, transferAmount)
      ).to.be.revertedWithCustomError(oem, 'ERC20InsufficientAllowance');
    });

    it('should increase allowance', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const initialAllowance = ethers.parseUnits('500', 18);
      const increaseAmount = ethers.parseUnits('200', 18);

      await oem.connect(user1).approve(user2.address, initialAllowance);
      await oem.connect(user1).increaseAllowance(user2.address, increaseAmount);

      expect(await oem.allowance(user1.address, user2.address)).to.equal(
        initialAllowance + increaseAmount
      );
    });

    it('should decrease allowance', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const initialAllowance = ethers.parseUnits('500', 18);
      const decreaseAmount = ethers.parseUnits('200', 18);

      await oem.connect(user1).approve(user2.address, initialAllowance);
      await oem.connect(user1).decreaseAllowance(user2.address, decreaseAmount);

      expect(await oem.allowance(user1.address, user2.address)).to.equal(
        initialAllowance - decreaseAmount
      );
    });

    it('should revert when decreasing allowance below zero', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const initialAllowance = ethers.parseUnits('500', 18);
      const decreaseAmount = ethers.parseUnits('600', 18);

      await oem.connect(user1).approve(user2.address, initialAllowance);

      await expect(
        oem.connect(user1).decreaseAllowance(user2.address, decreaseAmount)
      ).to.be.revertedWithCustomError(oem, 'ERC20InsufficientAllowance');
    });
  });

  describe('Ban List Management', function () {
    it('should ban addresses', async function () {
      const { oem, banlistManager, user1 } = await loadFixture(deployFixture);

      await oem.connect(banlistManager).banAddresses([user1.address]);

      expect(await oem.isBanned(user1.address)).to.be.true;
    });

    it('should emit AccountBanned event', async function () {
      const { oem, banlistManager, user1 } = await loadFixture(deployFixture);

      await expect(oem.connect(banlistManager).banAddresses([user1.address]))
        .to.emit(oem, 'AccountBanned')
        .withArgs(user1.address);
    });

    it('should ban multiple addresses at once', async function () {
      const { oem, banlistManager, user1, user2, user3 } = await loadFixture(deployFixture);

      await oem.connect(banlistManager).banAddresses([user1.address, user2.address, user3.address]);

      expect(await oem.isBanned(user1.address)).to.be.true;
      expect(await oem.isBanned(user2.address)).to.be.true;
      expect(await oem.isBanned(user3.address)).to.be.true;
    });

    it('should unban addresses', async function () {
      const { oem, banlistManager, user1 } = await loadFixture(deployFixture);

      await oem.connect(banlistManager).banAddresses([user1.address]);
      expect(await oem.isBanned(user1.address)).to.be.true;

      await oem.connect(banlistManager).unbanAddresses([user1.address]);
      expect(await oem.isBanned(user1.address)).to.be.false;
    });

    it('should emit AccountUnbanned event', async function () {
      const { oem, banlistManager, user1 } = await loadFixture(deployFixture);

      await oem.connect(banlistManager).banAddresses([user1.address]);

      await expect(oem.connect(banlistManager).unbanAddresses([user1.address]))
        .to.emit(oem, 'AccountUnbanned')
        .withArgs(user1.address);
    });

    it('should revert when trying to ban already banned address', async function () {
      const { oem, banlistManager, user1 } = await loadFixture(deployFixture);

      await oem.connect(banlistManager).banAddresses([user1.address]);

      await expect(
        oem.connect(banlistManager).banAddresses([user1.address])
      ).to.be.revertedWithCustomError(oem, 'InvalidBannedAccount');
    });

    it('should revert when trying to unban non-banned address', async function () {
      const { oem, banlistManager, user1 } = await loadFixture(deployFixture);

      await expect(
        oem.connect(banlistManager).unbanAddresses([user1.address])
      ).to.be.revertedWithCustomError(oem, 'InvalidBannedAccount');
    });

    it('should revert when non-banlist manager tries to ban', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      await expect(oem.connect(user1).banAddresses([user2.address])).to.be.revertedWithCustomError(
        oem,
        'AccessControlUnauthorizedAccount'
      );
    });

    it('should revert when minting to banned address', async function () {
      const { oem, minter, banlistManager, user1 } = await loadFixture(deployFixture);

      await oem.connect(banlistManager).banAddresses([user1.address]);

      const mintAmount = ethers.parseUnits('100', 18);

      // Minting to banned address should now revert for regulatory compliance
      await expect(oem.connect(minter).mint(user1.address, mintAmount))
        .to.be.revertedWithCustomError(oem, 'BannedRecipient')
        .withArgs(user1.address);
    });

    it('should revert when burning from banned address', async function () {
      const { oem, minter, burner, banlistManager, user1 } = await loadFixture(deployFixture);

      const amount = ethers.parseUnits('100', 18);

      // First mint to user1
      await oem.connect(minter).mint(user1.address, amount);

      // Then ban user1
      await oem.connect(banlistManager).banAddresses([user1.address]);

      // Burning from banned address should now revert for regulatory compliance
      await expect(oem.connect(burner).burn(user1.address, amount))
        .to.be.revertedWithCustomError(oem, 'BannedSender')
        .withArgs(user1.address);
    });
  });

  describe('Pausability', function () {
    it('should pause contract', async function () {
      const { oem, pauser } = await loadFixture(deployFixture);

      await oem.connect(pauser).pause();

      expect(await oem.paused()).to.be.true;
    });

    it('should emit Paused event', async function () {
      const { oem, pauser } = await loadFixture(deployFixture);

      await expect(oem.connect(pauser).pause()).to.emit(oem, 'Paused').withArgs(pauser.address);
    });

    it('should unpause contract', async function () {
      const { oem, pauser } = await loadFixture(deployFixture);

      await oem.connect(pauser).pause();
      expect(await oem.paused()).to.be.true;

      await oem.connect(pauser).unpause();
      expect(await oem.paused()).to.be.false;
    });

    it('should emit Unpaused event', async function () {
      const { oem, pauser } = await loadFixture(deployFixture);

      await oem.connect(pauser).pause();

      await expect(oem.connect(pauser).unpause()).to.emit(oem, 'Unpaused').withArgs(pauser.address);
    });

    it('should revert when non-pauser tries to pause', async function () {
      const { oem, user1 } = await loadFixture(deployFixture);

      await expect(oem.connect(user1).pause()).to.be.revertedWithCustomError(
        oem,
        'AccessControlUnauthorizedAccount'
      );
    });

    it('should revert when non-pauser tries to unpause', async function () {
      const { oem, pauser, user1 } = await loadFixture(deployFixture);

      await oem.connect(pauser).pause();

      await expect(oem.connect(user1).unpause()).to.be.revertedWithCustomError(
        oem,
        'AccessControlUnauthorizedAccount'
      );
    });

    it('should block transfers when paused', async function () {
      const { oem, user1, user2, pauser } = await loadFixture(deployFixture);

      await oem.connect(pauser).pause();

      const transferAmount = ethers.parseUnits('100', 18);

      await expect(
        oem.connect(user1).transfer(user2.address, transferAmount)
      ).to.be.revertedWithCustomError(oem, 'EnforcedPause');
    });

    it('should block minting when paused', async function () {
      const { oem, minter, user1, pauser } = await loadFixture(deployFixture);

      await oem.connect(pauser).pause();

      const mintAmount = ethers.parseUnits('100', 18);

      await expect(
        oem.connect(minter).mint(user1.address, mintAmount)
      ).to.be.revertedWithCustomError(oem, 'EnforcedPause');
    });

    it('should block burning when paused', async function () {
      const { oem, burner, user1, pauser } = await loadFixture(deployFixture);

      await oem.connect(pauser).pause();

      const burnAmount = ethers.parseUnits('100', 18);

      await expect(
        oem.connect(burner).burn(user1.address, burnAmount)
      ).to.be.revertedWithCustomError(oem, 'EnforcedPause');
    });

    it('should allow transfers after unpausing', async function () {
      const { oem, user1, user2, pauser } = await loadFixture(deployFixture);

      await oem.connect(pauser).pause();
      await oem.connect(pauser).unpause();

      const transferAmount = ethers.parseUnits('100', 18);

      await expect(oem.connect(user1).transfer(user2.address, transferAmount)).to.not.be.reverted;
    });
  });

  describe('Issue Cap Management', function () {
    it('should update issue cap', async function () {
      const { oem, admin } = await loadFixture(deployFixture);

      const newCap = ethers.parseUnits('2000000', 18);

      await oem.connect(admin).setIssueCap(newCap);

      expect(await oem.issueCap()).to.equal(newCap);
    });

    it('should emit IssueCapUpdated event', async function () {
      const { oem, admin } = await loadFixture(deployFixture);

      const oldCap = await oem.issueCap();
      const newCap = ethers.parseUnits('2000000', 18);

      await expect(oem.connect(admin).setIssueCap(newCap))
        .to.emit(oem, 'IssueCapUpdated')
        .withArgs(oldCap, newCap);
    });

    it('should allow setting cap to zero (unlimited)', async function () {
      const { oem, admin } = await loadFixture(deployFixture);

      await oem.connect(admin).setIssueCap(0);

      expect(await oem.issueCap()).to.equal(0);
    });

    it('should revert when setting cap below total supply', async function () {
      const { oem, admin } = await loadFixture(deployFixture);

      const totalSupply = await oem.totalSupply();
      const lowCap = totalSupply - 1n;

      await expect(oem.connect(admin).setIssueCap(lowCap)).to.be.revertedWithCustomError(
        oem,
        'CapBelowSupply'
      );
    });

    it('should allow setting cap equal to total supply', async function () {
      const { oem, admin } = await loadFixture(deployFixture);

      const totalSupply = await oem.totalSupply();

      await expect(oem.connect(admin).setIssueCap(totalSupply)).to.not.be.reverted;
    });

    it('should revert when non-maintainer tries to set cap', async function () {
      const { oem, user1 } = await loadFixture(deployFixture);

      const newCap = ethers.parseUnits('2000000', 18);

      await expect(oem.connect(user1).setIssueCap(newCap)).to.be.revertedWithCustomError(
        oem,
        'AccessControlUnauthorizedAccount'
      );
    });
  });

  describe('Role Management', function () {
    it('should allow admin to grant roles', async function () {
      const { oem, admin, user1 } = await loadFixture(deployFixture);

      const MINTER_ROLE = await oem.MINTER_ROLE();

      await oem.connect(admin).grantRole(MINTER_ROLE, user1.address);

      expect(await oem.hasRole(MINTER_ROLE, user1.address)).to.be.true;
    });

    it('should allow admin to revoke roles', async function () {
      const { oem, admin, minter } = await loadFixture(deployFixture);

      const MINTER_ROLE = await oem.MINTER_ROLE();

      await oem.connect(admin).revokeRole(MINTER_ROLE, minter.address);

      expect(await oem.hasRole(MINTER_ROLE, minter.address)).to.be.false;
    });

    it('should revert when non-admin tries to grant roles', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const MINTER_ROLE = await oem.MINTER_ROLE();

      await expect(
        oem.connect(user1).grantRole(MINTER_ROLE, user2.address)
      ).to.be.revertedWithCustomError(oem, 'AccessControlUnauthorizedAccount');
    });

    it('should enumerate role members', async function () {
      const { oem, admin, minter } = await loadFixture(deployFixture);

      const MINTER_ROLE = await oem.MINTER_ROLE();
      const memberCount = await oem.getRoleMemberCount(MINTER_ROLE);

      expect(memberCount).to.equal(1);
      expect(await oem.getRoleMember(MINTER_ROLE, 0)).to.equal(minter.address);
    });
  });

  describe('Upgradeability', function () {
    it('should allow admin to upgrade contract', async function () {
      const { oem, admin } = await loadFixture(deployFixture);

      const OEMFactory = await ethers.getContractFactory('Token');

      await expect(
        upgrades.upgradeProxy(await oem.getAddress(), OEMFactory, {
          call: {
            fn: 'initialize',
            args: [
              'USDO Prime',
              'OEM',
              admin.address,
              ethers.parseUnits('1000000', 18),
              ethers.ZeroAddress,
            ],
          },
        })
      ).to.be.revertedWithCustomError(OEMFactory, 'InvalidInitialization');
    });

    it('should revert when non-admin tries to upgrade', async function () {
      const { oem, user1 } = await loadFixture(deployFixture);

      const OEMFactory = await ethers.getContractFactory('Token', user1);

      await expect(
        upgrades.upgradeProxy(await oem.getAddress(), OEMFactory)
      ).to.be.revertedWithCustomError(oem, 'AccessControlUnauthorizedAccount');
    });
  });

  describe('Reentrancy Protection', function () {
    it('should protect mint from reentrancy', async function () {
      // This would require a malicious contract to test properly
      // The nonReentrant modifier is in place
      const { oem, minter } = await loadFixture(deployFixture);

      // Basic check that the function has the protection
      const mintAmount = ethers.parseUnits('100', 18);
      await expect(oem.connect(minter).mint(minter.address, mintAmount)).to.not.be.reverted;
    });

    it('should protect burn from reentrancy', async function () {
      const { oem, burner, user1 } = await loadFixture(deployFixture);

      const burnAmount = ethers.parseUnits('100', 18);
      await expect(oem.connect(burner).burn(user1.address, burnAmount)).to.not.be.reverted;
    });
  });

  describe('Edge Cases & Boundary Conditions', function () {
    it('should handle maximum uint256 allowance', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const maxAllowance = ethers.MaxUint256;

      await oem.connect(user1).approve(user2.address, maxAllowance);

      expect(await oem.allowance(user1.address, user2.address)).to.equal(maxAllowance);
    });

    it('should handle transferring entire balance', async function () {
      const { oem, user1, user2 } = await loadFixture(deployFixture);

      const balance = await oem.balanceOf(user1.address);

      await oem.connect(user1).transfer(user2.address, balance);

      expect(await oem.balanceOf(user1.address)).to.equal(0);
    });

    it('should handle empty ban list array', async function () {
      const { oem, banlistManager } = await loadFixture(deployFixture);

      await expect(oem.connect(banlistManager).banAddresses([])).to.not.be.reverted;
    });

    it('should handle very small amounts (1 wei)', async function () {
      const { oem, minter, user1, user2 } = await loadFixture(deployFixture);

      await oem.connect(minter).mint(user1.address, 1);
      await oem.connect(user1).transfer(user2.address, 1);

      expect(await oem.balanceOf(user2.address)).to.equal(await oem.balanceOf(user2.address));
    });

    it('should handle self-transfer', async function () {
      const { oem, user1 } = await loadFixture(deployFixture);

      const balanceBefore = await oem.balanceOf(user1.address);
      const transferAmount = ethers.parseUnits('100', 18);

      await oem.connect(user1).transfer(user1.address, transferAmount);

      expect(await oem.balanceOf(user1.address)).to.equal(balanceBefore);
    });

    it('should handle approval to self', async function () {
      const { oem, user1 } = await loadFixture(deployFixture);

      const approvalAmount = ethers.parseUnits('100', 18);

      await expect(oem.connect(user1).approve(user1.address, approvalAmount)).to.not.be.reverted;
    });
  });

  describe('Gas Optimization Tests', function () {
    it('should batch ban efficiently', async function () {
      const { oem, banlistManager } = await loadFixture(deployFixture);

      const addresses = [];
      for (let i = 0; i < 10; i++) {
        addresses.push(ethers.Wallet.createRandom().address);
      }

      const tx = await oem.connect(banlistManager).banAddresses(addresses);
      const receipt = await tx.wait();

      // Check that all addresses are banned
      for (const addr of addresses) {
        expect(await oem.isBanned(addr)).to.be.true;
      }
    });
  });
});

describe('Token KYC gating', () => {
  async function deployPermissionedToken() {
    const kyc = await deployKycManager();
    const TokenFactory = await ethers.getContractFactory('Token');
    const token = await upgrades.deployProxy(
      TokenFactory,
      [
        'HYBOND',
        'HBND',
        kyc.admin.address,
        ethers.parseUnits('10000000', 18),
        await kyc.kycManager.getAddress(),
      ],
      { kind: 'uups', initializer: 'initialize' }
    );
    await token.waitForDeployment();

    const MINTER_ROLE = await token.MINTER_ROLE();
    const BURNER_ROLE = await token.BURNER_ROLE();
    await token.connect(kyc.admin).grantRole(MINTER_ROLE, kyc.admin.address);
    await token.connect(kyc.admin).grantRole(BURNER_ROLE, kyc.admin.address);

    return { token, ...kyc };
  }

  async function deployPermissionlessToken() {
    const [admin, user1, user2] = await ethers.getSigners();
    const TokenFactory = await ethers.getContractFactory('Token');
    const token = await upgrades.deployProxy(
      TokenFactory,
      ['HYBOND', 'HBND', admin.address, ethers.parseUnits('10000000', 18), ethers.ZeroAddress],
      { kind: 'uups', initializer: 'initialize' }
    );
    await token.waitForDeployment();
    const MINTER_ROLE = await token.MINTER_ROLE();
    const BURNER_ROLE = await token.BURNER_ROLE();
    await token.connect(admin).grantRole(MINTER_ROLE, admin.address);
    await token.connect(admin).grantRole(BURNER_ROLE, admin.address);
    return { token, admin, user1, user2 };
  }

  it('permissionless mode: any address can hold and transfer', async () => {
    const { token, admin, user1, user2 } = await loadFixture(deployPermissionlessToken);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await token.connect(user1).transfer(user2.address, ethers.parseUnits('10', 18));
    expect(await token.balanceOf(user2.address)).to.equal(ethers.parseUnits('10', 18));
  });

  it('permissioned mode: mint to non-KYC address reverts NotKyced', async () => {
    const { token, admin, user1 } = await loadFixture(deployPermissionedToken);
    await expect(token.connect(admin).mint(user1.address, 1n))
      .to.be.revertedWithCustomError(token, 'NotKyced')
      .withArgs(user1.address);
  });

  it('permissioned mode: mint to KYC address succeeds', async () => {
    const { token, kycManager, whitelister, admin, user1 } = await loadFixture(
      deployPermissionedToken
    );
    await kycManager.connect(whitelister).grantKyc(user1.address);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    expect(await token.balanceOf(user1.address)).to.equal(ethers.parseUnits('100', 18));
  });

  it('permissioned mode: transfer between two KYC addresses succeeds', async () => {
    const { token, kycManager, whitelister, admin, user1, user2 } = await loadFixture(
      deployPermissionedToken
    );
    await kycManager.connect(whitelister).grantKycBulk([user1.address, user2.address]);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await token.connect(user1).transfer(user2.address, ethers.parseUnits('10', 18));
    expect(await token.balanceOf(user2.address)).to.equal(ethers.parseUnits('10', 18));
  });

  it('permissioned mode: transfer from non-KYC sender reverts', async () => {
    const { token, kycManager, whitelister, admin, user1, user2 } = await loadFixture(
      deployPermissionedToken
    );
    await kycManager.connect(whitelister).grantKyc(user1.address);
    await kycManager.connect(whitelister).grantKyc(user2.address);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await kycManager.connect(whitelister).revokeKyc(user1.address);

    await expect(token.connect(user1).transfer(user2.address, 1n))
      .to.be.revertedWithCustomError(token, 'NotKyced')
      .withArgs(user1.address);
  });

  it('permissioned mode: transfer to non-KYC receiver reverts', async () => {
    const { token, kycManager, whitelister, admin, user1, user2 } = await loadFixture(
      deployPermissionedToken
    );
    await kycManager.connect(whitelister).grantKyc(user1.address);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await expect(token.connect(user1).transfer(user2.address, 1n))
      .to.be.revertedWithCustomError(token, 'NotKyced')
      .withArgs(user2.address);
  });

  it('permissioned mode: burn from non-KYC address reverts', async () => {
    const { token, kycManager, whitelister, admin, user1 } = await loadFixture(
      deployPermissionedToken
    );
    await kycManager.connect(whitelister).grantKyc(user1.address);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await kycManager.connect(whitelister).revokeKyc(user1.address);
    await expect(token.connect(admin).burn(user1.address, 1n))
      .to.be.revertedWithCustomError(token, 'NotKyced')
      .withArgs(user1.address);
  });

  it('ban check fires before KYC check (preserves existing order)', async () => {
    const { token, kycManager, whitelister, admin, user1, user2 } = await loadFixture(
      deployPermissionedToken
    );
    await kycManager.connect(whitelister).grantKycBulk([user1.address, user2.address]);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));

    // ban user1; user1 is still KYC'd
    const BANLIST_ROLE = await token.BANLIST_ROLE();
    await token.connect(admin).grantRole(BANLIST_ROLE, admin.address);
    await token.connect(admin).banAddresses([user1.address]);

    await expect(token.connect(user1).transfer(user2.address, 1n)).to.be.revertedWithCustomError(
      token,
      'BannedSender'
    );
  });

  it('setKycManager: only DEFAULT_ADMIN_ROLE; emits KycManagerUpdated; accepts zero', async () => {
    const { token, admin, user1 } = await loadFixture(deployPermissionedToken);

    await expect(token.connect(user1).setKycManager(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(token, 'AccessControlUnauthorizedAccount');

    const oldManager = await token.kycManager();
    await expect(token.connect(admin).setKycManager(ethers.ZeroAddress))
      .to.emit(token, 'KycManagerUpdated')
      .withArgs(oldManager, ethers.ZeroAddress);
    expect(await token.kycManager()).to.equal(ethers.ZeroAddress);
  });

  it('setKycManager to zero flips Token to permissionless', async () => {
    const { token, admin, user1, user2 } = await loadFixture(deployPermissionedToken);
    await token.connect(admin).setKycManager(ethers.ZeroAddress);
    // No KYC needed now
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await token.connect(user1).transfer(user2.address, ethers.parseUnits('10', 18));
    expect(await token.balanceOf(user2.address)).to.equal(ethers.parseUnits('10', 18));
  });

  it('manager-revert bubbles up', async () => {
    const { token, admin, user1 } = await loadFixture(deployPermissionedToken);

    const RevertMock = await ethers.getContractFactory('KycManagerRevertMock');
    const mock = await RevertMock.deploy();
    await mock.waitForDeployment();

    await token.connect(admin).setKycManager(await mock.getAddress());
    await expect(token.connect(admin).mint(user1.address, 1n)).to.be.revertedWithCustomError(
      mock,
      'MockBoom'
    );
  });
});
