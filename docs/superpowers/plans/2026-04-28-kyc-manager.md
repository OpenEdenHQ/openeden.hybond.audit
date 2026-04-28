# KycManager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize KYC into a new `KycManager` contract; make Token optionally permissioned (KYC-gated transfers); migrate Express off its in-contract KYC list.

**Architecture:** New UUPS-upgradeable `KycManager` (AccessControlEnumerable, two roles: `DEFAULT_ADMIN_ROLE` + `WHITELIST_ROLE`). Token gains optional `kycManager` reference — when set, both `from` and `to` must be KYC'd on every `_update` (mint/burn/transfer; `address(0)` exempt). Express drops its `kycList`/`WHITELIST_ROLE`/`grantKycInBulk`/`revokeKycInBulk` and reads the same manager (manager required, zero rejected). Manager rotation on Express requires all queues empty. Manager-revert behavior: bubble (no try/catch). Fresh deployment — no upgrade compat constraint.

**Tech Stack:** Solidity 0.8.22, OpenZeppelin upgradeable contracts (`AccessControlEnumerableUpgradeable`, `UUPSUpgradeable`), Hardhat, ethers v6, hardhat-deploy, TypeChain, Mocha/Chai.

**Spec:** `docs/superpowers/specs/2026-04-28-kyc-manager-design.md`

---

## File Map

**Create:**
- `contracts/core/KycManager.sol` — new manager contract.
- `contracts/interfaces/IKycManager.sol` — narrow interface used by Token + Express.
- `test/unit/KycManager.test.ts` — unit tests for the manager.
- `test/fixtures/kycManagerDeployments.ts` — small standalone fixture for KycManager-only tests.
- `deploy/02a_deploy_kyc_manager.ts` — standalone deploy.
- `contracts/mocks/KycManagerRevertMock.sol` — minimal mock that always reverts on `isKyced` (used to verify Token bubbles the revert).

**Modify:**
- `contracts/core/Token.sol` — add `kycManager` state, `setKycManager`, gate in `_update`, extend `initialize` signature, new event/error.
- `contracts/extension/Express.sol` — remove `kycList`/`WHITELIST_ROLE`/`grantKycInBulk`/`revokeKycInBulk`/related events; add `kycManager` state + setter (queue-empty guard); rewrite `_validateKyc`; extend `initialize` signature.
- `contracts/interfaces/IToken.sol` — only if `IToken` exposes `initialize`-shaped types (verify; usually not).
- `test/fixtures/expressDeployments.ts` — deploy `KycManager`, wire it into both Token and Express, replace KYC grants on Express with grants on the manager, drop the now-removed `WHITELIST_ROLE` lookup on Express.
- `test/fixtures/deployments.ts` — same change shape as `expressDeployments.ts` (only if it independently deploys Token/Express; verify before editing).
- `test/unit/Token.test.ts` — extend with permissionless-mode regression + permissioned-mode coverage + setter coverage + bubble-revert coverage.
- `test/unit/Express.comprehensive.test.ts` — drop writes to Express's old `kycList`; drive KYC via the new manager; add rotation-guard tests; add init-rejects-zero test.
- `test/unit/Express.invariance.test.ts`, `Express.mgtFeeAccounting.test.ts`, `Express.OffchainShares.test.ts`, `Express.sharePerToken.test.ts` — only if any of them call `express.grantKycInBulk(...)` or read `express.kycList(...)` directly. Sweep with grep before touching.
- `deploy/00_deploy_hybond_all.ts` — deploy KycManager between MockERC20 and Token; pass `kycManager.address` (or `ZeroAddress` based on `TOKEN_PERMISSIONED` env flag) into Token init; pass `kycManager.address` into Express init; grant `WHITELIST_ROLE` on the manager to the configured operational signer.
- `deploy/02_deploy_hybond_token.ts` — depend on KycManager deployment, pass it into Token init.
- `deploy/04_deploy_express.ts` — depend on KycManager deployment, pass it into Express init; remove or update the closing log line that references `grantKycInBulk()` (Express no longer has that selector).
- `deploy/config.ts` — add `kycManagerAddress` (per-network optional), `tokenPermissioned` (per-network bool, default true).

---

## Sweep Before Coding (one-time inventory — do this first)

- [ ] **Step 0.1: Inventory all KYC touch-points.** Search for any other test files or scripts that touch the soon-to-be-removed selectors.

```bash
grep -rn "grantKycInBulk\|revokeKycInBulk\|kycList\|WHITELIST_ROLE\|KycGranted\|KycRevoked" \
  contracts/ test/ deploy/ scripts/ 2>/dev/null
```

Expected: hits in `contracts/extension/Express.sol`, `test/fixtures/expressDeployments.ts`, `test/fixtures/deployments.ts` (verify), `test/unit/Express.comprehensive.test.ts`, possibly other unit tests, and `deploy/04_deploy_express.ts`. Make a checklist file at `/tmp/kyc-touchpoints.txt`. Every entry must be addressed by the end of the plan.

```bash
grep -rn "grantKycInBulk\|revokeKycInBulk\|kycList\|WHITELIST_ROLE\|KycGranted\|KycRevoked" \
  contracts/ test/ deploy/ scripts/ > /tmp/kyc-touchpoints.txt
```

- [ ] **Step 0.2: Confirm Express has no `__gap` array.** Run:

```bash
grep -n "__gap" contracts/extension/Express.sol
```

If it returns nothing, the contract relies on append-only safety (no gap). Note this — the implementation will append `address public kycManager` at the end of state vars; do NOT introduce a `__gap` for the first time as part of this change.

- [ ] **Step 0.3: Confirm there is no other contract depending on `Express.kycList(addr)` or `Express.grantKycInBulk(...)`.** The grep in 0.1 covers this. If any non-test consumer surfaces, stop and re-plan.

---

## Task 1: Add `IKycManager` interface

**Files:**
- Create: `contracts/interfaces/IKycManager.sol`

- [ ] **Step 1.1: Create the interface file.**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IKycManager {
    function isKyced(address account) external view returns (bool);
}
```

- [ ] **Step 1.2: Compile.**

Run: `npm run compile`
Expected: success, no errors.

- [ ] **Step 1.3: Commit.**

```bash
git add contracts/interfaces/IKycManager.sol
git commit -m "feat(kyc): add IKycManager interface"
```

---

## Task 2: Implement `KycManager` contract — TDD

**Files:**
- Create: `contracts/core/KycManager.sol`
- Create: `test/fixtures/kycManagerDeployments.ts`
- Create: `test/unit/KycManager.test.ts`

### 2A. Fixture for KycManager-only tests

- [ ] **Step 2A.1: Create the standalone fixture.**

```typescript
// test/fixtures/kycManagerDeployments.ts
import { ethers, upgrades } from 'hardhat';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

export interface KycManagerDeployment {
  kycManager: any;
  admin: HardhatEthersSigner;
  whitelister: HardhatEthersSigner;
  user1: HardhatEthersSigner;
  user2: HardhatEthersSigner;
  user3: HardhatEthersSigner;
  outsider: HardhatEthersSigner;
}

export async function deployKycManager(): Promise<KycManagerDeployment> {
  const [admin, whitelister, user1, user2, user3, outsider] = await ethers.getSigners();

  const KycManagerFactory = await ethers.getContractFactory('KycManager');
  const kycManager = await upgrades.deployProxy(KycManagerFactory, [admin.address], {
    kind: 'uups',
    initializer: 'initialize',
  });
  await kycManager.waitForDeployment();

  const WHITELIST_ROLE = await kycManager.WHITELIST_ROLE();
  await kycManager.connect(admin).grantRole(WHITELIST_ROLE, whitelister.address);

  return { kycManager, admin, whitelister, user1, user2, user3, outsider };
}
```

### 2B. Test: initialization

- [ ] **Step 2B.1: Write the failing initialize tests.**

```typescript
// test/unit/KycManager.test.ts (top of file)
import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { deployKycManager } from '../fixtures/kycManagerDeployments';

describe('KycManager', () => {
  describe('initialize', () => {
    it('grants DEFAULT_ADMIN_ROLE to admin', async () => {
      const { kycManager, admin } = await loadFixture(deployKycManager);
      const DEFAULT_ADMIN_ROLE = await kycManager.DEFAULT_ADMIN_ROLE();
      expect(await kycManager.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
    });

    it('rejects zero admin', async () => {
      const KycManagerFactory = await ethers.getContractFactory('KycManager');
      await expect(
        upgrades.deployProxy(KycManagerFactory, [ethers.ZeroAddress], {
          kind: 'uups',
          initializer: 'initialize',
        })
      ).to.be.revertedWithCustomError(KycManagerFactory, 'InvalidAddress');
    });

    it('cannot be re-initialized', async () => {
      const { kycManager, admin } = await loadFixture(deployKycManager);
      await expect(kycManager.initialize(admin.address)).to.be.revertedWithCustomError(
        kycManager,
        'InvalidInitialization'
      );
    });
  });
});
```

- [ ] **Step 2B.2: Run; confirm fail.**

Run: `npx hardhat test test/unit/KycManager.test.ts`
Expected: compilation fails (`KycManager` contract does not exist yet).

### 2C. Implement `KycManager` (initialize only) to pass init tests

- [ ] **Step 2C.1: Create the contract with just initialize/roles.**

```solidity
// contracts/core/KycManager.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @title KycManager
/// @notice Single source of truth for KYC across HYBOND Token and Express
contract KycManager is AccessControlEnumerableUpgradeable, UUPSUpgradeable {
    bytes32 public constant WHITELIST_ROLE = keccak256("WHITELIST_ROLE");

    mapping(address => bool) private _kycList;

    event KycGranted(address indexed account);
    event KycRevoked(address indexed account);

    error InvalidAddress();
    error AlreadyKyced(address account);
    error NotKyced(address account);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) public initializer {
        if (admin == address(0)) revert InvalidAddress();
        __AccessControlEnumerable_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function isKyced(address account) external view returns (bool) {
        return _kycList[account];
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    uint256[49] private __gap;
}
```

- [ ] **Step 2C.2: Compile and run init tests.**

Run: `npm run compile && npx hardhat test test/unit/KycManager.test.ts`
Expected: 3 tests pass (initialize section).

### 2D. Test: grantKyc / revokeKyc

- [ ] **Step 2D.1: Add failing tests.**

```typescript
  describe('grantKyc / revokeKyc', () => {
    it('grants KYC and emits event', async () => {
      const { kycManager, whitelister, user1 } = await loadFixture(deployKycManager);
      await expect(kycManager.connect(whitelister).grantKyc(user1.address))
        .to.emit(kycManager, 'KycGranted')
        .withArgs(user1.address);
      expect(await kycManager.isKyced(user1.address)).to.equal(true);
    });

    it('reverts AlreadyKyced when granting twice', async () => {
      const { kycManager, whitelister, user1 } = await loadFixture(deployKycManager);
      await kycManager.connect(whitelister).grantKyc(user1.address);
      await expect(kycManager.connect(whitelister).grantKyc(user1.address))
        .to.be.revertedWithCustomError(kycManager, 'AlreadyKyced')
        .withArgs(user1.address);
    });

    it('revokes KYC and emits event', async () => {
      const { kycManager, whitelister, user1 } = await loadFixture(deployKycManager);
      await kycManager.connect(whitelister).grantKyc(user1.address);
      await expect(kycManager.connect(whitelister).revokeKyc(user1.address))
        .to.emit(kycManager, 'KycRevoked')
        .withArgs(user1.address);
      expect(await kycManager.isKyced(user1.address)).to.equal(false);
    });

    it('reverts NotKyced when revoking a non-KYC address', async () => {
      const { kycManager, whitelister, user1 } = await loadFixture(deployKycManager);
      await expect(kycManager.connect(whitelister).revokeKyc(user1.address))
        .to.be.revertedWithCustomError(kycManager, 'NotKyced')
        .withArgs(user1.address);
    });

    it('rejects zero address on grant', async () => {
      const { kycManager, whitelister } = await loadFixture(deployKycManager);
      await expect(
        kycManager.connect(whitelister).grantKyc(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(kycManager, 'InvalidAddress');
    });

    it('only WHITELIST_ROLE can grant', async () => {
      const { kycManager, outsider, user1 } = await loadFixture(deployKycManager);
      await expect(
        kycManager.connect(outsider).grantKyc(user1.address)
      ).to.be.revertedWithCustomError(kycManager, 'AccessControlUnauthorizedAccount');
    });

    it('only WHITELIST_ROLE can revoke', async () => {
      const { kycManager, whitelister, outsider, user1 } = await loadFixture(deployKycManager);
      await kycManager.connect(whitelister).grantKyc(user1.address);
      await expect(
        kycManager.connect(outsider).revokeKyc(user1.address)
      ).to.be.revertedWithCustomError(kycManager, 'AccessControlUnauthorizedAccount');
    });
  });
```

- [ ] **Step 2D.2: Run; confirm fail (functions don't exist).**

Run: `npx hardhat test test/unit/KycManager.test.ts`
Expected: compile error referencing missing `grantKyc` / `revokeKyc`.

### 2E. Implement grantKyc / revokeKyc

- [ ] **Step 2E.1: Add to `KycManager.sol`.**

Insert directly after the `isKyced` function:

```solidity
    function grantKyc(address account) external onlyRole(WHITELIST_ROLE) {
        _grantKyc(account);
    }

    function revokeKyc(address account) external onlyRole(WHITELIST_ROLE) {
        _revokeKyc(account);
    }

    function _grantKyc(address account) private {
        if (account == address(0)) revert InvalidAddress();
        if (_kycList[account]) revert AlreadyKyced(account);
        _kycList[account] = true;
        emit KycGranted(account);
    }

    function _revokeKyc(address account) private {
        if (!_kycList[account]) revert NotKyced(account);
        _kycList[account] = false;
        emit KycRevoked(account);
    }
```

- [ ] **Step 2E.2: Run.**

Run: `npx hardhat test test/unit/KycManager.test.ts`
Expected: all grant/revoke tests pass.

### 2F. Test + implement bulk variants

- [ ] **Step 2F.1: Add failing bulk tests.**

```typescript
  describe('grantKycBulk / revokeKycBulk', () => {
    it('grants multiple addresses and emits one event each', async () => {
      const { kycManager, whitelister, user1, user2, user3 } = await loadFixture(deployKycManager);
      const addrs = [user1.address, user2.address, user3.address];
      const tx = await kycManager.connect(whitelister).grantKycBulk(addrs);
      const receipt = await tx.wait();

      const granted = receipt.logs
        .map((log: any) => {
          try {
            return kycManager.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .filter((p: any) => p && p.name === 'KycGranted')
        .map((p: any) => p.args[0]);
      expect(granted).to.deep.equal(addrs);

      for (const a of addrs) expect(await kycManager.isKyced(a)).to.equal(true);
    });

    it('revokes multiple addresses', async () => {
      const { kycManager, whitelister, user1, user2 } = await loadFixture(deployKycManager);
      await kycManager.connect(whitelister).grantKycBulk([user1.address, user2.address]);
      await kycManager.connect(whitelister).revokeKycBulk([user1.address, user2.address]);
      expect(await kycManager.isKyced(user1.address)).to.equal(false);
      expect(await kycManager.isKyced(user2.address)).to.equal(false);
    });

    it('reverts the whole grantKycBulk batch on a duplicate', async () => {
      const { kycManager, whitelister, user1, user2 } = await loadFixture(deployKycManager);
      await kycManager.connect(whitelister).grantKyc(user1.address);
      await expect(
        kycManager.connect(whitelister).grantKycBulk([user2.address, user1.address])
      ).to.be.revertedWithCustomError(kycManager, 'AlreadyKyced').withArgs(user1.address);
      // user2 should NOT have been granted (whole batch reverted)
      expect(await kycManager.isKyced(user2.address)).to.equal(false);
    });

    it('only WHITELIST_ROLE can call bulk variants', async () => {
      const { kycManager, outsider, user1 } = await loadFixture(deployKycManager);
      await expect(
        kycManager.connect(outsider).grantKycBulk([user1.address])
      ).to.be.revertedWithCustomError(kycManager, 'AccessControlUnauthorizedAccount');
      await expect(
        kycManager.connect(outsider).revokeKycBulk([user1.address])
      ).to.be.revertedWithCustomError(kycManager, 'AccessControlUnauthorizedAccount');
    });
  });
```

- [ ] **Step 2F.2: Run; confirm fail.**

Run: `npx hardhat test test/unit/KycManager.test.ts`
Expected: compile error or test failures referencing missing `grantKycBulk` / `revokeKycBulk`.

- [ ] **Step 2F.3: Implement bulk variants.**

Insert in `KycManager.sol` directly after `revokeKyc`:

```solidity
    function grantKycBulk(address[] calldata accounts) external onlyRole(WHITELIST_ROLE) {
        uint256 length = accounts.length;
        for (uint256 i; i < length; ) {
            _grantKyc(accounts[i]);
            unchecked { ++i; }
        }
    }

    function revokeKycBulk(address[] calldata accounts) external onlyRole(WHITELIST_ROLE) {
        uint256 length = accounts.length;
        for (uint256 i; i < length; ) {
            _revokeKyc(accounts[i]);
            unchecked { ++i; }
        }
    }
```

- [ ] **Step 2F.4: Run.**

Run: `npx hardhat test test/unit/KycManager.test.ts`
Expected: all tests pass (initialize + grant/revoke + bulk).

### 2G. Test: UUPS upgrade authorization

- [ ] **Step 2G.1: Add failing upgrade test.**

```typescript
  describe('upgrade', () => {
    it('only DEFAULT_ADMIN_ROLE can authorize upgrade', async () => {
      const { kycManager, admin, outsider } = await loadFixture(deployKycManager);
      const KycManagerFactory = await ethers.getContractFactory('KycManager');

      // outsider cannot upgrade
      const newImpl = await KycManagerFactory.deploy();
      await newImpl.waitForDeployment();
      await expect(
        kycManager.connect(outsider).upgradeToAndCall(await newImpl.getAddress(), '0x')
      ).to.be.revertedWithCustomError(kycManager, 'AccessControlUnauthorizedAccount');

      // admin can upgrade
      await expect(kycManager.connect(admin).upgradeToAndCall(await newImpl.getAddress(), '0x'))
        .to.not.be.reverted;
    });
  });
```

- [ ] **Step 2G.2: Run.**

Run: `npx hardhat test test/unit/KycManager.test.ts`
Expected: pass (already implemented).

### 2H. Commit Task 2

- [ ] **Step 2H.1: Commit.**

```bash
git add contracts/core/KycManager.sol test/fixtures/kycManagerDeployments.ts test/unit/KycManager.test.ts
git commit -m "feat(kyc): add KycManager contract with role-gated grant/revoke + bulk + tests"
```

---

## Task 3: Add Token KYC gate — TDD

**Files:**
- Modify: `contracts/core/Token.sol`
- Create: `contracts/mocks/KycManagerRevertMock.sol`
- Modify: `test/unit/Token.test.ts`

### 3A. Mock that always reverts on `isKyced`

- [ ] **Step 3A.1: Create the mock.**

```solidity
// contracts/mocks/KycManagerRevertMock.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract KycManagerRevertMock {
    error MockBoom();
    function isKyced(address) external pure returns (bool) {
        revert MockBoom();
    }
}
```

### 3B. Failing tests for Token KYC gate (write before touching Token.sol)

- [ ] **Step 3B.1: Read the existing Token.test.ts fixture pattern.** Open `test/unit/Token.test.ts` and identify how Token is currently deployed (signature of `initialize`, fixture function name). The next steps assume a fixture pattern; if the file uses inline deployment, mirror that style instead.

- [ ] **Step 3B.2: Add a new describe block "with KycManager" — write all tests first.** Append to `test/unit/Token.test.ts`:

```typescript
import { deployKycManager } from '../fixtures/kycManagerDeployments';

describe('Token KYC gating', () => {
  async function deployPermissionedToken() {
    const kyc = await deployKycManager();
    const TokenFactory = await ethers.getContractFactory('Token');
    const token = await upgrades.deployProxy(
      TokenFactory,
      [
        'HYBOND',
        'HBND',
        kyc.admin.address,
        ethers.parseUnits('10000000', 18),
        await kyc.kycManager.getAddress(),
      ],
      { kind: 'uups', initializer: 'initialize' }
    );
    await token.waitForDeployment();

    const MINTER_ROLE = await token.MINTER_ROLE();
    const BURNER_ROLE = await token.BURNER_ROLE();
    await token.connect(kyc.admin).grantRole(MINTER_ROLE, kyc.admin.address);
    await token.connect(kyc.admin).grantRole(BURNER_ROLE, kyc.admin.address);

    return { token, ...kyc };
  }

  async function deployPermissionlessToken() {
    const [admin, user1, user2] = await ethers.getSigners();
    const TokenFactory = await ethers.getContractFactory('Token');
    const token = await upgrades.deployProxy(
      TokenFactory,
      ['HYBOND', 'HBND', admin.address, ethers.parseUnits('10000000', 18), ethers.ZeroAddress],
      { kind: 'uups', initializer: 'initialize' }
    );
    await token.waitForDeployment();
    const MINTER_ROLE = await token.MINTER_ROLE();
    const BURNER_ROLE = await token.BURNER_ROLE();
    await token.connect(admin).grantRole(MINTER_ROLE, admin.address);
    await token.connect(admin).grantRole(BURNER_ROLE, admin.address);
    return { token, admin, user1, user2 };
  }

  it('permissionless mode: any address can hold and transfer', async () => {
    const { token, admin, user1, user2 } = await loadFixture(deployPermissionlessToken);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await token.connect(user1).transfer(user2.address, ethers.parseUnits('10', 18));
    expect(await token.balanceOf(user2.address)).to.equal(ethers.parseUnits('10', 18));
  });

  it('permissioned mode: mint to non-KYC address reverts NotKyced', async () => {
    const { token, admin, user1 } = await loadFixture(deployPermissionedToken);
    await expect(token.connect(admin).mint(user1.address, 1n))
      .to.be.revertedWithCustomError(token, 'NotKyced')
      .withArgs(user1.address);
  });

  it('permissioned mode: mint to KYC address succeeds', async () => {
    const { token, kycManager, whitelister, admin, user1 } = await loadFixture(
      deployPermissionedToken
    );
    await kycManager.connect(whitelister).grantKyc(user1.address);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    expect(await token.balanceOf(user1.address)).to.equal(ethers.parseUnits('100', 18));
  });

  it('permissioned mode: transfer between two KYC addresses succeeds', async () => {
    const { token, kycManager, whitelister, admin, user1, user2 } = await loadFixture(
      deployPermissionedToken
    );
    await kycManager.connect(whitelister).grantKycBulk([user1.address, user2.address]);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await token.connect(user1).transfer(user2.address, ethers.parseUnits('10', 18));
    expect(await token.balanceOf(user2.address)).to.equal(ethers.parseUnits('10', 18));
  });

  it('permissioned mode: transfer from non-KYC sender reverts', async () => {
    const { token, kycManager, whitelister, admin, user1, user2 } = await loadFixture(
      deployPermissionedToken
    );
    // mint while user1 is KYC'd, then revoke
    await kycManager.connect(whitelister).grantKyc(user1.address);
    await kycManager.connect(whitelister).grantKyc(user2.address);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await kycManager.connect(whitelister).revokeKyc(user1.address);

    await expect(token.connect(user1).transfer(user2.address, 1n))
      .to.be.revertedWithCustomError(token, 'NotKyced')
      .withArgs(user1.address);
  });

  it('permissioned mode: transfer to non-KYC receiver reverts', async () => {
    const { token, kycManager, whitelister, admin, user1, user2 } = await loadFixture(
      deployPermissionedToken
    );
    await kycManager.connect(whitelister).grantKyc(user1.address);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await expect(token.connect(user1).transfer(user2.address, 1n))
      .to.be.revertedWithCustomError(token, 'NotKyced')
      .withArgs(user2.address);
  });

  it('permissioned mode: burn from non-KYC address reverts', async () => {
    const { token, kycManager, whitelister, admin, user1 } = await loadFixture(
      deployPermissionedToken
    );
    await kycManager.connect(whitelister).grantKyc(user1.address);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await kycManager.connect(whitelister).revokeKyc(user1.address);
    await expect(token.connect(admin).burn(user1.address, 1n))
      .to.be.revertedWithCustomError(token, 'NotKyced')
      .withArgs(user1.address);
  });

  it('ban check fires before KYC check (preserves existing order)', async () => {
    const { token, kycManager, whitelister, admin, user1, user2 } = await loadFixture(
      deployPermissionedToken
    );
    await kycManager.connect(whitelister).grantKycBulk([user1.address, user2.address]);
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));

    // ban user1; user1 is still KYC'd
    const BANLIST_ROLE = await token.BANLIST_ROLE();
    await token.connect(admin).grantRole(BANLIST_ROLE, admin.address);
    await token.connect(admin).banAddresses([user1.address]);

    await expect(token.connect(user1).transfer(user2.address, 1n)).to.be.revertedWithCustomError(
      token,
      'BannedSender'
    );
  });

  it('setKycManager: only DEFAULT_ADMIN_ROLE; emits KycManagerUpdated; accepts zero', async () => {
    const { token, admin, user1 } = await loadFixture(deployPermissionedToken);

    await expect(token.connect(user1).setKycManager(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(token, 'AccessControlUnauthorizedAccount');

    const oldManager = await token.kycManager();
    await expect(token.connect(admin).setKycManager(ethers.ZeroAddress))
      .to.emit(token, 'KycManagerUpdated')
      .withArgs(oldManager, ethers.ZeroAddress);
    expect(await token.kycManager()).to.equal(ethers.ZeroAddress);
  });

  it('setKycManager to zero flips Token to permissionless', async () => {
    const { token, admin, user1, user2 } = await loadFixture(deployPermissionedToken);
    await token.connect(admin).setKycManager(ethers.ZeroAddress);
    // No KYC needed now
    await token.connect(admin).mint(user1.address, ethers.parseUnits('100', 18));
    await token.connect(user1).transfer(user2.address, ethers.parseUnits('10', 18));
    expect(await token.balanceOf(user2.address)).to.equal(ethers.parseUnits('10', 18));
  });

  it('manager-revert bubbles up', async () => {
    const { token, admin, user1 } = await loadFixture(deployPermissionedToken);

    const RevertMock = await ethers.getContractFactory('KycManagerRevertMock');
    const mock = await RevertMock.deploy();
    await mock.waitForDeployment();

    await token.connect(admin).setKycManager(await mock.getAddress());
    await expect(token.connect(admin).mint(user1.address, 1n)).to.be.revertedWithCustomError(
      mock,
      'MockBoom'
    );
  });
});
```

- [ ] **Step 3B.3: Run; confirm fail.**

Run: `npx hardhat test test/unit/Token.test.ts`
Expected: compile errors — `Token.initialize` 5-arg signature doesn't exist; `setKycManager` doesn't exist; `NotKyced` doesn't exist.

### 3C. Implement Token changes

- [ ] **Step 3C.1: Edit `contracts/core/Token.sol` — add import, state, error, event.**

Add at the top imports:

```solidity
import { IKycManager } from "../interfaces/IKycManager.sol";
```

Add to state vars (just before `__gap`):

```solidity
    address public kycManager;
```

Add to events:

```solidity
    event KycManagerUpdated(address indexed oldManager, address indexed newManager);
```

Add to errors:

```solidity
    error NotKyced(address account);
```

Shrink `__gap` from `[45]` to `[44]`:

```solidity
    uint256[44] private __gap;
```

- [ ] **Step 3C.2: Extend `initialize` to take `_kycManager`.** Replace the existing `initialize` function with:

```solidity
    function initialize(
        string memory _name,
        string memory _symbol,
        address _admin,
        uint256 _issueCap,
        address _kycManager
    ) public initializer {
        __ERC20_init(_name, _symbol);
        __ERC20Pausable_init();
        __AccessControlEnumerable_init();

        if (_admin == address(0)) revert InvalidAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        issueCap = _issueCap;
        kycManager = _kycManager;
    }
```

(No zero-check on `_kycManager` — permissionless is allowed.)

- [ ] **Step 3C.3: Add `setKycManager`.** Insert directly after `setIssueCap`:

```solidity
    /// @notice Set or rotate the KycManager. Pass address(0) to flip to permissionless mode.
    function setKycManager(address newManager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address old = kycManager;
        kycManager = newManager;
        emit KycManagerUpdated(old, newManager);
    }
```

- [ ] **Step 3C.4: Update `_update` to gate on KYC.** Replace the function body with:

```solidity
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        // Check sender ban status (including burns FROM banned addresses)
        if (from != address(0) && isBanned(from)) {
            revert BannedSender(from);
        }
        // Check recipient ban status (including mints TO banned addresses)
        if (to != address(0) && isBanned(to)) {
            revert BannedRecipient(to);
        }

        // KYC gate (permissionless when kycManager == address(0))
        address mgr = kycManager;
        if (mgr != address(0)) {
            if (from != address(0) && !IKycManager(mgr).isKyced(from)) revert NotKyced(from);
            if (to != address(0) && !IKycManager(mgr).isKyced(to)) revert NotKyced(to);
        }

        // Pause check is handled by super._update() via ERC20PausableUpgradeable
        super._update(from, to, amount);
    }
```

- [ ] **Step 3C.5: Compile.**

Run: `npm run compile`
Expected: success.

- [ ] **Step 3C.6: Run all Token tests.**

Run: `npx hardhat test test/unit/Token.test.ts`
Expected: existing pre-KYC Token tests will FAIL because `Token.initialize` now requires 5 args. Update the existing fixture/inline deployments in `test/unit/Token.test.ts` to pass `ethers.ZeroAddress` as the 5th arg (permissionless = identical behavior to the prior contract). Then re-run.

- [ ] **Step 3C.7: Re-run.**

Run: `npx hardhat test test/unit/Token.test.ts`
Expected: all tests pass — pre-existing tests (with `ZeroAddress`) and new "Token KYC gating" tests.

### 3D. Commit Task 3

- [ ] **Step 3D.1: Commit.**

```bash
git add contracts/core/Token.sol contracts/mocks/KycManagerRevertMock.sol test/unit/Token.test.ts
git commit -m "feat(token): optional KYC gate via KycManager + tests"
```

---

## Task 4: Update fixtures so other test suites compile after Token signature change

**Files:**
- Modify: `test/fixtures/expressDeployments.ts`
- Modify: `test/fixtures/deployments.ts` (if it independently deploys Token; verify with `grep -n "deployProxy.*Token" test/fixtures/deployments.ts`)

Goal: every existing test fixture passes the new Token + Express signatures. Do NOT yet remove Express's `kycList` writes — that's Task 5. This task is the minimum delta to get the suite green again.

- [ ] **Step 4.1: Modify `test/fixtures/expressDeployments.ts` so it deploys `KycManager`, wires it into Token and Express, and migrates the existing KYC grants.**

Replace the body of `deployExpressContracts` step-by-step:

(a) After the signers line, deploy KycManager:

```typescript
  // Deploy KycManager
  const KycManagerFactory = await ethers.getContractFactory('KycManager');
  const kycManager = await upgrades.deployProxy(KycManagerFactory, [admin.address], {
    kind: 'uups',
    initializer: 'initialize',
  });
  await kycManager.waitForDeployment();
```

(b) Update Token deployment (5-arg initialize, passing the manager):

```typescript
  const oem = await upgrades.deployProxy(
    OEMFactory,
    [
      'OEM Multi Strategy Yield',
      'OEM',
      admin.address,
      ethers.parseUnits('10000000', 18),
      await kycManager.getAddress(),
    ],
    { kind: 'uups', initializer: 'initialize' }
  );
```

(c) Update Express deployment to pass `kycManager` as the new init arg. **NOTE:** The exact position of the new arg depends on Task 5's chosen `initialize` signature. Since Task 5 has not yet modified Express, this fixture must temporarily continue to call the OLD Express signature. Skip the Express signature change in this task; only update Token + add KycManager grants.

(d) Replace the line that calls `express.grantKycInBulk(...)` with KycManager grants for the same set, AND keep the existing Express `grantKycInBulk` call so the old `kycList` is still populated for whatever tests still read it. (Both lists active until Task 5 removes the old one.)

```typescript
  // Grant KYC on the new manager
  const KYC_WHITELIST_ROLE = await kycManager.WHITELIST_ROLE();
  await kycManager.connect(admin).grantRole(KYC_WHITELIST_ROLE, admin.address);
  await kycManager
    .connect(admin)
    .grantKycBulk([user1.address, user2.address, user3.address, treasury.address, feeTo.address]);

  // (existing) — leave Express's grantKycInBulk call in place for now; Task 5 removes it.
  await express
    .connect(whitelister)
    .grantKycInBulk([user1.address, user2.address, user3.address, treasury.address, feeTo.address]);
```

(e) Add `kycManager` to the `ExpressDeployment` interface and return value:

```typescript
export interface ExpressDeployment {
  kycManager: any;
  oem: any;
  // ...rest unchanged
}
```

```typescript
  return {
    kycManager,
    oem,
    usdo,
    express,
    // ...rest unchanged
  };
```

- [ ] **Step 4.2: If `test/fixtures/deployments.ts` independently deploys Token, apply the same Token-signature change there.** Verify first:

```bash
grep -n "deployProxy.*Token\|deployProxy.*HYBOND\|deployProxy.*OEMFactory" test/fixtures/deployments.ts
```

If it deploys Token, update the args list to include `ethers.ZeroAddress` as the 5th arg (permissionless — keeps that fixture's existing semantics).

- [ ] **Step 4.3: Compile + run the full test suite to confirm only Express-internal KYC tests still pass and nothing else regressed.**

Run: `npm test`
Expected: **all existing tests still pass** — Token deployments now succeed against the 5-arg signature; Express still has its old `kycList`; both lists are populated identically.

- [ ] **Step 4.4: Commit.**

```bash
git add test/fixtures/expressDeployments.ts test/fixtures/deployments.ts
git commit -m "test(fixtures): wire KycManager into existing fixtures (no Express change yet)"
```

---

## Task 5: Migrate Express to KycManager (remove old, add new) — TDD

**Files:**
- Modify: `contracts/extension/Express.sol`
- Modify: `test/fixtures/expressDeployments.ts`
- Modify: `test/unit/Express.comprehensive.test.ts`
- Modify (only if grep shows hits in Step 0.1): other Express test files

This is the largest task. Break into sub-tasks 5A–5G.

### 5A. Plan the storage change

Express has no `__gap` (confirmed in Step 0.2). Storage layout consequence of this task:

- DELETE: `mapping(address => bool) public kycList;` at line 139.
- APPEND (after the last existing state variable, currently `depositEscrowBalance`): `address public kycManager;`

Because this is a fresh deployment (per spec), deleting the mapping is safe. If you discover a non-fresh-deploy constraint mid-task, STOP and re-plan.

### 5B. Failing tests for new Express behavior

- [ ] **Step 5B.1: Add new tests at the end of `test/unit/Express.comprehensive.test.ts`** describing the NEW behavior. These will fail because Express still has the old behavior:

```typescript
// Add this import near the top of the file alongside the existing ones:
//   import { DEFAULT_MAX_STALE_PERIOD } from '../fixtures/expressDeployments';

describe('Express ↔ KycManager wiring', () => {
  it('initialize rejects zero kycManager', async () => {
    // Reuse the working fixture's already-deployed dependency set, but redeploy Express with
    // kycManager=0 to isolate the check under test.
    const fx = await loadFixture(deployExpressContracts);
    const ExpressFactory = await ethers.getContractFactory(
      'contracts/extension/Express.sol:Express'
    );

    await expect(
      upgrades.deployProxy(
        ExpressFactory,
        [
          await fx.oem.getAddress(),
          await fx.usdo.getAddress(),
          fx.treasury.address,
          fx.feeTo.address,
          fx.treasury.address, // mgtFeeTo
          fx.admin.address,
          await fx.assetRegistry.getAddress(),
          await fx.priceOracle.getAddress(),
          DEFAULT_MAX_STALE_PERIOD,
          {
            depositMinimum: ethers.parseUnits('100', 18),
            redeemMinimum: ethers.parseUnits('50', 18),
            firstDepositAmount: ethers.parseUnits('1000', 18),
          },
          ethers.ZeroAddress, // <-- new arg: kycManager
        ],
        { kind: 'uups', initializer: 'initialize' }
      )
    ).to.be.revertedWithCustomError(ExpressFactory, 'InvalidAddress');
  });

  it('uses KycManager state for KYC checks', async () => {
    const { express, kycManager, admin, user1 } = await loadFixture(deployExpressContracts);
    // user1 is KYC'd in fixture. Revoke directly on the manager and confirm Express sees it.
    const WL = await kycManager.WHITELIST_ROLE();
    await kycManager.connect(admin).grantRole(WL, admin.address);
    await kycManager.connect(admin).revokeKyc(user1.address);

    await expect(
      express
        .connect(user1)
        .requestDeposit(await (await loadFixture(deployExpressContracts)).usdo.getAddress(), 1n, user1.address)
    ).to.be.revertedWithCustomError(express, 'NotInKycList');
  });

  it('exposes kycManager() and no longer has kycList/grantKycInBulk', async () => {
    const { express } = await loadFixture(deployExpressContracts);
    expect(typeof express.kycManager).to.equal('function');
    expect(express.interface.fragments.find((f: any) => f.name === 'kycList')).to.equal(undefined);
    expect(express.interface.fragments.find((f: any) => f.name === 'grantKycInBulk')).to.equal(
      undefined
    );
    expect(express.interface.fragments.find((f: any) => f.name === 'revokeKycInBulk')).to.equal(
      undefined
    );
  });

  it('setKycManager: requires DEFAULT_ADMIN_ROLE, rejects zero, emits event', async () => {
    const { express, kycManager, admin, user1 } = await loadFixture(deployExpressContracts);
    const KycManagerFactory = await ethers.getContractFactory('KycManager');
    const newMgr = await upgrades.deployProxy(KycManagerFactory, [admin.address], {
      kind: 'uups',
      initializer: 'initialize',
    });
    await newMgr.waitForDeployment();

    await expect(express.connect(user1).setKycManager(await newMgr.getAddress()))
      .to.be.revertedWithCustomError(express, 'AccessControlUnauthorizedAccount');

    await expect(express.connect(admin).setKycManager(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(express, 'InvalidAddress');

    const old = await express.kycManager();
    await expect(express.connect(admin).setKycManager(await newMgr.getAddress()))
      .to.emit(express, 'KycManagerUpdated')
      .withArgs(old, await newMgr.getAddress());
  });

  it('setKycManager rotation is gated by empty queues', async () => {
    const { express, kycManager, usdo, admin, user1, maintainer } = await loadFixture(
      deployExpressContracts
    );
    const KycManagerFactory = await ethers.getContractFactory('KycManager');
    const newMgr = await upgrades.deployProxy(KycManagerFactory, [admin.address], {
      kind: 'uups',
      initializer: 'initialize',
    });
    await newMgr.waitForDeployment();

    // depositQueue not empty → rotation reverts
    await express
      .connect(user1)
      .requestDeposit(await usdo.getAddress(), ethers.parseUnits('1000', 18), user1.address);

    await expect(
      express.connect(admin).setKycManager(await newMgr.getAddress())
    ).to.be.revertedWithCustomError(express, 'NonEmptyQueue');

    // Drain the queue (process it with newShares matching the deposit at 1:1 bootstrap)
    await express.connect(maintainer).processDepositQueue(1, ethers.parseUnits('1000', 18));

    // Now succeeds
    await expect(express.connect(admin).setKycManager(await newMgr.getAddress()))
      .to.emit(express, 'KycManagerUpdated');
  });
});
```

- [ ] **Step 5B.2: Run; confirm fail.**

Run: `npx hardhat test test/unit/Express.comprehensive.test.ts`
Expected: failures referencing missing `kycManager()` view, missing `setKycManager`, missing `NonEmptyQueue` error, etc.

### 5C. Modify Express.sol — state, error, event, role removal

- [ ] **Step 5C.1: Remove `WHITELIST_ROLE` constant** at line 47. Delete the line entirely.

- [ ] **Step 5C.2: Remove `kycList` mapping** at line 139. Delete the line and its preceding comment (`// KYC list`).

- [ ] **Step 5C.3: Add IKycManager import.** Add to imports near line 14:

```solidity
import { IKycManager } from "../interfaces/IKycManager.sol";
```

- [ ] **Step 5C.4: Append `kycManager` state variable** after `depositEscrowBalance` (the last existing state var, line 171):

```solidity
    /// @notice KYC manager (single source of truth, shared with Token). Required (non-zero).
    address public kycManager;
```

- [ ] **Step 5C.5: Add `KycManagerUpdated` event and `NonEmptyQueue` error.** In the events block:

```solidity
    event KycManagerUpdated(address indexed oldManager, address indexed newManager);
```

In the errors block:

```solidity
    error NonEmptyQueue();
```

- [ ] **Step 5C.6: Remove obsolete events** `event KycGranted(address[] addresses);` and `event KycRevoked(address[] addresses);` (lines 277 + 279).

### 5D. Modify Express.sol — remove `grantKycInBulk` / `revokeKycInBulk`

- [ ] **Step 5D.1: Delete the two functions and their preceding `KYC MANAGEMENT` banner comment** in the range around lines 1305–1340.

### 5E. Modify Express.sol — rewrite `_validateKyc`

- [ ] **Step 5E.1: Replace `_validateKyc`.**

Old (around line 1575):

```solidity
    function _validateKyc(address _sender, address _receiver) internal view {
        if (!kycList[_sender] || !kycList[_receiver]) revert NotInKycList(_sender, _receiver);
    }
```

New:

```solidity
    function _validateKyc(address _sender, address _receiver) internal view {
        IKycManager mgr = IKycManager(kycManager);
        if (!mgr.isKyced(_sender) || !mgr.isKyced(_receiver)) {
            revert NotInKycList(_sender, _receiver);
        }
    }
```

### 5F. Modify Express.sol — extend `initialize` and add `setKycManager`

- [ ] **Step 5F.1: Read the current `initialize` signature.** Open Express.sol around the initialize block (search for `function initialize`). Identify the existing struct and final argument.

- [ ] **Step 5F.2: Append `_kycManager` as the LAST positional argument.** Add zero-check inside the function body:

```solidity
    function initialize(
        // ...existing args...
        address _kycManager
    ) public initializer {
        // ...existing init body...
        if (_kycManager == address(0)) revert InvalidAddress();
        kycManager = _kycManager;
    }
```

- [ ] **Step 5F.3: Add `setKycManager`.** Place it next to other admin setters (e.g., near `updateMgtFeeTo`):

```solidity
    /// @notice Rotate the KycManager. Requires DEFAULT_ADMIN_ROLE and all queues empty.
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

### 5G. Update fixture + tests to match new Express signature

- [ ] **Step 5G.1: Update `test/fixtures/expressDeployments.ts`.**

(a) Add `kycManager` address to the `Express.deployProxy` arg list as the new last positional arg.

(b) Drop these now-deleted lines:

```typescript
  const WHITELIST_ROLE = await express.WHITELIST_ROLE();
  await express.connect(admin).grantRole(WHITELIST_ROLE, whitelister.address);
```

```typescript
  await express
    .connect(whitelister)
    .grantKycInBulk([user1.address, user2.address, user3.address, treasury.address, feeTo.address]);
```

(c) Keep the KycManager-side grant (added in Task 4). Confirm `whitelister` is no longer needed for Express (it's now a KYC operator on the manager — but to keep the fixture API stable, just stop granting it `WHITELIST_ROLE` on Express).

- [ ] **Step 5G.2: Sweep `/tmp/kyc-touchpoints.txt` from Step 0.1.** For every test file that referenced `express.grantKycInBulk`, `express.revokeKycInBulk`, `express.kycList`, or `express.WHITELIST_ROLE`, replace the call with the equivalent operation on `kycManager`. For `kycList(addr)` reads, replace with `kycManager.isKyced(addr)`.

Concrete substitutions:

| Old | New |
|-----|-----|
| `express.grantKycInBulk([...])` (called by `whitelister`) | `kycManager.grantKycBulk([...])` (called by `admin` or `whitelister`, depending on who has `WHITELIST_ROLE` on the manager) |
| `express.revokeKycInBulk([...])` | `kycManager.revokeKycBulk([...])` |
| `express.kycList(addr)` | `kycManager.isKyced(addr)` |
| `await express.WHITELIST_ROLE()` | (delete — no longer exists) |

- [ ] **Step 5G.3: Compile.**

Run: `npm run compile`
Expected: success.

- [ ] **Step 5G.4: Run the full test suite.**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5G.5: Commit.**

```bash
git add contracts/extension/Express.sol test/fixtures/expressDeployments.ts test/unit/Express.comprehensive.test.ts test/unit/Express.invariance.test.ts test/unit/Express.mgtFeeAccounting.test.ts test/unit/Express.OffchainShares.test.ts test/unit/Express.sharePerToken.test.ts
git commit -m "feat(express): migrate KYC list to KycManager; require manager on init/rotation"
```

(Stage only the files actually modified — `git add` will fail silently for untouched ones.)

---

## Task 6: Update deploy scripts

**Files:**
- Modify: `deploy/00_deploy_hybond_all.ts`
- Modify: `deploy/02_deploy_hybond_token.ts`
- Modify: `deploy/04_deploy_express.ts`
- Modify: `deploy/config.ts`
- Create: `deploy/02a_deploy_kyc_manager.ts`

### 6A. Standalone KycManager deploy

- [ ] **Step 6A.1: Create `deploy/02a_deploy_kyc_manager.ts`.**

```typescript
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';
import { getConfigSection, getConfigValue, loadNetworkConfig } from './config';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const hreAny = hre as any;
  const { deployments: deployerDeployments, getNamedAccounts, network } = hreAny;
  const ethers = hreAny.ethers;
  const upgrades = hreAny.upgrades;
  const run = hreAny.run;
  const { get } = deployerDeployments;
  const { deployer } = await getNamedAccounts();
  const config = loadNetworkConfig(network.name);
  const commonConfig = getConfigSection(config, 'Common');

  console.log('🚀 Deploying KycManager');
  console.log('📌 Deployer address:', deployer);

  try {
    const existing = await get('KycManager');
    console.log('📌 KycManager already deployed at:', existing.address);
    console.log('⏭️  Skipping deployment. Use --reset to redeploy.');
    return;
  } catch {
    // not yet deployed
  }

  const adminConfig = getConfigValue<string>(commonConfig, 'admin');
  const admin = adminConfig === ethers.ZeroAddress ? deployer : adminConfig;

  const KycManagerFactory = await ethers.getContractFactory('KycManager');
  const kycManager = await upgrades.deployProxy(KycManagerFactory, [admin], {
    initializer: 'initialize',
    kind: 'uups',
  });
  await kycManager.waitForDeployment();
  const address = await kycManager.getAddress();
  console.log('✅ KycManager deployed to:', address);

  await deployerDeployments.save('KycManager', {
    address,
    abi: KycManagerFactory.interface.format() as any,
  });

  if (network.name !== 'hardhat' && network.name !== 'localhost') {
    console.log('\n⏳ Waiting for Etherscan to index...');
    await new Promise((r) => setTimeout(r, 30_000));
    const impl = await upgrades.erc1967.getImplementationAddress(address);
    try {
      await run('verify:verify', { address: impl, constructorArguments: [] });
      console.log('✅ KycManager implementation verified');
    } catch (e: any) {
      console.log('❌ Verification failed:', e.message);
    }
  }
};

func.tags = ['kyc_manager', 'hybond', 'core'];
export default func;
```

### 6B. Update Token deploy

- [ ] **Step 6B.1: Modify `deploy/02_deploy_hybond_token.ts`.** Resolve the KycManager address (if `Common.tokenPermissioned` is true, look up the deployment; else use ZeroAddress) and add it as the 5th initialize arg.

Insert after `const admin = ...` line:

```typescript
  // Resolve KycManager (permissioned mode only)
  const tokenPermissioned = getConfigValue<boolean>(commonConfig, 'tokenPermissioned');
  let kycManagerAddress = ethers.ZeroAddress;
  if (tokenPermissioned) {
    try {
      const km = await get('KycManager');
      kycManagerAddress = km.address;
    } catch {
      throw new Error(
        'tokenPermissioned=true but KycManager not deployed. Run 02a_deploy_kyc_manager.ts first.'
      );
    }
  }
  console.log('📌 KycManager:', kycManagerAddress, tokenPermissioned ? '(permissioned)' : '(permissionless)');
```

Update the `deployProxy` args:

```typescript
  const hybond = await upgrades.deployProxy(
    Token,
    [name, symbol, admin, issueCap, kycManagerAddress],
    { initializer: 'initialize', kind: 'uups' }
  );
```

### 6C. Update Express deploy

- [ ] **Step 6C.1: Modify `deploy/04_deploy_express.ts`.** Resolve KycManager (always required for Express) and add as the new last init arg.

Insert near the other dependency lookups:

```typescript
  let kycManagerAddress: string;
  try {
    const km = await get('KycManager');
    kycManagerAddress = km.address;
  } catch {
    throw new Error('KycManager not deployed. Run 02a_deploy_kyc_manager.ts first.');
  }
```

Add `kycManagerAddress` as the new last positional arg in the `deployProxy` call:

```typescript
      maxStalePeriod,
      {
        depositMinimum,
        redeemMinimum,
        firstDepositAmount,
      },
      kycManagerAddress,
```

- [ ] **Step 6C.2: Replace the closing log line about `grantKycInBulk()`** (around line 211 of the current script):

Old:

```typescript
  console.log('   - Grant KYC status to users via grantKycInBulk()');
```

New:

```typescript
  console.log('   - Grant WHITELIST_ROLE on KycManager to ops signer, then call kycManager.grantKycBulk([...])');
```

### 6D. Update `deploy_hybond_all.ts` (combined script)

- [ ] **Step 6D.1: Modify `deploy/00_deploy_hybond_all.ts`** to deploy KycManager between MockERC20 and HYBOND, then thread the address into both Token and Express init.

(a) Add a step before the HYBOND deploy:

```typescript
  // ============================================
  // 1.5. Deploy KycManager
  // ============================================
  console.log('\n🚀 Deploying KycManager...');
  const KycManagerFactory = await ethers.getContractFactory('KycManager');
  const kycManager = await upgrades.deployProxy(KycManagerFactory, [admin], {
    initializer: 'initialize',
    kind: 'uups',
  });
  await kycManager.waitForDeployment();
  const kycManagerAddress = await kycManager.getAddress();
  console.log('✅ KycManager deployed to:', kycManagerAddress);
```

(b) Resolve `tokenPermissioned`:

```typescript
  const tokenPermissioned = getConfigValue<boolean>(commonConfig, 'tokenPermissioned');
  const tokenKycManagerArg = tokenPermissioned ? kycManagerAddress : ethers.ZeroAddress;
```

(c) Update the HYBOND deploy args:

```typescript
  const hybond = await upgrades.deployProxy(
    Token,
    [tokenName, tokenSymbol, admin, tokenIssueCap, tokenKycManagerArg],
    { initializer: 'initialize', kind: 'uups' }
  );
```

(d) Update the Express deploy args (append `kycManagerAddress` as the new last positional arg).

(e) Save the KycManager deployment record:

```typescript
  await deployerDeployments.save('KycManager', {
    address: kycManagerAddress,
    abi: KycManagerFactory.interface.format() as any,
  });
```

(f) Add KycManager to the verification block alongside HYBOND/AssetRegistry/PriceOracle/Express.

### 6E. Update `deploy/config.ts`

- [ ] **Step 6E.1: Add `tokenPermissioned: boolean`** to the `Common` section type, and add `kycManagerAddress: string` to the `Express` section type. Default `tokenPermissioned` to `true` in any fixture/test config; verify each network config under `deploy/config/` is updated to include the new keys (or set them to defaults via `getConfigValue` fallback).

If config files in `deploy/config/` are network-specific, edit each `.json`/`.ts` to add the two keys. Skip files that are read-only references.

### 6F. Smoke test deploy on hardhat

- [ ] **Step 6F.1: Run combined deploy on the in-memory hardhat network.**

Run: `npx hardhat deploy --network hardhat --tags hybond_all --reset`
Expected: deploys MockERC20, KycManager, HYBOND, AssetRegistry, PriceOracle, Express; logs all addresses; grants MINTER/BURNER roles.

- [ ] **Step 6F.2: Commit.**

```bash
git add deploy/
git commit -m "deploy(kyc): add KycManager deploy + thread into Token/Express init"
```

---

## Task 7: Final verification

- [ ] **Step 7.1: Run the full test suite.**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7.2: Run the targeted suites.**

Run: `npm run test:express && npm run test:unit`
Expected: all pass.

- [ ] **Step 7.3: Re-grep for anything we missed.**

Run:
```bash
grep -rn "grantKycInBulk\|revokeKycInBulk\|kycList\|express.*WHITELIST_ROLE" \
  contracts/ test/ deploy/ 2>/dev/null
```
Expected: zero hits in `contracts/`, zero hits in `deploy/`. Hits in `test/` should only be in test files that explicitly verify selectors are GONE (like the `expect(express.interface.fragments.find(...))` assertion).

- [ ] **Step 7.4: Run coverage on the unit suite.**

Run: `npm run coverage:unit`
Expected: `KycManager.sol`, modified `Token.sol`, and modified `Express.sol` all show >= 95% coverage.

- [ ] **Step 7.5: Compile contract sizes.**

Run: `npm run size`
Expected: no contract over the 24KB EIP-170 limit.

- [ ] **Step 7.6: Final commit (if anything dangling).**

```bash
git status
# if clean, nothing to commit
# if dirty, review and commit:
# git add -p
# git commit -m "chore(kyc): final cleanup"
```

---

## Self-Review Checklist (run before declaring done)

- [ ] Spec section 1 (KycManager): covered by Tasks 1 + 2.
- [ ] Spec section 2 (IKycManager): covered by Task 1.
- [ ] Spec section 3 (Token changes — state, init, setter, _update gate): covered by Task 3.
- [ ] Spec section 4 (Express changes — drop kycList/role/bulk, add manager state, _validateKyc rewrite, init reject zero, setter with queue guard): covered by Task 5.
- [ ] Spec section 5 (Deployment — order, env flag, role wiring): covered by Task 6.
- [ ] Spec section 6 (Tests — KycManager.test.ts new, Token.test.ts extended, Express.comprehensive.test.ts updated, fixtures): covered by Tasks 2/3/4/5.
- [ ] Spec "Storage Layout" hygiene: Task 5A explicitly addresses the absence of `__gap` in Express; Task 3C.1 shrinks Token's `__gap` by 1.
- [ ] Manager-revert behavior (bubble): Task 3B.2 includes a test against `KycManagerRevertMock`.
- [ ] Express rotation guard (queues empty): Task 5B.1 includes the "rotation gated by empty queues" test.
- [ ] No placeholders: every step contains exact code or exact commands.
- [ ] Type/name consistency: `KycManagerUpdated`, `NotKyced` (Token), `NotInKycList` (Express, kept for back-compat with existing call-sites), `NonEmptyQueue` (Express new), `InvalidAddress` (reused everywhere). Verified consistent across tasks.
