'use strict';

// THE MACHINE RECORD -- what first-run setup decides, written down once.
//
// Task T6 of docs/design/INSTALLER-EXPERIENCE.md section 7. Before this module
// existed, the answers to "which Node runs the servers", "where does this
// installation keep its state", "which ports may it use", and "which folders may
// an assistant touch" were not recorded anywhere a program could read. They were
// hardcoded, in a TRACKED file that ships: `.mcp.json` names
// `C:\agent-apps\node-v22.19.0\node.exe` five times and an absolute owner path
// three more. On any other computer all five MCP servers fail to launch, and the
// only repair documented anywhere is "edit the JSON by hand", which is precisely
// what the owner said must never be required of the person testing this.
//
// So `.mcp.json` is GENERATED from this record rather than shipped. The record is
// the single place a resolved value lives; every generated file is a projection of
// it and may be regenerated at any time without asking the user anything again.
//
// ABSENCE IS NOT AN ERROR, WITH ONE HONEST EXCEPTION. `readMachineRecord()` on a
// machine that has never run setup returns null, not a throw -- that is a machine
// which has not been set up yet, which is a normal state with an obvious next
// step, not a fault. The exception is a record that EXISTS and is malformed: that
// is reported as a typed refusal rather than silently replaced with defaults,
// because silently regenerating over a real installation's record would discard
// choices the user made and could not see us discard.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Cheap to require: this module has no top-level requires of its own, so a
// caller merely validating a record does not pull the tool registry in here.
const permissionTierPolicy = require('../permission-tier-policy');
const { resolveServicesRoot } = require('../durable-memory-file');

const SCHEMA_VERSION = 1;

// The three tiers of docs/design/INSTALLER-EXPERIENCE.md section 2, in the order
// the question presents them. `guided` is first because it is preselected: the
// least confident reader must be able to proceed by not deciding.
//
// RE-EXPORTED, NOT RESTATED. The list used to be declared here as well as in
// src/lib/permission-tier-policy.js, which meant the file that RECORDS a level
// and the file that ENFORCES one held separate ideas of what the levels were,
// with no mapping between them. One list, in the module that decides what each
// level permits; every existing importer of machineRecord.TIERS is unaffected.
const TIERS = permissionTierPolicy.INSTALL_TIERS;

// Section 3 step 5. The shell (application window) and the bridge get separate
// ranges, and the shell range is bounded by the origin allowlist the bridge
// enforces -- see src/lib/mission-bridge/server.js, which refuses an application
// origin outside 4600-4609 rather than clamping it silently.
const SHELL_PORT_RANGE = Object.freeze({ first: 4601, last: 4609 });
const BRIDGE_PORT_RANGE = Object.freeze({ first: 4610, last: 4619 });

// The bridge binds loopback and refuses anything else (BRIDGE_BIND_REFUSED). It
// is recorded here so a generated file never has to guess it, not so it can be
// changed -- a record naming a different host is refused below.
const LOOPBACK_HOST = '127.0.0.1';

const MACHINE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

class SetupRefusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SetupRefusal';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * Where this installation keeps everything it owns.
 *
 * The canonical resolver lives in durable-memory-file.js and derives the
 * directory from the running product identity. settings.js imports that same
 * resolver, so an installation remains one folder a person could delete.
 * Writable by the invoking user with no elevation, which is the property the
 * whole zero-UAC requirement rests on.
 */
function machineRecordPath(servicesRoot) {
  return path.join(servicesRoot, 'machine.json');
}

/**
 * The Node that will run the servers.
 *
 * `process.execPath` -- the interpreter actually executing this code -- and NOT a
 * pinned absolute path. This is the whole of P3.4 in the shipment plan reduced to
 * one line: a value that is true by construction on every machine cannot go stale
 * on any of them. An explicit override is accepted for the Unrestricted tier's
 * `/node=` argument, and is verified to exist rather than trusted.
 */
function resolveNodePath({ override = null, execPath = process.execPath, exists = fs.existsSync } = {}) {
  if (override !== null && override !== undefined && override !== '') {
    const resolved = path.resolve(override);
    if (!exists(resolved)) {
      throw new SetupRefusal(
        'SETUP_NODE_NOT_FOUND',
        `No program exists at ${resolved}. Setup will not write a configuration naming a runtime that is not there.`,
        { nodePath: resolved }
      );
    }
    return resolved;
  }
  return execPath;
}

function defaultMachineId(hostnameProvider = os.hostname) {
  let candidate = '';
  try {
    const name = hostnameProvider();
    if (typeof name === 'string') candidate = name.trim().toLowerCase();
  } catch (error) {
    throw new SetupRefusal(
      'SETUP_MACHINE_ID_UNAVAILABLE',
      `This computer's name could not be read, so setup cannot tell which machine this is. This does not mean the computer has no name: ${error.message}`,
      { reason: error.message, causeCode: error.code }
    );
  }
  const slug = candidate.replace(/[^a-z0-9._-]/g, '-').replace(/^-+/, '');
  return MACHINE_ID_PATTERN.test(slug) ? slug : 'this-machine';
}

function defaultMachineLabel(hostnameProvider = os.hostname) {
  try {
    const name = hostnameProvider();
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  } catch (error) {
    throw new SetupRefusal(
      'SETUP_MACHINE_LABEL_UNAVAILABLE',
      `This computer's name could not be read, so setup cannot tell what to call this machine. This does not mean the computer has no name: ${error.message}`,
      { reason: error.message, causeCode: error.code }
    );
  }
  return 'This computer';
}

/**
 * Build a complete record from resolved values. Every field is required: a record
 * with a hole in it is how a generated file ends up with `undefined` in a path.
 */
function buildMachineRecord(input = {}) {
  const {
    tier,
    installRoot,
    servicesRoot,
    nodePath,
    workspaceRoots,
    machineId = defaultMachineId(),
    machineLabel = defaultMachineLabel(),
    shellPortRange = SHELL_PORT_RANGE,
    bridgePortRange = BRIDGE_PORT_RANGE,
    loopbackHost = LOOPBACK_HOST,
    createdAtMs = Date.now()
  } = input;

  const record = {
    schemaVersion: SCHEMA_VERSION,
    tier,
    machine: { id: machineId, label: machineLabel },
    installRoot: typeof installRoot === 'string' ? path.resolve(installRoot) : installRoot,
    servicesRoot: typeof servicesRoot === 'string' ? path.resolve(servicesRoot) : servicesRoot,
    nodePath: typeof nodePath === 'string' ? path.resolve(nodePath) : nodePath,
    workspaceRoots: Array.isArray(workspaceRoots)
      ? workspaceRoots.map(entry => (typeof entry === 'string' ? path.resolve(entry) : entry))
      : workspaceRoots,
    loopbackHost,
    shellPortRange: { first: shellPortRange.first, last: shellPortRange.last },
    bridgePortRange: { first: bridgePortRange.first, last: bridgePortRange.last },
    createdAtMs
  };

  const validation = validateMachineRecord(record);
  if (!validation.ok) {
    throw new SetupRefusal(
      'SETUP_MACHINE_RECORD_INVALID',
      `This configuration cannot be written: ${validation.errors.join('; ')}`,
      { errors: validation.errors }
    );
  }
  return Object.freeze({
    ...record,
    machine: Object.freeze(record.machine),
    workspaceRoots: Object.freeze(record.workspaceRoots.slice()),
    shellPortRange: Object.freeze(record.shellPortRange),
    bridgePortRange: Object.freeze(record.bridgePortRange)
  });
}

function validateMachineRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: ['the record is not an object'] };
  }
  if (record.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!TIERS.includes(record.tier)) errors.push(`tier must be one of ${TIERS.join(', ')}`);

  const machine = record.machine;
  if (!machine || typeof machine !== 'object') errors.push('machine is missing');
  else {
    if (typeof machine.id !== 'string' || !MACHINE_ID_PATTERN.test(machine.id)) {
      errors.push('machine.id must be a short lowercase name (letters, digits, dot, dash, underscore)');
    }
    if (typeof machine.label !== 'string' || machine.label.trim() === '') errors.push('machine.label must be text');
  }

  for (const field of ['installRoot', 'servicesRoot', 'nodePath']) {
    if (typeof record[field] !== 'string' || !path.isAbsolute(record[field])) {
      errors.push(`${field} must be an absolute path`);
    }
  }
  if (!Array.isArray(record.workspaceRoots) || record.workspaceRoots.length === 0) {
    errors.push('workspaceRoots must list at least one folder');
  } else if (record.workspaceRoots.some(entry => typeof entry !== 'string' || !path.isAbsolute(entry))) {
    errors.push('every workspace root must be an absolute path');
  }
  // Not a preference. src/lib/mission-bridge/server.js refuses any other bind
  // with BRIDGE_BIND_REFUSED, so a record claiming otherwise would describe a
  // configuration that cannot start.
  if (record.loopbackHost !== LOOPBACK_HOST) errors.push(`loopbackHost must be ${LOOPBACK_HOST}`);

  for (const [field, allowed] of [['shellPortRange', SHELL_PORT_RANGE], ['bridgePortRange', BRIDGE_PORT_RANGE]]) {
    const range = record[field];
    if (!range || typeof range !== 'object') { errors.push(`${field} is missing`); continue; }
    if (!Number.isInteger(range.first) || !Number.isInteger(range.last) || range.first > range.last) {
      errors.push(`${field} must be an integer range`);
    } else if (range.first < allowed.first || range.last > allowed.last) {
      errors.push(`${field} must stay inside ${allowed.first}-${allowed.last}`);
    }
  }
  if (!Number.isFinite(record.createdAtMs)) errors.push('createdAtMs must be a number');

  return { ok: errors.length === 0, errors };
}

// --- tamper evidence on the record -----------------------------------------
//
// WHAT THIS CLOSES, MEASURED. This record is the SOLE authority for the
// permission level and for workspaceRoots, and until now validateMachineRecord
// checked its SHAPE and nothing else. Measured against the packaged payload at
// release/win-unpacked on 2026-08-11: rewriting the single token `"tier":
// "guided"` to `"tier": "unrestricted"` took the resolved surface from 102 of
// 262 tools to 262 of 262 -- gaining host.exec, browser.start, duo.ucr_login,
// system.credential_request, instagram.publish_image, the Stripe tools,
// audit.flush and system.kill_switch_activate -- and flipped
// assertUnrestrictedSpawn from PERMISSION_UNRESTRICTED_SPAWN_REFUSED to
// allowed, which is the `--dangerously-bypass-approvals-and-sandbox` argv.
// validateMachineRecord accepted the rewritten record without complaint. The
// question the installer asks the user was therefore advisory.
//
// THIS IS TAMPER EVIDENCE. IT IS NOT TAMPER PROOFING, AND THE DIFFERENCE IS
// NOT A DETAIL. This product installs with no elevation on purpose: both
// servicesRoot (%LOCALAPPDATA%\ToolsEnabled) and installRoot
// (%LOCALAPPDATA%\Programs\toolsenabled) are writable by the ordinary user, so
// there is nowhere on this machine to put a key that code running AS that user
// cannot also read. An attacker who knows this mechanism can read the key,
// recompute the MAC over the record they want, and write both. No purely
// local, same-user scheme can prevent that, and claiming otherwise here would
// be worse than the hole, because someone would rely on it.
//
// WHAT IT IS WORTH ANYWAY, stated concretely rather than as a principle:
//   - The escalation stops being a ONE-TOKEN EDIT. Today a prompt-injected or
//     merely confused agent that can write a file changes one word and widens
//     itself. After this, the same act must locate the key, reproduce this
//     module's exact canonical serialisation, and forge a MAC. That converts
//     an accident into a deliberate, product-specific attack -- and only the
//     second one is worth calling an attack.
//   - The failure is LOUD AND FAILS CLOSED. Every caller of readMachineRecord
//     already wraps it in try/catch and falls back to the most restrictive
//     level (dispatch-permission-session.js, mcp-server.js,
//     mission-bridge/actions.js, agent-session-confinement.js), and the two
//     shell paths surface `code` and `reason` to the user. So a broken seal
//     produces a narrow surface plus a visible named refusal instead of a
//     silent full-surface grant.
//
// THE DOWNGRADE IS REAL AND IS NOT CLOSED. An attacker who deletes BOTH the
// key file and the integrity field returns the install to the unadopted state
// below and is re-adopted at whatever tier they wrote. Closing that needs an
// authority off this machine or an admin-owned location, i.e. it needs the
// zero-UAC property to be traded away. The stronger local answer is to witness
// each tier decision in the hash-chained audit ledger, which audit.verify
// already protects; that crosses into the audit lane's territory and is
// recorded for them rather than improvised here.
//
// ADOPTION SEALS WHAT IT FINDS. An install upgrading from a version without
// this mechanism has no key, so its existing record is sealed as-is on first
// read. If that record was ALREADY tampered with before the upgrade, the tamper
// is what gets sealed. Adoption cannot authenticate the past; it only starts
// the evidence.
const INTEGRITY_VERSION = 1;
const INTEGRITY_ALGORITHM = 'sha256';
// A domain separator, so this MAC can never be replayed as, or confused with,
// any other HMAC this product computes with the same key material.
const INTEGRITY_DOMAIN = 'ToolsEnabled/machine-record/v1';

function machineRecordKeyPath(servicesRoot) {
  return path.join(servicesRoot, 'machine-record.key');
}

/* THE MAC COVERS THE WHOLE RECORD, NOT A LIST OF SECURITY-RELEVANT FIELDS.
 * A field list has to be maintained in step with every field anyone ever adds,
 * and the first one that is forgotten is the next escalation -- workspaceRoots
 * and nodePath are as load-bearing as tier, and `installRoot` decides which
 * program the shell launches. Covering everything except the signature itself
 * needs no maintenance and cannot be outflanked by adding a field.
 *
 * Keys are sorted so that a record re-serialised in a different key order
 * verifies. JSON.stringify preserves insertion order, and the record travels
 * through spreads and JSON round-trips in several callers. */
function canonicalRecordBytes(record) {
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((accumulator, key) => {
        accumulator[key] = canonical(value[key]);
        return accumulator;
      }, {});
    }
    return value;
  };
  const { integrity: _ignored, ...rest } = record;
  return Buffer.from(JSON.stringify(canonical(rest)), 'utf8');
}

function machineRecordMac(record, key) {
  return crypto.createHmac(INTEGRITY_ALGORITHM, key)
    .update(`${INTEGRITY_DOMAIN}\n`)
    .update(canonicalRecordBytes(record))
    .digest('hex');
}

function readIntegrityKey(servicesRoot) {
  try {
    const raw = fs.readFileSync(machineRecordKeyPath(servicesRoot), 'utf8').trim();
    // A truncated or emptied key file is not a missing key. Treating it as
    // missing would let `> machine-record.key` re-open the adoption path.
    if (!/^[0-9a-f]{64}$/i.test(raw)) return { present: true, key: null };
    return { present: true, key: Buffer.from(raw, 'hex') };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { present: false, key: null };
    throw new SetupRefusal(
      'SETUP_MACHINE_RECORD_KEY_UNREADABLE',
      `${machineRecordKeyPath(servicesRoot)} could not be read: ${error.message}`,
      { file: machineRecordKeyPath(servicesRoot) }
    );
  }
}

function createIntegrityKey(servicesRoot) {
  const key = crypto.randomBytes(32);
  const file = machineRecordKeyPath(servicesRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  // 0o600 is honoured on POSIX and is inert on Windows, where the file inherits
  // the per-user LOCALAPPDATA ACL. Stated so nobody reads the mode as a
  // Windows guarantee it is not.
  fs.writeFileSync(temporary, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  return key;
}

/** Stamp a record with its authenticator. Returns a new record; never mutates. */
function sealMachineRecord(record, { servicesRoot = record.servicesRoot } = {}) {
  const existing = readIntegrityKey(servicesRoot);
  const key = existing.key || createIntegrityKey(servicesRoot);
  const { integrity: _ignored, ...rest } = record;
  return {
    ...rest,
    integrity: { version: INTEGRITY_VERSION, algorithm: INTEGRITY_ALGORITHM, mac: machineRecordMac(rest, key) }
  };
}

/**
 * What the seal on this record says. Never throws for a bad seal -- reporting
 * is separate from deciding, so a caller that only wants to DESCRIBE the
 * installation (the setup UI) does not have to catch a refusal to do it.
 *
 * States:
 *   sealed     the MAC verifies against this installation's key
 *   unadopted  no key and no seal -- an install from before this mechanism
 *   tampered   a key exists and the record is unsealed or the MAC disagrees
 */
function verifyMachineRecordIntegrity(record, { servicesRoot = record && record.servicesRoot } = {}) {
  const stored = record && record.integrity;
  const { present, key } = readIntegrityKey(servicesRoot);
  if (!present) {
    // A seal with no key cannot be checked, and an unverifiable seal must not
    // read as "fine". It is the shape a downgrade leaves behind.
    if (stored) return { ok: false, state: 'tampered', reason: 'the record is sealed but this installation has no key' };
    return { ok: false, state: 'unadopted', reason: 'this installation predates record integrity' };
  }
  if (!key) return { ok: false, state: 'tampered', reason: 'the integrity key is unreadable or truncated' };
  if (!stored || typeof stored !== 'object') {
    return { ok: false, state: 'tampered', reason: 'the record carries no integrity seal but this installation has a key' };
  }
  if (stored.version !== INTEGRITY_VERSION || stored.algorithm !== INTEGRITY_ALGORITHM || typeof stored.mac !== 'string') {
    return { ok: false, state: 'tampered', reason: 'the integrity seal is not one this program can check' };
  }
  const expected = Buffer.from(machineRecordMac(record, key), 'utf8');
  const actual = Buffer.from(stored.mac, 'utf8');
  // Constant-time, and length-checked first because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, state: 'tampered', reason: 'the recorded permission level does not match its integrity seal' };
  }
  return { ok: true, state: 'sealed', reason: null };
}

function readMachineRecord({ servicesRoot, readFile = fs.readFileSync, adopt = true } = {}) {
  const file = machineRecordPath(servicesRoot);
  let text;
  try {
    text = readFile(file, 'utf8');
  } catch (error) {
    // Never set up here yet. A normal state with an obvious next step.
    if (error && error.code === 'ENOENT') return null;
    throw new SetupRefusal('SETUP_MACHINE_RECORD_UNREADABLE', `${file} could not be read: ${error.message}`, { file });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SetupRefusal(
      'SETUP_MACHINE_RECORD_MALFORMED',
      `${file} exists but is not readable configuration. Setup will not overwrite it without being told to.`,
      { file, reason: error.message }
    );
  }
  const validation = validateMachineRecord(parsed);
  if (!validation.ok) {
    throw new SetupRefusal(
      'SETUP_MACHINE_RECORD_INVALID',
      `${file} exists but is not a valid configuration: ${validation.errors.join('; ')}`,
      { file, errors: validation.errors }
    );
  }

  /* THE SEAL IS CHECKED ONLY WHEN THIS IS A REAL READ OF A REAL INSTALLATION.
   * An injected `readFile` means a caller is validating text it supplied, not
   * reading this machine -- the existing tests do exactly that with fabricated
   * servicesRoot paths. Verifying against a key that describes a different
   * installation would refuse valid records, and ADOPTING would write a key
   * into a directory the caller never asked us to touch. */
  if (readFile !== fs.readFileSync) return parsed;

  const integrity = verifyMachineRecordIntegrity(parsed, { servicesRoot });
  if (integrity.state === 'tampered') {
    throw new SetupRefusal(
      'SETUP_MACHINE_RECORD_TAMPERED',
      `${file} does not match its integrity seal, so the permission level it claims cannot be trusted: ${integrity.reason}. Run setup again to record a level deliberately.`,
      { file, reason: integrity.reason }
    );
  }
  if (integrity.state === 'unadopted' && adopt) {
    /* Self-healing, once, for installs that predate this mechanism. Best
     * effort on purpose: a read-only services root, or a second process
     * adopting concurrently, must not make an otherwise valid installation
     * unreadable. Failing to START the evidence is not a reason to refuse a
     * record that is not yet claiming to have any. */
    try { writeJsonAtomic(file, sealMachineRecord(parsed, { servicesRoot })); } catch { /* stays unadopted */ }
  }
  return parsed;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return file;
}

function writeMachineRecord(record, { servicesRoot = record.servicesRoot } = {}) {
  const validation = validateMachineRecord(record);
  if (!validation.ok) {
    throw new SetupRefusal('SETUP_MACHINE_RECORD_INVALID', validation.errors.join('; '), { errors: validation.errors });
  }
  /* THE RECORD IS SETUP'S COMMIT MARKER. commandStatus() treats its presence as
   * a completed installation, while applyPlan() writes the generated MCP file
   * immediately afterwards. Run that generation's complete refusal path before
   * creating either the integrity key or machine.json, so a missing runtime or
   * unusable catalogue cannot leave a false completed-installation marker. The
   * later writeMcpConfig() still generates again at the point of use; this call
   * is the no-write preflight that makes the earlier commit safe. */
  generateMcpConfig(record);
  /* SEALED ON THE WAY OUT, so there is exactly one way a record reaches disk
   * and it is always authenticated. Doing it in the callers instead would mean
   * the one that forgets writes an unsealed record, which readMachineRecord
   * then reports as TAMPERED on an installation nobody attacked. */
  return writeJsonAtomic(machineRecordPath(servicesRoot), sealMachineRecord(record, { servicesRoot }));
}

// --- generated .mcp.json ----------------------------------------------------

// Which servers a tier may configure, AND how wide each one is. This is a real
// difference in what the install can reach, not a difference in what it
// displays: Guided generates a read-only surface and no remote lane at all,
// which is what docs/design/INSTALLER-EXPERIENCE.md section 2.2 means by
// "refuses ... arbitrary MCP servers, since Guided generates its own .mcp.json
// rather than inheriting one".
//
// `allowlisted` says whether the server narrows itself from
// TOOLSENABLED_TOOL_ALLOWLIST. Only the two src/mcp-server.js entries do;
// src/playwright-gateway.js never reads that variable and enforces its own
// reviewed positive allowlist instead (BROWSER_TOOL_NOT_ALLOWED, gateway :251),
// so writing the variable there would be decoration that a reader could mistake
// for a limit.
//
// WHAT THIS STILL DOES NOT DO. Enforcement of the SPAWN flags -- the OS-level
// sandbox that bounds the agent process's own file access -- is the other half
// of T5 and lives in src/lib/mission-bridge/actions.js, which this module does
// not touch. What is enforced from here is the TOOL SURFACE: the server refuses
// a tool outside the generated allowlist on every call.
// THE TWO REMOTE LANES ARE DELIBERATELY ABSENT. They need
// `REMOTE_AGENT_EXPECTED_ROOT` -- the path the OTHER computer is installed at --
// and setup cannot know that until two computers have been paired and have told
// each other. Emitting them with a guessed root is precisely the failure this
// repository has already had once: a hardcoded address for the other machine
// produced a listener that answered every probe while being the wrong one (see
// the incident recorded at the top of config/service-registry.json). Pairing
// owns those entries; setup does not invent them.
// The script that reads TOOLSENABLED_TOOL_ALLOWLIST. Named so the check below
// can bind to it rather than to a server's name.
const ALLOWLIST_READING_SCRIPT = 'src/mcp-server.js';

/* THE ARGUMENT WITHOUT WHICH THE BROWSER SERVER CANNOT START, AND DID NOT.
 *
 * src/playwright-gateway.js refuses to run unless its own process.argv[2] is a
 * PINNED package spec -- it tests exactly PLAYWRIGHT_PACKAGE_SPEC_RE below and,
 * failing it, writes "A pinned @playwright/mcp version is required." and exits 2.
 * The catalogue entry below emitted `args: [scriptPath]` and nothing else, so
 * argv[2] was undefined on every configuration this function has ever generated
 * -- which is every installed build and every lane whose surface comes from here.
 * The browser server was advertised in the document and dead on arrival.
 *
 * MEASURED 2026-08-16 against a machine record the product itself wrote: at both
 * `standard` and `unrestricted` the generated args were ["...playwright-gateway.js"],
 * argv[2] undefined, guard false. The CONTROL is the checked-in .mcp.json in this
 * repository, which passes "@playwright/mcp@0.0.78" and passes the guard -- as do
 * install.ps1, tools/playwright-mcp.cmd, tools/playwright-call.js, the codex config
 * example and providers/workstation.js:446. Every writer of this argument got it
 * right except the one that writes the shipped configuration.
 *
 * WHY THE SPEC IS MIRRORED HERE rather than imported. The canonical constant is
 * providers/workstation.js PLAYWRIGHT_PACKAGE, which is exported -- but that module
 * pulls in the elevation-refusal chain and the whole workstation provider, and this
 * is a setup module that other setup code requires at load.
 * tests/install-tier-enforcement.test.js asserts the two are EQUAL, so drift is a
 * red test rather than a browser server that dies at spawn on a customer's machine.
 *
 * The regex is the gateway's own, copied deliberately: generation now refuses to
 * emit an entry whose spec would fail at spawn, which is the check that was missing.
 */
/* WHAT THE VERSION NUMBER MEANS NOW (2026-09-22). It is the version fetched
 * when ToolsEnabled has no copy of @playwright/mcp yet, not a pin that decides
 * whether the browser tools may run: src/playwright-gateway.js accepts a copy
 * by what its own tools/list offers (checkPlaywrightTools). The default moves
 * only to a version whose recorded tools/list is in tests/fixtures and checks
 * 'ready'; tests/desktop.browser/playwright-gateway.js holds every writer of
 * this argument to the same version. 0.0.82 was proven against the gateway
 * with a real browser before it replaced 0.0.78. */
const PLAYWRIGHT_PACKAGE_SPEC = '@playwright/mcp@0.0.82';
const PLAYWRIGHT_PACKAGE_SPEC_RE = /^@playwright\/mcp@\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

/* THE V8 FLAG THAT REMOVES THE TASK BOTH MCP SERVERS DIED INSIDE.
 *
 * MEASURED 2026-09-04T04:11:56Z, two crash dumps, pids 20204 and 11012 -- the
 * `toolsenabled` and `toolsenabled-readonly` servers of ONE circle, both started
 * 03:56:20Z, both aborted in the same second. The CONTEXT-based stack walk
 * (REPORT-crash-20260903/evidence/D, identical in both dumps) is:
 *
 *   KERNELBASE!DebugBreak                                       <- EXCEPTION_BREAKPOINT
 *   electron.exe!uv_fatal_error                                 <- rsi=6, rdi="PostQueuedCompletionStatus"
 *   electron.exe!node::NodePlatform::PostDelayedTaskOnWorkerThreadImpl
 *   electron.exe!v8::internal::MemoryPool::PostDelayedReleaseTask
 *   electron.exe!v8::internal::MemoryPool::ReleasePooledChunksTask::RunInternal
 *   electron.exe!node::PlatformWorkerThread
 *
 * while the MAIN thread of the same process was already inside
 * `node::WorkerThreadsTaskRunner::Shutdown()` <- `node::NodePlatform::~NodePlatform()`
 * <- `electron::JavascriptEnvironment::~JavascriptEnvironment()` <- `electron::NodeMain()`.
 *
 * That is a clean process exit racing V8's global memory pool. The pool re-arms
 * a release task on a platform worker thread every `--memory-pool-timeout`
 * seconds (MEASURED default: 8). If that task fires while NodeMain's teardown
 * has already closed the delayed-task scheduler's libuv loop, the re-post lands
 * on a closed IOCP, `PostQueuedCompletionStatus` returns ERROR_INVALID_HANDLE
 * (6), and libuv calls `uv_fatal_error` -> `DebugBreak()` -> abort. Two servers
 * of one circle hit it in the same second because they were started in the same
 * second -- their 8-second pool timers are phase-aligned -- and were shut down
 * in the same second when their parent died.
 *
 * IT IS NOT AN OUT-OF-MEMORY. Committed PRIVATE memory in both dumps was
 * 10.9 MB, total commit 367 MB, and the largest free VA hole was 70 TB.
 *
 * `--no-memory-pool` removes `MemoryPool::ReleasePooledChunksTask` and with it
 * the two middle frames, so the re-post cannot happen. A stdio broker that lives
 * for one session gains nothing from pooling pages globally anyway.
 *
 * ONLY WHEN THE RUNTIME ACCEPTS IT. MEASURED: `electron.exe` 43.3.0 under
 * ELECTRON_RUN_AS_NODE accepts the flag and still reports `process.argv[1]` as
 * the script (so playwright-gateway's argv[2] package spec is unaffected), while
 * `node.exe` v22.14.0 rejects it outright -- "bad option: --no-memory-pool",
 * exit 9. An unrecognised flag does not degrade the server, it prevents the
 * process from starting at all, which would take the whole tool surface down.
 * So the flag is PROBED against the recorded runtime before it is written, and
 * anything other than a clean exit 0 writes no flags at all.
 */
const RUNTIME_GUARD_FLAGS = Object.freeze(['--no-memory-pool']);
const RUNTIME_GUARD_PROBE_TIMEOUT_MS = 10000;
// Keyed by runtime path + flags: generation runs once per lane configuration and
// the answer cannot change for a given binary inside one process.
const runtimeGuardProbeCache = new Map();

/**
 * The guard flags this runtime will actually start with. Returns [] on any
 * doubt: no probe result, a non-zero exit, a spawn error, or a timeout.
 */
function runtimeGuardFlags(nodePath, {
  flags = RUNTIME_GUARD_FLAGS,
  spawn = childProcess.spawnSync,
  cache = runtimeGuardProbeCache
} = {}) {
  if (typeof nodePath !== 'string' || nodePath.length === 0) return [];
  if (!Array.isArray(flags) || flags.length === 0) return [];
  // Only the run-as-node runtimes. `node` is the one binary MEASURED to refuse
  // the flag, and it is also the one that never carries this Electron teardown.
  if (!runtimeNeedsNodeMode(nodePath)) return [];
  const key = `${nodePath} ${flags.join(' ')}`;
  if (cache.has(key)) return cache.get(key);
  let accepted = [];
  try {
    const result = spawn(nodePath, [...flags, '-e', '0'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: RUNTIME_GUARD_PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: 'ignore'
    });
    if (result && !result.error && result.status === 0) accepted = [...flags];
  } catch {
    accepted = [];
  }
  const frozen = Object.freeze(accepted);
  cache.set(key, frozen);
  return frozen;
}

function resetRuntimeGuardProbeForTests() {
  runtimeGuardProbeCache.clear();
}

/* HOW MUCH MEMORY ONE OF THESE SERVERS MAY TAKE BEFORE IT DIES ALONE.
 *
 * MEASURED 2026-09-03 (REPORT-crash-20260903/evidence/C/heapcap-probe.txt) on
 * the electron.exe this record names, started with ELECTRON_RUN_AS_NODE=1
 * exactly as an MCP client starts it:
 *
 *   no cap                                heap_size_limit = 4192 MB
 *   NODE_OPTIONS=--max-old-space-size=512 heap_size_limit =  608 MB
 *   NODE_OPTIONS=--max-old-space-size=384 heap_size_limit =  408 MB
 *
 * So the default is FOUR GIGABYTES of old space per server, and the generated
 * document starts THREE of them per assistant. Nine assistants -- the number
 * this computer actually resumed on 2026-09-03 between 21:15 and 21:24 --
 * therefore carried a 113 GB V8 ceiling on a 32 GB machine with a 34.7 GB
 * commit limit. (Two of those servers died at 04:11:56Z; lane D's stack walk
 * later showed that was a shutdown race, not an out-of-memory, so this cap is
 * protection against a runaway server, not the repair for that death.)
 *
 * The caps below are set against the MEASURED steady state, not a guess
 * (REPORT-crash-20260903/evidence/C/measure-*.json): each server settles at
 * 30-60 MB private bytes idle and after twenty tool calls, so 512/256 MB of old
 * space is 8-16x the observed working size. A server that exceeds that is a
 * runaway, and the point of the cap is that a runaway aborts by itself with a
 * heap-limit message instead of taking every other process on the computer with
 * it.
 *
 * WHY PER SERVER RATHER THAN ONE NUMBER. `toolsenabled-readonly` advertises 95
 * tools against `toolsenabled`'s 240 (measured, same evidence files) and can
 * never write, so it gets half. When both run for the same assistant this is
 * what stops the second copy costing as much as the first.
 */
const SERVER_CATALOGUE = Object.freeze([
  {
    name: 'toolsenabled-readonly',
    script: 'src/mcp-server.js',
    tiers: Object.freeze(['guided', 'standard', 'unrestricted']),
    readOnly: true,
    allowlisted: true,
    heapCapMB: 256,
    browser: false
  },
  {
    name: 'toolsenabled',
    script: 'src/mcp-server.js',
    tiers: Object.freeze(['standard', 'unrestricted']),
    readOnly: false,
    allowlisted: true,
    heapCapMB: 512,
    browser: false
  },
  {
    name: 'playwright',
    script: 'src/playwright-gateway.js',
    tiers: Object.freeze(['standard', 'unrestricted']),
    readOnly: false,
    allowlisted: false,
    heapCapMB: 512,
    // The one entry that exists to drive a browser, and the only one an
    // assistant with no browser work has no use for. See `browserTools`.
    browser: true,
    // Without this the gateway exits 2 before doing anything. See the note above.
    packageSpec: PLAYWRIGHT_PACKAGE_SPEC
  }
]);

/* The V8 flag, spelled once. NODE_OPTIONS rather than argv because the argv of
 * these entries is already load-bearing (the gateway reads argv[2] as its
 * pinned package spec, and mcp-server.js is argv[1]); a flag inserted there
 * would shift what those programs read. MEASURED both ways in the probe above:
 * ELECTRON_RUN_AS_NODE honours the variable and the argv form identically. */
function heapCapEnvironment(megabytes) {
  return { NODE_OPTIONS: `--max-old-space-size=${megabytes}` };
}

/**
 * Every catalogue entry must SAY whether it is narrowed, and an entry backed by
 * the server that reads the variable must say yes.
 *
 * Without this, `allowlisted` is a permissive default wearing a flag: a future
 * server added to the catalogue without the property is `undefined`, takes the
 * `else if (server.allowlisted === true)` branch's false arm, and is written
 * with no allowlist -- which the server reads as the FULL surface. That failure
 * is invisible in every test that only exercises the three entries that exist
 * today, which is exactly the shape of hidden fallback that survives mutation
 * testing: reachable only once another component (a new entry) is present.
 *
 * Checked at the point of generation rather than at module load, so a malformed
 * catalogue refuses to produce a configuration instead of taking the whole
 * program down on require.
 */
function assertServerCatalogue(catalogue) {
  if (!Array.isArray(catalogue) || catalogue.length === 0) {
    throw new SetupRefusal('SETUP_SERVER_CATALOGUE_INVALID', 'The list of servers setup may configure is unreadable.', {});
  }
  for (const server of catalogue) {
    if (!server || typeof server.name !== 'string' || typeof server.script !== 'string') {
      throw new SetupRefusal('SETUP_SERVER_CATALOGUE_INVALID', 'A server in the catalogue is missing its name or script.', {});
    }
    if (typeof server.allowlisted !== 'boolean') {
      throw new SetupRefusal(
        'SETUP_SERVER_CATALOGUE_INVALID',
        `The server "${server.name}" does not say whether the permission level narrows it, and setup will not guess that it does not.`,
        { server: server.name }
      );
    }
    if (server.script === ALLOWLIST_READING_SCRIPT && server.allowlisted !== true) {
      throw new SetupRefusal(
        'SETUP_SERVER_CATALOGUE_INVALID',
        `The server "${server.name}" runs the program that reads the tool allowlist, so it cannot be left unnarrowed by the permission level.`,
        { server: server.name, script: server.script }
      );
    }
    /* SAME SHAPE, SAME REASON as `allowlisted` above: a future entry added
     * without a cap would be `undefined`, would take the no-cap branch, and
     * would ship the 4192 MB default that this file exists to end -- invisibly,
     * because every test that exercises only today's three entries would still
     * pass. An entry must SAY how much memory it may take.
     *
     * ORDERED LAST, and that is this suite's own rule rather than an accident:
     * tests/setup/first-run-setup.test.js keeps each catalogue fixture tripping
     * EXACTLY ONE guard, so a fixture written to prove the allowlist guard must
     * still reach it rather than being turned away here first. */
    if (!Number.isInteger(server.heapCapMB) || server.heapCapMB < 64 || server.heapCapMB > 4096) {
      throw new SetupRefusal(
        'SETUP_SERVER_CATALOGUE_INVALID',
        `The server "${server.name}" does not say how much memory it may use, and setup will not write a configuration that lets one assistant's helper take the whole computer.`,
        { server: server.name, heapCapMB: server.heapCapMB }
      );
    }
    if (typeof server.browser !== 'boolean') {
      throw new SetupRefusal(
        'SETUP_SERVER_CATALOGUE_INVALID',
        `The server "${server.name}" does not say whether it is the browser server, and setup will not guess that it is not.`,
        { server: server.name }
      );
    }
  }
  return catalogue;
}

/**
 * The tools a read-only surface may advertise, DERIVED rather than listed.
 *
 * The shipped `.mcp.json` names its 36 read-only tools by hand. A hand-written
 * list is a copy that goes stale the first time a tool is added, and a stale
 * read-only list fails in the dangerous direction. This asks the registry which
 * tools only read, using the same effect classification
 * `src/lib/permission-tier-policy.js` already enforces at call time, so the
 * advertised surface and the enforced surface cannot disagree.
 *
 * Loaded lazily: the tool registry pulls in every provider, and a caller merely
 * validating a record has no reason to pay for that.
 */
function readOnlyToolAllowlist() {
  const { registeredTools } = require('../tool-registry');
  const { allowedToolNames } = permissionTierPolicy;
  const names = allowedToolNames(registeredTools(), { origin: 'local', tier: 'guarded' });
  if (!Array.isArray(names) || names.length === 0) {
    // Fail closed. An empty allowlist would be read by the server as "no
    // allowlist", which is the FULL surface -- a read-only label over an
    // unrestricted profile is worse than no configuration at all.
    throw new SetupRefusal(
      'SETUP_READ_ONLY_PROFILE_UNAVAILABLE',
      'A read-only assistant profile could not be worked out on this computer, so setup will not write one that only claims to be read-only.',
      {}
    );
  }
  return names;
}

/**
 * The tools the FULL assistant surface may carry at a recorded level.
 *
 * THIS IS THE GAP THIS FUNCTION EXISTS TO CLOSE. Before it, only the read-only
 * server was narrowed. A `standard` install therefore generated a
 * `toolsenabled` server with NO allowlist at all -- which
 * src/lib/tool-registry.js reads as the full 307-tool surface, including
 * `host.exec`. The level whose own words are "cannot reach the rest of the
 * computer" handed over a tool that runs any program on it.
 *
 * The surface is derived, not listed, from the same session
 * src/lib/permission-tier-policy.js enforces at call time, so what is written
 * into the configuration and what the server refuses cannot disagree.
 *
 * RETURNS null FOR THE LEVEL THAT GRANTS THE WHOLE MACHINE, and that is
 * deliberate rather than an oversight: writing a snapshot of every registered
 * name would be a list that silently goes stale the first time a tool is added,
 * and omitting the variable is exactly how the server already reads "no limit".
 * Unrestricted's contract (section 2.4) is that it decides nothing on the user's
 * behalf, so it gets no allowlist and no pretence of one.
 *
 * An unreadable or unrecognised level raises. It never degrades to null, because
 * null here means the whole machine.
 */
function tierToolAllowlist(tier) {
  const { registeredTools } = require('../tool-registry');
  const session = permissionTierPolicy.installTierSession(tier);
  if (session.tier === 'full') return null;
  const names = permissionTierPolicy.allowedToolNames(registeredTools(), session);
  if (!Array.isArray(names) || names.length === 0) {
    throw new SetupRefusal(
      'SETUP_TIER_PROFILE_UNAVAILABLE',
      `The set of tools allowed at the "${tier}" level could not be worked out on this computer, so setup will not write a configuration that only claims to be limited.`,
      { tier }
    );
  }
  return names;
}

/* IS THE RECORDED RUNTIME A PLAIN NODE, OR THIS PRODUCT'S OWN BINARY?
 *
 * MEASURED 2026-08-18 ON A STAGED PACKAGED BUILD, not deduced. The generated
 * document names `record.nodePath` as `command`, and on every packaged install
 * that value is the app's own Electron executable -- resolveNodePath() answers
 * `process.execPath`, and the process that runs setup is the app. Electron does
 * NOT execute a script argument as Node unless ELECTRON_RUN_AS_NODE is set, so
 *
 *     "<install>\ToolsEnabled.exe" "<engine>\src\mcp-server.js"
 *
 * does not start an MCP server at all: it starts THE WHOLE APPLICATION, a second
 * time, and that instance never speaks a byte of stdio JSON-RPC. Both halves
 * measured on the same staged build, same command, same cwd, same env:
 *
 *   without ELECTRON_RUN_AS_NODE -> initialize: no answer; tools advertised: 0;
 *                                   5 new top-level windows owned by the child
 *                                   (Chrome_WidgetWin_0, and a #32770 dialog)
 *   with    ELECTRON_RUN_AS_NODE -> initialize: answered; tools advertised: the
 *                                   allowlist exactly; 0 new windows
 *
 * So the user's report -- "every time I launch an agent a second ToolsEnabled
 * pops up that looks outdated" -- and "an app-started agent session has none of
 * this product's own tools" are ONE defect, and the window was the visible half.
 *
 * WHY THE CHECK IS "IS IT NODE" RATHER THAN "IS IT ELECTRON". The set of names
 * this product's own binary can have is open -- it has been renamed once already
 * and an installer can be told to call it anything -- while the set of names a
 * plain Node interpreter has is closed and stable. Asking the closed question
 * fails in the safe direction: an unrecognised runtime is treated as ours and
 * gets the variable, which a real Node ignores anyway (it is an Electron-only
 * variable and node(1) has never read it). The opposite phrasing would leave a
 * renamed binary silently booting the GUI again.
 */
function runtimeNeedsNodeMode(nodePath) {
  if (typeof nodePath !== 'string' || nodePath.length === 0) return false;
  const leaf = path.basename(nodePath).toLowerCase().replace(/\.exe$/, '');
  return leaf !== 'node';
}

/* The names this generator may write as a calling principal.
 *
 * Frozen beside the generator rather than imported, because this list is what
 * this file is allowed to WRITE; the server's own list is what it is willing to
 * READ, and a generator that could write an unsupported name would be one that
 * produces documents whose actor-bound tools refuse at runtime -- in a
 * grandchild process nobody is watching.
 *
 * Local inference starts its generated tool servers through the shared local
 * runtime, so it needs its own actor stamp as well. This list must remain a
 * SUBSET of AGENT_ACTORS in src/owner-host.js. The old heading equated these
 * names with what the server accepts; that was not true
 * on 2026-09-11, when "grok" was writable here and unreadable there and every
 * Grok start refused. tests/owner-host-agent-actors.test.js now asserts the
 * containment in that direction instead of leaving it to a comment. */
const AGENT_ACTORS = Object.freeze(['codex', 'claude', 'gemini', 'grok', 'local']);
const DECLARED_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AGENT_SESSION_CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;

/**
 * Generate the `.mcp.json` document from a record.
 *
 * The acceptance property from T6, enforced here rather than hoped for: the
 * generated document contains no path that does not exist. A server whose script
 * is missing from this installation is OMITTED and reported in `skipped`, because
 * a client that fails to launch a server it was told about looks broken to the
 * user, while a client that was never told about it simply does less.
 *
 * TWO THINGS ARE STAMPED ON `entry.env` HERE AND NOWHERE ELSE, and they are one
 * rule rather than two accidents: an MCP server is a GRANDCHILD, spawned by the
 * agent CLI out of this document, not by us. Nothing we put in our own
 * environment reaches it. So every fact that process needs to be given -- which
 * tools it may advertise (TOOLSENABLED_TOOL_ALLOWLIST), that it must run as Node
 * rather than as this application (ELECTRON_RUN_AS_NODE), and who is calling it
 * (TOOLSENABLED_AGENT_ACTOR) -- has to be written into the document itself.
 * -- and WHERE IT KEEPS WHAT IT WRITES (TOOLSENABLED_STATE_ROOT) -- has to be
 * written into the document itself. `agentActor` and `stateRoot` both default to
 * null, which stamps nothing, so the install-time document is byte-identical to
 * the one this function has always produced.
 */
function generateMcpConfig(record, {
  exists = fs.existsSync,
  readOnlyTools = readOnlyToolAllowlist,
  tierTools = tierToolAllowlist,
  agentActor = null,
  agentId = null,
  anonymousAgentTransport = false,
  sessionCredential = null,
  agentApiMode,
  stateRoot = null,
  // Injectable so a test can assert both arms of the probe without spawning a
  // runtime. See RUNTIME_GUARD_FLAGS above for what is being probed and why.
  runtimeProbe = childProcess.spawnSync,
  /* WHETHER THIS DOCUMENT'S OWNER GETS A BROWSER.
   *
   * `true` is the default because that is what every existing caller has always
   * been written as: an installed machine's `.mcp.json` still carries the
   * browser server and nothing about setup changes. The option exists for the
   * OTHER caller -- prepareClaudeToolSurface(), which generates one document per
   * ASSISTANT and therefore starts a THIRD electron process for every assistant
   * on the computer, whether or not that assistant will ever open a page.
   *
   * MEASURED 2026-09-03 (REPORT-crash-20260903/evidence/C): the browser gateway
   * costs a whole process of its own on top of the two tool servers, and nine
   * assistants were running at once on this computer when it died. Omitting it
   * where it is not wanted is one entire process per assistant that is never
   * started -- not a process started smaller.
   */
  browserTools = true
} = {}) {
  /* Stated, not guessed. A caller that passes nothing keeps today's document;
   * a caller that passes something unreadable is told, rather than silently
   * getting the expensive answer. */
  if (typeof browserTools !== 'boolean') {
    throw new SetupRefusal(
      'SETUP_BROWSER_TOOLS_INVALID',
      'Whether this assistant gets browser tools has to be stated as true or false, so setup does not guess which way to spend this computer\'s memory.',
      { browserTools: typeof browserTools }
    );
  }
  /* AN ABSOLUTE PATH OR NOTHING. src/lib/runtime-state-root.js refuses a
   * relative TOOLSENABLED_STATE_ROOT when it READS it, so generating one would
   * produce a server that dies at startup inside a grandchild process nobody is
   * watching -- the same invisible failure this whole file is written against.
   * Refused here, where there is still somebody to tell. */
  if (stateRoot !== null && (typeof stateRoot !== 'string' || stateRoot.length === 0 || !path.isAbsolute(stateRoot))) {
    throw new SetupRefusal(
      'SETUP_STATE_ROOT_INVALID',
      'The directory this installation keeps its own records in must be given as a full path, so setup will not write a configuration naming a partial one.',
      { stateRoot: typeof stateRoot === 'string' ? stateRoot.slice(0, 200) : typeof stateRoot }
    );
  }
  /* Refused rather than dropped. A mis-spelled principal silently omitted would
   * produce a server whose actor-bound tools refuse at runtime with a message
   * nobody is watching for -- the exact failure shape this whole file is written
   * against. `null` alone means "not an agent session". */
  if (agentActor !== null && !AGENT_ACTORS.includes(agentActor)) {
    throw new SetupRefusal(
      'SETUP_AGENT_ACTOR_INVALID',
      `"${typeof agentActor === 'string' ? agentActor : typeof agentActor}" is not an assistant this installation can name as the caller, so no configuration can be generated for it.`,
      { agentActor: typeof agentActor === 'string' ? agentActor.slice(0, 60) : typeof agentActor, accepted: AGENT_ACTORS }
    );
  }
  /* Provider and declared identity are different facts. `agentActor` says
   * which assistant program is speaking; `agentId` says which exact enabled
   * organisation entry main bound at start. The latter is optional for legacy
   * and directions-only sessions, but when present it must already be a legal
   * declared id so no downstream consumer has to guess or normalize it. */
  if (agentId !== null && (typeof agentId !== 'string' || !DECLARED_AGENT_ID.test(agentId))) {
    throw new SetupRefusal(
      'SETUP_AGENT_ID_INVALID',
      'The generated agent tool transport must name one exact declared agent id or none.',
      { agentId: typeof agentId === 'string' ? agentId.slice(0, 64) : typeof agentId }
    );
  }
  /* SILENCE AND "ANONYMOUS" ARE DIFFERENT ANSWERS, and only one of them survives
   * being inherited. Stamping no id leaves the broker reading whatever
   * TOOLSENABLED_AGENT_ID its PARENT held -- and a lane child holds its own seat
   * id (agent-lane.js), which routes the broker into the owner-host proxy that
   * refuses without a session credential. Measured 2026-09-02: the broker exited
   * and the lane ran with zero ToolsEnabled tools while reporting healthy.
   *
   * So a caller that means "no identity, whatever the environment says" has to be
   * able to SAY it, and the empty string is how the transport spells that:
   * boundAgentId() already reads '' as absent, and the entry branch in
   * mcp-server.js agrees with it. This stays a separate, named intent rather than
   * a loosening of the check above, because "" is not a declared id and must
   * never start being accepted as one. */
  if (typeof anonymousAgentTransport !== 'boolean') {
    throw new SetupRefusal(
      'SETUP_AGENT_ID_INVALID',
      'Whether the generated agent tool transport is deliberately anonymous must be stated as true or false.',
      { anonymousAgentTransport: typeof anonymousAgentTransport }
    );
  }
  if (anonymousAgentTransport && agentId !== null) {
    throw new SetupRefusal(
      'SETUP_AGENT_ID_INVALID',
      'A generated agent tool transport cannot be anonymous and name a declared agent id at the same time.',
      { agentId: agentId.slice(0, 64) }
    );
  }
  let sessionCredentialBytes = null;
  if (typeof sessionCredential === 'string' && AGENT_SESSION_CREDENTIAL.test(sessionCredential)) {
    try { sessionCredentialBytes = Buffer.from(sessionCredential, 'base64url'); } catch { sessionCredentialBytes = null; }
  }
  const canonicalSessionCredential = sessionCredential === null
    || (sessionCredentialBytes?.length === 32
      && sessionCredentialBytes.toString('base64url') === sessionCredential);
  if (sessionCredentialBytes) sessionCredentialBytes.fill(0);
  if (!canonicalSessionCredential) {
    throw new SetupRefusal(
      'SETUP_AGENT_SESSION_CREDENTIAL_INVALID',
      'The generated agent tool transport must carry one canonical opaque session credential or none.',
      {}
    );
  }
  const validation = validateMachineRecord(record);
  if (!validation.ok) {
    throw new SetupRefusal('SETUP_MACHINE_RECORD_INVALID', validation.errors.join('; '), { errors: validation.errors });
  }
  if (!exists(record.nodePath)) {
    throw new SetupRefusal(
      'SETUP_NODE_NOT_FOUND',
      `The recorded runtime ${record.nodePath} is not on this computer, so no configuration can be generated from this record.`,
      { nodePath: record.nodePath }
    );
  }

  const mcpServers = {};
  const skipped = [];
  const modePolicy = require('../agent-api-mode');
  const selectedApiMode = agentApiMode === undefined
    ? require('../agent-api-policy').agentApiMode() : modePolicy.normalizeAgentApiMode(agentApiMode);
  if (!selectedApiMode) throw new SetupRefusal('AGENT_API_MODE_UNAVAILABLE', 'The captured agent tool mode is invalid.', {});
  const nativeToolsOnly = selectedApiMode === 'Disabled';
  // Probed ONCE for the whole document: three servers, one runtime, one answer.
  const guardFlags = runtimeGuardFlags(record.nodePath, { spawn: runtimeProbe });
  // The whole catalogue, not only the entries this level includes: an entry
  // that is malformed for one level is malformed for all of them, and finding
  // that out only at the level that happens to use it is finding out late.
  assertServerCatalogue(SERVER_CATALOGUE);
  for (const server of SERVER_CATALOGUE) {
    if (nativeToolsOnly) {
      skipped.push({ name: server.name, reason: 'ToolsEnabled tools are disabled by the user setting for assistant tool mode' });
      continue;
    }
    if (!server.tiers.includes(record.tier)) {
      skipped.push({ name: server.name, reason: `not part of the ${record.tier} tier` });
      continue;
    }
    /* NOT STARTED AT ALL, and it is recorded in `skipped` for the same reason
     * every other omission is: a server that is missing from the document
     * because somebody chose that is a different fact from one that is missing
     * because its file is gone, and the caller can tell them apart. */
    if (server.browser === true && browserTools !== true) {
      skipped.push({ name: server.name, reason: 'this assistant was started without browser tools' });
      continue;
    }
    const scriptPath = path.join(record.installRoot, server.script);
    if (!exists(scriptPath)) {
      skipped.push({ name: server.name, reason: `${scriptPath} is not present in this installation` });
      continue;
    }
    /* A server that declares a package pin gets it, and a pin that would fail the
     * gateway's own guard refuses generation instead of producing a document whose
     * server dies at spawn with a message nobody is watching for. */
    if (server.packageSpec !== undefined && !PLAYWRIGHT_PACKAGE_SPEC_RE.test(server.packageSpec)) {
      throw new SetupRefusal(
        'SETUP_MACHINE_RECORD_INVALID',
        `The ${server.name} server declares a package version its gateway would refuse, so no configuration can be generated from this record.`,
        { server: server.name, packageSpec: server.packageSpec }
      );
    }
    /* THE GUARD FLAGS GO BEFORE THE SCRIPT, and nothing else moves.
     *
     * MEASURED: under ELECTRON_RUN_AS_NODE the runtime consumes its own flags
     * and `process.argv[1]` is still the script, so playwright-gateway.js still
     * reads its pinned package spec from `process.argv[2]`. `guardFlags` is []
     * whenever the probe did not cleanly succeed, and then this line produces
     * exactly the array this function has always produced. */
    const entry = {
      command: record.nodePath,
      args: server.packageSpec === undefined
        ? [...guardFlags, scriptPath]
        : [...guardFlags, scriptPath, server.packageSpec],
      cwd: record.installRoot
    };
    /* FIRST, so the allowlist branches below merge onto it rather than replacing
     * it. On a checkout install (`command` is node) this adds nothing at all and
     * the document is byte-identical to the one this function has always
     * written; on a packaged install it is the difference between an MCP server
     * and a second copy of the application. */
    if (runtimeNeedsNodeMode(record.nodePath)) {
      entry.env = { ELECTRON_RUN_AS_NODE: '1' };
    }
    /* THE CEILING, ON EVERY ENTRY, INCLUDING THE CHECKOUT ONE. A node runtime
     * reads NODE_OPTIONS exactly as the ELECTRON_RUN_AS_NODE runtime does, so
     * there is no install shape where the servers this document starts are
     * unbounded. See the note above SERVER_CATALOGUE for the measurement. */
    entry.env = { ...(entry.env || {}), ...heapCapEnvironment(server.heapCapMB),
      TOOLSENABLED_AGENT_TOOL_MODE: modePolicy.TOOL_MODES[selectedApiMode] };
    // The level narrows every allowlisted server, INCLUDING the read-only one.
    // Guided generates that server and nothing else, so leaving it at the
    // generic read-only profile left Guided carrying `host.read_file` and
    // `repo.read_file` -- both local-read, both able to read any file on the
    // computer, under the level that says it cannot reach one. At Unrestricted
    // this narrows nothing (tierAllowed is null) and the read-only profile is
    // written exactly as before.
    const tierAllowed = server.allowlisted === true ? tierTools(record.tier) : null;
    const tierAllowedSet = tierAllowed === null ? null : new Set(tierAllowed);
    if (server.readOnly === true) {
      // The one environment variable the server actually reads
      // (src/lib/tool-registry.js TOOL_ALLOWLIST_ENV). Naming an invented
      // variable here would produce a server labelled read-only that advertised
      // everything.
      //
      // The emptiness check is HERE, at the point of use, and not only inside
      // the default supplier: an empty allowlist is read by the server as "no
      // allowlist", which is the FULL surface. Checking only where the list is
      // computed leaves the dangerous value reachable through any other
      // supplier -- which is how this was caught.
      const declared = readOnlyTools();
      const names = Array.isArray(declared) && tierAllowedSet !== null
        ? declared.filter(name => tierAllowedSet.has(name))
        : declared;
      if (!Array.isArray(names) || names.length === 0) {
        throw new SetupRefusal(
          'SETUP_READ_ONLY_PROFILE_EMPTY',
          'A read-only assistant profile worked out to nothing at all, which this program would read as no limit. Setup will not write it.',
          { server: server.name }
        );
      }
      entry.env = { ...(entry.env || {}), TOOLSENABLED_TOOL_ALLOWLIST: names.join(',') };
    } else if (server.allowlisted === true) {
      // The write-capable surface, narrowed by the recorded level. Same
      // variable, same emptiness check, and the same reason: an empty string is
      // read by the server as "no allowlist", which is the FULL surface.
      if (tierAllowed !== null) {
        if (!Array.isArray(tierAllowed) || tierAllowed.length === 0) {
          throw new SetupRefusal(
            'SETUP_TIER_PROFILE_EMPTY',
            `The set of tools allowed at the "${record.tier}" level worked out to nothing at all, which this program would read as no limit. Setup will not write it.`,
            { server: server.name, tier: record.tier }
          );
        }
        entry.env = { ...(entry.env || {}), TOOLSENABLED_TOOL_ALLOWLIST: tierAllowed.join(',') };
      }
    }
    /* Only the ToolsEnabled MCP entries consume the exact agent-session
     // identity.  In particular, do not hand the opaque authority bearer to
     // Playwright or any other catalogue child merely because it shares this
     * generated document. Provider identity is metadata for that authenticated
     * broker path, not ambient caller state for unrelated children. */
    const consumesAgentSessionIdentity = server.script === ALLOWLIST_READING_SCRIPT;
    if (consumesAgentSessionIdentity && agentActor !== null) {
      entry.env = { ...(entry.env || {}), TOOLSENABLED_AGENT_ACTOR: agentActor };
    }
    if (consumesAgentSessionIdentity && agentId !== null) {
      entry.env = { ...(entry.env || {}), TOOLSENABLED_AGENT_ID: agentId };
    }
    // See the note at the anonymousAgentTransport check: this OVERRIDES an
    // inherited id rather than merely declining to set one, which is the whole
    // difference between a broker that starts and one that exits on a handshake
    // it was never given the credential for.
    if (consumesAgentSessionIdentity && anonymousAgentTransport) {
      entry.env = { ...(entry.env || {}), TOOLSENABLED_AGENT_ID: '' };
    }
    if (consumesAgentSessionIdentity && sessionCredential !== null) {
      entry.env = { ...(entry.env || {}), TOOLSENABLED_AGENT_SESSION_CREDENTIAL: sessionCredential };
    }
    /* WHERE THIS SERVER KEEPS WHAT IT WRITES, and the reason it has to be said
     * here rather than inherited. The application sets TOOLSENABLED_STATE_ROOT
     * for the capability layer it starts itself. An MCP server is NOT that
     * child: it is spawned by the agent CLI out of this document, inherits
     * nothing from us, and falls back to the payload's per-user default -- a
     * DIFFERENT directory. MEASURED by a two-node drive: an agent registered in
     * the application's own directory file could not be found by a server
     * reading the other one, and the refusal was correct about what it could
     * see. Everything stateful an app-started session does -- memory writes,
     * task claims, audit records, calendar -- was landing somewhere the
     * application never reads. Every server, because two servers disagreeing
     * about where the records live is worse than either answer. */
    if (stateRoot !== null) {
      entry.env = { ...(entry.env || {}), TOOLSENABLED_STATE_ROOT: stateRoot };
    }
    const isolation = require('../provider-session-isolation');
    const isolatedContext = isolation.isolationContext();
    if (isolatedContext) {
      if (stateRoot !== null && path.resolve(stateRoot) !== isolatedContext.stateRoot) {
        throw new SetupRefusal('AGENT_PROVIDER_ISOLATION_PATH', 'Generated agent tools must use this isolated application state.', {});
      }
      entry.env = { ...(entry.env || {}), ...isolation.profileEnvironment(isolatedContext),
        TOOLSENABLED_STATE_ROOT: isolatedContext.stateRoot };
    }
    mcpServers[server.name] = entry;
  }

  return { document: { mcpServers }, skipped };
}

/**
 * Every absolute path a generated document names, so a caller can assert the
 * acceptance property directly instead of reimplementing the walk.
 */
function pathsNamedByMcpConfig(document) {
  const named = [];
  const servers = (document && document.mcpServers) || {};
  for (const entry of Object.values(servers)) {
    if (typeof entry.command === 'string') named.push(entry.command);
    if (Array.isArray(entry.args)) {
      for (const argument of entry.args) {
        if (typeof argument === 'string' && path.isAbsolute(argument)) named.push(argument);
      }
    }
    if (typeof entry.cwd === 'string') named.push(entry.cwd);
  }
  return named;
}

function writeMcpConfig(record, {
  targetDirectory,
  exists = fs.existsSync,
  readOnlyTools = readOnlyToolAllowlist,
  tierTools = tierToolAllowlist,
  agentActor = null,
  agentId = null,
  anonymousAgentTransport = false,
  sessionCredential = null,
  stateRoot = null
} = {}) {
  const { document, skipped } = generateMcpConfig(record, { exists, readOnlyTools, tierTools, agentActor, agentId, anonymousAgentTransport, sessionCredential, stateRoot });
  const file = path.join(targetDirectory, '.mcp.json');
  writeJsonAtomic(file, document);
  return { file, document, skipped };
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  TIERS,
  SHELL_PORT_RANGE,
  BRIDGE_PORT_RANGE,
  LOOPBACK_HOST,
  SERVER_CATALOGUE,
  AGENT_ACTORS,
  SetupRefusal,
  runtimeNeedsNodeMode,
  RUNTIME_GUARD_FLAGS,
  runtimeGuardFlags,
  resetRuntimeGuardProbeForTests,
  resolveServicesRoot,
  machineRecordPath,
  resolveNodePath,
  defaultMachineId,
  defaultMachineLabel,
  buildMachineRecord,
  validateMachineRecord,
  readMachineRecord,
  writeMachineRecord,
  machineRecordKeyPath,
  sealMachineRecord,
  verifyMachineRecordIntegrity,
  generateMcpConfig,
  assertServerCatalogue,
  readOnlyToolAllowlist,
  tierToolAllowlist,
  pathsNamedByMcpConfig,
  writeMcpConfig,
  writeJsonAtomic
});
