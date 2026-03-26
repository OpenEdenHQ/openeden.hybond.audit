// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/Context.sol";

abstract contract ExpressPausable {
    event PausedDeposit(address account);
    event PausedRedeem(address account);

    event UnpausedDeposit(address account);
    event UnpausedRedeem(address account);

    bool private pausedDepositState;
    bool private pausedRedeemState;

    error PausedDeposit1();
    error PausedRedeem1();
    error NotPausedRedeem1();
    error NotPausedDeposit1();

    /*//////////////////////////////////////////////////////////////
                          Paused Deposit
    //////////////////////////////////////////////////////////////*/

    modifier whenNotPausedDeposit() {
        if (pausedDeposit()) revert PausedDeposit1();
        _;
    }

    modifier whenPausedDeposit() {
        if (!pausedDeposit()) revert NotPausedDeposit1();
        _;
    }

    function pausedDeposit() public view virtual returns (bool) {
        return pausedDepositState;
    }

    function _pauseDeposit() internal virtual whenNotPausedDeposit {
        pausedDepositState = true;
        emit PausedDeposit(msg.sender);
    }

    function _unpauseDeposit() internal virtual whenPausedDeposit {
        pausedDepositState = false;
        emit UnpausedDeposit(msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                          Paused Redeem
    //////////////////////////////////////////////////////////////*/

    modifier whenNotPausedRedeem() {
        if (pausedRedeem()) revert PausedRedeem1();
        _;
    }

    modifier whenPausedRedeem() {
        if (!pausedRedeem()) revert NotPausedRedeem1();
        _;
    }

    function pausedRedeem() public view virtual returns (bool) {
        return pausedRedeemState;
    }

    function _pauseRedeem() internal virtual whenNotPausedRedeem {
        pausedRedeemState = true;
        emit PausedRedeem(msg.sender);
    }

    function _unpauseRedeem() internal virtual whenPausedRedeem {
        pausedRedeemState = false;
        emit UnpausedRedeem(msg.sender);
    }
}
