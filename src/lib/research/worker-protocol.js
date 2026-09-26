'use strict';

// Private worker control, separate from research output and native Job proof.
// The launch key crosses only the retained worker stdin pipe, never argv, an
// environment variable, a runtime record, a diagnostic or a public tool.
const crypto = require('node:crypto');

const PREFIX = 'TOOLSENABLED_RESEARCH_CONTROL_V1 ';
const MAX_FRAME_BYTES = 8192;
const ID = /^[0-9a-f-]{36}$/i;
const KEY = /^[0-9a-f]{64}$/;
function failure(code) { return Object.assign(new Error('The private research worker control channel could not be verified.'), { code }); }
function exact(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function frame(body, secret) {
  if (!KEY.test(secret)) throw failure('RESEARCH_WORKER_CONTROL_INVALID');
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES / 2) throw failure('RESEARCH_WORKER_CONTROL_TOO_LARGE');
  const payload = Buffer.from(text).toString('base64');
  return `${PREFIX}${payload} ${crypto.createHmac('sha256', secret).update(payload).digest('hex')}\n`;
}
function decode(line, secret) {
  if (!line.startsWith(PREFIX)) return null;
  const parts = line.slice(PREFIX.length).split(' ');
  if (parts.length !== 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[0]) || !KEY.test(parts[1])) {
    throw failure('RESEARCH_WORKER_CONTROL_INVALID');
  }
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(parts[1], 'hex'))) throw failure('RESEARCH_WORKER_CONTROL_INVALID');
  let body;
  try { body = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8')); }
  catch { throw failure('RESEARCH_WORKER_CONTROL_INVALID'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('RESEARCH_WORKER_CONTROL_INVALID');
  return body;
}

function lines(input, { onLine, onError, onEnd }) {
  let pending = '';
  let failed = false;
  let detached = false;
  const fail = error => { if (!failed) { failed = true; onError(error); } };
  const data = chunk => {
    if (failed || detached) return;
    pending += chunk.toString('utf8');
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) break;
      const line = pending.slice(0, end).replace(/\r$/, '');
      pending = pending.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { fail(failure('RESEARCH_WORKER_CONTROL_TOO_LARGE')); return; }
      try { onLine(line); } catch (error) { fail(error); return; }
      if (detached) return;
    }
    if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) fail(failure('RESEARCH_WORKER_CONTROL_TOO_LARGE'));
  };
  const ended = () => { if (!failed) onEnd?.(); };
  input.on('data', data);
  input.on('error', fail);
  input.on('end', ended);
  return () => { detached = true; input.off('data', data); input.off('error', fail); input.off('end', ended); pending = ''; };
}

function sender(output, instanceId, secret) {
  return body => new Promise((resolve, reject) => {
    try { output.write(frame({ ...body, instanceId }, secret), error => error ? reject(failure('RESEARCH_WORKER_CONTROL_DISCONNECTED')) : resolve()); }
    catch { reject(failure('RESEARCH_WORKER_CONTROL_DISCONNECTED')); }
  });
}

function createWorkerControlSession({ input, output, instanceId, secret, onMessage, onError, onEnd }) {
  if (!ID.test(instanceId) || !KEY.test(secret) || !input || !output) throw failure('RESEARCH_WORKER_CONTROL_INVALID');
  const detach = lines(input, {
    onLine(line) {
      const body = decode(line, secret);
      if (!body) return; // Diagnostics never become acknowledgements.
      if (body.instanceId !== instanceId) throw failure('RESEARCH_WORKER_CONTROL_IDENTITY_MISMATCH');
      onMessage(body);
    }, onError, onEnd
  });
  return Object.freeze({
    send: sender(output, instanceId, secret),
    close: detach
  });
}

function runSupervisedWorker({ input = process.stdin, output = process.stdout, createWorker, closeDatabase,
  initTimeoutMs = 10000, signal } = {}) {
  if (typeof createWorker !== 'function' || typeof closeDatabase !== 'function') throw failure('RESEARCH_WORKER_CONTROL_INVALID');
  if (!Number.isSafeInteger(initTimeoutMs) || initTimeoutMs < 1 || initTimeoutMs > 60000
      || (signal !== undefined && (!(signal instanceof AbortSignal)))) throw failure('RESEARCH_WORKER_CONTROL_INVALID');
  return new Promise((resolve, reject) => {
    let worker = null;
    let active = null;
    let session = null;
    let binding = null;
    let opened = false;
    let stopping = false;
    let finished = null;
    let sequence = 0;
    let firstFailure = null;
    const timer = setTimeout(() => shutdown(failure('RESEARCH_WORKER_CONTROL_TIMEOUT')), initTimeoutMs);
    let detachInitial = () => {};

    const shutdown = error => {
      firstFailure = firstFailure || error || null;
      stopping = true; // Seal before an await or another command can run.
      try { worker?.stop(); } catch (stopError) { firstFailure = firstFailure || stopError; }
      if (finished) return finished;
      finished = (async () => {
        clearTimeout(timer);
        detachInitial();
        signal?.removeEventListener('abort', abort);
        if (active) { try { await active; } catch (runError) { firstFailure = firstFailure || runError; } }
        let workerDbClosed = !opened;
        try { if (opened) { await closeDatabase(); workerDbClosed = true; } }
        catch { firstFailure = firstFailure || failure('RESEARCH_WORKER_DB_CLOSE_FAILED'); }
        try {
          await session?.send({ type: 'stopped', sequence, admissionStopped: true, drained: true,
            workerDbClosed, databaseOpened: opened, code: firstFailure?.code || null });
        } catch { firstFailure = firstFailure || failure('RESEARCH_WORKER_CONTROL_DISCONNECTED'); }
        input.pause?.();
        if (firstFailure) reject(firstFailure);
        else resolve(Object.freeze({ workerDbClosed, databaseOpened: opened }));
      })();
      // The returned promise above is observed by the entrypoint; internal
      // event callbacks must never manufacture an unhandled rejection.
      finished.catch(() => {});
      return finished;
    };

    const abort = () => shutdown(failure('RESEARCH_WORKER_STOP_REQUESTED'));
    output.on('error', () => shutdown(failure('RESEARCH_WORKER_CONTROL_DISCONNECTED')));
    detachInitial = lines(input, {
      onLine(line) {
        if (stopping) return;
        if (binding) {
          const message = decode(line, binding.secret);
          if (!exact(message, ['type', 'sequence', 'instanceId']) || message.instanceId !== binding.instanceId
              || !Number.isSafeInteger(message.sequence) || message.sequence !== sequence + 1) throw failure('RESEARCH_WORKER_CONTROL_REPLAY');
          sequence = message.sequence;
          if (message.type === 'quiesce') { void shutdown(); return; }
          if (message.type !== 'start' || worker) throw failure('RESEARCH_WORKER_CONTROL_INVALID');
          opened = true;
          try {
            worker = createWorker();
            active = Promise.resolve(worker.runForever());
            void active.then(() => shutdown(), error => shutdown(error)).catch(() => {});
          } catch (error) { void shutdown(error); return; }
          void session.send({ type: 'started', sequence }).catch(error => shutdown(error));
          return;
        }
        let init;
        try { init = JSON.parse(line); } catch { throw failure('RESEARCH_WORKER_CONTROL_INVALID'); }
        if (!exact(init, ['version', 'type', 'instanceId', 'secret']) || init.version !== 1 || init.type !== 'init'
            || !ID.test(init.instanceId) || !KEY.test(init.secret)) throw failure('RESEARCH_WORKER_CONTROL_INVALID');
        clearTimeout(timer);
        binding = Object.freeze({ instanceId: init.instanceId, secret: init.secret });
        session = Object.freeze({ send: sender(output, init.instanceId, init.secret) });
        void session.send({ type: 'ready', sequence: 0 }).catch(error => shutdown(error));
      }, onError: error => shutdown(error), onEnd: () => shutdown(failure('RESEARCH_WORKER_CONTROL_DISCONNECTED'))
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) void abort();
  });
}

module.exports = Object.freeze({ PREFIX, MAX_FRAME_BYTES, createWorkerControlSession, runSupervisedWorker });
