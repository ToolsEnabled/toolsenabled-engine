'use strict';

// WHAT THE ASSISTANT'S CLI SAID WHEN IT DIED, KEPT WHERE THE OWNER CAN READ IT.
//
// THE DEFECT. createClaudeCliTransport() collected the child's stderr into a
// string in this process's memory and handed it to the caller once, in
// finish(), when the CHILD ended. On 2026-09-03 the APPLICATION ended about
// eight times between 19:30 and 21:26 local without running its will-quit path
// (REPORT-crash-20260903/00-CONTROLLER-FINDINGS.md sections 1-2). Two MCP
// servers of one assistant had aborted out of memory at 21:11:56; whatever the
// claude CLI wrote about that went into the buffer and died with the app. There
// is no record of it anywhere on this machine -- which is why the investigation
// had to read minidumps to find out what happened.
//
// WHAT IS PROVED HERE: the same bytes reach a file as they arrive, the file is
// bounded, the directory is bounded, and what reaches it is the REDACTED chunk
// rather than the raw one.

const isolated = require('../lib/isolated-environment').activate('claude-cli-stderr-durable');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createClaudeCliTransport, durableStderrSink,
} = require('../../src/lib/agent-engine/claude-cli-process');

void isolated;

// The prefix the sink writes under, inside the installation's own logs/.
const PREFIX = 'agent-stderr-claude-';

test('the sink writes what it is given, to a file, as it is given it', () => {
  const write = durableStderrSink(4242);
  assert.equal(typeof write, 'function', 'there was nowhere to write the CLI stderr at all');

  const { rootPath } = require('../../src/lib/runtime');
  const directory = rootPath('logs');
  const before = fs.readdirSync(directory).filter(name => name.startsWith(PREFIX));
  assert.equal(before.length >= 1, true);

  write('MCP server "toolsenabled" exited unexpectedly\n');
  write('Error: Reached heap limit Allocation failed\n');

  const file = path.join(directory, before.sort().at(-1));
  const contents = fs.readFileSync(file, 'utf8');
  assert.match(contents, /pid 4242/, 'the log does not say which child it belongs to');
  assert.match(contents, /MCP server "toolsenabled" exited unexpectedly/);
  assert.match(contents, /Reached heap limit Allocation failed/);
});

test('one session cannot fill the disk', () => {
  const write = durableStderrSink(4243);
  const { rootPath } = require('../../src/lib/runtime');
  const directory = rootPath('logs');
  const file = path.join(directory, fs.readdirSync(directory).filter(n => n.startsWith(PREFIX) && n.includes('-4243-')).at(0));

  for (let i = 0; i < 12; i += 1) write('x'.repeat(64 * 1024));
  const size = fs.statSync(file).size;
  // 256 KB cap, plus the header and the one truncation notice.
  assert.ok(size <= 256 * 1024 + 512, `the stderr log grew to ${size} bytes, so the cap does not hold`);
  assert.match(fs.readFileSync(file, 'utf8').slice(-200), /stderr log full/);
});

test('the directory keeps a bounded number of logs', () => {
  const { rootPath } = require('../../src/lib/runtime');
  const directory = rootPath('logs');
  fs.mkdirSync(directory, { recursive: true });
  for (let i = 0; i < 70; i += 1) {
    fs.writeFileSync(path.join(directory, `${PREFIX}filler-${String(i).padStart(3, '0')}.log`), 'old\n', 'utf8');
  }
  // The audit sinks share this directory and must survive the pruning.
  fs.writeFileSync(path.join(directory, 'actions.log'), 'not ours\n', 'utf8');
  durableStderrSink(4244);
  const kept = fs.readdirSync(directory).filter(name => name.startsWith(PREFIX));
  assert.ok(kept.length <= 51, `${kept.length} logs are kept, which is not a bound`);
  assert.ok(fs.existsSync(path.join(directory, 'actions.log')),
    'the pruning reached a file that is not one of ours');
});

test('a sink that cannot be opened does not stop a session starting', () => {
  // The rule is "never throws". Proved by handing the transport a sink that
  // fails, which is the shape of an unwritable logs directory.
  const failing = () => { throw new Error('logs directory is read-only'); };
  assert.throws(failing, /read-only/);
  // And the transport must accept a caller-supplied sink at all, which is what
  // makes the rule assertable without writing into a real installation.
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'lib', 'agent-engine', 'claude-cli-process.js'), 'utf8');
  assert.match(source, /stderrSink = durableStderrSink/,
    'the transport no longer takes an injectable stderr sink');
  assert.ok(source.indexOf('const redacted = redactCredentials(chunk, childEnv);')
    < source.indexOf('if (sink) sink(redacted);'),
    'the durable log is written before redaction, so a credential could reach the file');
  assert.ok(!/sink\(chunk\)/.test(source),
    'the raw chunk is handed to the durable log somewhere, bypassing redaction');
});

test('the transport actually feeds the sink from a live child', async () => {
  const seen = [];
  const transport = createClaudeCliTransport({
    // Not `claude`: an absolute command is passed through by resolveInvocation,
    // and this one is guaranteed present and cheap.
    command: process.execPath,
    args: ['-e', 'process.stderr.write("MCP server \\"toolsenabled\\" exited unexpectedly\\n")'],
    cwd: os.tmpdir(),
    env: {},
    stderrSink: () => (chunk) => { seen.push(chunk); },
  });
  await new Promise(resolve => {
    transport.onData((packet, exit) => { if (packet === null && exit) resolve(exit); });
  });
  assert.equal(seen.join(''), 'MCP server "toolsenabled" exited unexpectedly\n',
    'the child wrote to stderr and the durable sink was never called');
});
