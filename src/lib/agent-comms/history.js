'use strict';

// Durable per-channel history.  The backing storage is intentionally injected:
// the production adapter is StateStore's revisioned getMemory/setMemory API,
// which makes each update a durable SQLite BEGIN IMMEDIATE transaction without
// giving this transport-neutral module a database of its own.

const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const DEFAULT_RETENTION = 1_000;
const DEFAULT_MAX_CHANNEL_BYTES = 24 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024;
const DEFAULT_MAX_WRITE_RETRIES = 8;
const MAX_IDENTIFIER_LENGTH = 128;
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|credential|cookie|pass(?:word|phrase)?|private[_-]?key|secret|token|vault)/i;
/* A CREDENTIAL IS A VALUE, NOT A WORD.
 *
 * The first version of this refused any message in which `token:`, `secret:`,
 * `credential:` or `authorization:` appeared at all. Measured 2026-09-03 in
 * the live log: five messages between agents refused in twenty minutes as
 * "credential-like", from agents discussing the code -- the vault, the audit
 * anchor, a turn's token count -- with no value in sight. A message that
 * cannot say the word `token` cannot describe half of this product.
 *
 * So the labelled forms now require what a leaked credential actually looks
 * like after the label: sixteen or more opaque characters, optionally quoted,
 * optionally after `Bearer`. `api_key: sk-abcdefghijklmnopq` is refused;
 * `the token: field is read by the vault` is not. The value-shaped forms --
 * a PEM header, an sk_/rk_ key, a JWT -- are unchanged: they never needed a
 * label to be recognised. */
const SENSITIVE_TEXT = /(?:-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\b(?:api[_ -]?key|authorization|credential|cookie|pass(?:word|phrase)?|private[_ -]?key|secret|token)\s*[:=]\s*["']?(?:bearer\s+)?[A-Za-z0-9+/_.\-]{16,}|\b(?:sk|rk)_[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;

/* THIS PRODUCT'S OWN PUBLIC IDENTIFIERS ARE NOT CREDENTIALS.
 *
 * The labelled rule above asks for sixteen opaque characters after `token:`
 * or `secret:`. An error code and a tool name clear that bar easily, so the
 * agents worst affected are the ones working ON the vault: MEASURED
 * 2026-09-03, seven agent_comms.send_local messages refused in one day, and
 * every one of these is refused --
 *
 *     credential: system.credential_request
 *     secret: SECRET_NOT_CONFIGURED
 *     token: MC_TREE_COMMAND_COMPLETION_TIMEOUT
 *     credential=custom.exoscale_api_key
 *
 * -- which are an error code, a tool name and the NAME of a vault key. A key's
 * name is not its value; it is printed in this product's own refusals and in
 * the setup surface. An agent that cannot quote the code it is looking at
 * cannot ask anyone for help with it.
 *
 * ONLY TWO SHAPES ARE EXEMPT, and both are shapes a secret does not have:
 * SCREAMING_SNAKE with at least one underscore, and dotted.lower_snake with at
 * least one dot. Requiring the separator is what keeps `TOKEN: ABCDEF0123456789`
 * refused. The trailing lookahead means the identifier must be the WHOLE value:
 * `token: SECRET_NOT_CONFIGURED_9f3ac1bd0e` keeps its opaque tail and stays
 * refused. Mixed case never matches either shape, so a real key -- which is
 * mixed case, or base64, or hex -- cannot take this exit.
 *
 * The exemption is applied by REMOVING those assignments and asking the
 * original rule again, so a message that also carries a genuine secret is
 * still refused on that secret. The three value-shaped rules (PEM header,
 * sk_/rk_ key, JWT) are never consulted here and are unchanged: they need no
 * label to be recognised, and nothing below can exempt them. */
const PRODUCT_IDENTIFIER_ASSIGNMENT = /\b(?:api[_ -]?key|authorization|credential|cookie|pass(?:word|phrase)?|private[_ -]?key|secret|token)\s*[:=]\s*["']?(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)(?![A-Za-z0-9+/_.\-])/g;

/* HOW STRICT THIS IS, IS THE PERSON'S CHOICE (setting agent.message_screening).
 *
 * Three levels and no fourth:
 *   strict    -- the labelled rule alone; this product's own code names are
 *                refused along with everything else that clears the bar.
 *   balanced  -- the default: identifiers may be quoted, values may not.
 *   off       -- nothing is inspected.
 *
 * The value-shaped rules are inside SENSITIVE_TEXT, so `off` is the only
 * level that stops looking at all, and it is the one the person has to pick
 * on purpose against a written risk. */
const SCREENING_LEVELS = Object.freeze(['strict', 'balanced', 'off']);
const SCREENING_BY_OPTION = Object.freeze({
  'Refuse look-alikes': 'strict',
  'Allow code names': 'balanced',
  Off: 'off'
});
const SCREENING_SETTING_ID = 'agent.message_screening';

/* Read ONCE, when the history is constructed -- never per message. A file
   read on the path every agent message takes is a latency cost paid forever
   for an answer that changes when a person moves a control.

   The fallback is the DEFAULT, never 'off': a settings file that cannot be
   read must not be a silent way to turn screening off. */
function configuredScreening() {
  try {
    const registry = require('../settings-registry').loadRegistry();
    if (!registry.byId.has(SCREENING_SETTING_ID)) return 'balanced';
    const resolved = require('../settings').loadSettings({ registry });
    return SCREENING_BY_OPTION[resolved.values[SCREENING_SETTING_ID]] || 'balanced';
  } catch {
    return 'balanced';
  }
}

function looksLikeCredential(text, screening = 'balanced') {
  if (screening === 'off') return false;
  if (!SENSITIVE_TEXT.test(text)) return false;
  if (screening === 'strict') return true;
  return SENSITIVE_TEXT.test(text.replace(PRODUCT_IDENTIFIER_ASSIGNMENT, ''));
}

class HistoryError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'HistoryError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details, cause) {
  throw new HistoryError(code, message, details, cause ? { cause } : {});
}

function plainObject(value, label, code = 'HISTORY_INVALID_ARGUMENT') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be a plain data object.`, { field: label });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain data object.`, { field: label });
  }
  return value;
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}, code = 'HISTORY_INVALID_ARGUMENT') {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(code, `${label} must be a safe integer in range.`, { field: label, min, max });
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_IDENTIFIER_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    fail('HISTORY_INVALID_ARGUMENT', `${label} is invalid.`, { field: label });
  }
  return value;
}

function storageKey(kind, first, second = null) {
  if (second === null) return `${kind}/${first}`;
  // StateStore memory keys are bounded at 200 characters, while an agent and
  // channel identifier may each legitimately be 128 characters.  Keep cursor
  // keys bounded without narrowing either identity; the full values remain in
  // the validated cursor payload.
  const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  return `${kind}/${hash(first)}/${hash(second)}`;
}

// A SECRET REFUSAL MUST NAME THE ACTION, AND MUST NOT NAME A FIELD THE CALLER
// NEVER SENT.
//
// Measured on this installation, capability/logs/actions.jsonl: eight
// agent_comms.send_local calls were refused with the whole sentence
// "message.message.body contains a credential-like value."  There is no
// `message.message.body` in that tool's request -- its parameters are `from`,
// `to` and `body`.  The doubled path is this module's own label walking the
// owner-journal envelope fabric.js builds, `{ streamId, message }`, appended
// under the default label `message`.  So the caller was handed a storage-
// internal location, a fact, and nothing to do.
//
// It is reachable because the two secret detectors disagree.  channel-contract
// screens the body with providers/sensitive-local-input.containsSensitiveMaterial
// and accepts it; this module then re-screens the envelope with the stricter
// SENSITIVE_TEXT above and refuses.  Measured here: the body
// "grep for token=aaaaaaaaaaaaaaaaaaaa in src/lib/audit.js" is false to the
// contract detector and true to this one.
//
// channel-contract's REFUSAL_REASONS already fixed exactly this for its own
// refusals -- "Keep the code for machines; give the person the mechanism and
// the next valid action here."  This brings the store's refusals to the same
// shape: mechanism, "nothing was stored and nothing was sent", the action, and
// only then the envelope location, labelled as an envelope location so nobody
// hunts for a request field by that name.
function secretRefusal(finding, action, location) {
  return `The durable message store ${finding}, so nothing was stored and nothing was sent. ${action}. `
    + `The match is at ${location} inside the stored envelope, which is not the name of a request field.`;
}

function cloneSafeMessage(value, label = 'message', depth = 0, seen = new Set(), screening = 'balanced') {
  if (depth > 32) fail('HISTORY_MESSAGE_INVALID', `${label} exceeds the maximum nesting depth.`, { field: label });
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('HISTORY_MESSAGE_INVALID', `${label} contains a non-finite number.`, { field: label });
    return value;
  }
  if (typeof value === 'string') {
    /* A NUL BYTE IS NOT A CREDENTIAL. These shared one sentence, so an agent
       whose message carried a stray NUL was told it had leaked a secret and
       went looking for one. Two findings, two sentences, two codes. */
    if (value.includes(' ')) {
      fail('HISTORY_MESSAGE_INVALID', `${label} contains a NUL character, which cannot be stored.`, { field: label });
    }
    if (looksLikeCredential(value, screening)) {
      fail('HISTORY_SECRET_REJECTED', secretRefusal(
        'found credential-shaped text in this message',
        'Take the password, key, or token out of the message text and send it again; a credential belongs in the vault and is referenced by name',
        label
      ), { field: label });
    }
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') {
    fail('HISTORY_MESSAGE_INVALID', `${label} is not JSON data.`, { field: label });
  }
  if (!value || typeof value !== 'object') fail('HISTORY_MESSAGE_INVALID', `${label} is invalid.`, { field: label });
  if (seen.has(value)) fail('HISTORY_MESSAGE_INVALID', `${label} contains a cycle.`, { field: label });
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry, index) => cloneSafeMessage(entry, `${label}[${index}]`, depth + 1, seen, screening));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('HISTORY_MESSAGE_INVALID', `${label} must contain plain JSON objects.`, { field: label });
    }
    // StateStore accepts ordinary JSON objects (not null-prototype objects),
    // and unsafe prototype-shaping keys were rejected above.
    const clone = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') {
        fail('HISTORY_MESSAGE_INVALID', `${label} contains an unsafe key.`, { field: label });
      }
      if (SENSITIVE_KEY.test(key)) {
        fail('HISTORY_SECRET_REJECTED', secretRefusal(
          'found a credential-shaped field name in this message',
          'Rename or remove that field and send it again; a credential belongs in the vault and is referenced by name',
          `${label}.${key}`
        ), { field: `${label}.${key}` });
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        fail('HISTORY_MESSAGE_INVALID', `${label} may not contain accessors.`, { field: `${label}.${key}` });
      }
      clone[key] = cloneSafeMessage(descriptor.value, `${label}.${key}`, depth + 1, seen, screening);
    }
    return clone;
  } finally {
    seen.delete(value);
  }
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/* SCREENING IS A WRITE-TIME POLICY, AND ONLY A WRITE-TIME POLICY.
 *
 * immutable() runs over records on their way OUT of storage -- including the
 * echo-back of a record append() has just accepted. Re-asking the credential
 * question there protects nothing: the bytes are already on disk, and refusing
 * to return them does not unleak them, it only makes the channel unreadable
 * and hides the evidence from the person who would clean it up.
 *
 * It is also how a policy refusal came back wearing the wrong sentence: a
 * record written with screening off was refused by this function, inside
 * append()'s try, and reported as "Durable history storage could not be
 * updated" -- a storage failure that had not happened.
 *
 * Every STRUCTURAL check still runs here at full strength: NUL bytes, cycles,
 * depth, non-finite numbers, non-JSON values. Only the credential policy is
 * skipped, because that question was already asked and answered when the
 * record was written. */
function immutable(value) {
  return deepFreeze(cloneSafeMessage(value, 'stored value', 0, new Set(), 'off'));
}

function emptyChannel(channelId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    channelId,
    floorSequence: 1,
    headSequence: 0,
    records: [],
    readers: []
  };
}

/* WHO THIS CHANNEL IS FOR, AND WHY RETENTION HAS TO KNOW (T201).
 *
 * Retention used to evict the oldest record on every append, by count and then
 * by bytes, without reference to anyone's read position:
 *
 *   while (records.length > retention) records.shift();
 *
 * So a message expired the moment the channel filled, whether or not the
 * session it was addressed to had ever read it. The app's tree courier shows
 * that outcome in words -- "Earlier agent messages have expired before this
 * session could read them" -- which is the symptom, not a remedy: nothing can
 * recover a record already gone.
 *
 * A DECLARED READER IS A PROMISE THAT SOMEONE IS COMING FOR THESE RECORDS.
 * append() takes the agentIds the channel exists to serve; the channel
 * remembers them, and retention may then evict only what every one of them has
 * already acknowledged. A channel with no declared reader behaves exactly as it
 * did -- there is no reader to be behind, so "unread" names nothing there.
 *
 * WHAT HAPPENS WHEN IT FILLS ANYWAY, STATED RATHER THAN HIDDEN. A channel whose
 * reader has stopped reading eventually cannot take another record, and the
 * append is REFUSED by name. That is the lesser loss: a refused append is one
 * the sender is told about and can act on, while a silent eviction destroys a
 * message the product already accepted and told the sender it had queued.
 * Bounded storage cannot promise both.
 *
 * BOUNDED, so a channel cannot accumulate readers without limit. */
const MAX_CHANNEL_READERS = 64;

function mergedReaders(prior, declared) {
  if (!declared.length) return prior;
  const readers = [...prior];
  for (const agentId of declared) {
    if (readers.includes(agentId)) continue;
    if (readers.length >= MAX_CHANNEL_READERS) {
      fail('HISTORY_CHANNEL_READERS_EXCEEDED',
        'This channel already tracks the maximum number of readers whose unread records retention must preserve.',
        { readers: readers.length, maximum: MAX_CHANNEL_READERS });
    }
    readers.push(agentId);
  }
  return readers;
}

function validateChannel(value, channelId) {
  const state = plainObject(value, 'stored channel history', 'HISTORY_STATE_CORRUPT');
  if (state.schemaVersion !== SCHEMA_VERSION || state.channelId !== channelId || !Array.isArray(state.records)) {
    fail('HISTORY_STATE_CORRUPT', 'Stored channel history has an invalid shape.', { channelId });
  }
  safeInteger(state.floorSequence, 'stored floorSequence', { min: 1 }, 'HISTORY_STATE_CORRUPT');
  safeInteger(state.headSequence, 'stored headSequence', { min: 0 }, 'HISTORY_STATE_CORRUPT');
  /* Absent on every channel written before readers were tracked, which is the
     honest state for those: nothing declared a reader, so nothing is unread. */
  if (state.readers !== undefined && !Array.isArray(state.readers)) {
    fail('HISTORY_STATE_CORRUPT', 'Stored channel readers have an invalid shape.', { channelId });
  }
  const readers = (state.readers || []).map((value, index) => {
    try { return identifier(value, `stored reader ${index}`); }
    catch (error) { fail('HISTORY_STATE_CORRUPT', 'Stored channel reader is not an identifier.', { channelId, index }, error); }
  });
  if (readers.length > MAX_CHANNEL_READERS) {
    fail('HISTORY_STATE_CORRUPT', 'Stored channel history tracks more readers than the bound allows.', { channelId, readers: readers.length });
  }
  if (!state.records.length) {
    if (state.floorSequence !== state.headSequence + 1) {
      fail('HISTORY_STATE_CORRUPT', 'An empty channel history has an invalid floor.', { channelId });
    }
    return { ...emptyChannel(channelId), readers };
  }
  if (state.floorSequence > state.headSequence || state.records.length !== state.headSequence - state.floorSequence + 1) {
    fail('HISTORY_STATE_CORRUPT', 'Stored channel history is not contiguous.', { channelId });
  }
  const records = state.records.map((record, index) => {
    const source = plainObject(record, `stored record ${index}`, 'HISTORY_STATE_CORRUPT');
    if (Object.keys(source).length !== 3 || !Object.hasOwn(source, 'sequence') || !Object.hasOwn(source, 'appendedAtMs') || !Object.hasOwn(source, 'message')) {
      fail('HISTORY_STATE_CORRUPT', 'Stored history record has unsupported fields.', { channelId, index });
    }
    const sequence = safeInteger(source.sequence, 'stored record sequence', { min: 1 }, 'HISTORY_STATE_CORRUPT');
    const appendedAtMs = safeInteger(source.appendedAtMs, 'stored record appendedAtMs', { min: 0 }, 'HISTORY_STATE_CORRUPT');
    if (sequence !== state.floorSequence + index) {
      fail('HISTORY_STATE_CORRUPT', 'Stored history record sequence is not contiguous.', { channelId, index });
    }
    let message;
    /* Read back from storage: structural checks only, for the reason above. */
    try { message = cloneSafeMessage(source.message, 'stored message', 0, new Set(), 'off'); }
    catch (error) {
      if (error instanceof HistoryError) fail('HISTORY_STATE_CORRUPT', 'Stored history message is invalid.', { channelId, index }, error);
      throw error;
    }
    return { sequence, appendedAtMs, message };
  });
  return { schemaVersion: SCHEMA_VERSION, channelId, floorSequence: state.floorSequence, headSequence: state.headSequence, records, readers };
}

function validateCursor(value, agentId, channelId) {
  const cursor = plainObject(value, 'stored history cursor', 'HISTORY_STATE_CORRUPT');
  if (cursor.schemaVersion !== SCHEMA_VERSION || cursor.agentId !== agentId || cursor.channelId !== channelId
    || Object.keys(cursor).length !== 5 || !Object.hasOwn(cursor, 'sequence') || !Object.hasOwn(cursor, 'updatedAtMs')) {
    fail('HISTORY_STATE_CORRUPT', 'Stored history cursor has an invalid shape.', { agentId, channelId });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    agentId,
    channelId,
    sequence: safeInteger(cursor.sequence, 'stored cursor sequence', { min: 0 }, 'HISTORY_STATE_CORRUPT'),
    updatedAtMs: safeInteger(cursor.updatedAtMs, 'stored cursor updatedAtMs', { min: 0 }, 'HISTORY_STATE_CORRUPT')
  };
}

function storageEntry(store, namespace, key) {
  let entry;
  try {
    entry = store.getMemory({ namespace, key });
  } catch (error) {
    fail('HISTORY_STORAGE_READ_FAILED', 'Durable history storage could not be read.', { namespace, key }, error);
  }
  if (entry === null || entry === undefined) return null;
  if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !Object.hasOwn(entry, 'value')) {
    fail('HISTORY_STORAGE_INVALID', 'Durable history storage returned an invalid entry.', { namespace, key });
  }
  return entry;
}

function isRevisionConflict(error) {
  return Boolean(error && (error.code === 'MEMORY_REVISION_CONFLICT' || error.code === 'HISTORY_REVISION_CONFLICT'));
}

function createHistory({
  store,
  namespace = 'agent-comms',
  retention = DEFAULT_RETENTION,
  maxChannelBytes = DEFAULT_MAX_CHANNEL_BYTES,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  maxWriteRetries = DEFAULT_MAX_WRITE_RETRIES,
  secretScreening,
  now = Date.now
} = {}) {
  if (!store || typeof store.getMemory !== 'function' || typeof store.setMemory !== 'function') {
    fail('HISTORY_CONFIGURATION_INVALID', 'A revisioned StateStore-compatible memory adapter is required.', { field: 'store' });
  }
  /* THE LEVEL APPLIES TO WHAT IS BEING WRITTEN, NOT TO WHAT IS READ BACK.
     immutable() runs this same clone over records on their way OUT, and a
     person tightening this control must not make history already on disk
     unreadable -- refusing to read a stored record does not unleak it, it
     only breaks the channel. So those paths keep the shipped default and
     only append() below is given the configured level. */
  const screening = secretScreening === undefined ? configuredScreening() : secretScreening;
  if (!SCREENING_LEVELS.includes(screening)) {
    fail('HISTORY_CONFIGURATION_INVALID', `secretScreening must be one of: ${SCREENING_LEVELS.join(', ')}.`, { field: 'secretScreening' });
  }
  identifier(namespace, 'namespace');
  if (namespace.length > 100) fail('HISTORY_CONFIGURATION_INVALID', 'namespace exceeds StateStore compatibility bounds.', { field: 'namespace' });
  safeInteger(retention, 'retention', { min: 1, max: 100_000 }, 'HISTORY_CONFIGURATION_INVALID');
  safeInteger(maxChannelBytes, 'maxChannelBytes', { min: 1_024, max: 32 * 1024 }, 'HISTORY_CONFIGURATION_INVALID');
  safeInteger(maxMessageBytes, 'maxMessageBytes', { min: 1, max: maxChannelBytes }, 'HISTORY_CONFIGURATION_INVALID');
  safeInteger(maxWriteRetries, 'maxWriteRetries', { min: 1, max: 100 }, 'HISTORY_CONFIGURATION_INVALID');
  if (typeof now !== 'function') fail('HISTORY_CONFIGURATION_INVALID', 'now must be an injected clock function.', { field: 'now' });

  function currentTime() {
    return safeInteger(now(), 'clock result', { min: 0 }, 'HISTORY_CLOCK_INVALID');
  }

  function write(key, value, expectedRevision) {
    try {
      return store.setMemory({
        namespace,
        key,
        value,
        tags: ['agent-comms', 'history'],
        expectedRevision
      });
    } catch (error) {
      throw error;
    }
  }

  /* The highest sequence EVERY declared reader has already acknowledged, and so
     the highest sequence retention is allowed to evict. No declared reader
     means no unread record to protect, and the channel prunes as it always
     did -- see the note on mergedReaders(). */
  function evictableThrough(channelId, readers) {
    if (!readers.length) return Number.MAX_SAFE_INTEGER;
    let floor = Number.MAX_SAFE_INTEGER;
    for (const agentId of readers) {
      const cursor = getCursor({ agentId, channelId });
      if (cursor.sequence < floor) floor = cursor.sequence;
    }
    return floor;
  }

  function append(input) {
    const source = plainObject(input, 'append input');
    const channelId = identifier(source.channelId, 'channelId');
    if (!Object.hasOwn(source, 'message')) fail('HISTORY_INVALID_ARGUMENT', 'append input requires message.', { field: 'message' });
    const message = cloneSafeMessage(source.message, 'message', 0, new Set(), screening);
    if (jsonBytes(message) > maxMessageBytes) {
      fail('HISTORY_MESSAGE_TOO_LARGE', 'Message exceeds the configured durable history limit.', { channelId, maximumBytes: maxMessageBytes });
    }
    /* WHO MUST HAVE READ A RECORD BEFORE IT MAY EXPIRE (T201). Optional, so
       every existing caller keeps the behaviour it has; a caller that knows the
       audience says so and the channel remembers it from then on. */
    if (source.readers !== undefined && !Array.isArray(source.readers)) {
      fail('HISTORY_INVALID_ARGUMENT', 'append readers must be an array of agent identifiers.', { field: 'readers' });
    }
    const declaredReaders = (source.readers || []).map(value => identifier(value, 'reader agentId'));
    const key = storageKey('history', channelId);
    const appendedAtMs = currentTime();
    for (let attempt = 1; attempt <= maxWriteRetries; attempt += 1) {
      const entry = storageEntry(store, namespace, key);
      const prior = entry ? validateChannel(entry.value, channelId) : emptyChannel(channelId);
      const readers = mergedReaders(prior.readers, declaredReaders);
      const evictableThroughSequence = evictableThrough(channelId, readers);
      const record = { sequence: prior.headSequence + 1, appendedAtMs, message };
      const records = [...prior.records, record];
      while (records.length > retention && records[0].sequence <= evictableThroughSequence) records.shift();
      if (records.length > retention) {
        fail('HISTORY_CHANNEL_UNREAD_FULL',
          'This channel is full of records its reader has not acknowledged, so a new one cannot be accepted without destroying one nobody has read.',
          { channelId, retention, unread: records.length - 1 - Math.max(0, evictableThroughSequence - prior.floorSequence + 1) });
      }
      const next = {
        schemaVersion: SCHEMA_VERSION,
        channelId,
        floorSequence: records[0].sequence,
        headSequence: record.sequence,
        records,
        readers
      };
      if (jsonBytes(record) > maxChannelBytes) {
        fail('HISTORY_MESSAGE_TOO_LARGE', 'Message cannot fit in the configured durable history channel.', { channelId, maximumBytes: maxChannelBytes });
      }
      while (jsonBytes(next) > maxChannelBytes && next.records.length > 1
        && next.records[0].sequence <= evictableThroughSequence) {
        next.records.shift();
        next.floorSequence = next.records[0].sequence;
      }
      if (jsonBytes(next) > maxChannelBytes && next.records.length > 1) {
        fail('HISTORY_CHANNEL_UNREAD_FULL',
          'This channel is full of records its reader has not acknowledged, so a new one cannot be accepted without destroying one nobody has read.',
          { channelId, maximumBytes: maxChannelBytes, unread: next.records.length - 1 });
      }
      if (jsonBytes(next) > maxChannelBytes) {
        fail('HISTORY_CHANNEL_CAPACITY', 'Channel history cannot fit in its durable storage budget.', { channelId, maximumBytes: maxChannelBytes });
      }
      try {
        write(key, next, entry ? entry.revision : 0);
        return immutable(record);
      } catch (error) {
        if (isRevisionConflict(error) && attempt < maxWriteRetries) continue;
        if (isRevisionConflict(error)) {
          fail('HISTORY_CONCURRENCY_RETRY_EXHAUSTED', 'Concurrent writers prevented a durable append.', { channelId, attempts: maxWriteRetries }, error);
        }
        fail('HISTORY_STORAGE_WRITE_FAILED', 'Durable history storage could not be updated.', { namespace, key }, error);
      }
    }
    fail('HISTORY_CONCURRENCY_RETRY_EXHAUSTED', 'Concurrent writers prevented a durable append.', { channelId, attempts: maxWriteRetries });
  }

  function read(input) {
    const source = plainObject(input, 'read input');
    const channelId = identifier(source.channelId, 'channelId');
    const afterSequence = safeInteger(source.afterSequence === undefined ? 0 : source.afterSequence, 'afterSequence');
    const entry = storageEntry(store, namespace, storageKey('history', channelId));
    const state = entry ? validateChannel(entry.value, channelId) : emptyChannel(channelId);
    if (afterSequence < state.floorSequence - 1) {
      // Returning no partial tail prevents a consumer from acknowledging past
      // unseen records.  The explicit floor tells it exactly why it must repair.
      return immutable({
        channelId,
        status: 'TRUNCATED',
        afterSequence,
        floorSequence: state.floorSequence,
        headSequence: state.headSequence,
        records: []
      });
    }
    return immutable({
      channelId,
      status: 'OK',
      afterSequence,
      floorSequence: state.floorSequence,
      headSequence: state.headSequence,
      records: state.records.filter(record => record.sequence > afterSequence)
    });
  }

  function getCursor(input) {
    const source = plainObject(input, 'cursor input');
    const agentId = identifier(source.agentId, 'agentId');
    const channelId = identifier(source.channelId, 'channelId');
    const entry = storageEntry(store, namespace, storageKey('cursor', agentId, channelId));
    const cursor = entry ? validateCursor(entry.value, agentId, channelId) : {
      schemaVersion: SCHEMA_VERSION, agentId, channelId, sequence: 0, updatedAtMs: 0
    };
    return immutable(cursor);
  }

  function replay(input) {
    const source = plainObject(input, 'replay input');
    const agentId = identifier(source.agentId, 'agentId');
    if (!Array.isArray(source.channelIds) || source.channelIds.length < 1 || source.channelIds.length > 1_000) {
      fail('HISTORY_INVALID_ARGUMENT', 'channelIds must be a non-empty bounded array.', { field: 'channelIds' });
    }
    const unique = new Set();
    const channels = source.channelIds.map(channelId => {
      const normalized = identifier(channelId, 'channelId');
      if (unique.has(normalized)) fail('HISTORY_INVALID_ARGUMENT', 'channelIds must not contain duplicates.', { channelId: normalized });
      unique.add(normalized);
      const cursor = getCursor({ agentId, channelId: normalized });
      const result = read({ channelId: normalized, afterSequence: cursor.sequence });
      return { ...result, cursorSequence: cursor.sequence };
    });
    // The array preserves the caller's channel order only; it does not imply
    // ordering between channels, which deliberately have independent clocks.
    return immutable({ agentId, channels });
  }

  function acknowledge(input) {
    const source = plainObject(input, 'acknowledge input');
    const agentId = identifier(source.agentId, 'agentId');
    const channelId = identifier(source.channelId, 'channelId');
    const sequence = safeInteger(source.sequence, 'sequence');
    const channel = read({ channelId, afterSequence: 0 });
    // A read at zero may itself be truncated; use its explicit metadata only.
    const floorSequence = channel.floorSequence;
    const headSequence = channel.headSequence;
    if (sequence > headSequence) {
      fail('HISTORY_ACK_BEYOND_HEAD', 'A cursor cannot acknowledge a sequence that was never appended.', { agentId, channelId, sequence, headSequence });
    }
    const key = storageKey('cursor', agentId, channelId);
    for (let attempt = 1; attempt <= maxWriteRetries; attempt += 1) {
      const entry = storageEntry(store, namespace, key);
      const prior = entry ? validateCursor(entry.value, agentId, channelId) : {
        schemaVersion: SCHEMA_VERSION, agentId, channelId, sequence: 0, updatedAtMs: 0
      };
      if (sequence <= prior.sequence) return immutable({ ...prior, advanced: false, replayed: true });
      if (prior.sequence < floorSequence - 1) {
        fail('HISTORY_CURSOR_TRUNCATED', 'A cursor behind the retention floor cannot be advanced silently.', {
          agentId, channelId, cursorSequence: prior.sequence, floorSequence
        });
      }
      const next = {
        schemaVersion: SCHEMA_VERSION,
        agentId,
        channelId,
        sequence,
        updatedAtMs: currentTime()
      };
      try {
        write(key, next, entry ? entry.revision : 0);
        return immutable({ ...next, advanced: true, replayed: false });
      } catch (error) {
        if (isRevisionConflict(error) && attempt < maxWriteRetries) continue;
        if (isRevisionConflict(error)) {
          fail('HISTORY_CONCURRENCY_RETRY_EXHAUSTED', 'Concurrent acknowledgements prevented a durable cursor update.', { agentId, channelId, attempts: maxWriteRetries }, error);
        }
        fail('HISTORY_STORAGE_WRITE_FAILED', 'Durable history cursor storage could not be updated.', { namespace, key }, error);
      }
    }
    fail('HISTORY_CONCURRENCY_RETRY_EXHAUSTED', 'Concurrent acknowledgements prevented a durable cursor update.', { agentId, channelId, attempts: maxWriteRetries });
  }

  return Object.freeze({
    acknowledge,
    append,
    getCursor,
    read,
    replay
  });
}

module.exports = Object.freeze({
  DEFAULT_MAX_CHANNEL_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_WRITE_RETRIES,
  DEFAULT_RETENTION,
  HistoryError,
  SCHEMA_VERSION,
  createHistory
});
