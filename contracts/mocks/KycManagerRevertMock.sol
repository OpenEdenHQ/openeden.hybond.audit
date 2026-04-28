// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract KycManagerRevertMock {
    error MockBoom();
    function isKyced(address) external pure returns (bool) {
        revert MockBoom();
    }
}
