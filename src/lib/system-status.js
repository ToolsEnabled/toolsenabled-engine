'use strict';

const fs = require('node:fs');
const packageInfo = require('../../package.json');
const { ROOT, commandExists, listSecretKeys, rootPath } = require('./runtime');
const { killSwitchPath, loadPolicy, requiresApproval } = require('./policy');
const killSwitch = require('./kill-switch');

function killSwitchActive(policy = loadPolicy()) {
  return filePresence(killSwitchPath(policy));
}

/* WHO STOPPED IT, WHEN, AND WHETHER ANYONE IS NAMED.
 *
 * killSwitchActive above answers "is outward work stopped", and is left exactly
 * as it was so every existing reader keeps working. It cannot answer the
 * question an owner actually has when the tree goes quiet: an agent that
 * activated the switch and a hand that wrote the marker publish the identical
 * boolean.
 *
 * It never throws. A status surface that dies on an unreadable marker tells the
 * owner less than one that says plainly that it does not know -- and `active:
 * null` is that statement, distinct from `false`.
 */
function killSwitchState(policy = loadPolicy()) {
  let status;
  try {
    status = killSwitch.statusFor(killSwitchPath(policy));
  } catch (error) {
    return { active: null, attributed: false, agent: null, actor: null, session: null,
      role: null, activatedAt: null, error: (error && error.code) || 'KILLSWITCH_UNREADABLE' };
  }
  if (status.active !== true) {
    return { active: false, attributed: false, agent: null, actor: null, session: null,
      role: null, activatedAt: null };
  }
  const recorded = status.attribution || {};
  const known = recorded.recorded === true;
  return {
    active: true,
    // False means the marker carries no author: a bare file written by a script,
    // an editor or a hand. It is never filled in with a guess.
    attributed: known,
    agent: known ? recorded.agent : null,
    actor: known ? recorded.actor : null,
    session: known ? recorded.session : null,
    role: known ? recorded.role : null,
    activatedAt: recorded.activatedAt || null
  };
}

function filePresence(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    // Permission and I/O failures do not establish that a file is absent.
    return null;
  }
}

function transactionalState() {
  try {
    const { getStateStore } = require('./state-store');
    return getStateStore().health();
  } catch (error) {
    return {
      ok: false,
      path: rootPath('state', 'toolsenabled.sqlite3'),
      error: {
        code: typeof error.code === 'string' ? error.code : 'STATE_UNAVAILABLE',
        message: String(error.message || error).slice(0, 1000)
      }
    };
  }
}

function hostAuditKeyStore(audit) {
  if (process.env.TOOLSENABLED_RUNTIME_MODE !== 'host') return {};
  // The audit subsystem reports its cached selection. Status never provisions
  // a second store or reads signing material to answer this diagnostic.
  let keyStore;
  try { keyStore = audit?.keyStoreStatus(); } catch { /* Report unavailable below. */ }
  const kind = ['private-file', 'os-keyring', 'unselected', 'unavailable'].includes(keyStore?.kind)
    ? keyStore.kind : 'unavailable';
  return { keyStore: { kind, ...(kind === 'private-file' ? { sameUserReadable: true, boundary: false } : {}) } };
}

function auditState() {
  let audit;
  try {
    audit = require('./audit');
    let current = audit.status();
    // This is a health READ on a timer, not the `audit.verify` tool. Taking the
    // cached verification keeps the answer identical while nothing has changed
    // and costs 2 ms instead of a 1.6 s signature walk of the whole ledger --
    // per poll, on the same single-writer ledger every tool call needs. See
    // audit.js verify()'s `cached` comment for why this decides nothing.
    let verification = audit.verify({ cached: true });
    // A tool-success event can be appended after status() observes the
    // canonical head but before the projection sinks catch up. That is a
    // transient projection race, not evidence of tampering. Reconcile once
    // through the canonical audit flusher, then verify the same fresh head;
    // persistent invalidity still remains fail-closed.
    //
    // The retry deliberately drops the cache: once something has reported
    // invalid, the cheap answer is no longer the one worth having, and a full
    // walk here is paid at most once per poll that already looks wrong.
    if (!verification.valid && ['projection-divergence', 'projection-malformed', 'emergency-backlog'].includes(verification.reason)) {
      try {
        audit.flush({ force: true });
        current = audit.status();
        verification = audit.verify();
      } catch { /* Preserve the original invalid evidence below. */ }
    }
    // How much the verifying itself cost this process, so a regression that
    // makes every call walk the whole ledger again is visible here rather than
    // only in a CPU profile. Counts only; never any ledger material.
    let verificationStats = null;
    try { verificationStats = audit.verificationStats(); } catch { /* counters are advisory */ }
    return { ...current, verification, verificationStats, ...hostAuditKeyStore(audit) };
  } catch (error) {
    return {
      ok: false,
      path: rootPath('state', 'audit.sqlite3'),
      ...hostAuditKeyStore(audit),
      error: {
        code: typeof error.code === 'string' ? error.code : 'AUDIT_UNAVAILABLE',
        message: String(error.message || error).slice(0, 1000)
      }
    };
  }
}

function mcpToolSurfaceStatus() {
  try {
    // Deliberately lazy: tool-registry imports this module to register
    // system.status/system.doctor, while the status read needs the current
    // advertised surface rather than a guessed source-file tool count.
    const { listTools } = require('./tool-registry');
    return require('./mcp-tool-surface').status({ tools: listTools() });
  } catch {
    return {
      schemaVersion: 1,
      state: 'unavailable',
      reason: 'MCP_TOOL_SURFACE_STATUS_UNAVAILABLE',
      nextAction: 'repair the local MCP surface observer before relying on it',
      counts: null,
      directSessionScopeUnverified: null
    };
  }
}

/* A name no registered tool carries lets status ask the real gate for the
 * external-write class without accidentally taking a by-name exemption. */
const EXTERNAL_WRITE_PROBE = 'system.external_write_probe';

/* Report the decision requiresApproval() will make. Reading policy.approvals
 * field by field drifted from the owner's agent.tool_approvals setting and
 * made status say ON after the effective gate was OFF. Keep the declared
 * policy beside the effective answer so the reason remains diagnosable. */
function approvalState(policy = loadPolicy()) {
  const approvals = (policy && policy.approvals) || {};
  const declared = Array.isArray(approvals.actions) ? approvals.actions : [];
  const actions = declared.filter(action => requiresApproval(action, 'local-write', policy));
  const externalWrites = requiresApproval(EXTERNAL_WRITE_PROBE, 'external-write', policy);
  return {
    enabled: actions.length > 0 || externalWrites,
    externalWrites,
    actions,
    timeoutSeconds: approvals.timeoutSeconds,
    declaredActions: declared,
    policyFileEnabled: Boolean(approvals.enabled)
  };
}

// A sandbox session sees the tools its permission tier offers.
function openShellStatus(env = process.env) {
  if (!require('./openshell-inside').isInsideOpenShellSandbox(env)) return {};
  const allowlist = String(env.TOOLSENABLED_TOOL_ALLOWLIST || '').split(',').filter(Boolean);
  return { openShell: { insideSandbox: true, toolsOffered: allowlist.length } };
}

function status(options = {}) {
  const policy = loadPolicy();
  const result = {
    name: 'ToolsEnabled Fleet',
    version: packageInfo.version,
    root: ROOT,
    mode: policy.mode,
    killSwitchActive: killSwitchActive(policy),
    killSwitch: killSwitchState(policy),
    approvals: approvalState(policy),
    ...openShellStatus(),
    transports: ['stdio-mcp'],
    mcpToolSurface: options.mcpToolSurface || mcpToolSurfaceStatus(),
    state: transactionalState(),
    audit: auditState()
  };
  const host = require('./host-status').hostStatus(result.audit.keyStore);
  return host ? { ...result, workspace: host.workspace, host } : result;
}

/* RESERVED-NAMESPACE HEALTH, WITHOUT SHOWING WHAT IS IN THEM.
 *
 * agent-comms, agent-comms-control and mcp.tool-surface hold Fleet's own
 * messaging, control and diagnostic state in the memory table. The public
 * memory.* tools used to reach them, so a release before that was closed could
 * have had a row written or overwritten by an agent, and closing the door does
 * not clean the room.
 *
 * TWO THINGS THIS REPORTS, AND ONE IT REFUSES TO.
 *   - A row the owning module can no longer parse is a positive finding, and its
 *     error code is reported.
 *   - A row that parses is reported as "unverifiable", NEVER as clean: a forged
 *     row has the same schema, revision mechanics and storage integrity as one
 *     Fleet wrote itself, so after the fact there is nothing to tell them apart.
 *     Saying "clean" here would be a claim nobody can support.
 *   - It reports counts and error codes only. No key, value or note is returned,
 *     because the retained history includes the owner's own messages and a health
 *     check is not a reason to put them in front of anyone.
 *
 * Recovery is deliberately not performed here: see RECOVERY.md. It resets
 * messaging state, so it is the person's decision, taken with Fleet stopped. */
const RESERVED_MEMORY = Object.freeze(['agent-comms', 'agent-comms-control', 'mcp.tool-surface']);
const RESERVED_NOTE = 'A row that parses cannot be proved to be Fleet\'s own: a forged row is identical in '
  + 'shape, revision and integrity. Treat any row written before this release as unverifiable. '
  + 'RECOVERY.md says how to reset this state with Fleet stopped.';

/* EACH ROW IS JUDGED BY THE MODULE THAT OWNS IT, never by a generic "is it an
 * object" test. A generic test calls `{ definitely: 'not an envelope' }`
 * acceptable, which is a false negative in the one check meant to catch
 * tampering, and it would quietly pass a cursor row whose claimed ids do not
 * belong to its own key. */
function reservedRowCode(namespace, key, store) {
  try {
    if (namespace === 'agent-comms-control') {
      /* The reader only ever looks at CONTROL_KEY, so asking it about a row under
       * any other key would validate a different row and call this one fine. Bind
       * the key first, then let the reader validate the value against the live
       * limits -- which is why the value check is still snapshot() and not a
       * second copy of its rules. */
      const control = require('./agent-comms/control-plane');
      if (key !== control.CONTROL_KEY) return 'AGENT_COMMS_CONTROL_KEY_UNKNOWN';
      control.createControlPlane({ store }).snapshot();
      return null;
    }
    const value = store.getMemory({ namespace, key })?.value;
    if (namespace === 'agent-comms') return require('./agent-comms/history').inspectStoredRow(key, value);
    if (namespace === 'mcp.tool-surface') return require('./mcp-tool-surface').inspectStoredRow(key, value);
    return 'RESERVED_ROW_NAMESPACE_UNKNOWN';
  } catch (error) {
    return typeof error?.code === 'string' ? error.code : 'RESERVED_ROW_UNREADABLE';
  }
}

function reservedMemoryState() {
  let store;
  try { store = require('./state-store').getStateStore(); }
  catch (error) {
    return { state: 'unreadable', error: { code: typeof error?.code === 'string' ? error.code : 'STATE_UNREADABLE' } };
  }
  const namespaces = {};
  for (const namespace of RESERVED_MEMORY) {
    let keys;
    try { keys = store.memoryKeys({ namespace }); }
    catch (error) {
      namespaces[namespace] = { state: 'unreadable', codes: [typeof error?.code === 'string' ? error.code : 'STATE_UNREADABLE'] };
      continue;
    }
    if (!keys.length) { namespaces[namespace] = { state: 'absent', rows: 0, malformed: 0 }; continue; }
    const codes = new Set();
    let malformed = 0;
    for (const key of keys) {
      const code = reservedRowCode(namespace, key, store);
      if (code) { malformed += 1; codes.add(code); }
    }
    namespaces[namespace] = {
      state: malformed ? 'malformed' : 'unverifiable',
      rows: keys.length,
      malformed,
      ...(codes.size ? { codes: [...codes].sort() } : {})
    };
  }
  return { namespaces, note: RESERVED_NOTE };
}

function doctor() {
  const policy = loadPolicy();
  let credentialVault = { state: 'readable' };
  try {
    listSecretKeys();
  } catch (error) {
    credentialVault = {
      state: 'unreadable',
      error: {
        code: typeof error.code === 'string' ? error.code : 'VAULT_UNREADABLE',
        message: String(error.message || error).slice(0, 500)
      }
    };
  }
  const surface = mcpToolSurfaceStatus();
  return {
    node: process.version,
    root: ROOT,
    cwd: ROOT,
    policy: filePresence(rootPath('config', 'toolsenabled.policy.json')),
    mcpServer: filePresence(rootPath('src', 'mcp-server.js')),
    executables: { node: commandExists('node') },
    state: transactionalState(),
    audit: auditState(),
    killSwitchActive: killSwitchActive(policy),
    killSwitch: killSwitchState(policy),
    credentialVault,
    mcpToolSurface: surface,
    reservedMemory: reservedMemoryState(),
    runtime: status({ mcpToolSurface: surface })
  };
}

module.exports = {
  RESERVED_MEMORY,
  approvalState,
  auditState,
  reservedMemoryState,
  doctor,
  mcpToolSurfaceStatus,
  status,
  transactionalState
};
