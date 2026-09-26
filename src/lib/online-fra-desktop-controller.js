'use strict';

// The parent's private Node IPC channel controls the already authenticated peer
// leg. It cannot supply an address, credential, header, replacement peer or lease.
const crypto = require('node:crypto');
const READS = Object.freeze({
  'agent:availability': ['/v1/agent/availability'],
  'agent:confinement': ['/v1/agent/confinement'],
  'agent:tools': ['/v1/agent/tools'],
  'agent:startable-tiers': ['/v1/agent/startable-tiers'],
  'agent:session-accounts': ['/v1/agent/session-accounts'],
  'agent:local-messages': ['/v1/agent/local-messages', 'limit'],
  'agent:history': ['/v1/agent/history', 'limit'],
  'agent:usage': ['/v1/agent/usage', 'limit'],
  'agent:requests': ['/v1/agent/requests', 'scope', 'key'],
  'agent:ledger': ['/v1/agent/ledger', 'scope', 'key', 'removed'],
  'agent:profiles': ['/v1/agent/profiles'],
  'agent:models': ['/v1/agent/models', 'sessionId'],
  'agent:remote-status': ['/v1/agent/remote-status'],
  'agent:events': ['/v1/agent/events', 'after', 'waitMs', 'sessionId'],
  'org:read': ['/v1/org'],
  'org:export': ['/v1/org/export'],
  'bridge:status': ['/v1/status'],
  'bridge:contract': ['/v1/contract'],
  'bridge:runtime': ['/v1/runtime'],
  'bridge:settings': ['/v1/settings'],
  'bridge:owner-prompts': ['/v1/owner-prompts'],
  'bridge:research-local-tiers-status': ['/v1/research/local-tiers-status'],
});
const WRITES = Object.freeze(Object.fromEntries([
  'agent:start', 'agent:send', 'agent:tree-address', 'agent:request',
  'agent:request-edit', 'agent:request-remove', 'agent:request-decide',
  'agent:profile-remove', 'agent:interrupt', 'agent:approval-answer',
  'agent:rewind', 'agent:effort', 'agent:close',
  'org:reparent', 'org:assign-role', 'org:ensure-seat', 'org:release-seat',
  'org:create-role', 'org:edit-role', 'org:reset-role', 'org:reset',
].map(name => [name, `/v1/${name.replace(':', '/')}`])));
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 96 * 1024;
const ID = /^[a-f0-9]{32}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const refuse = (code, outcome = 'not-sent') => ({ ok: false, code, outcome });

function requestFor(operation, params) {
  if (typeof operation !== 'string' || !plain(params)) return null;
  let json;
  try { json = JSON.stringify(params); } catch { return null; }
  if (Buffer.byteLength(json) > MAX_REQUEST_BYTES) return null;
  if (Object.hasOwn(READS, operation)) {
    const [path, ...keys] = READS[operation];
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (!keys.includes(key) || !['string', 'number', 'boolean'].includes(typeof value)) return null;
      if (String(value).length > 256) return null;
      query.set(key, String(value));
    }
    return { method: 'GET', path: path + (query.size ? `?${query}` : ''), options: {} };
  }
  if (!Object.hasOwn(WRITES, operation)) return null;
  return { method: 'POST', path: WRITES[operation], options: {
    headers: { 'content-type': 'application/json', 'x-request-id': crypto.randomBytes(16).toString('hex') },
    body: Buffer.from(json),
  } };
}

function createDesktopController({ send, now = Date.now } = {}) {
  if (typeof send !== 'function') throw new TypeError('send is required');
  let current = null;
  let heartbeat = null;
  const active = new Set();
  function snapshot() {
    if (!current || current.closed || !Number.isFinite(current.handle.leaseExpiresAtMs)
      || current.handle.leaseExpiresAtMs <= now()
      || current.handle.lease?.peerDeviceId !== current.peerId) return { state: 'unavailable', peer: null };
    return { state: current.ready ? 'ready' : 'waiting', expiresAtMs: current.handle.leaseExpiresAtMs, peer: {
      id: current.peerId, selection: current.selection,
    } };
  }
  function publish() { send({ type: 'fra:state', value: snapshot() }); }
  function matches(selection) {
    return current && !current.closed && current.selection === selection
      && current.handle.lease?.peerDeviceId === current.peerId
      && snapshot().state !== 'unavailable';
  }
  function attach(handle) {
    clearInterval(heartbeat);
    heartbeat = null;
    if (current) current.closed = true;
    current = null;
    const peerId = handle?.lease?.peerDeviceId;
    if (handle && handle.solo !== true && typeof peerId === 'string'
      && /^[a-zA-Z0-9_-]{1,128}$/.test(peerId)) {
      const record = { handle, peerId, selection: crypto.randomBytes(16).toString('hex'), ready: false, closed: false };
      current = record;
      // Renewal updates the handle in place. Report its actual expiry; an old
      // announcement cannot keep an expired or re-paired workspace alive.
      heartbeat = setInterval(publish, 1000);
      heartbeat.unref?.();
      Promise.resolve(handle.handshake).then(value => {
        if (current !== record || record.closed || value?.solo === true) return;
        record.ready = true;
        publish();
      }, () => { /* A late hello can still succeed; an explicit status request is allowed while waiting. */ });
      Promise.resolve(handle.closed).then(() => {
        record.closed = true;
        if (current === record) { clearInterval(heartbeat); publish(); }
      }, () => {
        record.closed = true;
        if (current === record) { clearInterval(heartbeat); publish(); }
      });
    }
    publish();
  }
  async function receive(packet) {
    if (!plain(packet) || !ID.test(packet.id || '')) return;
    const reply = value => send({ type: 'fra:reply', id: packet.id, value });
    if (packet.type === 'fra:status' && Object.keys(packet).length === 2) { reply(snapshot()); return; }
    if (packet.type !== 'fra:request' || Object.keys(packet).some(key => !['type', 'id', 'selection', 'operation', 'params'].includes(key))) {
      reply(refuse('REMOTE_REQUEST_REFUSED')); return;
    }
    const request = requestFor(packet.operation, packet.params);
    if (!request || !ID.test(packet.selection || '')) { reply(refuse('REMOTE_REQUEST_REFUSED')); return; }
    if (!matches(packet.selection)) { reply(refuse('REMOTE_CONNECTION_CHANGED')); return; }
    if (active.has(packet.id) || active.size >= 16) { reply(refuse('REMOTE_REQUEST_BUSY')); return; }
    active.add(packet.id);
    const selected = current;
    try {
      const result = await selected.handle.request(request.method, request.path, request.options);
      // Never display a result from an expired, revoked or replaced connection.
      if (current !== selected || !matches(packet.selection)) {
        reply(refuse('REMOTE_OUTCOME_UNKNOWN', request.method === 'POST' ? 'unknown' : 'unavailable')); return;
      }
      if (!result || !Number.isInteger(result.status) || result.status < 100 || result.status > 599
        || !Buffer.isBuffer(result.body) || result.body.length > MAX_RESPONSE_BYTES) {
        reply(refuse('REMOTE_OUTCOME_UNKNOWN', request.method === 'POST' ? 'unknown' : 'unavailable')); return;
      }
      let value;
      try { value = JSON.parse(result.body.toString('utf8')); } catch {
        reply(refuse('REMOTE_OUTCOME_UNKNOWN', request.method === 'POST' ? 'unknown' : 'unavailable')); return;
      }
      if (!plain(value)) { reply(refuse('REMOTE_OUTCOME_UNKNOWN', 'unknown')); return; }
      if (!selected.ready) { selected.ready = true; publish(); }
      reply({ ok: true, selection: selected.selection, status: result.status, value });
    } catch (error) {
      // No resubmission, including after a child restart. A lost response is not
      // evidence that a remote write did nothing.
      const notSent = error?.code === 'RELAY_SHELL_NO_SESSION';
      reply(refuse(notSent ? 'REMOTE_NOT_READY' : 'REMOTE_OUTCOME_UNKNOWN',
        notSent ? 'not-sent' : request.method === 'POST' ? 'unknown' : 'unavailable'));
    } finally { active.delete(packet.id); }
  }
  return { attach, receive, snapshot };
}

module.exports = { createDesktopController, requestFor, READS, WRITES, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES };
