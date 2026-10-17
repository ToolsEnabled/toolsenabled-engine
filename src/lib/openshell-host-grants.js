'use strict';

// Who may call the ToolsEnabled host outside the OpenShell sandboxes, and
// which of its tools (src/lib/openshell-host-server.js,
// adapters/openshell/HOST-OUTSIDE.md).
//
// A grant is one bearer token, made on the host and handed only to an OpenShell
// provider (`openshell provider create ... --credential <VARIABLE>`) whose
// profile binds it to the host's endpoint and to one agent CLI's executable.
// The sandbox then holds only OpenShell's placeholder; OpenShell's proxy puts
// the token on requests to the host. The host keeps the token's SHA-256 and
// never the token, so this file is not a credential. The grant names the
// actor its records are labelled with and the host tools it may call.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { OPENSHELL_HOST_TOOLS } = require('./openshell-host-tools');

const FORMAT = 'toolsenabled.openshell-host-grants.v1';
const GRANT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const { activeRegistry } = require('./agents/registry');
const TOKEN_PREFIX = 'te-host-';
const TOKEN_RE = /^te-host-[A-Za-z0-9_-]{43}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_GRANTS = 64;

class HostGrantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostGrantError';
    this.code = code;
  }
}

function grantsPath(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new HostGrantError('HOST_ROOT_INVALID', 'The host root must be an absolute path.');
  return path.join(root, 'openshell-host', 'grants.json');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** The tool names a grant may carry: known host tools, each once, at least one. */
function checkedTools(tools, served = OPENSHELL_HOST_TOOLS) {
  const list = Array.isArray(tools) ? tools : String(tools || '').split(',').map((name) => name.trim()).filter(Boolean);
  if (list.length === 0) throw new HostGrantError('HOST_GRANT_TOOLS_EMPTY', 'A grant needs at least one host tool.');
  const unknown = list.filter((name) => !served.includes(name));
  if (unknown.length > 0) {
    throw new HostGrantError('HOST_GRANT_TOOL_UNKNOWN', `Not served by the host: ${unknown.join(', ')}. The host serves: ${served.join(', ')}.`);
  }
  if (new Set(list).size !== list.length) throw new HostGrantError('HOST_GRANT_TOOLS_REPEATED', 'A grant names each tool once.');
  return Object.freeze([...list]);
}

function checkedGrant(value, served) {
  const fields = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  if (fields !== 'actor,createdAt,id,tokenSha256,tools'
      || !GRANT_ID_RE.test(value.id) || !activeRegistry().has(value.actor)
      || !SHA256_RE.test(value.tokenSha256) || typeof value.createdAt !== 'string' || !Array.isArray(value.tools)) {
    throw new HostGrantError('HOST_GRANTS_INVALID', 'The host grants file is not valid; nothing was served from it.');
  }
  let tools;
  try { tools = checkedTools(value.tools, served); } catch {
    throw new HostGrantError('HOST_GRANTS_INVALID', 'The host grants file is not valid; nothing was served from it.');
  }
  return Object.freeze({ ...value, tools });
}

/** Every grant, validated; none when the file does not exist yet. */
function readGrants(root, { served = OPENSHELL_HOST_TOOLS } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(grantsPath(root), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return Object.freeze([]);
    throw new HostGrantError('HOST_GRANTS_UNREADABLE', 'The host grants file could not be read.');
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw new HostGrantError('HOST_GRANTS_INVALID', 'The host grants file is not valid; nothing was served from it.'); }
  if (!data || data.format !== FORMAT || !Array.isArray(data.grants) || data.grants.length > MAX_GRANTS) {
    throw new HostGrantError('HOST_GRANTS_INVALID', 'The host grants file is not valid; nothing was served from it.');
  }
  const grants = data.grants.map((grant) => checkedGrant(grant, served));
  if (new Set(grants.map((grant) => grant.id)).size !== grants.length) {
    throw new HostGrantError('HOST_GRANTS_INVALID', 'The host grants file names one grant twice.');
  }
  return Object.freeze(grants);
}

function writeGrants(root, grants) {
  const file = grantsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ format: FORMAT, grants }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/**
 * A new grant and its token. The token is returned once, for the caller to
 * hand to an OpenShell provider; only its hash is stored.
 */
function createGrant(root, { id, actor, tools, served = OPENSHELL_HOST_TOOLS, randomBytes = crypto.randomBytes, now = () => new Date() } = {}) {
  if (!GRANT_ID_RE.test(String(id))) {
    throw new HostGrantError('HOST_GRANT_ID_INVALID', 'A grant id is lowercase letters, digits and hyphens, starting with a letter, at most 32 characters.');
  }
  if (!activeRegistry().has(actor)) throw new HostGrantError('HOST_GRANT_ACTOR_INVALID', `A grant's actor is one of: ${activeRegistry().ids.join(', ')}.`);
  const checked = checkedTools(tools, served);
  const grants = [...readGrants(root, { served })];
  if (grants.some((grant) => grant.id === id)) {
    throw new HostGrantError('HOST_GRANT_EXISTS', `There is already a grant "${id}". Remove it first to replace its token.`);
  }
  if (grants.length >= MAX_GRANTS) throw new HostGrantError('HOST_GRANTS_FULL', `The host keeps at most ${MAX_GRANTS} grants.`);
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const grant = Object.freeze({ id, actor, tools: checked, tokenSha256: tokenHash(token), createdAt: now().toISOString() });
  writeGrants(root, [...grants, grant]);
  return Object.freeze({ grant, token });
}

function removeGrant(root, id, { served = OPENSHELL_HOST_TOOLS } = {}) {
  const grants = readGrants(root, { served });
  if (!grants.some((grant) => grant.id === id)) throw new HostGrantError('HOST_GRANT_UNKNOWN', `There is no grant "${id}".`);
  writeGrants(root, grants.filter((grant) => grant.id !== id));
  return id;
}

/** The grant whose token this is, compared by hash in constant time; else null. */
function grantForToken(grants, presented) {
  if (typeof presented !== 'string' || !TOKEN_RE.test(presented)) return null;
  const digest = Buffer.from(tokenHash(presented), 'hex');
  let found = null;
  for (const grant of grants) {
    if (crypto.timingSafeEqual(digest, Buffer.from(grant.tokenSha256, 'hex'))) found = grant;
  }
  return found;
}

module.exports = Object.freeze({
  FORMAT, GRANT_ID_RE, TOKEN_PREFIX, HostGrantError,
  checkedTools, createGrant, grantForToken, grantsPath, readGrants, removeGrant, tokenHash
});
