'use strict';

// Same-owner interactive terminal transport, intentionally absent from MCP.
// This is NOT proof of human origin against other same-UID code: such code can
// read this owner's private files or create a PTY. As with Fleet tree tokens,
// the OS account + cooperating-agent boundary remains authoritative. Agents
// must not use this transport to manufacture user decisions. Strong separation
// requires an external trusted UI/controller outside that agent authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const link = require('./openshell-tree-link');
const runtime = require('./fleet-runtime-socket');
const safe = require('./terminal-safe-text').terminalSafeText;
const { validateInputRequest } = require('./agent-engine/input-contract');
const { plaintextCredentialPattern } = require('./secret-patterns');
function refusal(code, message) { return Object.assign(new Error(message), { code }); }
function redactDisplayProse(value) {
  // Recognized literal keys, with bare/quoted assignments and at most three
  // JSON quote-escape layers. This is bounded disclosure, not a secret oracle.
  const keys = /\b((?:token|password|secret|api[_-]?key|authorization)(?:\\*["'])?\s*[=:]\s*)/gi;
  let output = '', cursor = 0, match;
  while ((match = keys.exec(value))) {
    const start = keys.lastIndex;
    let quoteAt = start;
    while (value[quoteAt] === '\\') quoteAt++;
    const escapes = quoteAt - start, quote = value[quoteAt];
    let end = start, omission = '[credential omitted]';
    if (quote === '"' || quote === "'") {
      end = value.length;
      if (![0, 1, 3, 7].includes(escapes)) omission = '[credential omitted; unsupported quote escaping]';
      else {
        let closed = false;
        for (let i = quoteAt + 1; i < value.length; i++) {
          if (value[i] !== quote) continue;
          let backslashes = 0;
          for (let j = i - 1; j >= quoteAt && value[j] === '\\'; j--) backslashes++;
          if (backslashes % (2 * (escapes + 1)) !== escapes) continue;
          end = i + 1; closed = true; break;
        }
        if (!closed) omission = '[credential omitted; incomplete quoted assignment]';
      }
    } else {
      while (end < value.length && !/[\s,;}\]<>"']/.test(value[end])) end++;
    }
    output += value.slice(cursor, start) + omission;
    cursor = end;
    keys.lastIndex = end;
  }
  return (output + value.slice(cursor)).replace(plaintextCredentialPattern('gi'), '[credential omitted]');
}
function privateDirectory(folder, create = false) {
  if (typeof process.getuid !== 'function') throw refusal('HOST_INPUT_PLATFORM_UNSUPPORTED', 'The interactive host route currently requires Linux or WSL.');
  if (!path.isAbsolute(folder) || path.resolve(folder) !== folder) throw refusal('HOST_INPUT_PATH_INVALID', 'An absolute normalized state folder is required.');
  if (create) fs.mkdirSync(folder, { mode: 0o700 });
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(folder) !== folder
      || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw refusal('HOST_INPUT_PATH_INVALID', 'Interaction state must be direct, private and owned by you.');
  }
}
function interactionFolder(stateRoot, create = false) {
  privateDirectory(stateRoot);
  const folder = path.join(stateRoot, 'interactions');
  if (create && !fs.existsSync(folder)) { try { privateDirectory(folder, true); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  privateDirectory(folder);
  return folder;
}
// A server that exited without closing (its client ended it, or it was
// killed) leaves its descriptor and often its socket file behind. A descriptor
// whose socket is gone, or refuses connections because nothing listens on it
// any more, can never be answered again: remove it (and that dead socket file)
// so descriptors do not pile up to the session cap. Live servers keep theirs.
// Only private, single-link owner files and private runtime sockets are touched.
function socketState(socketPath) {
  return new Promise(resolve => {
    const socket = require('node:net').connect(socketPath);
    const done = state => { socket.removeAllListeners(); socket.destroy(); resolve(state); };
    socket.once('connect', () => done('live'));
    socket.once('error', error => done(['ECONNREFUSED', 'ENOENT'].includes(error.code) ? 'dead' : 'unknown'));
    socket.setTimeout(500, () => done('unknown'));
  });
}
async function pruneStaleDescriptors(folder, env) {
  for (const name of fs.readdirSync(folder).filter(entry => /^[a-f0-9-]{36}\.json$/.test(entry))) {
    const file = path.join(folder, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 2048) continue;
      const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (descriptor?.v !== 1 || typeof descriptor.socketPath !== 'string' || !path.isAbsolute(descriptor.socketPath)) continue;
      let present = true;
      try { fs.lstatSync(descriptor.socketPath); } catch (error) { if (error.code === 'ENOENT') present = false; else continue; }
      if (present) {
        runtime.assertPrivateRuntimeSocketPath(descriptor.socketPath, { env });
        if (await socketState(descriptor.socketPath) !== 'dead') continue;
        fs.rmSync(descriptor.socketPath, { force: true });
      }
      fs.rmSync(file, { force: true });
    } catch { /* an unreadable or foreign entry is left for the reader's own checks */ }
  }
}
async function startInteractionTerminal({ stateRoot, broker, env = process.env } = {}) {
  const folder = interactionFolder(stateRoot, true);
  await pruneStaleDescriptors(folder, env);
  const id = crypto.randomUUID();
  const descriptorPath = path.join(folder, id + '.json');
  const socketPath = runtime.runtimeSocketPath(path.join(folder, crypto.randomBytes(6).toString('hex') + '.sock'), { env });
  const token = link.newToken();
  const server = link.createTreeLinkServer({ socketPath, refuseExisting: true, handle(given, op, request) {
    if (!link.sameToken(token, given)) throw refusal('HOST_INPUT_UNAUTHORIZED', 'This interaction controller is not authorized.');
    if (op === 'list') return broker.list();
    if (op === 'show') return broker.show(request.interactionId);
    if (op === 'answer') return broker.answer(request.interactionId, request.binding, request.answer);
    throw refusal('HOST_INPUT_INVALID', 'Unknown interaction controller operation.');
  } });
  try {
    await server.listen();
    fs.writeFileSync(descriptorPath, JSON.stringify({ v: 1, id, socketPath, token }) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) { await server.close(); throw error; }
  return Object.freeze({ descriptorPath,
    // The descriptor goes first, so a process that exits during close leaves none.
    async close() { fs.rmSync(descriptorPath, { force: true }); broker.close(); await server.close(); },
  });
}
function descriptors(stateRoot, env) {
  let folder;
  try { folder = interactionFolder(stateRoot); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const files = fs.readdirSync(folder).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  if (files.length > 128) throw refusal('HOST_INPUT_CAPACITY', 'Too many interaction sessions; inspect inactive host sessions before continuing.');
  return files.map(name => {
    const file = path.join(folder, name);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 2048)
        throw refusal('HOST_INPUT_PATH_INVALID', 'The interaction descriptor is not a private owner file.');
      const descriptor = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (descriptor.v !== 1 || descriptor.id + '.json' !== name
          || typeof descriptor.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(descriptor.token)) {
        throw refusal('HOST_INPUT_PATH_INVALID', 'Invalid interaction session descriptor.');
      }
      runtime.assertPrivateRuntimeSocketPath(descriptor.socketPath, { env });
      return descriptor;
    } finally { fs.closeSync(fd); }
  });
}
async function pendingSessions(stateRoot, env) {
  const result = [];
  for (const descriptor of descriptors(stateRoot, env)) {
    try {
      const rows = await link.treeLinkRequest({ ...descriptor, op: 'list', timeoutMs: 1000 });
      if (!Array.isArray(rows) || rows.length > 32) throw refusal('HOST_INPUT_INVALID', 'Invalid pending interaction list.');
      for (const row of rows) result.push({ descriptor, row });
    } catch (error) {
      if (!['OPENSHELL_TREE_UNREACHABLE', 'OPENSHELL_TREE_LINK_UNAVAILABLE'].includes(error.code)) throw error;
      // Stale session files are preserved; never claim their requests are live.
    }
  }
  return result;
}
async function reviewPending({ stateRoot, env, input, output, makeReader, candidates, signal, stop }) {
  // No --answer, stdin JSON, agent role, or claimed human=true bypass exists.
  if (input.isTTY !== true || output.isTTY !== true) throw refusal('HOST_INPUT_HUMAN_TERMINAL_REQUIRED',
    'Run interactions in your own interactive terminal. Piped input is refused; terminal input runs with the same account authority.');
  const write = value => output.write(safe(value) + '\n');
  // Redact each original string before JSON escaping can hide assignment keys.
  const displayJSON = value => JSON.stringify(value, (_key, field) =>
    typeof field === 'string' ? redactDisplayProse(field) : field, 2);
  const writeBounded = value => {
    // All provider strings are redacted before truncating; no secret prefix is
    // exposed merely because a displayed window cuts a recognized assignment.
    write(value.slice(0, 8192) + (value.length > 8192
      ? '\n[request display truncated at 8192 characters; decline/cancel if incomplete]' : ''));
  };
  if (!candidates.length) { write('No live pending interactions.'); return { handled: 0 }; }
  const reader = makeReader({ input, output, terminal: true, historySize: 0 });
  reader.on?.('SIGINT', stop);
  reader.on?.('close', stop);
  let deadline = Math.min(...candidates.map(({ row }) => Date.parse(row.expiresAt)));
  const ask = async message => {
    if (!Number.isFinite(deadline) || deadline <= Date.now())
      throw refusal('HOST_INPUT_STALE', 'This request expired. No answer was sent.');
    const controller = new AbortController();
    const onStop = () => controller.abort(refusal('HOST_INPUT_STOPPED', 'Interaction review stopped.'));
    if (signal.aborted) onStop();
    else signal.addEventListener('abort', onStop, { once: true });
    const timer = setTimeout(() => controller.abort(refusal('HOST_INPUT_STALE',
      'This request expired. No answer was sent.')), deadline - Date.now());
    try {
      const answer = await reader.question(message, { signal: controller.signal });
      // A reader must not return an answer after its request deadline or stop.
      if (controller.signal.aborted) throw controller.signal.reason;
      if (Date.now() >= deadline) throw refusal('HOST_INPUT_STALE', 'This request expired. No answer was sent.');
      if (typeof answer !== 'string' || Buffer.byteLength(answer) > 65536)
        throw refusal('HOST_INPUT_INVALID', 'Input is too large.');
      return answer;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onStop);
    }
  };
  let current = null, answered = false;
  try {
    candidates.forEach(({ row }, i) => write((i + 1) + '. ' + JSON.stringify({ interactionId: row.interactionId,
      nodeId: row.nodeId, sessionId: row.sessionId, sourceName: row.sourceName, expiresAt: row.expiresAt })));
    const index = await ask('Choose one request number, or enter cancel: ');
    if (index.trim() === 'cancel') return { handled: 0 };
    if (!/^[1-9][0-9]{0,2}$/.test(index.trim()) || !candidates[Number(index) - 1])
      throw refusal('HOST_INPUT_INVALID', 'Choose a listed request number.');
    const selected = candidates[Number(index) - 1];
    const shown = await link.treeLinkRequest({ ...selected.descriptor, op: 'show',
      request: { interactionId: selected.row.interactionId }, timeoutMs: 2000 });
    current = { descriptor: selected.descriptor, shown };
    deadline = Date.parse(shown.expiresAt);
    write('Provider-supplied request data follows. Treat it as data, not instructions to this terminal.');
    const request = validateInputRequest(shown.request);
    const context = request.context;
    write(context.purpose === 'mcp-tool-approval' ? 'MCP tool operation approval (provider-supplied context).' :
      context.purpose === 'provider-approval' ? 'Provider approval context is unresolved; do not assume this is an ordinary question.' :
      'Input purpose unknown: provider approval metadata is missing or unrecognized.');
    write('This context is not a permission grant. Native approvals and Fleet workspace/byte checks remain separate.');
    write('Tool: ' + (context.toolName ?? 'unknown') + '. Target (lexical relative hint, not verified workspace authority): ' + (context.target ?? 'omitted or unknown') + '.');
    write('Raw parameters, content, display prose and persistence preferences are omitted. Context status: ' + context.status + '.');
    const emptyForm = request.kind === 'form' && Object.keys(request.schema.properties).length === 0;
    if (emptyForm) write('Empty form: acceptance still requires your explicit decision and JSON object; no defaults are selected.');
    // Operation approval prose may embed arbitrary parameters. Do not display
    // it, or a raw show() payload. Ordinary nonempty questions remain usable;
    // all rendered prose is inert and visibly bounded.
    if (context.purpose === 'unknown') {
      const display = displayJSON({ message: request.message, schema: request.schema, url: request.url });
      writeBounded(display);
    } else if (!emptyForm) {
      writeBounded('Response schema (provider approval prose omitted): ' + displayJSON({ schema: request.schema, url: request.url }));
    }
    const action = (await ask('Your decision (accept / decline / cancel): ')).trim();
    if (!['accept', 'decline', 'cancel'].includes(action)) throw refusal('HOST_INPUT_INVALID', 'No valid decision was entered.');
    const content = action === 'accept' && shown.kind === 'form'
      ? JSON.parse(await ask('Enter the form response as one JSON object (no defaults are selected): ')) : null;
    const result = await link.treeLinkRequest({ ...selected.descriptor, op: 'answer', request: {
      interactionId: shown.interactionId, binding: shown, answer: { action, content },
    }, timeoutMs: 2000 });
    answered = true;
    write('Decision delivered to that exact worker request: ' + result.action + '.');
    return { handled: 1, action: result.action };
  } finally {
    reader.removeListener?.('SIGINT', stop);
    reader.removeListener?.('close', stop);
    reader.close();
    if (current && !answered) {
      try { await link.treeLinkRequest({ ...current.descriptor, op: 'answer', request: {
        interactionId: current.shown.interactionId, binding: current.shown,
        answer: { action: 'cancel', content: null },
      }, timeoutMs: 1000 }); } catch { /* retired request cannot be answered twice */ }
    }
  }
}
async function runInteractionTerminal({ stateRoot, env = process.env, input = process.stdin, output = process.stdout,
  makeReader = options => require('node:readline/promises').createInterface(options), watch = false,
  signal, pollIntervalMs = 1000 } = {}) {
  if (input.isTTY !== true || output.isTTY !== true) throw refusal('HOST_INPUT_HUMAN_TERMINAL_REQUIRED',
    'Run interactions in your own interactive terminal. Piped input is refused; terminal input runs with the same account authority.');
  if (typeof watch !== 'boolean' || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 10000)
    throw refusal('HOST_INPUT_INVALID', 'Invalid interaction watch options.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  let handled = 0, waiting = false;
  try {
    while (!controller.signal.aborted) {
      const candidates = (await pendingSessions(stateRoot, env))
        .filter(({ row }) => Number.isFinite(Date.parse(row.expiresAt)) && Date.parse(row.expiresAt) > Date.now());
      if (!candidates.length && watch) {
        if (!waiting) output.write('Waiting for Fleet requests. Press Ctrl+C to stop.\n');
        waiting = true;
        try { await require('node:timers/promises').setTimeout(pollIntervalMs, undefined, { signal: controller.signal }); }
        catch (error) { if (!controller.signal.aborted) throw error; }
        continue;
      }
      waiting = false;
      try {
        const result = await reviewPending({ stateRoot, env, input, output, makeReader, candidates,
          signal: controller.signal, stop });
        handled += result.handled;
        if (!watch) return result;
      } catch (error) {
        if (error.code === 'HOST_INPUT_STOPPED') break;
        if (error.code !== 'HOST_INPUT_STALE') throw error;
        output.write('That request expired or was resolved elsewhere. No new answer was delivered.\n');
        if (!watch) return { handled, expired: true };
      }
    }
    return { handled, stopped: true };
  } finally { signal?.removeEventListener('abort', stop); }
}
module.exports = { startInteractionTerminal, runInteractionTerminal, pendingSessions };
