'use strict';

// Latest handshake per transport-bound actor, not a connection or permission
// assertion. One bounded file and a process lock retain simultaneous clients.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_ACTORS = 64;
const MAX_TEXT = 60;
const MAX_BYTES = 64 * 1024;
const FIELDS = Object.freeze(['requestedProtocolVersion', 'answeredProtocolVersion', 'clientName', 'clientVersion']);
function refusal() { return Object.assign(new Error('The saved MCP revision observations could not be read safely.'), { code: 'MCP_REVISIONS_UNREADABLE' }); }
function filePath(root = require('./runtime-state-root').resolveStateRoot().root) { return path.join(root, 'state', 'mcp-revisions.json'); }
function short(value) {
  if (typeof value !== 'string') return null;
  if (/te-host-|openshell:resolve:|bearer\s|(?:sk|ghp|github_pat)[-_]|(?:token|secret|password)\s*[:=]/i.test(value)) return '[redacted]';
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, MAX_TEXT);
}
function facts(params, answered) {
  return Object.freeze({ requestedProtocolVersion: short(params?.protocolVersion), answeredProtocolVersion: short(answered),
    clientName: short(params?.clientInfo?.name), clientVersion: short(params?.clientInfo?.version) });
}
function read({ root } = {}) {
  let fd;
  try {
    fd = fs.openSync(filePath(root), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw refusal();
    const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (data?.version !== 1 || Object.keys(data).sort().join(',') !== 'actors,version'
      || !Array.isArray(data.actors) || data.actors.length > MAX_ACTORS) throw refusal();
    const actors = new Set();
    for (const row of data.actors) {
      if (!row || Object.keys(row).sort().join(',') !== ['actor', 'at', ...FIELDS].sort().join(',')
        || typeof row.actor !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(row.actor) || actors.has(row.actor)
        || typeof row.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.at)
        || FIELDS.some(key => row[key] !== null && (typeof row[key] !== 'string' || short(row[key]) !== row[key]))) throw refusal();
      actors.add(row.actor);
    }
    return Object.freeze(data.actors.map(row => Object.freeze(row)));
  } catch (error) {
    if (error.code === 'ENOENT') return Object.freeze([]);
    throw refusal();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function record(actor, params, answered, { root, now = () => new Date(), registry = require('./agents/registry').activeRegistry() } = {}) {
  // Identity is supplied by the transport, never clientInfo or MCP params.
  if (typeof actor !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(actor) || !registry.has(actor)) return false;
  const file = filePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = require('./process-claim-lock').acquireLock(`${file}.lock`, { publishGraceMs: 5000, polls: 100 });
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    const actors = read({ root }).filter(row => row.actor !== actor);
    actors.push({ actor, at: now().toISOString(), ...facts(params, answered) });
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, actors: actors.slice(-MAX_ACTORS) })}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
    return true;
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    lock.release();
  }
}
function snapshot(options) {
  try { return Object.freeze({ state: 'available', actors: read(options) }); }
  catch { return Object.freeze({ state: 'unreadable', actors: Object.freeze([]) }); }
}
function format(saved) {
  if (saved?.state === 'unreadable') return ['MCP revisions       unavailable: saved observations could not be read'];
  return ['MCP revisions       latest observed handshake per actor (not a live connection check)',
    ...(saved?.actors?.length ? saved.actors.map(row => `  ${row.actor}: asked ${row.requestedProtocolVersion || 'unknown'}; answered ${row.answeredProtocolVersion || 'unknown'}; client ${row.clientName || 'unknown'} ${row.clientVersion || ''}; ${row.at}`) : ['  none recorded'])];
}
module.exports = Object.freeze({ MAX_ACTORS, MAX_TEXT, MAX_BYTES, filePath, facts, read, record, snapshot, format });
