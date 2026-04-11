import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('AssetRegistry', function () {
  async function deployFixture() {
    const [deployer, newOwner, user1] = await ethers.getSigners();

    // Deploy AssetRegistry
    const AssetRegistryFactory = await ethers.getContractFactory('AssetRegistry');
    const assetRegistry = await upgrades.deployProxy(AssetRegistryFactory, [deployer.address], {
      kind: 'uups',
      initializer: 'initialize',
    });
    await assetRegistry.waitForDeployment();

    // Deploy mock ERC20 tokens with different decimals
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const usdo = await MockERC20Factory.deploy('USDO', 'USDO', 18);
    await usdo.waitForDeployment();

    const usdc = await MockERC20Factory.deploy('USDC', 'USDC', 6);
    await usdc.waitForDeployment();

    const wbtc = await MockERC20Factory.deploy('WBTC', 'WBTC', 8);
    await wbtc.waitForDeployment();

    const exotic = await MockERC20Factory.deploy('EXOTIC', 'EXO', 19);
    await exotic.waitForDeployment();

    return {
      assetRegistry,
      deployer,
      newOwner,
      user1,
      usdo,
      usdc,
      wbtc,
      exotic,
    };
  }

  describe('Deployment & Initialization', function () {
    it('should initialize with deployer as owner', async function () {
      const { assetRegistry, deployer } = await loadFixture(deployFixture);

      expect(await assetRegistry.owner()).to.equal(deployer.address);
    });

    it('should revert re-initialization', async function () {
      const { assetRegistry, deployer } = await loadFixture(deployFixture);

      await expect(assetRegistry.initialize(deployer.address)).to.be.revertedWithCustomError(
        assetRegistry,
        'InvalidInitialization'
      );
    });
  });

  describe('Ownership', function () {
    it('should support two-step ownership transfer', async function () {
      const { assetRegistry, deployer, newOwner } = await loadFixture(deployFixture);

      await assetRegistry.connect(deployer).transferOwnership(newOwner.address);
      expect(await assetRegistry.owner()).to.equal(deployer.address);
      expect(await assetRegistry.pendingOwner()).to.equal(newOwner.address);

      await assetRegistry.connect(newOwner).acceptOwnership();
      expect(await assetRegistry.owner()).to.equal(newOwner.address);
    });

    it('should not allow non-pending owner to accept ownership', async function () {
      const { assetRegistry, deployer, newOwner, user1 } = await loadFixture(deployFixture);

      await assetRegistry.connect(deployer).transferOwnership(newOwner.address);

      await expect(assetRegistry.connect(user1).acceptOwnership()).to.be.revertedWithCustomError(
        assetRegistry,
        'OwnableUnauthorizedAccount'
      );
    });

    it('should not allow non-owner to transfer ownership', async function () {
      const { assetRegistry, user1, newOwner } = await loadFixture(deployFixture);

      await expect(
        assetRegistry.connect(user1).transferOwnership(newOwner.address)
      ).to.be.revertedWithCustomError(assetRegistry, 'OwnableUnauthorizedAccount');
    });

    it('should allow owner to renounce ownership', async function () {
      const { assetRegistry, deployer } = await loadFixture(deployFixture);

      await assetRegistry.connect(deployer).renounceOwnership();
      expect(await assetRegistry.owner()).to.equal(ethers.ZeroAddress);
    });
  });

  describe('Asset Configuration', function () {
    describe('Adding Assets', function () {
      it('should add asset without price feed (1:1 conversion)', async function () {
        const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        // First call should emit AssetAdded
        await expect(assetRegistry.connect(deployer).setAssetConfig(config)).to.emit(
          assetRegistry,
          'AssetAdded'
        );

        // Subsequent calls should emit AssetUpdated (asset already exists)
        await expect(assetRegistry.connect(deployer).setAssetConfig(config)).to.emit(
          assetRegistry,
          'AssetUpdated'
        );
        await expect(assetRegistry.connect(deployer).setAssetConfig(config)).to.emit(
          assetRegistry,
          'AssetUpdated'
        );

        const storedConfig = await assetRegistry.getAssetConfig(await usdo.getAddress());
        expect(storedConfig.asset).to.equal(await usdo.getAddress());
        expect(storedConfig.isSupported).to.be.true;
      });

      it('should add asset with price feed', async function () {
        const { assetRegistry, deployer, usdc } = await loadFixture(deployFixture);

        // Deploy mock price feed
        const MockPriceFeedFactory = await ethers.getContractFactory('MockERC20');
        const priceFeed = await MockPriceFeedFactory.deploy('Feed', 'FEED', 8);
        await priceFeed.waitForDeployment();

        const config = {
          asset: await usdc.getAddress(),
          priceFeed: await priceFeed.getAddress(),
          maxStalePeriod: 3600, // 1 hour
          isSupported: true,
          isRedeemable: true,
        };

        await expect(assetRegistry.connect(deployer).setAssetConfig(config)).to.emit(
          assetRegistry,
          'AssetAdded'
        );

        expect(await assetRegistry.isAssetSupported(await usdc.getAddress())).to.be.true;
      });

      it('should track supported assets in array', async function () {
        const { assetRegistry, deployer, usdo, usdc } = await loadFixture(deployFixture);

        const config1 = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        const config2 = {
          asset: await usdc.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config1);
        await assetRegistry.connect(deployer).setAssetConfig(config2);

        const supportedAssets = await assetRegistry.getSupportedAssets();
        expect(supportedAssets).to.have.length(2);
        expect(supportedAssets).to.include(await usdo.getAddress());
        expect(supportedAssets).to.include(await usdc.getAddress());
      });

      it('should revert if asset is zero address', async function () {
        const { assetRegistry, deployer } = await loadFixture(deployFixture);

        const config = {
          asset: ethers.ZeroAddress,
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await expect(
          assetRegistry.connect(deployer).setAssetConfig(config)
        ).to.be.revertedWithCustomError(assetRegistry, 'AssetRegistryZeroAddress');
      });

      it('should revert if price feed is set but maxStalePeriod is zero', async function () {
        const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: deployer.address, // Non-zero price feed
          maxStalePeriod: 0, // Invalid: should be > 0 when price feed is set
          isSupported: true,
          isRedeemable: true,
        };

        await expect(
          assetRegistry.connect(deployer).setAssetConfig(config)
        ).to.be.revertedWithCustomError(assetRegistry, 'AssetRegistryInvalidStalePeriod');
      });

      it('should revert if asset uses more than 18 decimals', async function () {
        const { assetRegistry, deployer, exotic } = await loadFixture(deployFixture);

        const config = {
          asset: await exotic.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await expect(
          assetRegistry.connect(deployer).setAssetConfig(config)
        ).to.be.revertedWithCustomError(assetRegistry, 'AssetRegistryInvalidAssetDecimals');
      });

      it('should revert if isSupported is false for new asset', async function () {
        const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: false,
          isRedeemable: true,
        };

        await expect(
          assetRegistry.connect(deployer).setAssetConfig(config)
        ).to.be.revertedWithCustomError(
          assetRegistry,
          'AssetRegistryUnsupportedAssetConfiguration'
        );
      });

      it('should only allow owner to add assets', async function () {
        const { assetRegistry, user1, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await expect(
          assetRegistry.connect(user1).setAssetConfig(config)
        ).to.be.revertedWithCustomError(assetRegistry, 'OwnableUnauthorizedAccount');
      });
    });

    describe('Updating Assets', function () {
      it('should update existing asset configuration', async function () {
        const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

        const initialConfig = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(initialConfig);

        // Deploy price feed
        const MockERC20Factory = await ethers.getContractFactory('MockERC20');
        const priceFeed = await MockERC20Factory.deploy('Feed', 'FEED', 8);
        await priceFeed.waitForDeployment();

        const updatedConfig = {
          asset: await usdo.getAddress(),
          priceFeed: await priceFeed.getAddress(),
          maxStalePeriod: 7200, // 2 hours
          isSupported: true,
          isRedeemable: true,
        };

        await expect(assetRegistry.connect(deployer).setAssetConfig(updatedConfig))
          .to.emit(assetRegistry, 'AssetUpdated')
          .withArgs(await usdo.getAddress(), [
            await usdo.getAddress(),
            updatedConfig.isSupported,
            updatedConfig.isRedeemable,
            await priceFeed.getAddress(),
            updatedConfig.maxStalePeriod,
          ]);

        const storedConfig = await assetRegistry.getAssetConfig(await usdo.getAddress());
        expect(storedConfig.priceFeed).to.equal(await priceFeed.getAddress());
        expect(storedConfig.maxStalePeriod).to.equal(7200);
      });

      it('should not duplicate asset in supported array when updating', async function () {
        const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config);
        await assetRegistry.connect(deployer).setAssetConfig(config);

        const supportedAssets = await assetRegistry.getSupportedAssets();
        expect(supportedAssets).to.have.length(1);
      });
    });

    describe('Removing Assets', function () {
      it('should remove asset from registry', async function () {
        const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config);

        await expect(assetRegistry.connect(deployer).removeAsset(await usdo.getAddress()))
          .to.emit(assetRegistry, 'AssetRemoved')
          .withArgs(await usdo.getAddress());

        expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.false;

        const supportedAssets = await assetRegistry.getSupportedAssets();
        expect(supportedAssets).to.not.include(await usdo.getAddress());
      });

      it('should revert if removing non-existent asset', async function () {
        const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

        await expect(
          assetRegistry.connect(deployer).removeAsset(await usdo.getAddress())
        ).to.be.revertedWithCustomError(assetRegistry, 'AssetRegistryAssetNotSupported');
      });

      it('should properly reorder array when removing middle asset', async function () {
        const { assetRegistry, deployer, usdo, usdc, wbtc } = await loadFixture(deployFixture);

        // Add three assets
        const configs = [
          {
            asset: await usdo.getAddress(),
            priceFeed: ethers.ZeroAddress,
            maxStalePeriod: 0,
            isSupported: true,
            isRedeemable: true,
          },
          {
            asset: await usdc.getAddress(),
            priceFeed: ethers.ZeroAddress,
            maxStalePeriod: 0,
            isSupported: true,
            isRedeemable: true,
          },
          {
            asset: await wbtc.getAddress(),
            priceFeed: ethers.ZeroAddress,
            maxStalePeriod: 0,
            isSupported: true,
            isRedeemable: true,
          },
        ];

        for (const config of configs) {
          await assetRegistry.connect(deployer).setAssetConfig(config);
        }

        // Remove middle asset
        await assetRegistry.connect(deployer).removeAsset(await usdc.getAddress());

        const supportedAssets = await assetRegistry.getSupportedAssets();
        expect(supportedAssets).to.have.length(2);
        expect(supportedAssets).to.include(await usdo.getAddress());
        expect(supportedAssets).to.include(await wbtc.getAddress());
        expect(supportedAssets).to.not.include(await usdc.getAddress());
      });

      it('should only allow owner to remove assets', async function () {
        const { assetRegistry, deployer, user1, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config);

        await expect(
          assetRegistry.connect(user1).removeAsset(await usdo.getAddress())
        ).to.be.revertedWithCustomError(assetRegistry, 'OwnableUnauthorizedAccount');
      });
    });
  });

  describe('Conversion Functions', function () {
    describe('Without Price Feed (1:1)', function () {
      it('should convert 18-decimal asset to USDO (1:1)', async function () {
        const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config);

        const amount = ethers.parseUnits('1000', 18);
        const converted = await assetRegistry.convertFromUnderlying(
          await usdo.getAddress(),
          amount
        );

        expect(converted).to.equal(amount); // 1:1
      });

      it('should scale 6-decimal asset (USDC) to 18-decimal USDO', async function () {
        const { assetRegistry, deployer, usdc } = await loadFixture(deployFixture);

        const config = {
          asset: await usdc.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config);

        const amount = ethers.parseUnits('1000', 6); // 1000 USDC
        const converted = await assetRegistry.convertFromUnderlying(
          await usdc.getAddress(),
          amount
        );

        expect(converted).to.equal(ethers.parseUnits('1000', 18)); // Scaled to 18 decimals
      });

      it('should scale 8-decimal asset (WBTC) to 18-decimal USDO', async function () {
        const { assetRegistry, deployer, wbtc } = await loadFixture(deployFixture);

        const config = {
          asset: await wbtc.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config);

        const amount = ethers.parseUnits('10', 8); // 10 WBTC
        const converted = await assetRegistry.convertFromUnderlying(
          await wbtc.getAddress(),
          amount
        );

        expect(converted).to.equal(ethers.parseUnits('10', 18)); // Scaled to 18 decimals
      });

      it('should convert USDO to underlying asset (reverse)', async function () {
        const { assetRegistry, deployer, usdc } = await loadFixture(deployFixture);

        const config = {
          asset: await usdc.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config);

        const usdoAmount = ethers.parseUnits('1000', 18);
        const converted = await assetRegistry.convertToUnderlying(
          await usdc.getAddress(),
          usdoAmount
        );

        expect(converted).to.equal(ethers.parseUnits('1000', 6)); // Scaled to 6 decimals
      });

      it('should handle dust amounts correctly', async function () {
        const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config);

        const dustAmount = 1n; // 1 wei
        const converted = await assetRegistry.convertFromUnderlying(
          await usdo.getAddress(),
          dustAmount
        );

        expect(converted).to.equal(dustAmount);
      });

      it('should handle very large amounts', async function () {
        const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config);

        const largeAmount = ethers.parseUnits('1000000000', 18); // 1 billion
        const converted = await assetRegistry.convertFromUnderlying(
          await usdo.getAddress(),
          largeAmount
        );

        expect(converted).to.equal(largeAmount);
      });

      it('should handle zero amount', async function () {
        const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config);

        const converted = await assetRegistry.convertFromUnderlying(await usdo.getAddress(), 0);

        expect(converted).to.equal(0);
      });
    });

    describe('Error Handling', function () {
      it('should revert if asset not supported', async function () {
        const { assetRegistry, usdo } = await loadFixture(deployFixture);

        const amount = ethers.parseUnits('1000', 18);

        await expect(
          assetRegistry.convertFromUnderlying(await usdo.getAddress(), amount)
        ).to.be.revertedWithCustomError(assetRegistry, 'AssetRegistryAssetNotSupported');
      });

      it('should revert convertToUnderlying if asset not supported', async function () {
        const { assetRegistry, usdo } = await loadFixture(deployFixture);

        const amount = ethers.parseUnits('1000', 18);

        await expect(
          assetRegistry.convertToUnderlying(await usdo.getAddress(), amount)
        ).to.be.revertedWithCustomError(assetRegistry, 'AssetRegistryAssetNotSupported');
      });
    });
  });

  describe('View Functions', function () {
    it('should return asset configuration', async function () {
      const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

      const config = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
        isRedeemable: true,
      };

      await assetRegistry.connect(deployer).setAssetConfig(config);

      const storedConfig = await assetRegistry.getAssetConfig(await usdo.getAddress());
      expect(storedConfig.asset).to.equal(config.asset);
      expect(storedConfig.priceFeed).to.equal(config.priceFeed);
      expect(storedConfig.maxStalePeriod).to.equal(config.maxStalePeriod);
      expect(storedConfig.isSupported).to.equal(config.isSupported);
    });

    it('should return empty config for non-existent asset', async function () {
      const { assetRegistry, usdo } = await loadFixture(deployFixture);

      const config = await assetRegistry.getAssetConfig(await usdo.getAddress());
      expect(config.asset).to.equal(ethers.ZeroAddress);
      expect(config.isSupported).to.be.false;
    });

    it('should return supported status correctly', async function () {
      const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

      expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.false;

      const config = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
        isRedeemable: true,
      };

      await assetRegistry.connect(deployer).setAssetConfig(config);

      expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.true;
    });

    it('should return all supported assets', async function () {
      const { assetRegistry, deployer, usdo, usdc } = await loadFixture(deployFixture);

      expect(await assetRegistry.getSupportedAssets()).to.have.length(0);

      const config1 = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
        isRedeemable: true,
      };

      const config2 = {
        asset: await usdc.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
        isRedeemable: true,
      };

      await assetRegistry.connect(deployer).setAssetConfig(config1);
      await assetRegistry.connect(deployer).setAssetConfig(config2);

      const assets = await assetRegistry.getSupportedAssets();
      expect(assets).to.have.length(2);
      expect(assets).to.include(await usdo.getAddress());
      expect(assets).to.include(await usdc.getAddress());
    });
  });

  describe('Upgradeability', function () {
    it('should allow owner to upgrade', async function () {
      const { assetRegistry } = await loadFixture(deployFixture);

      const AssetRegistryV2Factory = await ethers.getContractFactory('AssetRegistry');

      await expect(upgrades.upgradeProxy(await assetRegistry.getAddress(), AssetRegistryV2Factory))
        .to.not.be.reverted;
    });

    it('should preserve state after upgrade', async function () {
      const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

      const config = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
        isRedeemable: true,
      };

      await assetRegistry.connect(deployer).setAssetConfig(config);

      const AssetRegistryV2Factory = await ethers.getContractFactory('AssetRegistry');
      const upgraded = await upgrades.upgradeProxy(
        await assetRegistry.getAddress(),
        AssetRegistryV2Factory
      );

      expect(await upgraded.isAssetSupported(await usdo.getAddress())).to.be.true;
    });

    it('should revert if non-owner tries to upgrade', async function () {
      const { assetRegistry, user1 } = await loadFixture(deployFixture);

      const AssetRegistryV2Factory = await ethers.getContractFactory('AssetRegistry');
      const newImpl = await AssetRegistryV2Factory.deploy();
      await newImpl.waitForDeployment();

      await expect(
        assetRegistry.connect(user1).upgradeToAndCall(await newImpl.getAddress(), '0x')
      ).to.be.revertedWithCustomError(assetRegistry, 'OwnableUnauthorizedAccount');
    });
  });

  describe('Edge Cases', function () {
    it('should handle adding and removing same asset multiple times', async function () {
      const { assetRegistry, deployer, usdo } = await loadFixture(deployFixture);

      const config = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
        isRedeemable: true,
      };

      // Add
      await assetRegistry.connect(deployer).setAssetConfig(config);
      expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.true;

      // Remove
      await assetRegistry.connect(deployer).removeAsset(await usdo.getAddress());
      expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.false;

      // Add again
      await assetRegistry.connect(deployer).setAssetConfig(config);
      expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.true;
    });

    it('should handle maximum supported assets', async function () {
      const { assetRegistry, deployer } = await loadFixture(deployFixture);

      const MockERC20Factory = await ethers.getContractFactory('MockERC20');

      // Add 20 assets
      for (let i = 0; i < 20; i++) {
        const token = await MockERC20Factory.deploy(`Token${i}`, `TKN${i}`, 18);
        await token.waitForDeployment();

        const config = {
          asset: await token.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
          isRedeemable: true,
        };

        await assetRegistry.connect(deployer).setAssetConfig(config);
      }

      const supportedAssets = await assetRegistry.getSupportedAssets();
      expect(supportedAssets).to.have.length(20);
    });
  });

  describe('Access Control', function () {
    it('should enforce owner-only for configuration changes', async function () {
      const { assetRegistry, user1, usdo } = await loadFixture(deployFixture);

      const config = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
        isRedeemable: true,
      };

      await expect(
        assetRegistry.connect(user1).setAssetConfig(config)
      ).to.be.revertedWithCustomError(assetRegistry, 'OwnableUnauthorizedAccount');
    });

    it('should allow new owner to manage assets after ownership transfer', async function () {
      const { assetRegistry, deployer, newOwner, usdo } = await loadFixture(deployFixture);

      // Transfer ownership
      await assetRegistry.connect(deployer).transferOwnership(newOwner.address);
      await assetRegistry.connect(newOwner).acceptOwnership();

      const config = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
        isRedeemable: true,
      };

      await expect(assetRegistry.connect(newOwner).setAssetConfig(config)).to.emit(
        assetRegistry,
        'AssetAdded'
      );

      // Old owner should no longer have access
      await expect(
        assetRegistry.connect(deployer).removeAsset(await usdo.getAddress())
      ).to.be.revertedWithCustomError(assetRegistry, 'OwnableUnauthorizedAccount');
    });
  });
});
