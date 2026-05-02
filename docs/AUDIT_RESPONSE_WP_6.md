# Audit Response — WatchPug Round #5 (HYBOND)

Source: https://notes.watchpug.com/p/19dd315ee90Rc9DU
Branch: `wp/5`
Status legend: ✅ Fixed · ⚪ Acknowledged (no change) · 🟡 Partial

---

## [WP-H1] De-KYC'd redeem sender deadlocks settlement and emergency cancel — ✅ Fixed

### Finding

`_refundOrEscrow` only routed to escrow when `token.isBanned(_sender)`. After the Token-side KYC gate was added in `Token._update`, a de-KYC'd sender at the head of `pendingRedeemQueue` / `redeemQueue` deadlocked the queue: settlement reverts via `_validateKyc`, and the emergency cancel paths revert via `Token._update`'s `NotKyced` check inside the refund `safeTransfer`.

### Resolution

Extended `_refundOrEscrow` to mirror `Token._update`'s gate: route to `redeemEscrowBalance` when the sender is banned **or** (in permissioned mode) not KYC'd. The user reclaims via `claimRedeemEscrow` after re-KYC.

```solidity
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
```

**Files touched:**
- `contracts/extension/Express.sol` — `_refundOrEscrow`; mgtFeeTo operational invariant comment updated to reflect that cancel paths now succeed and refunds escrow.
- `test/unit/Express.comprehensive.test.ts` — added two regression tests covering `cancelPendingRedeem` and `cancelRedeem` for de-KYC'd users (escrow + re-KYC + claim round-trip).

**Settlement note:** `processPendingRedeems` / `processRedeemQueue` still revert on a de-KYC'd head entry by design (KYC must hold through settlement). The remediation is now reachable: MAINTAINER calls `cancelPendingRedeem` / `cancelRedeem`, which routes the refund to escrow instead of reverting, unblocking the queue for the users behind.

---

## [WP-I2] `updateOffchainShares` accepts arbitrary values while queues non-empty — ✅ Fixed

### Finding

`updateOffchainShares` is a rare admin override (e.g., share-split reconciliation). Without a queue-empty guard, an operator error mid-settlement re-prices in-flight batches against a freshly-rewritten `offchainShares`, breaking the documented invariance of `sharesPerToken` during deposit/redeem operations.

### Resolution

Added `_requireQueuesEmpty()` to match the discipline already enforced by `updateMgtFeeTo` and `setKycManager`.

```solidity
function updateOffchainShares(uint256 _newValue) external onlyRole(MAINTAINER_ROLE) {
    _requireQueuesEmpty();
    uint256 previous = offchainShares;
    offchainShares = _newValue;
    emit UpdateOffchainShares(_msgSender(), _newValue, previous);
}
```

**Files touched:** `contracts/extension/Express.sol`.

---

## [WP-I3] `Token.setKycManager` lacks queue-empty / cross-contract consistency guard — ⚪ Acknowledged, no change

### Finding

Token's `setKycManager` is unguarded. Rotating it while Express queues are non-empty risks Express<->Token KYC manager desync (Express validates against the old manager; Token rejects against the new manager).

### Decision: Accept the risk; do not modify Token.

We are intentionally keeping `Token` independent of `Express`. Reasons:

1. **Architectural separation.** Token is a generic, reusable upgradeable ERC20. Wiring it to know about Express's queue state would create a back-reference from a base contract to a specific extension, which we have explicitly avoided. The current direction (Express references Token, never the reverse) is the boundary we want to preserve.
2. **Operational, not protocol-level, hazard.** `setKycManager` is admin-gated (`DEFAULT_ADMIN_ROLE` on Token). The mitigation lives in the rotation runbook: drain Express queues → rotate KycManager on Token → rotate on Express → KYC-list system wallets in the new manager. We accept this is procedural rather than enforced on-chain.
3. **Safer on-chain footprint.** The proposed coupling (Token reading from a shared singleton, or Token validating Express queue state) widens Token's storage and trust surface for a scenario that requires a privileged actor to misbehave.

We've documented the rotation sequence as part of the operational runbook for the admin role. No code change.

---

## [WP-I4] Deviation tolerances default to zero on initialize — ✅ Fixed

### Finding

`depositMaxDeviationBps` and `redeemMaxDeviationBps` defaulted to `0` because `initialize` did not set them. Strict-equality enforcement against an oracle-priced batch fails on first use due to rounding drift, and the corrective setters require empty queues — forcing a cancel-drain-update-resubmit recovery on day one.

### Resolution

Added both fields as explicit `initialize` parameters (matching the `_maxStalePeriod` pattern). Deploy scripts read them from network config and pass them at init time. Production configs default to `100` BPS (1%) per the design spec.

```solidity
function initialize(
    ...
    address _kycManager,
    uint256 _depositMaxDeviationBps,
    uint256 _redeemMaxDeviationBps
) external initializer {
    ...
    depositMaxDeviationBps = _depositMaxDeviationBps;
    redeemMaxDeviationBps = _redeemMaxDeviationBps;
    ...
}
```

**Files touched:**
- `contracts/extension/Express.sol` — `initialize` signature + body + docstring.
- `deploy/00_deploy_hybond_all.ts`, `deploy/04_deploy_express.ts` — read new keys from config and pass to `initialize`.
- `config/sepolia.json`, `config/mainnet.json` — added `depositMaxDeviationBps: 100`, `redeemMaxDeviationBps: 100`.
- `test/fixtures/expressDeployments.ts` — pass `10000` (effectively disabled) at init for permissive test defaults; removed the now-redundant post-init `update*MaxDeviationBps` calls.
- `test/unit/Express.comprehensive.test.ts`, `test/unit/Express.OffchainShares.test.ts` — updated all `deployProxy` callsites to include the two new params.

---

## Verification

- `npm run compile` — clean.
- `npm test` — **389 passing**, including the two new WP-H1 regression tests.
