// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import "./ExpressPausable.sol";
import "./DepositRedeemLimiter.sol";
import "./DoubleQueueModified.sol";
import { IToken } from "../interfaces/IToken.sol";
import "../interfaces/IAssetRegistry.sol";
import "../interfaces/IPriceFeed.sol";
import { IKycManager } from "../interfaces/IKycManager.sol";

/**
 * @title Express
 * @notice Token Express - Deposit and Redeem Gateway
 * @dev Upgradeable contract for queued deposits and queued token redemptions with compliance controls
 *
 * Key Features:
 * - Queued deposit and redeem system
 * - KYC/compliance enforcement
 * - Fee management for deposits and redemptions
 * - First deposit requirements
 * - Rate limiting for deposits and redeems
 * - Integration with asset registry
 * - Upgradeable via UUPS pattern
 */
enum TxType {
    DEPOSIT,
    REDEEM
}

contract Express is UUPSUpgradeable, AccessControlEnumerableUpgradeable, ExpressPausable, DepositRedeemLimiter {
    using Math for uint256;
    using DoubleQueueModified for DoubleQueueModified.BytesDeque;
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 public constant MAINTAINER_ROLE = keccak256("MAINTAINER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant UPGRADE_ROLE = keccak256("UPGRADE_ROLE");

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 private constant BPS_BASE = 1e4;
    uint256 private constant DAYS_IN_YEAR = 365;
    uint256 private constant MAX_DECIMALS = 18;

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    // Fee configuration (in basis points, 1e4)
    uint256 public depositFeeRate;
    uint256 public redeemFeeRate;

    // Core token addresses
    IToken public token;

    // Redeem asset addresses
    address public redeemAsset;

    // Treasury address
    address public treasury;

    // Transaction fee recipient address
    address public txFeeTo;

    // Management fee recipient address.
    //
    // OPERATIONAL INVARIANTS for mgtFeeTo (enforced off-chain):
    // 1. The mgtFeeTo wallet must only transfer HYBOND shares to the Express contract via
    //    requestRedeem(). Direct transfers to any other address can desync totalMgtFeeUnclaimed
    //    against on-chain fee ownership, because fee-share provenance is keyed on sender identity.
    //    The mgtFeeTo wallet must NEVER call requestDirectRedeem() — fee shares must settle in
    //    redeemAsset via the queued path. requestDirectRedeem rejects mgtFeeTo on-chain.
    // 2. Any non-fee shares accidentally received by mgtFeeTo (e.g. a user's direct transfer) must
    //    be moved to a quarantine wallet and must NOT be redeemed through requestRedeem by mgtFeeTo.
    //    requestRedeem overrides caller-supplied amount to totalMgtFeeUnclaimed for mgtFeeTo to
    //    limit the blast radius, but this relies on non-fee shares being moved out beforehand.
    // 3. The mgtFeeTo wallet must never be added to the banned list while it holds live fee shares
    //    (totalMgtFeeUnclaimed > 0) or has in-flight fee redeems in either queue. Violating this
    //    deadlocks cancelRedeem's refund path into redeemEscrowBalance with no on-chain exit.
    // 4. Rotating mgtFeeTo requires both redeem queues empty (enforced on-chain by updateMgtFeeTo).
    //    Operators should drain queues before rotation.
    // 5. The mgtFeeTo wallet must remain unbanned for the full lifetime of the pool. Banning it —
    //    even when totalMgtFeeUnclaimed == 0 — breaks the next updateEpoch call because
    //    updateEpoch mints new fee shares to mgtFeeTo, and Token._update rejects mints
    //    to banned recipients, wedging fee accrual until unban.
    // 6. The mgtFeeTo wallet AND the receiver of any in-flight fee redeem must remain KYC-listed
    //    through settlement. processPendingRedeems, processRedeemQueue, and requestRedeem
    //    all re-check KYC, so de-KYCing mid-flow wedges the front of a queue until re-KYC or
    //    manual cancelPendingRedeem / cancelRedeem (cancel routes refunds to redeemEscrowBalance
    //    when the sender is banned or de-KYC'd; user reclaims via claimRedeemEscrow after re-KYC).
    // 7. Queue-time parameters are read live at processing time, not snapshotted at request time.
    //    Do NOT change convertRedeemRequestsDelay, redeemFeeRate, depositFeeRate, priceOracle,
    //    maxStalePeriod, trimDecimals, depositMaxDeviationBps, or redeemMaxDeviationBps while
    //    pendingRedeemQueue / redeemQueue / depositQueue is non-empty — doing so will silently
    //    change the pricing, fees, or settlement timing of already-queued entries relative to
    //    what the user saw when they submitted.
    address public mgtFeeTo;

    // Management fee rate (in basis points, 1e4)
    uint256 public mgtFeeRate;

    // External contract integrations
    IAssetRegistry public assetRegistry;

    /// @notice External price feed reporting the token price of HYBOND (assets per
    ///         HYBOND token, normalized to 1e18). When unset, getPrice() falls back
    ///         to 1e18 (1:1 ratio). Note: this changed from share-price semantics —
    ///         see docs/2026-05-21-oracle-token-price-semantics-design.md.
    IPriceFeed public priceOracle;

    // Maximum allowed staleness for price data (e.g., 24 hours = 86400)
    uint256 public maxStalePeriod;

    // Updated automatically by processDepositQueue (increment) and requestRedeem (decrement).
    // Admin override available via updateOffchainShares for rare reconciliation.
    uint256 public offchainShares;

    // Last update timestamp for epoch management
    uint256 public lastUpdateTS;

    // Currently live (unredeemed) management fee tokens. Zeroed at requestRedeem time when
    // mgtFeeTo redeems. Re-credited in cancelPendingRedeem and cancelRedeem for fee-owned entries.
    uint256 public totalMgtFeeUnclaimed;

    // Minimum time between epoch updates (e.g., 20 hours)
    uint256 public timeBuffer;

    // First deposit flag, used to check if the user has made a deposit
    mapping(address => bool) public firstDeposit;

    /// @notice KYC manager (single source of truth, shared with Token). Required (non-zero).
    address public kycManager;

    // T+0 Deposit queue (before price is known)
    mapping(address => mapping(address => uint256)) public depositInfo;
    DoubleQueueModified.BytesDeque private depositQueue;

    // T+0 Pending redeem queue (before price is known)
    mapping(address => uint256) public pendingRedeemInfo;
    DoubleQueueModified.BytesDeque private pendingRedeemQueue;

    // T+2 Redeem queue (after price is known)
    mapping(address => uint256) public redeemInfo;
    DoubleQueueModified.BytesDeque private redeemQueue;

    // Delay in seconds before pending requests can be processed (default: 2 days)
    uint256 public convertRedeemRequestsDelay;

    // Aggregate token amount committed to redeem queues (pending + final). Incremented at
    // requestRedeem time, decremented at processRedeemQueue (burn) or cancel time.
    uint256 public totalRedeemQueueTokens;

    // Precision trimming: number of decimals to keep (e.g., 3 means trim to 3 decimals)
    uint8 public trimDecimals;

    // Monotonically increasing nonce for unique queue entry IDs
    uint256 private _nonce;

    // Escrowed token balances for banned users whose cancel redeem refunds could not be transferred directly
    mapping(address => uint256) public redeemEscrowBalance;

    // Escrowed deposit asset balances credited on cancelDeposit; claimable via claimDepositEscrow()
    // user => asset => amount
    mapping(address => mapping(address => uint256)) public depositEscrowBalance;

    // Symmetric oracle deviation tolerance (basis points, BPS_BASE = 10000) for processDepositQueue.
    // 0 = strict equality with oracle; > BPS_BASE rejected by setter. Skipped when priceOracle unset.
    uint256 public depositMaxDeviationBps;

    // Symmetric oracle deviation tolerance (basis points, BPS_BASE = 10000) for processPendingRedeems.
    // 0 = strict equality with oracle; > BPS_BASE rejected by setter. Skipped when priceOracle unset.
    uint256 public redeemMaxDeviationBps;

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
    event UpdateEpoch(uint256 dailyFeeShares, uint256 dailyFeeTokens, uint256 offchainShares);
    event UpdateTimeBuffer(uint256 timeBuffer);
    event UpdatePriceOracle(address indexed priceOracle);
    event UpdateMaxStalePeriod(uint256 maxStalePeriod);
    event UpdateConvertRedeemRequestsDelay(uint256 delay);
    event UpdateTrimDecimals(uint8 decimals);
    event UpdateRedeemAsset(address indexed oldAsset, address indexed newAsset);
    event KycManagerUpdated(address indexed oldManager, address indexed newManager);
    event UpdateDepositMaxDeviationBps(uint256 bps);
    event UpdateRedeemMaxDeviationBps(uint256 bps);

    // Event for adding a deposit request to the queue
    event AddToDepositQueue(
        address asset,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 fee,
        bytes32 indexed id
    );

    // Event for processing a deposit request
    event ProcessDeposit(
        address asset,
        address indexed from,
        address indexed to,
        uint256 netAssets,
        uint256 mintedAmount,
        uint256 feeAmt,
        bytes32 indexed id
    );

    // Event for adding a redeem request to the queue
    event AddToPendingRedeemQueue(
        address indexed from,
        address indexed to,
        uint256 tokenAmount,
        uint256 shareAmount,
        bytes32 indexed id
    );

    // Event for processing a redeem request, after price is known
    event ProcessPendingRedeem(
        address indexed from,
        address indexed to,
        uint256 shareAmount,
        uint256 priceUsed,
        bytes32 indexed pendingId,
        bytes32 finalId
    );

    // Event for canceling a pending redeem request
    event CancelPendingRedeem(address indexed from, address indexed to, uint256 shareAmount, bytes32 indexed id);

    // Event for canceling a deposit request
    event CancelProcessDeposit(
        address asset,
        address indexed from,
        address indexed to,
        uint256 netAssets,
        uint256 feeAmt,
        bytes32 indexed id
    );

    // Event for canceling a redeem request from the final queue
    event CancelProcessRedeem(
        address indexed from,
        address indexed to,
        uint256 netAmount,
        uint256 feeAmt,
        bytes32 indexed id
    );

    // Event for processing a redeem request from the final queue
    event ProcessRedeem(
        address indexed from,
        address indexed to,
        uint256 burnedAmount,
        uint256 redeemAssetOut,
        bytes32 indexed id
    );

    // Event for reverting a redeem request to the pending redeem queue
    event RevertRedeemToPending(
        address indexed from,
        address indexed to,
        uint256 tokenAmount,
        bytes32 indexed oldRedeemId,
        bytes32 newPendingId
    );

    // Event for off-chain redeem (direct burn, off-chain settlement in arbitrary asset)
    event OffchainRedeem(
        address indexed from,
        address indexed to,
        address indexed asset,
        uint256 tokenAmount,
        uint256 shareAmount
    );

    // Event for off-ramping redeem assets to the treasury
    event OffRamp(address indexed to, uint256 amount);
    // Event for updating the first deposit flag
    event UpdateFirstDeposit(address indexed account, bool flag);
    // Event for escrowing tokens when a banned user's cancel redeem refund cannot be transferred
    event RedeemEscrowIn(address indexed account, uint256 amount);
    // Event for claiming escrowed tokens
    event RedeemEscrowOut(address indexed account, uint256 amount);
    // Event for escrowing deposit assets when a banned user's cancel deposit refund cannot be transferred
    event DepositEscrowIn(address indexed account, address indexed asset, uint256 amount);
    // Event for claiming escrowed deposit assets
    event DepositEscrowOut(address indexed account, address indexed asset, uint256 amount);
    // Event for admin override of offchainShares (rare: share splits, reconciliation)
    event UpdateOffchainShares(address indexed caller, uint256 newValue, uint256 previousValue);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidAddress();
    error InvalidAmount();
    error InvalidInput(uint256 input);
    error UpdateTooEarly(uint256 timestamp);
    error NotInKycList(address from, address to);
    error FirstDepositLessThanRequired(uint256 amount, uint256 minimum);
    error EmptyQueue();
    error InvalidPrice(int256 price);
    error StalePriceData(uint256 updatedAt, uint256 currentTime, uint256 maxStalePeriod);
    error IncompleteRound(uint80 answeredInRound, uint80 roundId);
    error NoPendingRedeemsReady();
    error MgtFeeDisabled();
    error QueuesNotEmpty();
    error InsufficientOffchainShares();
    error InsufficientSettlementFunds(uint256 oracleTotal, uint256 suppliedTotal);
    error OracleDeviationExceeded(uint256 actual, uint256 expected, uint256 bps);
    error RedeemAssetNotAllowed();
    error MgtFeeToCannotDirectRedeem();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
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
     * @param _maxStalePeriod Maximum staleness in seconds (e.g., 86400 for 24 hours)
     * @param cfg Deposit and redeem limiter configuration
     * @param _kycManager Address of the KYC manager (required, non-zero; shared with Token)
     * @param _depositMaxDeviationBps Symmetric oracle deviation tolerance for processDepositQueue (BPS)
     * @param _redeemMaxDeviationBps Symmetric oracle deviation tolerance for processPendingRedeems (BPS)
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
        uint256 _maxStalePeriod,
        DepositRedeemLimiterCfg memory cfg,
        address _kycManager,
        uint256 _depositMaxDeviationBps,
        uint256 _redeemMaxDeviationBps
    ) external initializer {
        if (
            admin == address(0) ||
            _token == address(0) ||
            _redeemAsset == address(0) ||
            _treasury == address(0) ||
            _txFeeTo == address(0) ||
            _mgtFeeTo == address(0) ||
            _assetRegistry == address(0) ||
            _priceOracle == address(0) ||
            _kycManager == address(0)
        ) revert InvalidAddress();

        if (_depositMaxDeviationBps > BPS_BASE) revert InvalidInput(_depositMaxDeviationBps);
        if (_redeemMaxDeviationBps > BPS_BASE) revert InvalidInput(_redeemMaxDeviationBps);

        __AccessControlEnumerable_init();

        token = IToken(_token);
        redeemAsset = _redeemAsset;
        treasury = _treasury;
        txFeeTo = _txFeeTo;
        mgtFeeTo = _mgtFeeTo;
        assetRegistry = IAssetRegistry(_assetRegistry);
        priceOracle = IPriceFeed(_priceOracle);
        maxStalePeriod = _maxStalePeriod;
        kycManager = _kycManager;
        depositMaxDeviationBps = _depositMaxDeviationBps;
        redeemMaxDeviationBps = _redeemMaxDeviationBps;

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
        _requireQueuesEmpty();
        priceOracle = IPriceFeed(_address);
        emit UpdatePriceOracle(_address);
    }

    /**
     * @notice Rotate the KycManager. Requires DEFAULT_ADMIN_ROLE and all queues empty.
     * @dev Queue-empty guard: queue processors re-check KYC, so rotating mid-flight could
     *      strand entries whose user is KYC'd in the old manager but not the new.
     */
    function setKycManager(address newManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newManager == address(0)) revert InvalidAddress();
        _requireQueuesEmpty();
        address old = kycManager;
        kycManager = newManager;
        emit KycManagerUpdated(old, newManager);
    }

    /**
     * @notice Update the maximum stale period for price data
     * @param _maxStalePeriod Maximum staleness in seconds (e.g., 86400 for 24 hours)
     */
    function updateMaxStalePeriod(uint256 _maxStalePeriod) external onlyRole(MAINTAINER_ROLE) {
        if (_maxStalePeriod == 0) revert InvalidInput(_maxStalePeriod);
        _requireQueuesEmpty();
        maxStalePeriod = _maxStalePeriod;
        emit UpdateMaxStalePeriod(_maxStalePeriod);
    }

    /**
     * @notice Update the redeem delay for T+2 processing
     * @dev Can be adjusted for holidays (e.g., 2 days → 3 days → back to 2 days).
     *      OPERATIONAL INVARIANT (not enforced on-chain to save gas / bytecode):
     *      do NOT call this while pendingRedeemQueue or redeemQueue is non-empty — changing
     *      the delay retroactively shifts the settlement timing of already-queued entries
     *      relative to what the user saw when they submitted. Maintainers should drain both
     *      redeem queues before adjusting this value.
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
     * @dev Requires all live fee tokens to be redeemed and burned first (totalMgtFeeUnclaimed == 0).
     *      Also requires both redeem queues (pendingRedeemQueue, redeemQueue) to be empty.
     *      In-flight entries from the old mgtFeeTo would carry its address as `from`; on
     *      cancel/revert those branches would fail to match the new mgtFeeTo and skip the
     *      totalMgtFeeUnclaimed decrement, corrupting the live fee tracker.
     * @param _address The new management fee recipient address
     */
    function updateMgtFeeTo(address _address) external onlyRole(MAINTAINER_ROLE) {
        if (_address == address(0)) revert InvalidAddress();
        if (totalMgtFeeUnclaimed != 0) revert InvalidAmount();
        _requireQueuesEmpty();
        mgtFeeTo = _address;
        emit UpdateMgtFeeTo(_address);
    }

    /**
     * @notice Update the redeem asset address
     * @dev Requires all queues (deposit, pendingRedeem, redeem) to be empty to prevent
     *      in-flight requests from being settled in the wrong asset.
     *      Claim escrow mappings (redeemEscrowBalance, depositEscrowBalance) are unaffected
     *      because redeemEscrowBalance holds HYBOND tokens (not redeemAsset) and
     *      depositEscrowBalance is keyed by the original deposit asset.
     * @param _address The new redeem asset address
     */
    function updateRedeemAsset(address _address) external onlyRole(MAINTAINER_ROLE) {
        if (_address == address(0)) revert InvalidAddress();
        if (depositQueue.length() != 0 || pendingRedeemQueue.length() != 0 || redeemQueue.length() != 0) {
            revert QueuesNotEmpty();
        }
        address oldAsset = redeemAsset;
        redeemAsset = _address;
        emit UpdateRedeemAsset(oldAsset, _address);
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
        _requireQueuesEmpty();
        depositFeeRate = _rate;
        emit UpdateDepositFeeRate(_rate);
    }

    /**
     * @notice Update the redeem fee rate
     * @param _rate The new fee rate in basis points
     */
    function updateRedeemFeeRate(uint256 _rate) external onlyRole(MAINTAINER_ROLE) {
        if (_rate >= BPS_BASE) revert InvalidInput(_rate);
        _requireQueuesEmpty();
        redeemFeeRate = _rate;
        emit UpdateRedeemFeeRate(_rate);
    }

    /**
     * @notice Update the management fee rate
     * @param _rate The new management fee rate in basis points (e.g., 300 for 3% annually)
     */
    function updateMgtFeeRate(uint256 _rate) external onlyRole(MAINTAINER_ROLE) {
        if (_rate >= BPS_BASE) revert InvalidInput(_rate);
        mgtFeeRate = _rate;
        emit UpdateMgtFeeRate(_rate);
    }

    /**
     * @notice Update the symmetric oracle deviation tolerance for processDepositQueue
     * @param _bps Deviation tolerance in basis points (0 = strict, max = BPS_BASE)
     */
    function updateDepositMaxDeviationBps(uint256 _bps) external onlyRole(MAINTAINER_ROLE) {
        if (_bps > BPS_BASE) revert InvalidInput(_bps);
        _requireQueuesEmpty();
        depositMaxDeviationBps = _bps;
        emit UpdateDepositMaxDeviationBps(_bps);
    }

    /**
     * @notice Update the symmetric oracle deviation tolerance for processPendingRedeems
     * @param _bps Deviation tolerance in basis points (0 = strict, max = BPS_BASE)
     */
    function updateRedeemMaxDeviationBps(uint256 _bps) external onlyRole(MAINTAINER_ROLE) {
        if (_bps > BPS_BASE) revert InvalidInput(_bps);
        _requireQueuesEmpty();
        redeemMaxDeviationBps = _bps;
        emit UpdateRedeemMaxDeviationBps(_bps);
    }

    /**
     * @notice Update the number of decimals to keep when trimming amounts
     * @param _decimals Number of decimals to keep (0-18)
     */
    function updateTrimDecimals(uint8 _decimals) external onlyRole(MAINTAINER_ROLE) {
        if (_decimals > MAX_DECIMALS) revert InvalidInput(_decimals);
        _requireQueuesEmpty();
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
     * @dev Fee is charged at request time and net assets are forwarded to treasury
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

    // /**
    //  * @notice Not supported. Use requestDeposit instead.
    //  */
    // function requestMint(address, uint256, address) external pure {
    //     revert UseRequestDeposit();
    // }

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

    /**
     * @notice Calculate token mint amount from net asset amount
     * @param _asset Asset token address
     * @param _netAssets Net asset amount (after fees)
     * @return mintAmount Token amount to mint
     */
    function _calculateMintAmount(address _asset, uint256 _netAssets) internal view returns (uint256 mintAmount) {
        uint256 amount = convertFromUnderlying(_asset, _netAssets);
        uint256 price = getPrice();
        uint256 tokenPrice = Math.mulDiv(price, _sharesPerToken(), 1e18);
        mintAmount = _trim(Math.mulDiv(amount, 1e18, tokenPrice));
    }

    /**
     * @notice Get fresh price from price feed with staleness check
     * @return price The fresh price (normalized to 18 decimals)
     */
    function getPrice() public view returns (uint256 price) {
        // If price oracle not set, return 1:1 ratio (1e18)
        if (address(priceOracle) == address(0)) return 1e18;

        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = priceOracle.latestRoundData();

        // Validate price is positive
        if (answer <= 0) revert InvalidPrice(answer);

        // Check for stale price data
        if (block.timestamp - updatedAt > maxStalePeriod)
            revert StalePriceData(updatedAt, block.timestamp, maxStalePeriod);

        // Check for incomplete round data
        if (answeredInRound < roundId) {
            revert IncompleteRound(answeredInRound, roundId);
        }

        // Normalize price to 18 decimals
        uint8 decimals = priceOracle.decimals();
        price = uint256(answer);

        if (decimals < 18) {
            price = price * 10 ** (18 - decimals);
        } else if (decimals > 18) {
            price = price / 10 ** (decimals - 18);
        }
        // If decimals == 18, price remains unchanged
    }

    /**
     * @notice Symmetric oracle deviation guard
     * @dev Reverts if |actual - expected| / expected exceeds bps / BPS_BASE.
     *      No-op when expected == 0 (degenerate; empty batches do not reach this).
     * @param actual Operator-supplied value
     * @param expected Oracle-derived value
     * @param bps Tolerance in basis points (BPS_BASE = 10000)
     */
    function _checkDeviation(uint256 actual, uint256 expected, uint256 bps) internal pure {
        if (expected == 0) return;
        uint256 diff = actual > expected ? actual - expected : expected - actual;
        if (diff * BPS_BASE > expected * bps) {
            revert OracleDeviationExceeded(actual, expected, bps);
        }
    }

    /*//////////////////////////////////////////////////////////////
                           DEPOSIT QUEUE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Process queued deposit requests with pro-rata minting
     * @dev Two-pass algorithm: first pass peeks entries to sum normalized net assets and validate KYC,
     *      then sanity-checks operator-supplied _newShares against the oracle and computes total mint.
     *      Second pass pops and mints pro-rata. This preserves the sharesPerToken ratio exactly
     *      (see design spec for invariance proof).
     * @param _len Number of requests to process (0 = process all)
     * @param _newShares Actual offchain fund shares acquired for this batch (must be >0 when _len >0)
     */
    function processDepositQueue(uint256 _len, uint256 _newShares) external onlyRole(MAINTAINER_ROLE) {
        if (_newShares == 0) revert InvalidAmount();
        _len = _validateQueueProcessing(depositQueue.length(), _len);

        // Capture current ratio before state changes
        uint256 currentRatio = _sharesPerToken();

        // Pop all entries, validate KYC, sum normalized net assets
        uint256 batchTotalNetAssets;
        uint256[] memory normalizedAmounts = new uint256[](_len);
        bytes[] memory entries = new bytes[](_len);

        for (uint256 i = 0; i < _len; ) {
            bytes memory data = depositQueue.front();
            depositQueue.popFront();
            entries[i] = data;

            (address asset, address sender, address receiver, uint256 netAssets, , ) = _decodeDepositData(data);
            _validateKyc(sender, receiver);

            uint256 normalized = convertFromUnderlying(asset, netAssets);
            normalizedAmounts[i] = normalized;
            batchTotalNetAssets += normalized;

            unchecked {
                ++i;
            }
        }

        if (address(priceOracle) != address(0)) {
            uint256 oracleTokens = Math.mulDiv(batchTotalNetAssets, 1e18, getPrice());
            uint256 oracleShares = Math.mulDiv(oracleTokens, _sharesPerToken(), 1e18);
            _checkDeviation(_newShares, oracleShares, depositMaxDeviationBps);
        }

        // Compute total tokens to mint (preserves ratio exactly)
        uint256 mintTotal = Math.mulDiv(_newShares, 1e18, currentRatio);

        // Update offchainShares
        offchainShares += _newShares;

        // Mint pro-rata to each depositor
        for (uint256 i = 0; i < _len; ) {
            (
                address asset,
                address sender,
                address receiver,
                uint256 netAssets,
                uint256 feeAmt,
                bytes32 prevId
            ) = _decodeDepositData(entries[i]);

            depositInfo[receiver][asset] -= netAssets;

            uint256 mintedAmount = _trim(Math.mulDiv(mintTotal, normalizedAmounts[i], batchTotalNetAssets));
            token.mint(receiver, mintedAmount);

            emit ProcessDeposit(asset, sender, receiver, netAssets, mintedAmount, feeAmt, prevId);

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Cancel queued deposit requests and credit refunds to deposit escrow
     * @dev Refund amounts (net + fee) are added to depositEscrowBalance for the sender to claim later
     *      via claimDepositEscrow().
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
     * @param _index Queue index
     * @return asset Asset address
     * @return sender Sender address
     * @return receiver Receiver address
     * @return netAssets Net asset amount queued
     * @return feeAmt Fee collected at request
     * @return id Queue id
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
     * @return Length of deposit queue
     */
    function getDepositQueueLength() external view returns (uint256) {
        return depositQueue.length();
    }

    /*//////////////////////////////////////////////////////////////
                           REDEMPTION QUEUE
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Queue a redeem request for T+2 pricing
     * @dev Request goes to pending queue. offchainShares is decremented immediately to maintain
     *      sharesPerToken invariance. The shareAmount is encoded in the queue entry for
     *      later use in processPendingRedeems (no snapshot needed).
     *
     *      For the mgtFeeTo wallet, the caller-supplied _tokenAmount is IGNORED and
     *      the full live fee balance (totalMgtFeeUnclaimed) is redeemed instead.
     *      totalMgtFeeUnclaimed is zeroed at request time.
     * @param _to The address to receive redeemed asset
     * @param _tokenAmount The amount of tokens to redeem (IGNORED if caller is mgtFeeTo)
     */
    function requestRedeem(address _to, uint256 _tokenAmount) external whenNotPausedRedeem {
        address from = _msgSender();
        _validateKyc(from, _to);

        if (from == mgtFeeTo) {
            if (totalMgtFeeUnclaimed == 0) revert InvalidAmount();
            _tokenAmount = totalMgtFeeUnclaimed;
            totalMgtFeeUnclaimed = 0;
        } else {
            if (_tokenAmount < redeemMinimum) {
                revert RedeemLessThanMinimum(_tokenAmount, redeemMinimum);
            }
        }

        // Convert token amount to offchain shares at current ratio
        uint256 shareAmount = Math.mulDiv(_tokenAmount, _sharesPerToken(), 1e18);

        // Guard: offchainShares must cover the deduction
        if (offchainShares < shareAmount) revert InsufficientOffchainShares();

        // Update accounting — both numerator and denominator change proportionally
        offchainShares -= shareAmount;
        totalRedeemQueueTokens += _tokenAmount;

        // Collect full token amount to contract (burned later in processRedeemQueue)
        IERC20(address(token)).safeTransferFrom(from, address(this), _tokenAmount);

        // Track pending info
        pendingRedeemInfo[_to] += _tokenAmount;

        bytes32 id = keccak256(abi.encode(from, _to, _tokenAmount, shareAmount, block.timestamp, _nonce++));
        bytes memory data = abi.encode(from, _to, _tokenAmount, shareAmount, block.timestamp, id);
        pendingRedeemQueue.pushBack(data);

        emit AddToPendingRedeemQueue(from, _to, _tokenAmount, shareAmount, id);
    }

    /**
     * @notice Redeem HYBOND tokens with off-chain settlement in an arbitrary asset.
     * @dev Burns tokens immediately. The redeem-asset payout is handled fully off-chain;
     *      the contract only emits the burn record for the DB to match against.
     *      No queue, no T+2 delay; fees are applied off-chain at settlement time.
     *
     *      Accounting: decrements offchainShares by the share-equivalent at current ratio.
     *      Does NOT touch totalRedeemQueueTokens (no in-flight tokens — burn is immediate).
     *      _sharesPerToken stays invariant: numerator drops by shareAmount, denominator
     *      drops by _tokenAmount (totalSupply burn), and shareAmount = _tokenAmount * ratio.
     *
     *      The mgtFeeTo wallet is rejected upfront — fee shares must redeem through
     *      requestRedeem only, to keep totalMgtFeeUnclaimed reconciliation clean.
     * @param _asset Informational asset address the user wants to receive off-chain
     *               (e.g. RLUSD). Must be non-zero and not equal to redeemAsset.
     * @param _tokenAmount HYBOND token amount to burn.
     * @param _to KYC'd recipient address recorded for off-chain settlement.
     */
    function requestDirectRedeem(address _asset, uint256 _tokenAmount, address _to) external whenNotPausedRedeem {
        address from = _msgSender();

        if (_tokenAmount == 0) revert InvalidAmount();
        if (_asset == address(0)) revert InvalidAddress();
        if (_asset == redeemAsset) revert RedeemAssetNotAllowed();
        if (from == mgtFeeTo) revert MgtFeeToCannotDirectRedeem();

        _validateKyc(from, _to);

        uint256 shareAmount = Math.mulDiv(_tokenAmount, _sharesPerToken(), 1e18);
        if (offchainShares < shareAmount) revert InsufficientOffchainShares();

        offchainShares -= shareAmount;

        token.burn(from, _tokenAmount);

        emit OffchainRedeem(from, _to, _asset, _tokenAmount, shareAmount);
    }

    // /**
    //  * @notice Not supported. Use requestRedeem instead.
    //  */
    // function requestWithdraw(address, uint256) external pure {
    //     revert UseRequestRedeem();
    // }

    /**
     * @notice Preview redeem request accounting
     * @param _tokenAmount The amount of tokens to redeem
     * @return feeAmt Platform fee amount in redeemAsset
     * @return redeemAssetAmt Gross redeemAsset amount queued before fee deduction
     * @return netRedeemAssetAmt Net redeemAsset amount after fee deduction
     */
    function previewRedeem(
        uint256 _tokenAmount
    ) public view returns (uint256 feeAmt, uint256 redeemAssetAmt, uint256 netRedeemAssetAmt) {
        uint256 price = getPrice();
        redeemAssetAmt = _redeemAssetAmount(_tokenAmount, price);
        feeAmt = txsFee(redeemAssetAmt, TxType.REDEEM);
        netRedeemAssetAmt = redeemAssetAmt - feeAmt;
    }

    /*//////////////////////////////////////////////////////////////
                  PENDING REDEMPTION QUEUE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Process pending redeems with operator-supplied total asset distributed pro-rata
     * @dev Two-pass: Pass 1 pops ready entries, validates KYC, sums shareAmounts, and (if oracle
     *      configured) accumulates oracle-derived expected total. Then deviation-checks
     *      _totalAsset against expectedTotal. Pass 2 distributes _totalAsset pro-rata by
     *      shareAmount and computes per-entry fee on the operator-derived slice.
     *
     *      Stops at the first not-ready entry. If no entries are ready, reverts
     *      NoPendingRedeemsReady. _totalAsset is interpreted relative to the entries actually
     *      processed (not the requested _len).
     * @param _len Number of pending requests to attempt (must be > 0)
     * @param _totalAsset Operator-supplied actual redeem asset pool to distribute pro-rata
     */
    function processPendingRedeems(uint256 _len, uint256 _totalAsset) external onlyRole(OPERATOR_ROLE) {
        bool useOracle = address(priceOracle) != address(0);
        uint256 oraclePrice = useOracle ? getPrice() : 0;

        bytes[] memory entries = new bytes[](_len);
        uint256[] memory shareAmounts = new uint256[](_len);
        uint256 batchTotalShares;
        uint256 expectedTotal;
        uint256 processed;

        // Pass 1: pop ready entries, validate KYC, accumulate
        while (processed < _len && !pendingRedeemQueue.empty()) {
            bytes memory data = pendingRedeemQueue.front();
            (
                address sender,
                address receiver,
                uint256 tokenAmount,
                uint256 shareAmount,
                uint256 requestTimestamp,

            ) = _decodePendingRedeemData(data);

            if (block.timestamp < requestTimestamp + convertRedeemRequestsDelay) {
                break;
            }

            _validateKyc(sender, receiver);

            pendingRedeemQueue.popFront();
            pendingRedeemInfo[receiver] -= tokenAmount;

            entries[processed] = data;
            shareAmounts[processed] = shareAmount;
            batchTotalShares += shareAmount;

            if (useOracle) {
                expectedTotal += _redeemAssetAmount(tokenAmount, oraclePrice);
            }

            unchecked {
                ++processed;
            }
        }

        if (processed == 0) revert NoPendingRedeemsReady();

        // Deviation gate
        if (useOracle) {
            _checkDeviation(_totalAsset, expectedTotal, redeemMaxDeviationBps);
        }

        // Pass 2: distribute _totalAsset pro-rata by shareAmount
        for (uint256 i = 0; i < processed; ) {
            (
                address sender,
                address receiver,
                uint256 tokenAmount,
                uint256 shareAmount,
                uint256 requestTimestamp,
                bytes32 pendingId
            ) = _decodePendingRedeemData(entries[i]);

            uint256 redeemAssetAmt = _trimAsset(
                Math.mulDiv(_totalAsset, shareAmounts[i], batchTotalShares),
                redeemAsset
            );
            uint256 feeAssetAmt = txsFee(redeemAssetAmt, TxType.REDEEM);

            bytes32 finalId = keccak256(
                abi.encode(
                    sender,
                    receiver,
                    tokenAmount,
                    shareAmount,
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
                    tokenAmount,
                    shareAmount,
                    redeemAssetAmt,
                    feeAssetAmt,
                    requestTimestamp,
                    finalId
                )
            );

            redeemInfo[receiver] += tokenAmount;

            emit ProcessPendingRedeem(sender, receiver, tokenAmount, oraclePrice, pendingId, finalId);

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Cancel pending redeem requests and refund full token amount
     * @dev User specified they CANNOT cancel pending redeems - only MAINTAINER can do emergency cancellations
     *      No token fees taken (fees are in redeemAsset).
     *      Restores offchainShares and totalRedeemQueueTokens (reverse of requestRedeem).
     * @param _len Number of pending requests to cancel
     */
    function cancelPendingRedeem(uint256 _len) external onlyRole(MAINTAINER_ROLE) {
        _len = _validateQueueProcessing(pendingRedeemQueue.length(), _len);

        while (_len > 0) {
            bytes memory data = pendingRedeemQueue.popFront();
            (
                address sender,
                address receiver,
                uint256 tokenAmount,
                uint256 shareAmount, // requestTimestamp
                ,
                bytes32 id
            ) = _decodePendingRedeemData(data);

            pendingRedeemInfo[receiver] -= tokenAmount;

            // Restore accounting (reverse of requestRedeem)
            offchainShares += shareAmount;
            totalRedeemQueueTokens -= tokenAmount;

            // Restore mgtFeeUnclaimed if this was a fee redeem
            if (sender == mgtFeeTo) {
                totalMgtFeeUnclaimed += tokenAmount;
            }

            unchecked {
                --_len;
            }

            _refundOrEscrow(sender, tokenAmount);

            emit CancelPendingRedeem(sender, receiver, tokenAmount, id);
        }
    }

    // snapshotPendingRedeemRatio and setSnapshotRatio removed — ratio is now baked into queue entries at requestRedeem time

    /*//////////////////////////////////////////////////////////////
                      REDEMPTION QUEUE MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Process redeem queue with pre-calculated amounts
     * @dev Burns full token amount, splits redeemAsset between user and txFeeTo.
     *      Decrements totalRedeemQueueTokens (token supply decreases by same amount via burn,
     *      keeping the sharesPerToken ratio invariant).
     * @param _len Number of requests to process (0 = process all)
     */
    function processRedeemQueue(uint256 _len) external onlyRole(OPERATOR_ROLE) {
        _len = _validateQueueProcessing(redeemQueue.length(), _len);

        for (uint256 count = 0; count < _len; ) {
            bytes memory data = redeemQueue.front();
            (
                address sender,
                address receiver,
                uint256 tokenAmount, // shareAmount
                ,
                uint256 redeemAssetAmt,
                uint256 feeAssetAmt, // requestTimestamp
                ,
                bytes32 id
            ) = _decodeRedeemData(data);

            _validateKyc(sender, receiver);

            // Check liquidity against total redeemAsset needed
            uint256 availableLiquidity = getTokenBalance(address(redeemAsset));
            if (redeemAssetAmt > availableLiquidity) {
                break;
            }

            redeemQueue.popFront();
            redeemInfo[receiver] -= tokenAmount;
            totalRedeemQueueTokens -= tokenAmount;
            unchecked {
                ++count;
            }

            // Burn full token amount
            token.burn(address(this), tokenAmount);

            // Split redeemAsset: fee to txFeeTo, net to user
            if (feeAssetAmt > 0) {
                if (txFeeTo == address(0)) revert InvalidAddress();
                IERC20(redeemAsset).safeTransfer(txFeeTo, feeAssetAmt);
            }

            uint256 netAssetAmt = redeemAssetAmt - feeAssetAmt;
            IERC20(redeemAsset).safeTransfer(receiver, netAssetAmt);

            emit ProcessRedeem(sender, receiver, tokenAmount, netAssetAmt, id);
        }
    }

    /**
     * @notice Cancel redeem requests and refund full token amount
     * @dev Refunds full amount - no token fees taken (fees are in redeemAsset).
     *      Restores offchainShares and totalRedeemQueueTokens (reverse of requestRedeem).
     * @param _len Number of requests to cancel
     */
    function cancelRedeem(uint256 _len) public onlyRole(MAINTAINER_ROLE) {
        _len = _validateQueueProcessing(redeemQueue.length(), _len);

        while (_len > 0) {
            bytes memory data = redeemQueue.popFront();
            (
                address sender,
                address receiver,
                uint256 tokenAmount,
                uint256 shareAmount, // redeemAssetAmt
                ,
                ,
                ,
                // feeAssetAmt
                // requestTimestamp
                bytes32 id
            ) = _decodeRedeemData(data);

            redeemInfo[receiver] -= tokenAmount;
            totalRedeemQueueTokens -= tokenAmount;

            // Restore offchainShares (reverse of requestRedeem)
            offchainShares += shareAmount;

            // Restore mgtFeeUnclaimed if this was a fee redeem
            if (sender == mgtFeeTo) {
                totalMgtFeeUnclaimed += tokenAmount;
            }

            unchecked {
                --_len;
            }

            _refundOrEscrow(sender, tokenAmount);

            emit CancelProcessRedeem(
                sender,
                receiver,
                tokenAmount,
                0, // No token fee
                id
            );
        }
    }

    /**
     * @notice Claim escrowed tokens from cancelled redemptions that could not be refunded directly
     * @dev Tokens are escrowed when cancel() cannot transfer back to the sender (e.g. sender was banned)
     * @dev Can be called by the escrowed user directly or by an operator on their behalf
     * @param _account Address to claim escrow for (ignored when caller is not OPERATOR_ROLE, uses msg.sender)
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
     * @notice Claim escrowed deposit assets from cancelled deposits that could not be refunded directly
     * @dev Deposit assets are escrowed when cancelDeposit() cannot transfer back to the sender (e.g. sender was banned)
     * @dev Can be called by the escrowed user directly or by an operator on their behalf
     * @param _account Address to claim escrow for (ignored when caller is not OPERATOR_ROLE, uses msg.sender)
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
     * @dev Used when wrong T+2 price was applied - moves items back to pending for repricing.
     *      Simplified: no snapshot migration needed (ratio baked into queue entry at request time).
     *      totalRedeemQueueTokens and offchainShares are NOT modified — they were adjusted at
     *      requestRedeem time and cover both pending and final queue entries.
     * @param _len Number of redeems to revert (0 = revert all)
     */
    function revertRedeemToPending(uint256 _len) external onlyRole(OPERATOR_ROLE) {
        _len = _validateQueueProcessing(redeemQueue.length(), _len);

        for (uint256 i = 0; i < _len; ) {
            bytes memory data = redeemQueue.popBack();
            (
                address sender,
                address receiver,
                uint256 tokenAmount,
                uint256 shareAmount, // redeemAssetAmt
                ,
                ,
                // feeAssetAmt
                uint256 requestTimestamp,
                bytes32 oldId
            ) = _decodeRedeemData(data);

            redeemInfo[receiver] -= tokenAmount;

            bytes32 newPendingId = keccak256(
                abi.encode(sender, receiver, tokenAmount, shareAmount, requestTimestamp, _nonce++)
            );
            pendingRedeemQueue.pushFront(
                abi.encode(sender, receiver, tokenAmount, shareAmount, requestTimestamp, newPendingId)
            );
            pendingRedeemInfo[receiver] += tokenAmount;

            emit RevertRedeemToPending(sender, receiver, tokenAmount, oldId, newPendingId);

            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Get redeem queue information at index
     * @param _index Queue index to query
     * @return sender Sender address
     * @return receiver Receiver address
     * @return tokenAmount Full token amount
     * @return shareAmount Offchain share amount (ratio baked in at request time)
     * @return redeemAssetAmt Pre-calculated redeemAsset amount (from T+2)
     * @return feeAssetAmt Fee amount in redeemAsset
     * @return requestTimestamp Original timestamp from pending queue
     * @return id Redeem ID
     */
    function getRedeemQueueInfo(
        uint256 _index
    )
        public
        view
        returns (
            address sender,
            address receiver,
            uint256 tokenAmount,
            uint256 shareAmount,
            uint256 redeemAssetAmt,
            uint256 feeAssetAmt,
            uint256 requestTimestamp,
            bytes32 id
        )
    {
        if (redeemQueue.empty() || _index > redeemQueue.length() - 1) {
            return (address(0), address(0), 0, 0, 0, 0, 0, 0x0);
        }

        bytes memory data = bytes(redeemQueue.at(_index));
        (
            sender,
            receiver,
            tokenAmount,
            shareAmount,
            redeemAssetAmt,
            feeAssetAmt,
            requestTimestamp,
            id
        ) = _decodeRedeemData(data);
    }

    /**
     * @notice Get redeem queue length
     * @return Length of the redeem queue
     */
    function getRedeemQueueLength() external view returns (uint256) {
        return redeemQueue.length();
    }

    /*//////////////////////////////////////////////////////////////
                    PENDING REDEMPTION QUEUE QUERIES
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Get pending redeem queue info at index
     * @param _index Queue index to query
     * @return sender Sender address
     * @return receiver Receiver address
     * @return tokenAmount Full token amount
     * @return shareAmount Offchain share amount (ratio baked in at request time)
     * @return requestTimestamp Request timestamp
     * @return id Pending redeem ID
     */
    function getPendingRedeemQueueInfo(
        uint256 _index
    )
        external
        view
        returns (
            address sender,
            address receiver,
            uint256 tokenAmount,
            uint256 shareAmount,
            uint256 requestTimestamp,
            bytes32 id
        )
    {
        if (pendingRedeemQueue.empty() || _index > pendingRedeemQueue.length() - 1) {
            return (address(0), address(0), 0, 0, 0, 0x0);
        }
        bytes memory data = bytes(pendingRedeemQueue.at(_index));
        (sender, receiver, tokenAmount, shareAmount, requestTimestamp, id) = _decodePendingRedeemData(data);
    }

    /**
     * @notice Get pending redeem queue length
     * @return Length of pending redeem queue
     */
    function getPendingRedeemQueueLength() external view returns (uint256) {
        return pendingRedeemQueue.length();
    }

    /*//////////////////////////////////////////////////////////////
                         PAUSABLE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Pause deposit operations
     */
    function pauseDeposit() external onlyRole(PAUSE_ROLE) {
        _pauseDeposit();
    }

    /**
     * @notice Unpause deposit operations
     */
    function unpauseDeposit() external onlyRole(PAUSE_ROLE) {
        _unpauseDeposit();
    }

    /**
     * @notice Pause redeem operations
     */
    function pauseRedeem() external onlyRole(PAUSE_ROLE) {
        _pauseRedeem();
    }

    /**
     * @notice Unpause redeem operations
     */
    function unpauseRedeem() external onlyRole(PAUSE_ROLE) {
        _unpauseRedeem();
    }

    /*//////////////////////////////////////////////////////////////
                    DEPOSIT/REDEEM LIMITER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Update deposit minimum amount (in token, 18 decimals)
     * @param _depositMinimum Minimum deposit amount
     */
    function updateDepositMinimum(uint256 _depositMinimum) external onlyRole(MAINTAINER_ROLE) {
        _setDepositMinimum(_depositMinimum);
    }

    /**
     * @notice Update redeem minimum amount (in token, 18 decimals)
     * @param _redeemMinimum Minimum redeem amount
     */
    function updateRedeemMinimum(uint256 _redeemMinimum) external onlyRole(MAINTAINER_ROLE) {
        _setRedeemMinimum(_redeemMinimum);
    }

    /**
     * @notice Update first deposit requirement amount (in token, 18 decimals)
     * @param _amount Required first deposit amount
     */
    function updateFirstDepositAmount(uint256 _amount) external onlyRole(MAINTAINER_ROLE) {
        _setFirstDepositAmount(_amount);
    }

    /**
     * @notice Update first deposit status for an account
     * @param _account Account address
     * @param _flag First deposit status
     */
    function updateFirstDeposit(address _account, bool _flag) external onlyRole(MAINTAINER_ROLE) {
        if (_account == address(0)) revert InvalidAddress();
        firstDeposit[_account] = _flag;
        emit UpdateFirstDeposit(_account, _flag);
    }

    /*//////////////////////////////////////////////////////////////
                         TREASURY MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Transfer redeem asset from contract to treasury
     * @param _amount Amount of redeem asset to transfer
     */
    function offRamp(uint256 _amount) external onlyRole(OPERATOR_ROLE) {
        if (_amount == 0) revert InvalidAmount();
        IERC20(redeemAsset).safeTransfer(treasury, _amount);
        emit OffRamp(treasury, _amount);
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
     * @notice Update epoch and accrue management fees based on offchainShares
     * @dev Fee is charged on the offchain BNY value (the real AUM), not on circulating HYBOND.
     *      This matches how a real-world fund charges mgmt fees on AUM rather than on issued shares.
     *      Can only be called after timeBuffer has elapsed since last update.
     */
    function updateEpoch() external onlyRole(OPERATOR_ROLE) {
        if (mgtFeeRate == 0) revert MgtFeeDisabled();
        if (offchainShares == 0) revert InvalidAmount();
        if (mgtFeeTo == address(0)) revert InvalidAddress();

        if (lastUpdateTS != 0 && block.timestamp < lastUpdateTS + timeBuffer) {
            revert UpdateTooEarly(block.timestamp);
        }

        uint256 dailyFeeShares = _calculateDailyMgtFee(offchainShares);
        uint256 ratio = _sharesPerToken();
        uint256 dailyFeeTokens = _trim(Math.mulDiv(dailyFeeShares, 1e18, ratio));
        if (dailyFeeTokens > 0) {
            totalMgtFeeUnclaimed += dailyFeeTokens;
            token.mint(mgtFeeTo, dailyFeeTokens);
        }

        lastUpdateTS = block.timestamp;
        emit UpdateEpoch(dailyFeeShares, dailyFeeTokens, offchainShares);
    }

    /**
     * @notice Update the minimum time buffer between epoch updates
     * @param _timeBuffer Time buffer in seconds (e.g., 72000 for 20 hours)
     */
    function updateTimeBuffer(uint256 _timeBuffer) external onlyRole(MAINTAINER_ROLE) {
        timeBuffer = _timeBuffer;
        emit UpdateTimeBuffer(_timeBuffer);
    }

    /**
     * @notice Get circulating token supply
     * @dev Circulating = Total Supply - Tokens committed to redeem queues (pending + final) - Live mgt fee tokens.
     *      totalRedeemQueueTokens is incremented at requestRedeem time, covering both pending and final queues.
     * @return supply Circulating token supply
     */
    function circulatingSupply() public view returns (uint256 supply) {
        uint256 totalSupply = IERC20(address(token)).totalSupply();
        supply = totalSupply - totalRedeemQueueTokens - totalMgtFeeUnclaimed;
    }

    /**
     * @notice Get shares per token ratio
     * @dev Shares per Token = Circulating Supply / Total Supply (scaled by 1e18)
     * @return ratio Shares per token in 1e18 precision
     */
    function sharesPerToken() external view returns (uint256 ratio) {
        ratio = _sharesPerToken();
    }

    /*//////////////////////////////////////////////////////////////
                    OFFCHAIN SHARES MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Admin override for rare events (share splits, reconciliation).
     * @dev Should almost never be called. Use only for error correction or corporate actions.
     *      offchainShares is normally maintained automatically by processDepositQueue (increment)
     *      and requestRedeem (decrement).
     * @param _newValue The new offchainShares value
     */
    function updateOffchainShares(uint256 _newValue) external onlyRole(MAINTAINER_ROLE) {
        _requireQueuesEmpty();
        uint256 previous = offchainShares;
        offchainShares = _newValue;
        emit UpdateOffchainShares(_msgSender(), _newValue, previous);
    }

    /*//////////////////////////////////////////////////////////////
                        CONVERSION HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Convert asset token amount to token amount
     * @param _token Asset token address (e.g., USDC, USDO)
     * @param _amount Amount of asset token
     * @return amount Equivalent token amount
     */
    function convertFromUnderlying(address _token, uint256 _amount) public view returns (uint256 amount) {
        return assetRegistry.convertFromUnderlying(_token, _amount);
    }

    /**
     * @notice Convert token amount to asset token amount
     * @param _token Asset token address (e.g., USDC, USDO)
     * @param _amount Amount of token
     * @return amount Equivalent asset token amount
     */
    function convertToUnderlying(address _token, uint256 _amount) public view returns (uint256 amount) {
        return assetRegistry.convertToUnderlying(_token, _amount);
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Refund tokens to sender, or escrow if sender is banned
     * @param _sender Address to refund
     * @param _amount Amount of tokens to refund
     */
    /**
     * @notice Revert if any queue (deposit, pending redeem, redeem) is non-empty
     * @dev Guards parameter changes that would retroactively affect queued entries
     */
    function _requireQueuesEmpty() internal view {
        if (depositQueue.length() != 0 || pendingRedeemQueue.length() != 0 || redeemQueue.length() != 0) {
            revert QueuesNotEmpty();
        }
    }

    /**
     * @notice Refund tokens to sender, or escrow if sender is banned or not kyced
     * @param _sender Address to refund
     * @param _amount Amount of tokens to refund
     */
    function _refundOrEscrow(address _sender, uint256 _amount) internal {
        bool blocked = token.isBanned(_sender);
        if (!blocked && kycManager != address(0)) {
            blocked = !IKycManager(kycManager).isKyced(_sender);
        }
        if (blocked) {
            redeemEscrowBalance[_sender] += _amount;
            emit RedeemEscrowIn(_sender, _amount);
        } else {
            IERC20(address(token)).safeTransfer(_sender, _amount);
        }
    }

    /**
     * @notice Validate KYC for sender and receiver via the configured KycManager
     * @param _sender Sender address
     * @param _receiver Receiver address
     */
    function _validateKyc(address _sender, address _receiver) internal view {
        IKycManager mgr = IKycManager(kycManager);
        if (!mgr.isKyced(_sender) || !mgr.isKyced(_receiver)) {
            revert NotInKycList(_sender, _receiver);
        }
    }

    /**
     * @notice Validate queue processing parameters
     * @param _queueLength Current queue length
     * @param _len Requested processing length (0 = all)
     * @return len Validated processing length
     */
    function _validateQueueProcessing(uint256 _queueLength, uint256 _len) internal pure returns (uint256 len) {
        if (_queueLength == 0) revert EmptyQueue();
        if (_len > _queueLength) revert InvalidInput(_len);
        len = _len == 0 ? _queueLength : _len;
    }

    /**
     * @notice Calculate daily management fee from a base amount (typically offchainShares)
     * @param _base The AUM base to charge the annualized rate against
     * @return fee Daily management fee amount
     */
    function _calculateDailyMgtFee(uint256 _base) internal view returns (uint256 fee) {
        fee = Math.mulDiv(_base, mgtFeeRate, DAYS_IN_YEAR * BPS_BASE);
    }

    /**
     * @notice Calculate the current shares-per-token ratio in 1e18 precision
     * @dev Formula: offchainShares / (totalSupply - totalRedeemQueueTokens), scaled by 1e18.
     *      Denominator excludes tokens committed to both pending and final redeem queues
     *      (totalRedeemQueueTokens is incremented at requestRedeem time, covering both).
     *
     *      Returns the 1e18 fallback when either denom is zero (bootstrap / full exit) or
     *      offchainShares has not yet been set (pre-first-sync). In the pre-sync window
     *      deposits and redeems settle at 1:1 against the underlying asset.
     *      updateEpoch is a no-op in this window because dailyFee = offchainShares * rate = 0.
     */
    function _sharesPerToken() internal view returns (uint256 ratio) {
        uint256 totalSupply = IERC20(address(token)).totalSupply();
        uint256 denom = totalSupply - totalRedeemQueueTokens;
        if (offchainShares == 0 || denom == 0) return 1e18;
        ratio = Math.mulDiv(offchainShares, 1e18, denom);
    }

    /**
     * @notice Convert an 18-decimal HYBOND-denominated amount to redeem asset using a price
     * @dev Unit-agnostic: the input may be tokens or shares depending on the caller. The
     *      `_price` must match the unit of `_amount18` (tokenPrice for tokens, sharePrice for shares).
     * @param _amount18 18-decimal HYBOND-denominated amount (tokens or shares, depending on caller)
     * @param _price Price in 1e18 precision
     */
    function _redeemAssetAmount(uint256 _amount18, uint256 _price) internal view returns (uint256 redeemAssetAmt) {
        redeemAssetAmt = _trimAsset(
            Math.mulDiv(convertToUnderlying(redeemAsset, _amount18), _price, 1e18),
            redeemAsset
        );
    }

    /**
     * @notice Truncate an 18-decimal value to trimDecimals places (round down)
     * @dev If trimDecimals is 0 (unset), returns the value unchanged
     * @param _value The value to truncate
     * @return The truncated value
     */
    function _trim(uint256 _value) internal view returns (uint256) {
        if (trimDecimals == 0 || trimDecimals >= 18) return _value;
        uint256 factor = 10 ** (18 - trimDecimals);
        return (_value / factor) * factor;
    }

    function _trimAsset(uint256 _value, address _asset) internal view returns (uint256) {
        uint8 assetDecimals = IERC20Metadata(_asset).decimals();
        if (trimDecimals == 0 || trimDecimals >= assetDecimals) return _value;
        uint256 factor = 10 ** (assetDecimals - trimDecimals);
        return (_value / factor) * factor;
    }

    /**
     * @notice Decode deposit queue data
     * @param _data Encoded deposit data
     * @return asset Asset address
     * @return sender Sender address
     * @return receiver Receiver address
     * @return netAssets Net asset amount
     * @return feeAmt Fee amount
     * @return id Queue entry ID
     */
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

    /**
     * @notice Decode redeem queue data (8 fields - includes shareAmount, redeemAssetAmt, feeAssetAmt, and requestTimestamp)
     * @param _data Encoded redeem data
     * @return sender Sender address
     * @return receiver Receiver address
     * @return tokenAmount Full token amount (no fee deduction)
     * @return shareAmount Offchain share amount (ratio baked in at request time)
     * @return redeemAssetAmt Pre-calculated redeemAsset amount (from T+2 pricing)
     * @return feeAssetAmt Fee amount in redeemAsset
     * @return requestTimestamp Original timestamp from pending queue
     * @return id Queue entry ID
     */
    function _decodeRedeemData(
        bytes memory _data
    )
        internal
        pure
        returns (
            address sender,
            address receiver,
            uint256 tokenAmount,
            uint256 shareAmount,
            uint256 redeemAssetAmt,
            uint256 feeAssetAmt,
            uint256 requestTimestamp,
            bytes32 id
        )
    {
        (sender, receiver, tokenAmount, shareAmount, redeemAssetAmt, feeAssetAmt, requestTimestamp, id) = abi.decode(
            _data,
            (address, address, uint256, uint256, uint256, uint256, uint256, bytes32)
        );
    }

    /**
     * @notice Decode pending redeem queue data
     * @param _data Encoded pending redeem data
     * @return sender Sender address
     * @return receiver Receiver address
     * @return tokenAmount Full token amount (no fee deduction)
     * @return shareAmount Offchain share amount (ratio baked in at request time)
     * @return requestTimestamp Timestamp of redeem request
     * @return id Queue entry ID
     */
    function _decodePendingRedeemData(
        bytes memory _data
    )
        internal
        pure
        returns (
            address sender,
            address receiver,
            uint256 tokenAmount,
            uint256 shareAmount,
            uint256 requestTimestamp,
            bytes32 id
        )
    {
        (sender, receiver, tokenAmount, shareAmount, requestTimestamp, id) = abi.decode(
            _data,
            (address, address, uint256, uint256, uint256, bytes32)
        );
    }

    /*//////////////////////////////////////////////////////////////
                             UPGRADEABILITY
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Authorize upgrade to new implementation
     * @param _newImplementation Address of new implementation
     */
    function _authorizeUpgrade(address _newImplementation) internal view override onlyRole(UPGRADE_ROLE) {
        if (_newImplementation == address(0)) revert InvalidAddress();
    }

    /**
     * @notice Get contract version
     * @return Version string
     */
    function version() external pure returns (string memory) {
        return "1.0.0";
    }

    /*//////////////////////////////////////////////////////////////
                            STORAGE GAP
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Storage gap for future upgrades
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[33] private __gap;
}
