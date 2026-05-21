import { ethers, upgrades } from 'hardhat';

async function main() {
  const proxies: Record<string, string> = {
    HYBOND: '0x323e2B26373C5f4dD804c11759C7006efedc0E10',
    Express: '0x9e3A1F46820DB3f2724A5966647C0C0b9A4aa3Af',
    AssetRegistry: '0x1bF4Aba3fCF4b853FeDB3D027D3cb94d77267f92',
    PriceOracle: '0xc47aF12cAd7e8Caf8639D719B180C78Fb24134A9',
    KycManager: '0xE957f756A6f7cA6a9Aa33A65679E5CA67b967591',
  };
  for (const [name, addr] of Object.entries(proxies)) {
    const impl = await upgrades.erc1967.getImplementationAddress(addr);
    console.log(`${name.padEnd(14)} proxy=${addr} impl=${impl}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
