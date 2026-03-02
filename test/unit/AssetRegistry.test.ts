import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('AssetRegistry', function () {
  async function deployFixture() {
    const [admin, maintainer, user1] = await ethers.getSigners();

    // Deploy AssetRegistry
    const AssetRegistryFactory = await ethers.getContractFactory('AssetRegistry');
    const assetRegistry = await upgrades.deployProxy(AssetRegistryFactory, [admin.address], {
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
      admin,
      maintainer,
      user1,
      usdo,
      usdc,
      wbtc,
      exotic,
    };
  }

  describe('Deployment & Initialization', function () {
    it('should initialize with admin role', async function () {
      const { assetRegistry, admin } = await loadFixture(deployFixture);

      const DEFAULT_ADMIN_ROLE = await assetRegistry.DEFAULT_ADMIN_ROLE();
      expect(await assetRegistry.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it('should grant MAINTAINER_ROLE and UPGRADE_ROLE to admin', async function () {
      const { assetRegistry, admin } = await loadFixture(deployFixture);

      const MAINTAINER_ROLE = await assetRegistry.MAINTAINER_ROLE();
      const UPGRADE_ROLE = await assetRegistry.UPGRADE_ROLE();

      expect(await assetRegistry.hasRole(MAINTAINER_ROLE, admin.address)).to.be.true;
      expect(await assetRegistry.hasRole(UPGRADE_ROLE, admin.address)).to.be.true;
    });

    it('should revert re-initialization', async function () {
      const { assetRegistry, admin } = await loadFixture(deployFixture);

      await expect(assetRegistry.initialize(admin.address)).to.be.revertedWithCustomError(
        assetRegistry,
        'InvalidInitialization'
      );
    });
  });

  describe('Asset Configuration', function () {
    describe('Adding Assets', function () {
      it('should add asset without price feed (1:1 conversion)', async function () {
        const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        // First call should emit AssetAdded
        await expect(assetRegistry.connect(admin).setAssetConfig(config)).to.emit(
          assetRegistry,
          'AssetAdded'
        );

        // Subsequent calls should emit AssetUpdated (asset already exists)
        await expect(assetRegistry.connect(admin).setAssetConfig(config)).to.emit(
          assetRegistry,
          'AssetUpdated'
        );
        await expect(assetRegistry.connect(admin).setAssetConfig(config)).to.emit(
          assetRegistry,
          'AssetUpdated'
        );

        const storedConfig = await assetRegistry.getAssetConfig(await usdo.getAddress());
        expect(storedConfig.asset).to.equal(await usdo.getAddress());
        expect(storedConfig.isSupported).to.be.true;
      });

      it('should add asset with price feed', async function () {
        const { assetRegistry, admin, usdc } = await loadFixture(deployFixture);

        // Deploy mock price feed
        const MockPriceFeedFactory = await ethers.getContractFactory('MockERC20'); // Use any contract
        const priceFeed = await MockPriceFeedFactory.deploy('Feed', 'FEED', 8);
        await priceFeed.waitForDeployment();

        const config = {
          asset: await usdc.getAddress(),
          priceFeed: await priceFeed.getAddress(),
          maxStalePeriod: 3600, // 1 hour
          isSupported: true,
        };

        await expect(assetRegistry.connect(admin).setAssetConfig(config)).to.emit(
          assetRegistry,
          'AssetAdded'
        );

        expect(await assetRegistry.isAssetSupported(await usdc.getAddress())).to.be.true;
      });

      it('should track supported assets in array', async function () {
        const { assetRegistry, admin, usdo, usdc } = await loadFixture(deployFixture);

        const config1 = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        const config2 = {
          asset: await usdc.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(config1);
        await assetRegistry.connect(admin).setAssetConfig(config2);

        const supportedAssets = await assetRegistry.getSupportedAssets();
        expect(supportedAssets).to.have.length(2);
        expect(supportedAssets).to.include(await usdo.getAddress());
        expect(supportedAssets).to.include(await usdc.getAddress());
      });

      it('should revert if asset is zero address', async function () {
        const { assetRegistry, admin } = await loadFixture(deployFixture);

        const config = {
          asset: ethers.ZeroAddress,
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await expect(
          assetRegistry.connect(admin).setAssetConfig(config)
        ).to.be.revertedWithCustomError(assetRegistry, 'AssetRegistryZeroAddress');
      });

      it('should revert if price feed is set but maxStalePeriod is zero', async function () {
        const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: admin.address, // Non-zero price feed
          maxStalePeriod: 0, // Invalid: should be > 0 when price feed is set
          isSupported: true,
        };

        await expect(
          assetRegistry.connect(admin).setAssetConfig(config)
        ).to.be.revertedWithCustomError(assetRegistry, 'AssetRegistryInvalidStalePeriod');
      });

      it('should revert if asset uses more than 18 decimals', async function () {
        const { assetRegistry, admin, exotic } = await loadFixture(deployFixture);

        const config = {
          asset: await exotic.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await expect(
          assetRegistry.connect(admin).setAssetConfig(config)
        ).to.be.revertedWithCustomError(assetRegistry, 'AssetRegistryInvalidAssetDecimals');
      });

      it('should revert if isSupported is false for new asset', async function () {
        const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: false, // Should revert for new asset
        };

        await expect(
          assetRegistry.connect(admin).setAssetConfig(config)
        ).to.be.revertedWithCustomError(
          assetRegistry,
          'AssetRegistryUnsupportedAssetConfiguration'
        );
      });

      it('should only allow MAINTAINER_ROLE to add assets', async function () {
        const { assetRegistry, user1, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await expect(
          assetRegistry.connect(user1).setAssetConfig(config)
        ).to.be.revertedWithCustomError(assetRegistry, 'AccessControlUnauthorizedAccount');
      });
    });

    describe('Updating Assets', function () {
      it('should update existing asset configuration', async function () {
        const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

        const initialConfig = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(initialConfig);

        // Deploy price feed
        const MockERC20Factory = await ethers.getContractFactory('MockERC20');
        const priceFeed = await MockERC20Factory.deploy('Feed', 'FEED', 8);
        await priceFeed.waitForDeployment();

        const updatedConfig = {
          asset: await usdo.getAddress(),
          priceFeed: await priceFeed.getAddress(),
          maxStalePeriod: 7200, // 2 hours
          isSupported: true,
        };

        await expect(assetRegistry.connect(admin).setAssetConfig(updatedConfig))
          .to.emit(assetRegistry, 'AssetUpdated')
          .withArgs(await usdo.getAddress(), [
            await usdo.getAddress(),
            updatedConfig.isSupported,
            await priceFeed.getAddress(),
            updatedConfig.maxStalePeriod,
          ]);

        const storedConfig = await assetRegistry.getAssetConfig(await usdo.getAddress());
        expect(storedConfig.priceFeed).to.equal(await priceFeed.getAddress());
        expect(storedConfig.maxStalePeriod).to.equal(7200);
      });

      it('should not duplicate asset in supported array when updating', async function () {
        const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(config);
        await assetRegistry.connect(admin).setAssetConfig(config);

        const supportedAssets = await assetRegistry.getSupportedAssets();
        expect(supportedAssets).to.have.length(1);
      });
    });

    describe('Removing Assets', function () {
      it('should remove asset from registry', async function () {
        const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(config);

        await expect(assetRegistry.connect(admin).removeAsset(await usdo.getAddress()))
          .to.emit(assetRegistry, 'AssetRemoved')
          .withArgs(await usdo.getAddress());

        expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.false;

        const supportedAssets = await assetRegistry.getSupportedAssets();
        expect(supportedAssets).to.not.include(await usdo.getAddress());
      });

      it('should revert if removing non-existent asset', async function () {
        const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

        await expect(
          assetRegistry.connect(admin).removeAsset(await usdo.getAddress())
        ).to.be.revertedWithCustomError(assetRegistry, 'AssetRegistryAssetNotSupported');
      });

      it('should properly reorder array when removing middle asset', async function () {
        const { assetRegistry, admin, usdo, usdc, wbtc } = await loadFixture(deployFixture);

        // Add three assets
        const configs = [
          {
            asset: await usdo.getAddress(),
            priceFeed: ethers.ZeroAddress,
            maxStalePeriod: 0,
            isSupported: true,
          },
          {
            asset: await usdc.getAddress(),
            priceFeed: ethers.ZeroAddress,
            maxStalePeriod: 0,
            isSupported: true,
          },
          {
            asset: await wbtc.getAddress(),
            priceFeed: ethers.ZeroAddress,
            maxStalePeriod: 0,
            isSupported: true,
          },
        ];

        for (const config of configs) {
          await assetRegistry.connect(admin).setAssetConfig(config);
        }

        // Remove middle asset
        await assetRegistry.connect(admin).removeAsset(await usdc.getAddress());

        const supportedAssets = await assetRegistry.getSupportedAssets();
        expect(supportedAssets).to.have.length(2);
        expect(supportedAssets).to.include(await usdo.getAddress());
        expect(supportedAssets).to.include(await wbtc.getAddress());
        expect(supportedAssets).to.not.include(await usdc.getAddress());
      });

      it('should only allow MAINTAINER_ROLE to remove assets', async function () {
        const { assetRegistry, admin, user1, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(config);

        await expect(
          assetRegistry.connect(user1).removeAsset(await usdo.getAddress())
        ).to.be.revertedWithCustomError(assetRegistry, 'AccessControlUnauthorizedAccount');
      });
    });
  });

  describe('Conversion Functions', function () {
    describe('Without Price Feed (1:1)', function () {
      it('should convert 18-decimal asset to USDO (1:1)', async function () {
        const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(config);

        const amount = ethers.parseUnits('1000', 18);
        const converted = await assetRegistry.convertFromUnderlying(
          await usdo.getAddress(),
          amount
        );

        expect(converted).to.equal(amount); // 1:1
      });

      it('should scale 6-decimal asset (USDC) to 18-decimal USDO', async function () {
        const { assetRegistry, admin, usdc } = await loadFixture(deployFixture);

        const config = {
          asset: await usdc.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(config);

        const amount = ethers.parseUnits('1000', 6); // 1000 USDC
        const converted = await assetRegistry.convertFromUnderlying(
          await usdc.getAddress(),
          amount
        );

        expect(converted).to.equal(ethers.parseUnits('1000', 18)); // Scaled to 18 decimals
      });

      it('should scale 8-decimal asset (WBTC) to 18-decimal USDO', async function () {
        const { assetRegistry, admin, wbtc } = await loadFixture(deployFixture);

        const config = {
          asset: await wbtc.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(config);

        const amount = ethers.parseUnits('10', 8); // 10 WBTC
        const converted = await assetRegistry.convertFromUnderlying(
          await wbtc.getAddress(),
          amount
        );

        expect(converted).to.equal(ethers.parseUnits('10', 18)); // Scaled to 18 decimals
      });

      it('should convert USDO to underlying asset (reverse)', async function () {
        const { assetRegistry, admin, usdc } = await loadFixture(deployFixture);

        const config = {
          asset: await usdc.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(config);

        const usdoAmount = ethers.parseUnits('1000', 18);
        const converted = await assetRegistry.convertToUnderlying(
          await usdc.getAddress(),
          usdoAmount
        );

        expect(converted).to.equal(ethers.parseUnits('1000', 6)); // Scaled to 6 decimals
      });

      it('should handle dust amounts correctly', async function () {
        const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(config);

        const dustAmount = 1n; // 1 wei
        const converted = await assetRegistry.convertFromUnderlying(
          await usdo.getAddress(),
          dustAmount
        );

        expect(converted).to.equal(dustAmount);
      });

      it('should handle very large amounts', async function () {
        const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(config);

        const largeAmount = ethers.parseUnits('1000000000', 18); // 1 billion
        const converted = await assetRegistry.convertFromUnderlying(
          await usdo.getAddress(),
          largeAmount
        );

        expect(converted).to.equal(largeAmount);
      });

      it('should handle zero amount', async function () {
        const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

        const config = {
          asset: await usdo.getAddress(),
          priceFeed: ethers.ZeroAddress,
          maxStalePeriod: 0,
          isSupported: true,
        };

        await assetRegistry.connect(admin).setAssetConfig(config);

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
      const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

      const config = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
      };

      await assetRegistry.connect(admin).setAssetConfig(config);

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
      const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

      expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.false;

      const config = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
      };

      await assetRegistry.connect(admin).setAssetConfig(config);

      expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.true;
    });

    it('should return all supported assets', async function () {
      const { assetRegistry, admin, usdo, usdc } = await loadFixture(deployFixture);

      expect(await assetRegistry.getSupportedAssets()).to.have.length(0);

      const config1 = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
      };

      const config2 = {
        asset: await usdc.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
      };

      await assetRegistry.connect(admin).setAssetConfig(config1);
      await assetRegistry.connect(admin).setAssetConfig(config2);

      const assets = await assetRegistry.getSupportedAssets();
      expect(assets).to.have.length(2);
      expect(assets).to.include(await usdo.getAddress());
      expect(assets).to.include(await usdc.getAddress());
    });
  });

  describe('Upgradeability', function () {
    it('should allow UPGRADE_ROLE to upgrade', async function () {
      const { assetRegistry, admin } = await loadFixture(deployFixture);

      const AssetRegistryV2Factory = await ethers.getContractFactory('AssetRegistry');

      await expect(upgrades.upgradeProxy(await assetRegistry.getAddress(), AssetRegistryV2Factory))
        .to.not.be.reverted;
    });

    it('should preserve state after upgrade', async function () {
      const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

      const config = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
      };

      await assetRegistry.connect(admin).setAssetConfig(config);

      const AssetRegistryV2Factory = await ethers.getContractFactory('AssetRegistry');
      const upgraded = await upgrades.upgradeProxy(
        await assetRegistry.getAddress(),
        AssetRegistryV2Factory
      );

      expect(await upgraded.isAssetSupported(await usdo.getAddress())).to.be.true;
    });

    it('should revert if non-UPGRADE_ROLE tries to upgrade', async function () {
      const { assetRegistry, user1 } = await loadFixture(deployFixture);

      const AssetRegistryV2Factory = await ethers.getContractFactory('AssetRegistry');
      const newImpl = await AssetRegistryV2Factory.deploy();
      await newImpl.waitForDeployment();

      await expect(
        assetRegistry.connect(user1).upgradeToAndCall(await newImpl.getAddress(), '0x')
      ).to.be.revertedWithCustomError(assetRegistry, 'AccessControlUnauthorizedAccount');
    });
  });

  describe('Edge Cases', function () {
    it('should handle adding and removing same asset multiple times', async function () {
      const { assetRegistry, admin, usdo } = await loadFixture(deployFixture);

      const config = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
      };

      // Add
      await assetRegistry.connect(admin).setAssetConfig(config);
      expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.true;

      // Remove
      await assetRegistry.connect(admin).removeAsset(await usdo.getAddress());
      expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.false;

      // Add again
      await assetRegistry.connect(admin).setAssetConfig(config);
      expect(await assetRegistry.isAssetSupported(await usdo.getAddress())).to.be.true;
    });

    it('should handle maximum supported assets', async function () {
      const { assetRegistry, admin } = await loadFixture(deployFixture);

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
        };

        await assetRegistry.connect(admin).setAssetConfig(config);
      }

      const supportedAssets = await assetRegistry.getSupportedAssets();
      expect(supportedAssets).to.have.length(20);
    });
  });

  describe('Access Control', function () {
    it('should enforce MAINTAINER_ROLE for configuration changes', async function () {
      const { assetRegistry, user1, usdo } = await loadFixture(deployFixture);

      const config = {
        asset: await usdo.getAddress(),
        priceFeed: ethers.ZeroAddress,
        maxStalePeriod: 0,
        isSupported: true,
      };

      const MAINTAINER_ROLE = await assetRegistry.MAINTAINER_ROLE();

      await expect(
        assetRegistry.connect(user1).setAssetConfig(config)
      ).to.be.revertedWithCustomError(assetRegistry, 'AccessControlUnauthorizedAccount');
    });

    it('should allow DEFAULT_ADMIN_ROLE to grant MAINTAINER_ROLE', async function () {
      const { assetRegistry, admin, user1 } = await loadFixture(deployFixture);

      const MAINTAINER_ROLE = await assetRegistry.MAINTAINER_ROLE();

      await assetRegistry.connect(admin).grantRole(MAINTAINER_ROLE, user1.address);

      expect(await assetRegistry.hasRole(MAINTAINER_ROLE, user1.address)).to.be.true;
    });
  });
});
