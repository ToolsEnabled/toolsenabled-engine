'use strict';

require('../lib/isolated-environment').activate('playwright-call');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const {
  ROOT,
  PLAYWRIGHT_GATEWAY,
  OUTPUT_DIRECTORY,
  DEFAULT_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  MAX_STEPS,
  MAX_RESPONSE_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_STDERR_BYTES,
  assertContainedRegularFile,
  buildSpawnSpec,
  executeOneShot,
  invoke,
  parseCli,
  readRequestFile,
  safeOutputFile,
  safeSummary,
  sanitizeResponsesForPersistence,
  sameOpenedFile,
  validateOutputName,
  validateRequestObject,
  writeExclusiveOutput
} = require('../../tools/playwright-call');

function errorCode(code) {
  return error => error && error.code === code;
}

{
  const canary = 'PLAYWRIGHT-CANARY-PERSISTENCE-0123456789';
  const sanitized = sanitizeResponsesForPersistence(
    { tool: 'browser_snapshot', arguments: {} },
    [{ jsonrpc: '2.0', id: 1, result: {
      content: [{ type: 'text', text: `ordinary persisted text\nCookie: session=${canary}` }],
      structuredContent: { apiKey: canary, ordinary: 'kept' }
    } }]
  );
  assert.equal(JSON.stringify(sanitized).includes(canary), false);
  assert.match(sanitized[0].result.content[0].text, /ordinary persisted text/);
  assert.equal(sanitized[0].result.structuredContent.ordinary, 'kept');
}

function fakeFileStats({
  dev = 1n,
  ino = 2n,
  nlink = 1n,
  size = 42n,
  isFile = true
} = {}) {
  return {
    dev,
    ino,
    nlink,
    size,
    isFile: () => isFile
  };
}

function createFakeLauncher(onFrame, onStart) {
  const state = {
    captures: [],
    frames: [],
    child: null,
    close: null
  };

  state.spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let input = '';
    let closed = false;

    function close(code = 0) {
      if (closed) return;
      closed = true;
      child.exitCode = code;
      stdout.end();
      stderr.end();
      child.emit('close', code, null);
    }

    function respond(message) {
      queueMicrotask(() => {
        if (!closed) stdout.write(`${JSON.stringify(message)}\n`);
      });
    }

    function writeRawStdout(value) {
      queueMicrotask(() => {
        if (!closed) stdout.write(value);
      });
    }

    function writeRawStderr(value) {
      queueMicrotask(() => {
        if (!closed) stderr.write(value);
      });
    }

    const stdin = new Writable({
      write(chunk, encoding, callback) {
        input += chunk.toString('utf8');
        while (true) {
          const lineEnd = input.indexOf('\n');
          if (lineEnd < 0) break;
          const line = input.slice(0, lineEnd).trim();
          input = input.slice(lineEnd + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          state.frames.push(frame);
          if (onFrame) onFrame(frame, { child, close, respond, writeRawStdout, writeRawStderr });
        }
        callback();
      }
    });
    stdin.once('finish', () => queueMicrotask(() => close(0)));

    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.pid = 40000 + state.captures.length;
    child.exitCode = null;
    child.kill = () => { close(137); return true; };
    state.child = child;
    state.close = close;
    state.captures.push({ command, args: [...args], options: { ...options } });
    if (onStart) onStart({ child, close, respond, writeRawStdout, writeRawStderr });
    return child;
  };
  return state;
}

fs.mkdirSync(path.join(ROOT, 'scratch'), { recursive: true });
const directory = fs.mkdtempSync(path.join(ROOT, 'scratch', 'playwright-call-test-'));
const requestFile = path.join(directory, 'request.json');
const relativeRequest = path.relative(ROOT, requestFile);
const outputNames = [];

function writeText(text) {
  fs.writeFileSync(requestFile, text, 'utf8');
}

function writeRequest(value) {
  writeText(JSON.stringify(value));
}

async function run() {
  assert.equal(DEFAULT_TIMEOUT_MS, 120000,
    'the one-shot client must outlast the gateway\'s bounded owned-CDP attach timeout');
  writeRequest({ tool: 'browser_snapshot', arguments: {} });
  assert.deepEqual(readRequestFile(relativeRequest), {
    tool: 'browser_snapshot',
    arguments: {}
  });
  const containedRequest = assertContainedRegularFile(relativeRequest);
  assert.equal(typeof containedRequest.entry.dev, 'bigint');
  assert.equal(typeof containedRequest.entry.ino, 'bigint');
  assert.ok(containedRequest.entry.dev > 0n);
  assert.ok(containedRequest.entry.ino > 0n);
  assert.equal(containedRequest.entry.nlink, 1n);

  const matchingIdentity = fakeFileStats({ dev: 17n, ino: 23n, size: 40n });
  assert.equal(
    sameOpenedFile(matchingIdentity, fakeFileStats({ dev: 17n, ino: 23n, size: 99n })),
    true,
    'size changes do not replace the BigInt file identity'
  );
  assert.equal(
    sameOpenedFile(matchingIdentity, fakeFileStats({ dev: 17n, ino: 24n, size: 40n })),
    false,
    'different BigInt file IDs must not collide merely because size matches'
  );
  for (const unreliable of [
    fakeFileStats({ dev: 0n, ino: 23n }),
    fakeFileStats({ dev: 17n, ino: 0n }),
    { nlink: 1n, size: 42n, isFile: () => true },
    fakeFileStats({ dev: 17n, ino: 23n, nlink: 2n })
  ]) {
    assert.equal(
      sameOpenedFile(unreliable, unreliable),
      false,
      'zero, missing, or multi-link identities must fail closed'
    );
  }
  const collidingBigIntA = 16325548652124192n;
  const collidingBigIntB = collidingBigIntA + 1n;
  assert.equal(Number(collidingBigIntA), Number(collidingBigIntB));
  assert.equal(
    sameOpenedFile(
      fakeFileStats({ dev: 17, ino: Number(collidingBigIntA), size: 40 }),
      fakeFileStats({ dev: 17, ino: Number(collidingBigIntB), size: 40 })
    ),
    false,
    'rounded Number identities must never be accepted'
  );
  const maximumBatch = {
    steps: Array.from({ length: MAX_STEPS }, () => ({
      tool: 'browser_snapshot',
      arguments: {}
    }))
  };
  writeRequest(maximumBatch);
  assert.deepEqual(readRequestFile(relativeRequest), maximumBatch);
  const mutableBatch = {
    steps: [
      { tool: 'browser_tabs', arguments: { action: 'list' } },
      { tool: 'browser_tabs', arguments: { action: 'select', index: 1 } }
    ]
  };
  const immutableBatch = validateRequestObject(mutableBatch);
  mutableBatch.steps[1].arguments.action = 'close';
  assert.equal(immutableBatch.steps[1].arguments.action, 'select');
  assert.equal(Object.isFrozen(immutableBatch.steps[1].arguments), true);
  const selectFirst = validateRequestObject({
    tool: 'browser_tabs',
    arguments: { action: 'select', index: 1 }
  });
  assert.equal(selectFirst.tool, 'browser_tabs');
  assert.equal(selectFirst.arguments.action, 'select');
  assert.equal(Object.isFrozen(selectFirst.arguments), true);
  const maximumSelectFirst = validateRequestObject({
    steps: [
      { tool: 'browser_tabs', arguments: { action: 'select', index: 1 } },
      ...Array.from({ length: MAX_STEPS - 1 }, () => ({
        tool: 'browser_snapshot',
        arguments: {}
      }))
    ]
  });
  assert.equal(maximumSelectFirst.steps.length, MAX_STEPS);
  for (const invalidBatch of [
    { steps: [] },
    { steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ tool: 'browser_snapshot', arguments: {} })) }
  ]) {
    writeRequest(invalidBatch);
    assert.throws(
      () => readRequestFile(relativeRequest),
      errorCode('PLAYWRIGHT_CALL_STEP_COUNT_INVALID')
    );
  }
  for (const invalidBatch of [
    { steps: [{ tool: 'browser_snapshot' }] },
    { steps: [{ tool: 'browser_snapshot', arguments: {}, condition: 'always' }] },
    { steps: [{ tool: 'browser_snapshot', arguments: {} }], repeat: 2 }
  ]) {
    writeRequest(invalidBatch);
    assert.throws(
      () => readRequestFile(relativeRequest),
      error => ['PLAYWRIGHT_CALL_STEP_SHAPE_INVALID', 'PLAYWRIGHT_CALL_INPUT_SHAPE_INVALID'].includes(error.code)
    );
  }
  assert.throws(
    () => validateRequestObject({
      steps: Array.from({ length: MAX_STEPS }, () => ({
        tool: 'browser_type',
        arguments: { text: 'x'.repeat(Math.ceil(MAX_REQUEST_BYTES / MAX_STEPS)) }
      }))
    }),
    errorCode('PLAYWRIGHT_CALL_INPUT_SIZE_INVALID')
  );

  assert.throws(
    () => readRequestFile(path.join('..', 'outside-tools-enabled.json')),
    errorCode('PLAYWRIGHT_CALL_INPUT_OUTSIDE_ROOT')
  );

  const linked = path.join(directory, 'linked.json');
  let actualSymlinkCovered = false;
  try {
    fs.symlinkSync(requestFile, linked, 'file');
    assert.throws(
      () => readRequestFile(path.relative(ROOT, linked)),
      errorCode('PLAYWRIGHT_CALL_INPUT_NOT_REGULAR')
    );
    actualSymlinkCovered = true;
  } catch (error) {
    if (!error || !['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  if (!actualSymlinkCovered) {
    fs.writeFileSync(linked, fs.readFileSync(requestFile));
    const linkedResolved = path.resolve(linked);
    const fsApi = new Proxy(fs, {
      get(target, property) {
        if (property === 'lstatSync') {
          return candidate => {
            const entry = target.lstatSync(candidate);
            if (path.resolve(candidate) !== linkedResolved) return entry;
            return new Proxy(entry, {
              get(stats, key) {
                if (key === 'isSymbolicLink') return () => true;
                const value = Reflect.get(stats, key);
                return typeof value === 'function' ? value.bind(stats) : value;
              }
            });
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    assert.throws(
      () => readRequestFile(path.relative(ROOT, linked), { fsApi }),
      errorCode('PLAYWRIGHT_CALL_INPUT_NOT_REGULAR')
    );
  }

  const zeroIdentityPath = path.resolve(requestFile);
  let zeroIdentityOpens = 0;
  const zeroIdentityFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'lstatSync') {
        return (candidate, options) => {
          const entry = target.lstatSync(candidate, options);
          if (path.resolve(candidate) !== zeroIdentityPath || options?.bigint !== true) return entry;
          return new Proxy(entry, {
            get(stats, key) {
              if (key === 'dev' || key === 'ino') return 0n;
              const value = Reflect.get(stats, key);
              return typeof value === 'function' ? value.bind(stats) : value;
            }
          });
        };
      }
      if (property === 'openSync') {
        return (...args) => {
          zeroIdentityOpens += 1;
          return target.openSync(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => readRequestFile(relativeRequest, { fsApi: zeroIdentityFs }),
    errorCode('PLAYWRIGHT_CALL_INPUT_NOT_REGULAR')
  );
  assert.equal(zeroIdentityOpens, 0, 'an unreliable path identity must fail before open');

  const originalBytes = fs.readFileSync(requestFile);
  function createSameSizeReplacement(name) {
    const candidate = path.join(directory, name);
    const prefix = JSON.stringify({ tool: 'browser_tabs', arguments: { action: 'list' } });
    assert.ok(Buffer.byteLength(prefix) <= originalBytes.length);
    fs.writeFileSync(candidate, `${prefix}${' '.repeat(originalBytes.length - Buffer.byteLength(prefix))}`, 'utf8');
    assert.equal(fs.statSync(candidate).size, originalBytes.length);
    return candidate;
  }
  function restoreSwappedRequest(backup, replacement, swapped) {
    if (swapped) {
      if (fs.existsSync(requestFile)) fs.unlinkSync(requestFile);
      fs.renameSync(backup, requestFile);
    }
    if (fs.existsSync(replacement)) fs.unlinkSync(replacement);
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
  }

  const openSwapReplacement = createSameSizeReplacement('open-swap-replacement.json');
  const openSwapBackup = path.join(directory, 'open-swap-original.json');
  let openSwapped = false;
  const openSwapFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (candidate, ...args) => {
          if (!openSwapped && path.resolve(candidate) === path.resolve(requestFile)) {
            target.renameSync(requestFile, openSwapBackup);
            target.renameSync(openSwapReplacement, requestFile);
            openSwapped = true;
          }
          return target.openSync(candidate, ...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  try {
    assert.throws(
      () => readRequestFile(relativeRequest, { fsApi: openSwapFs }),
      errorCode('PLAYWRIGHT_CALL_INPUT_CHANGED'),
      'a same-size regular-file replacement during open must fail'
    );
  } finally {
    restoreSwappedRequest(openSwapBackup, openSwapReplacement, openSwapped);
  }

  const postOpenReplacement = createSameSizeReplacement('post-open-swap-replacement.json');
  const postOpenBackup = path.join(directory, 'post-open-swap-original.json');
  let postOpenSwapped = false;
  const postOpenSwapFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'fstatSync') {
        return (handle, options) => {
          const opened = target.fstatSync(handle, options);
          if (!postOpenSwapped) {
            target.renameSync(requestFile, postOpenBackup);
            target.renameSync(postOpenReplacement, requestFile);
            postOpenSwapped = true;
          }
          return opened;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  try {
    assert.throws(
      () => readRequestFile(relativeRequest, { fsApi: postOpenSwapFs }),
      errorCode('PLAYWRIGHT_CALL_INPUT_CHANGED'),
      'a path replacement after descriptor pinning must fail the post-open recheck'
    );
  } finally {
    restoreSwappedRequest(postOpenBackup, postOpenReplacement, postOpenSwapped);
  }

  const hardlink = path.join(directory, 'hardlinked-request.json');
  let hardlinkCreated = false;
  try {
    fs.linkSync(requestFile, hardlink);
    hardlinkCreated = true;
    assert.throws(
      () => readRequestFile(path.relative(ROOT, hardlink)),
      errorCode('PLAYWRIGHT_CALL_INPUT_NOT_REGULAR'),
      'multi-link files must not cross the containment boundary'
    );
  } catch (error) {
    if (!error || !['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    if (hardlinkCreated) fs.unlinkSync(hardlink);
  }

  let multiLinkOpens = 0;
  const multiLinkFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'lstatSync') {
        return (candidate, options) => {
          const entry = target.lstatSync(candidate, options);
          if (path.resolve(candidate) !== path.resolve(requestFile) || options?.bigint !== true) return entry;
          return new Proxy(entry, {
            get(stats, key) {
              if (key === 'nlink') return 2n;
              const value = Reflect.get(stats, key);
              return typeof value === 'function' ? value.bind(stats) : value;
            }
          });
        };
      }
      if (property === 'openSync') {
        return (...args) => {
          multiLinkOpens += 1;
          return target.openSync(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  assert.throws(
    () => readRequestFile(relativeRequest, { fsApi: multiLinkFs }),
    errorCode('PLAYWRIGHT_CALL_INPUT_NOT_REGULAR'),
    'multi-link identities must fail closed even when the host cannot create hard links'
  );
  assert.equal(multiLinkOpens, 0, 'a multi-link path identity must fail before open');

  fs.writeFileSync(requestFile, Buffer.alloc(MAX_REQUEST_BYTES + 1, 0x20));
  assert.throws(
    () => readRequestFile(relativeRequest),
    errorCode('PLAYWRIGHT_CALL_INPUT_SIZE_INVALID')
  );

  writeText('{{');
  assert.throws(
    () => readRequestFile(relativeRequest),
    errorCode('PLAYWRIGHT_CALL_INPUT_JSON_INVALID')
  );
  for (const invalid of [
    null,
    { tool: 'browser_snapshot' },
    { tool: 'browser_snapshot', arguments: {}, extra: true }
  ]) {
    writeRequest(invalid);
    assert.throws(
      () => readRequestFile(relativeRequest),
      errorCode('PLAYWRIGHT_CALL_INPUT_SHAPE_INVALID')
    );
  }
  writeRequest({ tool: 'browser_snapshot', arguments: [] });
  assert.throws(
    () => readRequestFile(relativeRequest),
    errorCode('PLAYWRIGHT_CALL_ARGUMENTS_INVALID')
  );
  writeRequest({ tool: 'not_browser', arguments: {} });
  assert.throws(
    () => readRequestFile(relativeRequest),
    errorCode('PLAYWRIGHT_CALL_TOOL_INVALID')
  );

  for (const [tool, args, code] of [
    ['browser_close', {}, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL'],
    ['browser_evaluate', { function: '() => document.body.innerText' }, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL'],
    ['browser_run_code', { code: 'async page => page.url()' }, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL'],
    ['browser_run_code_unsafe', { code: 'async page => page.url()' }, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL'],
    ['browser_tabs', { action: 'close' }, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL'],
    ['browser_future_unreviewed', {}, 'BROWSER_TOOL_NOT_ALLOWED'],
    ['browser_navigate', { url: 'file:///C:/Windows/win.ini' }, 'BROWSER_NAVIGATION_URL_FORBIDDEN']
  ]) {
    writeRequest({ tool, arguments: args });
    assert.throws(() => readRequestFile(relativeRequest), errorCode(code), `${tool} must fail closed`);
  }
  const blockedLaterLauncher = createFakeLauncher();
  await assert.rejects(
    invoke({
      steps: [
        { tool: 'browser_snapshot', arguments: {} },
        { tool: 'browser_evaluate', arguments: { function: '() => location.href' } }
      ]
    }, {
      timeoutMs: 2000,
      spawnImpl: blockedLaterLauncher.spawnImpl,
      terminateTreeFn: async () => {}
    }),
    errorCode('BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL')
  );
  assert.equal(
    blockedLaterLauncher.captures.length,
    0,
    'every later step must be reviewed before the launcher is spawned'
  );
  const blockedConsoleUrl = 'file:///C:/private/do-not-print.txt?token=do-not-print';
  writeRequest({ tool: 'browser_navigate', arguments: { url: blockedConsoleUrl } });
  const blockedCli = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'playwright-call.js'),
    '--input',
    relativeRequest
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  assert.equal(blockedCli.status, 1, blockedCli.stderr || blockedCli.stdout);
  assert.equal(
    blockedCli.stdout,
    '{"ok":false,"code":"BROWSER_NAVIGATION_URL_FORBIDDEN"}\n'
  );
  assert.equal(blockedCli.stderr, '');
  assert.doesNotMatch(`${blockedCli.stdout}${blockedCli.stderr}`, /private|do-not-print|token/i);

  assert.equal(validateOutputName('snapshot-1.json'), 'snapshot-1.json');
  assert.throws(
    () => validateOutputName('../snapshot.json'),
    errorCode('PLAYWRIGHT_CALL_OUTPUT_NAME_INVALID')
  );
  assert.throws(
    () => parseCli(['--input', 'one.json', '--input', 'two.json']),
    errorCode('PLAYWRIGHT_CALL_USAGE')
  );
  assert.throws(
    () => parseCli(['--input', 'one.json', '--model', 'anything']),
    errorCode('PLAYWRIGHT_CALL_USAGE')
  );

  const collisionName = `playwright-call-collision-${process.pid}-${Date.now()}.json`;
  outputNames.push(collisionName);
  const collisionPath = safeOutputFile(collisionName);
  assert.equal(path.dirname(collisionPath), fs.realpathSync(OUTPUT_DIRECTORY));
  fs.writeFileSync(collisionPath, 'sentinel', { encoding: 'utf8', flag: 'wx' });
  assert.throws(
    () => writeExclusiveOutput(collisionName, { result: { content: [] } }),
    errorCode('PLAYWRIGHT_CALL_OUTPUT_EXISTS')
  );
  assert.equal(fs.readFileSync(collisionPath, 'utf8'), 'sentinel');
  const collisionLauncher = createFakeLauncher();
  await assert.rejects(
    executeOneShot({ tool: 'browser_snapshot', arguments: {} }, {
      outputName: collisionName,
      timeoutMs: 2000,
      spawnImpl: collisionLauncher.spawnImpl,
      terminateTreeFn: async () => {}
    }),
    errorCode('PLAYWRIGHT_CALL_OUTPUT_EXISTS')
  );
  assert.equal(collisionLauncher.captures.length, 0, 'an output collision must fail before launcher spawn');

  const outputName = `playwright-call-result-${process.pid}-${Date.now()}.json`;
  outputNames.push(outputName);
  const written = writeExclusiveOutput(outputName, [
    {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'first constrained response' }] }
    },
    {
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: 'second constrained response' }] }
    }
  ]);
  assert.equal(path.dirname(written), fs.realpathSync(OUTPUT_DIRECTORY));
  const rawResponses = JSON.parse(fs.readFileSync(written, 'utf8'));
  assert.equal(rawResponses.length, 2);
  assert.match(rawResponses[1].result.content[0].text, /second constrained/);
  assert.throws(
    () => writeExclusiveOutput(`playwright-call-large-${process.pid}.json`, [
      { result: { content: [{ type: 'text', text: 'x'.repeat(Math.ceil(MAX_OUTPUT_BYTES / 2)) }] } },
      { result: { content: [{ type: 'text', text: 'y'.repeat(Math.ceil(MAX_OUTPUT_BYTES / 2)) }] } }
    ]),
    errorCode('PLAYWRIGHT_CALL_OUTPUT_TOO_LARGE')
  );

  const sensitiveUrl = 'https://example.com/private?token=do-not-print';
  const summaryRequest = {
    steps: [
      { tool: 'browser_snapshot', arguments: {} },
      { tool: 'browser_click', arguments: { target: 'do-not-print', element: sensitiveUrl } }
    ]
  };
  const summary = safeSummary(summaryRequest, [
    {
      result: {
        content: [{
          type: sensitiveUrl,
          text: `${sensitiveUrl} secret page content`
        }],
        structuredContent: { url: sensitiveUrl, arguments: { password: 'do-not-print' } }
      }
    },
    {
      result: {
        content: [{ type: 'text', text: 'second do-not-print result' }],
        structuredContent: { url: sensitiveUrl }
      }
    }
  ], true);
  assert.equal(summary.ok, true);
  assert.equal(summary.stepCount, 2);
  assert.equal(summary.completedSteps, 2);
  assert.deepEqual(summary.tools, ['browser_snapshot', 'browser_click']);
  assert.equal(summary.results[0].content[0].type, 'other');
  assert.equal(summary.results[0].content[0].bytes, 66);
  assert.equal(summary.results[1].content[0].type, 'text');
  assert.equal(summary.outputWritten, true);
  assert.doesNotMatch(JSON.stringify(summary), /example\.com|do-not-print|password|private/i);

  const unmeasuredSummary = safeSummary({
    tool: 'browser_snapshot',
    arguments: {}
  }, [{}]);
  assert.equal(unmeasuredSummary.ok, false);
  assert.equal(unmeasuredSummary.completedSteps, 1);
  assert.equal(unmeasuredSummary.results[0].ok, false);

  const happy = createFakeLauncher(frame => {
    if (frame.method === 'initialize') {
      happy.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'fake-playwright', version: '1.0' }
        }
      });
    } else if (frame.method === 'tools/call') {
      happy.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          content: [{ type: 'text', text: `${sensitiveUrl} sensitive result` }],
          structuredContent: { url: sensitiveUrl }
        }
      });
    }
  }, api => { happy.framesApi = api; });
  let happyTerminates = 0;
  const responses = await invoke({
    tool: 'browser_navigate',
    arguments: { url: sensitiveUrl }
  }, {
    timeoutMs: 2000,
    spawnImpl: happy.spawnImpl,
    terminateTreeFn: async () => { happyTerminates += 1; }
  });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.content.length, 1);
  assert.equal(happy.captures.length, 1);
  const expectedSpec = buildSpawnSpec();
  assert.equal(happy.captures[0].command, expectedSpec.command);
  assert.deepEqual(happy.captures[0].args, expectedSpec.args);
  assert.equal(expectedSpec.gateway, PLAYWRIGHT_GATEWAY);
  // The spec names the gateway and nothing else: the one-shot client spawns the
  // gateway directly, so a second launcher path in the spec would be a value
  // nobody executes and a refusal nobody needs.
  assert.equal(Object.hasOwn(expectedSpec, 'launcher'), false);
  assert.equal(happy.captures[0].command, process.execPath);
  assert.deepEqual(happy.captures[0].args, [PLAYWRIGHT_GATEWAY, '@playwright/mcp@0.0.82']);
  assert.equal(happy.captures[0].options.cwd, ROOT);
  assert.equal(happy.captures[0].options.shell, false);
  /* THE SPAWN CARRIES A SCRUBBED ENVIRONMENT, AND THAT IS THE POINT.
     This assertion previously required `env` to be ABSENT, which pinned the
     behaviour from before the gateway spawn was given a scrubbed environment
     to stop an ambient ANTHROPIC_API_KEY (or any provider key persisted on the
     machine) reaching a child that can spawn a billing CLI. Absent `env` means
     the child INHERITS the whole ambient environment, so the old assertion was
     green in exactly the unsafe state.

     Asserting the SHAPE rather than a key list is deliberate: a fixed list of
     forbidden names goes stale the day a provider adds a variable, and a test
     that pins a spelling instead of a property is a defect this repository has
     already paid for more than once. */
  const spawnEnv = happy.captures[0].options.env;
  assert.equal(spawnEnv && typeof spawnEnv === 'object', true,
    'the gateway spawn must carry an explicit environment; an absent one inherits the ambient environment wholesale');
  /* The product owns the definition of what must not travel. Asserting it with
     the scrubber's OWN exported check rather than a regex written here keeps one
     definition in one place — a second, hand-written list would drift from the
     real one and would also fire on variables the HARNESS sets rather than the
     product (a first draft of this assertion tripped on the agent runner's own
     session token, which no customer machine carries). */
  const { assertNoBillingCredentials } = require('../../src/lib/providers/subscription-launch-env');
  assertNoBillingCredentials(spawnEnv, { context: 'playwright gateway spawn' });
  assert.equal(JSON.stringify(happy.captures[0]).includes('--model'), false);
  assert.deepEqual(happy.frames.map(frame => frame.method), [
    'initialize',
    'notifications/initialized',
    'tools/call'
  ]);
  assert.equal(happy.frames.filter(frame => frame.method === 'tools/call').length, 1);
  assert.equal(happy.frames[2].params.name, 'browser_navigate');
  assert.deepEqual(happy.frames[2].params.arguments, { url: sensitiveUrl });
  assert.equal(happy.frames.some(frame => frame.params?.name === 'browser_close'), false);
  assert.equal(happyTerminates, 0, 'a cooperative fake launcher close should not need forced cleanup');
  assert.doesNotMatch(JSON.stringify(safeSummary({
    tool: 'browser_navigate',
    arguments: { url: sensitiveUrl }
  }, responses)), /example\.com|do-not-print/i);

  const selectLauncher = createFakeLauncher(frame => {
    if (frame.method === 'initialize') {
      selectLauncher.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'fake-playwright', version: '1.0' }
        }
      });
    } else if (frame.method === 'tools/call') {
      selectLauncher.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          content: [{
            type: 'text',
            text: frame.params.name === 'browser_tabs' && frame.params.arguments.action === 'list'
              ? 'unrelated-secret-tab https://example.com/?token=private-tab-token'
              : 'selected tab'
          }]
        }
      });
    }
  }, api => { selectLauncher.framesApi = api; });
  const selectOutputName = `playwright-call-select-${process.pid}-${Date.now()}.json`;
  outputNames.push(selectOutputName);
  const selectExecution = await executeOneShot({
    tool: 'browser_tabs',
    arguments: { action: 'select', index: 1 }
  }, {
    timeoutMs: 2000,
    outputName: selectOutputName,
    spawnImpl: selectLauncher.spawnImpl,
    terminateTreeFn: async () => {}
  });
  const selectCalls = selectLauncher.frames.filter(frame => frame.method === 'tools/call');
  assert.deepEqual(
    selectCalls.map(frame => [frame.params.name, frame.params.arguments.action]),
    [['browser_tabs', 'list'], ['browser_tabs', 'select']],
    'tab selection must retain its audited lazy-index preflight'
  );
  assert.equal(selectExecution.responses.length, 1,
    'the internal tab inventory must not appear as a user response');
  const selectRaw = fs.readFileSync(path.join(OUTPUT_DIRECTORY, selectOutputName), 'utf8');
  assert.match(selectRaw, /Tab selected\./);
  assert.doesNotMatch(selectRaw, /selected tab/,
    'the upstream select response may repeat the full tab inventory and must be replaced');
  assert.doesNotMatch(selectRaw, /unrelated-secret-tab|private-tab-token|example\.com/,
    'the internal tab inventory must never be persisted');
  const selectSummary = safeSummary({
    tool: 'browser_tabs',
    arguments: { action: 'select', index: 1 }
  }, selectExecution.responses, true);
  assert.equal(selectSummary.stepCount, 1);
  assert.deepEqual(selectSummary.tools, ['browser_tabs']);

  const maximumSequentialRequest = {
    steps: [
      { tool: 'browser_tabs', arguments: { action: 'list' } },
      { tool: 'browser_tabs', arguments: { action: 'select', index: 1 } },
      ...Array.from({ length: MAX_STEPS - 2 }, () => ({
        tool: 'browser_snapshot',
        arguments: {}
      }))
    ]
  };
  let maximumCallCount = 0;
  let maximumCallOutstanding = false;
  let parallelCallObserved = false;
  const maximumLauncher = createFakeLauncher(frame => {
    if (frame.method === 'initialize') {
      maximumLauncher.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'fake-playwright', version: '1.0' }
        }
      });
    } else if (frame.method === 'tools/call') {
      if (maximumCallOutstanding) parallelCallObserved = true;
      maximumCallOutstanding = true;
      maximumCallCount += 1;
      const responseNumber = maximumCallCount;
      setImmediate(() => {
        maximumCallOutstanding = false;
        maximumLauncher.framesApi.respond({
          jsonrpc: '2.0',
          id: frame.id,
          result: { content: [{ type: 'text', text: `step-${responseNumber}` }] }
        });
      });
    }
  }, api => { maximumLauncher.framesApi = api; });
  const maximumOutputName = `playwright-call-maximum-${process.pid}-${Date.now()}.json`;
  outputNames.push(maximumOutputName);
  const maximumExecution = await executeOneShot(maximumSequentialRequest, {
    timeoutMs: 3000,
    outputName: maximumOutputName,
    spawnImpl: maximumLauncher.spawnImpl,
    terminateTreeFn: async () => {}
  });
  const maximumResponses = maximumExecution.responses;
  assert.equal(maximumResponses.length, MAX_STEPS);
  assert.equal(parallelCallObserved, false, 'only one tools/call may be in flight');
  assert.equal(maximumExecution.outputWritten, true);
  const maximumRaw = JSON.parse(fs.readFileSync(
    path.join(OUTPUT_DIRECTORY, maximumOutputName),
    'utf8'
  ));
  assert.equal(maximumRaw.length, MAX_STEPS);
  assert.equal(maximumLauncher.captures.length, 1);
  assert.deepEqual(maximumLauncher.frames.slice(0, 2).map(frame => frame.method), [
    'initialize',
    'notifications/initialized'
  ]);
  const maximumCalls = maximumLauncher.frames.slice(2);
  assert.equal(maximumCalls.length, MAX_STEPS);
  assert.equal(maximumCalls.every(frame => frame.method === 'tools/call'), true);
  assert.deepEqual(
    maximumCalls.map(frame => frame.id),
    Array.from({ length: MAX_STEPS }, (_, index) => index + 2)
  );
  assert.deepEqual(maximumCalls[0].params, {
    name: 'browser_tabs',
    arguments: { action: 'list' }
  });
  assert.deepEqual(maximumCalls[1].params, {
    name: 'browser_tabs',
    arguments: { action: 'select', index: 1 }
  });
  assert.equal(maximumLauncher.frames.some(frame => frame.params?.name === 'browser_close'), false);

  const midBatchRequest = {
    steps: [
      { tool: 'browser_snapshot', arguments: {} },
      { tool: 'browser_click', arguments: { target: 'button-1', element: 'Continue' } },
      { tool: 'browser_snapshot', arguments: {} }
    ]
  };
  let midBatchCalls = 0;
  const midBatchLauncher = createFakeLauncher(frame => {
    if (frame.method === 'initialize') {
      midBatchLauncher.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'fake-playwright', version: '1.0' }
        }
      });
    } else if (frame.method === 'tools/call') {
      midBatchCalls += 1;
      midBatchLauncher.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: midBatchCalls === 2
          ? {
              isError: true,
              content: [{ type: 'text', text: `${sensitiveUrl} must not reach stdout` }]
            }
          : { content: [{ type: 'text', text: 'first succeeded' }] }
      });
    }
  }, api => { midBatchLauncher.framesApi = api; });
  const midBatchResponses = await invoke(midBatchRequest, {
    timeoutMs: 2000,
    spawnImpl: midBatchLauncher.spawnImpl,
    terminateTreeFn: async () => {}
  });
  assert.equal(midBatchResponses.length, 2);
  assert.equal(midBatchCalls, 2, 'the third step must not be sent after a tool error');
  assert.deepEqual(
    midBatchLauncher.frames.filter(frame => frame.method === 'tools/call').map(frame => frame.params.name),
    ['browser_snapshot', 'browser_click']
  );
  const midBatchSummary = safeSummary(midBatchRequest, midBatchResponses);
  assert.equal(midBatchSummary.ok, false);
  assert.equal(midBatchSummary.stepCount, 3);
  assert.equal(midBatchSummary.completedSteps, 2);
  assert.equal(midBatchSummary.results[1].isError, true);
  assert.doesNotMatch(JSON.stringify(midBatchSummary), /example\.com|must not reach/i);

  let rpcErrorCalls = 0;
  const rpcErrorLauncher = createFakeLauncher(frame => {
    if (frame.method === 'initialize') {
      rpcErrorLauncher.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'fake-playwright', version: '1.0' }
        }
      });
    } else if (frame.method === 'tools/call') {
      rpcErrorCalls += 1;
      rpcErrorLauncher.framesApi.respond(rpcErrorCalls === 2
        ? {
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32000, message: `${sensitiveUrl} rpc detail` }
          }
        : {
            jsonrpc: '2.0',
            id: frame.id,
            result: { content: [{ type: 'text', text: 'first succeeded' }] }
          });
    }
  }, api => { rpcErrorLauncher.framesApi = api; });
  const rpcErrorResponses = await invoke(midBatchRequest, {
    timeoutMs: 2000,
    spawnImpl: rpcErrorLauncher.spawnImpl,
    terminateTreeFn: async () => {}
  });
  assert.equal(rpcErrorResponses.length, 2);
  assert.equal(rpcErrorCalls, 2, 'the third step must not be sent after a JSON-RPC error');
  const rpcErrorSummary = safeSummary(midBatchRequest, rpcErrorResponses);
  assert.equal(rpcErrorSummary.ok, false);
  assert.equal(rpcErrorSummary.results[1].rpcErrorCode, -32000);
  assert.doesNotMatch(JSON.stringify(rpcErrorSummary), /example\.com|rpc detail/i);

  let orderedCallCount = 0;
  const orderingRequest = {
    steps: [
      { tool: 'browser_snapshot', arguments: {} },
      { tool: 'browser_snapshot', arguments: {} }
    ]
  };
  const orderingLauncher = createFakeLauncher(frame => {
    if (frame.method === 'initialize') {
      orderingLauncher.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'fake-playwright', version: '1.0' }
        }
      });
    } else if (frame.method === 'tools/call') {
      orderedCallCount += 1;
      if (orderedCallCount === 1) {
        orderingLauncher.framesApi.respond({
          jsonrpc: '2.0',
          id: frame.id + 1,
          result: { content: [{ type: 'text', text: 'future response must be ignored' }] }
        });
        orderingLauncher.framesApi.respond({
          jsonrpc: '2.0',
          id: frame.id,
          result: { content: [{ type: 'text', text: 'first ordered response' }] }
        });
        orderingLauncher.framesApi.respond({
          jsonrpc: '2.0',
          id: frame.id,
          result: { content: [{ type: 'text', text: 'duplicate response must be ignored' }] }
        });
      } else {
        orderingLauncher.framesApi.respond({
          jsonrpc: '2.0',
          id: frame.id,
          result: { content: [{ type: 'text', text: 'second ordered response' }] }
        });
      }
    }
  }, api => { orderingLauncher.framesApi = api; });
  const orderedResponses = await invoke(orderingRequest, {
    timeoutMs: 2000,
    spawnImpl: orderingLauncher.spawnImpl,
    terminateTreeFn: async () => {}
  });
  assert.equal(orderedResponses.length, 2);
  assert.equal(orderedResponses[0].result.content[0].text, 'first ordered response');
  assert.equal(orderedResponses[1].result.content[0].text, 'second ordered response');
  assert.deepEqual(
    orderingLauncher.frames.filter(frame => frame.method === 'tools/call').map(frame => frame.id),
    [2, 3]
  );

  const cumulativeTimeoutLauncher = createFakeLauncher(frame => {
    if (frame.method === 'initialize') {
      cumulativeTimeoutLauncher.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'fake-playwright', version: '1.0' }
        }
      });
    } else if (frame.method === 'tools/call'
        && cumulativeTimeoutLauncher.frames.filter(item => item.method === 'tools/call').length === 1) {
      setTimeout(() => cumulativeTimeoutLauncher.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: { content: [{ type: 'text', text: 'delayed first response' }] }
      }), 700);
    }
  }, api => { cumulativeTimeoutLauncher.framesApi = api; });
  let cumulativeTimeoutTerminates = 0;
  const cumulativeStarted = Date.now();
  await assert.rejects(
    invoke(orderingRequest, {
      timeoutMs: 1000,
      spawnImpl: cumulativeTimeoutLauncher.spawnImpl,
      terminateTreeFn: async () => {
        cumulativeTimeoutTerminates += 1;
        cumulativeTimeoutLauncher.close(127);
      }
    }),
    errorCode('PLAYWRIGHT_CALL_TIMEOUT')
  );
  const cumulativeElapsed = Date.now() - cumulativeStarted;
  assert.equal(cumulativeTimeoutTerminates, 1);
  assert.ok(cumulativeElapsed >= 650 && cumulativeElapsed < 1500, `cumulative timeout was ${cumulativeElapsed}ms`);
  assert.equal(
    cumulativeTimeoutLauncher.frames.filter(frame => frame.method === 'tools/call').length,
    2
  );

  const stalled = createFakeLauncher();
  let stalledTerminates = 0;
  await assert.rejects(
    invoke({ tool: 'browser_snapshot', arguments: {} }, {
      timeoutMs: 1000,
      spawnImpl: stalled.spawnImpl,
      terminateTreeFn: async child => {
        stalledTerminates += 1;
        stalled.close(124);
        assert.equal(child, stalled.child);
      }
    }),
    errorCode('PLAYWRIGHT_CALL_TIMEOUT')
  );
  assert.equal(stalledTerminates, 1);
  assert.deepEqual(stalled.frames.map(frame => frame.method), ['initialize']);

  const oversizedResponse = createFakeLauncher(frame => {
    if (frame.method === 'initialize') {
      oversizedResponse.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          serverInfo: { name: 'fake-playwright', version: '1.0' }
        }
      });
    } else if (frame.method === 'tools/call') {
      oversizedResponse.framesApi.respond({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          content: [{
            type: 'text',
            text: 'x'.repeat(Math.ceil(MAX_RESPONSE_BYTES / 2))
          }]
        }
      });
    }
  }, api => { oversizedResponse.framesApi = api; });
  let responseTerminates = 0;
  await assert.rejects(
    invoke(orderingRequest, {
      timeoutMs: 5000,
      spawnImpl: oversizedResponse.spawnImpl,
      terminateTreeFn: async () => {
        responseTerminates += 1;
        oversizedResponse.close(125);
      }
    }),
    errorCode('PLAYWRIGHT_CALL_RESPONSE_TOO_LARGE')
  );
  assert.equal(responseTerminates, 1);
  assert.equal(
    oversizedResponse.frames.filter(frame => frame.method === 'tools/call').length,
    2,
    'stdout response bytes must be capped cumulatively across the batch'
  );

  const noisy = createFakeLauncher(null, api => {
    noisy.framesApi = api;
    api.writeRawStderr('e'.repeat(MAX_STDERR_BYTES + 1));
  });
  let stderrTerminates = 0;
  await assert.rejects(
    invoke({ tool: 'browser_snapshot', arguments: {} }, {
      timeoutMs: 2000,
      spawnImpl: noisy.spawnImpl,
      terminateTreeFn: async () => {
        stderrTerminates += 1;
        noisy.close(126);
      }
    }),
    errorCode('PLAYWRIGHT_CALL_STDERR_TOO_LARGE')
  );
  assert.equal(stderrTerminates, 1);
}

run().then(() => {
  console.log('Playwright one-shot fallback client tests passed.');
}).catch(error => {
  process.exitCode = 1;
  console.error(error && error.stack || error);
}).finally(() => {
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(path.join(ROOT, 'scratch'), resolvedDirectory);
  if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
      && path.basename(resolvedDirectory).startsWith('playwright-call-test-')) {
    fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  }
  for (const name of outputNames) {
    const candidate = path.resolve(OUTPUT_DIRECTORY, name);
    if (path.dirname(candidate) === path.resolve(OUTPUT_DIRECTORY)) fs.rmSync(candidate, { force: true });
  }
});
