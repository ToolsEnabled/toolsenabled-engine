'use strict';
/* The audit tools inside a sandbox when the ledger file is truncated: each
 * says what is wrong, as audit.verify already did, rather than "internal
 * error". */
require('./lib/isolated-environment').activate('openshell-audit-edges');
process.env.OPENSHELL_SANDBOX = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const audit = require('../src/lib/audit');
const { executeTool } = require('../src/lib/tool-registry');
const { toolError } = require('../src/mcp-server');

const context = { permissionSession: require('../src/lib/permission-tier-policy').installTierSession('unrestricted') };

test('audit.status and audit.tail on a truncated ledger say it could not be opened', async () => {
  for (let index = 0; index < 5; index += 1) await audit.record('openshell.audit.edge', `entry-${index}`, { index });
  assert.equal((await executeTool('audit.status', {}, context)).ok, true);
  await audit.close();
  const file = process.env.TOOLSENABLED_AUDIT_DB;
  fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2));
  audit.resetForTests();
  for (const tool of ['audit.status', 'audit.tail']) {
    const error = await executeTool(tool, {}, context).then(() => null, caught => caught);
    assert.equal(error && error.code, 'AUDIT_SQLITE_ERROR', tool);
    assert.equal(toolError(error).content[0].text, 'The audit ledger could not be opened.', tool);
  }
  const verified = await executeTool('audit.verify', {}, context);
  assert.deepEqual({ valid: verified.valid, error: verified.error }, { valid: false, error: 'The audit ledger could not be opened.' });
  assert.equal(toolError(Object.assign(new Error('SQLITE_CORRUPT: database disk image is malformed at /x'), { code: 'AUDIT_SQLITE_ERROR' })).content[0].text,
    'The operation stopped safely because of an internal error. Check whether the action took effect before trying it again; if this keeps happening, report it to ToolsEnabled support with the time it happened.',
    'other words under the same code stay private');
});
