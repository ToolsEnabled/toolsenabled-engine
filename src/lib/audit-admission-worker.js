'use strict';

// The audit admission worker: one thread whose only job is to admit batches
// of audit events to the canonical ledger, so the synchronous SQLite and
// vault work never runs on the thread the desktop app draws on. See
// src/lib/audit-admission.js for the contract.
//
// It shares nothing with the parent but the ledger file and the environment;
// from the ledger's point of view it is another writer process, held to the
// same cross-process witness checks as every MCP broker.

const { parentPort, isMainThread } = require('node:worker_threads');

if (isMainThread || !parentPort) {
  throw new Error('audit-admission-worker.js runs only as a worker thread.');
}

const path = require('node:path');

const audit = require('./audit');

// Statuses cross the thread boundary by structured clone; error entries are
// already plain {sink, code, message} objects, but a JSON round trip keeps
// any future non-cloneable field from failing the whole reply.
function cloneable(value) {
  return JSON.parse(JSON.stringify(value));
}

// The tool meter's ledger belongs to the controller layer, which sits above
// this one. This worker must not reach up and name it: a kernel that imports
// its own callers cannot be reasoned about, and the package checker counts
// that edge as KERNEL_IMPORTS_UP debt. So the caller that already owns the
// ledger passes its module specifier with the request, and this worker loads
// only what it was handed.
//
// The specifier is fenced to this directory. The request comes from our own
// parent thread rather than from anywhere a stranger can reach, but a worker
// that will require whatever string it is sent is a bad shape to leave lying
// around for the next caller.
function meterLedgerFor(specifier) {
  if (typeof specifier !== 'string' || !specifier) {
    throw Object.assign(new Error('A tool-meter batch must name its ledger module.'),
      { code: 'METER_LEDGER_UNSPECIFIED' });
  }
  const resolved = require.resolve(path.resolve(__dirname, specifier));
  if (path.dirname(resolved) !== __dirname) {
    throw Object.assign(new Error('The tool-meter ledger must live beside the audit worker.'),
      { code: 'METER_LEDGER_PATH_INVALID' });
  }
  return require(resolved);
}

parentPort.on('message', async message => {
  if (!message || typeof message !== 'object' || !Array.isArray(message.items)) return;
  if (message.kind === 'close') {
    try {
      await audit.close();
      parentPort.postMessage({ id: message.id, result: { closed: true } });
    } catch (error) { parentPort.postMessage({ id: message.id, error: { code: error.code || 'AUDIT_CLOSE_FAILED', message: error.message } }); }
    return;
  }
  let reply;
  try {
    reply = message.kind === 'tool-meter'
      ? { id: message.id, result: cloneable(meterLedgerFor(message.ledgerModule).recordMeterBatch(message.items, { audit })) }
      : { id: message.id, statuses: cloneable(audit.recordBatch(message.items)) };
  } catch (error) {
    if (message.kind === 'tool-meter') {
      try { audit.record('mcp.meter.failed', 'mcp-tool-batch', {
        outcome: String(error?.code || 'meter-batch-unavailable').slice(0, 80), count: message.items.length
      }); } catch { /* A broken ledger cannot persist its own failure marker. */ }
    }
    reply = {
      id: message.id,
      error: {
        code: error && typeof error.code === 'string' ? error.code : 'AUDIT_ADMISSION_FAILED',
        message: error && error.message ? String(error.message) : String(error)
      }
    };
  }
  parentPort.postMessage(reply);
});
