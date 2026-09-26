'use strict';

// Relay binding for the broker's injected transport port.  Network I/O stays
// behind requestPort: this module never opens a socket and tests can prove the
// full contract with a deterministic fake.

const crypto = require('node:crypto');

const CHANNEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SENDER_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const RELAY_ERROR_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DELIVERY_STATUSES = new Set(['CONFIRMED', 'PENDING', 'REJECTED', 'RETRYABLE', 'UNCERTAIN']);
const READ_STATUSES = new Set(['BACKLOG', 'CAUGHT_UP', 'INCOMPLETE']);
const MAX_RELAY_PAGE_SIZE = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
// Twenty-five maximum-sized relay messages, even at worst-case JSON escaping,
// remain below the default bounded read response allowance.
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_DRAIN_MESSAGES = 5_000;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_MAX_SEND_RESPONSE_BYTES = 8 * 1024;
const DEFAULT_MAX_READ_RESPONSE_BYTES = 16 * 1024 * 1024;

class RelayTransportError extends Error {
  constructor(code, message, {
    messageId = null,
    outcome = 'FAILED',
    programmingError = false,
    relayCode = null,
    retryable = false,
    statusCode = null
  } = {}) {
    super(message);
    this.name = 'RelayTransportError';
    this.code = code;
    this.messageId = messageId;
    this.outcome = outcome;
    this.programmingError = programmingError;
    this.retryable = retryable;
    this.details = Object.freeze({ relayCode, statusCode });
  }
}

function fail(code, message, details) {
  throw new RelayTransportError(code, message, details);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('TRANSPORT_RELAY_ARGUMENT_INVALID', `${label} must be a plain object.`, { programmingError: true });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('TRANSPORT_RELAY_ARGUMENT_INVALID', `${label} must be a plain object.`, { programmingError: true });
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      fail('TRANSPORT_RELAY_ARGUMENT_INVALID', `${label} may only contain string keys.`, { programmingError: true });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail('TRANSPORT_RELAY_ARGUMENT_INVALID', `${label} may not contain accessors.`, { programmingError: true });
    }
  }
  return value;
}

function boundedInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('TRANSPORT_RELAY_ARGUMENT_INVALID', `${label} is outside its allowed range.`, { programmingError: true });
  }
  return value;
}

function validateChannel(value) {
  if (typeof value !== 'string' || !CHANNEL_RE.test(value)) {
    fail('TRANSPORT_RELAY_CONFIGURATION_INVALID', 'channel is invalid.', { programmingError: true });
  }
  return value;
}

function validateSender(value) {
  if (typeof value !== 'string' || !SENDER_RE.test(value)) {
    fail('TRANSPORT_RELAY_CONFIGURATION_INVALID', 'sender is invalid.', { programmingError: true });
  }
  return value;
}

function validateMessageId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.includes('\u0000')) {
    fail('TRANSPORT_RELAY_ARGUMENT_INVALID', 'messageId is invalid.', { programmingError: true });
  }
  return value;
}

function freezeReceipt(value) {
  Object.freeze(value.evidence);
  return Object.freeze(value);
}

function createMemoryRelayState({ cursor = 0 } = {}) {
  boundedInteger(cursor, 'cursor');
  const deliveries = new Map();
  const cursors = new Map();
  return Object.freeze({
    getDelivery(messageId) {
      return deliveries.get(messageId) || null;
    },
    setDelivery(messageId, record) {
      deliveries.set(messageId, Object.freeze({ ...record }));
    },
    getCursor(channel) {
      return cursors.has(channel) ? cursors.get(channel) : null;
    },
    setCursor(channel, value) {
      boundedInteger(value, 'cursor');
      cursors.set(channel, value);
    },
    initialCursor: cursor
  });
}

function resolveRequestPort(requestPort) {
  if (typeof requestPort === 'function') return requestPort;
  if (requestPort && typeof requestPort.request === 'function') {
    return requestPort.request.bind(requestPort);
  }
  fail(
    'TRANSPORT_RELAY_CONFIGURATION_INVALID',
    'requestPort must be an injected function or expose request().',
    { programmingError: true }
  );
}

function validateStatePort(state) {
  const required = ['getDelivery', 'setDelivery', 'getCursor', 'setCursor'];
  if (!state || typeof state !== 'object' || required.some(method => typeof state[method] !== 'function')) {
    fail(
      'TRANSPORT_RELAY_CONFIGURATION_INVALID',
      'state must expose getDelivery(), setDelivery(), getCursor(), and setCursor().',
      { programmingError: true }
    );
  }
  return state;
}

function validateStoredDelivery(value, messageId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !DELIVERY_STATUSES.has(value.status)
    || typeof value.fingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || typeof value.sentAt !== 'string'
    || Number.isNaN(Date.parse(value.sentAt))) {
    fail('TRANSPORT_RELAY_STATE_INVALID', 'stored delivery state is invalid.', {
      messageId,
      outcome: 'UNCERTAIN'
    });
  }
  if (value.status === 'CONFIRMED'
    && (!value.receipt || value.receipt.delivered !== true || value.receipt.messageId !== messageId)) {
    fail('TRANSPORT_RELAY_STATE_INVALID', 'stored delivery receipt is invalid.', {
      messageId,
      outcome: 'UNCERTAIN'
    });
  }
  return value;
}

function safeRelayCode(value) {
  return typeof value === 'string' && RELAY_ERROR_RE.test(value) ? value : null;
}

function safeCauseCode(error) {
  return error && safeRelayCode(error.code);
}

function encodedJson(value, maxBytes, code) {
  let text;
  try { text = JSON.stringify(value); }
  catch { fail(code, 'value is not JSON serializable.', { programmingError: true }); }
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) {
    fail(code, 'JSON payload exceeds the configured byte bound.', { programmingError: true });
  }
  return text;
}

function parseResponse(response, maxBytes) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    fail('TRANSPORT_RELAY_RESPONSE_INVALID', 'request port returned an invalid response.');
  }
  const statusCode = response.statusCode === undefined ? response.status : response.statusCode;
  if (!Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    fail('TRANSPORT_RELAY_RESPONSE_INVALID', 'request port returned an invalid status code.');
  }
  let body;
  if (Buffer.isBuffer(response.body)) {
    if (response.body.length > maxBytes) {
      fail('TRANSPORT_RELAY_RESPONSE_TOO_LARGE', 'relay response exceeds the configured byte bound.');
    }
    body = response.body.toString('utf8');
  } else if (typeof response.body === 'string') {
    if (Buffer.byteLength(response.body, 'utf8') > maxBytes) {
      fail('TRANSPORT_RELAY_RESPONSE_TOO_LARGE', 'relay response exceeds the configured byte bound.');
    }
    body = response.body;
  } else {
    fail('TRANSPORT_RELAY_RESPONSE_INVALID', 'request port must return a bounded string or Buffer body.');
  }
  let json;
  try { json = JSON.parse(body); }
  catch { fail('TRANSPORT_RELAY_RESPONSE_INVALID', 'relay response is not valid JSON.'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    fail('TRANSPORT_RELAY_RESPONSE_INVALID', 'relay response JSON is invalid.');
  }
  return { statusCode, json };
}

function timestampFor(message, now) {
  const candidate = message && Object.hasOwn(message, 'issuedAt') ? message.issuedAt : now();
  const date = typeof candidate === 'string' ? new Date(candidate) : new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    fail('TRANSPORT_RELAY_CLOCK_INVALID', 'message time cannot form a valid relay timestamp.', {
      programmingError: true
    });
  }
  return date.toISOString();
}

function createRelayTransport({
  channel,
  sender,
  requestPort,
  state = null,
  initialCursor,
  now = Date.now,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  pageSize = DEFAULT_PAGE_SIZE,
  maxDrainMessages = DEFAULT_MAX_DRAIN_MESSAGES,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxSendResponseBytes = DEFAULT_MAX_SEND_RESPONSE_BYTES,
  maxReadResponseBytes = DEFAULT_MAX_READ_RESPONSE_BYTES
} = {}) {
  validateChannel(channel);
  validateSender(sender);
  const request = resolveRequestPort(requestPort);
  if (typeof now !== 'function') {
    fail('TRANSPORT_RELAY_CONFIGURATION_INVALID', 'now must be an injected function.', { programmingError: true });
  }
  boundedInteger(requestTimeoutMs, 'requestTimeoutMs', { min: 1, max: 120_000 });
  boundedInteger(pageSize, 'pageSize', { min: 1, max: MAX_RELAY_PAGE_SIZE });
  boundedInteger(maxDrainMessages, 'maxDrainMessages', { min: 1, max: 100_000 });
  boundedInteger(maxMessageBytes, 'maxMessageBytes', { min: 1, max: DEFAULT_MAX_MESSAGE_BYTES });
  boundedInteger(maxRequestBytes, 'maxRequestBytes', { min: 1, max: DEFAULT_MAX_REQUEST_BYTES });
  boundedInteger(maxSendResponseBytes, 'maxSendResponseBytes', { min: 1, max: 1024 * 1024 });
  boundedInteger(maxReadResponseBytes, 'maxReadResponseBytes', { min: 1, max: 64 * 1024 * 1024 });
  if (initialCursor === undefined) {
    fail(
      'TRANSPORT_RELAY_CURSOR_REQUIRED',
      'initialCursor is required; relay reads may not silently begin without a cursor.',
      { programmingError: true }
    );
  }
  boundedInteger(initialCursor, 'initialCursor');
  const relayState = validateStatePort(state || createMemoryRelayState({ cursor: initialCursor }));
  let storedCursor;
  try { storedCursor = relayState.getCursor(channel); }
  catch {
    fail('TRANSPORT_RELAY_STATE_UNAVAILABLE', 'relay cursor state could not be read.', { outcome: 'UNCERTAIN' });
  }
  if (storedCursor === null || storedCursor === undefined) {
    try { relayState.setCursor(channel, initialCursor); }
    catch {
      fail('TRANSPORT_RELAY_STATE_UNAVAILABLE', 'relay cursor state could not be initialized.', { outcome: 'UNCERTAIN' });
    }
  } else {
    boundedInteger(storedCursor, 'stored cursor');
  }

  const inFlight = new Map();

  function getDelivery(messageId) {
    try {
      const value = relayState.getDelivery(messageId);
      return value === null || value === undefined ? null : validateStoredDelivery(value, messageId);
    } catch (error) {
      if (error instanceof RelayTransportError) throw error;
      fail('TRANSPORT_RELAY_STATE_UNAVAILABLE', 'relay delivery state could not be read.', {
        messageId,
        outcome: 'UNCERTAIN'
      });
    }
  }

  function setDelivery(messageId, value, outcomeOnFailure = 'UNCERTAIN') {
    try { relayState.setDelivery(messageId, value); }
    catch {
      fail('TRANSPORT_RELAY_STATE_UNAVAILABLE', 'relay delivery state could not be stored.', {
        messageId,
        outcome: outcomeOnFailure
      });
    }
  }

  function getCursor() {
    let value;
    try { value = relayState.getCursor(channel); }
    catch { fail('TRANSPORT_RELAY_STATE_UNAVAILABLE', 'relay cursor state could not be read.', { outcome: 'UNCERTAIN' }); }
    return boundedInteger(value, 'stored cursor');
  }

  function setCursor(value) {
    try { relayState.setCursor(channel, value); }
    catch { fail('TRANSPORT_RELAY_STATE_UNAVAILABLE', 'relay cursor state could not be stored.', { outcome: 'UNCERTAIN' }); }
  }

  async function requestWithDeadline({ method, path, body = null, responseLimit, operation }) {
    const controller = new AbortController();
    let requestSent = false;
    let timeoutHandle;
    let timedOut = false;
    const deadline = new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(Object.assign(new Error('request deadline expired'), { code: 'TRANSPORT_RELAY_DEADLINE' }));
      }, requestTimeoutMs);
    });
    const headers = body === null
      ? Object.freeze({ accept: 'application/json' })
      : Object.freeze({
        accept: 'application/json',
        'content-length': String(Buffer.byteLength(body, 'utf8')),
        'content-type': 'application/json; charset=utf-8'
      });
    const descriptor = Object.freeze({
      method,
      path,
      headers,
      body,
      signal: controller.signal,
      maxResponseBytes: responseLimit,
      onRequestSent() { requestSent = true; }
    });
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => request(descriptor)),
        deadline
      ]);
      // Receiving any response proves the request reached a responder even if
      // an injected port omitted the explicit byte-flush callback.
      requestSent = true;
      return { response, requestSent };
    } catch (error) {
      const bytesLeft = requestSent || Boolean(error && (error.bytesSent === true || error.requestSent === true));
      if (operation === 'SEND' && bytesLeft) {
        fail('TRANSPORT_RELAY_SEND_UNCERTAIN', 'relay send outcome is uncertain and must not be retried automatically.', {
          outcome: 'UNCERTAIN',
          relayCode: safeCauseCode(error),
          retryable: false
        });
      }
      fail(
        timedOut ? 'TRANSPORT_RELAY_REQUEST_TIMEOUT' : 'TRANSPORT_RELAY_REQUEST_FAILED',
        timedOut ? 'relay request timed out before delivery was possible.' : 'relay request failed.',
        { outcome: 'FAILED', relayCode: safeCauseCode(error), retryable: operation === 'SEND' }
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  function prepareAttempt(input) {
    const attempt = plainObject(input, 'delivery attempt');
    const messageId = validateMessageId(attempt.messageId);
    if (attempt.idempotencyKey !== messageId) {
      fail(
        'TRANSPORT_RELAY_IDEMPOTENCY_KEY_INVALID',
        'idempotencyKey must be the fabric message id.',
        { messageId, programmingError: true }
      );
    }
    if (!attempt.message || typeof attempt.message !== 'object' || Array.isArray(attempt.message)) {
      fail('TRANSPORT_RELAY_ARGUMENT_INVALID', 'delivery attempt message is invalid.', {
        messageId,
        programmingError: true
      });
    }
    const message = encodedJson(attempt.message, maxMessageBytes, 'TRANSPORT_RELAY_MESSAGE_TOO_LARGE');
    const fingerprint = crypto.createHash('sha256')
      .update('ToolsEnabled/agent-comms/relay/v1\0', 'utf8')
      .update(JSON.stringify([channel, sender, messageId, message]), 'utf8')
      .digest('hex');
    return Object.freeze({ fingerprint, message, messageId });
  }

  function cachedFailure(record, messageId) {
    if (record.status === 'PENDING' || record.status === 'UNCERTAIN') {
      fail('TRANSPORT_RELAY_SEND_UNCERTAIN', 'a prior relay send is uncertain and will not be re-sent.', {
        messageId,
        outcome: 'UNCERTAIN',
        retryable: false
      });
    }
    if (record.status === 'REJECTED') {
      fail('TRANSPORT_RELAY_SEND_REJECTED', 'the relay previously rejected this message id.', {
        messageId,
        outcome: 'REJECTED',
        relayCode: record.relayCode || null,
        retryable: false,
        statusCode: record.statusCode || null
      });
    }
  }

  function parseRelaySequence(id) {
    if (typeof id !== 'string' || !id.startsWith(`${channel}:`)) {
      fail('TRANSPORT_RELAY_ACK_INVALID', 'relay acknowledgement does not name the configured channel.');
    }
    const raw = id.slice(channel.length + 1);
    if (!/^[1-9][0-9]*$/.test(raw)) {
      fail('TRANSPORT_RELAY_ACK_INVALID', 'relay acknowledgement has no valid assigned sequence.');
    }
    const sequence = Number(raw);
    if (!Number.isSafeInteger(sequence)) {
      fail('TRANSPORT_RELAY_ACK_INVALID', 'relay acknowledgement sequence is outside the safe range.');
    }
    return sequence;
  }

  async function performDelivery(prepared, sentAt) {
    const payload = encodedJson({ channel, sender, message: prepared.message, sentAt }, maxRequestBytes, 'TRANSPORT_RELAY_REQUEST_TOO_LARGE');
    let exchange;
    try {
      exchange = await requestWithDeadline({
        method: 'POST',
        path: '/v1/messages',
        body: payload,
        responseLimit: maxSendResponseBytes,
        operation: 'SEND'
      });
    } catch (error) {
      if (error instanceof RelayTransportError && error.outcome === 'UNCERTAIN') {
        setDelivery(prepared.messageId, {
          fingerprint: prepared.fingerprint,
          sentAt,
          status: 'UNCERTAIN'
        });
      } else {
        setDelivery(prepared.messageId, {
          fingerprint: prepared.fingerprint,
          sentAt,
          status: 'RETRYABLE'
        });
      }
      if (error instanceof RelayTransportError && error.messageId === null) error.messageId = prepared.messageId;
      throw error;
    }

    let parsed;
    try { parsed = parseResponse(exchange.response, maxSendResponseBytes); }
    catch (error) {
      setDelivery(prepared.messageId, {
        fingerprint: prepared.fingerprint,
        sentAt,
        status: 'UNCERTAIN'
      });
      fail('TRANSPORT_RELAY_SEND_UNCERTAIN', 'relay responded without usable delivery evidence.', {
        messageId: prepared.messageId,
        outcome: 'UNCERTAIN',
        relayCode: safeCauseCode(error),
        retryable: false
      });
    }

    const relayCode = safeRelayCode(parsed.json.error);
    if (parsed.statusCode !== 200) {
      const uncertain = parsed.statusCode >= 500;
      setDelivery(prepared.messageId, {
        fingerprint: prepared.fingerprint,
        relayCode,
        sentAt,
        status: uncertain ? 'UNCERTAIN' : 'REJECTED',
        statusCode: parsed.statusCode
      });
      fail(
        uncertain ? 'TRANSPORT_RELAY_SEND_UNCERTAIN' : 'TRANSPORT_RELAY_SEND_REJECTED',
        uncertain ? 'relay send outcome is uncertain.' : 'relay rejected the message.',
        {
          messageId: prepared.messageId,
          outcome: uncertain ? 'UNCERTAIN' : 'REJECTED',
          relayCode,
          retryable: false,
          statusCode: parsed.statusCode
        }
      );
    }

    let sequence;
    try { sequence = parseRelaySequence(parsed.json.id); }
    catch {
      setDelivery(prepared.messageId, {
        fingerprint: prepared.fingerprint,
        sentAt,
        status: 'UNCERTAIN'
      });
      fail('TRANSPORT_RELAY_SEND_UNCERTAIN', 'relay acknowledgement was not valid delivery evidence.', {
        messageId: prepared.messageId,
        outcome: 'UNCERTAIN',
        retryable: false
      });
    }
    const receipt = freezeReceipt({
      delivered: true,
      evidence: {
        id: parsed.json.id,
        sequence,
        source: 'relay-assigned-sequence'
      },
      messageId: prepared.messageId,
      relaySequence: sequence,
      sequence
    });
    setDelivery(prepared.messageId, {
      fingerprint: prepared.fingerprint,
      receipt,
      sentAt,
      status: 'CONFIRMED'
    });
    return receipt;
  }

  function deliver(input) {
    let prepared;
    try { prepared = prepareAttempt(input); }
    catch (error) { return Promise.reject(error); }

    const active = inFlight.get(prepared.messageId);
    if (active) {
      if (active.fingerprint !== prepared.fingerprint) {
        return Promise.reject(new RelayTransportError(
          'TRANSPORT_RELAY_MESSAGE_ID_CONFLICT',
          'message id was reused with different content.',
          { messageId: prepared.messageId, programmingError: true }
        ));
      }
      return active.promise;
    }

    let record;
    try { record = getDelivery(prepared.messageId); }
    catch (error) { return Promise.reject(error); }
    if (record && record.fingerprint !== prepared.fingerprint) {
      return Promise.reject(new RelayTransportError(
        'TRANSPORT_RELAY_MESSAGE_ID_CONFLICT',
        'message id was reused with different content.',
        { messageId: prepared.messageId, programmingError: true }
      ));
    }
    if (record && record.status === 'CONFIRMED') return Promise.resolve(record.receipt);
    try { if (record) cachedFailure(record, prepared.messageId); }
    catch (error) { return Promise.reject(error); }

    const sentAt = record ? record.sentAt : timestampFor(input.message, now);
    try {
      setDelivery(prepared.messageId, {
        fingerprint: prepared.fingerprint,
        sentAt,
        status: 'PENDING'
      });
    } catch (error) {
      return Promise.reject(error);
    }
    const promise = performDelivery(prepared, sentAt)
      .finally(() => {
        const current = inFlight.get(prepared.messageId);
        if (current && current.promise === promise) inFlight.delete(prepared.messageId);
      });
    inFlight.set(prepared.messageId, Object.freeze({ fingerprint: prepared.fingerprint, promise }));
    return promise;
  }

  function validateReadPage(json, requestedCursor, requestedLimit) {
    if (!Array.isArray(json.messages)
      || json.messages.length > requestedLimit
      || typeof json.cursor !== 'string'
      || !/^[0-9]+$/.test(json.cursor)
      || !Number.isSafeInteger(json.requestedCursor)
      || json.requestedCursor !== requestedCursor
      || !Number.isSafeInteger(json.headSequence)
      || json.headSequence < 0
      || !Number.isSafeInteger(json.floorSequence)
      || json.floorSequence < 1
      || !Number.isSafeInteger(json.backlogCount)
      || json.backlogCount < 0
      || typeof json.caughtUp !== 'boolean'
      || !READ_STATUSES.has(json.status)) {
      fail('TRANSPORT_RELAY_READ_RESPONSE_INVALID', 'relay read response is invalid.');
    }
    const cursor = Number(json.cursor);
    if (!Number.isSafeInteger(cursor)
      || json.backlogCount !== Math.max(0, json.headSequence - requestedCursor)
      || json.caughtUp !== (requestedCursor === json.headSequence)) {
      fail('TRANSPORT_RELAY_READ_RESPONSE_INVALID', 'relay read evidence is inconsistent.');
    }
    let expected = requestedCursor + 1;
    const messages = json.messages.map(record => {
      if (!record || typeof record !== 'object' || Array.isArray(record)
        || !Number.isSafeInteger(record.sequence)
        || record.sequence !== expected
        || record.channel !== channel
        || typeof record.sender !== 'string'
        || typeof record.message !== 'string'
        || typeof record.sentAt !== 'string'
        || Number.isNaN(Date.parse(record.sentAt))) {
        fail('TRANSPORT_RELAY_READ_GAP', 'relay read contains a gap, duplicate, or invalid record.');
      }
      expected += 1;
      return Object.freeze({ ...record });
    });
    const expectedCursor = messages.length ? messages[messages.length - 1].sequence : requestedCursor;
    if (cursor !== expectedCursor) {
      fail('TRANSPORT_RELAY_READ_RESPONSE_INVALID', 'relay cursor does not match the returned records.');
    }
    return Object.freeze({
      backlogCount: json.backlogCount,
      caughtUp: json.caughtUp,
      cursor,
      floorSequence: json.floorSequence,
      headSequence: json.headSequence,
      messages: Object.freeze(messages),
      reason: safeRelayCode(json.reason),
      requestedCursor,
      status: json.status
    });
  }

  async function read(input) {
    const source = plainObject(input, 'read input');
    if (!Object.hasOwn(source, 'cursor')) {
      fail('TRANSPORT_RELAY_CURSOR_REQUIRED', 'cursor is required for every relay read.', {
        programmingError: true
      });
    }
    const cursor = boundedInteger(source.cursor, 'cursor');
    const limit = source.limit === undefined
      ? pageSize
      : boundedInteger(source.limit, 'limit', { min: 1, max: MAX_RELAY_PAGE_SIZE });
    const path = `/v1/messages?channel=${encodeURIComponent(channel)}&cursor=${cursor}&limit=${limit}`;
    const exchange = await requestWithDeadline({
      method: 'GET',
      path,
      responseLimit: maxReadResponseBytes,
      operation: 'READ'
    });
    const parsed = parseResponse(exchange.response, maxReadResponseBytes);
    if (parsed.statusCode !== 200) {
      const relayCode = safeRelayCode(parsed.json.error);
      if (relayCode === 'LINK_BUS_CURSOR_REQUIRED') {
        fail('TRANSPORT_RELAY_CURSOR_PROGRAMMING_ERROR', 'relay refused a cursorless read.', {
          outcome: 'FAILED',
          programmingError: true,
          relayCode,
          statusCode: parsed.statusCode
        });
      }
      fail('TRANSPORT_RELAY_READ_REJECTED', 'relay rejected the read.', {
        relayCode,
        statusCode: parsed.statusCode
      });
    }
    return validateReadPage(parsed.json, cursor, limit);
  }

  let readTail = Promise.resolve();
  function drain(input) {
    const source = plainObject(input, 'drain input');
    if (typeof source.onMessage !== 'function') {
      return Promise.reject(new RelayTransportError(
        'TRANSPORT_RELAY_RECEIVER_REQUIRED',
        'drain requires an onMessage callback so messages are not buffered or dropped.',
        { programmingError: true }
      ));
    }
    const operation = async () => {
      const requestedCursor = getCursor();
      let cursor = requestedCursor;
      let drainedCount = 0;
      let headSequence = cursor;
      let floorSequence = cursor + 1;
      let initialBacklogCount = null;
      let pages = 0;

      while (drainedCount < maxDrainMessages) {
        const page = await read({ cursor, limit: pageSize });
        pages += 1;
        if (initialBacklogCount === null) initialBacklogCount = page.backlogCount;
        headSequence = page.headSequence;
        floorSequence = page.floorSequence;
        if (page.status === 'INCOMPLETE' && page.reason !== 'PAGE_PARTIAL') {
          fail('TRANSPORT_RELAY_READ_INCOMPLETE', 'relay cannot continue the stored cursor without loss.', {
            relayCode: page.reason
          });
        }
        if (page.messages.length === 0 && cursor < headSequence) {
          fail('TRANSPORT_RELAY_READ_NO_PROGRESS', 'relay read made no progress before the head.');
        }
        for (const message of page.messages) {
          await source.onMessage(message);
          cursor = message.sequence;
          setCursor(cursor);
          drainedCount += 1;
          if (drainedCount >= maxDrainMessages) break;
        }
        if (cursor === headSequence) {
          return Object.freeze({
            backlogCount: Math.max(0, headSequence - requestedCursor),
            caughtUp: true,
            cursor,
            drainedCount,
            floorSequence,
            headSequence,
            initialBacklogCount: initialBacklogCount || 0,
            pages,
            remainingBacklogCount: 0,
            requestedCursor,
            status: 'CAUGHT_UP'
          });
        }
      }
      return Object.freeze({
        backlogCount: Math.max(0, headSequence - requestedCursor),
        caughtUp: false,
        cursor,
        drainedCount,
        floorSequence,
        headSequence,
        initialBacklogCount: initialBacklogCount || 0,
        pages,
        reason: 'DRAIN_LIMIT',
        remainingBacklogCount: Math.max(0, headSequence - cursor),
        requestedCursor,
        status: 'INCOMPLETE'
      });
    };
    const result = readTail.then(operation, operation);
    readTail = result.catch(() => {});
    return result;
  }

  return Object.freeze({
    deliver,
    drain,
    getCursor,
    read
  });
}

module.exports = Object.freeze({
  DEFAULT_MAX_DRAIN_MESSAGES,
  DEFAULT_PAGE_SIZE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RelayTransportError,
  createMemoryRelayState,
  createRelayTransport,
  createTransport: createRelayTransport
});
