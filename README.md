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

- [sepolia.json](/Users/duke/mycoding/openeden/gitlab/hybond/hybond-contracts/config/sepolia.json)
- [mainnet.json](/Users/duke/mycoding/openeden/gitlab/hybond/hybond-contracts/config/mainnet.json)

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
