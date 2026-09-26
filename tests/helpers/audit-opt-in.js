'use strict';

/* THE AUDITED INSTALL, CHOSEN THE WAY A PERSON CHOOSES IT.
 *
 * Audit is off by default (Basic: operation-audit.js, runtime-policy.js). A
 * suite that describes what the audited install does -- intents before
 * effects, refusals on an audit outage, receipts read back from the signed
 * ledger -- has to make that choice first, or it silently tests Basic instead.
 * This writes the isolated profile's saved settings with user provenance, the
 * same shape the app saves, and proves the runtime policy now reads audit as
 * on. It refuses to write anywhere but the isolated root.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function optInToAudit(isolatedRoot, values = { 'audit.enabled': true }) {
  const valuesPath = require('../../src/lib/settings').resolveValuesPath();
  assert.ok(typeof isolatedRoot === 'string' && valuesPath.startsWith(isolatedRoot + path.sep),
    'only the isolated profile is ever written');
  fs.mkdirSync(path.dirname(valuesPath), { recursive: true });
  fs.writeFileSync(valuesPath, JSON.stringify({ revision: 1, values,
    provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user' }])), rejected: [] }));
  const policy = require('../../src/lib/runtime-policy').runtimePolicy();
  assert.equal(policy.auditEnabled, true, 'the isolated profile really opted in to audit');
  return valuesPath;
}

module.exports = { optInToAudit };
