'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER = 'TOOLSENABLED_TEST_ISOLATED';
const ROOT_KEY = 'TOOLSENABLED_TEST_ROOT';

// THE RUNNING PRODUCT'S IDENTITY, FOR A RUN THAT HAS NO INSTALLATION.
//
// src/lib/durable-memory-file.js#resolveServicesRoot answers "where does this
// installation keep everything it owns" as LOCALAPPDATA plus the product name
// derived from the already selected TOOLSENABLED_STATE_ROOT.
// resolveProductDirectory REFUSES when that variable is unset, which is the
// fix working: falling back to a literal name is what once made a renamed or
// test build read and write the shipping product's own machine record, key and
// settings. Only the Electron shell publishes that variable, so every bare
// `node` run has it unset -- this checkout included.
//
// LOCALAPPDATA remains redirected both for the service root and for providers
// and platform helpers that consume it independently. On Windows production
// resolution additionally proves that this path is inside the verified
// installation owner's profile, so a stale elevated-account value is refused.
//
// AND THE IDENTITY IS DELIBERATELY NOT "ToolsEnabled". If a call site ever
// resolves the services root against the real process environment instead of a
// configured one, the directory it derives must still not be the shipping
// product's.
const SERVICES_BASE = 'local-app-data';
const PRODUCT_IDENTITY = 'ToolsEnabled Isolated Test';

const PATHS = Object.freeze({
  TOOLSENABLED_AUDIT_DB: 'audit.sqlite3',
  TOOLSENABLED_AUDIT_JSONL_PATH: 'actions.jsonl',
  TOOLSENABLED_AUDIT_TEXT_PATH: 'actions.log',
  TOOLSENABLED_AUDIT_EMERGENCY_PATH: 'audit-emergency.jsonl',
  TOOLSENABLED_VAULT_PATH: 'vault.json',
  TOOLSENABLED_KILLSWITCH_PATH: 'KILLSWITCH',
  TOOLSENABLED_STATE_PATH: 'state.sqlite3',
  TOOLSENABLED_SCHEDULER_LEGACY_PATH: 'jobs.json',
  // Q31: keep the dispatch-time owner-instruction gate check (tool-registry.js
  // executeTool -> egress-preflight.js#assertGatesMet) off the real
  // reports/OWNER-REQUEST-LEDGER.json for every isolated test run. The path
  // deliberately does not exist under the scratch root, so an unresolved
  // requestId (most tests never set one) reads as "no known gate" rather than
  // hitting production state.
  TOOLSENABLED_OWNER_LEDGER_FILE: path.join('reports', 'OWNER-REQUEST-LEDGER.json'),
  // Q31: src/lib/request-context.js's durable active-request marker, read by
  // the same dispatch-time gate check. Keeps every isolated test off the real
  // state/active-request.json.
  TOOLSENABLED_ACTIVE_REQUEST_PATH: path.join('state', 'active-request.json'),
  // R84: the owner-delivery outcome record. `node src/agent-digest.js --status`
  // reads it to report whether reports are actually reaching him, so a test
  // that exercises a send path must never be able to write a synthetic
  // failure into the real one.
  TOOLSENABLED_OWNER_DELIVERY_PATH: path.join('state', 'owner-delivery.json'),
  TOOLSENABLED_BROWSER_PROFILE_PATH: 'browser-profile',
  TOOLSENABLED_BROWSER_OWNER_PATH: path.join('state', 'browser-owner.json'),
  TOOLSENABLED_PLAYWRIGHT_OUTPUT_PATH: 'playwright-output',
  // R100: tools/fleet-supervisor.js's own startup/lifecycle log (separate
  // from the audit subsystem above). tests/fleet-supervisor-startup-refusal.test.js
  // spawns the real CLI end to end to prove the refusal happens before any
  // side effect; without this override every such run appended real
  // "startup-refused" lines to the production logs/fleet-supervisor.log.
  TOOLSENABLED_FLEET_SUPERVISOR_LOG_PATH: 'fleet-supervisor.log',
  // W41: state-root identity plus an independently isolated ambient platform
  // directory. See the note above for why the identity is a throwaway name.
  // Measured on this checkout before the change: tests/scheduler-runner.js,
  // tests/mission-bridge-claude-mcp-config.test.js and
  // tests/agent-session-confinement.test.js each died with
  // SERVICE_PRODUCT_IDENTITY_UNAVAILABLE at
  // src/lib/durable-memory-file.js:57 before reaching an assertion.
  LOCALAPPDATA: SERVICES_BASE,
  TOOLSENABLED_STATE_ROOT: path.join(SERVICES_BASE, PRODUCT_IDENTITY, 'capability'),
  TOOLSENABLED_PROVIDER_STATE_FILE: path.join('provider-state', 'cli-providers.json')
});

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/* Do not pre-seed runtime-state-root's migration record here. That workaround
 * once hid the product defect where a configured source checkout was mistaken
 * for an installed payload and its vault/logs/state were copied into scratch.
 * The product now gates legacy adoption on PAYLOAD.json, and an isolated test
 * must exercise that real decision. A fabricated "already-decided" record
 * would let the regression return while every consumer suite stayed green. */

/* Windows may publish TEMP in its 8.3 spelling even while the account's own
 * home is available in its canonical long spelling. Product account fencing
 * deliberately refuses an ambiguous `C:\\Users\\SAMPLE~1` rather than probing
 * it to discover whether it is this account or a sibling. Keep isolated test
 * roots unambiguous at creation time so the suite exercises the same long-form
 * account boundary the packaged shell publishes to children. */
function isolatedTemporaryRoot() {
  if (process.platform !== 'win32') return os.tmpdir();
  const home = os.homedir();
  if (typeof home !== 'string' || !path.win32.isAbsolute(home) || /~/.test(home)) return os.tmpdir();
  return path.join(home, 'AppData', 'Local', 'Temp');
}

function configure(root, environment = process.env) {
  const resolvedRoot = path.resolve(root);
  // The Linux vault correctly refuses group/world-readable custody folders.
  // mkdtemp roots were private, but per-file roots made by this runner were
  // 0755 under an ordinary umask, preventing every real audit signer read.
  fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  environment[MARKER] = '1';
  environment[ROOT_KEY] = resolvedRoot;
  for (const [name, filename] of Object.entries(PATHS)) environment[name] = path.join(resolvedRoot, filename);
  return resolvedRoot;
}

// Match the explicit retained-fixture flags published by the app source runner.
// Capture the decision when state is acquired so later environment changes
// cannot turn a retained fixture into an exit-time deletion.
function retainTestStateRequested(environment = process.env) {
  return environment.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1'
    || environment.TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES === '1';
}

function activate(label = 'test') {
  const inheritedRoot = process.env[MARKER] === '1' && process.env[ROOT_KEY]
    ? path.resolve(process.env[ROOT_KEY]) : null;
  const inheritedSafe = inheritedRoot && Object.keys(PATHS).every(name =>
    typeof process.env[name] === 'string' && within(inheritedRoot, process.env[name]));
  if (inheritedSafe) return { root: inheritedRoot, owner: false, paths: { ...PATHS } };

  const safeLabel = String(label).replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 40) || 'test';
  const root = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), `toolsenabled-${safeLabel}-`));
  configure(root);
  /* CLEANUP IS BEST-EFFORT FOR ORDINARY STATE AND MUST NOT BE FOR KEY MATERIAL.
   *
   * A scratch root that outlives its test is normally litter. One containing a
   * vault is different in kind, and this is not hypothetical: before the
   * PAYLOAD-gated product fix, 135 scratch roots in %TEMP% held vault-derived
   * secrets.json files -- one byte-identical to the live vault and 137 that had
   * DIVERGED, meaning suites had been mutating what they believed was scratch
   * state on top of the owner's real secrets.
   *
   * So a vault is swept explicitly first, and its survival is ANNOUNCED rather
   * than swallowed. The ordinary rm stays best-effort because a locked log file
   * is litter; a surviving vault is key material, and silence about it is what
   * let 135 accumulate unseen. The warning costs one line on a path that should
   * never run. */
  const retainState = retainTestStateRequested();
  const cleanup = () => {
    if (retainState) {
      process.stderr.write(`Isolated test state retained by request: ${root}\n`);
      return;
    }
    const vault = path.join(root, 'vault');
    try {
      if (fs.existsSync(vault)) fs.rmSync(vault, { recursive: true, force: true });
    } catch (error) {
      process.emitWarning('isolated-environment: could not remove scratch vault ' + vault
        + ': ' + (error && error.message) + '. Key material may survive this run.');
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort test cleanup */ }
    try {
      if (fs.existsSync(path.join(root, 'vault'))) {
        process.emitWarning('isolated-environment: scratch vault SURVIVED cleanup at ' + root
          + '. Remove it by hand; a temp vault outliving its test is leaked key material.');
      }
    } catch { /* the check itself must never fail a run */ }
  };
  process.once('exit', cleanup);
  return { root, owner: true, paths: { ...PATHS }, cleanup };
}

module.exports = { PATHS, activate, configure, isolatedTemporaryRoot, within, retainTestStateRequested };
