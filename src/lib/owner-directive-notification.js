'use strict';

// P11: a newly captured owner directive must reach live agents immediately,
// through the existing durable internal-comms fabric.  This is intentionally
// a post-persistence side effect: capture is authoritative and append-only;
// notification is useful delivery work that must never undo a successful
// capture when the fabric is unavailable or uncertain.

const presence = require('./agent-presence');
const { createLocalAgentCommsRuntime } = require('./agent-comms/local-runtime');

function errorCode(error) {
  return error && typeof error.code === 'string'
    ? error.code
    : 'OWNER_DIRECTIVE_NOTIFICATION_FAILED';
}

function runningAgentIds({
  presenceApi = presence,
  now = Date.now,
  isAlive
} = {}) {
  const registry = presenceApi.readRegistry();
  const livenessOptions = { now: now() };
  if (isAlive !== undefined) livenessOptions.isAlive = isAlive;
  return presenceApi.rosterRows(registry, livenessOptions)
    .filter(row => row.agentId !== 'owner'
      && row.status === 'running'
      && (row.liveness === 'running' || row.liveness === 'heartbeat-fault'))
    .map(row => row.agentId);
}

function directiveNotice({ id, revision, mode, scope }) {
  // The notification intentionally carries no owner verbatim or controller
  // interpretation.  It tells a live agent that its snapshot is stale and
  // where to refresh, without copying prompt content into another transport.
  return `Owner directive ${id} was captured (ledger revision ${revision}; ${mode}; scope ${scope}). Re-read current directive context before continuing.`;
}

function mailboxDelivered(result) {
  return Array.isArray(result && result.mailboxDeliveries)
    && result.mailboxDeliveries.length > 0
    && result.mailboxDeliveries.every(delivery => delivery && delivery.queued === true);
}

/**
 * Send a compact stale-context notice to every presently live local agent.
 *
 * The existing local runtime composes the production fabric, durable history,
 * and presence mailbox.  No endpoint, socket, or secondary queue is created
 * here.  This function returns delivery uncertainty as data so the caller can
 * preserve the already-persisted capture regardless of notification outcome.
 */
async function notifyCapturedDirective(directive, {
  listRunningAgents = runningAgentIds,
  runtimeFactory = createLocalAgentCommsRuntime
} = {}) {
  let recipients;
  try {
    recipients = listRunningAgents();
  } catch (error) {
    return Object.freeze({
      status: 'uncertain',
      attempted: 0,
      notified: 0,
      failed: 0,
      code: errorCode(error)
    });
  }

  if (!Array.isArray(recipients)) {
    return Object.freeze({
      status: 'uncertain',
      attempted: 0,
      notified: 0,
      failed: 0,
      code: 'OWNER_DIRECTIVE_NOTIFICATION_RECIPIENTS_INVALID'
    });
  }

  if (recipients.length === 0) {
    return Object.freeze({ status: 'no-running-agents', attempted: 0, notified: 0, failed: 0 });
  }

  let runtime;
  let sender;
  try {
    runtime = runtimeFactory({ extraAgentIds: recipients });
    sender = runtime.identity('owner');
  } catch (error) {
    return Object.freeze({
      status: 'uncertain',
      attempted: recipients.length,
      notified: 0,
      failed: recipients.length,
      code: errorCode(error),
      recipients: Object.freeze([...recipients])
    });
  }

  const body = directiveNotice(directive);
  const deliveries = [];
  for (const recipientId of recipients) {
    try {
      const recipient = runtime.identity(recipientId);
      const result = await runtime.fabric.send({
        sender,
        recipient,
        kind: 'notice',
        body
      }, { identity: sender });
      const delivered = result && result.accepted === true && mailboxDelivered(result);
      deliveries.push(Object.freeze({
        recipientId,
        delivered,
        ...(delivered ? {} : {
          code: result && result.accepted !== true && typeof result.code === 'string'
            ? result.code
            : 'OWNER_DIRECTIVE_NOTIFICATION_MAILBOX_DELIVERY_UNCONFIRMED'
        })
      }));
    } catch (error) {
      deliveries.push(Object.freeze({ recipientId, delivered: false, code: errorCode(error) }));
    }
  }

  const notified = deliveries.filter(delivery => delivery.delivered).length;
  const failed = deliveries.length - notified;
  return Object.freeze({
    status: failed === 0 ? 'notified' : 'partial',
    attempted: deliveries.length,
    notified,
    failed,
    deliveries: Object.freeze(deliveries)
  });
}

module.exports = Object.freeze({
  directiveNotice,
  notifyCapturedDirective,
  runningAgentIds
});
