// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct DepositRedeemLimiterCfg {
    uint256 depositMinimum;
    uint256 redeemMinimum;
    uint256 firstDepositAmount;
}

/**
 * @title DepositRedeemLimiter
 * @notice contract implementing minimum thresholds for depositing and redeeming.
 */
abstract contract DepositRedeemLimiter {
    uint256 public depositMinimum;
    uint256 public redeemMinimum;
    uint256 public firstDepositAmount;

    event DepositMinimumUpdated(uint256 newMinimum);
    event RedeemMinimumUpdated(uint256 newMinimum);
    event FirstDepositAmount(uint256 amount);
    error DepositLessThanMinimum(uint256 amount, uint256 minimum);
    error RedeemLessThanMinimum(uint256 amount, uint256 minimum);

    /**
     * @notice Initializes deposit and redeem minimums.
     * @param _depositMinimum    Min amount allowed to deposit in one transaction (in token decimals - 18)
     * @param _redeemMinimum  Min amount allowed to redeem in one transaction (in token decimals - 18)
     * @param _firstDepositAmount The first deposit amount (in token decimals - 18)
     */

    function __DepositRedeemLimiter_init(
        uint256 _depositMinimum,
        uint256 _redeemMinimum,
        uint256 _firstDepositAmount
    ) internal {
        depositMinimum = _depositMinimum;
        redeemMinimum = _redeemMinimum;
        firstDepositAmount = _firstDepositAmount;
    }

    /*//////////////////////////////////////////////////////////////
                          Deposit Functions
    //////////////////////////////////////////////////////////////*/
    /**
     * @dev Updates the deposit minimum.
     * @dev Amount should be in token decimals (18) for accurate comparison across different underlying assets
     * @param _depositMinimum New deposit minimum in token equivalent.
     */
    function _setDepositMinimum(uint256 _depositMinimum) internal {
        depositMinimum = _depositMinimum;
        emit DepositMinimumUpdated(_depositMinimum);
    }

    /**
     * @dev Updates the redeem minimum.
     * @param _redeemMinimum New redeem minimum.
     */
    function _setRedeemMinimum(uint256 _redeemMinimum) internal {
        redeemMinimum = _redeemMinimum;
        emit RedeemMinimumUpdated(_redeemMinimum);
    }

    /**
     * @notice Set the first deposit amount
     * @dev Amount should be in token decimals (18) for accurate comparison across different underlying assets
     * @param _amount The first deposit amount in token equivalent
     */
    function _setFirstDepositAmount(uint256 _amount) internal {
        firstDepositAmount = _amount;
        emit FirstDepositAmount(_amount);
    }

    uint256[10] private __gap;
}
