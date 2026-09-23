'use strict';

// This file is not wired into any npm script, so its only invocation path is a
// direct `node tests/repo-files-tool-registry.js`. Without this, executeTool()'s
// mcp.tool.* audit writes land in the PRODUCTION ledger (createAuditStore
// defaults to state/audit.sqlite3).
require('./lib/isolated-environment').activate('repo-files-tool-registry');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { executeTool, listTools } = require('./helpers/dispatch');
const repoFiles = require('../src/lib/providers/repo-files');
const { createFileToolContext, retireFileToolContext } = require('../src/lib/file-tool-context');

async function run() {
  const fileToolContext = createFileToolContext({ scopeKind: 'standalone-mcp' });
  const names = listTools().map(tool => tool.name);
  assert.ok(names.includes('repo.read_file'));
  assert.ok(names.includes('repo.write_file'));
  assert.ok(names.includes('repo.patch_file'));
  assert.ok(names.includes('repo.list_dir'));
  console.log('repo.* tools are registered.');

  const scratchRel = `tests/.repo-files-registry-test-${process.pid}-${Date.now()}`;
  const scratchAbs = path.join(repoFiles.ROOT, scratchRel);
  fs.mkdirSync(scratchAbs, { recursive: true });
  try {
    const filePath = `${scratchRel}/from-executeTool.txt`;
    const written = await executeTool('repo.write_file', { path: filePath, content: 'hi from executeTool\n' }, { requestId: 'repo-files-test-1', fileToolContext });
    assert.equal(written.path, filePath);
    assert.equal(written.created, true);
    assert.equal(written.receipt.binding.runtimeScopeId, fileToolContext.binding.runtimeScopeId);

    const read = await executeTool('repo.read_file', { path: filePath }, { requestId: 'repo-files-test-2', fileToolContext });
    assert.equal(read.content, 'hi from executeTool\n');

    const patched = await executeTool('repo.patch_file', {
      path: filePath,
      oldText: 'hi from executeTool',
      newText: 'patched through executeTool'
    }, { requestId: 'repo-files-test-patch', fileToolContext });
    assert.equal(patched.replacements, 1);
    assert.equal(repoFiles.readFile({ path: filePath }).content, 'patched through executeTool\n');

    const listed = await executeTool('repo.list_dir', { path: scratchRel }, { requestId: 'repo-files-test-3' });
    assert.deepEqual(listed.entries, [{ name: 'from-executeTool.txt', type: 'file' }]);

    // Schema enforcement: additionalProperties:false must reject stray fields.
    await assert.rejects(executeTool('repo.read_file', { path: filePath, extra: true }, { requestId: 'repo-files-test-4' }));

    // Write protection survives the full executeTool pipeline, not just the bare module.
    await assert.rejects(executeTool('repo.write_file', { path: 'STANDING-ORDERS.md', content: 'nope' }, { requestId: 'repo-files-test-5' }));
  } finally {
    await retireFileToolContext(fileToolContext, 'test-finished');
    fs.rmSync(scratchAbs, { recursive: true, force: true });
  }
  console.log('repo.* tools work end to end through executeTool().');
}

run().then(() => process.stdout.write('repo-files-tool-registry tests passed.\n')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
