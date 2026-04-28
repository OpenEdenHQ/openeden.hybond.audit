# KycManager Design — Centralize KYC for Token and Express

**Date:** 2026-04-28
**Status:** Approved (pending user spec review)
**Scope:** New `KycManager` contract; `Token.sol` gains optional KYC gating on transfers; `Express.sol` migrates its in-contract KYC list to read from `KycManager`.

## Motivation

Today, KYC is owned by Express (`kycList` mapping + `WHITELIST_ROLE` + bulk grant/revoke). Token has no KYC awareness — transfers are gated only by ban list and pause. To make Token a permission token (transferable only between KYC'd addresses) without duplicating state, KYC should live in a single contract that both Token and Express consult.

A second goal: support both **permissioned** and **permissionless** Token deployments from the same codebase. Whether KYC gates transfers becomes a deploy-time choice (whether `Token.kycManager` is set), independent of Express's KYC setup.

This is a fresh deployment — no upgrade-compatibility constraints.

## Architecture

```
KycManager  ◄────────  Token   (optional consumer; permissionless if kycManager == 0)
     ▲
     └─────────────  Express  (required consumer; rejects zero address)
```

- `KycManager` is the single source of truth for KYC state.
- `Token` reads it on every `_update` (mint/burn/transfer) **only when configured**.
- `Express` reads it on deposit/redeem request submission and on every queue-processing pass.
- The two contracts hold independent `kycManager` references. In practice they point at the same instance, but Token can be left at zero for a permissionless ERC20 while Express remains permissioned.

## Component 1: `contracts/core/KycManager.sol`

**Inheritance:** `AccessControlEnumerableUpgradeable`, `UUPSUpgradeable`.

**Roles:**
- `DEFAULT_ADMIN_ROLE` — manages roles, authorizes upgrades.
- `WHITELIST_ROLE` — grants/revokes KYC.

**State:**
```solidity
mapping(address => bool) private _kycList;
uint256[49] private __gap;
```

**Functions:**
```solidity
function initialize(address admin) public initializer;

function grantKyc(address account) external onlyRole(WHITELIST_ROLE);
function revokeKyc(address account) external onlyRole(WHITELIST_ROLE);
function grantKycBulk(address[] calldata accounts) external onlyRole(WHITELIST_ROLE);
function revokeKycBulk(address[] calldata accounts) external onlyRole(WHITELIST_ROLE);

function isKyced(address account) external view returns (bool);

function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE);
```

**Events:**
```solidity
event KycGranted(address indexed account);
event KycRevoked(address indexed account);
```

**Errors:**
```solidity
error InvalidAddress();
error AlreadyKyced(address account);
error NotKyced(address account);
```

**Behavior:**
- `initialize(admin)` reverts on `admin == address(0)`, grants `DEFAULT_ADMIN_ROLE` to `admin`. `WHITELIST_ROLE` is granted separately by admin.
- `grantKyc` reverts with `AlreadyKyced` if already KYC'd. `revokeKyc` reverts with `NotKyced` if not currently KYC'd. Bulk variants apply the same per-entry checks (so a duplicate in a batch reverts the whole batch — no silent skips).
- Each grant/revoke emits one event per account.
- No batch size cap. Operators control batch sizes; gas is the natural limit.

## Component 2: `contracts/interfaces/IKycManager.sol`

```solidity
interface IKycManager {
    function isKyced(address account) external view returns (bool);
}
```

Imported by Token and Express. Keeps the dependency surface narrow.

## Component 3: `Token.sol` changes

**New state (no upgrade compat needed — fresh contract):**
```solidity
address public kycManager;   // address(0) = permissionless
```

**`initialize` signature gains a parameter:**
```solidity
function initialize(
    string memory _name,
    string memory _symbol,
    address _admin,
    uint256 _issueCap,
    address _kycManager   // pass address(0) for permissionless mode
) public initializer;
```
No zero-address check on `_kycManager` — permissionless is a legitimate mode.

**New admin setter:**
```solidity
function setKycManager(address newManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
    address old = kycManager;
    kycManager = newManager;
    emit KycManagerUpdated(old, newManager);
}
```
Allows rotation, including back to zero (re-permissionless).

**`_update` gains a KYC gate:**
```solidity
function _update(address from, address to, uint256 amount)
    internal override(ERC20Upgradeable, ERC20PausableUpgradeable)
{
    if (from != address(0) && isBanned(from)) revert BannedSender(from);
    if (to != address(0) && isBanned(to)) revert BannedRecipient(to);

    address mgr = kycManager;
    if (mgr != address(0)) {
        if (from != address(0) && !IKycManager(mgr).isKyced(from)) revert NotKyced(from);
        if (to != address(0) && !IKycManager(mgr).isKyced(to)) revert NotKyced(to);
    }

    super._update(from, to, amount);
}
```

Strict mode: both `from` and `to` must be KYC'd, including mint (`from == 0` exempt) and burn (`to == 0` exempt). If `isKyced` reverts, the revert bubbles up — broken manager = halted token.

**New event / error:**
```solidity
event KycManagerUpdated(address indexed oldManager, address indexed newManager);
error NotKyced(address account);
```

## Component 4: `Express.sol` changes

**Removed (no upgrade compat — fresh contract):**
- `bytes32 public constant WHITELIST_ROLE`.
- `mapping(address => bool) public kycList`.
- `function grantKycInBulk(address[] calldata)`.
- `function revokeKycInBulk(address[] calldata)`.
- The "KYC granted/revoked in bulk" events.
- All references to `kycList` in `_validateKyc` and elsewhere.

**Added:**
```solidity
address public kycManager;

event KycManagerUpdated(address indexed oldManager, address indexed newManager);
```

**`initialize` gains a parameter and rejects zero:**
```solidity
function initialize(
    ...,
    address _kycManager
) public initializer {
    ...
    if (_kycManager == address(0)) revert InvalidAddress();
    kycManager = _kycManager;
}
```

**Setter, gated by empty queues:**
```solidity
function setKycManager(address newManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (newManager == address(0)) revert InvalidAddress();
    if (depositQueue.length() != 0) revert NonEmptyQueue();
    if (redeemQueue.length() != 0) revert NonEmptyQueue();
    if (pendingRedeemQueue.length() != 0) revert NonEmptyQueue();

    address old = kycManager;
    kycManager = newManager;
    emit KycManagerUpdated(old, newManager);
}
```
(Use the existing queue-empty error type if one already exists; otherwise add `NonEmptyQueue()`.)

Rationale: queue processors re-check KYC. A rotation between `requestDeposit` and `processDepositQueue` can permanently strand entries whose user is KYC'd in the old manager but not the new. Same invariant style as `updateMgtFeeTo`.

**`_validateKyc` rewritten:**
```solidity
function _validateKyc(address sender, address receiver) internal view {
    IKycManager mgr = IKycManager(kycManager);
    if (!mgr.isKyced(sender) || !mgr.isKyced(receiver)) {
        revert NotInKycList(sender, receiver);
    }
}
```
No null-check — Express requires a manager (enforced at init and on setter).

All existing call-sites (request submission and queue-processing re-validation) keep working unchanged.

## Component 5: Deployment

**New deploy tag:** `kyc_manager`.

**Order in `hybond_all`:**
1. MockERC20 (testing only).
2. KycManager (UUPS proxy + initialize).
3. Token (UUPS proxy + initialize, passing `kycManager.address` for permissioned mode or `address(0)` for permissionless — driven by `TOKEN_PERMISSIONED` env flag).
4. AssetRegistry.
5. PriceOracle.
6. Express (UUPS proxy + initialize, passing `kycManager.address` — always non-zero).
7. Post-deploy wiring: grant `MINTER_ROLE`/`BURNER_ROLE` on Token to Express; grant `WHITELIST_ROLE` on KycManager to the operational signer.

**Env flag:** `TOKEN_PERMISSIONED=true|false` (default `true`). Controls whether Token's `_kycManager` arg is the deployed `KycManager` or `address(0)`.

## Component 6: Tests

**New: `test/unit/KycManager.test.ts`**
- Initialization: admin set, zero-admin rejected.
- Role enforcement: only `WHITELIST_ROLE` can grant/revoke. Only `DEFAULT_ADMIN_ROLE` can authorize upgrades.
- `grantKyc` / `revokeKyc`: state changes, events, `AlreadyKyced` / `NotKyced` reverts.
- Bulk variants: success path, per-entry failure reverts whole batch.
- `isKyced` correctness.
- Upgrade flow via UUPS.

**Updated: `test/unit/Token.test.ts`**
- Permissionless mode (`kycManager == 0`): all transfers/mints/burns work as before. (Existing test suite should pass unchanged when fixtures pass `address(0)`.)
- Permissioned mode:
  - Transfer between two KYC'd addresses succeeds.
  - Transfer from non-KYC'd sender reverts with `NotKyced`.
  - Transfer to non-KYC'd receiver reverts with `NotKyced`.
  - Mint to non-KYC'd address reverts.
  - Burn from non-KYC'd address reverts.
  - Ban + KYC interaction: ban check fires before KYC check (existing order preserved).
- `setKycManager`: admin-only; zero address allowed; `KycManagerUpdated` event.
- Manager revert bubbles up: deploy a manager mock that reverts `isKyced` and verify transfer fails with the mock's error.

**Updated: `test/unit/Express.comprehensive.test.ts`**
- Remove all writes to Express's old `kycList`. Drive KYC by calling `kycManager.grantKyc` / `revokeKyc` instead.
- All existing deposit/redeem KYC scenarios should still pass against the new wiring.
- Rotation invariant: `setKycManager` succeeds only when all three queues are empty; reverts otherwise.
- Initializer rejects `_kycManager == address(0)`.
- Removal coverage: no `WHITELIST_ROLE`, no `grantKycInBulk`/`revokeKycInBulk` selectors.

**Fixtures:** `test/fixtures/` deploy helpers gain a `KycManager` and KYC'd test addresses by default.

## Open Items / Non-goals

- **No migration path.** Pre-launch — there is no existing population of KYC'd addresses to migrate.
- **No `Ownable2Step`.** Role-based access already provides the safety net; ownership transfer is via role grants/revokes.
- **No batch size cap on KycManager.** Add later if a real-world batch hits the block gas limit.
- **No off-chain index changes** scoped here. If indexers track Express's `KycGrantedInBulk` / `KycRevokedInBulk` events, they must switch to `KycManager`'s `KycGranted` / `KycRevoked` events. Out of scope for this spec.

## Storage Layout

Fresh deployment — no in-place upgrade compatibility constraints. Standard upgrade-safe hygiene still applies for future versions:
- `KycManager`: `_kycList` mapping + `__gap[49]` (one slot reserved for the mapping).
- `Token`: append `address public kycManager` after existing state; shrink `__gap` from `[45]` to `[44]`.
- `Express`: delete `kycList` mapping; append `address public kycManager`; shrink `__gap` accordingly (exact size pinned during implementation against the current Express storage map).

If a future change ever turns this into a live upgrade rather than a fresh deploy, the design needs revisiting (orphan-mapping retention for Express, no `initialize` signature change for Token, etc). Out of scope here.
