'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { STATES } = require('../agent-wake/liveness-receiver');
const { acquireLock, pidAlive: lockPidAlive } = require('../process-claim-lock');

const SCHEMA_VERSION = 1;
const DEFAULT_WAKE_COOLDOWN_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const LEGACY_LOCK_STALE_MS = 60_000;
/* HOW MANY DELIVERY RECEIPTS AND DEAD LETTERS THIS FILE REMEMBERS FOREVER,
 * WHICH BEFORE THIS FIX WAS "ALL OF THEM, FOR AS LONG AS THE INSTALLATION
 * LIVES".
 *
 * MEASURED 2026-09-04 against the Live installation's own local-broker.json
 * (read-only, not written by this change): 256,593 bytes, spool and dead
 * letters both empty, and 822 delivery receipts alone accounting for
 * 215,365 of those bytes -- 84% of the file, for a value nothing after
 * delivery ever reads again except to answer one question. See readState /
 * commit / withStateLock: every single broker operation -- one send, one
 * drain, one delivery reservation, one claim release -- reads this whole
 * file, JSON.parses it, deep-clones it (clone() below), and writes the
 * entire thing back out. So the cost of literally every message on this
 * machine was proportional to every message this installation had EVER
 * delivered, not to the small, naturally self-bounding set still in flight
 * (a spool entry is deleted the moment it is delivered -- see
 * recordDelivery -- so it was never the growth risk).
 *
 * A delivery receipt exists to answer exactly one question for exactly one
 * caller: "was this exact messageId already delivered", asked by enqueue()
 * when a sender retries after a crash or a lost reply. A retry that
 * surfaces months after the original delivery is not a case this file could
 * protect against anyway -- nothing on the sending side remembers a
 * messageId that long either. So the fix agent-comms/history.js already
 * uses for the identical shape of problem (DEFAULT_RETENTION, "while
 * (records.length > retention) records.shift()") applies here too: keep the
 * most recent N, oldest evicted first, so a retry inside the window is still
 * caught and the file's size gets a fixed ceiling instead of an
 * installation's whole lifetime in it. See trimOldest() below.
 *
 * Dead letters are capped separately, and lower, because a dead letter keeps
 * the FULL rejected packet -- not a small receipt -- so it is the payload
 * size, not the count, that matters most; that is the same distinction
 * history.js draws between its record retention and its maxChannelBytes. */
const DEFAULT_DELIVERY_RETENTION = 500;
const DEFAULT_DEAD_LETTER_RETENTION = 200;
const ACTIVE_DELIVERY_CLAIMS = new Set();
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_PROCESS_START_IDENTITY_LENGTH = 256;
const PROCESS_IDENTITY_STATES = Object.freeze({
  ALIVE: 'ALIVE',
  DEAD: 'DEAD',
  UNKNOWN: 'UNKNOWN'
});
const ROUTES = Object.freeze({
  LOCAL: 'local',
  PEER: 'peer'
});
const DELIVERY_STATES = Object.freeze({
  SENT: 'SENT',
  DELIVERED: 'DELIVERED'
});
const TRANSPORT_OUTCOMES = Object.freeze({
  FAILED: 'FAILED',
  UNCERTAIN: 'UNCERTAIN'
});
const CREDENTIAL_FIELDS = Object.freeze(new Set([
  'accesstoken',
  'apikey',
  'authentication',
  'authorization',
  'cookie',
  'credentials',
  'password',
  'passwd',
  'refreshtoken',
  'secret',
  'secretkey',
  'token'
]));
const SPOOL_ENTRY_KEYS = Object.freeze(new Set([
  'sequence', 'messageId', 'recipientAgentId', 'recipientMachineId', 'fingerprint',
  'enqueuedAtMs', 'message', 'transportOutcome', 'deliveryClaim'
]));
const REQUIRED_SPOOL_ENTRY_KEYS = Object.freeze(new Set([
  'sequence', 'messageId', 'recipientAgentId', 'recipientMachineId', 'fingerprint',
  'enqueuedAtMs', 'message'
]));
const DEAD_LETTER_KEYS = Object.freeze(new Set([
  'deadLetteredAtMs', 'reason', 'entry'
]));
const DEAD_LETTER_REASONS = Object.freeze(new Set([
  'RECIPIENT_NOT_IN_DIRECTORY', 'RECIPIENT_QUEUE_DISCARDED'
]));
const DEAD_LETTER_REQUEST_KEYS = Object.freeze(new Set(['message', 'reason']));
const DEFERRED_DELIVERY_KEYS = Object.freeze(new Set(['deferredAtMs', 'entry']));
const WAITING_DELIVERY_KEYS = Object.freeze(new Set([...DEFERRED_DELIVERY_KEYS, 'waitingForModel']));
const HANDOFF_REQUEST_KEYS = Object.freeze(new Set(['message']));
const LEGACY_DELIVERY_CLAIM_KEYS = Object.freeze(new Set([
  'claimId', 'holderPid', 'claimedAtMs'
]));
const DELIVERY_CLAIM_KEYS = Object.freeze(new Set([
  'claimId', 'holderPid', 'holderProcessStartIdentity', 'claimedAtMs'
]));

/* WHY THE RECEIPT SAYS WHY, AND NOT JUST WHO.
 *
 * The delivery receipt is the ONLY durable trace a delivered message leaves:
 * recordDelivery splices the spool entry -- and with it the message that
 * carried the sender -- out of the state in the same commit that writes the
 * receipt. If the receipt records a bare null sender, a later read cannot tell
 * apart three completely different facts: that this build did not record
 * senders at all, that the message genuinely carried none, or that it carried
 * something that was not a usable identity. On 2026-09-06/07 six agent circles
 * stopped on an instruction that could not be attributed afterwards, and that
 * is the read that failed. So the receipt states its own provenance. */
const SENDER_READ_STATES = Object.freeze({
  RECORDED: 'RECORDED',
  ABSENT: 'ABSENT',
  UNUSABLE: 'UNUSABLE'
});

const WINDOWS_PROCESS_IDENTITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targetPid = [int]__TARGET_PID__
try {
  $target = [System.Diagnostics.Process]::GetProcessById($targetPid)
  try {
    $ticks = $target.StartTime.ToUniversalTime().Ticks
    [Console]::Out.Write('ALIVE:' + $ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture))
  } catch [System.InvalidOperationException] {
    [Console]::Out.Write('DEAD')
  } catch {
    [Console]::Out.Write('UNKNOWN')
  }
} catch [System.ArgumentException] {
  [Console]::Out.Write('DEAD')
} catch {
  [Console]::Out.Write('UNKNOWN')
}
`;

/* THE BUDGET IS A BOUND ON A HANG, NOT A LATENCY TARGET.
 *
 * MEASURED 2026-09-02 on Windows 10 with the fleet running: the first two
 * launches of powershell.exe in a fresh process cost 5.30 s and 5.31 s, and
 * every launch afterwards cost about 0.3 s. The image is cold once per
 * process, and this probe is the first thing a process asks -- so a five
 * second budget did not trim a slow answer, it timed out on the ONE probe
 * every process makes. The observation came back UNKNOWN and the send failed
 * closed with BROKER_DELIVERY_OWNERSHIP_UNKNOWN, which is the first local
 * agent message in every freshly started agent.
 *
 * Waiting longer costs nothing when the answer arrives in 300 ms, and the
 * answer is cached for this process's own pid, so the wait is paid at most
 * once. The number is here to stop a genuinely wedged PowerShell from
 * blocking a delivery forever, and that is all it is for. */
const PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 30_000;

let cachedSelfProcessStartIdentity = null;

function processIdentityObservation(status, processStartIdentity = null) {
  return Object.freeze({ status, processStartIdentity });
}

function validProcessStartIdentity(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_PROCESS_START_IDENTITY_LENGTH
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function windowsProcessIdentity(pid) {
  const systemRoot = typeof process.env.SystemRoot === 'string' && path.isAbsolute(process.env.SystemRoot)
    ? process.env.SystemRoot
    : 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = WINDOWS_PROCESS_IDENTITY_SCRIPT.replace('__TARGET_PID__', String(pid));
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  let result;
  try {
    // This child only asks the kernel for one process creation time. Provider
    // credentials and routing overrides have no reason to cross that process
    // boundary, and inheriting them here would make a read-only ownership
    // probe another credential-bearing launch surface.
    const { safeLaunchEnvironment } = require('../supervision/launch-environment.js');
    result = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None',
      '-EncodedCommand', encodedCommand
    ], {
      encoding: 'utf8',
      env: safeLaunchEnvironment(process.env, { context: 'agent-comms process identity PowerShell' }),
      windowsHide: true,
      timeout: PROCESS_IDENTITY_PROBE_TIMEOUT_MS,
      maxBuffer: 16 * 1024
    });
  } catch {
    return processIdentityObservation(PROCESS_IDENTITY_STATES.UNKNOWN);
  }
  if (!result || result.error || result.status !== 0) {
    return processIdentityObservation(PROCESS_IDENTITY_STATES.UNKNOWN);
  }
  const output = String(result.stdout || '').trim();
  if (output === 'DEAD') return processIdentityObservation(PROCESS_IDENTITY_STATES.DEAD);
  if (output === 'UNKNOWN') return processIdentityObservation(PROCESS_IDENTITY_STATES.UNKNOWN);
  const match = /^ALIVE:([0-9]+)$/.exec(output);
  if (!match) return processIdentityObservation(PROCESS_IDENTITY_STATES.UNKNOWN);
  return processIdentityObservation(PROCESS_IDENTITY_STATES.ALIVE, `windows-start-ticks:${match[1]}`);
}

function linuxProcessIdentity(pid) {
  let stat;
  let bootId;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ESRCH')) {
      return processIdentityObservation(PROCESS_IDENTITY_STATES.DEAD);
    }
    return processIdentityObservation(PROCESS_IDENTITY_STATES.UNKNOWN);
  }
  const commandEnd = stat.lastIndexOf(')');
  const fields = commandEnd >= 0 ? stat.slice(commandEnd + 1).trim().split(/\s+/) : [];
  const startTicks = fields[19];
  if (!/^[0-9]+$/.test(startTicks || '')
    || !/^[A-Fa-f0-9-]{8,64}$/.test(bootId)) {
    return processIdentityObservation(PROCESS_IDENTITY_STATES.UNKNOWN);
  }
  return processIdentityObservation(
    PROCESS_IDENTITY_STATES.ALIVE,
    `linux-proc-start:${bootId.toLowerCase()}:${startTicks}`
  );
}

function inspectProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return processIdentityObservation(PROCESS_IDENTITY_STATES.UNKNOWN);
  }
  if (pid === process.pid && cachedSelfProcessStartIdentity !== null) {
    return processIdentityObservation(PROCESS_IDENTITY_STATES.ALIVE, cachedSelfProcessStartIdentity);
  }
  const observed = process.platform === 'win32'
    ? windowsProcessIdentity(pid)
    : (process.platform === 'linux'
      ? linuxProcessIdentity(pid)
      : processIdentityObservation(PROCESS_IDENTITY_STATES.UNKNOWN));
  if (pid === process.pid && observed.status === PROCESS_IDENTITY_STATES.ALIVE
    && validProcessStartIdentity(observed.processStartIdentity)) {
    cachedSelfProcessStartIdentity = observed.processStartIdentity;
  }
  return observed;
}

function normalizeProcessIdentityObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return processIdentityObservation(PROCESS_IDENTITY_STATES.UNKNOWN);
  }
  if (value.status === PROCESS_IDENTITY_STATES.ALIVE
    && validProcessStartIdentity(value.processStartIdentity)) {
    return processIdentityObservation(PROCESS_IDENTITY_STATES.ALIVE, value.processStartIdentity);
  }
  if (value.status === PROCESS_IDENTITY_STATES.DEAD) {
    return processIdentityObservation(PROCESS_IDENTITY_STATES.DEAD);
  }
  return processIdentityObservation(PROCESS_IDENTITY_STATES.UNKNOWN);
}

function sleepSync(milliseconds) {
  if (milliseconds > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
}

class BrokerError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BrokerError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new BrokerError(code, message, cause);
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('BROKER_CONFIGURATION_INVALID', `${label} must be a safe integer in range.`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_IDENTIFIER_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    fail('BROKER_MESSAGE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function messageIdentifier(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.includes('\u0000')) {
    fail('BROKER_MESSAGE_INVALID', 'messageId is invalid.');
  }
  return value;
}

function normalizedFieldName(value) {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function canonicalData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') {
    fail('BROKER_MESSAGE_INVALID', 'message data must be JSON-compatible.');
  }
  if (seen.has(value)) fail('BROKER_MESSAGE_INVALID', 'message data may not contain cycles.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => canonicalData(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('BROKER_MESSAGE_INVALID', 'message data must contain only plain objects.');
    }
    const result = Object.create(null);
    const names = Reflect.ownKeys(value);
    if (names.some(name => typeof name !== 'string')) {
      fail('BROKER_MESSAGE_INVALID', 'message data may only contain string keys.');
    }
    for (const name of names.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail('BROKER_MESSAGE_INVALID', 'message data may not contain accessors.');
      }
      if (CREDENTIAL_FIELDS.has(normalizedFieldName(name))) {
        fail('BROKER_CREDENTIAL_FIELD_REFUSED', 'credential-bearing message fields are forbidden.');
      }
      result[name] = canonicalData(descriptor.value, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeMessage(input) {
  const message = canonicalData(input);
  let messageId;
  let recipientAgentId;
  let recipientMachineId = null;
  if (typeof message.messageId === 'string' && typeof message.recipientAgentId === 'string') {
    messageId = messageIdentifier(message.messageId);
    recipientAgentId = identifier(message.recipientAgentId, 'recipientAgentId');
    if (message.recipientMachineId !== undefined) {
      recipientMachineId = identifier(message.recipientMachineId, 'recipientMachineId');
    }
  } else if (typeof message.id === 'string'
    && message.audience
    && message.audience.type === 'direct'
    && message.audience.agent) {
    messageId = messageIdentifier(message.id);
    recipientAgentId = identifier(message.audience.agent.agentId, 'audience.agent.agentId');
    recipientMachineId = identifier(message.audience.agent.machineId, 'audience.agent.machineId');
  } else {
    fail('BROKER_MESSAGE_INVALID', 'message must carry a direct recipient and message id.');
  }
  const canonicalMessage = JSON.stringify(message);
  return Object.freeze({
    message: deepFreeze(message),
    messageId,
    recipientAgentId,
    recipientMachineId,
    canonicalMessage,
    fingerprint: crypto.createHash('sha256').update(canonicalMessage).digest('hex')
  });
}

/* Reads the sender identity off a spooled message for the delivery receipt.
 *
 * The message body is free-form by design (`message` is in SPOOL_ENTRY_KEYS but
 * nothing constrains its shape), so this reads defensively and NEVER throws:
 * attribution bookkeeping may not decide whether a message is delivered. A
 * sender that is missing and a sender that is present but unusable are reported
 * as different outcomes rather than folded into one null.
 *
 * Only the identity is taken. The body is deliberately left behind -- the
 * deliveries array is never pruned, so retaining bodies here would grow a
 * permanent on-disk copy of every message the fleet has ever sent. */
function senderOnReceipt(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || message.sender === undefined || message.sender === null) {
    return Object.freeze({
      senderAgentId: null,
      senderMachineId: null,
      senderReadState: SENDER_READ_STATES.ABSENT
    });
  }
  const sender = message.sender;
  const unusable = Object.freeze({
    senderAgentId: null,
    senderMachineId: null,
    senderReadState: SENDER_READ_STATES.UNUSABLE
  });
  if (typeof sender !== 'object' || Array.isArray(sender)) return unusable;
  let senderAgentId;
  let senderMachineId = null;
  try {
    senderAgentId = identifier(sender.agentId, 'sender.agentId');
    if (sender.machineId !== undefined && sender.machineId !== null) {
      senderMachineId = identifier(sender.machineId, 'sender.machineId');
    }
  } catch {
    return unusable;
  }
  return Object.freeze({
    senderAgentId,
    senderMachineId,
    senderReadState: SENDER_READ_STATES.RECORDED
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* Both deliveries and deadLetters are only ever appended to (push), never
 * reordered, so the front of either array is always the oldest entry -- the
 * one a retry is least likely to still need. Mutates in place, matching
 * history.js's own `records.shift()` retention loop, so a caller mid-mutation
 * (the constructor sweep, recordDelivery's commit) sees the trimmed array
 * without having to remember to reassign it. */
function trimOldest(list, maxLength) {
  while (list.length > maxLength) list.shift();
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every(key => keys.has(key));
}

function validStoredDeliveryClaim(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.hasOwn(value, 'holderProcessStartIdentity')
    ? DELIVERY_CLAIM_KEYS
    : LEGACY_DELIVERY_CLAIM_KEYS;
  return hasExactKeys(value, keys)
    && typeof value.claimId === 'string'
    && value.claimId.length >= 1
    && value.claimId.length <= MAX_IDENTIFIER_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.claimId)
    && Number.isSafeInteger(value.holderPid)
    && value.holderPid >= 1
    && Number.isSafeInteger(value.claimedAtMs)
    && value.claimedAtMs >= 0
    && (!Object.hasOwn(value, 'holderProcessStartIdentity')
      || validProcessStartIdentity(value.holderProcessStartIdentity));
}

function validateStoredPacketEntry(entry, nextSequence, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || !Object.keys(entry).every(key => SPOOL_ENTRY_KEYS.has(key))
    || ![...REQUIRED_SPOOL_ENTRY_KEYS].every(key => Object.hasOwn(entry, key))
    || !Number.isSafeInteger(entry.sequence)
    || entry.sequence < 1
    || entry.sequence >= nextSequence
    || !Number.isSafeInteger(entry.enqueuedAtMs)
    || entry.enqueuedAtMs < 0
    || typeof entry.fingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
    || (Object.hasOwn(entry, 'transportOutcome')
      && entry.transportOutcome !== TRANSPORT_OUTCOMES.UNCERTAIN)
    || (Object.hasOwn(entry, 'deliveryClaim')
      && !validStoredDeliveryClaim(entry.deliveryClaim))
    || (Object.hasOwn(entry, 'transportOutcome') && Object.hasOwn(entry, 'deliveryClaim'))) {
    fail('BROKER_STATE_CORRUPT', `${label} is invalid.`);
  }
  let normalized;
  try {
    normalized = normalizeMessage(entry.message);
    messageIdentifier(entry.messageId);
    identifier(entry.recipientAgentId, 'stored recipientAgentId');
    if (entry.recipientMachineId !== null) {
      identifier(entry.recipientMachineId, 'stored recipientMachineId');
    }
  } catch (error) {
    fail('BROKER_STATE_CORRUPT', `${label} message is invalid.`, error);
  }
  if (entry.messageId !== normalized.messageId
    || entry.recipientAgentId !== normalized.recipientAgentId
    || entry.recipientMachineId !== normalized.recipientMachineId
    || entry.fingerprint !== normalized.fingerprint) {
    fail('BROKER_STATE_CORRUPT', `${label} identity is invalid.`);
  }
  return normalized;
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    nextSequence: 1,
    spool: [],
    deliveries: [],
    deadLetters: [],
    deferred: [],
    wakeCooldowns: []
  };
}

function validateStoredState(value) {
  // Schema version 1 predates dead-letter storage. Preserve compatibility with
  // state written by that version while making every subsequent write explicit.
  if (value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === SCHEMA_VERSION && value.deadLetters === undefined) {
    value.deadLetters = [];
  }
  if (value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === SCHEMA_VERSION && value.deferred === undefined) {
    value.deferred = [];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(value.nextSequence)
    || value.nextSequence < 1
    || !Array.isArray(value.spool)
    || !Array.isArray(value.deliveries)
    || !Array.isArray(value.deadLetters)
    || !Array.isArray(value.deferred)
    || !Array.isArray(value.wakeCooldowns)) {
    fail('BROKER_STATE_CORRUPT', 'broker state is invalid.');
  }

  const packetMessageIds = new Set();
  const sequences = new Set();
  for (const entry of value.spool) {
    validateStoredPacketEntry(entry, value.nextSequence, 'stored spool entry');
    if (packetMessageIds.has(entry.messageId)
      || sequences.has(entry.sequence)) {
      fail('BROKER_STATE_CORRUPT', 'stored spool identity is invalid or duplicated.');
    }
    packetMessageIds.add(entry.messageId);
    sequences.add(entry.sequence);
  }

  // A packet can legitimately coexist with its delivery receipt after recovery
  // from an interrupted older write; createBroker prunes that packet on open.
  // Receipt IDs still must be unique within deliveries themselves.
  const deliveryMessageIds = new Set();
  const deliveriesByMessageId = new Map();
  for (const delivery of value.deliveries) {
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)
      || typeof delivery.fingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(delivery.fingerprint)
      || !Number.isSafeInteger(delivery.deliveredAtMs)
      || delivery.deliveredAtMs < 0) {
      fail('BROKER_STATE_CORRUPT', 'stored delivery receipt is invalid.');
    }
    if (Object.hasOwn(delivery, 'modelHandoffAtMs')
      && (!Number.isSafeInteger(delivery.modelHandoffAtMs) || delivery.modelHandoffAtMs < 0)) {
      fail('BROKER_STATE_CORRUPT', 'stored model handoff receipt is invalid.');
    }
    if (Object.hasOwn(delivery, 'modelHandoffRecovered')
      && (typeof delivery.modelHandoffRecovered !== 'boolean' || !Object.hasOwn(delivery, 'modelHandoffAtMs'))) {
      fail('BROKER_STATE_CORRUPT', 'stored model handoff recovery flag is invalid.');
    }
    try {
      messageIdentifier(delivery.messageId);
      identifier(delivery.recipientAgentId, 'stored recipientAgentId');
      if (delivery.recipientMachineId !== null && delivery.recipientMachineId !== undefined) {
        identifier(delivery.recipientMachineId, 'stored recipientMachineId');
      }
    } catch (error) {
      fail('BROKER_STATE_CORRUPT', 'stored delivery identity is invalid.', error);
    }
    /* Attribution is validated only when it is there. Receipts written before
     * senderOnReceipt existed carry none of these fields and are still real
     * delivery evidence -- refusing them would fail every send on this machine
     * with BROKER_STATE_CORRUPT over bookkeeping. What is checked is that a
     * receipt claiming to name a sender actually names a usable one, so the
     * RECORDED marker cannot be trusted over a null. */
    if (Object.hasOwn(delivery, 'senderReadState')
      || Object.hasOwn(delivery, 'senderAgentId')
      || Object.hasOwn(delivery, 'senderMachineId')) {
      const recorded = delivery.senderReadState === SENDER_READ_STATES.RECORDED;
      if (!Object.values(SENDER_READ_STATES).includes(delivery.senderReadState)) {
        fail('BROKER_STATE_CORRUPT', 'stored delivery sender read state is invalid.');
      }
      try {
        if (recorded) {
          identifier(delivery.senderAgentId, 'stored senderAgentId');
          if (delivery.senderMachineId !== null && delivery.senderMachineId !== undefined) {
            identifier(delivery.senderMachineId, 'stored senderMachineId');
          }
        } else if ((delivery.senderAgentId ?? null) !== null
          || (delivery.senderMachineId ?? null) !== null) {
          fail('BROKER_STATE_CORRUPT', 'stored delivery names a sender it did not record.');
        }
      } catch (error) {
        fail('BROKER_STATE_CORRUPT', 'stored delivery sender identity is invalid.', error);
      }
    }
    if (deliveryMessageIds.has(delivery.messageId)) {
      fail('BROKER_STATE_CORRUPT', 'stored delivery message identity is duplicated.');
    }
    deliveryMessageIds.add(delivery.messageId);
    deliveriesByMessageId.set(delivery.messageId, delivery);
  }

  // An exact packet/receipt overlap is an older recovery shape and is pruned
  // on open.  Sharing only the message id is not recovery evidence: dropping
  // a different fingerprint or recipient under that id silently loses an
  // undelivered packet.  Refuse the state before createBroker can prune it.
  for (const entry of value.spool) {
    const delivery = deliveriesByMessageId.get(entry.messageId);
    if (!delivery) continue;
    if (delivery.fingerprint !== entry.fingerprint
      || delivery.recipientAgentId !== entry.recipientAgentId
      || (delivery.recipientMachineId ?? null) !== (entry.recipientMachineId ?? null)) {
      fail('BROKER_STATE_CORRUPT',
        'stored spool packet conflicts with the delivery receipt carrying the same message identity.');
    }
  }

  for (const deadLetter of value.deadLetters) {
    if (!hasExactKeys(deadLetter, DEAD_LETTER_KEYS)
      || !Number.isSafeInteger(deadLetter.deadLetteredAtMs)
      || deadLetter.deadLetteredAtMs < 0
      || typeof deadLetter.reason !== 'string'
      || !DEAD_LETTER_REASONS.has(deadLetter.reason)) {
      fail('BROKER_STATE_CORRUPT', 'stored dead letter is invalid.');
    }
    const entry = deadLetter.entry;
    validateStoredPacketEntry(entry, value.nextSequence, 'stored dead-letter entry');
    if (packetMessageIds.has(entry.messageId)
      || deliveryMessageIds.has(entry.messageId)
      || sequences.has(entry.sequence)) {
      fail('BROKER_STATE_CORRUPT', 'stored dead-letter identity conflicts with another broker collection.');
    }
    packetMessageIds.add(entry.messageId);
    sequences.add(entry.sequence);
  }

  // Deferred model handoffs are pending work, not historical receipts. Keep
  // their full envelopes through history compaction and a retired address.
  // A matching transport receipt may coexist until its normal retention ends.
  for (const deferred of value.deferred) {
    if (!hasExactKeys(deferred, deferred && Object.hasOwn(deferred, 'waitingForModel') ? WAITING_DELIVERY_KEYS : DEFERRED_DELIVERY_KEYS)
      || (Object.hasOwn(deferred, 'waitingForModel') && typeof deferred.waitingForModel !== 'boolean')
      || !Number.isSafeInteger(deferred.deferredAtMs) || deferred.deferredAtMs < 0) {
      fail('BROKER_STATE_CORRUPT', 'stored deferred delivery is invalid.');
    }
    const entry = deferred.entry;
    validateStoredPacketEntry(entry, value.nextSequence, 'stored deferred delivery entry');
    const receipt = deliveriesByMessageId.get(entry.messageId);
    if (packetMessageIds.has(entry.messageId) || sequences.has(entry.sequence)
      || (receipt && (receipt.fingerprint !== entry.fingerprint
        || receipt.recipientAgentId !== entry.recipientAgentId
        || (receipt.recipientMachineId ?? null) !== (entry.recipientMachineId ?? null)
        || Object.hasOwn(receipt, 'modelHandoffAtMs')))) {
      fail('BROKER_STATE_CORRUPT', 'stored deferred delivery conflicts with another broker collection.');
    }
    packetMessageIds.add(entry.messageId);
    sequences.add(entry.sequence);
  }

  const wakeAgents = new Set();
  for (const wake of value.wakeCooldowns) {
    if (!wake || typeof wake !== 'object' || Array.isArray(wake)
      || !Number.isSafeInteger(wake.lastRequestedAtMs)
      || wake.lastRequestedAtMs < 0) {
      fail('BROKER_STATE_CORRUPT', 'stored wake cooldown is invalid.');
    }
    try { identifier(wake.agentId, 'stored agentId'); } catch (error) {
      fail('BROKER_STATE_CORRUPT', 'stored wake identity is invalid.', error);
    }
    if (wakeAgents.has(wake.agentId)) {
      fail('BROKER_STATE_CORRUPT', 'stored wake cooldown is duplicated.');
    }
    wakeAgents.add(wake.agentId);
  }
  return value;
}

function readState(stateFile) {
  let serialized;
  try {
    serialized = fs.readFileSync(stateFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyState();
    fail('BROKER_STATE_CORRUPT', 'broker state cannot be read.', error);
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized.replace(/^\uFEFF/, ''));
  } catch (error) {
    fail('BROKER_STATE_CORRUPT', 'broker state cannot be read.', error);
  }
  return validateStoredState(parsed);
}

/* TEMP-AND-RENAME IS NOT THE SAME AS DURABLE, AND A SIBLING FILE IN THIS SAME
 * DIRECTORY ALREADY PAID FOR THE DIFFERENCE.
 *
 * The rename below has always meant a reader never sees half a file. It does
 * NOT mean the bytes reached the disk: without an fsync, the rename can be
 * recorded while the data blocks it points at are still only in the cache, and
 * an unclean shutdown then leaves a file of the right LENGTH full of zeros.
 *
 * MEASURED 2026-09-03: tree-node-directory.js's own state file was found this
 * way on this machine -- 22,346 bytes of pure NUL -- and fixed in
 * 4b0a59d94566f307771d70fd67cbdecbfb2e1f96 by fsyncing before the rename. This
 * file is the broker's spool: every undelivered packet, dead letter and wake
 * cooldown for agent_comms.send_local lives only here between commits, and
 * unlike the tree directory (identity only) a torn write here destroys message
 * content with nothing left anywhere to reconstruct it from -- a message the
 * sender believes it sent, with no answer and no trace. This machine has a
 * recorded history of unclean power events, so the window this closes is not
 * theoretical here either.
 *
 * The handle is opened with 'wx' so a leftover temp from a dead process is
 * never silently written through, and the finally block removes the temp on
 * any failure rather than leaving litter beside the real file. fsyncSync is
 * called only when the injected filesystem offers it, matching
 * tree-node-directory.js and agent-presence.js: a test fake without it still
 * works and is not silently treated as durable. */
function writeState(stateFile, state) {
  const target = path.resolve(stateFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8' });
    if (typeof fs.fsyncSync === 'function') fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* atomic rename consumed it, or never created */ }
  }
}

function reclaimLegacyEmptyLock(lockFile, {
  fsImpl = fs,
  now = Date.now,
  staleMs = LEGACY_LOCK_STALE_MS,
  pid = process.pid,
  isAlive = lockPidAlive
} = {}) {
  let migrationLock;
  try { migrationLock = acquireLock(`${lockFile}.legacy-migration`, { pid, isAlive }); }
  catch { return false; }
  const quarantine = `${lockFile}.legacy.${pid}.${crypto.randomUUID()}.stale`;
  let removeQuarantine = false;
  try {
  let metadata;
  try {
    metadata = fsImpl.statSync(lockFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    return false;
  }
  // Builds before the PID lock wrote an empty file and left it forever after a
  // crash. A fresh empty file can still belong to an old live process, so only
  // the legacy shape after a generous age is recoverable. New locks always
  // carry a parseable holder and are reclaimed from positive PID liveness.
  if (!metadata || metadata.size !== 0 || !Number.isFinite(metadata.mtimeMs)
    || now() - metadata.mtimeMs <= staleMs) return false;
  try {
    fsImpl.renameSync(lockFile, quarantine);
    const moved = fsImpl.statSync(quarantine);
    if (moved.size !== 0 || !Number.isFinite(moved.mtimeMs) || now() - moved.mtimeMs <= staleMs) {
      try { fsImpl.renameSync(quarantine, lockFile); } catch { /* a replacement path wins */ }
      return false;
    }
    removeQuarantine = true;
    fsImpl.unlinkSync(quarantine);
    removeQuarantine = false;
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
  } finally {
    if (removeQuarantine) {
      try { fsImpl.unlinkSync(quarantine); } catch { /* absent or already consumed */ }
    }
    migrationLock.release();
  }
}

function withStateLock(stateFile, work, {
  pid = process.pid,
  isAlive = lockPidAlive,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  sleep = sleepSync,
  lockNow = Date.now
} = {}) {
  const target = path.resolve(stateFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lockFile = `${target}.lock`;
  const deadline = Date.now() + timeoutMs;
  let lock = null;
  let legacyRecoveryAttempted = false;
  while (!lock) {
    try {
      lock = acquireLock(lockFile, { pid, isAlive, sleep });
    } catch (error) {
      if (!legacyRecoveryAttempted && error && error.code === 'AGENT_DIGEST_LOCK_UNREADABLE'
        && reclaimLegacyEmptyLock(lockFile, { now: lockNow, pid, isAlive })) {
        legacyRecoveryAttempted = true;
        continue;
      }
      if (error && error.code === 'AGENT_DIGEST_ALREADY_RUNNING' && Date.now() < deadline) {
        sleep(25);
        continue;
      }
      if (error && error.code === 'AGENT_DIGEST_ALREADY_RUNNING') {
        fail('BROKER_STATE_LOCKED', 'broker state is owned by another mutation; failing closed.', error);
      }
      if (error && error.code === 'AGENT_DIGEST_LOCK_UNREADABLE') {
        // An unreadable lock is not permission to take it: it may be a live
        // holder publishing the PID or an older holder's opaque lock shape.
        // At this boundary both facts mean the broker state is locked, while
        // the stale-empty compatibility case above remains the sole reclaim.
        fail('BROKER_STATE_LOCKED', 'broker state lock ownership is indeterminate; failing closed.', error);
      }
      fail('BROKER_STATE_UNAVAILABLE', 'broker state lock cannot be acquired.', error);
    }
  }
  try {
    return work(target);
  } finally {
    lock.release();
  }
}

function knownAgent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('BROKER_CONFIGURATION_INVALID', 'known agent must be a data object.');
  }
  const keys = Object.keys(input).sort();
  const basicKeys = ['agentId', 'route', 'sessionId'];
  const machineKeys = ['agentId', 'machineId', 'route', 'sessionId'];
  const validKeys = [basicKeys, machineKeys]
    .some(expected => keys.length === expected.length && keys.every((key, index) => key === expected[index]));
  if (!validKeys) {
    fail('BROKER_CONFIGURATION_INVALID', 'known agent keys are invalid.');
  }
  let agentId;
  let sessionId;
  let machineId = null;
  try {
    agentId = identifier(input.agentId, 'agentId');
    sessionId = identifier(input.sessionId, 'sessionId');
    if (input.machineId !== undefined) machineId = identifier(input.machineId, 'machineId');
  } catch (error) {
    fail('BROKER_CONFIGURATION_INVALID', 'known agent identity is invalid.', error);
  }
  if (!Object.values(ROUTES).includes(input.route)) {
    fail('BROKER_CONFIGURATION_INVALID', 'known agent route is invalid.');
  }
  return Object.freeze({ agentId, machineId, sessionId, route: input.route });
}

function resolveWakeCaller(wakePort) {
  if (wakePort === null || wakePort === undefined) return null;
  if (typeof wakePort === 'function') return wakePort;
  if (!wakePort || typeof wakePort !== 'object') {
    fail('BROKER_CONFIGURATION_INVALID', 'wakePort must be an injected function or port object.');
  }
  for (const method of ['request', 'requestWake', 'handleWakeRequest', 'handle']) {
    if (typeof wakePort[method] === 'function') return wakePort[method].bind(wakePort);
  }
  fail('BROKER_CONFIGURATION_INVALID', 'wakePort does not expose a wake request method.');
}

function immutableResult(value) {
  return deepFreeze(value);
}

function createBroker({
  stateFile,
  knownAgents = [],
  transport,
  livenessReceiver,
  wakePort = null,
  wakeCooldownMs = DEFAULT_WAKE_COOLDOWN_MS,
  deliveryRetention = DEFAULT_DELIVERY_RETENTION,
  deadLetterRetention = DEFAULT_DEAD_LETTER_RETENTION,
  retainModelHandoffs = false,
  now = Date.now,
  pid = process.pid,
  isProcessAlive = lockPidAlive,
  processIdentity = inspectProcessIdentity,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockSleep = sleepSync,
  lockNow = Date.now,
  randomUUID = crypto.randomUUID
} = {}) {
  if (typeof stateFile !== 'string' || stateFile.length < 1
    || typeof retainModelHandoffs !== 'boolean'
    || !Array.isArray(knownAgents)
    || !transport || typeof transport.deliver !== 'function'
    || !livenessReceiver || typeof livenessReceiver.getAgent !== 'function'
    || typeof now !== 'function'
    || !Number.isSafeInteger(pid) || pid < 1
    || typeof isProcessAlive !== 'function'
    || typeof processIdentity !== 'function'
    || typeof lockSleep !== 'function'
    || typeof lockNow !== 'function'
    || typeof randomUUID !== 'function') {
    fail('BROKER_CONFIGURATION_INVALID', 'stateFile, knownAgents, transport, livenessReceiver, and now are required.');
  }
  safeInteger(wakeCooldownMs, 'wakeCooldownMs', { min: 1, max: 86_400_000 });
  safeInteger(deliveryRetention, 'deliveryRetention', { min: 1, max: 1_000_000 });
  safeInteger(deadLetterRetention, 'deadLetterRetention', { min: 1, max: 1_000_000 });
  safeInteger(lockTimeoutMs, 'lockTimeoutMs', { min: 0, max: 60_000 });
  const brokerInstanceId = String(randomUUID());
  if (!/^[A-Za-z0-9-]{8,128}$/.test(brokerInstanceId)) {
    fail('BROKER_CONFIGURATION_INVALID', 'randomUUID returned an invalid broker instance id.');
  }
  const lockOptions = Object.freeze({
    pid,
    isAlive: isProcessAlive,
    timeoutMs: lockTimeoutMs,
    sleep: lockSleep,
    lockNow
  });
  const wakeCaller = resolveWakeCaller(wakePort);
  const directory = new Map();
  for (const configured of knownAgents.map(knownAgent)) {
    if (directory.has(configured.agentId)) {
      fail('BROKER_CONFIGURATION_INVALID', 'known agent ids must be unique.');
    }
    directory.set(configured.agentId, configured);
  }

  function observeProcess(targetPid, sweepCache) {
    if (sweepCache && sweepCache.has(targetPid)) return sweepCache.get(targetPid);
    let observation;
    try {
      observation = normalizeProcessIdentityObservation(processIdentity(targetPid));
    } catch {
      observation = processIdentityObservation(PROCESS_IDENTITY_STATES.UNKNOWN);
    }
    if (sweepCache) sweepCache.set(targetPid, observation);
    return observation;
  }

  function abandonDeliveryClaim(entry) {
    entry.transportOutcome = TRANSPORT_OUTCOMES.UNCERTAIN;
    delete entry.deliveryClaim;
    return 'UNCERTAIN';
  }

  /* sweepCache, WHEN GIVEN, IS GOOD FOR EXACTLY ONE SYNCHRONOUS PASS OVER THE
   * SPOOL -- NEVER ACROSS TWO CALLS INTO THE BROKER.
   *
   * MEASURED against this installation's local-broker.json: a single crashed
   * process can hold the deliveryClaim on several spool entries at once (a
   * batch of sends it had reserved but not yet recorded when it died), and
   * the constructor sweep below calls this once per SPOOL ENTRY. Before this
   * cache existed, N entries claimed by the same dead pid cost N identical
   * process-identity probes -- each a real spawnSync of powershell.exe
   * (PROCESS_IDENTITY_PROBE_TIMEOUT_MS above), 5.3 s apiece for the first two
   * spawns in a process and about 0.3 s after that -- to relearn the exact
   * same DEAD/ALIVE/UNKNOWN answer N times, entirely on the critical path of
   * whichever agent_comms.send_local call happened to rebuild this broker.
   * Nothing about that pid can change between two entries in one synchronous
   * loop, so the second and later asks are answered from the first, and the
   * verdict this construction pass produces is unchanged either way.
   *
   * reserveDelivery below calls this with NO cache and must keep doing so: it
   * re-checks a claim at the moment it is about to act on it, which can be
   * long after this broker was built, and "reserve re-evaluates a foreign
   * claim under the state lock before transport" (broker-state-recovery.test)
   * exists specifically to catch a stale answer reused there. */
  function reconcileDeliveryClaim(entry, sweepCache) {
    const claim = entry.deliveryClaim;
    if (!claim) return 'NONE';
    // Version-one claims did not bind the PID to a process generation. They
    // can never authorize another external attempt because a live PID may be
    // a recycled process and the original attempt may already have landed.
    if (!Object.hasOwn(claim, 'holderProcessStartIdentity')) {
      return abandonDeliveryClaim(entry);
    }
    // ACTIVE_DELIVERY_CLAIMS is process-local proof that this exact broker
    // invocation still owns an in-flight attempt. A claim naming this PID but
    // lacking that proof is necessarily an interrupted local attempt.
    if (claim.holderPid === pid && !ACTIVE_DELIVERY_CLAIMS.has(claim.claimId)) {
      return abandonDeliveryClaim(entry);
    }
    const observation = observeProcess(claim.holderPid, sweepCache);
    if (observation.status === PROCESS_IDENTITY_STATES.UNKNOWN) return 'UNKNOWN';
    if (observation.status === PROCESS_IDENTITY_STATES.DEAD
      || observation.processStartIdentity !== claim.holderProcessStartIdentity) {
      return abandonDeliveryClaim(entry);
    }
    return 'ACTIVE';
  }

  withStateLock(stateFile, target => {
    const initial = clone(readState(target));
    const deliveredIds = new Set(initial.deliveries.map(delivery => delivery.messageId));
    const retained = [];
    let openedAtMs = null;
    // One synchronous sweep, so entries sharing a holder pid share one probe.
    // See the comment on reconcileDeliveryClaim for why this cache must never
    // outlive this single pass.
    const sweepObservations = new Map();
    for (const deadLetter of initial.deadLetters) {
      if (deadLetter.entry.deliveryClaim) {
        // Older builds could dead-letter a packet while another broker held
        // its claim. Keep the dead letter, but preserve the side effect as
        // uncertain and remove the now-meaningless ownership record.
        deadLetter.entry.transportOutcome = TRANSPORT_OUTCOMES.UNCERTAIN;
        delete deadLetter.entry.deliveryClaim;
      }
    }
    for (const entry of initial.spool) {
      if (deliveredIds.has(entry.messageId)) continue;
      if (entry.deliveryClaim) {
        const disposition = reconcileDeliveryClaim(entry, sweepObservations);
        // A matching live generation or an identity that cannot be observed
        // remains exclusively owned. In particular, recipient-directory
        // changes may not dead-letter a packet while its transport is active.
        if (disposition === 'ACTIVE' || disposition === 'UNKNOWN') {
          retained.push(entry);
          continue;
        }
      }
      const recipient = directory.get(entry.recipientAgentId);
      if (!recipient
        || (entry.recipientMachineId !== null
          && entry.recipientMachineId !== undefined
          && recipient.machineId !== null
          && entry.recipientMachineId !== recipient.machineId)) {
        if (openedAtMs === null) {
          openedAtMs = now();
          if (!Number.isSafeInteger(openedAtMs) || openedAtMs < 0) {
            fail('BROKER_CLOCK_INVALID', 'clock returned an invalid time.');
          }
        }
        initial.deadLetters.push({
          deadLetteredAtMs: openedAtMs,
          reason: 'RECIPIENT_NOT_IN_DIRECTORY',
          entry
        });
        continue;
      }
      retained.push(entry);
    }
    initial.spool = retained;
    // Compact on every open, not only on the next delivery: an installation
    // that already grew its history past the cap (or had a lower cap in an
    // earlier build) is trimmed back down here instead of needing a separate
    // migration, exactly as history.js's own retention is enforced on the
    // append path it already owns.
    trimOldest(initial.deliveries, deliveryRetention);
    trimOldest(initial.deadLetters, deadLetterRetention);
    writeState(target, initial);
  }, lockOptions);

  function currentTime() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('BROKER_CLOCK_INVALID', 'clock returned an invalid time.');
    }
    return value;
  }

  function commit(mutator) {
    return withStateLock(stateFile, target => {
      const next = clone(readState(target));
      const result = mutator(next);
      validateStoredState(next);
      writeState(target, next);
      return result;
    }, lockOptions);
  }

  function stateSnapshot() {
    return clone(readState(path.resolve(stateFile)));
  }

  function presenceOf(agent, atMs) {
    let view;
    try {
      view = livenessReceiver.getAgent(agent.agentId, agent.sessionId, atMs);
    } catch {
      return Object.freeze({ measured: false, reachable: false, sleeping: false });
    }
    const fresh = Boolean(view && view.freshness === 'FRESH');
    const running = fresh && view.state === STATES.RUNNING;
    const sleeping = fresh && view.state === STATES.IDLE;
    return Object.freeze({
      measured: true,
      reachable: agent.route === ROUTES.LOCAL || running || sleeping,
      sleeping
    });
  }

  function reserveWake(agent, sequence, atMs) {
    return commit(next => {
      let cooldown = next.wakeCooldowns.find(item => item.agentId === agent.agentId);
      if (cooldown && atMs - cooldown.lastRequestedAtMs < wakeCooldownMs) {
        return Object.freeze({ reserved: false, code: 'BROKER_WAKE_COOLDOWN' });
      }
      if (!cooldown) {
        cooldown = { agentId: agent.agentId, lastRequestedAtMs: atMs };
        next.wakeCooldowns.push(cooldown);
        next.wakeCooldowns.sort((left, right) => left.agentId.localeCompare(right.agentId));
      } else {
        cooldown.lastRequestedAtMs = atMs;
      }
      const digest = crypto.createHash('sha256')
        .update(`${agent.agentId}\u0000${agent.sessionId}\u0000${sequence}\u0000${atMs}`)
        .digest('hex')
        .slice(0, 32);
      return Object.freeze({ reserved: true, requestId: `broker-${digest}` });
    });
  }

  async function maybeWake(agent, sequence, atMs) {
    if (!wakeCaller) {
      return immutableResult({ requested: false, accepted: false, executed: false, code: 'BROKER_WAKE_PORT_UNAVAILABLE' });
    }
    const reservation = reserveWake(agent, sequence, atMs);
    if (!reservation.reserved) {
      return immutableResult({ requested: false, accepted: false, executed: false, code: reservation.code });
    }
    const request = Object.freeze({
      requestId: reservation.requestId,
      agentId: agent.agentId,
      sessionId: agent.sessionId,
      action: 'resume',
      issuedAtMs: atMs
    });
    let outcome;
    try {
      outcome = await wakeCaller(request);
    } catch {
      return immutableResult({ requested: true, accepted: null, executed: null, code: 'BROKER_WAKE_PORT_FAILED' });
    }
    const accepted = Boolean(outcome && outcome.accepted === true);
    const executed = Boolean(outcome && outcome.executed === true);
    const code = outcome && typeof outcome.code === 'string'
      ? outcome.code
      : (accepted ? 'BROKER_WAKE_ACCEPTED' : 'BROKER_WAKE_REFUSED');
    return immutableResult({ requested: true, accepted, executed, code, request });
  }

  function enqueue(normalized, atMs) {
    return commit(next => {
      const deadLetter = next.deadLetters.find(item => item.entry.messageId === normalized.messageId);
      if (deadLetter) {
        if (deadLetter.reason === 'RECIPIENT_QUEUE_DISCARDED'
          && deadLetter.entry.fingerprint === normalized.fingerprint) {
          return Object.freeze({ accepted: false, code: 'BROKER_MESSAGE_DEAD_LETTERED', reason: deadLetter.reason });
        }
        return Object.freeze({ accepted: false, code: 'BROKER_MESSAGE_ID_CONFLICT' });
      }
      const delivered = next.deliveries.find(item => item.messageId === normalized.messageId);
      if (delivered) {
        if (delivered.fingerprint !== normalized.fingerprint) {
          return Object.freeze({ accepted: false, code: 'BROKER_MESSAGE_ID_CONFLICT' });
        }
        return Object.freeze({ accepted: true, delivered: true, replayed: true });
      }
      const deferred = next.deferred.find(item => item.entry.messageId === normalized.messageId);
      if (deferred) {
        return Object.freeze(deferred.entry.fingerprint === normalized.fingerprint
          ? { accepted: true, delivered: true, replayed: true }
          : { accepted: false, code: 'BROKER_MESSAGE_ID_CONFLICT' });
      }
      const queued = next.spool.find(item => item.messageId === normalized.messageId);
      if (queued) {
        if (queued.fingerprint !== normalized.fingerprint) {
          return Object.freeze({ accepted: false, code: 'BROKER_MESSAGE_ID_CONFLICT' });
        }
        return Object.freeze({ accepted: true, delivered: false, replayed: true, sequence: queued.sequence });
      }
      const sequence = next.nextSequence;
      next.nextSequence += 1;
      next.spool.push({
        sequence,
        messageId: normalized.messageId,
        recipientAgentId: normalized.recipientAgentId,
        recipientMachineId: normalized.recipientMachineId,
        fingerprint: normalized.fingerprint,
        enqueuedAtMs: atMs,
        message: clone(normalized.message)
      });
      return Object.freeze({ accepted: true, delivered: false, replayed: false, sequence });
    });
  }

  function reserveDelivery(entry, claimedAtMs) {
    const claimId = `${brokerInstanceId}-${String(randomUUID())}`;
    if (!/^[A-Za-z0-9-]{17,128}$/.test(claimId)) {
      fail('BROKER_CONFIGURATION_INVALID', 'randomUUID returned an invalid delivery claim id.');
    }
    const reservation = commit(next => {
      const current = next.spool.find(item => item.messageId === entry.messageId);
      if (!current) {
        const prior = next.deliveries.find(item => item.messageId === entry.messageId);
        return Object.freeze({ reserved: false, alreadyDelivered: Boolean(prior) });
      }
      if (current.fingerprint !== entry.fingerprint) {
        fail('BROKER_STATE_CORRUPT', 'spooled message changed before delivery reservation.');
      }
      if (current.transportOutcome === TRANSPORT_OUTCOMES.UNCERTAIN) {
        return Object.freeze({ reserved: false, uncertain: true });
      }
      if (current.deliveryClaim) {
        const disposition = reconcileDeliveryClaim(current);
        if (disposition === 'UNCERTAIN') {
          return Object.freeze({ reserved: false, uncertain: true });
        }
        if (disposition === 'UNKNOWN') {
          return Object.freeze({ reserved: false, ownershipUnknown: true });
        }
        return Object.freeze({ reserved: false, inProgress: true });
      }
      const self = observeProcess(pid);
      if (self.status !== PROCESS_IDENTITY_STATES.ALIVE) {
        return Object.freeze({ reserved: false, ownershipUnknown: true });
      }
      current.deliveryClaim = {
        claimId,
        holderPid: pid,
        holderProcessStartIdentity: self.processStartIdentity,
        claimedAtMs
      };
      return Object.freeze({ reserved: true, claimId });
    });
    if (reservation.reserved) ACTIVE_DELIVERY_CLAIMS.add(claimId);
    return reservation;
  }

  function releaseDeliveryClaim(entry, claimId) {
    const released = commit(next => {
      const current = next.spool.find(item => item.messageId === entry.messageId);
      if (!current) {
        const prior = next.deliveries.find(item => item.messageId === entry.messageId);
        return Object.freeze({ released: false, alreadyDelivered: Boolean(prior) });
      }
      if (current.fingerprint !== entry.fingerprint) {
        fail('BROKER_STATE_CORRUPT', 'spooled message changed while releasing its delivery claim.');
      }
      if (!current.deliveryClaim || current.deliveryClaim.claimId !== claimId) {
        return Object.freeze({ released: false, claimLost: true });
      }
      delete current.deliveryClaim;
      return Object.freeze({ released: true, alreadyDelivered: false });
    });
    return released;
  }

  function recordDelivery(entry, deliveredAtMs, claimId) {
    const recorded = commit(next => {
      const index = next.spool.findIndex(item => item.messageId === entry.messageId);
      if (index < 0) {
        const prior = next.deliveries.find(item => item.messageId === entry.messageId);
        return Object.freeze({ recorded: false, alreadyRecorded: Boolean(prior) });
      }
      const current = next.spool[index];
      if (current.fingerprint !== entry.fingerprint) {
        fail('BROKER_STATE_CORRUPT', 'spooled message changed during delivery.');
      }
      if (!current.deliveryClaim || current.deliveryClaim.claimId !== claimId) {
        return Object.freeze({ recorded: false, alreadyRecorded: false, claimLost: true });
      }
      // Read the sender BEFORE the splice: the spooled message is the last
      // place it exists, and the line below destroys it.
      const attribution = senderOnReceipt(current.message);
      next.spool.splice(index, 1);
      next.deliveries.push({
        messageId: entry.messageId,
        recipientAgentId: entry.recipientAgentId,
        recipientMachineId: entry.recipientMachineId ?? null,
        fingerprint: entry.fingerprint,
        deliveredAtMs,
        senderAgentId: attribution.senderAgentId,
        senderMachineId: attribution.senderMachineId,
        senderReadState: attribution.senderReadState
      });
      if (retainModelHandoffs && directory.get(entry.recipientAgentId)?.route === ROUTES.LOCAL) {
        // Transport delivery reaches the inbox, not the model. Hold the exact
        // envelope atomically with that receipt, before history compaction or
        // a process exit can remove the only proof available at retirement.
        const { deliveryClaim: _claim, transportOutcome: _outcome, ...packet } = current;
        next.deferred.push({ deferredAtMs: deliveredAtMs, waitingForModel: true, entry: clone(packet) });
      }
      // See DEFAULT_DELIVERY_RETENTION above: this is what keeps the file
      // from growing by one more receipt, forever, on every single delivery
      // this installation will ever make.
      trimOldest(next.deliveries, deliveryRetention);
      return Object.freeze({ recorded: true, alreadyRecorded: false });
    });
    return recorded;
  }

  // An uncertain transport outcome is durable negative permission: neither a
  // later send replay nor a drain may call the transport again.  The message
  // remains SENT because an uncertain attempt is not delivery evidence.
  function recordTransportUncertain(entry, claimId) {
    const recorded = commit(next => {
      const current = next.spool.find(item => item.messageId === entry.messageId);
      if (!current) {
        const prior = next.deliveries.find(item => item.messageId === entry.messageId);
        return Object.freeze({ recorded: false, alreadyDelivered: Boolean(prior) });
      }
      if (current.fingerprint !== entry.fingerprint) {
        fail('BROKER_STATE_CORRUPT', 'spooled message changed during an uncertain delivery attempt.');
      }
      if (!current.deliveryClaim || current.deliveryClaim.claimId !== claimId) {
        return Object.freeze({ recorded: false, alreadyDelivered: false, claimLost: true });
      }
      current.transportOutcome = TRANSPORT_OUTCOMES.UNCERTAIN;
      delete current.deliveryClaim;
      return Object.freeze({ recorded: true, alreadyDelivered: false });
    });
    return recorded;
  }

  async function deliverEntry(entry, agent, wake) {
    const reservation = reserveDelivery(entry, currentTime());
    if (!reservation.reserved) {
      if (reservation.alreadyDelivered) {
        return immutableResult({
          messageId: entry.messageId,
          state: DELIVERY_STATES.DELIVERED,
          delivered: true,
          attempted: false,
          code: 'BROKER_DELIVERY_REPLAY',
          wake
        });
      }
      if (reservation.uncertain) {
        return immutableResult({
          messageId: entry.messageId,
          state: DELIVERY_STATES.SENT,
          delivered: false,
          attempted: false,
          outcome: TRANSPORT_OUTCOMES.UNCERTAIN,
          retryable: false,
          code: 'BROKER_TRANSPORT_UNCERTAIN',
          transportCode: 'BROKER_TRANSPORT_UNCERTAIN',
          wake
        });
      }
      if (reservation.ownershipUnknown) {
        return immutableResult({
          messageId: entry.messageId,
          state: DELIVERY_STATES.SENT,
          delivered: false,
          attempted: false,
          retryable: false,
          code: 'BROKER_DELIVERY_OWNERSHIP_UNKNOWN',
          wake
        });
      }
      return immutableResult({
        messageId: entry.messageId,
        state: DELIVERY_STATES.SENT,
        delivered: false,
        attempted: false,
        code: 'BROKER_DELIVERY_IN_PROGRESS',
        wake
      });
    }
    try {
      const attempt = immutableResult({
        route: agent.route,
        recipient: {
          agentId: agent.agentId,
          machineId: agent.machineId,
          sessionId: agent.sessionId
        },
        messageId: entry.messageId,
        idempotencyKey: entry.messageId,
        sequence: entry.sequence,
        message: clone(entry.message)
      });
      let receipt;
      try {
        receipt = await transport.deliver(attempt);
      } catch (error) {
        const uncertain = Boolean(error && error.outcome === TRANSPORT_OUTCOMES.UNCERTAIN);
        if (uncertain) {
          const preserved = recordTransportUncertain(entry, reservation.claimId);
          if (!preserved.recorded && !preserved.alreadyDelivered) {
            fail('BROKER_STATE_CORRUPT', 'uncertain transport outcome could not be preserved.');
          }
        } else {
          const released = releaseDeliveryClaim(entry, reservation.claimId);
          if (!released.released && !released.alreadyDelivered) {
            fail('BROKER_STATE_CORRUPT', 'failed transport delivery claim could not be released.');
          }
        }
        return immutableResult({
          messageId: entry.messageId,
          state: DELIVERY_STATES.SENT,
          delivered: false,
          attempted: true,
          outcome: uncertain ? TRANSPORT_OUTCOMES.UNCERTAIN : TRANSPORT_OUTCOMES.FAILED,
          retryable: uncertain ? false : Boolean(!error || error.retryable !== false),
          code: 'BROKER_TRANSPORT_FAILED',
          transportCode: uncertain ? 'BROKER_TRANSPORT_UNCERTAIN' : 'BROKER_TRANSPORT_FAILED',
          wake
        });
      }
      if (!receipt || receipt.delivered !== true || receipt.messageId !== entry.messageId) {
        const released = releaseDeliveryClaim(entry, reservation.claimId);
        if (!released.released && !released.alreadyDelivered) {
          fail('BROKER_STATE_CORRUPT', 'unconfirmed transport delivery claim could not be released.');
        }
        return immutableResult({
          messageId: entry.messageId,
          state: DELIVERY_STATES.SENT,
          delivered: false,
          attempted: true,
          code: 'BROKER_TRANSPORT_UNCONFIRMED',
          wake
        });
      }
      const completed = recordDelivery(entry, currentTime(), reservation.claimId);
      if (!completed.recorded && !completed.alreadyRecorded) {
        fail('BROKER_STATE_CORRUPT', 'delivery receipt could not be recorded.');
      }
      return immutableResult({
        messageId: entry.messageId,
        state: DELIVERY_STATES.DELIVERED,
        delivered: true,
        attempted: true,
        code: completed.recorded ? 'BROKER_DELIVERED' : 'BROKER_DELIVERY_REPLAY',
        wake
      });
    } finally {
      // Reservation ownership is process-local and must not outlive this
      // invocation even when a post-transport clock or state commit throws.
      ACTIVE_DELIVERY_CLAIMS.delete(reservation.claimId);
    }
  }

  async function drainInternal(agentId = null) {
    const snapshot = stateSnapshot();
    const entries = snapshot.spool
      .filter(entry => agentId === null || entry.recipientAgentId === agentId)
      .sort((left, right) => left.sequence - right.sequence);
    const blocked = new Set();
    const results = [];
    let attempts = 0;
    let delivered = 0;

    for (const entry of entries) {
      if (entry.transportOutcome === TRANSPORT_OUTCOMES.UNCERTAIN) {
        blocked.add(entry.recipientAgentId);
        results.push(immutableResult({
          messageId: entry.messageId,
          state: DELIVERY_STATES.SENT,
          delivered: false,
          attempted: false,
          outcome: TRANSPORT_OUTCOMES.UNCERTAIN,
          retryable: false,
          code: 'BROKER_TRANSPORT_UNCERTAIN',
          transportCode: 'BROKER_TRANSPORT_UNCERTAIN',
          wake: null
        }));
        continue;
      }
      const agent = directory.get(entry.recipientAgentId);
      if (!agent
        || (entry.recipientMachineId !== null
          && entry.recipientMachineId !== undefined
          && agent.machineId !== null
          && entry.recipientMachineId !== agent.machineId)) {
        blocked.add(entry.recipientAgentId);
        results.push(immutableResult({
          messageId: entry.messageId,
          state: DELIVERY_STATES.SENT,
          delivered: false,
          attempted: false,
          code: 'BROKER_AGENT_UNKNOWN',
          wake: null
        }));
        continue;
      }
      if (blocked.has(agent.agentId)) {
        results.push(immutableResult({
          messageId: entry.messageId,
          state: DELIVERY_STATES.SENT,
          delivered: false,
          attempted: false,
          code: 'BROKER_ORDER_BLOCKED',
          wake: null
        }));
        continue;
      }

      const atMs = currentTime();
      const presence = presenceOf(agent, atMs);
      if (!presence.measured) {
        blocked.add(agent.agentId);
        results.push(immutableResult({
          messageId: entry.messageId,
          state: DELIVERY_STATES.SENT,
          delivered: false,
          attempted: false,
          code: 'BROKER_LIVENESS_UNAVAILABLE',
          wake: null
        }));
        continue;
      }
      const wake = presence.sleeping ? await maybeWake(agent, entry.sequence, atMs) : null;
      // A fresh IDLE report proves presence, not readiness to consume.  The
      // wake contract is the readiness gate; a refusal or failed execution is
      // never delivery evidence and must leave the entry durably SENT.
      if (presence.sleeping && (!wake || wake.accepted !== true || wake.executed !== true)) {
        blocked.add(agent.agentId);
        results.push(immutableResult({
          messageId: entry.messageId,
          state: DELIVERY_STATES.SENT,
          delivered: false,
          attempted: false,
          code: 'BROKER_WAKE_NOT_EXECUTED',
          wake
        }));
        continue;
      }
      if (!presence.reachable) {
        blocked.add(agent.agentId);
        results.push(immutableResult({
          messageId: entry.messageId,
          state: DELIVERY_STATES.SENT,
          delivered: false,
          attempted: false,
          code: 'BROKER_PEER_UNREACHABLE',
          wake
        }));
        continue;
      }

      const result = await deliverEntry(entry, agent, wake);
      results.push(result);
      attempts += 1;
      if (result.delivered) delivered += 1;
      else blocked.add(agent.agentId);
    }

    const remaining = stateSnapshot().spool
      .filter(entry => agentId === null || entry.recipientAgentId === agentId)
      .length;
    return immutableResult({
      code: 'BROKER_DRAIN_COMPLETE',
      attempted: attempts,
      delivered,
      remaining,
      results
    });
  }

  let operationTail = Promise.resolve();
  function serialize(operation) {
    const next = operationTail.then(operation, operation);
    operationTail = next.catch(() => {});
    return next;
  }

  async function sendInternal(input) {
    let normalized;
    try {
      normalized = normalizeMessage(input);
    } catch (error) {
      const code = error instanceof BrokerError ? error.code : 'BROKER_MESSAGE_INVALID';
      return immutableResult({
        accepted: false,
        code,
        state: null,
        delivered: false,
        spooled: false
      });
    }
    const recipient = directory.get(normalized.recipientAgentId);
    if (!recipient
      || (normalized.recipientMachineId !== null
        && recipient.machineId !== null
        && normalized.recipientMachineId !== recipient.machineId)) {
      return immutableResult({
        accepted: false,
        code: 'BROKER_AGENT_UNKNOWN',
        state: null,
        delivered: false,
        spooled: false,
        messageId: normalized.messageId
      });
    }

    const queued = enqueue(normalized, currentTime());
    if (!queued.accepted) {
      return immutableResult({
        accepted: false,
        code: queued.code,
        ...(queued.reason ? { reason: queued.reason } : {}),
        state: null,
        delivered: false,
        spooled: false,
        messageId: normalized.messageId
      });
    }
    if (queued.delivered) {
      return immutableResult({
        accepted: true,
        code: 'BROKER_DELIVERY_REPLAY',
        state: DELIVERY_STATES.DELIVERED,
        delivered: true,
        spooled: false,
        replayed: true,
        messageId: normalized.messageId,
        wake: null
      });
    }

    const drainResult = await drainInternal(normalized.recipientAgentId);
    const messageResult = drainResult.results.find(item => item.messageId === normalized.messageId);
    if (messageResult && messageResult.delivered) {
      return immutableResult({
        accepted: true,
        code: messageResult.code,
        state: DELIVERY_STATES.DELIVERED,
        delivered: true,
        spooled: false,
        replayed: queued.replayed,
        messageId: normalized.messageId,
        wake: messageResult.wake
      });
    }
    return immutableResult({
      accepted: true,
      code: messageResult ? messageResult.code : 'BROKER_SPOOLED',
      state: DELIVERY_STATES.SENT,
      delivered: false,
      spooled: true,
      replayed: queued.replayed,
      messageId: normalized.messageId,
      wake: messageResult ? messageResult.wake : null,
      ...(messageResult && messageResult.outcome ? {
        outcome: messageResult.outcome,
        retryable: messageResult.retryable,
        transportCode: messageResult.transportCode
      } : {})
    });
  }

  function send(message) {
    return serialize(() => sendInternal(message));
  }

  function drain(agentId = null) {
    if (agentId !== null) {
      try { identifier(agentId, 'agentId'); } catch (error) { return Promise.reject(error); }
    }
    return serialize(() => drainInternal(agentId));
  }

  // Delivery proves the durable transport handoff, not consumption by the
  // recipient's model. A host that cannot recover a discarded queue can
  // replace that receipt with an explicit dead letter. The original envelope
  // must match the retained receipt; the broker never trusts a replacement
  // body or infers a discard merely because a session stopped.
  function deadLetter(input) {
    return serialize(() => {
      if (!hasExactKeys(input, DEAD_LETTER_REQUEST_KEYS)) {
        return immutableResult({ accepted: false, code: 'BROKER_DEAD_LETTER_INVALID' });
      }
      if (input.reason !== 'RECIPIENT_QUEUE_DISCARDED') {
        return immutableResult({ accepted: false, code: 'BROKER_DEAD_LETTER_REASON_INVALID' });
      }
      let normalized;
      try { normalized = normalizeMessage(input.message); }
      catch (error) {
        return immutableResult({
          accepted: false,
          code: error instanceof BrokerError ? error.code : 'BROKER_MESSAGE_INVALID'
        });
      }
      const atMs = currentTime();
      return commit(next => {
        const existing = next.deadLetters.find(item => item.entry.messageId === normalized.messageId);
        if (existing) {
          return existing.entry.fingerprint === normalized.fingerprint && existing.reason === input.reason
            ? immutableResult({ accepted: true, code: 'BROKER_DEAD_LETTERED', messageId: normalized.messageId,
              reason: existing.reason, replayed: true })
            : immutableResult({ accepted: false, code: 'BROKER_MESSAGE_ID_CONFLICT' });
        }
        const index = next.deliveries.findIndex(item => item.messageId === normalized.messageId);
        const deferredIndex = next.deferred.findIndex(item => item.entry.messageId === normalized.messageId);
        const deferred = next.deferred[deferredIndex];
        if (index < 0 && !deferred) {
          return immutableResult({ accepted: false, code: 'BROKER_DELIVERY_NOT_RETAINED' });
        }
        const receipt = next.deliveries[index] || deferred.entry;
        if (receipt.fingerprint !== normalized.fingerprint
          || receipt.recipientAgentId !== normalized.recipientAgentId
          || receipt.recipientMachineId !== normalized.recipientMachineId) {
          return immutableResult({ accepted: false, code: 'BROKER_MESSAGE_ID_CONFLICT' });
        }
        const sequence = next.nextSequence;
        next.nextSequence += 1;
        if (index >= 0) next.deliveries.splice(index, 1);
        if (deferredIndex >= 0) next.deferred.splice(deferredIndex, 1);
        next.deadLetters.push({
          deadLetteredAtMs: atMs,
          reason: input.reason,
          entry: {
            sequence,
            messageId: normalized.messageId,
            recipientAgentId: normalized.recipientAgentId,
            recipientMachineId: normalized.recipientMachineId,
            fingerprint: normalized.fingerprint,
            enqueuedAtMs: receipt.deliveredAtMs ?? receipt.enqueuedAtMs,
            message: clone(normalized.message)
          }
        });
        trimOldest(next.deadLetters, deadLetterRetention);
        return immutableResult({ accepted: true, code: 'BROKER_DEAD_LETTERED', messageId: normalized.messageId,
          reason: input.reason, replayed: false });
      });
    });
  }

  function updateDeferredDelivery(input, acknowledge) {
    return serialize(() => {
      if (!hasExactKeys(input, HANDOFF_REQUEST_KEYS)) {
        return immutableResult({ accepted: false, code: 'BROKER_HANDOFF_INVALID' });
      }
      let normalized;
      try { normalized = normalizeMessage(input.message); }
      catch (error) {
        return immutableResult({ accepted: false,
          code: error instanceof BrokerError ? error.code : 'BROKER_MESSAGE_INVALID' });
      }
      const atMs = currentTime();
      return commit(next => {
        const terminal = next.deadLetters.find(item => item.entry.messageId === normalized.messageId);
        if (terminal) return immutableResult({ accepted: false,
          code: terminal.entry.fingerprint === normalized.fingerprint
            ? 'BROKER_MESSAGE_DEAD_LETTERED' : 'BROKER_MESSAGE_ID_CONFLICT' });
        const index = next.deferred.findIndex(item => item.entry.messageId === normalized.messageId);
        const pending = next.deferred[index];
        const receipt = next.deliveries.find(item => item.messageId === normalized.messageId);
        const prior = pending?.entry || receipt;
        if (!prior) return immutableResult({ accepted: false, code: 'BROKER_DELIVERY_NOT_RETAINED' });
        if (prior.fingerprint !== normalized.fingerprint
          || prior.recipientAgentId !== normalized.recipientAgentId
          || (prior.recipientMachineId ?? null) !== (normalized.recipientMachineId ?? null)) {
          return immutableResult({ accepted: false, code: 'BROKER_MESSAGE_ID_CONFLICT' });
        }
        if (Number.isSafeInteger(receipt?.modelHandoffAtMs)) {
          return immutableResult({ accepted: true, code: 'BROKER_MODEL_HANDOFF_CONFIRMED',
            messageId: normalized.messageId, replayed: true });
        }
        if (acknowledge) {
          if (pending) next.deferred.splice(index, 1);
          const confirmed = receipt || {
            messageId: normalized.messageId, fingerprint: normalized.fingerprint,
            recipientAgentId: normalized.recipientAgentId,
            recipientMachineId: normalized.recipientMachineId ?? null,
            deliveredAtMs: pending.entry.enqueuedAtMs, ...senderOnReceipt(normalized.message),
          };
          confirmed.modelHandoffAtMs = atMs;
          confirmed.modelHandoffRecovered = Boolean(pending && pending.waitingForModel !== true);
          if (!receipt) next.deliveries.push(confirmed);
          trimOldest(next.deliveries, deliveryRetention);
          return immutableResult({ accepted: true, code: 'BROKER_MODEL_HANDOFF_CONFIRMED',
            messageId: normalized.messageId, replayed: false });
        }
        if (pending) {
          const replayed = pending.waitingForModel !== true;
          if (!replayed) { pending.waitingForModel = false; pending.deferredAtMs = atMs; }
          return immutableResult({ accepted: true, code: 'BROKER_DELIVERY_DEFERRED',
            messageId: normalized.messageId, replayed });
        }
        const sequence = next.nextSequence++;
        next.deferred.push({ deferredAtMs: atMs, entry: {
          sequence, messageId: normalized.messageId, fingerprint: normalized.fingerprint,
          recipientAgentId: normalized.recipientAgentId,
          recipientMachineId: normalized.recipientMachineId,
          enqueuedAtMs: receipt.deliveredAtMs, message: clone(normalized.message),
        } });
        return immutableResult({ accepted: true, code: 'BROKER_DELIVERY_DEFERRED',
          messageId: normalized.messageId, replayed: false });
      });
    });
  }

  const deferDelivery = input => updateDeferredDelivery(input, false);
  const acknowledgeDeferredDelivery = input => updateDeferredDelivery(input, true);

  function getSpool() {
    return immutableResult(stateSnapshot().spool
      .sort((left, right) => left.sequence - right.sequence)
      .map(entry => clone(entry)));
  }

  function getState() {
    return stateSnapshot();
  }

  return Object.freeze({
    acknowledgeDeferredDelivery,
    deadLetter,
    deferDelivery,
    drain,
    getSpool,
    getState,
    send
  });
}

module.exports = Object.freeze({
  BrokerError,
  DEFAULT_DEAD_LETTER_RETENTION,
  DEFAULT_DELIVERY_RETENTION,
  DEFAULT_WAKE_COOLDOWN_MS,
  DELIVERY_STATES,
  ROUTES,
  SCHEMA_VERSION,
  SENDER_READ_STATES,
  TRANSPORT_OUTCOMES,
  createBroker,
  normalizeMessage
});
