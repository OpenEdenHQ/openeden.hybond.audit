import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

describe('Express - Offchain Shares', function () {
  async function deployFixture() {
    const base = await deployExpressContracts();
    const signers = await ethers.getSigners();
    const confirmer = signers[10];
    const CONFIRM_ROLE = await base.express.CONFIRM_ROLE();
    await base.express.connect(base.admin).grantRole(CONFIRM_ROLE, confirmer.address);
    return { ...base, confirmer };
  }

  // Fixture: bootstrap first deposit minted, offchainShares still 0
  async function deployWithBootstrapFixture() {
    const base = await deployFixture();
    const { express, usdo, user1, maintainer } = base;

    // Bootstrap deposit: totalSupply == 0, so guard allows it even with offchainShares == 0
    const depositAmt = ethers.parseUnits('2000', 18); // >= firstDepositAmount (1000)
    await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

    // Process the queue: mints tokens, totalSupply is now > 0; offchainShares stays 0
    await express.connect(maintainer).processDepositQueue(1);

    return base;
  }

  describe('proposeOffchainShares', function () {
    it('reverts with AccessControl error when called by non-OPERATOR_ROLE', async function () {
      const { express, user1 } = await loadFixture(deployFixture);

      await expect(
        express.connect(user1).proposeOffchainShares(ethers.parseUnits('1000', 18))
      ).to.be.revertedWithCustomError(express, 'AccessControlUnauthorizedAccount');
    });

    it('reverts with InvalidAmount when _supply is 0', async function () {
      const { express, operator } = await loadFixture(deployFixture);

      await expect(
        express.connect(operator).proposeOffchainShares(0)
      ).to.be.revertedWithCustomError(express, 'InvalidAmount');
    });

    it('sets proposedOffchainShares and emits ProposeOffchainShares on valid propose', async function () {
      const { express, operator } = await loadFixture(deployFixture);

      const supply = ethers.parseUnits('500000', 18);

      await expect(express.connect(operator).proposeOffchainShares(supply))
        .to.emit(express, 'ProposeOffchainShares')
        .withArgs(operator.address, supply);

      expect(await express.proposedOffchainShares()).to.equal(supply);
    });

    it('overwrites prior pending value with latest proposal (latest-wins)', async function () {
      const { express, operator } = await loadFixture(deployFixture);

      const firstSupply = ethers.parseUnits('100000', 18);
      const secondSupply = ethers.parseUnits('200000', 18);

      await express.connect(operator).proposeOffchainShares(firstSupply);
      expect(await express.proposedOffchainShares()).to.equal(firstSupply);

      await expect(express.connect(operator).proposeOffchainShares(secondSupply))
        .to.emit(express, 'ProposeOffchainShares')
        .withArgs(operator.address, secondSupply);
      expect(await express.proposedOffchainShares()).to.equal(secondSupply);
    });
  });

  describe('confirmOffchainShares', function () {
    it('reverts with AccessControl error when called by non-CONFIRM_ROLE', async function () {
      const { express, user1 } = await loadFixture(deployFixture);

      await expect(
        express.connect(user1).confirmOffchainShares(ethers.parseUnits('1000', 18))
      ).to.be.revertedWithCustomError(express, 'AccessControlUnauthorizedAccount');
    });

    it('reverts with InvalidAmount when proposedOffchainShares is 0', async function () {
      const { express, confirmer } = await loadFixture(deployFixture);

      await expect(
        express.connect(confirmer).confirmOffchainShares(ethers.parseUnits('1000', 18))
      ).to.be.revertedWithCustomError(express, 'InvalidAmount');
    });

    it('reverts with InvalidInput when _supply does not match proposedOffchainShares', async function () {
      const { express, operator, confirmer } = await loadFixture(deployFixture);

      const supply = ethers.parseUnits('500000', 18);
      const wrongSupply = ethers.parseUnits('999999', 18);

      await express.connect(operator).proposeOffchainShares(supply);

      await expect(express.connect(confirmer).confirmOffchainShares(wrongSupply))
        .to.be.revertedWithCustomError(express, 'InvalidInput')
        .withArgs(wrongSupply);
    });

    it('sets offchainShares, clears proposedOffchainShares, and emits ConfirmOffchainShares', async function () {
      const { express, operator, confirmer } = await loadFixture(deployFixture);

      const supply = ethers.parseUnits('500000', 18);
      await express.connect(operator).proposeOffchainShares(supply);

      await expect(express.connect(confirmer).confirmOffchainShares(supply))
        .to.emit(express, 'ConfirmOffchainShares')
        .withArgs(confirmer.address, supply, 0n);

      expect(await express.offchainShares()).to.equal(supply);
      expect(await express.proposedOffchainShares()).to.equal(0n);
    });

    it('reverts on second confirm after pending is cleared', async function () {
      const { express, operator, confirmer } = await loadFixture(deployFixture);

      const supply = ethers.parseUnits('500000', 18);
      await express.connect(operator).proposeOffchainShares(supply);
      await express.connect(confirmer).confirmOffchainShares(supply);

      await expect(
        express.connect(confirmer).confirmOffchainShares(supply)
      ).to.be.revertedWithCustomError(express, 'InvalidAmount');
    });

    it('re-propose + confirm sequence: operator proposes A, re-proposes B, confirmer echoes B', async function () {
      const { express, operator, confirmer } = await loadFixture(deployFixture);

      const supplyA = ethers.parseUnits('100000', 18);
      const supplyB = ethers.parseUnits('200000', 18);

      await express.connect(operator).proposeOffchainShares(supplyA);
      expect(await express.proposedOffchainShares()).to.equal(supplyA);

      await express.connect(operator).proposeOffchainShares(supplyB);
      expect(await express.proposedOffchainShares()).to.equal(supplyB);

      // Stale echo: confirmer must not be able to confirm the overwritten value
      await expect(express.connect(confirmer).confirmOffchainShares(supplyA))
        .to.be.revertedWithCustomError(express, 'InvalidInput')
        .withArgs(supplyA);

      await expect(express.connect(confirmer).confirmOffchainShares(supplyB))
        .to.emit(express, 'ConfirmOffchainShares')
        .withArgs(confirmer.address, supplyB, 0n);

      expect(await express.offchainShares()).to.equal(supplyB);
      expect(await express.proposedOffchainShares()).to.equal(0n);
    });
  });

  describe('redeem after sync', function () {
    it('requestRedeem succeeds once offchainShares > 0 (post-sync)', async function () {
      const { express, oem, user1, operator, confirmer } = await loadFixture(
        deployWithBootstrapFixture
      );

      const user1Balance = await oem.balanceOf(user1.address);
      await express.connect(operator).proposeOffchainShares(user1Balance);
      await express.connect(confirmer).confirmOffchainShares(user1Balance);

      const redeemAmt = ethers.parseUnits('100', 18);
      await oem.connect(user1).approve(await express.getAddress(), redeemAmt);

      await expect(express.connect(user1).requestRedeem(user1.address, redeemAmt)).to.not.be
        .reverted;
    });
  });

  describe('updateEpoch guard', function () {
    async function deployWithEpochReadyFixture() {
      const base = await deployWithBootstrapFixture();
      const { express, oem, user1, operator, confirmer, maintainer } = base;

      // Set offchainShares so the system is post-bootstrap
      const supply = await oem.balanceOf(user1.address);
      await express.connect(operator).proposeOffchainShares(supply);
      await express.connect(confirmer).confirmOffchainShares(supply);

      // Enable management fees (required for updateEpoch)
      await express.connect(maintainer).updateMgtFeeRate(100); // 1% annual in BPS

      // Zero out lastUpdateTS so timeBuffer doesn't block
      await express.connect(maintainer).updateTimeBuffer(0);

      return base;
    }

    it('reverts PendingProposalExists when proposedOffchainShares != 0', async function () {
      const { express, operator } = await loadFixture(deployWithEpochReadyFixture);

      const pendingSupply = ethers.parseUnits('999999', 18);
      await express.connect(operator).proposeOffchainShares(pendingSupply);
      expect(await express.proposedOffchainShares()).to.equal(pendingSupply);

      await expect(express.connect(operator).updateEpoch())
        .to.be.revertedWithCustomError(express, 'PendingProposalExists')
        .withArgs(pendingSupply);
    });

    it('updateEpoch succeeds after confirming the pending proposal', async function () {
      const { express, operator, confirmer } = await loadFixture(deployWithEpochReadyFixture);

      const pendingSupply = ethers.parseUnits('999999', 18);
      await express.connect(operator).proposeOffchainShares(pendingSupply);

      // Confirm clears the proposal
      await express.connect(confirmer).confirmOffchainShares(pendingSupply);
      expect(await express.proposedOffchainShares()).to.equal(0n);

      await expect(express.connect(operator).updateEpoch()).to.not.be.reverted;
    });

    it('re-propose + confirm recovery: operator overwrites wrong proposal, confirmer echoes correct value, updateEpoch succeeds', async function () {
      const { express, operator, confirmer } = await loadFixture(deployWithEpochReadyFixture);

      const wrongSupply = ethers.parseUnits('111111', 18);
      const correctSupply = ethers.parseUnits('222222', 18);

      // Operator proposes wrong value
      await express.connect(operator).proposeOffchainShares(wrongSupply);

      // Operator re-proposes correct value (latest-wins overwrite)
      await express.connect(operator).proposeOffchainShares(correctSupply);
      expect(await express.proposedOffchainShares()).to.equal(correctSupply);

      // Confirmer echoes the correct value
      await express.connect(confirmer).confirmOffchainShares(correctSupply);
      expect(await express.proposedOffchainShares()).to.equal(0n);

      // updateEpoch now succeeds
      await expect(express.connect(operator).updateEpoch()).to.not.be.reverted;
    });
  });

  describe('pre-sync deposit (offchainShares == 0)', function () {
    it('second deposit after bootstrap succeeds at 1:1 fallback when offchainShares == 0', async function () {
      const { express, usdo, oem, user2 } = await loadFixture(deployWithBootstrapFixture);

      // totalSupply > 0 from bootstrap, offchainShares still 0
      // With the 1e18 fallback in _sharesPerToken(), deposit succeeds and user2 mints at 1:1.
      const depositAmt = ethers.parseUnits('2000', 18);
      await expect(
        express.connect(user2).requestDeposit(await usdo.getAddress(), depositAmt, user2.address)
      ).to.not.be.reverted;
    });

    it('requestDeposit at totalSupply == 0 (original bootstrap) also succeeds', async function () {
      const { express, usdo, user1 } = await loadFixture(deployFixture);

      const depositAmt = ethers.parseUnits('2000', 18);
      await expect(
        express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address)
      ).to.not.be.reverted;
    });

    it('previewDeposit returns a non-zero mint amount at the 1e18 fallback when offchainShares == 0', async function () {
      const { express, usdo } = await loadFixture(deployWithBootstrapFixture);

      const depositAmt = ethers.parseUnits('1000', 18);
      const [, , netMintAmt] = await express.previewDeposit(await usdo.getAddress(), depositAmt);
      expect(netMintAmt).to.be.gt(0n);
    });

    it('concurrent bootstrap deposits can be batched — no stuck queue', async function () {
      const { express, usdo, oem, user1, user2, maintainer } = await loadFixture(deployFixture);

      // Both users queue deposits during the pre-sync window
      const depositAmt = ethers.parseUnits('2000', 18);
      await express
        .connect(user1)
        .requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
      await express
        .connect(user2)
        .requestDeposit(await usdo.getAddress(), depositAmt, user2.address);
      expect(await express.getDepositQueueLength()).to.equal(2n);

      // Both mint successfully at 1:1 in a single batch — no guard blocks after first mint
      await expect(express.connect(maintainer).processDepositQueue(2)).to.not.be.reverted;

      expect(await oem.balanceOf(user1.address)).to.be.gt(0n);
      expect(await oem.balanceOf(user2.address)).to.be.gt(0n);
      expect(await express.getDepositQueueLength()).to.equal(0n);
    });
  });

  describe('setSnapshotRatio', function () {
    it('reverts InvalidInput when _ratio exceeds 1e18 (sanity cap)', async function () {
      const { express, maintainer } = await loadFixture(deployFixture);
      const aboveOne = ethers.parseUnits('2', 18); // 2e18 > 1e18

      await expect(express.connect(maintainer).setSnapshotRatio(ethers.ZeroHash, aboveOne))
        .to.be.revertedWithCustomError(express, 'InvalidInput')
        .withArgs(aboveOne);
    });

    it('reverts InvalidInput when _ratio is 0', async function () {
      const { express, maintainer } = await loadFixture(deployFixture);

      await expect(express.connect(maintainer).setSnapshotRatio(ethers.ZeroHash, 0))
        .to.be.revertedWithCustomError(express, 'InvalidInput')
        .withArgs(0n);
    });

    it('accepts a ratio of exactly 1e18', async function () {
      const { express, maintainer } = await loadFixture(deployFixture);

      await expect(
        express.connect(maintainer).setSnapshotRatio(ethers.ZeroHash, ethers.parseUnits('1', 18))
      )
        .to.emit(express, 'SetSnapshotRatio')
        .withArgs(ethers.ZeroHash, ethers.parseUnits('1', 18));
    });
  });
});
