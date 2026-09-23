'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('./lib/isolated-environment').activate('code-intel-refusals');
const codeIntel = require('../src/lib/providers/code-intel');

// Fixtures live under the checkout root, not the system temp directory.
// resolveFilePath() now refuses any `file` outside the ToolsEnabled root and
// every recorded workspace root (src/lib/code-file-containment.js); a
// fixture directly under os.tmpdir() is a SIBLING of this worktree (which
// itself lives under Temp), so it would be refused CODE_FILE_OUTSIDE_ROOT
// before this suite's own oversized-file/server-launch/protocol refusals
// ever ran.
const SCRATCH_BASE = path.join(__dirname, '..', 'tmp-code-intel-refusals-test');
fs.mkdirSync(SCRATCH_BASE, { recursive: true });
const temporary = [];
function tempDir(label) {
  const directory = fs.mkdtempSync(path.join(SCRATCH_BASE, `te-code-refusal-${label}-`));
  temporary.push(directory);
  return directory;
}

async function refusal(run, expected) {
  try {
    await run();
  } catch (error) {
    assert.equal(error.code, expected, `expected ${expected}, received ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected ${expected}, but the call resolved`);
}

(async () => {
  // This refusal happens before discovery, reading, or process creation.
  const largeRoot = tempDir('large');
  const largeFile = path.join(largeRoot, 'large.ts');
  fs.writeFileSync(path.join(largeRoot, 'tsconfig.json'), '{}');
  fs.writeFileSync(largeFile, Buffer.alloc((2 * 1024 * 1024) + 1, 0x20));
  let discoveryCalls = 0;
  codeIntel.setServerResolverForTests(() => {
    discoveryCalls += 1;
    throw new Error('discovery must not run for an oversized file');
  });
  const tooLarge = await refusal(
    () => codeIntel.documentSymbols({ file: largeFile, root: largeRoot }),
    'CODE_FILE_TOO_LARGE'
  );
  assert.equal(tooLarge.details.bytes, (2 * 1024 * 1024) + 1);
  assert.equal(discoveryCalls, 0, 'oversized-file refusal must not discover or spawn a server');
  assert.equal(codeIntel.sessionPoolForTests().list().length, 0, 'oversized-file refusal creates no session');

  const serverRoot = tempDir('server');
  const source = path.join(serverRoot, 'sample.ts');
  fs.writeFileSync(path.join(serverRoot, 'tsconfig.json'), '{}');
  fs.writeFileSync(source, 'export const sample = 1;\n');

  // A genuine child-process launch failure must retain its translated provider code.
  codeIntel.setServerResolverForTests(() => ({
    resolved: true,
    serverId: 'missing-test-server',
    command: path.join(serverRoot, 'definitely-not-an-executable'),
    args: [],
    attempts: []
  }));
  const startFailed = await refusal(
    () => codeIntel.documentSymbols({ file: source, root: serverRoot }),
    'CODE_SERVER_START_FAILED'
  );
  assert.equal(startFailed.details.lspCode, 'LSP_SERVER_START_FAILED');
  assert.equal(codeIntel.sessionPoolForTests().list().length, 0, 'failed launch is not retained as a session');

  // Drive malformed bytes through the real stdio transport rather than testing a string/table.
  const malformedServer = path.join(serverRoot, 'malformed-server.js');
  fs.writeFileSync(malformedServer, "process.stdout.write('Content-Type: application/json\\r\\n\\r\\n{}'); setTimeout(() => {}, 10000);\n");
  codeIntel.setServerResolverForTests(() => ({
    resolved: true,
    serverId: 'malformed-test-server',
    command: process.execPath,
    args: [malformedServer],
    attempts: []
  }));
  const protocolError = await refusal(
    () => codeIntel.documentSymbols({ file: source, root: serverRoot }),
    'CODE_SERVER_PROTOCOL_ERROR'
  );
  assert.equal(protocolError.details.lspCode, 'LSP_PROTOCOL_ERROR');
  await codeIntel.stopAllSessionsForTests();
  assert.equal(codeIntel.sessionPoolForTests().list().length, 0, 'protocol-failed session is removed and stopped');

  // Status is deliberately spawn-free; an unavailable resolver result becomes the
  // caller-visible NO_LANGUAGE_SERVER_FOUND state for every language family.
  let statusResolutions = 0;
  codeIntel.setServerResolverForTests(() => {
    statusResolutions += 1;
    return { resolved: false, attempts: [] };
  });
  const status = codeIntel.status({ root: serverRoot });
  assert.equal(statusResolutions, 2, 'status performs discovery for both supported language families');
  assert.ok(status.languages.length > 0);
  assert.ok(status.languages.every(language => !language.available
    && language.reason === 'NO_LANGUAGE_SERVER_FOUND'));
  assert.equal(codeIntel.sessionPoolForTests().list().length, 0, 'status never spawns a language server');

  console.log('code-intel refusal tests passed: 4 driven refusals');
})().finally(async () => {
  codeIntel.setServerResolverForTests(null);
  await codeIntel.stopAllSessionsForTests();
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(SCRATCH_BASE, { recursive: true, force: true });
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
