// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title PriceOracle
 * @notice Upgradeable oracle contract for managing staged price updates with deviation controls
 * @dev Uses UUPS upgradeable pattern for future improvements
 *
 * Key Features:
 * - Two configurable price deviation limits for safety
 * - Two-step price updates (proposal + confirmation)
 * - Round-based price updates (Chainlink-compatible interface)
 * - Role-based access control
 * - Upgradeable via UUPS pattern
 */
contract PriceOracle is Initializable, AccessControlEnumerableUpgradeable, UUPSUpgradeable {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant CONFIRMER_ROLE = keccak256("CONFIRMER_ROLE");
    bytes32 public constant UPGRADE_ROLE = keccak256("UPGRADE_ROLE");

    struct RoundData {
        uint80 roundId;
        uint256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        uint80 answeredInRound;
    }

    struct PendingPrice {
        uint256 value;
        uint256 proposedAt;
        address proposer;
        bool exists;
    }

    uint8 private decimalsValue;

    uint80 private latestRoundValue;
    uint256 private referencePriceValue;

    uint256 public constant DEVIATION_FACTOR = 10000;
    uint256 private relativeMaxDeviationValue;
    uint256 private absoluteMaxDeviationValue;
    mapping(uint80 => RoundData) private roundData;
    PendingPrice private pendingPriceValue;

    event PriceProposed(uint256 currentPrice, uint256 proposedPrice, address indexed proposer);
    event PendingPriceCancelled(uint256 pendingPrice, address indexed cancelledBy);
    event UpdatePrice(uint256 oldPrice, uint256 newPrice);
    event RoundUpdated(uint80 indexed roundId);
    event UpdateRelativeMaxDeviation(uint256 oldDeviation, uint256 newDeviation);
    event UpdateAbsoluteMaxDeviation(uint256 oldDeviation, uint256 newDeviation);
    event UpdateReferencePrice(uint256 oldPrice, uint256 newPrice);

    error InvalidAddress();
    error InvalidDeviation(uint256 deviation);
    error InvalidPrice();
    error RelativeDeviationTooLarge(uint256 deviation, uint256 maxDeviation);
    error AbsoluteDeviationTooLarge(uint256 deviation, uint256 maxDeviation);
    error PendingPriceNotSet();
    error PendingPriceExists();
    error PendingPriceExpired(uint256 proposedAt, uint256 expiredAt, uint256 currentTimestamp);

    uint256 public constant PENDING_PRICE_TTL = 1 days;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the PriceOracle contract with essential configuration values
     * @param _decimals Decimals used for the oracle price
     * @param _relativeMaxDeviation Maximum allowed deviation from the latest answer (in basis points)
     * @param _absoluteMaxDeviation Maximum allowed deviation from the reference price (in basis points)
     * @param _initPrice Initial price
     * @param _referencePrice Initial reference price used for the second guardrail
     * @param _admin Address of the administrator who can manage roles
     */
    function initialize(
        uint8 _decimals,
        uint256 _relativeMaxDeviation,
        uint256 _absoluteMaxDeviation,
        uint256 _initPrice,
        uint256 _referencePrice,
        address _admin
    ) external initializer {
        if (_admin == address(0)) revert InvalidAddress();
        if (_relativeMaxDeviation > DEVIATION_FACTOR) revert InvalidDeviation(_relativeMaxDeviation);
        if (_absoluteMaxDeviation > DEVIATION_FACTOR) revert InvalidDeviation(_absoluteMaxDeviation);
        if (_initPrice == 0 || _referencePrice == 0) revert InvalidPrice();

        __AccessControl_init();
        __UUPSUpgradeable_init();

        decimalsValue = _decimals;
        relativeMaxDeviationValue = _relativeMaxDeviation;
        absoluteMaxDeviationValue = _absoluteMaxDeviation;
        referencePriceValue = _referencePrice;

        latestRoundValue = 1;
        RoundData storage round = roundData[latestRoundValue];
        round.roundId = latestRoundValue;
        round.answer = _initPrice;
        round.startedAt = block.timestamp;
        round.updatedAt = block.timestamp;
        round.answeredInRound = latestRoundValue;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function decimals() public view returns (uint8) {
        return decimalsValue;
    }

    function latestRound() public view returns (uint80) {
        return latestRoundValue;
    }

    function latestRoundData() public view returns (uint80, uint256, uint256, uint256, uint80) {
        RoundData storage round = roundData[latestRoundValue];
        return (round.roundId, round.answer, round.startedAt, round.updatedAt, round.answeredInRound);
    }

    function latestAnswer() public view returns (uint256) {
        return roundData[latestRoundValue].answer;
    }

    function referencePrice() public view returns (uint256) {
        return referencePriceValue;
    }

    function relativeMaxDeviation() public view returns (uint256) {
        return relativeMaxDeviationValue;
    }

    function absoluteMaxDeviation() public view returns (uint256) {
        return absoluteMaxDeviationValue;
    }

    function pendingPrice() public view returns (uint256, uint256, address, bool) {
        PendingPrice storage pending = pendingPriceValue;
        return (pending.value, pending.proposedAt, pending.proposer, pending.exists);
    }

    function isValidPriceUpdate(uint256 _newPrice) public view returns (bool isValid) {
        if (_newPrice == 0) return false;

        uint256 latestPrice = latestAnswer();
        uint256 priceDeviation = _calculateDeviation(latestPrice, _newPrice);
        if (priceDeviation > relativeMaxDeviationValue) return false;

        uint256 referenceDeviation = _calculateDeviation(referencePriceValue, _newPrice);
        return referenceDeviation <= absoluteMaxDeviationValue;
    }

    /*//////////////////////////////////////////////////////////////
                        ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function updateRelativeMaxDeviation(uint256 _newDeviation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pendingPriceValue.exists) revert PendingPriceExists();
        if (_newDeviation > DEVIATION_FACTOR) revert InvalidDeviation(_newDeviation);

        emit UpdateRelativeMaxDeviation(relativeMaxDeviationValue, _newDeviation);
        relativeMaxDeviationValue = _newDeviation;
    }

    function updateAbsoluteMaxDeviation(uint256 _newDeviation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pendingPriceValue.exists) revert PendingPriceExists();
        if (_newDeviation > DEVIATION_FACTOR) revert InvalidDeviation(_newDeviation);

        emit UpdateAbsoluteMaxDeviation(absoluteMaxDeviationValue, _newDeviation);
        absoluteMaxDeviationValue = _newDeviation;
    }

    function updateReferencePrice(uint256 _price) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pendingPriceValue.exists) revert PendingPriceExists();
        if (_price == 0) revert InvalidPrice();

        emit UpdateReferencePrice(referencePriceValue, _price);
        referencePriceValue = _price;
    }

    function cancelPendingPrice() external onlyRole(OPERATOR_ROLE) {
        if (!pendingPriceValue.exists) revert PendingPriceNotSet();

        uint256 pending = pendingPriceValue.value;
        delete pendingPriceValue;

        emit PendingPriceCancelled(pending, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                        OPERATOR FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function proposePrice(uint256 _price) external onlyRole(OPERATOR_ROLE) {
        if (_price == 0) revert InvalidPrice();

        uint256 latestPrice = latestAnswer();
        uint256 priceDeviation = _calculateDeviation(latestPrice, _price);
        if (priceDeviation > relativeMaxDeviationValue) {
            revert RelativeDeviationTooLarge(priceDeviation, relativeMaxDeviationValue);
        }

        uint256 referenceDeviation = _calculateDeviation(referencePriceValue, _price);
        if (referenceDeviation > absoluteMaxDeviationValue) {
            revert AbsoluteDeviationTooLarge(referenceDeviation, absoluteMaxDeviationValue);
        }

        pendingPriceValue = PendingPrice({
            value: _price,
            proposedAt: block.timestamp,
            proposer: msg.sender,
            exists: true
        });

        emit PriceProposed(latestPrice, _price, msg.sender);
    }

    function confirmPrice() external onlyRole(CONFIRMER_ROLE) {
        if (!pendingPriceValue.exists) revert PendingPriceNotSet();
        uint256 expiresAt = pendingPriceValue.proposedAt + PENDING_PRICE_TTL;
        if (block.timestamp > expiresAt) {
            revert PendingPriceExpired(pendingPriceValue.proposedAt, expiresAt, block.timestamp);
        }

        uint256 newPrice = pendingPriceValue.value;
        uint256 oldAnswer = latestAnswer();

        emit UpdatePrice(oldAnswer, newPrice);

        unchecked {
            ++latestRoundValue;
        }

        RoundData storage round = roundData[latestRoundValue];
        round.roundId = latestRoundValue;
        round.answer = newPrice;
        round.startedAt = block.timestamp;
        round.updatedAt = block.timestamp;
        round.answeredInRound = latestRoundValue;

        delete pendingPriceValue;

        emit RoundUpdated(latestRoundValue);
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _calculateDeviation(uint256 _basePrice, uint256 _newPrice) private pure returns (uint256 deviation) {
        uint256 numerator = _basePrice > _newPrice ? _basePrice - _newPrice : _newPrice - _basePrice;
        uint256 denominator = (_basePrice + _newPrice) / 2;

        if (denominator == 0) return 0;

        deviation = (numerator * DEVIATION_FACTOR) / denominator;
    }

    function _authorizeUpgrade(address _newImplementation) internal view override onlyRole(UPGRADE_ROLE) {
        if (_newImplementation == address(0)) revert InvalidAddress();
    }

    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    /*//////////////////////////////////////////////////////////////
                            STORAGE GAP
    //////////////////////////////////////////////////////////////*/

    uint256[40] private __gap;
}
