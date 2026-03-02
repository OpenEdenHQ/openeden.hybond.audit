// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IToken {
    function approve(address spender, uint256 amount) external returns (bool);

    function mint(address to, uint256 amount) external;

    function burn(address from, uint256 amount) external;

    function pause() external;

    function unpause() external;
}
