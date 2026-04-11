// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import "../interfaces/IAssetRegistry.sol";
import "../interfaces/IPriceFeed.sol";

/// @dev Deployed library for Express view/conversion helpers to reduce Express contract size.
library ExpressLib {
    error InvalidPrice(int256 price);
    error StalePriceData(uint256 updatedAt, uint256 currentTime, uint256 maxStalePeriod);
    error IncompleteRound(uint80 answeredInRound, uint80 roundId);

    function getPrice(IPriceFeed priceOracle, uint256 maxStalePeriod) external view returns (uint256 price) {
        if (address(priceOracle) == address(0)) {
            return 1e18;
        }

        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = priceOracle.latestRoundData();

        if (answer <= 0) revert InvalidPrice(answer);

        if (maxStalePeriod > 0 && block.timestamp - updatedAt > maxStalePeriod) {
            revert StalePriceData(updatedAt, block.timestamp, maxStalePeriod);
        }

        if (answeredInRound < roundId) {
            revert IncompleteRound(answeredInRound, roundId);
        }

        uint8 decimals = priceOracle.decimals();
        price = uint256(answer);

        if (decimals < 18) {
            price = price * 10 ** (18 - decimals);
        } else if (decimals > 18) {
            price = price / 10 ** (decimals - 18);
        }
    }

    function redeemAssetAmount(
        uint256 _shareAmount,
        uint256 _ratio,
        uint256 _price,
        address _redeemAsset,
        IAssetRegistry assetRegistry,
        uint8 trimDecimals
    ) external view returns (uint256 redeemAssetAmt) {
        uint256 backedShareAmount = Math.mulDiv(_shareAmount, _ratio, 1e18);
        uint256 underlyingAmt = assetRegistry.convertToUnderlying(_redeemAsset, backedShareAmount);
        redeemAssetAmt = _trimAsset(Math.mulDiv(underlyingAmt, _price, 1e18), _redeemAsset, trimDecimals);
    }

    function calculateMintAmount(
        address _asset,
        uint256 _netAssets,
        IAssetRegistry assetRegistry,
        uint256 price,
        uint256 sharesPerTokenRatio,
        uint8 trimDecimals
    ) external view returns (uint256 mintAmount) {
        uint256 amount = assetRegistry.convertFromUnderlying(_asset, _netAssets);
        uint256 tokenPrice = Math.mulDiv(price, sharesPerTokenRatio, 1e18);
        mintAmount = _trim(Math.mulDiv(amount, 1e18, tokenPrice), trimDecimals);
    }

    function sharesPerToken(
        address tokenAddr,
        uint256 totalRedeemQueueShares,
        uint256 totalMgtFeeMinted
    ) external view returns (uint256 ratio) {
        uint256 totalSupply = IERC20(tokenAddr).totalSupply();
        if (totalSupply == 0) return 1e18;
        uint256 effectiveTotal = totalSupply - totalRedeemQueueShares;
        if (effectiveTotal == 0) return 1e18;
        ratio = Math.mulDiv(effectiveTotal - totalMgtFeeMinted, 1e18, effectiveTotal);
    }

    function calculateDailyMgtFee(
        uint256 _circulatingSupply,
        uint256 mgtFeeRate,
        uint8 trimDecimals
    ) external pure returns (uint256 fee) {
        fee = _trim(Math.mulDiv(_circulatingSupply, mgtFeeRate, 365 * 1e4), trimDecimals);
    }

    function _trim(uint256 _value, uint8 _trimDecimals) internal pure returns (uint256) {
        if (_trimDecimals == 0 || _trimDecimals >= 18) return _value;
        uint256 factor = 10 ** (18 - _trimDecimals);
        return (_value / factor) * factor;
    }

    function _trimAsset(uint256 _value, address _asset, uint8 _trimDecimals) internal view returns (uint256) {
        uint8 assetDecimals = IERC20Metadata(_asset).decimals();
        if (_trimDecimals == 0 || _trimDecimals >= assetDecimals) return _value;
        uint256 factor = 10 ** (assetDecimals - _trimDecimals);
        return (_value / factor) * factor;
    }
}
