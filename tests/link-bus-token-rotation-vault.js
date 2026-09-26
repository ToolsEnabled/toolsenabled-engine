// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-link-bus-token-rotation-vault-js):
// - SAME-CODE EXPECTATION: the token fingerprint assertions derived their
//   expected values with the exported tokenFingerprint implementation that
//   supplies the behavior being checked. Mutation: changed the product's
//   TOKEN_FINGERPRINT_DOMAIN by appending ".MUTANT". Before this change the
//   test stayed green: "link-bus-token-rotation-vault: all focused tests passed".
//   Expected fingerprints are now fixed, independently recorded vectors. With
//   the same mutation the test went red:
//   "link-bus-token-rotation-vault failed: VAULT_FINGERPRINT_MISMATCH".
// - NOT-FOUND: assertions in loops/forEach over potentially empty collections.
// - NOT-FOUND: exit-status/truthy-return assertions used in place of checking
//   the subject's own output.
// - NOT-FOUND: try/catch or optional chaining that swallows the tested failure.
// - NOT-FOUND: assertions against a mock of the behavior under test. Injected
//   filesystem primitives are fakes, but assertions exercise transaction state,
//   canonical files, errors, and the calls the transaction makes at that seam.
// - NOT-FOUND: skips or platform precondition guards.
// - Preconditions not met: none.
// - Restoration: tools/lib/link-bus-token-rotation.js was restored byte-for-byte
//   after each mutation (SHA-256 cd467dd0970cb7db15bb0465eb869c1be9ee9aaa009c4bda2ec73fac3b37e3d8).
//   Restored run: "link-bus-token-rotation-vault: all focused tests passed".

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createAuthenticatedVerificationReceipt
} = require('../tools/lib/link-bus-token-rotation');
const {
  RotationVaultTransaction
} = require('../tools/lib/link-bus-token-rotation-vault');

const fsPromises = fs.promises;
const OLD_TOKEN = Buffer.alloc(32, 0x51).toString('base64url');
const NEW_TOKEN = Buffer.alloc(32, 0x52).toString('base64url');
const OLD_TOKEN_SHA256 = 'cVXT2RAWn6781zg4wFBcOrd1eQzsJAPPmj_BR1ChLVs';
const NEW_TOKEN_SHA256 = 'BKRTh-_Qi9y2spisLbPMN05bMjB_kT1J_FP5n-VWCcI';
const RECEIPT_KEY = Buffer.alloc(32, 0x53);

function operationId(byte) {
  return Buffer.alloc(16, byte).toString('base64url');
}

function sha256FileBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('base64url');
}

async function readVault(target) {
  return JSON.parse(await fsPromises.readFile(target, 'utf8'));
}

async function writeVault(target, value) {
  await fsPromises.writeFile(target, `${JSON.stringify(value)}\n`, 'utf8');
}

async function makeFixture() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'link-bus-token-rotation-vault-')
  );
  const vaultDirectory = path.join(root, 'vault');
  await fsPromises.mkdir(vaultDirectory, { recursive: true });
  const vaultPath = path.join(vaultDirectory, 'secrets.json');
  await writeVault(vaultPath, {
    tokenCiphertext: 'synthetic-dpapi-old-ciphertext',
    tokenFingerprint: OLD_TOKEN_SHA256,
    bOnlyCiphertext: 'synthetic-dpapi-b-only'
  });
  return { root, vaultPath };
}

function fakeDependencies({
  corruptCandidate = false,
  throwAfterFirstReplace = false
} = {}) {
  let randomCounter = 0;
  let replaceCalls = 0;
  const aclTargets = [];
  const deps = {
    fs: fsPromises,
    now: (() => {
      let value = 1800000000000;
      return () => ++value;
    })(),
    randomId: () => (++randomCounter).toString(16).padStart(24, '0'),
    restrictAcl: async target => {
      aclTargets.push(path.resolve(target));
    },
    fingerprint: async target => (await readVault(target)).tokenFingerprint,
    fileDigest: async target => sha256FileBytes(
      await fsPromises.readFile(target)
    ),
    setToken: async (target, token) => {
      const value = await readVault(target);
      assert.equal(token, NEW_TOKEN);
      value.tokenCiphertext = `synthetic-dpapi-new-${NEW_TOKEN_SHA256}`;
      value.tokenFingerprint = corruptCandidate
        ? OLD_TOKEN_SHA256
        : NEW_TOKEN_SHA256;
      await writeVault(target, value);
    },
    atomicReplace: async (
      source,
      destination,
      backup,
      expectedGeneration
    ) => {
      const current = sha256FileBytes(await fsPromises.readFile(destination));
      if (current !== expectedGeneration) {
        const error = new Error('generation conflict');
        error.code = 'SYNTHETIC_GENERATION_CONFLICT';
        throw error;
      }
      await fsPromises.copyFile(
        destination,
        backup,
        fs.constants.COPYFILE_EXCL
      );
      await fsPromises.copyFile(source, destination);
      await fsPromises.unlink(source);
      replaceCalls += 1;
      if (throwAfterFirstReplace && replaceCalls === 1) {
        throw new Error('synthetic post-replace fault');
      }
    }
  };
  return { deps, aclTargets, get replaceCalls() { return replaceCalls; } };
}

async function receipt(state) {
  return createAuthenticatedVerificationReceipt({
    operationId: state.operationId,
    tokenSha256: state.newTokenSha256,
    listenerPid: 43210,
    listenerCreationDate: '20260730120000.000000-420',
    port8788Closed: true,
    verifiedAt: 1800000001000,
    signCanonical: async canonical => crypto.createHmac(
      'sha256',
      RECEIPT_KEY
    ).update(canonical).digest('base64url')
  });
}

async function testSuccessFinalizeAndRollback() {
  const fixture = await makeFixture();
  try {
    const fake = fakeDependencies();
    const transaction = new RotationVaultTransaction({
      repoRoot: fixture.root,
      role: 'b',
      operationId: operationId(0x61),
      dependencies: fake.deps
    });
    const prepared = await transaction.prepare(NEW_TOKEN);
    assert.equal(prepared.phase, 'prepared');
    assert.equal(prepared.oldTokenSha256, OLD_TOKEN_SHA256);
    assert.equal(prepared.newTokenSha256, NEW_TOKEN_SHA256);
    assert.notEqual(
      prepared.baseGenerationSha256,
      prepared.candidateGenerationSha256
    );

    const candidateBytes = await fsPromises.readFile(
      transaction.paths.candidatePath
    );
    assert.equal(candidateBytes.includes(Buffer.from(NEW_TOKEN)), false);
    const candidate = JSON.parse(candidateBytes.toString('utf8'));
    assert.equal(candidate.bOnlyCiphertext, 'synthetic-dpapi-b-only');
    assert.equal(
      (await readVault(transaction.paths.stagedBackupPath)).tokenFingerprint,
      OLD_TOKEN_SHA256
    );

    const committed = await transaction.commit();
    assert.equal(committed.phase, 'committed');
    assert.equal(
      (await readVault(fixture.vaultPath)).tokenFingerprint,
      NEW_TOKEN_SHA256
    );
    assert.equal(
      (await readVault(transaction.paths.backupPath)).tokenFingerprint,
      OLD_TOKEN_SHA256
    );
    assert.equal(
      (await readVault(fixture.vaultPath)).bOnlyCiphertext,
      'synthetic-dpapi-b-only'
    );

    const verified = await transaction.markVerified(
      await receipt(committed)
    );
    assert.equal(verified.phase, 'verified');
    const finalized = await transaction.finalize();
    assert.equal(finalized.phase, 'finalized');
    await assert.rejects(
      transaction.rollback(),
      error => error.code === 'FINALIZED_ROLLBACK_REFUSED'
    );

    const rolledBack = await transaction.rollback({
      allowFinalized: true
    });
    assert.equal(rolledBack.phase, 'rolled_back');
    assert.equal(
      (await readVault(fixture.vaultPath)).tokenFingerprint,
      OLD_TOKEN_SHA256
    );
    assert.equal(
      (await readVault(transaction.paths.failedNewPath)).tokenFingerprint,
      NEW_TOKEN_SHA256
    );
    assert.equal(await fsPromises.stat(transaction.paths.backupPath)
      .then(stat => stat.isFile()), true);
    assert.ok(fake.aclTargets.includes(
      path.resolve(transaction.paths.backupPath)
    ));
  } finally {
    await fsPromises.rm(fixture.root, { recursive: true, force: true });
  }
}

async function testConcurrentCanonicalChangeIsPreserved() {
  const fixture = await makeFixture();
  try {
    const fake = fakeDependencies();
    const transaction = new RotationVaultTransaction({
      repoRoot: fixture.root,
      role: 'a',
      operationId: operationId(0x62),
      dependencies: fake.deps
    });
    await transaction.prepare(NEW_TOKEN);
    const concurrent = await readVault(fixture.vaultPath);
    concurrent.concurrentCiphertext = 'synthetic-dpapi-concurrent';
    await writeVault(fixture.vaultPath, concurrent);

    await assert.rejects(
      transaction.commit(),
      error => error.code === 'VAULT_GENERATION_CONFLICT'
    );
    const state = await transaction.status();
    assert.equal(state.phase, 'rolled_back');
    const canonical = await readVault(fixture.vaultPath);
    assert.equal(
      canonical.concurrentCiphertext,
      'synthetic-dpapi-concurrent'
    );
    assert.equal(
      canonical.tokenFingerprint,
      OLD_TOKEN_SHA256
    );
    await assert.rejects(
      fsPromises.lstat(transaction.paths.candidatePath),
      error => error.code === 'ENOENT'
    );
    assert.equal(fake.replaceCalls, 0);
  } finally {
    await fsPromises.rm(fixture.root, { recursive: true, force: true });
  }
}

async function testPostReplaceFaultRestoresOldGeneration() {
  const fixture = await makeFixture();
  try {
    const fake = fakeDependencies({ throwAfterFirstReplace: true });
    const transaction = new RotationVaultTransaction({
      repoRoot: fixture.root,
      role: 'a',
      operationId: operationId(0x63),
      dependencies: fake.deps
    });
    await transaction.prepare(NEW_TOKEN);
    await assert.rejects(
      transaction.commit(),
      error => error.code === 'VAULT_COMMIT_FAILED'
    );
    assert.equal((await transaction.status()).phase, 'rolled_back');
    assert.equal(
      (await readVault(fixture.vaultPath)).tokenFingerprint,
      OLD_TOKEN_SHA256
    );
    assert.equal(
      (await readVault(transaction.paths.failedNewPath)).tokenFingerprint,
      NEW_TOKEN_SHA256
    );
    assert.equal(fake.replaceCalls, 2);
  } finally {
    await fsPromises.rm(fixture.root, { recursive: true, force: true });
  }
}

async function testCandidateVerificationFailureNeverCommits() {
  const fixture = await makeFixture();
  try {
    const fake = fakeDependencies({ corruptCandidate: true });
    const transaction = new RotationVaultTransaction({
      repoRoot: fixture.root,
      role: 'b',
      operationId: operationId(0x64),
      dependencies: fake.deps
    });
    await assert.rejects(
      transaction.prepare(NEW_TOKEN),
      error => error.code === 'VAULT_FINGERPRINT_MISMATCH'
    );
    assert.equal((await transaction.status()).phase, 'rolled_back');
    assert.equal(
      (await readVault(fixture.vaultPath)).tokenFingerprint,
      OLD_TOKEN_SHA256
    );
    assert.equal(fake.replaceCalls, 0);
  } finally {
    await fsPromises.rm(fixture.root, { recursive: true, force: true });
  }
}

async function main() {
  await testSuccessFinalizeAndRollback();
  await testConcurrentCanonicalChangeIsPreserved();
  await testPostReplaceFaultRestoresOldGeneration();
  await testCandidateVerificationFailureNeverCommits();
  process.stdout.write(
    'link-bus-token-rotation-vault: all focused tests passed\n'
  );
}

main().catch(error => {
  process.stderr.write(
    `link-bus-token-rotation-vault failed: ${error && error.code || 'TEST_FAILED'}\n`
  );
  process.exitCode = 1;
});
