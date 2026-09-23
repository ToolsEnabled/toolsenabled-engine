'use strict';

// Append-only, per-channel durable message store for the direct-ethernet link
// bus. Deliberately dependency-free (matches src/mcp-server.js's own
// no-dependency convention): one NDJSON file per channel under stateDir, plus
// an in-memory index rebuilt from those files at boot. This is intentionally
// a "small local durable store" per the owner's contract, not a database --
// two trusted machines on a direct link exchanging short coordination
// messages, nothing more.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CHANNEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SENDER_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_RETAINED_PER_CHANNEL = 5000; // in-memory read window; the NDJSON file keeps the full history
const MAX_PAGE_SIZE = 200;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertChannel(channel) {
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) {
    throw fail('LINK_BUS_CHANNEL_INVALID', 'channel must match ^[A-Za-z0-9_-]{1,64}$.');
  }
  return channel;
}

function assertSender(sender) {
  if (typeof sender !== 'string' || !SENDER_RE.test(sender)) {
    throw fail('LINK_BUS_SENDER_INVALID', 'sender must be a short agent-name-shaped string.');
  }
  return sender;
}

function assertMessage(message) {
  if (typeof message !== 'string' || message.length === 0) {
    throw fail('LINK_BUS_MESSAGE_INVALID', 'message must be a non-empty string.');
  }
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
    throw fail('LINK_BUS_MESSAGE_INVALID', `message must be at most ${MAX_MESSAGE_BYTES} bytes.`);
  }
  return message;
}

function assertSentAt(sentAt) {
  if (typeof sentAt !== 'string' || !sentAt.trim() || Number.isNaN(Date.parse(sentAt))) {
    throw fail('LINK_BUS_SENTAT_INVALID', 'sentAt must be a valid ISO-8601 timestamp string.');
  }
  return sentAt;
}

function channelFile(stateDir, channel) {
  // channel already validated against CHANNEL_RE before this is ever called,
  // so it cannot contain path separators or traversal segments.
  return path.join(stateDir, `channel-${channel}.ndjson`);
}

function replayFingerprint({ channel, sender, message, sentAt }) {
  return crypto.createHash('sha256')
    .update('ToolsEnabled/link-bus/replay/v1\0', 'utf8')
    .update(JSON.stringify([channel, sender, message, sentAt]), 'utf8')
    .digest('hex');
}

function readChannelRecords(stateDir, channel) {
  const file = channelFile(stateDir, channel);
  const records = [];
  let nextSequence = 1;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { records, nextSequence };
    throw fail('LINK_BUS_STORE_UNAVAILABLE', 'The link bus durable store could not be read.');
  }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // tolerate a stray UTF-8 BOM, see owner-prompt-queue.js
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try { record = JSON.parse(trimmed); }
    catch { throw fail('LINK_BUS_STORE_UNAVAILABLE', 'The link bus durable store is corrupt.'); }
    if (!record || typeof record !== 'object' || !Number.isSafeInteger(record.sequence) || record.sequence < 1) {
      throw fail('LINK_BUS_STORE_UNAVAILABLE', 'The link bus durable store is corrupt.');
    }
    records.push(record);
    if (record.sequence >= nextSequence) nextSequence = record.sequence + 1;
  }
  return { records, nextSequence };
}

function loadChannel(stateDir, channel) {
  const loaded = readChannelRecords(stateDir, channel);
  const retained = loaded.records.length > MAX_RETAINED_PER_CHANNEL
    ? loaded.records.slice(loaded.records.length - MAX_RETAINED_PER_CHANNEL)
    : loaded.records;
  const replayIndex = new Map();
  for (const record of retained) replayIndex.set(replayFingerprint(record), record);
  return { records: retained, nextSequence: loaded.nextSequence, replayIndex };
}

// createStore is a factory, not a class, so tests can spin up an isolated
// instance per temp directory without any module-level shared state.
function createStore({ stateDir, now = Date.now } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required.');
  fs.mkdirSync(stateDir, { recursive: true });
  const channels = new Map(); // channel -> { records: [], nextSequence }

  function channelState(channel) {
    let state = channels.get(channel);
    if (!state) {
      state = loadChannel(stateDir, channel);
      channels.set(channel, state);
    }
    return state;
  }

  // totalCount() (the /health "messages" figure) must be accurate for a
  // freshly-opened store even before any particular channel has been
  // queried, since channelState() above loads channels lazily. Discover any
  // on-disk channel files this instance has not yet touched and fold them
  // in -- skipping anything whose name does not match CHANNEL_RE, since a
  // foreign file dropped into stateDir is not this store's concern.
  function discoverChannels() {
    let entries;
    try { entries = fs.readdirSync(stateDir); }
    catch { return; }
    for (const entry of entries) {
      const match = /^channel-(.+)\.ndjson$/.exec(entry);
      if (match && CHANNEL_RE.test(match[1]) && !channels.has(match[1])) channelState(match[1]);
    }
  }

  function append({ channel, sender, message, sentAt }) {
    assertChannel(channel);
    assertSender(sender);
    assertMessage(message);
    assertSentAt(sentAt);
    const state = channelState(channel);
    const fingerprint = replayFingerprint({ channel, sender, message, sentAt });
    const existing = state.replayIndex.get(fingerprint);
    if (existing && existing.channel === channel && existing.sender === sender
        && existing.message === message && existing.sentAt === sentAt) return existing;
    const record = Object.freeze({
      sequence: state.nextSequence, channel, sender, message, sentAt, receivedAtMs: now()
    });
    fs.appendFileSync(channelFile(stateDir, channel), `${JSON.stringify(record)}\n`, 'utf8');
    state.nextSequence = record.sequence + 1;
    state.records.push(record);
    state.replayIndex.set(fingerprint, record);
    if (state.records.length > MAX_RETAINED_PER_CHANNEL) {
      const removed = state.records.shift();
      const removedFingerprint = replayFingerprint(removed);
      if (state.replayIndex.get(removedFingerprint) === removed) state.replayIndex.delete(removedFingerprint);
    }
    return record;
  }

  // Cursor semantics: the sequence number of the last message the caller has
  // already seen. It is deliberately mandatory: treating a missing cursor as
  // zero silently turns an observation of the oldest page into a claim about
  // the current bus. Every successful read reports the supplied cursor, the
  // snapshot head, and its backlog so a partial page announces itself.
  function list({ channel, cursor, limit = MAX_PAGE_SIZE } = {}) {
    assertChannel(channel);
    if (cursor === undefined || cursor === null || cursor === '') {
      throw fail('LINK_BUS_CURSOR_REQUIRED', 'cursor is required; a read may not silently begin at the oldest retained message.');
    }
    const boundedLimit = Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_PAGE_SIZE ? limit : MAX_PAGE_SIZE;
    const after = Number(cursor);
    if (!Number.isSafeInteger(after) || after < 0) throw fail('LINK_BUS_CURSOR_INVALID', 'cursor must be a non-negative integer.');
    const state = channelState(channel);
    const headSequence = state.nextSequence - 1;
    let readable = state.records;
    let floorSequence = readable.length ? readable[0].sequence : headSequence + 1;
    // The in-memory window is bounded, but the NDJSON file is the durable
    // full history. A lagged peer must be able to recover mechanically rather
    // than receiving a permanent RETENTION_GAP for owner directives. Reload
    // the archive only when the requested cursor predates the hot window.
    if (readable.length && after < floorSequence - 1) {
      readable = readChannelRecords(stateDir, channel).records;
      floorSequence = readable.length ? readable[0].sequence : headSequence + 1;
    }
    const page = readable.filter(record => record.sequence > after).slice(0, boundedLimit);
    const nextCursor = page.length > 0 ? page[page.length - 1].sequence : after;
    const backlogCount = headSequence > after ? headSequence - after : 0;
    const caughtUp = after === headSequence;
    let status;
    let reason;
    if (after > headSequence) {
      status = 'INCOMPLETE';
      reason = 'CURSOR_AHEAD';
    } else if (caughtUp) {
      status = 'CAUGHT_UP';
    } else if (!page.length) {
      status = 'INCOMPLETE';
      reason = 'EMPTY_PAGE_BEHIND';
    } else if (page[0].sequence !== after + 1) {
      status = 'INCOMPLETE';
      reason = 'RETENTION_GAP';
    } else if (nextCursor < headSequence) {
      status = 'INCOMPLETE';
      reason = 'PAGE_PARTIAL';
    } else {
      status = 'BACKLOG';
    }
    const response = {
      messages: page,
      cursor: String(nextCursor),
      requestedCursor: after,
      headSequence,
      floorSequence,
      backlogCount,
      caughtUp,
      status
    };
    if (reason) response.reason = reason;
    return response;
  }

  function totalCount() {
    discoverChannels();
    let total = 0;
    for (const state of channels.values()) total += state.records.length;
    return total;
  }

  return Object.freeze({ append, list, totalCount });
}

module.exports = {
  CHANNEL_RE, SENDER_RE, MAX_MESSAGE_BYTES, MAX_RETAINED_PER_CHANNEL, MAX_PAGE_SIZE,
  createStore
};
