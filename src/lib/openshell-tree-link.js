'use strict';

// The line between a worker's own ToolsEnabled server and the tree that holds
// it, inside one OpenShell sandbox.
//
// Every worker on the tree runs its own ToolsEnabled MCP server: its CLI starts
// one, over stdio, exactly as the person's CLI starts the root's. Only the ROOT
// server holds the tree -- the workers' processes, the records, the courier --
// so a worker's server does not decide anything about the tree itself. It
// carries each agent.* and agent_comms.* request to the root over a Unix socket
// under the state root (or a named pipe on Windows), and brings the answer back,
// refusals included.
//
// WHO IS ASKING is established here, never claimed. Each worker session is
// started with its own random link token, and the root maps a token to exactly
// one node and one session of it. A request names no caller; the caller is the
// token. A token from a replaced session (restart, resume) no longer maps to
// anything and is refused.
//
// THE SANDBOX IS STILL THE BOUNDARY. Every process in the sandbox runs as the
// same user, so the token binds identity between cooperating workers; it does
// not defend one worker from another that goes looking for it. On Linux the
// socket and its folder are private to that user. On Windows the caller still
// needs the session's random token to make a request.
//
// One JSON line each way per request, then the connection closes.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL = 1;
const MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// sun_path holds 108 bytes on Linux, including the terminator.
const MAX_SOCKET_PATH_BYTES = 100;

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

/** A usable local IPC address for `preferred`, stable for this tree. */
function socketPathFor(preferred) {
  if (process.platform === 'win32') {
    // Windows cannot listen on a Unix socket pathname. A named pipe does not
    // leave a stale file after a crash, and hashing the state path keeps names
    // distinct across installations and user profiles.
    const digest = crypto.createHash('sha256').update(preferred, 'utf8').digest('hex').slice(0, 32);
    return `\\\\.\\pipe\\te-tree-${digest}`;
  }
  if (Buffer.byteLength(preferred, 'utf8') <= MAX_SOCKET_PATH_BYTES) return preferred;
  const digest = crypto.createHash('sha256').update(preferred, 'utf8').digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `te-tree-${digest}.sock`);
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sameToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicError(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'OPENSHELL_TREE_LINK_FAILED';
  const message = String(error && error.message ? error.message : error).slice(0, 4000);
  return { code, message };
}

function readOneLine(socket, onLine, onFail) {
  let buffered = '';
  let done = false;
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    if (done) return;
    buffered += chunk;
    const index = buffered.indexOf('\n');
    if (index >= 0) {
      done = true;
      onLine(buffered.slice(0, index));
    } else if (Buffer.byteLength(buffered, 'utf8') > MAX_LINE_BYTES) {
      done = true;
      onFail(refusal('OPENSHELL_TREE_LINK_TOO_LARGE', 'A tree request or answer was larger than the link carries.'));
    }
  });
  socket.on('end', () => { if (!done) { done = true; onFail(refusal('OPENSHELL_TREE_LINK_CLOSED', 'The tree link closed before answering.')); } });
  socket.on('error', error => { if (!done) { done = true; onFail(error); } });
}

/** Is a live server answering on this path? A refused connection means a stale file. */
function probe(socketPath) {
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    const finish = live => { socket.destroy(); resolve(live); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 1000).unref();
  });
}

/**
 * The root's side. `handle(token, op, request)` answers one request (a value
 * or a promise); a throw becomes a refusal with its code and message.
 */
function createTreeLinkServer({ socketPath, handle }) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) {
    throw refusal('OPENSHELL_TREE_LINK_INVALID', 'The tree link needs an absolute socket path.');
  }
  if (typeof handle !== 'function') throw refusal('OPENSHELL_TREE_LINK_INVALID', 'The tree link needs a request handler.');
  const connections = new Set();
  const namedPipe = process.platform === 'win32';
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    readOneLine(socket, async line => {
      let answer;
      try {
        const message = JSON.parse(line);
        if (!message || message.v !== PROTOCOL || typeof message.op !== 'string') {
          throw refusal('OPENSHELL_TREE_LINK_INVALID', 'The tree request was not understood.');
        }
        answer = { ok: true, result: await handle(message.token, message.op, message.request || {}) };
      } catch (error) {
        answer = { ok: false, error: publicError(error) };
      }
      try { socket.end(`${JSON.stringify(answer)}\n`); } catch { /* the asker went away */ }
    }, () => socket.destroy());
  });
  let listening = false;
  return Object.freeze({
    socketPath,
    async listen() {
      if (!namedPipe) {
        fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
        if (fs.existsSync(socketPath)) {
          if (await probe(socketPath)) {
            throw refusal('OPENSHELL_TREE_LINK_IN_USE', 'Another ToolsEnabled server already holds this tree.');
          }
          fs.rmSync(socketPath, { force: true });
        }
      }
      await new Promise((resolve, reject) => {
        const onError = error => reject(namedPipe && error.code === 'EADDRINUSE'
          ? refusal('OPENSHELL_TREE_LINK_IN_USE', 'Another ToolsEnabled server already holds this tree.')
          : error);
        server.once('error', onError);
        server.listen(socketPath, () => { server.off('error', onError); resolve(); });
      });
      listening = true;
      if (!namedPipe) {
        try { fs.chmodSync(socketPath, 0o600); } catch { /* the folder is private anyway */ }
      }
      server.unref();
    },
    async close() {
      if (!listening) return;
      listening = false;
      for (const socket of connections) socket.destroy();
      await new Promise(resolve => server.close(() => resolve()));
      if (!namedPipe) {
        try { fs.rmSync(socketPath, { force: true }); } catch { /* already gone */ }
      }
    },
  });
}

/** A worker server's side: one request, one answer. Refusals arrive as errors with their code. */
function treeLinkRequest({ socketPath, token, op, request = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let settled = false;
    const timer = setTimeout(() => finish(refusal('OPENSHELL_TREE_LINK_UNAVAILABLE', 'The tree did not answer in time.')), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    }
    socket.once('connect', () => socket.write(`${JSON.stringify({ v: PROTOCOL, token, op, request })}\n`));
    readOneLine(socket, line => {
      let answer;
      try { answer = JSON.parse(line); } catch { return finish(refusal('OPENSHELL_TREE_LINK_INVALID', 'The tree answered in a form this server cannot read.')); }
      if (answer && answer.ok === true) return finish(null, answer.result);
      const detail = answer && answer.error ? answer.error : {};
      return finish(refusal(typeof detail.code === 'string' ? detail.code : 'OPENSHELL_TREE_LINK_FAILED',
        typeof detail.message === 'string' ? detail.message : 'The tree refused the request.'));
    }, error => finish(error && error.code === 'ENOENT' || error && error.code === 'ECONNREFUSED'
      ? refusal('OPENSHELL_TREE_UNREACHABLE', 'The ToolsEnabled server that holds this tree is not running, so nothing was changed.')
      : error));
  });
}

module.exports = Object.freeze({
  PROTOCOL,
  MAX_SOCKET_PATH_BYTES,
  socketPathFor,
  newToken,
  sameToken,
  createTreeLinkServer,
  treeLinkRequest,
});
