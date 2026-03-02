import * as fs from 'fs';
import * as path from 'path';

/**
 * Generate Standard Input JSON for Etherscan Verification
 *
 * This script extracts the standard input JSON from Hardhat's build-info
 * for manual verification on Etherscan. This is the most reliable method
 * for verifying contracts compiled with viaIR.
 *
 * Usage:
 *   npx ts-node scripts/generate-verification-json.ts
 */

async function main() {
  console.log('\n📝 Generating Verification JSON for Express\n');
  console.log('='.repeat(60));

  // Find the latest build-info file
  const buildInfoDir = path.join(__dirname, '../artifacts/build-info');
  const files = fs
    .readdirSync(buildInfoDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      name: f,
      path: path.join(buildInfoDir, f),
      mtime: fs.statSync(path.join(buildInfoDir, f)).mtime,
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (files.length === 0) {
    console.log('❌ No build-info files found. Please compile the contracts first.');
    console.log('   Run: npx hardhat compile');
    return;
  }

  const latestBuildInfo = files[0];
  console.log('📦 Using build info:', latestBuildInfo.name);
  console.log('📅 Last modified:', latestBuildInfo.mtime.toISOString());

  // Read the build info
  const buildInfo = JSON.parse(fs.readFileSync(latestBuildInfo.path, 'utf8'));

  // Extract the input section which contains the standard JSON
  const standardInput = buildInfo.input;

  // Write to a new file
  const outputPath = path.join(__dirname, '../Express-verification-input.json');
  fs.writeFileSync(outputPath, JSON.stringify(standardInput, null, 2));

  console.log('\n✅ Standard input JSON generated!');
  console.log('📁 Location:', outputPath);

  console.log('\n' + '='.repeat(60));
  console.log('📋 Manual Verification Steps:');
  console.log('='.repeat(60));
  console.log('\n1. Visit Etherscan:');
  console.log('   https://sepolia.etherscan.io/address/0x25708d679f999ff1A9ac8f3f9Cfec60B4B973499#code');
  console.log('\n2. Click "Verify and Publish"');
  console.log('\n3. Select verification method:');
  console.log('   ✓ "Solidity (Standard-Json-Input)"');
  console.log('\n4. Compiler Configuration:');
  console.log('   - Compiler: v0.8.22+commit.4fc1097e');
  console.log('   - Open Source License Type: MIT License (MIT)');
  console.log('\n5. Upload the JSON file:');
  console.log('   ' + outputPath);
  console.log('\n6. Click "Verify and Publish"');
  console.log('\n💡 Tip: The Standard JSON Input method includes all compiler');
  console.log('   settings (optimizer, viaIR, etc.) automatically, making it');
  console.log('   the most reliable method for complex contracts.');

  // Also show compiler settings for reference
  console.log('\n' + '='.repeat(60));
  console.log('🔧 Compiler Settings (for reference):');
  console.log('='.repeat(60));
  console.log(JSON.stringify(buildInfo.solcLongVersion, null, 2));
  console.log('\nOptimizer:', buildInfo.input.settings.optimizer);
  console.log('Via IR:', buildInfo.input.settings.viaIR);
  console.log('EVM Version:', buildInfo.input.settings.evmVersion);

  console.log('\n' + '='.repeat(60) + '\n');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
