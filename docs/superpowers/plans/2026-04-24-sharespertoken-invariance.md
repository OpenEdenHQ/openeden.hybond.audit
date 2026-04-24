# sharesPerToken Invariance Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sharesPerToken` invariant during deposit and redeem operations by automatically maintaining `offchainShares` in `processDepositQueue` and `requestRedeem`, eliminating the propose/confirm flow and snapshot ratios.

**Architecture:** Refactor `Express.sol` to update `offchainShares` proportionally during deposit (increment) and redeem (decrement), rename `totalRedeemQueueShares` to `totalRedeemQueueTokens` (incremented at request time, not process time), remove propose/confirm + snapshot machinery, simplify `revertRedeemToPending`. All queue entry encodings change to carry both `tokenAmount` and `offchainShareAmount`.

**Tech Stack:** Solidity 0.8.22, Hardhat, ethers-v6, Chai, hardhat-network-helpers

**Spec:** `docs/superpowers/specs/2026-04-24-sharespertoken-invariance-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `contracts/extension/Express.sol` | Modify | All contract changes: remove propose/confirm, snapshots; modify queue functions; rename state var; add `updateOffchainShares` |
| `test/fixtures/expressDeployments.ts` | Modify | Update `bootstrapAndSeedOffchainShares` to use new `processDepositQueue(len, newShares)` instead of propose/confirm. Remove `CONFIRM_ROLE` setup. |
| `test/unit/Express.OffchainShares.test.ts` | Rewrite | Replace propose/confirm tests with `updateOffchainShares` admin override tests |
| `test/unit/Express.sharePerToken.test.ts` | Rewrite | Update all helpers and tests for new function signatures; add ratio invariance assertions |
| `test/unit/Express.comprehensive.test.ts` | Modify | Update `seedOffchainShares` helper and all call sites for new signatures |
| `test/unit/Express.mgtFeeAccounting.test.ts` | Rewrite | Update for new signatures; add M-1 double-redeem regression test |
| `test/integration/DailyRoutine.test.ts` | Rewrite | Update daily routine flow for new function signatures and removed steps |
| `test/unit/Express.invariance.test.ts` | Create | Dedicated ratio invariance tests across all operations |

---

## Task 1: Remove propose/confirm and CONFIRM_ROLE from Express.sol

**Files:**
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Remove `CONFIRM_ROLE` constant**

In the ROLES section (~line 51), delete:
```solidity
bytes32 public constant CONFIRM_ROLE = keccak256("CONFIRM_ROLE");
```

- [ ] **Step 2: Remove `proposedOffchainShares` state variable**

In the STATE VARIABLES section (~line 131), delete:
```solidity
uint256 public proposedOffchainShares;
```

- [ ] **Step 3: Remove `proposeOffchainShares` function**

Delete the entire function (~lines 1490-1494):
```solidity
function proposeOffchainShares(uint256 _supply) external onlyRole(OPERATOR_ROLE) {
    if (_supply == 0) revert InvalidAmount();
    proposedOffchainShares = _supply;
    emit ProposeOffchainShares(_msgSender(), _supply);
}
```

- [ ] **Step 4: Remove `confirmOffchainShares` function**

Delete the entire function (~lines 1502-1511):
```solidity
function confirmOffchainShares(uint256 _supply) external onlyRole(CONFIRM_ROLE) {
    uint256 pending = proposedOffchainShares;
    if (pending == 0) revert InvalidAmount();
    if (_supply != pending) revert InvalidInput(_supply);

    uint256 previous = offchainShares;
    offchainShares = pending;
    proposedOffchainShares = 0;
    emit ConfirmOffchainShares(_msgSender(), pending, previous);
}
```

- [ ] **Step 5: Remove `PendingProposalExists` guard from `updateEpoch`**

In `updateEpoch` (~line 1435), delete this line:
```solidity
if (proposedOffchainShares != 0) revert PendingProposalExists(proposedOffchainShares);
```

- [ ] **Step 6: Remove related events**

Delete these event declarations:
```solidity
event ProposeOffchainShares(address indexed proposer, uint256 supply);
event ConfirmOffchainShares(address indexed confirmer, uint256 newSupply, uint256 previousSupply);
```

- [ ] **Step 7: Remove `PendingProposalExists` error**

Delete:
```solidity
error PendingProposalExists(uint256 pendingValue);
```

- [ ] **Step 8: Add `updateOffchainShares` admin override function**

Add near the other MAINTAINER functions:
```solidity
/// @notice Admin override for rare events (share splits, reconciliation).
/// @dev Should almost never be called. Use only for error correction or corporate actions.
function updateOffchainShares(uint256 _newValue) external onlyRole(MAINTAINER_ROLE) {
    uint256 previous = offchainShares;
    offchainShares = _newValue;
    emit UpdateOffchainShares(_msgSender(), _newValue, previous);
}
```

Add the event declaration:
```solidity
event UpdateOffchainShares(address indexed caller, uint256 newValue, uint256 previousValue);
```

- [ ] **Step 9: Compile**

Run: `npm run compile`
Expected: Compilation succeeds (may have warnings about unused errors from later tasks — that's fine).

- [ ] **Step 10: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "refactor: remove propose/confirm flow, add updateOffchainShares admin override"
```

---

## Task 2: Remove snapshot ratios machinery from Express.sol

**Files:**
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Remove `snapshotRatios` state variable**

Delete (~line 174):
```solidity
mapping(bytes32 => uint256) public snapshotRatios;
```

- [ ] **Step 2: Remove `snapshotPendingRedeemRatio` function**

Delete the entire function (~lines 979-998):
```solidity
function snapshotPendingRedeemRatio(uint256 _start, uint256 _end) external onlyRole(OPERATOR_ROLE) { ... }
```

- [ ] **Step 3: Remove `setSnapshotRatio` function**

Delete the entire function (~lines 1006-1010):
```solidity
function setSnapshotRatio(bytes32 _id, uint256 _ratio) external onlyRole(MAINTAINER_ROLE) { ... }
```

- [ ] **Step 4: Remove snapshot-related events**

Delete:
```solidity
event SnapshotPendingRedeemRatio(bytes32 indexed id, uint256 ratio);
event SetSnapshotRatio(bytes32 indexed id, uint256 ratio);
```

- [ ] **Step 5: Remove `RatioNotSnapshotted` error**

Delete:
```solidity
error RatioNotSnapshotted(bytes32 id);
```

- [ ] **Step 6: Remove all `snapshotRatios` references in queue processing**

In `_processSinglePendingRedeem` (~lines 870-934), remove:
```solidity
uint256 currentRatio = snapshotRatios[pendingId];
if (currentRatio == 0) revert RatioNotSnapshotted(pendingId);
```

And remove the snapshot migration lines:
```solidity
snapshotRatios[finalId] = currentRatio;
delete snapshotRatios[pendingId];
```

In `processRedeemQueue` (~line 1048), remove:
```solidity
delete snapshotRatios[id];
```

In `cancelPendingRedeem` (~line 963), remove:
```solidity
delete snapshotRatios[id];
```

In `cancelRedeem` (~line 1095), remove:
```solidity
delete snapshotRatios[id];
```

In `revertRedeemToPending` (~lines 1195-1200), remove the snapshot migration:
```solidity
snapshotRatios[newPendingId] = snapshotRatios[oldId];
delete snapshotRatios[oldId];
```

- [ ] **Step 7: Compile**

Run: `npm run compile`
Expected: Compilation errors about `currentRatio` being used in `_processSinglePendingRedeem` — this is expected and will be fixed in Task 4 when we rewrite the redeem flow.

- [ ] **Step 8: Commit (WIP — will compile after Task 4)**

```bash
git add contracts/extension/Express.sol
git commit -m "refactor: remove snapshot ratios machinery (WIP — compiles after redeem flow rewrite)"
```

---

## Task 3: Rename `totalRedeemQueueShares` to `totalRedeemQueueTokens` and rewrite `processDepositQueue`

**Files:**
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Rename state variable**

Change (~line 157):
```solidity
// Old:
uint256 public totalRedeemQueueShares;
// New:
uint256 public totalRedeemQueueTokens;
```

Find-and-replace all references to `totalRedeemQueueShares` → `totalRedeemQueueTokens` throughout the file. Locations include:
- `_sharesPerToken()` (~line 1599)
- `_processSinglePendingRedeem` (~line 930) — will be rewritten in Task 4
- `processRedeemQueue` (~line 1048)
- `cancelRedeem` (~line 1093)
- `revertRedeemToPending` (~line 1181)
- `circulatingSupply()` if it exists

- [ ] **Step 2: Add `InsufficientOffchainShares` error**

Add to the errors section:
```solidity
error InsufficientOffchainShares();
```

- [ ] **Step 3: Add `InsufficientSettlementFunds` error**

```solidity
error InsufficientSettlementFunds(uint256 oracleTotal, uint256 suppliedTotal);
```

- [ ] **Step 4: Rewrite `processDepositQueue` with two-pass pro-rata logic**

Replace the entire function with:
```solidity
function processDepositQueue(uint256 _len, uint256 _newShares) external onlyRole(MAINTAINER_ROLE) {
    _len = _validateQueueProcessing(depositQueue.length(), _len);

    // If no entries to process, _newShares must be 0
    if (_len == 0) {
        if (_newShares != 0) revert InvalidAmount();
        return;
    }
    if (_newShares == 0) revert InvalidAmount();

    // Capture current ratio before state changes
    uint256 currentRatio = _sharesPerToken();

    // First pass: peek entries, validate KYC, sum normalized net assets
    uint256 batchTotalNetAssets;
    for (uint256 i = 0; i < _len; ) {
        bytes memory data = depositQueue.at(i);
        (
            address asset,
            address sender,
            address receiver,
            uint256 netAssets,
            ,
            // feeAmt — not needed in first pass
        ) = _decodeDepositData(data);

        _validateKyc(sender, receiver);
        batchTotalNetAssets += convertFromUnderlying(asset, netAssets);

        unchecked { ++i; }
    }

    // Compute total tokens to mint (preserves ratio exactly)
    uint256 mintTotal = Math.mulDiv(_newShares, 1e18, currentRatio);

    // Update offchainShares
    offchainShares += _newShares;

    // Second pass: pop entries, compute pro-rata mint, mint tokens
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

        depositQueue.popFront();
        depositInfo[receiver][asset] -= netAssets;

        uint256 normalizedAssets = convertFromUnderlying(asset, netAssets);
        uint256 mintedAmount = _trim(Math.mulDiv(mintTotal, normalizedAssets, batchTotalNetAssets));
        token.mint(receiver, mintedAmount);

        emit ProcessDeposit(asset, sender, receiver, netAssets, mintedAmount, feeAmt, prevId);

        unchecked { ++count; }
    }
}
```

- [ ] **Step 5: Remove old `_calculateMintAmount` if no longer used**

The old helper:
```solidity
function _calculateMintAmount(address _asset, uint256 _netAssets) internal view returns (uint256 mintAmount) { ... }
```
Check if `previewDeposit` or any other function still calls it. If `previewDeposit` uses it, keep it for now and update it in a later task. If nothing else uses it, delete it.

**Note:** `previewDeposit` likely still needs a mint amount calculation. Keep `_calculateMintAmount` for `previewDeposit` but note that its meaning changes — it now shows what a deposit WOULD mint at the current ratio assuming 1:1 oracle price, which is a rough estimate. The actual mint is determined by the operator-supplied `_newShares`.

- [ ] **Step 6: Compile**

Run: `npm run compile`
Expected: May still have errors from the redeem flow (Task 2 WIP). The deposit side should compile cleanly.

- [ ] **Step 7: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "refactor: rename totalRedeemQueueShares -> totalRedeemQueueTokens, rewrite processDepositQueue with pro-rata mint"
```

---

## Task 4: Rewrite `requestRedeem` and pending redeem queue encoding

**Files:**
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Update `_decodePendingRedeemData` for new encoding**

The new encoding adds `offchainShareAmount` between `tokenAmount` and `requestTimestamp`:
```solidity
function _decodePendingRedeemData(
    bytes memory _data
)
    internal
    pure
    returns (address sender, address receiver, uint256 tokenAmount, uint256 offchainShareAmount, uint256 requestTimestamp, bytes32 id)
{
    (sender, receiver, tokenAmount, offchainShareAmount, requestTimestamp, id) = abi.decode(
        _data,
        (address, address, uint256, uint256, uint256, bytes32)
    );
}
```

- [ ] **Step 2: Rewrite `requestRedeem`**

Replace the entire function:
```solidity
function requestRedeem(address _to, uint256 _tokenAmount) external whenNotPausedRedeem {
    address from = _msgSender();
    _validateKyc(from, _to);

    if (from == mgtFeeTo) {
        if (totalMgtFeeUnclaimed == 0) revert InvalidAmount();
        _tokenAmount = totalMgtFeeUnclaimed;
        totalMgtFeeUnclaimed = 0; // decrement at request time (fixes M-1)
    } else {
        if (_tokenAmount < redeemMinimum) {
            revert RedeemLessThanMinimum(_tokenAmount, redeemMinimum);
        }
    }

    // Convert token amount to offchain shares at current ratio
    uint256 offchainShareAmount = Math.mulDiv(_tokenAmount, _sharesPerToken(), 1e18);

    // Guard: offchainShares must cover the deduction
    if (offchainShares < offchainShareAmount) revert InsufficientOffchainShares();

    // Update accounting — both numerator and denominator change proportionally
    offchainShares -= offchainShareAmount;
    totalRedeemQueueTokens += _tokenAmount;

    // Collect full token amount to contract (burned later in processRedeemQueue)
    IERC20(address(token)).safeTransferFrom(from, address(this), _tokenAmount);

    // Track pending info
    pendingRedeemInfo[_to] += _tokenAmount;

    bytes32 id = keccak256(abi.encode(from, _to, _tokenAmount, offchainShareAmount, block.timestamp, _nonce++));
    bytes memory data = abi.encode(from, _to, _tokenAmount, offchainShareAmount, block.timestamp, id);
    pendingRedeemQueue.pushBack(data);

    emit AddToPendingRedeemQueue(from, _to, _tokenAmount, id);
}
```

- [ ] **Step 3: Update `AddToPendingRedeemQueue` event to include offchainShareAmount**

```solidity
event AddToPendingRedeemQueue(
    address indexed from,
    address indexed to,
    uint256 tokenAmount,
    uint256 offchainShareAmount,
    bytes32 indexed id
);
```

Update the emit in `requestRedeem`:
```solidity
emit AddToPendingRedeemQueue(from, _to, _tokenAmount, offchainShareAmount, id);
```

- [ ] **Step 4: Fix all callers of `_decodePendingRedeemData`**

Search for all call sites. Each now returns 6 values instead of 5. Update destructuring everywhere:

In `_processSinglePendingRedeem`:
```solidity
(
    address sender,
    address receiver,
    uint256 tokenAmount,
    uint256 offchainShareAmount,
    uint256 requestTimestamp,
    bytes32 pendingId
) = _decodePendingRedeemData(data);
```

In `cancelPendingRedeem`:
```solidity
(
    address sender,
    address receiver,
    uint256 tokenAmount,
    uint256 offchainShareAmount,
    ,
    bytes32 id
) = _decodePendingRedeemData(data);
```

In `snapshotPendingRedeemRatio` — already deleted in Task 2.

In `getPendingRedeemQueueItem` or similar view functions — update destructuring.

- [ ] **Step 5: Compile**

Run: `npm run compile`
Expected: Errors in `_processSinglePendingRedeem` about undefined `currentRatio` (removed in Task 2). Will be fixed in Task 5.

- [ ] **Step 6: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "refactor: rewrite requestRedeem with offchainShares deduction and new queue encoding"
```

---

## Task 5: Rewrite `processPendingRedeems` and `_processSinglePendingRedeem`

**Files:**
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Update `_redeemAssetAmount` signature**

Simplify — no more snapshot ratio parameter:
```solidity
function _redeemAssetAmount(
    uint256 _offchainShareAmount,
    uint256 _price
) internal view returns (uint256 redeemAssetAmt) {
    redeemAssetAmt = _trimAsset(
        Math.mulDiv(convertToUnderlying(redeemAsset, _offchainShareAmount), _price, 1e18),
        redeemAsset
    );
}
```

- [ ] **Step 2: Update `_decodeRedeemData` for new final queue encoding**

The final queue now includes `offchainShareAmount`:
```solidity
function _decodeRedeemData(
    bytes memory _data
)
    internal
    pure
    returns (
        address sender,
        address receiver,
        uint256 tokenAmount,
        uint256 offchainShareAmount,
        uint256 redeemAssetAmt,
        uint256 feeAssetAmt,
        uint256 requestTimestamp,
        bytes32 id
    )
{
    (sender, receiver, tokenAmount, offchainShareAmount, redeemAssetAmt, feeAssetAmt, requestTimestamp, id) = abi.decode(
        _data,
        (address, address, uint256, uint256, uint256, uint256, uint256, bytes32)
    );
}
```

- [ ] **Step 3: Rewrite `processPendingRedeems` with `_totalAsset` parameter**

```solidity
function processPendingRedeems(uint256 _len, uint256 _totalAsset) external onlyRole(OPERATOR_ROLE) {
    uint256 processed;
    uint256 currentPrice = getPrice();
    uint256 runningTotal;

    while (processed < _len && !pendingRedeemQueue.empty()) {
        (bool success, uint256 assetAmt) = _processSinglePendingRedeem(currentPrice);
        if (!success) {
            break;
        }
        runningTotal += assetAmt;
        unchecked { ++processed; }
    }

    if (processed == 0) revert NoPendingRedeemsReady();

    // Sanity bound: oracle-derived total must not exceed operator-supplied actual
    if (runningTotal > _totalAsset) revert InsufficientSettlementFunds(runningTotal, _totalAsset);
}
```

- [ ] **Step 4: Rewrite `_processSinglePendingRedeem`**

```solidity
function _processSinglePendingRedeem(uint256 currentPrice) internal returns (bool success, uint256 redeemAssetAmt) {
    bytes memory data = pendingRedeemQueue.front();
    (
        address sender,
        address receiver,
        uint256 tokenAmount,
        uint256 offchainShareAmount,
        uint256 requestTimestamp,
        bytes32 pendingId
    ) = _decodePendingRedeemData(data);

    // Check if convertRedeemRequestsDelay has elapsed
    if (block.timestamp < requestTimestamp + convertRedeemRequestsDelay) {
        return (false, 0);
    }

    _validateKyc(sender, receiver);

    // Remove from pending queue
    pendingRedeemQueue.popFront();
    pendingRedeemInfo[receiver] -= tokenAmount;

    // Price redeem proceeds using the offchainShareAmount (ratio already baked in at request time)
    redeemAssetAmt = _redeemAssetAmount(offchainShareAmount, currentPrice);

    // Calculate fee in redeemAsset
    uint256 feeAssetAmt = txsFee(redeemAssetAmt, TxType.REDEEM);

    // Add to final redeem queue
    bytes32 finalId = keccak256(
        abi.encode(
            sender,
            receiver,
            tokenAmount,
            offchainShareAmount,
            redeemAssetAmt,
            feeAssetAmt,
            requestTimestamp,
            block.timestamp,
            _nonce++
        )
    );

    redeemQueue.pushBack(
        abi.encode(sender, receiver, tokenAmount, offchainShareAmount, redeemAssetAmt, feeAssetAmt, requestTimestamp, finalId)
    );

    redeemInfo[receiver] += tokenAmount;
    // Note: totalRedeemQueueTokens NOT incremented here — already done in requestRedeem

    emit ProcessPendingRedeem(sender, receiver, tokenAmount, currentPrice, pendingId, finalId);

    return (true, redeemAssetAmt);
}
```

- [ ] **Step 5: Fix all callers of `_decodeRedeemData`**

The function now returns 8 values instead of 7. Update destructuring in:

`processRedeemQueue`:
```solidity
(
    address sender,
    address receiver,
    uint256 tokenAmount,
    ,  // offchainShareAmount — not needed for processing
    uint256 redeemAssetAmt,
    uint256 feeAssetAmt,
    ,  // requestTimestamp
    bytes32 id
) = _decodeRedeemData(data);
```

`cancelRedeem`:
```solidity
(
    address sender,
    address receiver,
    uint256 tokenAmount,
    uint256 offchainShareAmount,
    ,  // redeemAssetAmt
    ,  // feeAssetAmt
    ,  // requestTimestamp
    bytes32 id
) = _decodeRedeemData(data);
```

`revertRedeemToPending`:
```solidity
(
    address sender,
    address receiver,
    uint256 tokenAmount,
    uint256 offchainShareAmount,
    ,  // redeemAssetAmt — discard
    ,  // feeAssetAmt — discard
    uint256 requestTimestamp,
    bytes32 oldId
) = _decodeRedeemData(data);
```

- [ ] **Step 6: Compile**

Run: `npm run compile`
Expected: Compilation succeeds. All contract changes are now structurally complete.

- [ ] **Step 7: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "refactor: rewrite processPendingRedeems with _totalAsset sanity bound, remove snapshot dependency"
```

---

## Task 6: Update `processRedeemQueue`, `cancelRedeem`, `cancelPendingRedeem`, and `revertRedeemToPending`

**Files:**
- Modify: `contracts/extension/Express.sol`

- [ ] **Step 1: Update `processRedeemQueue`**

Key changes: use `tokenAmount` (not `shareAmount`), remove `snapshotRatios` cleanup (already removed in Task 2), use updated `_decodeRedeemData` destructuring from Task 5.

```solidity
function processRedeemQueue(uint256 _len) external onlyRole(OPERATOR_ROLE) {
    _len = _validateQueueProcessing(redeemQueue.length(), _len);

    for (uint256 count = 0; count < _len; ) {
        bytes memory data = redeemQueue.front();
        (
            address sender,
            address receiver,
            uint256 tokenAmount,
            ,  // offchainShareAmount
            uint256 redeemAssetAmt,
            uint256 feeAssetAmt,
            ,  // requestTimestamp
            bytes32 id
        ) = _decodeRedeemData(data);

        _validateKyc(sender, receiver);

        // Check liquidity
        uint256 availableLiquidity = getTokenBalance(address(redeemAsset));
        if (redeemAssetAmt > availableLiquidity) {
            break;
        }

        redeemQueue.popFront();
        redeemInfo[receiver] -= tokenAmount;
        totalRedeemQueueTokens -= tokenAmount;
        unchecked { ++count; }

        // Burn tokens
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
```

- [ ] **Step 2: Update `cancelPendingRedeem`**

Add `offchainShares` and `totalRedeemQueueTokens` restoration:

```solidity
function cancelPendingRedeem(uint256 _len) external onlyRole(MAINTAINER_ROLE) {
    _len = _validateQueueProcessing(pendingRedeemQueue.length(), _len);

    while (_len > 0) {
        bytes memory data = pendingRedeemQueue.popFront();
        (
            address sender,
            address receiver,
            uint256 tokenAmount,
            uint256 offchainShareAmount,
            ,  // requestTimestamp
            bytes32 id
        ) = _decodePendingRedeemData(data);

        pendingRedeemInfo[receiver] -= tokenAmount;

        // Restore accounting (reverse of requestRedeem)
        offchainShares += offchainShareAmount;
        totalRedeemQueueTokens -= tokenAmount;

        // Restore mgtFeeUnclaimed if this was a fee redeem
        if (sender == mgtFeeTo) {
            totalMgtFeeUnclaimed += tokenAmount;
        }

        unchecked { --_len; }

        _refundOrEscrow(sender, tokenAmount);

        emit CancelPendingRedeem(sender, receiver, tokenAmount, id);
    }
}
```

- [ ] **Step 3: Update `cancelRedeem`**

Add `offchainShares` restoration:

```solidity
function cancelRedeem(uint256 _len) public onlyRole(MAINTAINER_ROLE) {
    _len = _validateQueueProcessing(redeemQueue.length(), _len);

    while (_len > 0) {
        bytes memory data = redeemQueue.popFront();
        (
            address sender,
            address receiver,
            uint256 tokenAmount,
            uint256 offchainShareAmount,
            ,  // redeemAssetAmt
            ,  // feeAssetAmt
            ,  // requestTimestamp
            bytes32 id
        ) = _decodeRedeemData(data);

        redeemInfo[receiver] -= tokenAmount;
        totalRedeemQueueTokens -= tokenAmount;

        // Restore offchainShares (reverse of requestRedeem)
        offchainShares += offchainShareAmount;

        // Restore mgtFeeUnclaimed if this was a fee redeem
        if (sender == mgtFeeTo) {
            totalMgtFeeUnclaimed += tokenAmount;
        }

        unchecked { --_len; }

        _refundOrEscrow(sender, tokenAmount);

        emit CancelProcessRedeem(sender, receiver, tokenAmount, 0, id);
    }
}
```

- [ ] **Step 4: Simplify `revertRedeemToPending`**

Remove snapshot migration, remove `totalMgtFeeUnclaimed` restoration (fee counter already decremented at request time), keep `totalRedeemQueueTokens` unchanged:

```solidity
function revertRedeemToPending(uint256 _len) external onlyRole(OPERATOR_ROLE) {
    _len = _validateQueueProcessing(redeemQueue.length(), _len);

    for (uint256 i = 0; i < _len; ) {
        bytes memory data = redeemQueue.popBack();
        (
            address sender,
            address receiver,
            uint256 tokenAmount,
            uint256 offchainShareAmount,
            ,  // redeemAssetAmt — discard
            ,  // feeAssetAmt — discard
            uint256 requestTimestamp,
            bytes32 oldId
        ) = _decodeRedeemData(data);

        redeemInfo[receiver] -= tokenAmount;
        // Note: totalRedeemQueueTokens unchanged (covers both queues)
        // Note: offchainShares unchanged (adjusted at requestRedeem time)

        bytes32 newPendingId = keccak256(
            abi.encode(sender, receiver, tokenAmount, offchainShareAmount, requestTimestamp, _nonce++)
        );
        pendingRedeemQueue.pushFront(
            abi.encode(sender, receiver, tokenAmount, offchainShareAmount, requestTimestamp, newPendingId)
        );
        pendingRedeemInfo[receiver] += tokenAmount;

        emit RevertRedeemToPending(sender, receiver, tokenAmount, oldId, newPendingId);

        unchecked { ++i; }
    }
}
```

- [ ] **Step 5: Update any view functions that decode queue entries**

Search for `getRedeemQueueItem`, `getPendingRedeemQueueItem`, or similar view functions and update their return types and destructuring to match the new encoding.

- [ ] **Step 6: Compile**

Run: `npm run compile`
Expected: Clean compilation. All contract code changes are complete.

- [ ] **Step 7: Commit**

```bash
git add contracts/extension/Express.sol
git commit -m "refactor: update processRedeemQueue, cancelRedeem, cancelPendingRedeem, simplify revertRedeemToPending"
```

---

## Task 7: Update test fixtures

**Files:**
- Modify: `test/fixtures/expressDeployments.ts`

- [ ] **Step 1: Update `bootstrapAndSeedOffchainShares`**

Replace the propose/confirm flow with the new `processDepositQueue(len, newShares)`:

```typescript
export async function bootstrapAndSeedOffchainShares(
  deployment: ExpressDeployment
): Promise<{ depositedAmount: bigint }> {
  const { express, usdo, user1, maintainer } = deployment;

  const firstDepositAmount = await express.firstDepositAmount();

  // Bootstrap deposit
  await express
    .connect(user1)
    .requestDeposit(await usdo.getAddress(), firstDepositAmount, user1.address);

  // Process with newShares = firstDepositAmount (1:1 at bootstrap, ratio fallback is 1e18)
  await express.connect(maintainer).processDepositQueue(1, firstDepositAmount);

  return { depositedAmount: firstDepositAmount };
}
```

Remove the `confirmer` parameter since `CONFIRM_ROLE` is gone.

- [ ] **Step 2: Remove `CONFIRM_ROLE` grants from `deployExpressContracts` if any exist**

Check if there's a `CONFIRM_ROLE` grant in the deploy function. If so, remove it.

- [ ] **Step 3: Update `ExpressDeployment` interface if needed**

If `confirmer` was part of the interface, remove it. Check all test files that import `ExpressDeployment`.

- [ ] **Step 4: Compile tests**

Run: `npx hardhat compile`
Expected: Compiles (tests won't pass yet — test files still reference old APIs).

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/expressDeployments.ts
git commit -m "test: update fixtures for new processDepositQueue signature, remove propose/confirm"
```

---

## Task 8: Rewrite `Express.OffchainShares.test.ts`

**Files:**
- Rewrite: `test/unit/Express.OffchainShares.test.ts`

- [ ] **Step 1: Replace propose/confirm tests with `updateOffchainShares` tests**

```typescript
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

describe('Express - Offchain Shares', function () {
  async function deployFixture() {
    return deployExpressContracts();
  }

  // Bootstrap: deposit and process so offchainShares > 0
  async function deployWithBootstrapFixture() {
    const base = await deployFixture();
    const { express, usdo, user1, maintainer } = base;
    const depositAmt = ethers.parseUnits('2000', 18);
    await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
    await express.connect(maintainer).processDepositQueue(1, depositAmt);
    return base;
  }

  describe('updateOffchainShares', function () {
    it('reverts when called by non-MAINTAINER_ROLE', async function () {
      const { express, user1 } = await loadFixture(deployFixture);
      await expect(
        express.connect(user1).updateOffchainShares(ethers.parseUnits('1000', 18))
      ).to.be.revertedWithCustomError(express, 'AccessControlUnauthorizedAccount');
    });

    it('sets offchainShares and emits UpdateOffchainShares', async function () {
      const { express, maintainer } = await loadFixture(deployWithBootstrapFixture);
      const newValue = ethers.parseUnits('5000', 18);
      const previous = await express.offchainShares();

      await expect(express.connect(maintainer).updateOffchainShares(newValue))
        .to.emit(express, 'UpdateOffchainShares')
        .withArgs(maintainer.address, newValue, previous);

      expect(await express.offchainShares()).to.equal(newValue);
    });

    it('allows setting to zero', async function () {
      const { express, maintainer } = await loadFixture(deployWithBootstrapFixture);
      await express.connect(maintainer).updateOffchainShares(0);
      expect(await express.offchainShares()).to.equal(0n);
    });
  });

  describe('processDepositQueue updates offchainShares', function () {
    it('increments offchainShares by _newShares', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      const depositAmt = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      const sharesBefore = await express.offchainShares();
      const newShares = ethers.parseUnits('5000', 18);
      await express.connect(maintainer).processDepositQueue(1, newShares);

      expect(await express.offchainShares()).to.equal(sharesBefore + newShares);
    });

    it('reverts if _newShares is 0 when _len > 0', async function () {
      const { express, usdo, user1, maintainer } = await loadFixture(deployFixture);
      const depositAmt = ethers.parseUnits('5000', 18);
      await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);

      await expect(
        express.connect(maintainer).processDepositQueue(1, 0)
      ).to.be.revertedWithCustomError(express, 'InvalidAmount');
    });

    it('reverts if _newShares > 0 when queue is empty', async function () {
      const { express, maintainer } = await loadFixture(deployFixture);
      await expect(
        express.connect(maintainer).processDepositQueue(0, ethers.parseUnits('100', 18))
      ).to.be.revertedWithCustomError(express, 'InvalidAmount');
    });
  });

  describe('Pre-sync behavior (offchainShares == 0)', function () {
    it('_sharesPerToken returns 1e18 fallback before any processDepositQueue', async function () {
      const { express } = await loadFixture(deployFixture);
      expect(await express.sharesPerToken()).to.equal(ethers.parseUnits('1', 18));
    });

    it('first processDepositQueue mints 1:1 at fallback ratio', async function () {
      const { express, oem, usdo, user1, maintainer } = await loadFixture(deployFixture);
      const depositAmt = ethers.parseUnits('2000', 18);

      // Fee is 0 by default, so net = deposit amount
      await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
      await express.connect(maintainer).processDepositQueue(1, depositAmt);

      // At 1e18 fallback ratio: mintTotal = newShares * 1e18 / 1e18 = newShares = depositAmt
      expect(await oem.balanceOf(user1.address)).to.equal(depositAmt);
      expect(await express.offchainShares()).to.equal(depositAmt);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx hardhat test test/unit/Express.OffchainShares.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/unit/Express.OffchainShares.test.ts
git commit -m "test: rewrite OffchainShares tests for updateOffchainShares and processDepositQueue"
```

---

## Task 9: Create `Express.invariance.test.ts` — ratio invariance tests

**Files:**
- Create: `test/unit/Express.invariance.test.ts`

- [ ] **Step 1: Write ratio invariance test suite**

```typescript
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);

describe('Express - Ratio Invariance', function () {
  async function deployFixture() {
    const fixture = await deployExpressContracts();
    return fixture;
  }

  // Helper: bootstrap with a deposit so we have a real ratio
  async function deployWithDeposit() {
    const fixture = await deployFixture();
    const { express, usdo, oem, user1, user2, maintainer } = fixture;
    const depositAmt = ethers.parseUnits('10000', 18);

    await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
    await express.connect(maintainer).processDepositQueue(1, depositAmt);

    // Approve for user1 and user2 redeems
    await oem.connect(user1).approve(await express.getAddress(), ethers.MaxUint256);
    await oem.connect(user2).approve(await express.getAddress(), ethers.MaxUint256);

    return fixture;
  }

  // Helper: bootstrap + fee accrual so ratio < 1e18
  async function deployWithDepositAndFees() {
    const fixture = await deployWithDeposit();
    const { express, maintainer, operator } = fixture;

    // Set fee rate and accrue fees
    await express.connect(maintainer).updateMgtFeeRate(1000); // 10% annual
    await express.connect(maintainer).updateTimeBuffer(72000);
    await time.increase(72001);
    await express.connect(operator).updateEpoch();

    return fixture;
  }

  describe('processDepositQueue preserves ratio', function () {
    it('ratio unchanged after deposit when ratio == 1e18', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, usdo, user2, maintainer } = fixture;

      const ratioBefore = await express.sharesPerToken();

      const depositAmt = ethers.parseUnits('3000', 18);
      await express.connect(user2).requestDeposit(await usdo.getAddress(), depositAmt, user2.address);
      await express.connect(maintainer).processDepositQueue(1, depositAmt);

      const ratioAfter = await express.sharesPerToken();
      expect(ratioAfter).to.equal(ratioBefore);
    });

    it('ratio unchanged after deposit when ratio < 1e18 (post-fee)', async function () {
      const fixture = await loadFixture(deployWithDepositAndFees);
      const { express, usdo, user2, maintainer } = fixture;

      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.be.lt(ONE); // Verify fees diluted the ratio

      const depositAmt = ethers.parseUnits('5000', 18);
      await express.connect(user2).requestDeposit(await usdo.getAddress(), depositAmt, user2.address);
      // newShares should be proportional to maintain ratio
      const newShares = ethers.parseUnits('5000', 18);
      await express.connect(maintainer).processDepositQueue(1, newShares);

      const ratioAfter = await express.sharesPerToken();
      expect(ratioAfter).to.equal(ratioBefore);
    });

    it('ratio unchanged with multiple depositors in a batch', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, usdo, user1, user2, maintainer } = fixture;

      const ratioBefore = await express.sharesPerToken();

      await express.connect(user1).requestDeposit(await usdo.getAddress(), ethers.parseUnits('2000', 18), user1.address);
      await express.connect(user2).requestDeposit(await usdo.getAddress(), ethers.parseUnits('3000', 18), user2.address);

      const totalNewShares = ethers.parseUnits('5000', 18);
      await express.connect(maintainer).processDepositQueue(2, totalNewShares);

      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });

  describe('requestRedeem preserves ratio', function () {
    it('ratio unchanged after redeem when ratio == 1e18', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, user1 } = fixture;

      const ratioBefore = await express.sharesPerToken();

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18));

      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });

    it('ratio unchanged after redeem when ratio < 1e18 (post-fee)', async function () {
      const fixture = await loadFixture(deployWithDepositAndFees);
      const { express, user1 } = fixture;

      const ratioBefore = await express.sharesPerToken();
      expect(ratioBefore).to.be.lt(ONE);

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18));

      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });

    it('reverts with InsufficientOffchainShares when offchainShares cannot cover', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, user1, maintainer } = fixture;

      // Set offchainShares to near-zero
      await express.connect(maintainer).updateOffchainShares(1n);

      await expect(
        express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18))
      ).to.be.revertedWithCustomError(express, 'InsufficientOffchainShares');
    });
  });

  describe('processRedeemQueue (burn) preserves ratio', function () {
    it('ratio unchanged after burn', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, user1, operator } = fixture;

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18));

      // Advance past T+2
      await time.increase(2 * 24 * 60 * 60 + 1);

      const ratioBefore = await express.sharesPerToken();

      // Process pending -> final (supply _totalAsset high enough to pass sanity check)
      await express.connect(operator).processPendingRedeems(1, ethers.parseUnits('100000', 18));

      // Ratio should still be same (pending->final doesn't change ratio-relevant state)
      expect(await express.sharesPerToken()).to.equal(ratioBefore);

      // Process final (burn)
      await express.connect(operator).processRedeemQueue(1);

      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });

  describe('cancelPendingRedeem preserves ratio', function () {
    it('ratio unchanged after cancel (reverse of requestRedeem)', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, user1, maintainer } = fixture;

      const ratioBefore = await express.sharesPerToken();

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18));

      // Ratio should be unchanged after requestRedeem
      expect(await express.sharesPerToken()).to.equal(ratioBefore);

      // Cancel
      await express.connect(maintainer).cancelPendingRedeem(1);

      // Ratio should still be unchanged
      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });

  describe('cancelRedeem preserves ratio', function () {
    it('ratio unchanged after cancelRedeem', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, user1, operator, maintainer } = fixture;

      const ratioBefore = await express.sharesPerToken();

      await express.connect(user1).requestRedeem(user1.address, ethers.parseUnits('1000', 18));
      await time.increase(2 * 24 * 60 * 60 + 1);
      await express.connect(operator).processPendingRedeems(1, ethers.parseUnits('100000', 18));

      // Cancel from final queue
      await express.connect(maintainer).cancelRedeem(1);

      expect(await express.sharesPerToken()).to.equal(ratioBefore);
    });
  });

  describe('updateEpoch changes ratio (intended dilution)', function () {
    it('ratio drops after fee mint', async function () {
      const fixture = await loadFixture(deployWithDeposit);
      const { express, maintainer, operator } = fixture;

      await express.connect(maintainer).updateMgtFeeRate(1000);
      await express.connect(maintainer).updateTimeBuffer(72000);

      const ratioBefore = await express.sharesPerToken();

      await time.increase(72001);
      await express.connect(operator).updateEpoch();

      const ratioAfter = await express.sharesPerToken();
      expect(ratioAfter).to.be.lt(ratioBefore);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx hardhat test test/unit/Express.invariance.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/unit/Express.invariance.test.ts
git commit -m "test: add ratio invariance test suite for all operations"
```

---

## Task 10: Rewrite `Express.mgtFeeAccounting.test.ts` with M-1 regression test

**Files:**
- Rewrite: `test/unit/Express.mgtFeeAccounting.test.ts`

- [ ] **Step 1: Rewrite test file**

```typescript
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { deployExpressContracts } from '../fixtures/expressDeployments';

const ONE = ethers.parseUnits('1', 18);

describe('Express - Management Fee Accounting', function () {
  async function deployWithFeeSetup() {
    const fixture = await deployExpressContracts();
    const { express, usdo, oem, user1, maintainer, operator, treasury } = fixture;

    // 10% annual fee
    await express.connect(maintainer).updateMgtFeeRate(1000);
    await express.connect(maintainer).updateTimeBuffer(72000);

    // Bootstrap deposit
    const depositAmt = ethers.parseUnits('100000', 18);
    await express.connect(user1).requestDeposit(await usdo.getAddress(), depositAmt, user1.address);
    await express.connect(maintainer).processDepositQueue(1, depositAmt);

    // Approve for treasury (mgtFeeTo) redeems
    await oem.connect(treasury).approve(await express.getAddress(), ethers.MaxUint256);

    return fixture;
  }

  it('fee accrual + fee redeem cycle works correctly', async function () {
    const fixture = await loadFixture(deployWithFeeSetup);
    const { express, oem, operator, treasury, maintainer } = fixture;

    const depositAmount = ethers.parseUnits('100000', 18);

    // Day 1: accrue fees
    await time.increase(72001);
    await express.connect(operator).updateEpoch();
    const dailyFee = await express.totalMgtFeeUnclaimed();
    expect(dailyFee).to.be.gt(0n);

    // Day 2-3: more fees
    for (let i = 0; i < 2; i++) {
      await time.increase(72001);
      await express.connect(operator).updateEpoch();
    }

    const totalFees = await express.totalMgtFeeUnclaimed();
    expect(totalFees).to.be.gt(dailyFee);

    // mgtFeeTo redeems all fees
    await express.connect(treasury).requestRedeem(treasury.address, 0); // amount overridden to totalMgtFeeUnclaimed

    // totalMgtFeeUnclaimed should be 0 immediately after request (not at process time)
    expect(await express.totalMgtFeeUnclaimed()).to.equal(0n);

    // Process through full cycle
    await time.increase(2 * 24 * 60 * 60 + 1);
    await express.connect(operator).processPendingRedeems(1, ethers.parseUnits('1000000', 18));
    await express.connect(operator).processRedeemQueue(1);

    // Post-cycle: fee tokens burned, totalMgtFeeUnclaimed stays 0
    expect(await express.totalMgtFeeUnclaimed()).to.equal(0n);
  });

  it('M-1 regression: mgtFeeTo cannot double-redeem', async function () {
    const fixture = await loadFixture(deployWithFeeSetup);
    const { express, oem, operator, treasury, user2, maintainer } = fixture;

    // Accrue fees
    await time.increase(72001);
    await express.connect(operator).updateEpoch();
    const feeBalance = await express.totalMgtFeeUnclaimed();
    expect(feeBalance).to.be.gt(0n);

    // Simulate non-fee shares in mgtFeeTo (user accidentally transfers tokens)
    const accidentalTransfer = ethers.parseUnits('1000', 18);
    // user1 already has tokens from bootstrap deposit
    const { user1 } = fixture;
    await oem.connect(user1).transfer(treasury.address, accidentalTransfer);

    // First requestRedeem succeeds — zeroes totalMgtFeeUnclaimed
    await express.connect(treasury).requestRedeem(treasury.address, 0);
    expect(await express.totalMgtFeeUnclaimed()).to.equal(0n);

    // Second requestRedeem MUST revert — totalMgtFeeUnclaimed is now 0
    await expect(
      express.connect(treasury).requestRedeem(treasury.address, 0)
    ).to.be.revertedWithCustomError(express, 'InvalidAmount');
  });

  it('cancelPendingRedeem restores totalMgtFeeUnclaimed for mgtFeeTo entries', async function () {
    const fixture = await loadFixture(deployWithFeeSetup);
    const { express, operator, treasury, maintainer } = fixture;

    await time.increase(72001);
    await express.connect(operator).updateEpoch();
    const totalFees = await express.totalMgtFeeUnclaimed();

    // mgtFeeTo redeems
    await express.connect(treasury).requestRedeem(treasury.address, 0);
    expect(await express.totalMgtFeeUnclaimed()).to.equal(0n);

    // Cancel restores
    await express.connect(maintainer).cancelPendingRedeem(1);
    expect(await express.totalMgtFeeUnclaimed()).to.equal(totalFees);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx hardhat test test/unit/Express.mgtFeeAccounting.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/unit/Express.mgtFeeAccounting.test.ts
git commit -m "test: rewrite mgt fee accounting tests, add M-1 double-redeem regression test"
```

---

## Task 11: Update `Express.sharePerToken.test.ts`

**Files:**
- Modify: `test/unit/Express.sharePerToken.test.ts`

- [ ] **Step 1: Update all helpers**

Replace `setOffchainShares` (propose/confirm) with direct `processDepositQueue`:
```typescript
// Old:
async function setOffchainShares(fixture: any, amount: bigint) {
    const { express, operator, confirmer } = fixture;
    await express.connect(operator).proposeOffchainShares(amount);
    await express.connect(confirmer).confirmOffchainShares(amount);
}
// New: not needed — offchainShares is set by processDepositQueue automatically
```

Replace `depositFor` to use new signature:
```typescript
async function depositFor(fixture: any, user: any, amount: bigint) {
    const { express, usdo, maintainer } = fixture;
    await express.connect(user).requestDeposit(await usdo.getAddress(), amount, user.address);
    await express.connect(maintainer).processDepositQueue(1, amount);
}
```

Replace `processPendingRedeemsAfterDelay` — remove snapshot step:
```typescript
async function processPendingRedeemsAfterDelay(fixture: any, len?: bigint) {
    const { express, operator } = fixture;
    await time.increase(2n * 24n * 60n * 60n);
    const queueLen: bigint = await express.getPendingRedeemQueueLength();
    await express.connect(operator).processPendingRedeems(
        len ?? queueLen,
        ethers.parseUnits('10000000', 18) // large _totalAsset for sanity check
    );
}
```

Remove `confirmer` from fixture setup and all references to `CONFIRM_ROLE`.

- [ ] **Step 2: Update all test cases**

Go through each test case and:
1. Remove any `setOffchainShares` calls — offchainShares is now automatic
2. Remove any `snapshotPendingRedeemRatio` calls
3. Update `processDepositQueue(1)` → `processDepositQueue(1, amount)`
4. Update `processPendingRedeems(n)` → `processPendingRedeems(n, largeAmount)`
5. Update ratio expectations where the new invariance means values differ from old behavior

- [ ] **Step 3: Run tests**

Run: `npx hardhat test test/unit/Express.sharePerToken.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/unit/Express.sharePerToken.test.ts
git commit -m "test: update sharePerToken tests for new function signatures and invariance"
```

---

## Task 12: Update `Express.comprehensive.test.ts`

**Files:**
- Modify: `test/unit/Express.comprehensive.test.ts`

- [ ] **Step 1: Update `deployFixture` — remove `confirmer`**

```typescript
async function deployFixture() {
    const fixture = await deployExpressContracts();
    await fixture.express.connect(fixture.maintainer).updateTrimDecimals(TRIM_DECIMALS);
    return fixture;
}
```

Remove `seedOffchainShares` helper entirely.

- [ ] **Step 2: Bulk update all call sites**

Search and replace across the file:
1. `processDepositQueue(N)` → `processDepositQueue(N, amount)` — where `amount` is the sum of net deposit assets in that batch. Determine from context.
2. `processPendingRedeems(N)` → `processPendingRedeems(N, largeAmount)`
3. Remove all `seedOffchainShares(fixture)` calls — offchainShares is now set by `processDepositQueue`
4. Remove all `snapshotPendingRedeemRatio(...)` calls
5. Remove `confirmer` from destructuring
6. Update `requestRedeem(addr, amount)` — parameter is now `_tokenAmount` but the external signature hasn't changed name-wise in the ABI, just internal. Calls don't change.

- [ ] **Step 3: Run tests**

Run: `npx hardhat test test/unit/Express.comprehensive.test.ts`
Expected: All tests pass (or identify specific failures to fix).

- [ ] **Step 4: Fix any remaining failures**

Address test-by-test. Common issues:
- Mint amounts changed due to pro-rata calculation vs. old price-based calculation
- Expected event parameters changed (new `offchainShareAmount` in `AddToPendingRedeemQueue`)
- `revertRedeemToPending` tests may need updating for simplified behavior

- [ ] **Step 5: Commit**

```bash
git add test/unit/Express.comprehensive.test.ts
git commit -m "test: update comprehensive tests for new function signatures and removed features"
```

---

## Task 13: Rewrite `DailyRoutine.test.ts`

**Files:**
- Rewrite: `test/integration/DailyRoutine.test.ts`

- [ ] **Step 1: Update daily routine flow**

The new daily routine is:
1. `processDepositQueue(len, newShares)`
2. `updateEpoch()`
3. `processPendingRedeems(len, totalAsset)`
4. `processRedeemQueue(len)`

Remove from the old flow:
- `proposeOffchainShares` + `confirmOffchainShares`
- `snapshotPendingRedeemRatio`
- `proposePrice` + `confirmPrice` (if those were part of the PriceOracle — check)

Update the test to follow the new sequence, asserting ratio invariance at each step.

- [ ] **Step 2: Run tests**

Run: `npx hardhat test test/integration/DailyRoutine.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/integration/DailyRoutine.test.ts
git commit -m "test: rewrite DailyRoutine integration test for new operational flow"
```

---

## Task 14: Run full test suite and fix remaining issues

**Files:**
- All test and contract files

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Fix any remaining compilation or test failures**

Address issues one by one. Common categories:
- Missing event parameter changes in assertions
- View functions returning different values
- Queue decode mismatches
- `revertRedeemToPending` test cases that expected snapshot behavior

- [ ] **Step 3: Run full suite again**

Run: `npm test`
Expected: All tests pass. Zero failures.

- [ ] **Step 4: Run gas report**

Run: `REPORT_GAS=true npm test`
Review gas changes — the two-pass deposit is expected to be slightly more expensive.

- [ ] **Step 5: Run contract size check**

Run: `npm run size`
Verify Express stays under the 24KB contract size limit.

- [ ] **Step 6: Commit final fixes**

```bash
git add -A
git commit -m "fix: resolve remaining test failures from sharesPerToken invariance refactor"
```

---

## Task 15: Clean up and final commit

**Files:**
- Modify: `CLAUDE.md` — update documentation
- Modify: `docs/superpowers/specs/2026-04-24-sharespertoken-invariance-design.md` — mark as Implemented

- [ ] **Step 1: Update CLAUDE.md**

Update the "Management Fee Accounting" section to reflect the new design:
- Remove references to `proposeOffchainShares`, `confirmOffchainShares`, `CONFIRM_ROLE`
- Remove references to `snapshotRatios`, `snapshotPendingRedeemRatio`, `setSnapshotRatio`
- Update `processDepositQueue` signature documentation
- Update `processPendingRedeems` signature documentation
- Update `requestRedeem` behavior (now deducts `offchainShares` at request time)
- Update daily routine sequence
- Add `updateOffchainShares` documentation
- Rename `totalRedeemQueueShares` → `totalRedeemQueueTokens` in all references

- [ ] **Step 2: Update spec status**

In `docs/superpowers/specs/2026-04-24-sharespertoken-invariance-design.md`, change:
```
**Status:** Draft
```
to:
```
**Status:** Implemented
```

- [ ] **Step 3: Final test run**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-04-24-sharespertoken-invariance-design.md
git commit -m "docs: update CLAUDE.md and spec for sharesPerToken invariance redesign"
```
