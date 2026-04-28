// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @title KycManager
/// @notice Single source of truth for KYC across HYBOND Token and Express.
contract KycManager is AccessControlEnumerableUpgradeable, UUPSUpgradeable {
    bytes32 public constant WHITELIST_ROLE = keccak256("WHITELIST_ROLE");

    mapping(address => bool) private _kycList;

    event KycGranted(address indexed account);
    event KycRevoked(address indexed account);

    error InvalidAddress();
    error AlreadyKyced(address account);
    error NotKyced(address account);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) public initializer {
        if (admin == address(0)) revert InvalidAddress();
        __AccessControlEnumerable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function grantKyc(address account) external onlyRole(WHITELIST_ROLE) {
        _grantKyc(account);
    }

    function revokeKyc(address account) external onlyRole(WHITELIST_ROLE) {
        _revokeKyc(account);
    }

    function grantKycBulk(address[] calldata accounts) external onlyRole(WHITELIST_ROLE) {
        uint256 length = accounts.length;
        for (uint256 i; i < length; ) {
            _grantKyc(accounts[i]);
            unchecked { ++i; }
        }
    }

    function revokeKycBulk(address[] calldata accounts) external onlyRole(WHITELIST_ROLE) {
        uint256 length = accounts.length;
        for (uint256 i; i < length; ) {
            _revokeKyc(accounts[i]);
            unchecked { ++i; }
        }
    }

    function isKyced(address account) external view returns (bool) {
        return _kycList[account];
    }

    function _grantKyc(address account) private {
        if (account == address(0)) revert InvalidAddress();
        if (_kycList[account]) revert AlreadyKyced(account);
        _kycList[account] = true;
        emit KycGranted(account);
    }

    function _revokeKyc(address account) private {
        if (!_kycList[account]) revert NotKyced(account);
        _kycList[account] = false;
        emit KycRevoked(account);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    uint256[49] private __gap;
}
