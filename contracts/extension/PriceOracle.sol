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
 * - Round-based price updates (Chainlink AggregatorV3Interface-compatible)
 * - Role-based access control
 * - Upgradeable via UUPS pattern
 */
contract PriceOracle is Initializable, AccessControlEnumerableUpgradeable, UUPSUpgradeable {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant CONFIRMER_ROLE = keccak256("CONFIRMER_ROLE");
    bytes32 public constant UPGRADE_ROLE = keccak256("UPGRADE_ROLE");

    struct RoundData {
        uint80 roundId;
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        uint80 answeredInRound;
    }

    struct PendingPrice {
        int256 value;
        uint256 proposedAt;
        address proposer;
        bool exists;
        uint256 observedAt;
    }

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    uint8 private immutable _decimals;

    uint80 private latestRoundValue;
    uint256 private referencePriceValue;

    uint256 public constant DEVIATION_FACTOR = 10000;
    uint256 private relativeMaxDeviationValue;
    uint256 private absoluteMaxDeviationValue;
    mapping(uint80 => RoundData) private roundData;
    PendingPrice private pendingPriceValue;

    event PriceProposed(int256 currentPrice, int256 proposedPrice, uint256 observedAt, address indexed proposer);
    event PendingPriceCancelled(int256 pendingPrice, address indexed cancelledBy);
    event UpdatePrice(int256 oldPrice, int256 newPrice);
    event RoundUpdated(uint80 indexed roundId);
    event UpdateRelativeMaxDeviation(uint256 oldDeviation, uint256 newDeviation);
    event UpdateAbsoluteMaxDeviation(uint256 oldDeviation, uint256 newDeviation);
    event UpdateReferencePrice(uint256 oldPrice, uint256 newPrice);

    error InvalidAddress();
    error InvalidDeviation(uint256 deviation);
    error InvalidPrice();
    error InvalidRoundId();
    error RelativeDeviationTooLarge(uint256 deviation, uint256 maxDeviation);
    error AbsoluteDeviationTooLarge(uint256 deviation, uint256 maxDeviation);
    error PendingPriceNotSet();
    error PendingPriceExists();
    error PendingPriceExpired(uint256 proposedAt, uint256 expiredAt, uint256 currentTimestamp);
    error PriceMismatch(int256 expected, int256 actual);
    error InvalidTimestamp();

    uint256 public constant PENDING_PRICE_TTL = 1 days;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(uint8 decimals_) {
        _decimals = decimals_;
        _disableInitializers();
    }

    /**
     * @notice Initializes the PriceOracle contract with essential configuration values
     * @param _relativeMaxDeviation Maximum allowed deviation from the latest answer (in basis points)
     * @param _absoluteMaxDeviation Maximum allowed deviation from the reference price (in basis points)
     * @param _initPrice Initial price
     * @param _referencePrice Initial reference price used for the second guardrail
     * @param _admin Address of the administrator who can manage roles
     */
    function initialize(
        uint256 _relativeMaxDeviation,
        uint256 _absoluteMaxDeviation,
        int256 _initPrice,
        uint256 _referencePrice,
        address _admin,
        uint256 _priceTimestamp
    ) external initializer {
        if (_admin == address(0)) revert InvalidAddress();
        if (_relativeMaxDeviation > DEVIATION_FACTOR) revert InvalidDeviation(_relativeMaxDeviation);
        if (_absoluteMaxDeviation > DEVIATION_FACTOR) revert InvalidDeviation(_absoluteMaxDeviation);
        if (_initPrice <= 0 || _referencePrice == 0) revert InvalidPrice();
        if (_priceTimestamp == 0 || _priceTimestamp >= block.timestamp) revert InvalidTimestamp();

        __AccessControl_init();

        relativeMaxDeviationValue = _relativeMaxDeviation;
        absoluteMaxDeviationValue = _absoluteMaxDeviation;
        referencePriceValue = _referencePrice;

        latestRoundValue = 1;
        RoundData storage round = roundData[latestRoundValue];
        round.roundId = latestRoundValue;
        round.answer = _initPrice;
        round.startedAt = _priceTimestamp;
        round.updatedAt = _priceTimestamp;
        round.answeredInRound = latestRoundValue;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function decimals() public view returns (uint8) {
        return _decimals;
    }

    function latestRound() public view returns (uint80) {
        return latestRoundValue;
    }

    function getRoundData(uint80 _roundId)
        public
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (_roundId == 0 || _roundId > latestRoundValue) revert InvalidRoundId();
        RoundData storage round = roundData[_roundId];
        return (round.roundId, round.answer, round.startedAt, round.updatedAt, round.answeredInRound);
    }

    function latestRoundData()
        public
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        RoundData storage round = roundData[latestRoundValue];
        return (round.roundId, round.answer, round.startedAt, round.updatedAt, round.answeredInRound);
    }

    function latestAnswer() public view returns (int256) {
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

    function pendingPrice() public view returns (int256, uint256, address, bool, uint256) {
        PendingPrice storage pending = pendingPriceValue;
        return (pending.value, pending.proposedAt, pending.proposer, pending.exists, pending.observedAt);
    }

    function isValidPriceUpdate(int256 _newPrice) public view returns (bool isValid) {
        if (_newPrice <= 0) return false;

        int256 latest = latestAnswer();
        uint256 priceDeviation = _calculateDeviation(uint256(latest), uint256(_newPrice));
        if (priceDeviation > relativeMaxDeviationValue) return false;

        uint256 referenceDeviation = _calculateDeviation(referencePriceValue, uint256(_newPrice));
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

        int256 pending = pendingPriceValue.value;
        delete pendingPriceValue;

        emit PendingPriceCancelled(pending, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                        OPERATOR FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function proposePrice(int256 _price, uint256 _priceTimestamp) external onlyRole(OPERATOR_ROLE) {
        if (_price <= 0) revert InvalidPrice();
        if (_priceTimestamp == 0 || _priceTimestamp >= block.timestamp) revert InvalidTimestamp();

        int256 latestPrice = latestAnswer();
        uint256 priceDeviation = _calculateDeviation(uint256(latestPrice), uint256(_price));
        if (priceDeviation > relativeMaxDeviationValue) {
            revert RelativeDeviationTooLarge(priceDeviation, relativeMaxDeviationValue);
        }

        uint256 referenceDeviation = _calculateDeviation(referencePriceValue, uint256(_price));
        if (referenceDeviation > absoluteMaxDeviationValue) {
            revert AbsoluteDeviationTooLarge(referenceDeviation, absoluteMaxDeviationValue);
        }

        pendingPriceValue = PendingPrice({
            value: _price,
            proposedAt: block.timestamp,
            proposer: msg.sender,
            exists: true,
            observedAt: _priceTimestamp
        });

        emit PriceProposed(latestPrice, _price, _priceTimestamp, msg.sender);
    }

    function confirmPrice(int256 _expectedPrice) external onlyRole(CONFIRMER_ROLE) {
        if (!pendingPriceValue.exists) revert PendingPriceNotSet();
        if (pendingPriceValue.value != _expectedPrice) revert PriceMismatch(_expectedPrice, pendingPriceValue.value);
        uint256 expiresAt = pendingPriceValue.proposedAt + PENDING_PRICE_TTL;
        if (block.timestamp > expiresAt) {
            revert PendingPriceExpired(pendingPriceValue.proposedAt, expiresAt, block.timestamp);
        }

        int256 newPrice = pendingPriceValue.value;
        int256 oldAnswer = latestAnswer();

        emit UpdatePrice(oldAnswer, newPrice);

        unchecked {
            ++latestRoundValue;
        }

        RoundData storage round = roundData[latestRoundValue];
        round.roundId = latestRoundValue;
        round.answer = newPrice;
        round.startedAt = pendingPriceValue.observedAt;
        round.updatedAt = pendingPriceValue.observedAt;
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

    function version() external pure returns (uint256) {
        return 2;
    }

    /*//////////////////////////////////////////////////////////////
                            STORAGE GAP
    //////////////////////////////////////////////////////////////*/

    uint256[39] private __gap;
}
