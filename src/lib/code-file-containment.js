'use strict';

// Shared by the two providers that read arbitrary agent-supplied file paths
// off disk WITHOUT the breadth src/lib/providers/host-control.js#resolveHostPath
// deliberately grants host.read_file (the whole owner profile tree):
// src/lib/providers/code-intel.js#resolveFilePath and search.index's file
// reader (src/lib/search.js#indexPath).
//
// MEASURED (memory key code-intel-abs-path-escape-20260906): at engine commit
// b7149aeb, resolveFilePath ran `path.resolve(rootPath(), value)` then
// `fs.statSync(resolved)` with zero containment checks and zero audit calls,
// so an absolute `file` argument read any file the process could open.
// search.js#indexPath had the identical shape for its `root` argument --
// already named as an unpatched bypass in this codebase's own
// src/lib/workspace-boundary.js header ("search.index root -> a secrets dir
// outside it READ+INDEXED").
//
// This mirrors host.read_file's containment policy
// (src/lib/providers/host-control.js#resolveHostPath: resolve, then check
// containment, then canonicalize with fs.realpathSync and check the
// canonical form too, so a reparse point or 8.3 short name in the ancestor
// chain cannot walk the check around the fence) but with a NARROWER allowed
// zone than host.read_file's owner-profile breadth: the ToolsEnabled root
// itself, plus whatever folders setup recorded as `workspaceRoots` in
// machine.json (src/lib/setup/machine-record.js), reached through
// src/lib/tool-registry.js#confinedWorkspaceRoots -- the exact list
// agent.spawn's `workspaceRoot` parameter reads ("defaults to the first
// verified workspace root in the machine record"), and a real, already-used
// consumer of machine-record.js's `workspaceRoots` (src/lib/tool-registry.js
// lines ~268, ~409, ~3720). src/lib/settings.js also republishes the same
// field under CAPABILITY_WORKSPACE_ROOTS_ID (capabilityBoundaryReadback), but
// a grep of src/ for that id and that function name turns up NO caller other
// than settings.js's own loadSettings() -- the settings.read UI backend, not
// a dispatch-path reader -- so it is not, in fact, "the way the rest of the
// engine" reads these roots for an enforcement decision; confinedWorkspaceRoots
// is. Both ultimately read the identical `workspaceRoots` field out of the
// same machine-record.js, so this is a choice of wrapper, not of data source.
// Either way, this is reuse of an existing reader, not a second hand-rolled
// parse of machine-record.js.
// Both language-server code intelligence and the embedding index run
// untrusted-derived tooling (a spawned language server; an embedder) against
// file content, and are meant to inspect the user's own recorded project(s)
// -- not anything the process account happens to be able to read.
const os = require('node:os');
const { rootPath } = require('./runtime');
const workspaceBoundary = require('./workspace-boundary');
const audit = require('./audit');
const auditAdmission = require('./operation-audit');

// A recorded workspace root that no longer exists, or a machine record that
// cannot be parsed, must narrow this to "no extra grant" -- never to "every
// grant", and never to "code intelligence stops working inside the
// ToolsEnabled root because one unrelated recorded folder went stale". That is
// why each recorded root is resolved INDIVIDUALLY below rather than handed to
// workspaceBoundary.resolveRoots() as one list, which fails the whole list
// closed on the first bad entry -- correct for its one existing caller
// (src/lib/confined-tool-surface.js), which gates a single permission tier
// that has nothing to fall back to, but too broad a blast radius for a check
// that runs unconditionally, at every tier, on every file-reading call here.
function recordedWorkspaceRoots() {
  try {
    // Deferred require: src/lib/tool-registry.js lazily requires every
    // provider (including this file's own callers) through its own
    // `deferred()` helper and never invokes one at its own module-load time,
    // so requiring it here does not create a load-time cycle -- verified by
    // loading both orders (code-intel first, tool-registry first) directly.
    // eslint-disable-next-line global-require
    const { confinedWorkspaceRoots } = require('./tool-registry');
    const roots = confinedWorkspaceRoots();
    return Array.isArray(roots) ? roots.filter(entry => typeof entry === 'string') : [];
  } catch {
    // An unreadable grant list grants nothing extra.
    return [];
  }
}

function computeNarrowZoneRoots() {
  // rootPath() with no parts is the ToolsEnabled program root; it exists for
  // as long as this process is running, so this can never legitimately throw
  // WORKSPACE_ROOTS_ABSENT/UNREADABLE.
  const roots = [...workspaceBoundary.resolveRoots([rootPath()], { label: 'the ToolsEnabled root' })];
  for (const candidate of recordedWorkspaceRoots()) {
    try { roots.push(...workspaceBoundary.resolveRoots([candidate], { label: 'a recorded workspace root' })); }
    catch { /* stale or unreadable: narrows nothing, refused below by omission */ }
  }
  return roots;
}

// host.read_file's OWN zone (src/lib/providers/host-control.js: `const HOME =
// os.homedir();`, and resolveHostPath's containment is "inside HOME" and
// nothing narrower). Not the active default here -- see ACTIVE_ZONE below --
// but a real, already-shipped, already-audited alternative an owner running
// at the Unrestricted tier may prefer for code.*/search.index too, since
// that tier already grants host.read_file this exact breadth. Kept as its
// own function, not inlined, so the "one line" swap in ACTIVE_ZONE has
// something concrete to point at.
function computeBroadZoneRoots() {
  return [...workspaceBoundary.resolveRoots([os.homedir()], { label: 'the owner profile tree' })];
}

// THE ALLOWED ZONE IS AN OWNER DECISION, NOT AN IMPLEMENTATION DETAIL.
//
// This fix's contract asked for NARROW: the ToolsEnabled root plus recorded
// workspace roots. host.read_file's own BROAD zone (the whole owner profile
// tree) is the documented alternative for whoever accepts this lane to
// choose instead, without touching any call site in code-intel.js or
// search.js -- both already only ever call usableRoots() below, never
// computeNarrowZoneRoots()/computeBroadZoneRoots() directly.
//
// THIS IS THE ONE LINE: change 'narrow' to 'broad' to switch every caller of
// this module from the recorded-workspace-roots zone to host.read_file's
// whole-owner-profile zone. Nothing else in this file, code-intel.js, or
// search.js needs to change. The default is NOT changed by this comment --
// it stays 'narrow', matching the contract, until an owner decision says
// otherwise.
const ACTIVE_ZONE = 'narrow';

const ZONE_POLICIES = Object.freeze({
  narrow: computeNarrowZoneRoots,
  broad: computeBroadZoneRoots
});

function computeUsableRoots() {
  return ZONE_POLICIES[ACTIVE_ZONE]();
}

// Workspace grants are read through the registry's existing public reader on
// each decision. This avoids another setup-layer dependency and observes a
// changed grant even when a writer preserves the machine file timestamp.
function usableRoots() {
  return computeUsableRoots();
}

/**
 * Is `candidate` inside the ToolsEnabled root or a recorded workspace root,
 * checked against both its resolved and its realpath (symlink/junction/8.3
 * short-name-resolved, case-insensitive on Windows) form? Never throws -- a
 * malformed or unresolvable candidate answers false, which is the
 * fail-closed direction for a read gate.
 *
 * Calls workspaceBoundary.assertInsideRoots(), the same containment helper
 * src/lib/confined-tool-surface.js#assertPathValueInsideRoots calls, rather
 * than a second, hand-written prefix check. That helper is currently wired
 * in only through src/lib/permission-tier-policy.js#assertConfinedArgumentsAllowed,
 * which runs for the confined tier alone -- which is exactly why an
 * unrestricted-tier call to code.* or search.index escaped it before this
 * fix, and this module is what makes the same helper apply unconditionally.
 */
function isInsideAllowedRoots(candidate, { label = 'path' } = {}) {
  try {
    workspaceBoundary.assertInsideRoots(candidate, usableRoots(), { label });
    return true;
  } catch {
    return false;
  }
}

// THE SUCCESS-PATH READ AUDIT IS ALSO AN OWNER DECISION, SAME PATTERN AS
// ACTIVE_ZONE ABOVE: one named mode, one line to flip, no call site changes.
//
// MEASURED (100 sequential in-root resolveFilePathForTests calls, pinned
// node, grouped/'fast' throughput mode): 'durable' costs a median ~130ms per
// call in steady state (max 578ms once warmed past the one-time
// admission-queue worker startup, ~2.8s on the very first call of a
// process) -- an order of magnitude above the 0.14ms cached containment
// check above, and paid on every successful code.hover/code.document_symbols/
// etc. call, not once per session. See the owner-decision table in this
// lane's report for the full comparison including 'record' and 'none'.
//
//   'durable' (DEFAULT, unchanged): auditAdmission.requireRecordAsync --
//     admission must be durable and anchored before the read returns,
//     exactly mirroring host.read_file's own host-control.js#readFile.
//     Fails closed: an unavailable or unanchored ledger throws
//     AuditRequiredError (code AUDIT_UNAVAILABLE, or AUDIT_DISABLED if audit
//     is turned off), not a CodeIntelError, propagated raw -- every code.*
//     call stops cold until the ledger is repaired. host.read_file accepts
//     this identical tradeoff already; this is not a new defect.
//   'record': audit.record of the same action/target/details -- the same
//     durable ledger still receives the entry (this is not a step down to
//     the dispatch-layer's own tool-name-only mcp.tool.* record), but
//     nothing here waits for durability or anchoring, and nothing here
//     throws if the ledger is unavailable: the read succeeds regardless.
//   'none': no provider-level read audit call at all. The dispatch-layer
//     mcp.tool.succeeded/mcp.tool.failed record (src/lib/tool-registry.js
//     #auditInvocation) still lands either way, for every mode, since it is
//     written at the tool-call chokepoint, above and independent of
//     anything in this module.
const READ_AUDIT_MODES = Object.freeze(['durable', 'record', 'none']);
let readAuditMode = 'durable';

function setReadAuditModeForTests(mode) {
  const next = mode === null || mode === undefined ? 'durable' : mode;
  if (!READ_AUDIT_MODES.includes(next)) {
    throw new Error(`"${next}" is not a read audit mode this module declares (${READ_AUDIT_MODES.join(', ')}).`);
  }
  readAuditMode = next;
}

function readAuditModeForTests() {
  return readAuditMode;
}

// The one choke point every successful, in-bounds resolveFilePath (and any
// future caller) routes its success-path audit through. `auditAdmission` is
// accessed as a property on every call, never destructured at load time, so
// a test that reassigns auditAdmission.requireRecordAsync still reaches this
// function's own call to it.
async function auditSuccessfulRead(action, target, details) {
  if (readAuditMode === 'none') return;
  if (readAuditMode === 'record') {
    auditAdmission.record(action, target, details);
    return;
  }
  await auditAdmission.requireRecordAsync(action, target, details);
}

module.exports = {
  isInsideAllowedRoots, usableRoots, recordedWorkspaceRoots,
  auditSuccessfulRead,
  // Test-only seams.
  setReadAuditModeForTests, readAuditModeForTests
};
