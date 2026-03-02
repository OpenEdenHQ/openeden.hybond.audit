// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAssetRegistry
 * @notice Simple interface for managing supported underlying assets
 */
interface IAssetRegistry {
    struct AssetConfig {
        address asset;
        bool isSupported;
        address priceFeed; // Optional: IPriceFeed contract for price conversion (like TBILL)
        uint256 maxStalePeriod; // Maximum staleness period for this asset's price feed (in seconds)
    }

    /**
     * @notice Add or update an asset configuration
     * @param config The asset configuration
     */
    function setAssetConfig(AssetConfig calldata config) external;

    /**
     * @notice Remove an asset from supported assets
     * @param asset The asset address
     */
    function removeAsset(address asset) external;

    /**
     * @notice Get asset configuration
     * @param asset The asset address
     * @return config The asset configuration
     */
    function getAssetConfig(address asset) external view returns (AssetConfig memory config);

    /**
     * @notice Check if asset is supported
     * @param asset The asset address
     * @return supported True if asset is supported
     */
    function isAssetSupported(address asset) external view returns (bool supported);

    /**
     * @notice Convert asset amount to target token amount
     * @param _asset The asset address
     * @param _amount The asset amount
     * @return amount The equivalent target token amount
     */
    function convertFromUnderlying(address _asset, uint256 _amount) external view returns (uint256 amount);

    /**
     * @notice Convert target token amount to asset amount
     * @param _asset The asset address
     * @param _amount The target token amount
     * @return amount The equivalent asset amount
     */
    function convertToUnderlying(address _asset, uint256 _amount) external view returns (uint256 amount);

    /**
     * @notice Get list of all supported assets
     * @return assets Array of supported asset addresses
     */
    function getSupportedAssets() external view returns (address[] memory assets);

    // Events
    event AssetAdded(address indexed asset, AssetConfig config);
    event AssetUpdated(address indexed asset, AssetConfig config);
    event AssetRemoved(address indexed asset);
    event MaxStalePeriodUpdated(uint256 newStalePeriod);
}
