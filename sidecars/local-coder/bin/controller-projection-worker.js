'use strict';

// Keep the signed-ledger scan off the sidecar HTTP event loop.  This worker
// returns only the already-scrubbed tail, plus at most twenty exact immutable
// launch parents needed to pair recent terminal receipts, and verification
// metadata needed by the browser-safe projection builder; it never accepts a
// prompt or command.
const { parentPort } = require('node:worker_threads');
const audit = require('../../../src/lib/audit');

try {
  let status = audit.status();
  let verification = audit.verify();
  // A broker/tool-success event may be durable while its rebuildable sinks
  // are one event behind. Reconcile that bounded writer race once before
  // publishing an invalid controller snapshot; persistent invalidity still
  // remains fail-closed.
  if (!verification.valid && ['projection-divergence', 'projection-malformed', 'emergency-backlog'].includes(verification.reason)) {
    try {
      audit.flush({ force: true });
      status = audit.status();
      verification = audit.verify();
    } catch { /* The original verification remains the safe result. */ }
  }
  const events = verification.valid ? audit.tailWithReferencedParents({
    limit: 200,
    childAction: 'controller.agent.launch.terminal',
    parentAction: 'controller.agent.launch',
    perTargetLimit: 2,
    maxTargets: 20
  }) : [];
  parentPort.postMessage({
    status: {
      headSequence: Number.isSafeInteger(status.headSequence) ? status.headSequence : 0,
      headHash: typeof status.headHash === 'string' ? status.headHash : null,
      headKeyId: typeof status.headKeyId === 'string' ? status.headKeyId : null
    },
    verification,
    events
  });
} catch (error) {
  parentPort.postMessage({
    error: { code: error && typeof error.code === 'string' ? error.code : 'CONTROLLER_AUDIT_VERIFY_FAILED' }
  });
}
