# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important: Naming Convention

**The project uses deposit/redeem terminology:**
- ✅ Use: `deposit`, `redeem`, `requestDeposit`, `requestRedeem`
- ❌ Avoid: `mint`, `withdraw`, `depositRequest`, `withdrawRequest`

**Key terminology:**
- `depositFeeRate` / `redeemFeeRate` (not mintFeeRate/withdrawFeeRate)
- `depositMinimum` / `redeemMinimum` (not mintMinimum/withdrawMinimum)
- `depositQueue` / `redeemQueue` (not mintQueue/withdrawQueue)
- `processDepositQueue()` / `processRedeemQueue()` (not ProcessDepositQueue/processWithdrawQueue)
- `pendingRedeemQueue` (not pendingWithdrawQueue)
- `processPendingRedeems()` (not processPendingWithdraws)
- `revertRedeemToPending()` (not revertWithdrawToPending)
- `redeemDelay` (not withdrawDelay)
- `redeemAsset` (not withdrawAsset)
- `DepositRedeemLimiter` (not DepositWithdrawLimiter)

## Project Overview

This is a Solidity smart contract project for **HYBOND**, a tokenized real-world asset (RWA) system implementing:
- An upgradeable ERC20 token with access control, pause, ban list, and issue cap
- A queued deposit and redeem gateway (Express) with KYC/compliance
- An ERC4626 vault for staking with T+N redemption queue
- Asset registry for multi-asset support with price feeds

The contracts are upgradeable via UUPS proxy pattern and deployed using hardhat-deploy.

**Note:** The codebase contains references to "OEM" (OpenEden Multi Strategy Yield) and "USDO Prime" from earlier iterations, but the project is now branded as **HYBOND**.

## Core Architecture

### Contract Hierarchy

```
Token (Core HYBOND Token)
├── Core ERC20 with access control
├── Minting controlled by MINTER_ROLE (granted to Express)
└── Burning controlled by BURNER_ROLE (granted to Express)

Express (Gateway)
├── Inherits: ExpressPausable, DepositRedeemLimiter
├── Uses DoubleQueueModified for FIFO request queues
├── Integrates with AssetRegistry for multi-asset support
└── Implements queued deposit and redeem flows

AssetRegistry
├── Manages supported assets and their configurations
├── Stores price feed references per asset
└── Used by Express to validate and price assets

RedemptionQueue (separate contract, not in current files)
└── Manages T+N unstaking queue for vault withdrawals
```

### Key Design Patterns

**Upgradeable Pattern**: All core contracts use UUPS (UUPSUpgradeable) with upgrade control via `UPGRADE_ROLE`

**Role-Based Access Control**: Uses OpenZeppelin's AccessControlEnumerableUpgradeable
- `DEFAULT_ADMIN_ROLE`: Full administrative control
- `MINTER_ROLE`, `BURNER_ROLE`: Token supply management
- `PAUSE_ROLE`: Emergency pause
- `BANLIST_ROLE`: Ban list management
- `MAINTAINER_ROLE`: Configuration updates
- `OPERATOR_ROLE`: Process queues
- `WHITELIST_ROLE`: KYC management
- `UPGRADE_ROLE`: Contract upgrades

**Queue-Driven Flows**: Express uses DoubleQueueModified (bytes-based deque) for FIFO processing of deposit and redeem requests

**First Deposit Requirements**: Users must make a minimum first deposit before subsequent operations (tracked via `firstDeposit` mapping)

**Fee System**: Basis point fees (BPS_BASE = 10000) for deposits and redemptions

## Development Commands

### Setup
```bash
npm install
```

### Compilation
```bash
npm run compile        # Compile all contracts
npm run clean          # Clean artifacts and cache
npm run typechain      # Generate TypeChain types
```

### Testing
```bash
npm test                        # Run all tests
npm run test:unit              # Run unit tests only
npm run test:integration       # Run integration tests only
npm run test:express           # Run Express contract tests
npm run test:vault             # Run Vault contract tests
npm run test:queue             # Run queue tests
npm run test:fuzz              # Run fuzz tests
npm run test:invariants        # Run invariant tests
```

### Coverage & Analysis
```bash
npm run coverage               # Full coverage report
npm run coverage:unit          # Coverage for unit tests only
npm run gas-report             # Gas usage report (set REPORT_GAS=true)
npm run size                   # Contract size analysis
```

### Deployment
```bash
# Deploy all contracts at once (recommended for first deployment)
npx hardhat deploy --network <network> --tags hybond_all

# Deploy individual contracts
npx hardhat deploy --network <network> --tags mock_erc20
npx hardhat deploy --network <network> --tags token
npx hardhat deploy --network <network> --tags asset_registry
npx hardhat deploy --network <network> --tags price_oracle
npx hardhat deploy --network <network> --tags express

# Force redeploy
npx hardhat deploy --network <network> --tags <tag> --reset

# Available networks: hardhat, sepolia, base_sepolia, arbi_sepolia, bsc_testnet,
#                     mainnet, base_mainnet, arb_mainnet, bsc_mainnet, kairos
```

### Formatting & Linting
```bash
npm run format                 # Format Solidity and TypeScript files
npm run format:check          # Check formatting without changes
```

### Running Tests for Specific Files
```bash
npx hardhat test test/unit/Express.comprehensive.test.ts
npx hardhat test test/unit/Token.test.ts
```

## Critical Implementation Details

### Express Contract Queue Flow

**Current Architecture**: Express is fully queue-driven:
- All operations use queued request/processing pattern
- Deposit flow: `requestDeposit()` → enqueue → `processDepositQueue()` → mint tokens
- Redeem flow (T+2, operator-enforced off-chain): `requestRedeem()` → `pendingRedeemQueue` → `processPendingRedeems()` → `redeemQueue` → `processRedeemQueue()` → burn tokens and transfer assets
- Fee handling occurs at different phases:
  - Deposit: Fee charged at request time (in underlying asset)
  - Redeem: Fee calculated at T+2 pricing (in redeemAsset)
- All queue processing must re-check KYC status
- Liquidity-aware processing (break when insufficient underlying)

### Queue Processing Pattern (from DoubleQueueModified)
```solidity
// FIFO processing with length parameter
function processQueue(uint256 _len) {
    uint256 toProcess = _len == 0 ? queue.length() : min(_len, queue.length());
    for (uint256 i = 0; i < toProcess; i++) {
        bytes memory request = queue.popFront();
        // decode and process
        // break early if insufficient liquidity
    }
}
```

### KYC/Compliance Enforcement
- KYC required for both sender and receiver in deposit/redeem requests
- KYC re-checked during queue processing (status can change between request and processing)
- Managed via `kycList` mapping and `WHITELIST_ROLE`

### First Deposit Logic
- Tracked via `firstDeposit[user]` boolean mapping
- Must meet `firstDepositAmount` threshold on first deposit
- Subsequent deposits only need to meet `depositMinimum`

### Fee Calculation
- Fees in basis points (BPS): `feeAmount = amount * feeRate / BPS_BASE`
- `depositFeeRate`, `redeemFeeRate` configurable by `MAINTAINER_ROLE`
- Fee recipients: `treasury`, `txFeeTo`, `mgtFeeTo`

### Management Fee Accounting (`offchainShares` / `totalMgtFeeUnclaimed`)
- **`offchainShares`**: the active BNY share value used as the numerator in `_sharesPerToken`. Set via a two-step propose+confirm flow: OPERATOR_ROLE proposes with `proposeOffchainShares`, CONFIRM_ROLE confirms with `confirmOffchainShares`. Latest proposal wins (re-propose to correct a wrong value before the confirmer echoes it).
- **`proposedOffchainShares`**: pending value awaiting confirmation. Cleared to zero on confirm. `updateEpoch` reverts `PendingProposalExists` while this is non-zero, ensuring the epoch always bakes in a freshly confirmed value.
- **`totalMgtFeeUnclaimed`**: currently live (unredeemed) fee tokens. Decremented when fee tokens move pending→final in `_processSinglePendingRedeem`; re-credited in `cancelRedeem` and `revertRedeemToPending` for fee-owned entries.
- **Formula**: `sharesPerToken = offchainShares / (totalSupply - totalRedeemQueueShares)`. Falls back to `1e18` when the denominator is zero (bootstrap, or fully drained pool). The ratio drops whenever `updateEpoch` mints new HYBOND tokens to `mgtFeeTo` (inflating `totalSupply` while `offchainShares` stays unchanged), and rises on the next `confirmOffchainShares` that reflects BNY growth.
- `mgtFeeTo` redeems via `requestRedeem`, which **overrides the caller-supplied amount to `totalMgtFeeUnclaimed`** (full live balance) to prevent provenance desync.
- `updateMgtFeeTo` requires `totalMgtFeeUnclaimed == 0` AND both redeem queues empty.
- **Pre-sync fairness**: when `offchainShares == 0`, `_sharesPerToken()` returns the 1e18 fallback so deposits and redeems settle at 1:1. This is economically fair (users get the exact asset-value of their shares) and safe because `updateEpoch` is a no-op while `offchainShares == 0` (`dailyFee = 0 * rate = 0`) — no dilution can happen in the pre-sync window.

### mgtFeeTo Operational Invariants (enforced off-chain)
See the comment block at `Express.sol:80` near the `mgtFeeTo` declaration for the full list. Summary:
1. mgtFeeTo transfers HYBOND shares only to Express via `requestRedeem`.
2. Non-fee shares accidentally received by mgtFeeTo go to quarantine, not redeemed.
3. Don't ban mgtFeeTo while it holds fees or has in-flight fee redeems.
4. Rotating mgtFeeTo requires drained queues (enforced on-chain).
5. mgtFeeTo stays unbanned for the pool lifetime (epoch mints would fail on banned recipient).
6. mgtFeeTo and redeem receivers stay KYC'd through settlement.
7. Don't change `redeemFeeRate`, `depositFeeRate`, `priceOracle`, `maxStalePeriod`, or `trimDecimals` while any queue is non-empty (changes retroactively affect queued entries).

### Storage Safety for Upgrades
- NEVER reorder or remove existing state variables
- ALWAYS append new state variables at the end
- Use `__gap` arrays to reserve storage slots for future variables
- Pay attention to inheritance order - changes affect storage layout

### Asset Registry Integration
- Express queries AssetRegistry for supported assets
- Price feeds stored per asset for non-1:1 conversions
- `maxStalePeriod` enforces price data freshness

## Testing Patterns

### Fixture-Based Testing
Tests use `loadFixture()` from `@nomicfoundation/hardhat-network-helpers` for fast, isolated test setup:
```typescript
const { express, oem, usdo, treasury, feeTo } = await loadFixture(deployFixture);
```

### Deployment Fixtures
Located in `test/fixtures/` - reusable contract deployment helpers

### Test Structure
- `test/unit/` - Unit tests for individual contracts
- `test/integration/` - Integration tests for cross-contract flows
- Fuzz and invariant tests for property-based testing

## Configuration Files

### Environment Variables (.env)
```
PRIVATE_KEY=           # Deployer private key
ALCHEMY_KEY=           # Alchemy RPC API key
ETHERSCAN_KEY=         # Etherscan API key for verification
ARBSCAN_KEY=           # Arbiscan API key
BASESCAN_KEY=          # Basescan API key
BSCSCAN_KEY=           # BSC Scan API key
KAIASCAN_KEY=          # Kaia Scan API key
QUICK_NODE_RPC=        # Alternative RPC endpoint
REPORT_GAS=true        # Enable gas reporting
```

### Hardhat Configuration
- Solidity: 0.8.22 with viaIR optimizer (200 runs)
- TypeChain target: ethers-v6
- Mocha timeout: 120s (for complex integration tests)
- Network configs include mainnet, testnets, and L2s

## Deployment Architecture

### Deployment Order (Dependencies)
1. MockERC20 (USDC) - optional, for testing only
2. Token - core HYBOND token contract
3. AssetRegistry - can deploy in parallel with Token
4. PriceOracle - can deploy in parallel with Token
5. Express - requires Token + AssetRegistry + PriceOracle + USDC

### Post-Deployment Configuration
After deploying contracts:
1. Grant `MINTER_ROLE` and `BURNER_ROLE` on Token to Express contract
2. Configure assets in AssetRegistry via `setAssetConfig()`
3. Set fee rates in Express via `updateDepositFeeRate()` / `updateRedeemFeeRate()`
4. Grant KYC status to users via `grantKycInBulk()`
5. Set vault address in RedemptionQueue
6. Verify all contracts on block explorer

### Deployment Tags
- `hybond_all`: Deploy entire HYBOND system (recommended)
- `core`: Core contracts (Token)
- `extension`: Extension contracts (Express)
- Individual tags: `mock_erc20`, `token`, `asset_registry`, `price_oracle`, `express`

**Note:** Some deployment scripts and test fixtures may still reference "OEM" or "USDOX" for historical reasons, but they deploy the HYBOND system.

## Common Development Workflows

### Adding a New Queue Function
1. Define request struct and encoding/decoding helpers
2. Add queue state variable (e.g., `DoubleQueueModified.BytesDeque`)
3. Add user tracking mapping (e.g., `mapping(address => uint256)`)
4. Implement request function with KYC checks and enqueue logic
5. Implement processing function with FIFO iteration and KYC revalidation
6. Add queue view functions (length, user amount, item decode)
7. Add cancel function with proper refund logic
8. Emit events for observability
9. Write comprehensive unit tests

### Modifying Fee Logic
1. Update fee calculation in request or process phase (consistent with fee-on-request precedence)
2. Update fee transfer logic
3. Add/update events
4. Update tests to verify fee amounts and recipients
5. Update integration tests for cross-contract fee flows

### Adding New Role-Gated Functions
1. Check if existing role is appropriate or define new role constant
2. Add role check modifier or inline `_checkRole()` call
3. Grant role in initialization function
4. Update deployment scripts to grant role
5. Test role enforcement (should revert for non-role holders)

### Upgrading Contracts
1. Create new implementation contract version
2. Deploy via upgrade script in `deploy/upgrade/`
3. Test with upgraded proxy thoroughly
4. Verify storage layout hasn't been corrupted
5. Re-verify implementation contract on block explorer

## Common Gotchas

1. **Gas Optimization**: Contracts use `viaIR` optimizer which can cause long compile times for complex contracts
2. **Queue Processing**: Always validate `_len` parameter (0 = process all, otherwise cap at queue length)
3. **KYC Timing**: KYC can be revoked between request and processing - always recheck in process functions
4. **First Deposit**: Don't forget to check `firstDeposit[user]` when validating deposit amounts
5. **Liquidity Breaks**: Redeem processing must break early if insufficient underlying assets
6. **Storage Layout**: Never reorder state variables in upgradeable contracts
7. **Role Management**: Roles are per-contract - granting roles must happen on each deployed contract
8. **Decimal Precision**: HYBOND token uses 18 decimals; ensure asset conversions respect decimals
9. **Fee Basis Points**: Fees use 10000 basis points (100.00%) - don't confuse with percentages
10. **Upgrade Safety**: Test upgrades on testnet first; storage corruption is irreversible

## Reference Documents

- **Deployment Guide**: `docs/DEPLOYMENT.md` - comprehensive deployment and verification instructions
- **Project Plan**: `plan.md` - current refactoring objectives for Express contract
- **Test Fixtures**: `test/fixtures/` - reusable deployment fixtures for testing
