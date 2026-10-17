'use strict';

const { getStateStore } = require('../state-store');
const coordinatorAudit = require('../coordinator-audit-events');

const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

/* NAMESPACES THIS PUBLIC TOOL MAY NOT TOUCH, read or write.
 *
 * These hold product authority and private state in the SAME memory table this
 * tool exposes: agent-comms keeps live message history, including the
 * owner.journal every local message is appended to; agent-comms-control keeps
 * channel membership and owner-special designation; mcp.tool-surface keeps the
 * instance records system.status reports. Reaching them through this tool let an
 * agent forge a message from another agent, read the owner's retained traffic,
 * poison the roster, or corrupt the surface record.
 *
 * `contentTrust: untrusted` on a result is an INTEGRITY label -- it says the
 * bytes grant no authority. It is not confidentiality, and it does nothing at
 * all on a write.
 *
 * THE CHECK BELONGS HERE, NOT IN StateStore. The trusted internal writers
 * (agent-comms/history.js, agent-comms/control-plane.js, mcp-tool-surface.js)
 * call the very same setMemory/getMemory, so refusing inside the store would
 * break the product's own state. This module is the public tool boundary and
 * the only caller that must be bounded.
 *
 * agent-coord is deliberately NOT here: it is the inter-agent coordination
 * board agents are told to use, and this tool's own description documents it. */
const INTERNAL_NAMESPACES = Object.freeze(['agent-comms', 'agent-comms-control', 'mcp.tool-surface']);

function refuseInternal(namespace, what) {
  throw Object.assign(
    new Error(`"${namespace}" is one of Fleet's own internal namespaces, so ${what}. `
      + `Use a namespace of your own, or agent-coord for notes to other agents.`),
    { code: 'MEMORY_NAMESPACE_RESERVED', details: Object.freeze({ namespace, reserved: INTERNAL_NAMESPACES }) }
  );
}

/* SNAPSHOT ONCE, THEN CHECK AND FORWARD THE SNAPSHOT.
 *
 * Reading input.namespace here and letting StateStore read it again would be a
 * check/use gap: an accessor can answer 'my-notes' the first time and
 * 'agent-comms' the second, and the row comes back. JSON-RPC cannot build such
 * an object, so this is hardening rather than a live remote hole -- but a
 * boundary that validates one value and forwards another is not a boundary.
 *
 * A non-plain input is returned untouched so StateStore's own argument
 * validation reports it, which it does better. An array in particular must NOT
 * be spread: {...[1,2]} is a plain object, so spreading one would smuggle it
 * past a check that currently rejects it. */
function publicMemoryInput(input, what) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const snapshot = { ...input };
  if (typeof snapshot.namespace === 'string' && INTERNAL_NAMESPACES.includes(snapshot.namespace)) {
    refuseInternal(snapshot.namespace, what);
  }
  return snapshot;
}

function durableState(dependencies) {
  return dependencies.state || getStateStore();
}

function metadata(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    namespace: entry.namespace,
    key: entry.key,
    valueHash: entry.valueHash,
    revision: entry.revision,
    createdAt: entry.createdAt,
    createdAtMs: entry.createdAtMs,
    updatedAt: entry.updatedAt,
    updatedAtMs: entry.updatedAtMs
  };
}

function set(input, dependencies = {}) {
  const bounded = publicMemoryInput(input, 'it cannot be written through this tool');
  const saved = durableState(dependencies).setMemory(bounded);
  const output = {
    ...metadata(saved.entry),
    created: saved.created,
    replayed: saved.replayed
  };
  const event = coordinatorAudit.memoryMutation({
    namespace: output.namespace,
    key: output.key,
    valueHash: output.valueHash,
    revision: output.revision,
    created: output.created,
    replayed: output.replayed,
    occurredAtMs: output.updatedAtMs
  });
  /* required: FALSE, and an earlier sweep's flip to true is reverted here. This audit
   * write happens AFTER the durable local mutation has already committed, so
   * demanding a durable audit record cannot protect anything -- it can only
   * throw away a completed local write when a canonical audit store is
   * unreachable. The legacy policy's stated contract is that local policy/task/memory
   * changes are OBSERVED with audit.record and never gated by a new
   * fail-closed boundary; the value-free events recover through the emergency
   * spool when a canonical store returns. Making this required turns an audit
   * outage into local data loss. */
  const auditOptions = {
    required: false,
    ...(typeof dependencies.auditRecord === 'function' ? { auditRecord: dependencies.auditRecord } : {}),
    ...(dependencies.auditDependencies ? { auditDependencies: dependencies.auditDependencies } : {})
  };
  /* OFF THE CALLER'S THREAD, BUT STILL WRITTEN. The synchronous write() ran the
   * whole admission -- writer-lock spin, projection digests, redaction -- on
   * whichever thread called memory.set. writeAsync submits the identical event
   * to the group-commit queue instead (src/lib/audit-admission.js), which
   * admits it on the worker thread.
   *
   * NOT AWAITED, AND THAT IS SAFE HERE FOR ONE SPECIFIC REASON: the record is
   * required:false and is made after the local mutation has already committed,
   * so nothing downstream reads its status -- set() discards it today. Awaiting
   * would force set() async and cascade through every caller for a value none
   * of them use.
   *
   * A DROPPED SUBMISSION IS NOT THE RISK IT LOOKS LIKE. The queue's coalesce
   * timer is deliberately left REFERENCED ("queued records with waiting callers
   * are work the process owes, not a background nicety"), so a pending record
   * keeps the event loop alive and an ordinary exit cannot leave it unwritten.
   * An abrupt termination still can, which the synchronous write survived --
   * that is the one property traded, and it is traded knowingly.
   *
   * THE STRICT BRANCH IS NOT OPTIONAL. writeAsync always queues; it does NOT
   * consult throughputMode itself. Calling it unconditionally would make
   * TOOLSENABLED_TOOLS_THROUGHPUT=strict silently stop meaning anything for
   * this event, so the mode is checked here exactly as tool-registry.js does
   * for the tool's own record. */
  if (require('../throughput-mode').throughputMode() !== 'strict') {
    void coordinatorAudit.writeAsync(event, {
      required: false,
      ...(dependencies.admissionQueue ? { admissionQueue: dependencies.admissionQueue } : {})
    }).catch(error => {
      /* The one place this can now fail quietly, so it is reported rather than
         swallowed. queue.submit() itself never rejects; this catches event
         validation and status shaping, and any future rejecting queue. */
      const report = typeof dependencies.reportError === 'function'
        ? dependencies.reportError
        : message => { try { process.stderr.write(`${message}\n`); } catch { /* best effort */ } };
      report(`ToolsEnabled memory mutation audit record failed: ${error && error.message ? error.message : error}`);
    });
  } else {
    coordinatorAudit.write(event, auditOptions);
  }
  return output;
}

function get(input, dependencies = {}) {
  const bounded = publicMemoryInput(input, 'it cannot be read through this tool');
  const entry = durableState(dependencies).getMemory(bounded);
  return entry === null ? null : { ...entry, ...UNTRUSTED_CONTENT };
}

/* Inside an OpenShell sandbox the agent CLIs keep about 10,000 tokens of a
   tool result and cut the middle out, and twenty matches of up to 32 KiB each
   came back as hundreds of kilobytes (measured 2026-09-29). There a search
   returns at most the read window's 32 KiB of JSON text: every match is
   named, and a value that does not fit is left for memory.get. */
function boundedSearch(result) {
  if (!require('../openshell-inside').isInsideOpenShellSandbox()) return result;
  const cap = require('./host-control').SANDBOX_READ_WINDOW_BYTES;
  const note = 'Some values are left out (valueOmitted: true) to keep this result whole; read each with memory.get.';
  const shell = entry => {
    const { value: _value, note: _note, ...rest } = entry;
    return { ...rest, valueOmitted: true };
  };
  let size = Buffer.byteLength(JSON.stringify({ ...result, entries: [], note }))
    + result.entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(shell(entry))) + 1, 0);
  let omitted = 0;
  const entries = result.entries.map(entry => {
    const whole = Buffer.byteLength(JSON.stringify(entry)) - Buffer.byteLength(JSON.stringify(shell(entry)));
    if (size + whole <= cap) { size += whole; return entry; }
    omitted += 1;
    return shell(entry);
  });
  return omitted === 0 ? result : { ...result, entries, note };
}

/* The exclusion is handed to the store so it applies in SQL, BEFORE the row
 * limit. Filtering the returned page here instead would hand back short or
 * empty pages whenever internal rows happened to sort first, which reads as
 * "no matches" rather than "not yours". */
function search(input, dependencies = {}) {
  const bounded = publicMemoryInput(input, 'it cannot be searched through this tool');
  // Only a plain object carries the exclusion; anything else goes through
  // unchanged so the store refuses it instead of being handed a shape its own
  // validation would have rejected.
  const scoped = bounded && typeof bounded === 'object' && !Array.isArray(bounded)
    ? { ...bounded, excludeNamespaces: INTERNAL_NAMESPACES }
    : bounded;
  const entries = durableState(dependencies).searchMemory(scoped);
  return boundedSearch({ entries, count: entries.length, ...UNTRUSTED_CONTENT });
}

module.exports = { INTERNAL_NAMESPACES, UNTRUSTED_CONTENT, get, metadata, search, set };
