// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { ERC20PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title Token
 * @dev Standard ERC-20 upgradeable for single-chain deployment
 *
 * Key Features:
 * - Built-in AccessControlEnumerable for role management
 * - Issue cap (maximum supply limit)
 * - Ban list enforcement on all transfers
 * - Burnable tokens
 * - Pausable for emergency situations
 * - Upgradeable via UUPS pattern
 */
contract Token is ERC20Upgradeable, ERC20PausableUpgradeable, AccessControlEnumerableUpgradeable, UUPSUpgradeable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant BANLIST_ROLE = keccak256("BANLIST_ROLE");
    bytes32 public constant UPGRADE_ROLE = keccak256("UPGRADE_ROLE");

    uint256 public issueCap;
    mapping(address => bool) private _bannedList;

    event Mint(address indexed to, uint256 amount);
    event Burn(address indexed from, uint256 amount);
    event IssueCapUpdated(uint256 oldCap, uint256 newCap);
    event AccountBanned(address indexed addr);
    event AccountUnbanned(address indexed addr);

    error InvalidAddress();
    error InvalidAmount();
    error ExceedsIssueCap();
    error CapBelowSupply();
    error BannedSender(address sender);
    error BannedRecipient(address recipient);
    error InvalidBannedAccount(address account);
    error BatchSizeTooLarge();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the token
     * @param _name Token name
     * @param _symbol Token symbol
     * @param _admin Default admin address
     * @param _issueCap Maximum supply limit (0 = unlimited)
     */
    function initialize(
        string memory _name,
        string memory _symbol,
        address _admin,
        uint256 _issueCap
    ) public initializer {
        __ERC20_init(_name, _symbol);
        __ERC20Pausable_init();
        __AccessControlEnumerable_init();

        if (_admin == address(0)) revert InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        issueCap = _issueCap;
    }

    /**
     * @notice Mint new tokens
     * @param to Recipient address
     * @param amount Amount to mint
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (amount == 0) revert InvalidAmount();

        uint256 _issueCap = issueCap;
        if (_issueCap > 0) {
            if (totalSupply() + amount > _issueCap) revert ExceedsIssueCap();
        }

        _mint(to, amount);
        emit Mint(to, amount);
    }

    /**
     * @notice Burn tokens
     * @param amount Amount to burn
     */
    function burn(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        if (amount == 0) revert InvalidAmount();

        _burn(from, amount);
        emit Burn(from, amount);
    }

    /**
     * @notice Increase the allowance granted to spender
     * @param spender The address which will spend the funds
     * @param addedValue The amount to increase the allowance by
     * @return True if the operation succeeded
     */
    function increaseAllowance(address spender, uint256 addedValue) external returns (bool) {
        address owner = _msgSender();
        _approve(owner, spender, allowance(owner, spender) + addedValue);
        return true;
    }

    /**
     * @notice Decrease the allowance granted to spender
     * @param spender The address which will spend the funds
     * @param subtractedValue The amount to decrease the allowance by
     * @return True if the operation succeeded
     */
    function decreaseAllowance(address spender, uint256 subtractedValue) external returns (bool) {
        address owner = _msgSender();
        uint256 currentAllowance = allowance(owner, spender);

        if (currentAllowance < subtractedValue) {
            revert ERC20InsufficientAllowance(spender, currentAllowance, subtractedValue);
        }

        _approve(owner, spender, currentAllowance - subtractedValue);
        return true;
    }

    /**
     * @notice Pause token transfers
     */
    function pause() external onlyRole(PAUSE_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause token transfers
     */
    function unpause() external onlyRole(PAUSE_ROLE) {
        _unpause();
    }

    /**
     * @notice Set issue cap
     * @param newCap New maximum supply (0 = unlimited)
     */
    function setIssueCap(uint256 newCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newCap != 0 && newCap < totalSupply()) revert CapBelowSupply();

        uint256 oldCap = issueCap;
        issueCap = newCap;

        emit IssueCapUpdated(oldCap, newCap);
    }

    /**
     * @notice Ban an account
     * @param account The address to ban
     */
    function _banAccount(address account) private {
        if (isBanned(account)) revert InvalidBannedAccount(account);

        _bannedList[account] = true;
        emit AccountBanned(account);
    }

    /**
     * @notice Unban an account
     * @param account The address to unban
     */
    function _unbanAccount(address account) private {
        if (!isBanned(account)) revert InvalidBannedAccount(account);

        _bannedList[account] = false;
        emit AccountUnbanned(account);
    }

    /**
     * @notice Ban multiple accounts at once
     * @param addresses An array of addresses to be banned
     * @dev Maximum batch size is 100 addresses to prevent gas limit issues
     */
    function banAddresses(address[] calldata addresses) external onlyRole(BANLIST_ROLE) {
        uint256 length = addresses.length;

        for (uint256 i; i < length; ) {
            _banAccount(addresses[i]);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Unban multiple accounts at once
     * @param addresses An array of addresses to be unbanned
     * @dev Maximum batch size is 100 addresses to prevent gas limit issues
     */
    function unbanAddresses(address[] calldata addresses) external onlyRole(BANLIST_ROLE) {
        uint256 length = addresses.length;

        for (uint256 i; i < length; ) {
            _unbanAccount(addresses[i]);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Check if an account is banned
     * @param account The address to check
     * @return True if the account is banned
     */
    function isBanned(address account) public view returns (bool) {
        return _bannedList[account];
    }

    /**
     * @notice Override _update to add ban check and pause check
     * @dev Called on mint, burn, and transfer
     * @dev Ban checks apply to ALL operations including mint and burn for regulatory compliance
     * @dev Pause check handled by ERC20PausableUpgradeable parent
     */
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        // Check sender ban status (including burns FROM banned addresses)
        if (from != address(0) && isBanned(from)) {
            revert BannedSender(from);
        }
        // Check recipient ban status (including mints TO banned addresses)
        if (to != address(0) && isBanned(to)) {
            revert BannedRecipient(to);
        }

        // Pause check is handled by super._update() via ERC20PausableUpgradeable
        super._update(from, to, amount);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(UPGRADE_ROLE) {
        if (newImplementation == address(0)) revert InvalidAddress();
    }

    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[45] private __gap;
}
