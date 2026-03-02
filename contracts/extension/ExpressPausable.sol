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

    /*//////////////////////////////////////////////////////////////
                          Paused Deposit
    //////////////////////////////////////////////////////////////*/

    modifier whenNotPausedDeposit() {
        require(!pausedDeposit(), "Pausable: Deposit paused");
        _;
    }

    modifier whenPausedDeposit() {
        require(pausedDeposit(), "Pausable: Deposit not paused");
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
        require(!pausedRedeem(), "Pausable: Redeem paused");
        _;
    }

    modifier whenPausedRedeem() {
        require(pausedRedeem(), "Pausable: Redeem not paused");
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
