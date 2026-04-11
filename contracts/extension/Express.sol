// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./ExpressPausable.sol";
import "./DepositRedeemLimiter.sol";
import "./DoubleQueueModified.sol";
import { IToken } from "../interfaces/IToken.sol";
import "../interfaces/IAssetRegistry.sol";
import "../interfaces/IPriceFeed.sol";
import { ExpressLib } from "./ExpressLib.sol";

/**
 * @title Express
 * @notice Token Express - Deposit and Redeem Gateway
 * @dev Upgradeable contract for queued deposits and queued token redemptions with compliance controls
 */
enum TxType {
    DEPOSIT,
    REDEEM
}

contract Express is UUPSUpgradeable, AccessControlEnumerableUpgradeable, ExpressPausable, DepositRedeemLimiter {
    using DoubleQueueModified for DoubleQueueModified.BytesDeque;
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant WHITELIST_ROLE = keccak256("WHITELIST_ROLE");
    bytes32 public constant MAINTAINER_ROLE = keccak256("MAINTAINER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant UPGRADE_ROLE = keccak256("UPGRADE_ROLE");

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 private constant BPS_BASE = 1e4;
    uint256 private constant MAX_DECIMALS = 18;

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    uint256 public depositFeeRate;
    uint256 public redeemFeeRate;

    IToken public token;

    // Deprecated: legacy single redeem asset slot
    address public redeemAsset;

    address public treasury;
    address public txFeeTo;

    address public mgtFeeTo;
    uint256 public mgtFeeRate;

    IAssetRegistry public assetRegistry;
    IPriceFeed public priceOracle;
    uint256 public maxStalePeriod;

    uint256 public epoch;
    uint256 public lastUpdateTS;

    // Cumulative management fee tokens minted but not yet burned via redeem.
    uint256 public totalMgtFeeMinted;

    uint256 public timeBuffer;

    mapping(address => bool) public firstDeposit;
    mapping(address => bool) public kycList;

    mapping(address => mapping(address => uint256)) public depositInfo;
    DoubleQueueModified.BytesDeque private depositQueue;

    mapping(address => uint256) public pendingRedeemInfo;
    DoubleQueueModified.BytesDeque private pendingRedeemQueue;

    mapping(address => uint256) public redeemInfo;
    DoubleQueueModified.BytesDeque private redeemQueue;

    uint256 public convertRedeemRequestsDelay;
    uint256 public totalRedeemQueueShares;
    uint8 public trimDecimals;
    uint256 private _nonce;

    mapping(address => uint256) public redeemEscrowBalance;
    mapping(address => mapping(address => uint256)) public depositEscrowBalance;
    mapping(bytes32 => uint256) public snapshotRatios;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event UpdateDepositFeeRate(uint256 fee);
    event UpdateRedeemFeeRate(uint256 fee);
    event UpdateMgtFeeRate(uint256 rate);
    event UpdateTreasury(address indexed treasury);
    event UpdateTxFeeTo(address indexed txFeeTo);
    event UpdateMgtFeeTo(address indexed mgtFeeTo);
    event UpdateAssetRegistry(address indexed newRegistry);
    event UpdateEpoch(uint256 totalMgtFeeMinted, uint256 dailyFee, uint256 epoch, uint256 circulatingSupply);
    event UpdateTimeBuffer(uint256 timeBuffer);
    event UpdatePriceOracle(address indexed priceOracle);
    event UpdateMaxStalePeriod(uint256 maxStalePeriod);
    event UpdateConvertRedeemRequestsDelay(uint256 delay);
    event UpdateTrimDecimals(uint8 decimals);

    event AddToDepositQueue(
        address asset,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 fee,
        bytes32 indexed id
    );

    event ProcessDeposit(
        address asset,
        address indexed from,
        address indexed to,
        uint256 netAssets,
        uint256 mintedAmount,
        uint256 feeAmt,
        bytes32 indexed id
    );

    event AddToPendingRedeemQueue(
        address indexed from,
        address indexed to,
        uint256 shareAmount,
        address redeemAsset,
        bytes32 indexed id
    );

    event ProcessPendingRedeem(
        address indexed from,
        address indexed to,
        uint256 shareAmount,
        address redeemAsset,
        uint256 priceUsed,
        bytes32 indexed pendingId,
        bytes32 finalId
    );

    event CancelPendingRedeem(address indexed from, address indexed to, uint256 shareAmount, bytes32 indexed id);

    event CancelProcessDeposit(
        address asset,
        address indexed from,
        address indexed to,
        uint256 netAssets,
        uint256 feeAmt,
        bytes32 indexed id
    );

    event CancelProcessRedeem(
        address indexed from,
        address indexed to,
        uint256 netAmount,
        uint256 feeAmt,
        bytes32 indexed id
    );

    event ProcessRedeem(
        address indexed from,
        address indexed to,
        uint256 burnedAmount,
        address redeemAsset,
        uint256 redeemAssetOut,
        bytes32 indexed id
    );

    event RevertRedeemToPending(
        address indexed from,
        address indexed to,
        uint256 tokenAmount,
        bytes32 indexed oldRedeemId,
        bytes32 newPendingId
    );

    event OffRamp(address indexed to, address indexed asset, uint256 amount);
    event UpdateFirstDeposit(address indexed account, bool flag);
    event KycGranted(address[] addresses);
    event KycRevoked(address[] addresses);
    event RedeemEscrowIn(address indexed account, uint256 amount);
    event RedeemEscrowOut(address indexed account, uint256 amount);
    event DepositEscrowIn(address indexed account, address indexed asset, uint256 amount);
    event DepositEscrowOut(address indexed account, address indexed asset, uint256 amount);
    event SnapshotPendingRedeemRatio(uint256 count, uint256 ratio);
    event SetSnapshotRatio(bytes32 indexed id, uint256 ratio);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidAddress();
    error InvalidAmount();
    error InvalidInput(uint256 input);
    error UpdateTooEarly(uint256 timestamp);
    error NotInKycList(address from, address to);
    error InsufficientLiquidity(uint256 required, uint256 available);
    error FirstDepositLessThanRequired(uint256 amount, uint256 minimum);
    error EmptyQueue();
    error NoPendingRedeemsReady();
    error MgtFeeDisabled();
    error QueuesNotEmpty();
    error RatioNotSnapshotted(bytes32 id);
    error AssetNotRedeemable(address asset);

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function reinitializeV2() external reinitializer(2) {
        if (depositQueue.length() != 0) revert QueuesNotEmpty();
        if (pendingRedeemQueue.length() != 0) revert QueuesNotEmpty();
        if (redeemQueue.length() != 0) revert QueuesNotEmpty();
    }

    /*//////////////////////////////////////////////////////////////
                             INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize the Express contract
     * @param _token Address of the token contract
     * @param _redeemAsset Address of the redeem asset (e.g., USDC, USDO)
     * @param _treasury Address to receive deposited assets
     * @param _txFeeTo Address to receive transaction fees
     * @param _mgtFeeTo Address to receive management fees
     * @param admin Address with admin privileges
     * @param _assetRegistry Address of the asset registry
     * @param _priceOracle Address of the price oracle (can be zero address if not using oracle)
     * @param cfg Deposit and redeem limiter configuration
     */
    function initialize(
        address _token,
        address _redeemAsset,
        address _treasury,
        address _txFeeTo,
        address _mgtFeeTo,
        address admin,
        address _assetRegistry,
        address _priceOracle,
        DepositRedeemLimiterCfg memory cfg
    ) external initializer {
        if (
            admin == address(0) ||
            _token == address(0) ||
            _redeemAsset == address(0) ||
            _treasury == address(0) ||
            _txFeeTo == address(0) ||
            _mgtFeeTo == address(0) ||
            _assetRegistry == address(0)
        ) revert InvalidAddress();

        __AccessControlEnumerable_init();

        token = IToken(_token);
        redeemAsset = _redeemAsset;
        treasury = _treasury;
        txFeeTo = _txFeeTo;
        mgtFeeTo = _mgtFeeTo;
        assetRegistry = IAssetRegistry(_assetRegistry);
        priceOracle = IPriceFeed(_priceOracle);

        __DepositRedeemLimiter_init(cfg.depositMinimum, cfg.redeemMinimum, cfg.firstDepositAmount);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /*//////////////////////////////////////////////////////////////
                         CONTRACT MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Update the asset registry address
     * @param _address The new asset registry address
     */
    function updateAssetRegistry(address _address) external onlyRole(MAINTAINER_ROLE) {
        if (_address == address(0)) revert InvalidAddress();
        assetRegistry = IAssetRegistry(_address);
        emit UpdateAssetRegistry(_address);
    }

    /**
     * @notice Update the price oracle address
     * @param _address The new price oracle address
     */
    function updatePriceOracle(address _address) external onlyRole(MAINTAINER_ROLE) {
        if (_address == address(0)) revert InvalidAddress();
        priceOracle = IPriceFeed(_address);
        emit UpdatePriceOracle(_address);
    }

    /**
     * @notice Update the maximum stale period for price data
     * @param _maxStalePeriod Maximum staleness in seconds (e.g., 86400 for 24 hours)
     */
    function updateMaxStalePeriod(uint256 _maxStalePeriod) external onlyRole(MAINTAINER_ROLE) {
        maxStalePeriod = _maxStalePeriod;
        emit UpdateMaxStalePeriod(_maxStalePeriod);
    }

    /**
     * @notice Update the redeem delay for T+2 processing
     * @param _delay Delay in seconds before pending requests can be processed
     */
    function updateConvertRedeemRequestsDelay(uint256 _delay) external onlyRole(MAINTAINER_ROLE) {
        convertRedeemRequestsDelay = _delay;
        emit UpdateConvertRedeemRequestsDelay(_delay);
    }

    /**
     * @notice Update the treasury address
     * @param _address The new treasury address
     */
    function updateTreasury(address _address) external onlyRole(MAINTAINER_ROLE) {
        if (_address == address(0)) revert InvalidAddress();
        treasury = _address;
        emit UpdateTreasury(_address);
    }

    /**
     * @notice Update the transaction fee recipient address
     * @param _address The new transaction fee recipient address
     */
    function updateTxFeeTo(address _address) external onlyRole(MAINTAINER_ROLE) {
        if (_address == address(0)) revert InvalidAddress();
        txFeeTo = _address;
        emit UpdateTxFeeTo(_address);
    }

    /**
     * @notice Update the management fee recipient address
     * @param _address The new management fee recipient address
     */
    function updateMgtFeeTo(address _address) external onlyRole(MAINTAINER_ROLE) {
        if (_address == address(0)) revert InvalidAddress();
        if (totalMgtFeeMinted != 0) revert InvalidInput(totalMgtFeeMinted);
        mgtFeeTo = _address;
        emit UpdateMgtFeeTo(_address);
    }

    /*//////////////////////////////////////////////////////////////
                           FEE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Update the deposit fee rate
     * @param _rate The new fee rate in basis points
     */
    function updateDepositFeeRate(uint256 _rate) external onlyRole(MAINTAINER_ROLE) {
        if (_rate >= BPS_BASE) revert InvalidInput(_rate);
        depositFeeRate = _rate;
        emit UpdateDepositFeeRate(_rate);
    }

    /**
     * @notice Update the redeem fee rate
     * @param _rate The new fee rate in basis points
     */
    function updateRedeemFeeRate(uint256 _rate) external onlyRole(MAINTAINER_ROLE) {
        if (_rate >= BPS_BASE) revert InvalidInput(_rate);
        redeemFeeRate = _rate;
        emit UpdateRedeemFeeRate(_rate);
    }

    /**
     * @notice Update the management fee rate
     * @param _rate The new management fee rate in basis points
     */
    function updateMgtFeeRate(uint256 _rate) external onlyRole(MAINTAINER_ROLE) {
        if (_rate >= BPS_BASE) revert InvalidInput(_rate);
        mgtFeeRate = _rate;
        emit UpdateMgtFeeRate(_rate);
    }

    /**
     * @notice Update the number of decimals to keep when trimming amounts
     * @param _decimals Number of decimals to keep (0-18)
     */
    function updateTrimDecimals(uint8 _decimals) external onlyRole(MAINTAINER_ROLE) {
        if (_decimals > MAX_DECIMALS) revert InvalidInput(_decimals);
        trimDecimals = _decimals;
        emit UpdateTrimDecimals(_decimals);
    }

    /**
     * @notice Calculate transaction fee based on amount and type
     * @param _amount The amount to calculate fee for
     * @param _txType The transaction type (DEPOSIT or REDEEM)
     * @return feeAmt The calculated fee amount
     */
    function txsFee(uint256 _amount, TxType _txType) public view returns (uint256 feeAmt) {
        uint256 feeRate;

        if (_txType == TxType.DEPOSIT) {
            feeRate = depositFeeRate;
        } else if (_txType == TxType.REDEEM) {
            feeRate = redeemFeeRate;
        }

        feeAmt = (_amount * feeRate) / BPS_BASE;
    }

    /**
     * @notice Queue a deposit request by depositing asset
     * @param _asset The asset token address (e.g., USDC, USDO)
     * @param _amount Amount of asset deposited
     * @param _receiver Address that receives minted token on processing
     */
    function requestDeposit(address _asset, uint256 _amount, address _receiver) external whenNotPausedDeposit {
        address sender = _msgSender();
        if (_amount == 0) revert InvalidAmount();

        _validateKyc(sender, _receiver);

        uint256 equivalentAmount = convertFromUnderlying(_asset, _amount);
        if (!firstDeposit[sender]) {
            if (equivalentAmount < firstDepositAmount) {
                revert FirstDepositLessThanRequired(equivalentAmount, firstDepositAmount);
            }
            firstDeposit[sender] = true;
        } else if (equivalentAmount < depositMinimum) {
            revert DepositLessThanMinimum(equivalentAmount, depositMinimum);
        }

        uint256 feeAmt = txsFee(_amount, TxType.DEPOSIT);
        uint256 netAmt = _amount - feeAmt;

        if (feeAmt > 0) {
            IERC20(_asset).safeTransferFrom(sender, txFeeTo, feeAmt);
        }
        IERC20(_asset).safeTransferFrom(sender, treasury, netAmt);

        depositInfo[_receiver][_asset] += netAmt;

        bytes32 id = keccak256(abi.encode(_asset, sender, _receiver, netAmt, feeAmt, block.timestamp, _nonce++));
        bytes memory data = abi.encode(_asset, sender, _receiver, netAmt, feeAmt, id);
        depositQueue.pushBack(data);

        emit AddToDepositQueue(_asset, sender, _receiver, netAmt, feeAmt, id);
    }

    /**
     * @notice Preview deposit request accounting
     * @param _asset The asset token address (e.g., USDC, USDO)
     * @param _amount The amount of asset token
     * @return netAmt Net amount after fees
     * @return feeAmt Fee amount
     * @return netMintAmt Net token amount to be minted after fees
     */
    function previewDeposit(
        address _asset,
        uint256 _amount
    ) public view returns (uint256 netAmt, uint256 feeAmt, uint256 netMintAmt) {
        feeAmt = txsFee(_amount, TxType.DEPOSIT);
        netAmt = _amount - feeAmt;
        netMintAmt = _calculateMintAmount(_asset, netAmt);
    }

    function _calculateMintAmount(address _asset, uint256 _netAssets) internal view returns (uint256) {
        return
            ExpressLib.calculateMintAmount(
                _asset,
                _netAssets,
                assetRegistry,
                getPrice(),
                _sharesPerToken(),
                trimDecimals
            );
    }

    /**
     * @notice Get fresh price from price feed with staleness check
     * @return price The fresh price (normalized to 18 decimals)
     */
    function getPrice() public view returns (uint256 price) {
        return ExpressLib.getPrice(priceOracle, maxStalePeriod);
    }

    /*//////////////////////////////////////////////////////////////
                           DEPOSIT QUEUE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Process queued deposit requests
     * @param _len Number of requests to process (0 = process all)
     */
    function processDepositQueue(uint256 _len) external onlyRole(MAINTAINER_ROLE) {
        _len = _validateQueueProcessing(depositQueue.length(), _len);

        for (uint256 count = 0; count < _len; ) {
            bytes memory data = depositQueue.front();
            (
                address asset,
                address sender,
                address receiver,
                uint256 netAssets,
                uint256 feeAmt,
                bytes32 prevId
            ) = _decodeDepositData(data);

            _validateKyc(sender, receiver);

            depositQueue.popFront();
            depositInfo[receiver][asset] -= netAssets;
            unchecked {
                ++count;
            }

            uint256 mintedAmount = _calculateMintAmount(asset, netAssets);
            token.mint(receiver, mintedAmount);

            emit ProcessDeposit(asset, sender, receiver, netAssets, mintedAmount, feeAmt, prevId);
        }
    }

    /**
     * @notice Cancel queued deposit requests and credit refunds to deposit escrow
     * @param _len Number of requests to cancel (0 = cancel all)
     */
    function cancelDeposit(uint256 _len) external onlyRole(MAINTAINER_ROLE) {
        _len = _validateQueueProcessing(depositQueue.length(), _len);

        while (_len > 0) {
            bytes memory data = depositQueue.front();
            (
                address asset,
                address sender,
                address receiver,
                uint256 netAssets,
                uint256 feeAmt,
                bytes32 prevId
            ) = _decodeDepositData(data);

            depositQueue.popFront();
            depositInfo[receiver][asset] -= netAssets;

            unchecked {
                --_len;
            }

            uint256 refundAmt = netAssets + feeAmt;
            depositEscrowBalance[sender][asset] += refundAmt;
            emit DepositEscrowIn(sender, asset, refundAmt);

            emit CancelProcessDeposit(asset, sender, receiver, netAssets, feeAmt, prevId);
        }
    }

    /**
     * @notice Get deposit queue info at index
     */
    function getDepositQueueInfo(
        uint256 _index
    )
        external
        view
        returns (address asset, address sender, address receiver, uint256 netAssets, uint256 feeAmt, bytes32 id)
    {
        if (depositQueue.empty() || _index > depositQueue.length() - 1) {
            return (address(0), address(0), address(0), 0, 0, 0x0);
        }
        bytes memory data = bytes(depositQueue.at(_index));
        (asset, sender, receiver, netAssets, feeAmt, id) = _decodeDepositData(data);
    }

    /**
     * @notice Get deposit queue length
     */
    function getDepositQueueLength() external view returns (uint256) {
        return depositQueue.length();
    }

    /*//////////////////////////////////////////////////////////////
                           REDEMPTION QUEUE
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Queue a redeem request for T+2 pricing
     * @param _to The address to receive redeemed asset
     * @param _shareAmount The amount of share to redeem
     * @param _redeemAsset The asset to receive upon redemption
     */
    function requestRedeem(address _to, uint256 _shareAmount, address _redeemAsset) external whenNotPausedRedeem {
        address from = _msgSender();
        if (_shareAmount == 0) revert InvalidAmount();
        if (!assetRegistry.isAssetSupported(_redeemAsset)) revert InvalidAddress();
        if (!assetRegistry.isAssetRedeemable(_redeemAsset)) revert AssetNotRedeemable(_redeemAsset);
        _validateKyc(from, _to);

        if (_shareAmount < redeemMinimum) {
            revert RedeemLessThanMinimum(_shareAmount, redeemMinimum);
        }

        IERC20(address(token)).safeTransferFrom(from, address(this), _shareAmount);

        pendingRedeemInfo[_to] += _shareAmount;

        bytes32 id = keccak256(abi.encode(from, _to, _shareAmount, _redeemAsset, block.timestamp, _nonce++));

        bytes memory data = abi.encode(from, _to, _shareAmount, _redeemAsset, block.timestamp, id);

        pendingRedeemQueue.pushBack(data);

        emit AddToPendingRedeemQueue(from, _to, _shareAmount, _redeemAsset, id);
    }

    /**
     * @notice Preview redeem request accounting
     * @param _shareAmount The amount of share to redeem
     * @param _redeemAsset The asset to receive upon redemption
     * @return feeAmt Platform fee amount in redeemAsset
     * @return redeemAssetAmt Gross redeemAsset amount queued before fee deduction
     * @return netRedeemAssetAmt Net redeemAsset amount after fee deduction
     */
    function previewRedeem(
        uint256 _shareAmount,
        address _redeemAsset
    ) public view returns (uint256 feeAmt, uint256 redeemAssetAmt, uint256 netRedeemAssetAmt) {
        uint256 price = getPrice();
        uint256 ratio = _sharesPerToken();
        redeemAssetAmt = _redeemAssetAmount(_shareAmount, ratio, price, _redeemAsset);
        feeAmt = txsFee(redeemAssetAmt, TxType.REDEEM);
        netRedeemAssetAmt = redeemAssetAmt - feeAmt;
    }

    /*//////////////////////////////////////////////////////////////
                  PENDING REDEMPTION QUEUE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Process pending redeems that have reached convertRedeemRequestsDelay
     * @param _len Number of pending requests to process (0 = all eligible)
     */
    function processPendingRedeems(uint256 _len) external onlyRole(OPERATOR_ROLE) {
        _len = _validateQueueProcessing(pendingRedeemQueue.length(), _len);

        uint256 processed;
        uint256 currentPrice = getPrice();

        for (uint256 count = 0; count < _len; ) {
            bytes memory data = pendingRedeemQueue.front();
            (
                address sender,
                address receiver,
                uint256 shareAmount,
                address redeemAssetAddr,
                uint256 requestTimestamp,
                bytes32 pendingId
            ) = _decodePendingRedeemData(data);

            if (block.timestamp < requestTimestamp + convertRedeemRequestsDelay) {
                break;
            }

            uint256 itemRatio = snapshotRatios[pendingId];
            if (itemRatio == 0) revert RatioNotSnapshotted(pendingId);

            _validateKyc(sender, receiver);

            uint256 redeemAssetAmt = _redeemAssetAmount(shareAmount, itemRatio, currentPrice, redeemAssetAddr);
            uint256 feeAssetAmt = txsFee(redeemAssetAmt, TxType.REDEEM);

            pendingRedeemQueue.popFront();
            pendingRedeemInfo[receiver] -= shareAmount;
            unchecked {
                ++count;
            }

            bytes32 finalId = keccak256(
                abi.encode(
                    sender,
                    receiver,
                    shareAmount,
                    redeemAssetAddr,
                    redeemAssetAmt,
                    feeAssetAmt,
                    requestTimestamp,
                    block.timestamp,
                    _nonce++
                )
            );

            redeemQueue.pushBack(
                abi.encode(
                    sender,
                    receiver,
                    shareAmount,
                    redeemAssetAddr,
                    redeemAssetAmt,
                    feeAssetAmt,
                    requestTimestamp,
                    finalId
                )
            );

            snapshotRatios[finalId] = itemRatio;
            delete snapshotRatios[pendingId];

            redeemInfo[receiver] += shareAmount;
            totalRedeemQueueShares += shareAmount;

            if (sender == mgtFeeTo && totalMgtFeeMinted >= shareAmount) {
                totalMgtFeeMinted -= shareAmount;
            }

            emit ProcessPendingRedeem(sender, receiver, shareAmount, redeemAssetAddr, currentPrice, pendingId, finalId);

            unchecked {
                ++processed;
            }
        }

        if (processed == 0) revert NoPendingRedeemsReady();
    }

    /**
     * @notice Cancel pending redeem requests and refund full token amount
     * @param _len Number of pending requests to cancel
     */
    function cancelPendingRedeem(uint256 _len) external onlyRole(MAINTAINER_ROLE) {
        _len = _validateQueueProcessing(pendingRedeemQueue.length(), _len);

        while (_len > 0) {
            bytes memory data = pendingRedeemQueue.popFront();
            (address sender, address receiver, uint256 shareAmount, , , bytes32 id) = _decodePendingRedeemData(data);

            pendingRedeemInfo[receiver] -= shareAmount;

            unchecked {
                --_len;
            }

            _refundOrEscrow(sender, shareAmount);
            delete snapshotRatios[id];

            emit CancelPendingRedeem(sender, receiver, shareAmount, id);
        }
    }

    /**
     * @notice Snapshot current sharesPerToken ratio into all pending redeem entries that have no ratio yet
     */
    function snapshotPendingRedeemRatio() external onlyRole(OPERATOR_ROLE) {
        uint256 queueLen = pendingRedeemQueue.length();
        if (queueLen == 0) revert EmptyQueue();

        uint256 currentRatio = _sharesPerToken();
        uint256 updated;

        for (uint256 i = 0; i < queueLen; ) {
            bytes memory data = pendingRedeemQueue.at(i);
            (, , , , , bytes32 id) = _decodePendingRedeemData(data);

            if (snapshotRatios[id] == 0) {
                snapshotRatios[id] = currentRatio;
                unchecked {
                    ++updated;
                }
            }

            unchecked {
                ++i;
            }
        }

        emit SnapshotPendingRedeemRatio(updated, currentRatio);
    }

    /**
     * @notice Manually set snapshot ratio for a pending redeem entry
     * @param _id Pending redeem ID
     * @param _ratio Shares-per-token ratio in 1e18 precision
     */
    function setSnapshotRatio(bytes32 _id, uint256 _ratio) external onlyRole(MAINTAINER_ROLE) {
        if (_ratio == 0 || _ratio > 1e18) revert InvalidInput(_ratio);
        snapshotRatios[_id] = _ratio;
        emit SetSnapshotRatio(_id, _ratio);
    }

    /*//////////////////////////////////////////////////////////////
                      REDEMPTION QUEUE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Process redeem queue with pre-calculated amounts
     * @param _len Number of requests to process (0 = process all)
     */
    function processRedeemQueue(uint256 _len) external onlyRole(OPERATOR_ROLE) {
        _len = _validateQueueProcessing(redeemQueue.length(), _len);

        for (uint256 count = 0; count < _len; ) {
            bytes memory data = redeemQueue.front();
            (
                address sender,
                address receiver,
                uint256 shareAmount,
                address redeemAssetAddr,
                uint256 redeemAssetAmt,
                uint256 feeAssetAmt,
                ,
                bytes32 id
            ) = _decodeRedeemData(data);

            _validateKyc(sender, receiver);

            uint256 availableLiquidity = IERC20(redeemAssetAddr).balanceOf(address(this));
            if (redeemAssetAmt > availableLiquidity) {
                break;
            }

            redeemQueue.popFront();
            redeemInfo[receiver] -= shareAmount;
            totalRedeemQueueShares -= shareAmount;
            delete snapshotRatios[id];
            unchecked {
                ++count;
            }

            token.burn(address(this), shareAmount);

            if (feeAssetAmt > 0) {
                if (txFeeTo == address(0)) revert InvalidAddress();
                IERC20(redeemAssetAddr).safeTransfer(txFeeTo, feeAssetAmt);
            }

            uint256 netAssetAmt = redeemAssetAmt - feeAssetAmt;
            IERC20(redeemAssetAddr).safeTransfer(receiver, netAssetAmt);

            emit ProcessRedeem(sender, receiver, shareAmount, redeemAssetAddr, netAssetAmt, id);
        }
    }

    /**
     * @notice Cancel redeem requests and refund full token amount
     * @param _len Number of requests to cancel
     */
    function cancelRedeem(uint256 _len) public onlyRole(MAINTAINER_ROLE) {
        _len = _validateQueueProcessing(redeemQueue.length(), _len);

        while (_len > 0) {
            bytes memory data = redeemQueue.popFront();
            (address sender, address receiver, uint256 shareAmount, , , , , bytes32 id) = _decodeRedeemData(data);

            redeemInfo[receiver] -= shareAmount;
            totalRedeemQueueShares -= shareAmount;
            delete snapshotRatios[id];

            unchecked {
                --_len;
            }

            _refundOrEscrow(sender, shareAmount);

            emit CancelProcessRedeem(sender, receiver, shareAmount, 0, id);
        }
    }

    /**
     * @notice Claim escrowed tokens from cancelled redemptions
     * @param _account Address to claim escrow for
     */
    function claimRedeemEscrow(address _account) external {
        address account = hasRole(OPERATOR_ROLE, msg.sender) ? _account : msg.sender;
        uint256 amount = redeemEscrowBalance[account];
        if (amount == 0) revert InvalidAmount();

        redeemEscrowBalance[account] = 0;
        IERC20(address(token)).safeTransfer(account, amount);
        emit RedeemEscrowOut(account, amount);
    }

    /**
     * @notice Claim escrowed deposit assets from cancelled deposits
     * @param _account Address to claim escrow for
     * @param _asset Address of the deposit asset to claim
     */
    function claimDepositEscrow(address _account, address _asset) external {
        address account = hasRole(OPERATOR_ROLE, msg.sender) ? _account : msg.sender;
        uint256 amount = depositEscrowBalance[account][_asset];
        if (amount == 0) revert InvalidAmount();

        depositEscrowBalance[account][_asset] = 0;
        IERC20(_asset).safeTransfer(account, amount);
        emit DepositEscrowOut(account, _asset, amount);
    }

    /**
     * @notice Revert redeems from final queue back to pending queue
     * @param _len Number of redeems to revert (0 = revert all)
     */
    function revertRedeemToPending(uint256 _len) external onlyRole(OPERATOR_ROLE) {
        _len = _validateQueueProcessing(redeemQueue.length(), _len);

        for (uint256 i = 0; i < _len; ) {
            bytes memory data = redeemQueue.popBack();
            (
                address sender,
                address receiver,
                uint256 shareAmount,
                address redeemAssetAddr,
                ,
                ,
                uint256 requestTimestamp,
                bytes32 oldId
            ) = _decodeRedeemData(data);

            redeemInfo[receiver] -= shareAmount;
            totalRedeemQueueShares -= shareAmount;

            bytes32 newPendingId = keccak256(
                abi.encode(sender, receiver, shareAmount, redeemAssetAddr, requestTimestamp, _nonce++)
            );

            bytes memory newPendingData = abi.encode(
                sender,
                receiver,
                shareAmount,
                redeemAssetAddr,
                requestTimestamp,
                newPendingId
            );
            pendingRedeemQueue.pushFront(newPendingData);

            pendingRedeemInfo[receiver] += shareAmount;

            snapshotRatios[newPendingId] = snapshotRatios[oldId];
            delete snapshotRatios[oldId];

            emit RevertRedeemToPending(sender, receiver, shareAmount, oldId, newPendingId);

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Get redeem queue information at index
     */
    function getRedeemQueueInfo(
        uint256 _index
    )
        external
        view
        returns (
            address sender,
            address receiver,
            uint256 shareAmount,
            address redeemAssetAddr,
            uint256 redeemAssetAmt,
            uint256 feeAssetAmt,
            uint256 requestTimestamp,
            bytes32 id
        )
    {
        if (redeemQueue.empty() || _index > redeemQueue.length() - 1) {
            return (address(0), address(0), 0, address(0), 0, 0, 0, 0x0);
        }

        bytes memory data = bytes(redeemQueue.at(_index));
        (
            sender,
            receiver,
            shareAmount,
            redeemAssetAddr,
            redeemAssetAmt,
            feeAssetAmt,
            requestTimestamp,
            id
        ) = _decodeRedeemData(data);
    }

    /**
     * @notice Get redeem queue length
     */
    function getRedeemQueueLength() external view returns (uint256) {
        return redeemQueue.length();
    }

    /*//////////////////////////////////////////////////////////////
                    PENDING REDEMPTION QUEUE QUERIES
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Get pending redeem queue info at index
     */
    function getPendingRedeemQueueInfo(
        uint256 _index
    )
        external
        view
        returns (
            address sender,
            address receiver,
            uint256 shareAmount,
            address redeemAssetAddr,
            uint256 requestTimestamp,
            bytes32 id
        )
    {
        if (pendingRedeemQueue.empty() || _index > pendingRedeemQueue.length() - 1) {
            return (address(0), address(0), 0, address(0), 0, 0x0);
        }
        bytes memory data = bytes(pendingRedeemQueue.at(_index));
        (sender, receiver, shareAmount, redeemAssetAddr, requestTimestamp, id) = _decodePendingRedeemData(data);
    }

    /**
     * @notice Get pending redeem queue length
     */
    function getPendingRedeemQueueLength() external view returns (uint256) {
        return pendingRedeemQueue.length();
    }

    /*//////////////////////////////////////////////////////////////
                           KYC MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Grant KYC status to multiple addresses
     * @param _addresses Array of addresses to grant KYC
     */
    function grantKycInBulk(address[] calldata _addresses) external onlyRole(WHITELIST_ROLE) {
        uint256 length = _addresses.length;

        for (uint256 i; i < length; ) {
            kycList[_addresses[i]] = true;
            unchecked {
                ++i;
            }
        }

        emit KycGranted(_addresses);
    }

    /**
     * @notice Revoke KYC status from multiple addresses
     * @param _addresses Array of addresses to revoke KYC
     */
    function revokeKycInBulk(address[] calldata _addresses) external onlyRole(WHITELIST_ROLE) {
        uint256 length = _addresses.length;

        for (uint256 i; i < length; ) {
            kycList[_addresses[i]] = false;
            unchecked {
                ++i;
            }
        }

        emit KycRevoked(_addresses);
    }

    /*//////////////////////////////////////////////////////////////
                         PAUSABLE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function pauseDeposit() external onlyRole(PAUSE_ROLE) {
        _pauseDeposit();
    }

    function unpauseDeposit() external onlyRole(PAUSE_ROLE) {
        _unpauseDeposit();
    }

    function pauseRedeem() external onlyRole(PAUSE_ROLE) {
        _pauseRedeem();
    }

    function unpauseRedeem() external onlyRole(PAUSE_ROLE) {
        _unpauseRedeem();
    }

    /*//////////////////////////////////////////////////////////////
                    DEPOSIT/REDEEM LIMITER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function updateDepositMinimum(uint256 _depositMinimum) external onlyRole(MAINTAINER_ROLE) {
        _setDepositMinimum(_depositMinimum);
    }

    function updateRedeemMinimum(uint256 _redeemMinimum) external onlyRole(MAINTAINER_ROLE) {
        _setRedeemMinimum(_redeemMinimum);
    }

    function updateFirstDepositAmount(uint256 _amount) external onlyRole(MAINTAINER_ROLE) {
        _setFirstDepositAmount(_amount);
    }

    function updateFirstDeposit(address _account, bool _flag) external onlyRole(MAINTAINER_ROLE) {
        if (_account == address(0)) revert InvalidAddress();
        firstDeposit[_account] = _flag;
        emit UpdateFirstDeposit(_account, _flag);
    }

    /*//////////////////////////////////////////////////////////////
                         TREASURY MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Transfer asset from contract to treasury
     * @param _asset Asset address to transfer
     * @param _amount Amount of asset to transfer
     */
    function offRamp(address _asset, uint256 _amount) external onlyRole(OPERATOR_ROLE) {
        if (_amount == 0) revert InvalidAmount();
        IERC20(_asset).safeTransfer(treasury, _amount);
        emit OffRamp(treasury, _asset, _amount);
    }

    /**
     * @notice Get token balance held by this contract
     * @param _token Token address
     * @return Balance amount
     */
    function getTokenBalance(address _token) public view returns (uint256) {
        return IERC20(_token).balanceOf(address(this));
    }

    /*//////////////////////////////////////////////////////////////
                        EPOCH MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Update epoch and accrue management fees
     */
    function updateEpoch() external onlyRole(OPERATOR_ROLE) {
        _updateEpochInternal(0, false);
    }

    /**
     * @notice Update epoch with manual circulating supply override
     * @param _circulatingSupply Circulating supply override used for fee calculation
     */
    function updateEpochAdjust(uint256 _circulatingSupply) external onlyRole(MAINTAINER_ROLE) {
        _updateEpochInternal(_circulatingSupply, true);
    }

    function _updateEpochInternal(uint256 _circulatingSupply, bool _useOverride) internal {
        if (mgtFeeRate == 0) revert MgtFeeDisabled();
        if (lastUpdateTS != 0 && block.timestamp < lastUpdateTS + timeBuffer) {
            revert UpdateTooEarly(block.timestamp);
        }

        epoch++;

        uint256 circulating;
        if (_useOverride) {
            uint256 totalSupply = IERC20(address(token)).totalSupply();
            if (_circulatingSupply > totalSupply) revert InvalidInput(_circulatingSupply);
            circulating = _circulatingSupply;
        } else {
            circulating = circulatingSupply();
        }

        uint256 dailyFee = ExpressLib.calculateDailyMgtFee(circulating, mgtFeeRate, trimDecimals);
        if (dailyFee > 0) {
            if (mgtFeeTo == address(0)) revert InvalidAddress();
            totalMgtFeeMinted += dailyFee;
            token.mint(mgtFeeTo, dailyFee);
        }

        lastUpdateTS = block.timestamp;
        emit UpdateEpoch(totalMgtFeeMinted, dailyFee, epoch, circulating);
    }

    /**
     * @notice Update the minimum time buffer between epoch updates
     * @param _timeBuffer Time buffer in seconds
     */
    function updateTimeBuffer(uint256 _timeBuffer) external onlyRole(MAINTAINER_ROLE) {
        timeBuffer = _timeBuffer;
        emit UpdateTimeBuffer(_timeBuffer);
    }

    /**
     * @notice Get circulating token supply
     */
    function circulatingSupply() public view returns (uint256 supply) {
        uint256 totalSupply = IERC20(address(token)).totalSupply();
        supply = totalSupply - totalRedeemQueueShares - totalMgtFeeMinted;
    }

    /**
     * @notice Get shares per token ratio
     */
    function sharesPerToken() external view returns (uint256 ratio) {
        ratio = _sharesPerToken();
    }

    /*//////////////////////////////////////////////////////////////
                        CONVERSION HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Convert asset token amount to token amount
     */
    function convertFromUnderlying(address _token, uint256 _amount) public view returns (uint256 amount) {
        return assetRegistry.convertFromUnderlying(_token, _amount);
    }

    /**
     * @notice Convert token amount to asset token amount
     */
    function convertToUnderlying(address _token, uint256 _amount) public view returns (uint256 amount) {
        return assetRegistry.convertToUnderlying(_token, _amount);
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _refundOrEscrow(address _sender, uint256 _amount) internal {
        if (token.isBanned(_sender)) {
            redeemEscrowBalance[_sender] += _amount;
            emit RedeemEscrowIn(_sender, _amount);
        } else {
            IERC20(address(token)).safeTransfer(_sender, _amount);
        }
    }

    function _validateKyc(address _sender, address _receiver) internal view {
        if (!kycList[_sender] || !kycList[_receiver]) revert NotInKycList(_sender, _receiver);
    }

    function _validateQueueProcessing(uint256 _queueLength, uint256 _len) internal pure returns (uint256 len) {
        if (_queueLength == 0) revert EmptyQueue();
        if (_len > _queueLength) revert InvalidInput(_len);
        len = _len == 0 ? _queueLength : _len;
    }

    function _sharesPerToken() internal view returns (uint256) {
        return ExpressLib.sharesPerToken(address(token), totalRedeemQueueShares, totalMgtFeeMinted);
    }

    function _redeemAssetAmount(
        uint256 _shareAmount,
        uint256 _ratio,
        uint256 _price,
        address _redeemAsset
    ) internal view returns (uint256) {
        return ExpressLib.redeemAssetAmount(_shareAmount, _ratio, _price, _redeemAsset, assetRegistry, trimDecimals);
    }

    function _decodeDepositData(
        bytes memory _data
    )
        internal
        pure
        returns (address asset, address sender, address receiver, uint256 netAssets, uint256 feeAmt, bytes32 id)
    {
        (asset, sender, receiver, netAssets, feeAmt, id) = abi.decode(
            _data,
            (address, address, address, uint256, uint256, bytes32)
        );
    }

    function _decodeRedeemData(
        bytes memory _data
    )
        internal
        pure
        returns (
            address sender,
            address receiver,
            uint256 tokenAmount,
            address redeemAssetAddr,
            uint256 redeemAssetAmt,
            uint256 feeAssetAmt,
            uint256 requestTimestamp,
            bytes32 id
        )
    {
        (sender, receiver, tokenAmount, redeemAssetAddr, redeemAssetAmt, feeAssetAmt, requestTimestamp, id) = abi
            .decode(_data, (address, address, uint256, address, uint256, uint256, uint256, bytes32));
    }

    function _decodePendingRedeemData(
        bytes memory _data
    )
        internal
        pure
        returns (
            address sender,
            address receiver,
            uint256 tokenAmount,
            address redeemAssetAddr,
            uint256 requestTimestamp,
            bytes32 id
        )
    {
        (sender, receiver, tokenAmount, redeemAssetAddr, requestTimestamp, id) = abi.decode(
            _data,
            (address, address, uint256, address, uint256, bytes32)
        );
    }

    /*//////////////////////////////////////////////////////////////
                             UPGRADEABILITY
    //////////////////////////////////////////////////////////////*/

    function _authorizeUpgrade(address _newImplementation) internal view override onlyRole(UPGRADE_ROLE) {
        if (_newImplementation == address(0)) revert InvalidAddress();
    }

    /**
     * @notice Get contract version
     */
    function version() external pure returns (string memory) {
        return "2.0.0";
    }

    /*//////////////////////////////////////////////////////////////
                            STORAGE GAP
    //////////////////////////////////////////////////////////////*/

    uint256[38] private __gap;
}
