'use strict';

const { getStateStore } = require('../state-store');
const coordinatorAudit = require('../coordinator-audit-events');

const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

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
  const saved = durableState(dependencies).setMemory(input);
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
  /* required: FALSE, and w20's flip to true is reverted here. This audit
   * write happens AFTER the durable local mutation has already committed, so
   * demanding a durable audit record cannot protect anything -- it can only
   * throw away a completed local write when a canonical audit store is
   * unreachable. P11's stated contract is that local policy/task/memory
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
  const entry = durableState(dependencies).getMemory(input);
  return entry === null ? null : { ...entry, ...UNTRUSTED_CONTENT };
}

function search(input, dependencies = {}) {
  const entries = durableState(dependencies).searchMemory(input);
  return { entries, count: entries.length, ...UNTRUSTED_CONTENT };
}

module.exports = { UNTRUSTED_CONTENT, get, metadata, search, set };
