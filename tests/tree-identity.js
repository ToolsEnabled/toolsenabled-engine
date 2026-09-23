// EXECUTABLE CHANGE
//
// TEST-CAN-FAIL REPORT (testcanfail-tests-tree-identity-js)
// Strengthened assertions:
// - agent-preflight delegation: replacing the direct import with an
//   output-equivalent forwarding function left the former deepStrictEqual green.
//   The direct-import assertion now goes RED with:
//   "AssertionError [ERR_ASSERTION]: agent-preflight.js must import treeIdentity
//   directly from the shared module".
// - onboarding delegation: replacing its direct import with the same kind of
//   output-equivalent forwarding function left the former deepStrictEqual green.
//   The direct-import assertion now goes RED with:
//   "AssertionError [ERR_ASSERTION]: agent-onboarding.js must import treeIdentity
//   directly from the shared module".
// Both mutated product files were restored byte-for-byte. With the restored
// files, the test through both delegation checks was GREEN: "STATUS=0".
//
// Census of the requested suspect shapes:
// - EMPTY-ITERATION: NOT-FOUND. The timing loop has no assertion body, and the
//   `.some()` result is itself asserted, so an empty collection fails it.
// - EXIT-STATUS-ONLY: NOT-FOUND. Successful subprocess output is parsed and
//   checked; no non-zero status is treated as proof.
// - SWALLOWED-FAILURE: NOT-FOUND. The only try/finally closes a descriptor and
//   does not catch an assertion or subject failure; there is no optional chain.
// - SUBJECT-MOCK: NOT-FOUND. Fixtures supply registry input, not a replacement
//   for treeIdentity or either caller.
// - SKIP/PRECONDITION-GUARD: NOT-FOUND. No test is skipped or guarded.
// - SAME-CODE-EXPECTED: FOUND in the two delegation checks and fixed above.
//   Their expected values came from treeIdentity(), the same implementation an
//   output-equivalent fork could call, so output equality did not prove direct
//   delegation.
//
// Unmet precondition: the complete file is not green in this checkout because
// config/service-registry.json has no machine declaring /workspace/engine. The
// existing canonical-hook assertion reports:
// "AssertionError [ERR_ASSERTION]: the tree line must be in the packet's first
// block, which the byte cap can never drop" (actual: TREE NOT-A-DECLARED-ROOT).
// That existing assertion was neither deleted nor weakened.

'use strict';

// Pins src/lib/tree-identity.js and BOTH of its callers:
//   tools/agent-preflight.js      -- runs only when a session remembers to run it
//   src/lib/agent-onboarding.js   -- runs automatically on every SessionStart
//
// WHY THIS EXISTS. On 2026-08-10 a full status report was produced against the
// RETIRED tree (C:\Users\owner\Desktop\ToolsEnabled, 353 test files, last commit
// 2026-08-08) while the canonical tree had 748 and was being committed to that
// same day. Every conclusion in it was stale on arrival, and the author had no
// mechanical way to know -- that checkout told them three different things at
// once. The owner's rule: "agents shouldnt have to manage things like this
// inside toolsenabled, it should be mechanical, remembering causes issues and
// should only be implemented where its the only realistic solution."
//
// So the guarantee under test is not "the function returns the right string".
// It is that A SESSION IS TOLD WHICH TREE IT IS IN WITHOUT ASKING, and that the
// answer is loud when it cannot be determined. The most important checks here
// are the ones that drive tools/agent-onboarding.js --hook end to end, because
// that is the only path the harness actually invokes by itself.
//
// Fixtures for the state transitions, live repo only for the two
// delegation/no-fork checks -- same convention as
// tests/open-gates-freshness-check.js and tests/agent-preflight.js.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { NON_CANONICAL_GUIDANCE, treeIdentity, treeIdentityHeadline } = require(path.join(ROOT, 'src', 'lib', 'tree-identity'));
const onboarding = require(path.join(ROOT, 'src', 'lib', 'agent-onboarding'));
const ONBOARDING_CLI = path.join(ROOT, 'tools', 'agent-onboarding.js');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-identity-test-'));
let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

function makeRoot(name, registry) {
  const root = path.join(workDir, name);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  // registry === null reproduces the retired tree exactly: a config/ directory
  // that exists, with no service-registry.json inside it.
  if (registry !== null) {
    fs.writeFileSync(path.join(root, 'config', 'service-registry.json'),
      typeof registry === 'string' ? registry : JSON.stringify(registry), 'utf8');
  }
  return root;
}

// The checked-in registry is a safe installation default, not a declaration
// for every checkout that runs this suite. Canonical-path assertions therefore
// use an owned registry fixture rather than ambient machine topology.
const canonicalRoot = makeRoot('canonical-runtime', { machines: {} });
fs.writeFileSync(path.join(canonicalRoot, 'config', 'service-registry.json'), JSON.stringify({
  machines: { 'fixture-machine': { root: canonicalRoot } }
}), 'utf8');

function runHook(event, environment = {}) {
  const eventFile = path.join(workDir, `event-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(eventFile, JSON.stringify(event), 'utf8');
  const stdin = fs.openSync(eventFile, 'r');
  try {
    const out = execFileSync(process.execPath, [ONBOARDING_CLI, '--hook', '--provider', 'claude', '--scope', 'full'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000,
      stdio: [stdin, 'pipe', 'pipe'],
      env: { ...process.env, ...environment }
    });
    return JSON.parse(out).hookSpecificOutput.additionalContext;
  } finally { fs.closeSync(stdin); }
}

// THE HOOK'S additionalContext IS A CONCATENATION, AND THE PACKET IS ONE SECTION
// OF IT. The two checks below used to read context.split('\n\n')[0] and require
// the tree line there, on the stated grounds that the FIRST BLOCK is the one the
// byte cap can never drop. Two later features now stand ahead of the packet in
// that string, and each one on its own moved the tree line out of block 0:
//
//   2026-08-11  R1232 status injection prepends a [TOOLSENABLED STATUS v1] block
//               (tools/agent-onboarding.js -> src/lib/status-injection.js).
//   2026-08-12  the launch recorder prepends one LAUNCH RECORDED / LAUNCH NOT
//               RECORDED line, so the ledger's answer is the first thing read.
//
// Neither is produced by onboarding.renderPacket(), so neither is subject to the
// byte cap the original wording was about -- block 0 had stopped being the thing
// the comment said it was. (Measured 2026-08-13, SessionStart, scope full: 634
// bytes stand ahead of the packet and the tree headline begins at byte 851 of
// 19275. The FEATURES YOU HAVE line added the same day is inside the packet
// body, far BELOW the tree line, and is not involved.)
//
// So the property is pinned in two halves that cannot both drift, instead of one
// index that any future preamble breaks:
//   1. the tree line is in the first block OF THE PACKET -- still exactly the
//      block applyByteBudget can never drop, which is the guarantee meant; and
//   2. the packet's preamble is bounded, so nothing can quietly bury the answer
//      under a section that grows.
// The two renderPacket() checks further down keep asserting block 0 directly,
// because for the rendered packet block 0 IS the packet.
const MAX_PREAMBLE_BYTES = 2 * 1024;

function packetOpening(context) {
  const blocks = context.split('\n\n');
  const index = blocks.findIndex(block => block.startsWith(onboarding.PACKET_BEGIN));
  assert.ok(index >= 0, 'the hook must deliver the onboarding packet itself, not only a preamble about it');
  const preamble = Buffer.byteLength(blocks.slice(0, index).join('\n\n'), 'utf8');
  assert.ok(preamble <= MAX_PREAMBLE_BYTES,
    `${preamble} bytes now stand ahead of the onboarding packet (cap ${MAX_PREAMBLE_BYTES}); the tree answer must stay at the top of what a session reads, not below a preamble that grew`);
  return blocks[index];
}

// --- CANONICAL: the root is declared in its own registry ------------------
check('CANONICAL names the machine whose declared root this is', () => {
  const root = makeRoot('declared', { machines: { 'machine-a': { root: null } } });
  fs.writeFileSync(path.join(root, 'config', 'service-registry.json'),
    JSON.stringify({ machines: { 'machine-a': { root }, 'machine-b': { root: path.join(workDir, 'elsewhere') } } }), 'utf8');
  const identity = treeIdentity({ root });
  assert.strictEqual(identity.state, 'CANONICAL');
  assert.strictEqual(identity.machineId, 'machine-a');
  assert.match(identity.message, /declared root for machine-a/);
  assert.match(treeIdentityHeadline(identity), /^TREE ✓ /);
});

// --- NOT-A-DECLARED-ROOT: a real checkout nobody declared -----------------
check('NOT-A-DECLARED-ROOT lists the declared roots so the session can move', () => {
  const declared = path.join(workDir, 'somewhere-declared');
  const root = makeRoot('undeclared', { machines: { 'machine-a': { root: declared } } });
  const identity = treeIdentity({ root });
  assert.strictEqual(identity.state, 'NOT-A-DECLARED-ROOT');
  assert.strictEqual(identity.machineId, undefined);
  assert.match(identity.message, /not the declared root of any machine/);
  assert.ok(identity.message.includes(declared), 'the honest answer must name where the session should be instead');
  assert.match(treeIdentityHeadline(identity), /^⚠ TREE NOT-A-DECLARED-ROOT: /);
});

// --- UNKNOWN: THE RETIRED TREE'S EXACT SHAPE ------------------------------
// config/ exists, service-registry.json does not. Failing OPEN here would be
// the worst possible answer: a missing authority is precisely when a session is
// most likely to be somewhere unexpected.
check('UNKNOWN, loudly, when the registry cannot be read at all', () => {
  const root = makeRoot('no-registry', null);
  const identity = treeIdentity({ root });
  assert.strictEqual(identity.state, 'UNKNOWN');
  assert.deepStrictEqual(identity.declared, []);
  assert.match(identity.message, /cannot tell you which tree you are in/);
  assert.match(identity.message, /ENOENT/);
  assert.match(treeIdentityHeadline(identity), /^⚠ TREE UNKNOWN: /);
});

check('UNKNOWN, not a crash and not a silent pass, on a corrupt registry', () => {
  const root = makeRoot('corrupt-registry', '{ not json');
  assert.strictEqual(treeIdentity({ root }).state, 'UNKNOWN');
});

check('an empty machines map cannot establish membership and says so', () => {
  const root = makeRoot('no-machines', { machines: {} });
  const identity = treeIdentity({ root });
  assert.strictEqual(identity.state, 'UNKNOWN');
  assert.match(identity.message, /no machine declares a checkout root/);
});

check('a trailing separator or different case is the same tree, not a new one', () => {
  const root = makeRoot('normalized', { machines: {} });
  fs.writeFileSync(path.join(root, 'config', 'service-registry.json'),
    JSON.stringify({ machines: { 'machine-a': { root: `${root.toUpperCase()}${path.sep}` } } }), 'utf8');
  assert.strictEqual(treeIdentity({ root }).state, 'CANONICAL',
    'path spelling must not be able to turn the canonical tree into an undeclared one');
});

// --- NO SECOND IMPLEMENTATION --------------------------------------------
// The whole reason this module exists. A forked copy in either caller would
// drift silently and recreate the original defect one level down.
check('tools/agent-preflight.js delegates to this module rather than a forked copy', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'agent-preflight.js'), 'utf8');
  assert.match(source,
    /const \{ treeIdentity, NON_CANONICAL_GUIDANCE \} = require\('\.\.\/src\/lib\/tree-identity'\);/,
    'agent-preflight.js must import treeIdentity directly from the shared module');
  assert.match(source, /treeIdentity: treeIdentity\(\{ root: REPO \}\)/,
    'agent-preflight.js must obtain the reported identity by calling the shared treeIdentity function');
  const report = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools', 'agent-preflight.js'), '--json'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000
  }));
  assert.deepStrictEqual(report.treeIdentity, JSON.parse(JSON.stringify(treeIdentity({ root: ROOT }))),
    'agent-preflight.js must delegate to treeIdentity(), not a divergent copy');
});

check('the onboarding packet delegates to this module rather than a forked copy', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'agent-onboarding.js'), 'utf8');
  assert.match(source,
    /const \{ NON_CANONICAL_GUIDANCE, normalizeRoot, treeIdentity, treeIdentityHeadline \} = require\('\.\/tree-identity'\);/,
    'agent-onboarding.js must import treeIdentity directly from the shared module');
  assert.match(source, /const runtime = treeIdentity\(\{ root: runtimeRoot, fsImpl \}\);/,
    'agent-onboarding.js must obtain the runtime identity by calling the shared treeIdentity function');
  const packet = onboarding.buildPacket({
    scope: 'minimal', profile: 'agent', runtimeRoot: canonicalRoot, projectRoot: canonicalRoot
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(packet.treeIdentity.runtime)),
    JSON.parse(JSON.stringify(treeIdentity({ root: canonicalRoot }))));
});

// --- THE AUTOMATIC PATH, PROVEN BOTH WAYS --------------------------------
// tools/agent-onboarding.js --hook is what the SessionStart hook invokes. If
// the tree line is not in THIS output, the check is decoration.
check('a SessionStart hook in the canonical tree is TOLD the tree, unprompted', () => {
  const context = runHook(
    { hook_event_name: 'SessionStart', cwd: canonicalRoot, source: 'startup' },
    { TOOLSENABLED_RUNTIME_ROOT: canonicalRoot }
  );
  const firstBlock = packetOpening(context);
  assert.match(firstBlock, /^TREE ✓ /m, 'the tree line must be in the packet\'s first block, which the byte cap can never drop');
  assert.ok(firstBlock.includes(canonicalRoot), 'the packet must name the checkout by absolute path');
  assert.match(firstBlock, /declared root for fixture-machine/);
});

check('a SessionStart hook in an UNDECLARED root says so loudly, and still starts', () => {
  const undeclared = makeRoot('hook-undeclared', null);
  const context = runHook(
    { hook_event_name: 'SessionStart', cwd: undeclared, source: 'startup' },
    { TOOLSENABLED_RUNTIME_ROOT: undeclared }
  );
  const firstBlock = packetOpening(context);
  assert.match(firstBlock, /^⚠ TREE UNKNOWN: /m,
    'an unreadable registry must produce a loud warning in the packet\'s first block, never silence');
  assert.ok(firstBlock.includes(undeclared));
  assert.ok(firstBlock.includes(NON_CANONICAL_GUIDANCE), 'a non-canonical answer must say what to do about it');
});

// --- DIVERGENT ROOTS ------------------------------------------------------
// The realistic incident: the packet is assembled from the canonical tree while
// the session's edits land somewhere else entirely.
check('a project root that differs from the runtime root is reported, not hidden', () => {
  const elsewhere = makeRoot('working-elsewhere', null);
  const packet = onboarding.buildPacket({
    scope: 'minimal', profile: 'agent', runtimeRoot: canonicalRoot, projectRoot: elsewhere
  });
  assert.strictEqual(packet.treeIdentity.divergentRoots, true);
  assert.ok(packet.mismatches.some(entry => entry.code === 'project-root-differs-from-runtime-root'),
    'a session editing a different tree than the packet describes is a mismatch, not a detail');
  const rendered = onboarding.renderPacket(packet);
  assert.match(rendered.split('\n\n')[0], /⚠ TREE DIVERGENCE:/);
  assert.ok(rendered.includes(elsewhere));
});

check('the tree line survives the smallest byte budget there is', () => {
  const rendered = onboarding.renderPacket(
    onboarding.buildPacket({
      scope: 'minimal', profile: 'agent', runtimeRoot: canonicalRoot, projectRoot: canonicalRoot
    })
  );
  assert.ok(Buffer.byteLength(rendered, 'utf8') <= onboarding.MAX_RENDERED_BYTES.minimal);
  assert.match(rendered.split('\n\n')[0], /^TREE ✓ /m,
    'the byte cap must never be able to omit which tree this is');
});

// --- BUDGET ---------------------------------------------------------------
// A SessionStart hook has roughly five seconds for EVERYTHING. This check is
// one small synchronous JSON read; if it ever grows a spawn, a network call, or
// a directory walk, this goes red before it reaches a session.
check('resolving tree identity stays far inside the SessionStart hook budget', () => {
  const root = makeRoot('budget', { machines: {} });
  const started = process.hrtime.bigint();
  for (let index = 0; index < 50; index += 1) treeIdentity({ root });
  const millis = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(millis < 500, `50 resolutions took ${millis.toFixed(1)}ms; this must stay cheap enough for a hook`);
});

fs.rmSync(workDir, { recursive: true, force: true });

assert.ok(checks >= 12, `expected at least 12 checks to run, ran ${checks}`);
console.log(`tree-identity: ${checks} checks passed`);
