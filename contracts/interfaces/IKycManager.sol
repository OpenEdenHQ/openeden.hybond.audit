// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IKycManager {
    function isKyced(address account) external view returns (bool);
}
