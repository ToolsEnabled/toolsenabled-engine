'use strict';

// pay.record must refuse while the canonical audit ledger cannot durably
// record its dispatch intent, exactly as gmail.send/drive.upload already do
// via the same tool-registry chokepoint. Before this change pay.record's
// declared effect is 'local-write', so that chokepoint
// (entry.effect === 'external-write' -> requireDurableRecord('mcp.tool.intent', ...))
// never runs for it, and a real charge is written to the spend ledger
// regardless of audit health -- the finding this test pins closed.
//
// Asserted BY BEHAVIOUR, not by error spelling: the dispatch call rejects,
// AND the state store's spend_entries table gains zero new rows for it.
// A thrown promise alone does not establish the spend never happened.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function assertIsolated() {
  assert.ok(process.env.TOOLSENABLED_TEST_ISOLATED === '1',
    'this suite writes a settings file and dispatches a real spend; run it via tests/run-isolated.js');
}
assertIsolated();

// The owner has NOT reserved purchase approval for himself, so a spend with
// no cart-line authorization auto-approves up to the daily cap
// (purchase-authority.js's PURCHASE_AUTO_APPROVED_BY_SETTING path). This is
// the only way to reach state.recordSpend at all through the REAL registry
// dispatch (pay.record's schema has no `authorization` field), and it is
// necessary for BOTH the red and the green case below -- the fix under test
// is the audit gate, not the spend-authorization gate, so that gate must be
// held open identically in both runs. Isolated via TOOLSENABLED_SETTINGS_PATH
// (an env var settings.js itself already reads), never the shipped config.
const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pay-record-durable-intent-settings-')), 'settings.json');
fs.writeFileSync(settingsPath, `${JSON.stringify({
  revision: 1,
  values: { 'outward.reserved_from_agents': [] },
  provenance: { 'outward.reserved_from_agents': { source: 'user', atMs: Date.now(), directive: null } }
})}\n`);
process.env.TOOLSENABLED_SETTINGS_PATH = settingsPath;

// SELF-CONTAINED, NOT THE SHIPPED CONFIG: tool-registry.js destructures
// `{ ..., loadPolicy, requiresApproval, ... } = require('./policy')` at its
// own top-level scope (read and quoted in the report before writing this).
// This flip makes pay.record approvalEligible under the SHIPPED
// config/toolsenabled.policy.json (approvals.enabled: true, externalWrites:
// true -- read directly from that file, not assumed), which would otherwise
// make every dispatch below demand a one-time approval token from
// system.ask -- a second, real, independently documented consequence of this
// change (see the commit message and report), but not what THIS test
// exists to assert. Overriding only `requiresApproval` -- never `loadPolicy`
// itself -- keeps every other policy-driven check in the dispatch (kill
// switch, provider-enabled, model floor, standing authorizations) reading
// the real shipped policy unchanged; only the one approval-required
// computation is stubbed, and only for the duration of this test process.
const originalLoad = Module._load;
let forceAuditRefusal = false;
Module._load = function loadForToolRegistry(request, parent, isMain) {
  if (parent && /[\\/]lib[\\/]tool-registry\.js$/.test(parent.filename)) {
    if (request === './audit') {
      const real = originalLoad.call(this, request, parent, isMain);
      // Force every audit.requireRecord / audit.requireDurableStatus call
      // made FROM tool-registry.js to refuse -- reproducing, with the audit
      // module's own real AuditRequiredError class and AUDIT_UNAVAILABLE
      // code, the caller-visible contract a genuinely non-durable canonical
      // ledger produces. pay.js's own best-effort audit.record() call, and
      // every other module's real ledger use, are untouched.
      const refuse = () => {
        throw new real.AuditRequiredError('AUDIT_UNAVAILABLE',
          'Durable audit intent could not be recorded; the external mutation was not started. '
          + '(test fixture: canonical ledger forced non-durable)');
      };
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (forceAuditRefusal && (prop === 'requireRecord' || prop === 'requireDurableStatus')) return refuse;
          return Reflect.get(target, prop, receiver);
        }
      });
    }
    if (request === './policy') {
      const real = originalLoad.call(this, request, parent, isMain);
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'requiresApproval') return () => false;
          return Reflect.get(target, prop, receiver);
        }
      });
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
const registry = require('../src/lib/tool-registry');
const { getStateStore } = require('../src/lib/state-store');
Module._load = originalLoad;

const OWNER_SESSION = Object.freeze({ origin: 'local', tier: 'full' });
function dispatchPayRecord(reference) {
  return registry.executeTool('pay.record', {
    amountUsd: 4.5, purpose: 'durable-intent fixture', provider: 'durable-intent-test', reference
  }, { permissionSession: OWNER_SESSION });
}

function spendRowExists(reference) {
  return getStateStore().listSpend({}).some(entry => entry.reference === reference);
}

let assertions = 0;
function ok(condition, message) { assert.ok(condition, message); assertions += 1; }

async function main() {
  // Control: a durable ledger still records the charge. Proves the fixture
  // (settings + dispatch shape) is otherwise valid -- a refusal in this block
  // would be the wrong reason, and the two checks below would not be testing
  // what they claim to.
  {
    forceAuditRefusal = false;
    const reference = `durable-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await dispatchPayRecord(reference);
    ok(result && typeof result === 'object', 'a durable ledger returns the recordSpend result');
    ok(spendRowExists(reference), 'a durable ledger writes the spend row');
  }

  // The behaviour under test: while audit admission refuses, pay.record must
  // be refused BEFORE state.recordSpend runs -- not after, not silently.
  {
    forceAuditRefusal = true;
    const reference = `nondurable-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let rejected = false;
    try { await dispatchPayRecord(reference); }
    catch { rejected = true; }
    finally { forceAuditRefusal = false; }
    ok(rejected, 'the dispatch call rejects while the canonical ledger is non-durable');
    ok(!spendRowExists(reference), 'a non-durable ledger writes zero spend rows for the refused call');
  }

  process.stdout.write(`pay-record-durable-intent: ${assertions}/4 checks passed\n`);
}

main().catch(error => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exitCode = 1;
});
