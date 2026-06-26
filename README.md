# HYBOND Contracts

Smart contracts and deployment scripts for the HYBOND system.

The repository is built on Hardhat and uses OpenZeppelin UUPS proxies for the main upgradeable contracts.

## Contracts

Primary contracts in this repo:

- `HYBOND` token
- `AssetRegistry`
- `Express`
- `PriceOracle`

The current `PriceOracle` uses:

- dual deviation guardrails (`relativeMaxDeviation` and `absoluteMaxDeviation`)
- staged updates via `proposePrice()` and `confirmPrice()`
- a 1-day expiry for pending price proposals

## Management Fee Accounting (Express)

`Express` charges a daily management fee to `mgtFeeTo` via `updateEpoch`. Fee accounting uses two counters:

- **`totalMgtFeeMinted`** — cumulative fees ever minted. Monotonic; never decremented. Anchors historical dilution in the `sharesPerToken` denominator even after fee tokens are burned.
- **`totalMgtFeeUnclaimed`** — currently live (unredeemed) fee tokens. Decremented when fee tokens move from the pending redeem queue to the final redeem queue.

Share accounting:

```
circulatingSupply = totalSupply − totalRedeemQueueShares − totalMgtFeeUnclaimed
sharesPerToken    = circulatingSupply / (circulatingSupply + totalMgtFeeMinted)
```

The ratio moves only on fee accrual and new user deposits. Fee redemptions (request → pending→final → burn) leave both `circulatingSupply` and `sharesPerToken` unchanged.

On-chain guards:

- `requestRedeem` called by `mgtFeeTo` **overrides** the caller-supplied amount to `totalMgtFeeUnclaimed` (full live balance). Prevents fee-share provenance desync.
- `updateMgtFeeTo` requires `totalMgtFeeUnclaimed == 0` AND empty redeem queues.
- `requestDeposit` and `_calculateMintAmount` both revert `DrainedInstance` when `circulatingSupply() == 0 && totalMgtFeeMinted > 0` — a drained instance with historical fees is terminal; redeploy instead of reusing.

### Operational invariants for `mgtFeeTo` (enforced off-chain)

The full list lives in the comment block at `contracts/extension/Express.sol` near the `mgtFeeTo` declaration. Operators must:

1. Transfer HYBOND shares from `mgtFeeTo` only to the `Express` contract via `requestRedeem`.
2. Move any non-fee shares that land on `mgtFeeTo` to a quarantine wallet; do not redeem them from `mgtFeeTo`.
3. Never ban `mgtFeeTo` while it holds live fees or has in-flight fee redeems.
4. Drain both redeem queues before rotating `mgtFeeTo` (also enforced on-chain).
5. Keep `mgtFeeTo` unbanned for the lifetime of the pool — future `updateEpoch` mints would fail on a banned recipient.
6. Keep `mgtFeeTo` and any fee-redeem receiver KYC-listed through settlement.
7. Do not change `convertRedeemRequestsDelay`, `redeemFeeRate`, `depositFeeRate`, `priceOracle`, `maxStalePeriod`, or `trimDecimals` while any queue is non-empty — these values are read live at processing time and changes retroactively affect queued entries.

## Requirements

- Node.js 18+ recommended
- npm

## Install

```bash
npm install
```

## Environment

Create a `.env` file for network access and verification:

```env
PRIVATE_KEY=your_private_key
ALCHEMY_KEY=your_alchemy_api_key
ETHERSCAN_KEY=your_etherscan_api_key
```

## Network Config

Deployment parameters are stored in:

- [config/sepolia.json](./config/sepolia.json)
- [config/mainnet.json](./config/mainnet.json)

The config format is hierarchical. Each top-level key is a contract or shared section, and that section contains its parameters.

Example:

```json
{
  "Common": {
    "admin": "0x..."
  },
  "PriceOracle": {
    "decimals": 8,
    "relativeMaxDeviation": 500,
    "absoluteMaxDeviation": 1000,
    "initPrice": "1",
    "referencePrice": "1",
    "operator": "0x..."
  }
}
```

Current top-level sections:

- `Common`
- `HYBOND`
- `AssetRegistry`
- `PriceOracle`
- `Express`

Notes:

- `hardhat` and `localhost` deployments use `config/sepolia.json` as the default config source.
- Several address fields are set to the zero address in the sample configs. In the deploy scripts, those fields fall back to `deployer` for admin/operator/fee-recipient style values.
- Real deployment addresses should be filled in before deploying to testnet or mainnet.

## Compile

```bash
npm run compile
```

## Test

Run all tests:

```bash
npm test
```

Useful subsets:

```bash
npm run test:unit
npm run test:integration
npm run coverage
```

## Deploy

The repo uses `hardhat-deploy` tags.

Deploy the full system:

```bash
npx hardhat deploy --network sepolia --tags hybond_all
```

Individual deploy scripts:

- `deploy/00_deploy_hybond_all.ts`
- `deploy/02_deploy_hybond_token.ts`
- `deploy/03_deploy_asset_registry.ts`
- `deploy/04_deploy_express.ts`
- `deploy/05_deploy_price_oracle.ts`

Examples:

```bash
npx hardhat deploy --network sepolia --tags hybond_all
npx hardhat deploy --network sepolia --tags hybond
npx hardhat deploy --network sepolia --tags asset_registry
npx hardhat deploy --network sepolia --tags express
npx hardhat deploy --network sepolia --tags price_oracle
```

## PriceOracle Deployment Notes

`deploy/05_deploy_price_oracle.ts` reads from the `PriceOracle` and `Common` config sections.

Initializer arguments:

```text
(decimals, relativeMaxDeviation, absoluteMaxDeviation, initPrice, referencePrice, admin)
```

After deployment the script:

- grants `OPERATOR_ROLE` if needed
- does not auto-grant `CONFIRMER_ROLE`
- does not auto-grant `UPGRADE_ROLE`

Those roles must be granted separately if your operational flow requires them.

## Formatting

```bash
npm run format
npm run format:check
```

## Verification

Useful commands:

```bash
npm run verify:generate-json
npm run verify:all
```

## Notes

- The deployment scripts are network-config driven; prefer updating `config/*.json` over editing hardcoded values in scripts.
- For upgradeable contracts, do not change storage layout unless you are intentionally introducing a new deployment baseline and understand the upgrade implications.

## Deployed Addresses

Deployed contract addresses for all networks (mainnet + testnet) are in [`deployed-addresses.md`](./deployed-addresses.md).

## Audits

Independent security audit reports are in [`audits/`](./audits/).

## Attribution

This project is released under the [MIT License](./LICENSE). While the MIT
License does not require it, if you use this software in your own product or
service, we kindly ask that you include visible attribution to **OpenEden**
(e.g. in your documentation, UI, or credits) and link to
[openeden.com](https://openeden.com/).
