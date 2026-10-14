'use strict';

// THE COORDINATOR'S ALARM, CARRIED BY THIS PRODUCT INSTEAD OF SOMEBODY ELSE'S.
//
// WHAT THIS REPLACES, measured rather than assumed. escalation-sink.js used to
// default to telegramBridge.sendToOwner, which resolves a pinned chat out of
// state/telegram-bridge.json. On this machine that file's pinnedChatId is null,
// so every send failed TELEGRAM_BRIDGE_NOT_PAIRED and the only wired path from
// a detected failure to a human ended in an error nobody was reading. An alarm
// channel whose delivery depends on a third-party account being paired is an
// alarm channel that is off by default.
//
// WHERE IT GOES NOW. src/lib/agent-comms/ -- the product's own local message
// fabric. One send here reaches two surfaces the person already has:
//
//   * THE DESK. The app's Comms page reads the owner journal through
//     src/lib/providers/agent-comms-local.js#ownerJournal, reached from the
//     renderer as bridge.localMessages -> shell/main.cjs's 'mc-agent:local-
//     messages' -> shell/agent-command-surface.cjs 'agent:local-messages'.
//   * THE PHONE. The same command is exposed over the app's facade at
//     GET /v1/agent/local-messages (shell/agent-facade.cjs), which is what the
//     relayed mobile surface reads.
//
// ONE STORE, NOT TWO. Nothing here keeps its own copy of anything. The message
// goes into the fabric that already exists and the journal that already exists;
// the two surfaces above are READS of that one record. A private "coordinator
// alerts" log would be a second answer to the question "what was I told", and
// the first time it disagreed with the journal there would be no way to say
// which one was right.
//
// WHY THE OWNER JOURNAL IS THE RIGHT PLACE FOR AN ALARM SPECIFICALLY. The
// fabric appends to the owner journal BEFORE it appends to the recipient's own
// stream and before it hands the message to the broker
// (agent-comms/fabric.js#acceptAuthenticatedSubmission). The ordering is
// structural: a later stream or delivery failure can leave a conspicuous
// incomplete operation, but it cannot produce traffic the owner cannot see.
// That is exactly the property an alarm needs and the property the pinned-chat
// path did not have.
//
// IT RAISES AN ALARM AND IT CANNOT DO ANYTHING ELSE. This module exports one
// function, it takes text and nothing else, and it addresses one recipient
// that it does not accept as a parameter. There is no reply path here, no
// inbox read, and no way to ask it to send as anyone but the coordinator. The
// daemon that calls it is structurally incapable of composing an answer on the
// owner's behalf (src/lib/coordinator/duty-registry.js refuses to load a
// judgement duty that carries a run() function), and nothing in this file
// widens that.
//
// DELIVERED MEANS IN THE JOURNAL, AND IT IS CHECKED. escalation-sink.js takes
// `delivered` from whether this function threw, and duty-registry.js takes the
// duty's own `delivered` from the sink's decision rather than from the absence
// of an exception. So the meaning of "no exception" has to be worth that: this
// function returns normally only after re-reading the journal THROUGH A SECOND
// RUNTIME and finding the message it just wrote. A fresh runtime reads the
// durable history the app's own separate process will read, so a return here is
// a claim about what is on disk, not about what one object remembers doing.

const { createLocalAgentCommsRuntime } = require('../agent-comms/local-runtime');

// The channel name that appears on the escalation record and in the directive
// inbox trail. It names the subsystem, not a vendor, because the subsystem is
// the thing that would have to be working for the message to arrive.
const CHANNEL = 'agent-comms';

// The coordinator is a durable agent identity, not a tree node the person drew
// in the app. It is passed as an extra agent id so the runtime admits it
// whether or not config/agent-org.json happens to declare it; 'owner' is
// admitted by local-runtime.js unconditionally.
const SENDER_AGENT_ID = 'coordinator';
const OWNER_AGENT_ID = 'owner';

// agent-comms/channel-contract.js DEFAULT_MAX_BODY_LENGTH. The sink composes a
// message well under this and truncates there too; this bound is the fabric's
// own and is enforced here so that an over-long alarm is shortened rather than
// refused. A truncated alarm still names the subsystem and the state on its
// first line, which is the part a person acts on.
const MAX_BODY_LENGTH = 4000;

class OwnerAlarmChannelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnerAlarmChannelError';
    this.code = code;
  }
}

function fail(code, message) { throw new OwnerAlarmChannelError(code, message); }

// Keep a refusal code in the shape escalation-sink.js#errorCode preserves
// (`/^[A-Za-z0-9_.:-]{1,80}$/`); anything else would be flattened to 'ERROR'
// and the reason the owner was not reached would be lost on the way out.
function refusalCode(result) {
  const code = result && typeof result.code === 'string' ? result.code : '';
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : 'OWNER_ALARM_REFUSED';
}

function runtimeOptionsFor(overrides) {
  const extra = Array.isArray(overrides.extraAgentIds) ? overrides.extraAgentIds : [];
  return {
    ...overrides,
    extraAgentIds: [...new Set([SENDER_AGENT_ID, ...extra])]
  };
}

/**
 * A journal row is {sequence, appendedAtMs, message: {streamId, message}} --
 * the outer `message` is the envelope naming which stream the message was filed
 * on, and the message itself is one level further in. The same double unwrap
 * src/lib/providers/agent-comms-local.js#ownerJournal does, for the same
 * reason: reading only the outer one finds no id and would report a delivered
 * message as missing.
 */
function journalledMessageId(record) {
  if (!record) return null;
  const envelope = record.message || record;
  const message = envelope.message || envelope;
  return message && typeof message.id === 'string' ? message.id : null;
}

/**
 * Put a coordinator alarm in front of the owner, through this product.
 *
 * Signature and failure mode match what escalation-sink.js expects of a sender:
 * it is called as sendFn({ text }), it THROWS with a `.code` when the owner was
 * not reached, and it returns a record when he was. There is no partial answer,
 * because the caller's whole honesty contract rests on that distinction.
 *
 * Returns { channel, messageId, journalSequence, streamId, truncated }.
 */
async function sendToOwner(input = {}, dependencies = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('OWNER_ALARM_INVALID', 'The owner alarm input must be a plain object with a text field.');
  }
  const text = typeof input.text === 'string' ? input.text : '';
  if (text.trim().length === 0) {
    fail('OWNER_ALARM_TEXT_REQUIRED', 'An owner alarm needs non-blank text.');
  }
  const truncated = text.length > MAX_BODY_LENGTH;
  const body = truncated ? `${text.slice(0, MAX_BODY_LENGTH - 3)}...` : text;

  const runtimeFactory = dependencies.runtimeFactory || createLocalAgentCommsRuntime;
  const options = runtimeOptionsFor(dependencies.runtimeOptions || {});

  // A runtime that cannot be built is a channel that cannot deliver, and it
  // throws its own code (AGENT_COMMS_AGENT_DIRECTORY_UNAVAILABLE when the
  // installation has no declared org, for instance). It is deliberately not
  // caught here: the sink records the code, marks the channel BROKEN, and the
  // duty host reports it. Swallowing it would make a dead channel look quiet,
  // which is the failure this whole subsystem exists to prevent.
  const runtime = runtimeFactory(options);
  const sender = runtime.identity(SENDER_AGENT_ID);
  const recipient = runtime.identity(OWNER_AGENT_ID);

  const result = await runtime.fabric.send({
    sender,
    recipient,
    kind: 'notice',
    body
  }, Object.freeze({ identity: sender }));

  // The fabric answers a refusal as a VALUE, not an exception. Letting that
  // value fall through as success is precisely how "the sink did not throw"
  // stops meaning "the owner was told".
  if (!result || result.accepted !== true) {
    fail(refusalCode(result), 'The local message fabric refused the coordinator alarm.');
  }

  const messageId = result.message && typeof result.message.id === 'string' ? result.message.id : null;
  const journalSequence = result.journal && Number.isSafeInteger(result.journal.sequence)
    ? result.journal.sequence
    : null;
  if (messageId === null || journalSequence === null) {
    fail('OWNER_ALARM_RECEIPT_UNREADABLE',
      'The fabric accepted the alarm but returned no message id or journal sequence, so there is nothing to verify.');
  }

  // THE READ-BACK. A second runtime over the same durable history, because the
  // process that will actually show this to him is a different one. Reading the
  // single journal row this send claims to have written is the cheapest check
  // that answers the only question the caller asks: is it really there.
  const verifier = runtimeFactory(options);
  const projection = await verifier.fabric.ownerProjection({
    actor: verifier.ownerActor,
    cursor: journalSequence - 1,
    limit: 1
  });
  // Do not collapse an unreadable projection into an empty journal. An empty
  // records array is a definite observation (the alarm is absent), while a
  // missing/malformed journal means the read-back did not establish anything.
  // Treating both as [] would turn a failed measurement into the confident
  // OWNER_ALARM_NOT_IN_JOURNAL answer below.
  const journal = projection && projection.journal;
  const knownStatuses = new Set(['BACKLOG', 'CAUGHT_UP', 'INCOMPLETE', 'TRUNCATED']);
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)
      || !knownStatuses.has(journal.status) || !Array.isArray(journal.records)) {
    fail('OWNER_ALARM_JOURNAL_UNREADABLE',
      'The owner journal read-back was malformed, so alarm visibility could not be established.');
  }
  if (journal.status === 'TRUNCATED') {
    fail('OWNER_ALARM_JOURNAL_TRUNCATED',
      'The owner journal has passed its retention floor, so the alarm cannot be confirmed as visible.');
  }
  const records = journal.records;
  if (journalledMessageId(records[0]) !== messageId) {
    fail('OWNER_ALARM_NOT_IN_JOURNAL',
      'The fabric accepted the alarm but it is not in the owner journal, so the owner cannot see it.');
  }

  return Object.freeze({
    channel: CHANNEL,
    messageId,
    journalSequence,
    streamId: result.stream && typeof result.stream.id === 'string' ? result.stream.id : null,
    truncated
  });
}

module.exports = Object.freeze({
  CHANNEL,
  MAX_BODY_LENGTH,
  OWNER_AGENT_ID,
  OwnerAlarmChannelError,
  SENDER_AGENT_ID,
  sendToOwner
});
