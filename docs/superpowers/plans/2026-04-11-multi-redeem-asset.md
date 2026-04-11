# Multi-Asset Redemption Implementation Plan

**Goal:** Enable users to choose which asset (USDC, USDT, DAI) they receive when redeeming HYBOND tokens, replacing the single global `redeemAsset`.

**Architecture:** Encode the user's chosen redeem asset into queue data at `requestRedeem` time. The asset flows through all 3 phases (pending queue, final queue, processing). Break-early on insufficient liquidity (FIFO). No skip logic, no liability tracking. Operator manages liquidity operationally.

**Tech Stack:** Solidity 0.8.22, Hardhat, ethers-v6, OpenZeppelin upgradeable contracts, Mocha/Chai tests

**Spec:** `docs/superpowers/specs/2026-04-11-multi-redeem-asset-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `contracts/interfaces/IAssetRegistry.sol` | Modify | Add `isRedeemable` to `AssetConfig`, add `isAssetRedeemable()` view |
| `contracts/extension/AssetRegistry.sol` | Modify | Implement `isAssetRedeemable()`, update `setAssetConfig` for new struct field |
| `contracts/extension/Express.sol` | Modify | All redeem flow changes, deprecate `redeemAsset`, events/errors |
| `contracts/extension/ExpressLib.sol` | Modify | Update `redeemAssetAmount` to accept `_redeemAsset` parameter |
| `test/unit/AssetRegistry.test.ts` | Modify | Tests for `isRedeemable` flag |
| `test/unit/Express.multiRedeem.test.ts` | Create | Multi-asset redemption tests |
| `test/unit/Express.comprehensive.test.ts` | Modify | Update call signatures |
| `test/unit/Express.sharePerToken.test.ts` | Modify | Update call signatures |
| `test/fixtures/expressDeployments.ts` | Modify | Add second mock ERC20 (USDT), configure `isRedeemable` |
| `deploy/00_deploy_hybond_all.ts` | Modify | Pass `isRedeemable` in `setAssetConfig` calls |

---

## Task 1: AssetRegistry — Add `isRedeemable` Flag

**Status:** Done

**Files:**
- `contracts/interfaces/IAssetRegistry.sol` — Add `isRedeemable` to `AssetConfig` struct, add `isAssetRedeemable()` to interface
- `contracts/extension/AssetRegistry.sol` — Implement `isAssetRedeemable()`
- `test/unit/AssetRegistry.test.ts` — Tests for new flag

**Changes:**
- [x] Add `bool isRedeemable` to `AssetConfig` struct
- [x] Add `isAssetRedeemable(address) returns (bool)` view function
- [x] Update all existing `setAssetConfig` calls in tests to include `isRedeemable: true`
- [x] Run tests to verify

---

## Task 2: Express — State Variable and Signature Changes

**Status:** Done

**Files:**
- `contracts/extension/Express.sol`

**Changes:**
- [x] Deprecate `address public redeemAsset` slot (keep for storage layout, stop reading)
- [x] Remove `updateRedeemAsset()` function
- [x] Remove `UpdateRedeemAsset` event
- [x] Add `error AssetNotRedeemable(address asset)`
- [x] Update event signatures to include `address redeemAsset`: `AddToPendingRedeemQueue`, `ProcessPendingRedeem`, `ProcessRedeem`, `OffRamp`
- [x] Add `reinitializeV2()` with queue-emptiness assertions (safety net, not primary guard)
- [x] `__gap` remains `[38]` — no new state variables added

---

## Task 3: Express — Update Queue Encoding/Decoding

**Status:** Done

**Files:**
- `contracts/extension/Express.sol` — decode functions

**Changes:**
- [x] `_decodePendingRedeemData`: 5 fields → 6 fields (add `redeemAssetAddr`)
- [x] `_decodeRedeemData`: 7 fields → 8 fields (add `redeemAssetAddr`)
- [x] Update all `abi.encode` calls for pending and final redeem queue data

---

## Task 4: Express — Update `requestRedeem` and `previewRedeem`

**Status:** Done

**Changes:**
- [x] `requestRedeem(address _to, uint256 _shareAmount, address _redeemAsset)` — add asset validation (`isAssetSupported`, `isAssetRedeemable`), encode asset into pending queue
- [x] `previewRedeem(uint256 _shareAmount, address _redeemAsset)` — pass asset to `_redeemAssetAmount`
- [x] `_redeemAssetAmount` — add `address _redeemAsset` parameter, pass to `convertToUnderlying` and `_trimAsset`

---

## Task 5: Express — Update `processPendingRedeems`

**Status:** Done

**Changes:**
- [x] Decode `redeemAssetAddr` from each pending queue item
- [x] Pass `redeemAssetAddr` to `_redeemAssetAmount` (replaces global `redeemAsset`)
- [x] Encode `redeemAssetAddr` into final redeem queue data (8 fields)
- [x] Break-early on T+N delay (unchanged — pending queue is time-ordered)
- [x] No skip-and-continue — operator guarantees registry stability

---

## Task 6: Express — Update `processRedeemQueue`

**Status:** Done

**Changes:**
- [x] Decode `redeemAssetAddr` from each final queue item
- [x] Per-item liquidity check: `IERC20(redeemAssetAddr).balanceOf(address(this))`
- [x] Break-early if insufficient liquidity (FIFO, no skip)
- [x] Per-item asset transfers: fee to `txFeeTo`, net to `receiver`
- [x] `delete snapshotRatios[id]` after processing
- [x] Use `front()`/`popFront()` pattern (peek before committing)

---

## Task 7: Express — Update Cancel, Revert, View, and offRamp

**Status:** Done

**Changes:**
- [x] `cancelPendingRedeem` — decode 6 fields (add `redeemAssetAddr`), no behavioral change
- [x] `cancelRedeem` — decode 8 fields (add `redeemAssetAddr`), `delete snapshotRatios[id]`
- [x] `revertRedeemToPending` — decode `redeemAssetAddr` from final queue, encode into new pending data, migrate snapshot ratio (`snapshotRatios[newPendingId] = snapshotRatios[oldId]`), delete old
- [x] `getRedeemQueueInfo` — return `redeemAssetAddr` as additional field
- [x] `getPendingRedeemQueueInfo` — return `redeemAssetAddr` as additional field
- [x] `offRamp(address _asset, uint256 _amount)` — no guards, operator has full flexibility to move funds

---

## Task 8: Update Test Fixtures and Existing Tests

**Status:** Done

**Files:**
- `test/fixtures/expressDeployments.ts` — add `isRedeemable` to `setAssetConfig`, add USDT mock
- `test/unit/Express.comprehensive.test.ts` — update `requestRedeem`, `processPendingRedeems`, `processRedeemQueue`, `offRamp` call signatures
- `test/unit/Express.sharePerToken.test.ts` — update call signatures

**Changes:**
- [x] Add `isRedeemable: true` to fixture `setAssetConfig` call
- [x] Add second mock ERC20 (USDT) to fixture
- [x] Update all `requestRedeem(to, amount)` → `requestRedeem(to, amount, redeemAsset)`
- [x] Update all `previewRedeem(amount)` → `previewRedeem(amount, redeemAsset)`
- [x] Update all `processRedeemQueue(n)` — signature unchanged (single param)
- [x] Update all `processPendingRedeems(n)` — signature unchanged (single param)
- [x] Update all `offRamp(amount)` → `offRamp(asset, amount)`

---

## Task 9: Write Multi-Asset Redemption Tests

**Status:** Done

**File:** `test/unit/Express.multiRedeem.test.ts`

**Tests written:**
- [x] `requestRedeem` with valid redeemable asset — emits event with correct asset
- [x] `requestRedeem` reverts for non-redeemable asset (`AssetNotRedeemable`)
- [x] `requestRedeem` reverts for unsupported asset (`InvalidAddress`)
- [x] Full redeem flow with USDT (non-default asset) — request → pending → process → redeem
- [x] `processRedeemQueue` break-early on insufficient liquidity
- [x] `offRamp` with asset parameter — transfers correct asset to treasury
- [x] `cancelPendingRedeem` and `cancelRedeem` with multi-asset queue items

---

## Task 10: Update Deployment Scripts

**Status:** Done

**File:** `deploy/00_deploy_hybond_all.ts`

**Changes:**
- [x] Add `isRedeemable: true` to `setAssetConfig` calls
- [x] Verify compilation

---

## Task 11: Final Verification

**Status:** Done

- [x] `npx hardhat compile --force` — clean compilation
- [x] `npx hardhat test` — 283 passing, 0 failing
- [x] Contract size under 24KB limit
