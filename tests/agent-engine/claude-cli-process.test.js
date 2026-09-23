// EXECUTABLE CHANGE — the non-JSON child test now proves its fixture loaded.
'use strict';

/* TEST-CAN-FAIL AUDIT (2026-08-26)
 *
 * Strengthened assertion: `non-JSON protocol output fails an active turn
 * immediately`. Mutation: createClaudeCliTransport was temporarily changed to
 * launch `/definitely-not-a-real-claude-test-command` instead of the requested
 * process.execPath. Before this change the test stayed green, proving that its
 * CLAUDE_CLI_EXITED rejection plus empty stderr could not distinguish malformed
 * protocol output from a child that never loaded. With the fixture-ready
 * sentinel assertion below, the mutation went red:
 *
 *   not ok - non-JSON protocol output fails an active turn immediately
 *     Expected values to be strictly equal:
 *     + actual - expected
 *
 *     + ''
 *     - 'NON_JSON_FIXTURE_READY\n'
 *   FAIL - claude-cli-process (1 failing)
 *
 * The production file was then restored byte-for-byte and the isolated test
 * returned:
 *
 *   PASS - claude-cli-process (0 failing)
 *
 * Shape census:
 *   (1) NOT-FOUND — loops use fixed non-empty fixtures, or the event loop is
 *       followed by required usage and completion witnesses.
 *   (2) FOUND AND FIXED — the non-JSON child rejection described above.
 *   (3) NOT-FOUND — catches/finally blocks either expose and assert the caught
 *       failure or perform cleanup without swallowing the tested outcome.
 *   (4) NOT-FOUND — the fake transport supplies protocol input; assertions
 *       measure adapter behavior, not a mocked adapter implementation.
 *   (5) NOT-FOUND — the Windows branch skips only a platform-specific invariant,
 *       not the file or test suite; all checks execute on this platform.
 *   (6) NOT-FOUND — expected values are independent literals/fixtures rather
 *       than values computed by the implementation under test.
 * Preconditions: all met. Node and the isolated runner were available; the
 * mutated source was restored exactly (verified with cmp).
 */

/* THE FIRST-PARTY CLAUDE ENGINE, AND THE FOUR WAYS IT COULD QUIETLY BECOME
 * SOMETHING ELSE.
 *
 * WHAT IS BEING GUARDED. src/lib/agent-engine/claude-cli-process.js exists
 * because the OTHER Claude module cannot authenticate by design: claude-process.js
 * drives a third-party wrapper on a throwaway config directory, which is a
 * licence fence (TE-L-0006). This engine is allowed to exist only because it
 * launches the OFFICIAL binary and touches no configuration at all, so the child
 * signs itself in on the person's own account. Four properties keep that true,
 * and every one of them is invisible in ordinary use:
 *
 *   1. IT NEVER INVENTS A CONFIG DIRECTORY. Rewritten 2026-08-18; the wording it
 *      replaces was "IT NEVER OVERRIDES THE CONFIG DIRECTORY. Setting
 *      CLAUDE_CONFIG_DIR is the fence; not setting it is the feature. An edit
 *      that adds one would look exactly like a bugfix and would break
 *      authentication for every customer." The owner ruled on 2026-08-16 and the
 *      legal position of 2026-08-18 records it as binding, so the engine may now
 *      be POINTED at one of the person's own signed-in directories. What did not
 *      change is why the old rule existed: a directory nobody signed into cannot
 *      authenticate. So the property is now narrower rather than gone -- the
 *      directory comes from a caller or there is none, the file never derives
 *      one, and no directory means the untouched path that has always worked.
 *      Asserted in BOTH directions below, because half of it is still an absence.
 *   2. IT NEVER READS A CREDENTIAL. Not from a file, not from a keychain, not
 *      from the environment on its way past. The child gets its own.
 *   3. IT STRIPS THE API KEY RATHER THAN FORWARDING IT. This is the mechanism,
 *      not hygiene: Claude Code gives ANTHROPIC_API_KEY precedence over the
 *      subscription login, so a key that reaches the child silently bills a
 *      metered account (R1186: hours of it, under a green `claude auth status`).
 *   4. IT FAILS CLOSED. An unrecognised permission level must narrow, never
 *      widen; an unwired approval path must deny, never permit.
 *
 * Properties 1 and 2 are the ABSENCE of code, which no behavioural test can
 * observe, so those two are asserted against the source text. That is the same
 * device tools/test/provider-cli-presence.test.mjs uses in the app repo and for
 * the same reason: a rule that lives only in a comment is not a rule.
 *
 * WHY THE TRANSPORT HERE IS FAKE AND WHY THAT IS NOT A SHORTCUT. The fake is in
 * the TEST. The shipped path spawns the real binary and there is no mock, stub
 * or simulated stream anywhere in it -- assertions below read the real source to
 * prove that. What the fake buys is a suite that costs no money, needs no
 * sign-in, and is deterministic: it feeds the adapter the EXACT packet shapes
 * measured off claude 2.1.186 and checks the mapping. The proof that the whole
 * thing runs is a separate, live, non-default measurement -- a real agent
 * answering a real question -- and is not what this file is for.
 *
 *   node tests/run-isolated.js tests/agent-engine/claude-cli-process.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ClaudeCliAdapter,
  ClaudeCliError,
  claudeArgs,
  claudeResumeArgs,
  cliModelFor,
  permissionModeFor
} = require('../../src/lib/agent-engine/claude-cli-adapter');
const {
  CREDENTIAL_ENV_NAMES,
  configDirEnvironment,
  createClaudeCliTransport,
  launchEnvironment,
  resumeClaudeSession,
  resolveInvocation
} = require('../../src/lib/agent-engine/claude-cli-process');
// Its own throwaway TOOLSENABLED_STATE_ROOT: two checks below reach the session
// spool, and the services-root resolver refuses without one rather than falling
// back to a literal that would be the REAL product's state. See the helper.
require('../helpers/scratch-state-root');

const { assertEngineAdapter, EVENT_TYPES } = require('../../src/lib/agent-engine/engine-contract');

const ADAPTER_SOURCE_FILE = path.join(__dirname, '..', '..', 'src', 'lib', 'agent-engine', 'claude-cli-adapter.js');
const PROCESS_SOURCE_FILE = path.join(__dirname, '..', '..', 'src', 'lib', 'agent-engine', 'claude-cli-process.js');
const THREAD_ID = '4fcaeb8b-93ec-4a5b-97c7-4cac9e59f2d1';

let failures = 0;
function check(name, run) {
  try {
    run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`not ok - ${name}\n  ${error && error.message}\n`);
  }
}
async function checkAsync(name, run) {
  try {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`not ok - ${name}\n  ${error && error.message}\n`);
  }
}

/* Strip comments before scanning source for a forbidden call. This file's own
   subject matter is credentials and config directories, and so is the source it
   reads -- both explain at length why they do NOT do these things. A raw scan
   would read the explanation as the violation. */
function codeOf(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* A transport that records what was sent and lets the test feed packets back.
   Same two-shape callback the real one uses: (packet) per line, (null, exit)
   once at the end. */
function fakeTransport() {
  const sent = [];
  let handler = null;
  return {
    sent,
    send(message) { sent.push(message); },
    onData(next) { handler = next; },
    close() {},
    emit(packet) { if (handler) handler(packet); },
    exit(info) { if (handler) handler(null, info || { code: 0, signal: null }); }
  };
}

function adapterWithTransport() {
  const transport = fakeTransport();
  const adapter = new ClaudeCliAdapter({ transport });
  adapter.threadId = THREAD_ID;
  const events = [];
  adapter.onEvent(event => events.push(event));
  return { transport, adapter, events };
}

/* ------------------------------------------------------------------
   1. THE LICENCE FENCE, ASSERTED AGAINST THE SOURCE.
   ------------------------------------------------------------------ */

check('the protocol half never touches the configuration directory at all', () => {
  /* The adapter maps packets. It has no business naming a sign-in, and keeping
     the whole mechanism in ONE file is what makes the assertions below able to
     be exhaustive about it. */
  assert.ok(
    !codeOf(ADAPTER_SOURCE_FILE).includes('CLAUDE_CONFIG_DIR'),
    'the protocol half names the configuration directory; the transport is the only place that may'
  );
});

check('no configuration directory is set unless a caller names one, and then it is the only change', () => {
  /* THE FIRST DIRECTION, and the one a customer feels. An omitted directory must
     produce the environment this engine produced before the rule changed -- not
     "equivalent", the same contents -- because that is the path that is proven to
     authenticate on the person's own account. */
  const ambient = { PATH: 'C:\\bin', APPDATA: 'C:\\app', ANTHROPIC_API_KEY: 'sk-should-not-survive' };
  const scrubbed = launchEnvironment(ambient);

  for (const nothing of [null, undefined, '', '   ']) {
    const untouched = configDirEnvironment({ ...scrubbed }, nothing);
    assert.deepEqual(untouched, scrubbed,
      'an omitted sign-in folder changed the environment; the default path must be the untouched one');
    assert.ok(!Object.hasOwn(untouched, 'CLAUDE_CONFIG_DIR'),
      'a configuration directory was set that no caller asked for');
  }

  /* THE SECOND DIRECTION, which is the whole feature. A named directory sets ONE
     variable, to exactly that directory, and touches nothing else -- so a switch
     between the accounts a person owns cannot quietly carry anything with it. */
  const secondAccountHome = path.join(os.tmpdir(), 'fixture-claude-home', 'second-account');
  const pinned = configDirEnvironment({ ...scrubbed }, secondAccountHome);
  assert.equal(pinned.CLAUDE_CONFIG_DIR, path.resolve(secondAccountHome));
  const withoutPin = { ...pinned };
  delete withoutPin.CLAUDE_CONFIG_DIR;
  assert.deepEqual(withoutPin, scrubbed,
    'naming a sign-in folder changed something other than the sign-in folder');

  /* AND THE SCRUB IS NOT UNDONE BY IT. The key that would silently bill a metered
     account is gone in both directions; this is the mechanism the engine rests
     on, so it is asserted at the same moment the new behaviour is. */
  assert.ok(!Object.hasOwn(pinned, 'ANTHROPIC_API_KEY'),
    'the metered key survived alongside a pinned sign-in folder');
});

check('the engine never derives a configuration directory of its own', () => {
  /* THE HALF THAT IS STILL AN ABSENCE OF CODE, and therefore still asserted
     against the source. The old rule banned the NAME; that would now ban the
     feature. What must stay banned is this file MAKING one up: joining a home
     directory, defaulting to `.claude`, reading a config file to find a path, or
     creating the directory so an unsigned home looks provisioned. Every one of
     those would look like a bugfix and would point a customer at a sign-in they
     never made -- which is exactly what the original fence was protecting. */
  /* `claudePermissionMode` is the confinement plan's own field name -- the
     recorded level's CLI mode, read off the plan object -- and reading it spells
     `plan.claudePermissionMode`, which contains the token `.claude`. That is an
     identifier, not a path fragment: the invention this scan exists to catch is
     joining a home directory to the literal `.claude` FOLDER. Stripping the one
     identifier keeps the scan exhaustive about the folder without banning the
     field's proper name. */
  const code = codeOf(PROCESS_SOURCE_FILE).replace(/claudePermissionMode/g, ' ');
  const INVENTIONS = [
    'homedir', 'os.homedir', 'USERPROFILE',
    '.claude', 'mkdirSync', 'mkdtempSync'
  ];
  for (const invention of INVENTIONS) {
    assert.ok(
      !code.includes(invention),
      `${path.basename(PROCESS_SOURCE_FILE)} contains ${invention}, which is how it would start deriving a sign-in folder instead of being handed one.`
    );
  }
  /* And there is exactly ONE assignment of the variable in the whole file, so the
     assertions above cannot be true of one path and false of another. */
  const assignments = code.split(/CLAUDE_CONFIG_DIR\s*=/).length - 1;
  assert.equal(assignments, 1,
    'the sign-in folder is set in more than one place; there must be exactly one');
});

check('a relative sign-in folder is refused rather than resolved', () => {
  /* It would resolve against the child's working directory -- the person's own
     project folder -- and quietly make a per-project sign-in nobody asked for. */
  let thrown = null;
  try { configDirEnvironment({ PATH: 'x' }, 'somewhere/relative'); } catch (error) { thrown = error; }
  assert.ok(thrown, 'a relative sign-in folder was accepted');
  assert.equal(thrown.code, 'CLAUDE_CLI_CONFIG_DIR_RELATIVE');
});

check('neither module reads a credential from anywhere', () => {
  /* The child authenticates itself. Nothing here may open, read, copy or
     forward a sign-in -- not from ~/.claude, not from a keychain, not from the
     environment on its way past. */
  const READERS = [
    'readFileSync', 'readFile', 'createReadStream', 'openSync', 'readSync',
    '.credentials', 'credentials.json', 'keychain', 'keytar', 'auth.json'
  ];
  for (const file of [ADAPTER_SOURCE_FILE, PROCESS_SOURCE_FILE]) {
    const code = codeOf(file);
    for (const reader of READERS) {
      assert.ok(
        !code.includes(reader),
        `${path.basename(file)} contains "${reader}": this engine must never read a credential.`
      );
    }
  }
});

check('the shipped path spawns a real program and simulates nothing', () => {
  const code = codeOf(PROCESS_SOURCE_FILE);
  /* THE REQUIRE MOVED, THE PROMISE DID NOT. This used to grep for
     `require('node:child_process')` in this file. That is no longer here and
     must not be: every launch on the agent-start path now goes through the one
     seam in ../proc/hidden-spawn.js, so that "no console window ever appears"
     is a property of the API rather than of each call site remembering
     windowsHide (see tests/agent-engine/hidden-spawn-fence.test.js, and the
     measurement in the seam's own header). So the check follows the require one
     hop: this file must reach the seam, and the seam must reach a real
     child_process. A fake would satisfy neither. */
  assert.ok(
    code.includes("require('../proc/hidden-spawn')"),
    'the engine must launch through the single spawn seam, ../proc/hidden-spawn',
  );
  const seam = codeOf(path.join(__dirname, '..', '..', 'src', 'lib', 'proc', 'hidden-spawn.js'));
  assert.ok(seam.includes("require('node:child_process')"), 'the spawn seam must spawn a real child process');
  for (const fake of ['mockStream', 'fakeStream', 'simulate', 'FAKE_', 'stubTransport']) {
    assert.ok(!code.includes(fake), `the shipped engine contains "${fake}"; the product must run the real binary`);
  }
});

/* ------------------------------------------------------------------
   2. THE BILLING SCRUB -- the mechanism, not hygiene.
   ------------------------------------------------------------------ */

check('the API key is stripped, so the child falls back to the subscription', () => {
  const scrubbed = launchEnvironment({
    PATH: 'C:/tools', APPDATA: 'C:/roaming',
    ANTHROPIC_API_KEY: 'sk-should-not-survive',
    ANTHROPIC_BASE_URL: 'https://elsewhere.example',
    KEEP_ME: 'yes'
  });
  assert.equal(scrubbed.ANTHROPIC_API_KEY, undefined);
  assert.equal(scrubbed.ANTHROPIC_BASE_URL, undefined);
  /* PATH must SURVIVE or `claude` cannot be found at all. The scrub is a named
     credential list, not a filter. */
  assert.equal(scrubbed.PATH, 'C:/tools');
  assert.equal(scrubbed.KEEP_ME, 'yes');
});

check('the scrub is case-insensitive, because the OS that resolves it is', () => {
  /* A child reads environment names case-insensitively on Windows, so a key
     stored as `anthropic_api_key` is read canonically by the child and would be
     missed entirely by an exact-case delete. This is a bug this codebase has
     already been bitten by once, on the redaction path. */
  const scrubbed = launchEnvironment({ anthropic_api_key: 'lower', AnThRoPiC_ApI_kEy: 'mixed', PATH: 'x' });
  assert.deepEqual(Object.keys(scrubbed).sort(), ['PATH']);
});

check('an omitted environment means ambient MINUS credentials, never raw ambient', () => {
  /* codex-process.js documents the opposite behaviour as a defect: `env ===
     undefined ? process.env : env` handed a forgetful caller every credential on
     the machine. Here the careless path is the safe one. */
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ambient-should-not-survive';
  try {
    const scrubbed = launchEnvironment(undefined);
    assert.equal(scrubbed.ANTHROPIC_API_KEY, undefined, 'an omitted env forwarded the ambient API key');
    assert.ok(scrubbed.PATH || scrubbed.Path, 'the scrub removed PATH, so claude could never be found');
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
});

check('the credential list covers the redirectors as well as the keys', () => {
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.ok(CREDENTIAL_ENV_NAMES.includes(name), `${name} is not scrubbed`);
  }
});

/* ------------------------------------------------------------------
   3. THE CONTRACT, AND THE ARGV THAT MAKES A THREAD FREE.
   ------------------------------------------------------------------ */

check('the adapter satisfies the engine contract', () => {
  assertEngineAdapter(new ClaudeCliAdapter({ transport: fakeTransport() }));
});

check('a thread is named before any turn, so starting one costs nothing', async () => {
  /* MEASURED: system/init does not arrive until a user message is sent, so the
     id cannot be read off the stream without spending a turn. --session-id
     inverts that, and this is the assertion that keeps it inverted. */
  const args = claudeArgs({ threadId: THREAD_ID, threadOptions: {} });
  assert.ok(args.includes('--session-id'));
  assert.equal(args[args.indexOf('--session-id') + 1], THREAD_ID);
  assert.ok(args.includes('--print'));
  assert.ok(args.includes('--input-format') && args.includes('stream-json'));
  assert.ok(args.includes('--include-partial-messages'), 'without this a person watches nothing happen, then a wall of text');
});

check('a resume names the conversation and never also names a new one', () => {
  /* --resume and --session-id are mutually exclusive. Passing both is how a
     resume quietly becomes a fresh thread wearing a familiar name. */
  const args = claudeResumeArgs({ threadId: THREAD_ID, threadOptions: {} });
  assert.ok(args.includes('--resume'));
  assert.ok(!args.includes('--session-id'), 'a resume also declared a new session id');
  assert.equal(args[args.indexOf('--resume') + 1], THREAD_ID);
});

checkAsync('a resumed session does not invent history the CLI never reported', async () => {
  const session = await resumeClaudeSession({
    command: process.execPath,
    args: ['-e', "require('node:readline').createInterface({input:process.stdin}).on('line', line => { const p=JSON.parse(line); if(p.type === 'control_request' && p.request.subtype === 'initialize') process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:p.request_id}})+'\\n'); });"],
    threadId: THREAD_ID
  });
  try {
    assert.ok(!Object.hasOwn(session, 'turns'), 'an unobserved empty transcript was published as fact');
    assert.ok(!Object.hasOwn(session, 'turnCount'), 'an unobserved zero turn count was published as fact');
  } finally {
    session.close();
  }
});

checkAsync('resume rejects an exited child before handing a session to the sender', async () => {
  await assert.rejects(resumeClaudeSession({
    command: process.execPath,
    args: ['-e', "process.stderr.write('No conversation found with session ID: fixture\\n'); process.exit(1)"],
    threadId: THREAD_ID,
  }), { code: 'CLAUDE_CLI_EXITED' });
});

checkAsync('initialize waits for its own acknowledgement and sends no user turn', async () => {
  const { adapter, transport } = adapterWithTransport();
  let settled = false;
  const pending = adapter.initialize().then(() => { settled = true; });
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].type, 'control_request');
  assert.equal(transport.sent[0].request.subtype, 'initialize');
  transport.emit({ type: 'control_response', response: { subtype: 'success', request_id: 'unrelated' } });
  await Promise.resolve();
  assert.equal(settled, false);
  transport.emit({ type: 'control_response', response: { subtype: 'success', request_id: transport.sent[0].request_id } });
  await pending;
  assert.equal(settled, true);
  assert.equal(adapter.activeTurn, null);
  assert.equal(adapter.getUsage(), null);
  adapter.close();
});

checkAsync('initialize rejects provider refusal and failed writes without leaving pending requests', async () => {
  for (const mode of ['refuse', 'write']) {
    const { adapter, transport } = adapterWithTransport();
    if (mode === 'write') transport.send = () => { throw new ClaudeCliError('WRITE_FAILED', 'write failed'); };
    const pending = adapter.initialize();
    if (mode === 'refuse') transport.emit({ type: 'control_response', response: { subtype: 'error', request_id: transport.sent[0].request_id } });
    await assert.rejects(pending, { code: mode === 'write' ? 'WRITE_FAILED' : 'CLAUDE_CLI_INITIALIZE_REFUSED' });
    assert.equal(adapter.pendingControl.size, 0);
    adapter.close();
  }
});

checkAsync('an unanswered resume initialization times out and closes the child', async () => {
  await assert.rejects(resumeClaudeSession({
    command: process.execPath, args: ['-e', 'process.stdin.resume()'],
    threadId: THREAD_ID, startupTimeoutMs: 30,
  }), { code: 'CLAUDE_CLI_INITIALIZE_TIMEOUT' });
});

checkAsync('invalid JSON is surfaced as the protocol refusal without delivering or writing data', async () => {
  const transport = createClaudeCliTransport({
    command: process.execPath,
    args: ['-e', "setTimeout(() => process.stdout.write('not-json\\n'), 20); process.stdin.resume()"]
  });
  let writes = 0;
  const originalWrite = transport.child.stdin.write;
  transport.child.stdin.write = function (...args) {
    writes += 1;
    return originalWrite.apply(this, args);
  };
  const packets = [];
  try {
    const exit = await new Promise(resolve => {
      transport.onData((packet, info) => {
        if (packet === null) resolve(info);
        else packets.push(packet);
      });
    });
    assert.equal(exit.code, null, 'a protocol refusal is not reported as a normal child exit');
    assert.equal(exit.signal, null);
    assert.equal(exit.error && exit.error.code, 'CLAUDE_CLI_PROTOCOL_INVALID');
    assert.equal(exit.error && exit.error.message,
      'The Claude program wrote a response that was not valid JSON.');
    assert.deepEqual(packets, [], 'invalid stdout must not be delivered as a protocol packet');
    assert.equal(writes, 0, 'refusing malformed output must not write another protocol message');
    assert.equal(transport.child.stdin.writableEnded, true,
      'the unusable protocol stream must be closed as part of the refusal');
  } finally {
    transport.close();
  }
});

checkAsync('non-JSON protocol output fails an active turn immediately', async () => {
  const transport = createClaudeCliTransport({
    command: process.execPath,
    args: ['-e', "process.stderr.write('NON_JSON_FIXTURE_READY\\n'); process.stdin.once('data', () => { process.stdout.write('not-json\\n'); }); process.stdin.resume()"]
  });
  const adapter = new ClaudeCliAdapter({ transport, turnTimeoutMs: 5_000 });
  adapter.threadId = THREAD_ID;
  try {
    const pending = adapter.sendTurn({ threadId: THREAD_ID, text: 'hello' });
    await assert.rejects(pending, error => error.code === 'CLAUDE_CLI_EXITED');
    assert.equal(transport.stderr, 'NON_JSON_FIXTURE_READY\n');
  } finally {
    adapter.close();
    transport.close();
  }
});

check('an unrecognised permission level narrows, and never widens', () => {
  assert.equal(permissionModeFor({ sandbox: 'read-only' }), 'plan');
  assert.equal(permissionModeFor({ sandbox: 'workspace-write' }), 'acceptEdits');
  assert.equal(permissionModeFor({ sandbox: 'danger-full-access' }), 'bypassPermissions');
  /* The two that matter: a value this module has never heard of, and none at
     all. Both must land on the most restrictive mode the CLI has. */
  assert.equal(permissionModeFor({ sandbox: 'something-invented-later' }), 'plan');
  assert.equal(permissionModeFor({}), 'plan');
});

check('the model a person picked is the model that is passed', () => {
  assert.equal(cliModelFor('claude/opus'), 'opus');
  assert.equal(cliModelFor('sonnet'), 'sonnet');
  assert.equal(cliModelFor(null), null);
  const args = claudeArgs({ threadId: THREAD_ID, threadOptions: { model: 'claude/fable' } });
  assert.equal(args[args.indexOf('--model') + 1], 'fable');
});

check('the effort a person picked is passed on both new and resumed sessions', () => {
  const started = claudeArgs({
    threadId: THREAD_ID,
    threadOptions: { model: 'claude/opus', effort: 'max' }
  });
  const resumed = claudeResumeArgs({
    threadId: THREAD_ID,
    threadOptions: { model: 'claude/sonnet', effort: 'max' }
  });
  assert.equal(started[started.indexOf('--model') + 1], 'opus');
  assert.equal(started[started.indexOf('--effort') + 1], 'max');
  assert.equal(resumed[resumed.indexOf('--model') + 1], 'sonnet');
  assert.equal(resumed[resumed.indexOf('--effort') + 1], 'max');
});

check('the real binary is preferred over the shim that cannot be spawned', () => {
  /* Node 22 throws EINVAL spawning a .cmd without a shell, and %APPDATA%\npm
     ships three files per program of which only one is runnable here.
     `claude` (no extension) is a bash script this platform cannot run.

     THIS NO LONGER ANSWERS WITH A `shell` FLAG, and that is the point. A shell
     turns an argv array back into a string cmd.exe re-parses, which leaves the
     launcher unable to say what executable it started -- and saying that is
     what let the console-window defect be found at all. The invocation now
     names a RUNNABLE target and ../proc/hidden-spawn.js runs a .cmd through
     cmd.exe with an explicit argv. */
  const invocation = resolveInvocation('claude');
  assert.ok(typeof invocation.command === 'string' && invocation.command.length > 0);
  assert.equal(invocation.shell, undefined, 'the invocation must not carry a shell flag any more');
  if (process.platform === 'win32') {
    assert.ok(
      /\.(?:exe|cmd)$/i.test(invocation.command),
      `resolved "${invocation.command}"; on Windows it must name a runnable target, never the extensionless bash shim`,
    );
  }
});

checkAsync('not found is distinct from could not be established', async () => {
  const absent = new Error('missing');
  absent.code = 'ENOENT';
  assert.deepEqual(
    resolveInvocation('claude', {
      platform: 'win32', appData: 'C:\\profile', statSync() { throw absent; }
    }),
    { command: 'claude.cmd' },
    'an established absence should use the PATH fallback'
  );

  const unreadable = new Error('access denied');
  unreadable.code = 'EACCES';
  assert.throws(
    () => resolveInvocation('claude', {
      platform: 'win32', appData: 'C:\\profile', statSync() { throw unreadable; }
    }),
    error => error.code === 'CLAUDE_CLI_RESOLUTION_FAILED' && error.cause === unreadable,
    'an unreadable installation must not render as an absent installation'
  );

  const transport = createClaudeCliTransport({
    command: process.execPath,
    args: ['-e', "process.stdout.write('{\\\"type\\\":\\\"ready\\\"}\\n'); process.stdin.resume()"]
  });
  try {
    const exit = await new Promise(resolve => {
      transport.onData((packet, result) => {
        if (packet) throw new Error('receiver failed');
        resolve(result);
      });
    });
    assert.equal(exit.error.code, 'CLAUDE_CLI_HANDLER_FAILED');
    assert.equal(exit.error.cause.message, 'receiver failed');
  } finally {
    transport.close();
  }
});

/* ------------------------------------------------------------------
   4. THE EVENT MAPPING, fed the EXACT shapes measured off claude 2.1.186.
   ------------------------------------------------------------------ */

check('a text delta becomes assistant_text_delta', () => {
  const { transport, events } = adapterWithTransport();
  transport.emit({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'HEL' } },
    session_id: THREAD_ID
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'assistant_text_delta');
  assert.equal(events[0].text, 'HEL');
  assert.equal(events[0].threadId, THREAD_ID);
});

/* The identity on an assistant_text is the CONTENT BLOCK's, not the message's
   (d110b624, "preserve text content-block identities across stream and final").
   The message id alone cannot be it: one assistant message may carry several
   text blocks, and the same words in two of them are two things said, not a
   replay of one. So the pin below is the block identity, and the two cases
   after it are the reason that identity has to be composite -- a consumer that
   joins a stream to its final by itemId, and two blocks that must not collapse.
   Pinning 'msg_01' again would re-break both. */
check('an assistant message becomes assistant_text, carrying its content block identity', () => {
  const { transport, events } = adapterWithTransport();
  transport.emit({
    type: 'assistant',
    message: { id: 'msg_01', role: 'assistant', content: [{ type: 'text', text: 'BANANA-7731' }] },
    session_id: THREAD_ID
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'assistant_text');
  assert.equal(events[0].text, 'BANANA-7731');
  assert.equal(events[0].itemId, `text:${JSON.stringify(['msg_01', 0])}`);
});

check('two text blocks in one message keep separate identities, and equal words do not merge', () => {
  const { transport, events } = adapterWithTransport();
  transport.emit({
    type: 'assistant',
    message: {
      id: 'msg_01', role: 'assistant',
      content: [{ type: 'text', text: 'SAME' }, { type: 'tool_use', id: 'toolu_9', name: 'Glob', input: {} }, { type: 'text', text: 'SAME' }]
    },
    session_id: THREAD_ID
  });
  const texts = events.filter(event => event.type === 'assistant_text');
  assert.equal(texts.length, 2);
  assert.deepEqual(texts.map(event => event.text), ['SAME', 'SAME']);
  assert.equal(texts[0].itemId, `text:${JSON.stringify(['msg_01', 0])}`);
  assert.equal(texts[1].itemId, `text:${JSON.stringify(['msg_01', 2])}`);
  assert.notEqual(texts[0].itemId, texts[1].itemId);
});

check('a tool_use block becomes tool_call, carrying the tool and its input', () => {
  const { transport, events } = adapterWithTransport();
  transport.emit({
    type: 'assistant',
    message: { id: 'msg_02', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Glob', input: { pattern: '*.json' } }] },
    session_id: THREAD_ID
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_call');
  assert.equal(events[0].toolCallId, 'toolu_1');
  assert.equal(events[0].tool, 'Glob');
  assert.deepEqual(events[0].payload, { pattern: '*.json' });
});

check('a tool_result becomes tool_result, and an error is marked as one', () => {
  const { transport, events } = adapterWithTransport();
  transport.emit({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.json\nb.json' }] },
    session_id: THREAD_ID
  });
  transport.emit({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'nope', is_error: true }] },
    session_id: THREAD_ID
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'tool_result');
  assert.equal(events[0].toolCallId, 'toolu_1');
  assert.equal(events[0].status, 'ok');
  assert.equal(events[1].status, 'error');
});

check('a thinking block is forwarded as its own type, never as assistant_text', () => {
  /* Owner, 2026-09-03: "more event types are fine we should be showing the
     user when the model is thinking anyway." This used to assert the block
     was dropped whole; the contract now has a type for it, and this is the
     one place that type is produced. */
  const { transport, events } = adapterWithTransport();
  transport.emit({
    type: 'assistant',
    message: { id: 'msg_03', role: 'assistant', content: [{ type: 'thinking', thinking: 'private working', signature: 'sig' }] },
    session_id: THREAD_ID
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'thinking');
  assert.equal(events[0].text, 'private working');
  assert.equal(events[0].itemId, 'thinking:["msg_03",0]');
  assert.ok(!events.some(event => event.type === 'assistant_text'), 'the model\'s private working was forwarded as speech');
});

check('a thinking block missing its text field emits nothing, rather than an empty thinking event', () => {
  const { transport, events } = adapterWithTransport();
  transport.emit({
    type: 'assistant',
    message: { id: 'msg_04', role: 'assistant', content: [{ type: 'thinking', signature: 'sig' }] },
    session_id: THREAD_ID
  });
  assert.equal(events.length, 0);
});

checkAsync('system/init is forwarded as turn_accepted, carrying the turn sendTurn is already tracking', async () => {
  const { transport, adapter, events } = adapterWithTransport();
  const pending = adapter.sendTurn({ threadId: THREAD_ID, text: 'hello' });
  const turnId = adapter.activeTurn.turnId;
  transport.emit({ type: 'system', subtype: 'init', session_id: THREAD_ID });
  const accepted = events.filter(event => event.type === 'turn_accepted');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].threadId, THREAD_ID);
  assert.equal(accepted[0].turnId, turnId, 'turn_accepted must carry the same turnId announceTurn() keys on');
  /* Settle the turn so nothing is left pending after the check. */
  transport.emit({ type: 'result', subtype: 'success', is_error: false, result: 'hi' });
  await pending;
});

check('a system packet that is not init emits nothing, thinking_tokens included', () => {
  const { transport, events } = adapterWithTransport();
  transport.emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 3 });
  assert.equal(events.length, 0);
});

check('every emitted event is one the contract recognises', () => {
  const { transport, events } = adapterWithTransport();
  transport.emit({ type: 'system', subtype: 'init', session_id: THREAD_ID });
  transport.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } });
  transport.emit({
    type: 'assistant',
    message: { id: 'm', content: [{ type: 'thinking', thinking: 'w', signature: 's' }, { type: 'text', text: 'y' }] }
  });
  transport.emit({ type: 'result', subtype: 'success', is_error: false, result: 'y', usage: { input_tokens: 1 } });
  /* Packets deliberately ignored rather than mapped to a type they are not. */
  transport.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  transport.emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 3 });
  for (const event of events) {
    assert.ok(EVENT_TYPES.includes(event.type), `emitted an unsupported type: ${event.type}`);
  }
  assert.ok(events.some(event => event.type === 'usage'));
  assert.ok(events.some(event => event.type === 'turn_completed'));
  assert.ok(events.some(event => event.type === 'turn_accepted'));
  assert.ok(events.some(event => event.type === 'thinking'));
});

check('usage is emitted BEFORE turn_completed', () => {
  /* A listener that tears down its turn state on turn_completed would never see
     figures emitted after it. */
  const { transport, events } = adapterWithTransport();
  transport.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 2 } });
  const usageAt = events.findIndex(event => event.type === 'usage');
  const doneAt = events.findIndex(event => event.type === 'turn_completed');
  assert.ok(usageAt >= 0 && doneAt >= 0);
  assert.ok(usageAt < doneAt, 'turn_completed was emitted before usage');
});

check('a FAILED result\'s own sentence rides the completion event', () => {
  /* MEASURED, twice. A fresh-install walkthrough (2026-08-16) drove a real
     Fable turn into {"type":"result","subtype":"success","is_error":true,
     "api_error_status":429,"result":"You're out of usage credits · resets
     Aug 25, 12am"} — and the person's card said "The turn finished without
     any words back", because turn_completed carried only
     type|threadId|turnId|status while the one human sentence in the whole
     stream sat in `result`, delivered to nobody. Re-measured 2026-08-19
     against claude 2.1.186: `--model claude-fable` produces the same shape
     with api_error_status 404. The completion must carry the sentence, on the
     contract's own `text` field, so a surface can put it on the glass. */
  const { transport, events } = adapterWithTransport();
  transport.emit({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 429,
    result: 'You\'re out of usage credits · resets Aug 25, 12am'
  });
  const done = events.find(event => event.type === 'turn_completed');
  assert.ok(done, 'no completion was emitted for a failed result');
  assert.equal(done.status, 'error');
  assert.equal(done.text, 'You\'re out of usage credits · resets Aug 25, 12am');
});

check('a SUCCESSFUL result does not repeat its text on the completion', () => {
  /* On success the result string duplicates the assistant text the stream
     already delivered; carrying it again would hand every surface the same
     answer twice and invite double printing. The sentence rides ONLY when the
     turn failed, because that is the only time it exists nowhere else. */
  const { transport, events } = adapterWithTransport();
  transport.emit({ type: 'result', subtype: 'success', is_error: false, result: 'the answer' });
  const done = events.find(event => event.type === 'turn_completed');
  assert.ok(done, 'no completion was emitted for a successful result');
  assert.equal(done.text, undefined, 'a successful result\'s text was repeated on the completion');
});

/* ------------------------------------------------------------------
   5. TURN LIFECYCLE, and the failures that must not read as success.
   ------------------------------------------------------------------ */

checkAsync('a turn resolves on result, and carries the provider\'s own figures', async () => {
  const { transport, adapter } = adapterWithTransport();
  const pending = adapter.sendTurn({ threadId: THREAD_ID, text: 'hello' });
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].type, 'user');
  transport.emit({ type: 'result', subtype: 'success', is_error: false, result: 'BANANA-7731', usage: { input_tokens: 3, output_tokens: 5 } });
  const result = await pending;
  assert.equal(result.text, 'BANANA-7731');
  assert.equal(result.status, 'success');
  assert.equal(result.isError, false);
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 5 });
  const usage = adapter.getUsage();
  assert.deepEqual(usage, { input_tokens: 3, output_tokens: 5 });
});

checkAsync('a failed transport write does not leave the session busy', async () => {
  const transport = fakeTransport();
  let fail = true;
  transport.send = message => {
    if (fail) {
      fail = false;
      throw new Error('stdin is closed');
    }
    transport.sent.push(message);
  };
  const adapter = new ClaudeCliAdapter({ transport });
  adapter.threadId = THREAD_ID;

  await assert.rejects(adapter.sendTurn({ threadId: THREAD_ID, text: 'one' }), /stdin is closed/);
  const second = adapter.sendTurn({ threadId: THREAD_ID, text: 'two' });
  assert.equal(transport.sent.length, 1);
  transport.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
  await second;
});

checkAsync('an INTERRUPTED turn resolves with no text, which is not malformed', async () => {
  /* MEASURED: an interrupted turn produces a result packet with NO `result`
     field. An early probe assumed a string and threw. */
  const { transport, adapter } = adapterWithTransport();
  const pending = adapter.sendTurn({ threadId: THREAD_ID, text: 'count to a hundred' });
  transport.emit({ type: 'result', subtype: 'error_during_execution', is_error: false });
  const result = await pending;
  assert.equal(result.text, null);
  assert.equal(result.status, 'error_during_execution');
});

checkAsync('a child that dies mid-turn REJECTS, and never resolves empty', async () => {
  /* A resolved turn with no answer reads to every caller as a successful empty
     reply, which is the silence this project keeps paying for. */
  const { transport, adapter } = adapterWithTransport();
  const pending = adapter.sendTurn({ threadId: THREAD_ID, text: 'hello' });
  transport.exit({ code: 1, signal: null, stderr: 'boom' });
  await assert.rejects(pending, error => error.code === 'CLAUDE_CLI_EXITED');
});

checkAsync('a second turn on a busy session is refused by name', async () => {
  const { transport, adapter } = adapterWithTransport();
  const first = adapter.sendTurn({ threadId: THREAD_ID, text: 'one' });
  await assert.rejects(
    adapter.sendTurn({ threadId: THREAD_ID, text: 'two' }),
    error => error.code === 'CLAUDE_CLI_TURN_ACTIVE'
  );
  transport.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
  await first;
});

checkAsync('interrupt is a protocol message and resolves on the CLI\'s answer', async () => {
  /* MEASURED: control_request/interrupt is answered control_response/success.
     Killing the child instead would end the SESSION to stop a TURN. */
  const { transport, adapter } = adapterWithTransport();
  const turn = adapter.sendTurn({ threadId: THREAD_ID, text: 'count to a hundred' });
  const stopping = adapter.interrupt();
  const control = transport.sent.find(message => message.type === 'control_request');
  assert.ok(control, 'no control_request was sent; the child was probably killed instead');
  assert.equal(control.request.subtype, 'interrupt');
  transport.emit({ type: 'control_response', response: { subtype: 'success', request_id: control.request_id } });
  const answer = await stopping;
  assert.equal(answer.subtype, 'success');
  transport.emit({ type: 'result', subtype: 'error_during_execution', is_error: false });
  await turn;
});

checkAsync('interrupting nothing refuses rather than pretending', async () => {
  const { adapter } = adapterWithTransport();
  await assert.rejects(adapter.interrupt(), error => error.code === 'CLAUDE_CLI_NO_TURN');
});

/* ------------------------------------------------------------------
   6. FAILING CLOSED.
   ------------------------------------------------------------------ */

checkAsync('an approval can never be granted through an unwired path', async () => {
  /* Rule 4 of the transport contract: the absent state must DENY, not permit. */
  const { adapter } = adapterWithTransport();
  await assert.rejects(
    adapter.answerApproval({ approvalId: 'a1', response: { decision: 'allow' } }),
    error => error.code === 'CLAUDE_CLI_APPROVALS_UNSUPPORTED'
  );
});

checkAsync('forking refuses by name instead of returning the parent thread', async () => {
  /* Silently returning the parent would let a person believe they are on a
     branch while they overwrite the original. */
  const { adapter } = adapterWithTransport();
  await assert.rejects(adapter.forkThread(), error => error.code === 'CLAUDE_CLI_FORK_UNSUPPORTED');
});

checkAsync('a picture that cannot be read is refused rather than silently dropped', async () => {
  /* Sending the text alone would answer a question about a picture the model
     never received, and look like the model ignoring it.
     UPDATED 2026-09-15 (T18): this case used to assert CLAUDE_CLI_IMAGES_UNSUPPORTED,
     because this adapter refused EVERY picture. It now sends pictures
     (tests/agent-engine/claude-cli-image-turn.test.js pins that), so the
     blanket refusal is gone and the path below -- which does not exist -- must
     refuse under the unreadable code instead. The guarantee under test is
     unchanged and still the stronger half: a picture that did not travel must
     take its turn down with it, never leave the words to travel alone. */
  const { adapter, transport } = adapterWithTransport();
  await assert.rejects(
    adapter.sendTurn({ threadId: THREAD_ID, text: 'what is this', images: [{ path: 'C:/tmp/a.png' }] }),
    error => error.code === 'CLAUDE_CLI_IMAGE_UNREADABLE'
  );
  assert.equal(transport.sent.length, 0,
    'the words must not reach the model when the picture they are about did not');
});

checkAsync('a turn for another conversation is refused', async () => {
  const { adapter } = adapterWithTransport();
  await assert.rejects(
    adapter.sendTurn({ threadId: '00000000-0000-4000-8000-000000000000', text: 'hello' }),
    error => error.code === 'CLAUDE_CLI_INVALID_THREAD'
  );
});

checkAsync('closing a session with a turn in flight rejects it', async () => {
  const { adapter } = adapterWithTransport();
  const pending = adapter.sendTurn({ threadId: THREAD_ID, text: 'hello' });
  adapter.close();
  await assert.rejects(pending, error => error.code === 'CLAUDE_CLI_CLOSED');
});

checkAsync('closing a session rejects a pending interrupt', async () => {
  const { adapter } = adapterWithTransport();
  const turn = adapter.sendTurn({ threadId: THREAD_ID, text: 'hello' });
  const stopping = adapter.interrupt();
  adapter.close();
  await assert.rejects(stopping, error => error.code === 'CLAUDE_CLI_CLOSED');
  await assert.rejects(turn, error => error.code === 'CLAUDE_CLI_CLOSED');
});

check('a listener that throws does not stop the others', () => {
  const transport = fakeTransport();
  const adapter = new ClaudeCliAdapter({ transport });
  adapter.threadId = THREAD_ID;
  const seen = [];
  adapter.onEvent(() => { throw new Error('bad listener'); });
  adapter.onEvent(event => seen.push(event));
  transport.emit({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'still delivered' }] } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'still delivered');
});

check('ClaudeCliError carries a code a caller can branch on', () => {
  const error = new ClaudeCliError('CLAUDE_CLI_CLOSED', 'closed');
  assert.equal(error.code, 'CLAUDE_CLI_CLOSED');
  assert.equal(error.name, 'ClaudeCliError');
});


checkAsync('ordinary native resume confirms the exact identity before accepting its first turn', async () => {
  const transport = fakeTransport();
  const adapter = new ClaudeCliAdapter({ transport, expectedResumeThreadId: THREAD_ID });
  adapter.threadId = THREAD_ID;
  const events = []; adapter.onEvent(event => events.push(event));
  const pending = adapter.sendTurn({ threadId: THREAD_ID, text: 'Continue.' });
  transport.emit({ type: 'system', subtype: 'init', session_id: THREAD_ID });
  assert.equal(events.filter(event => event.type === 'turn_accepted').length, 1);
  assert.equal(events.find(event => event.type === 'turn_accepted').threadId, THREAD_ID);
  transport.emit({ type: 'result', session_id: THREAD_ID, subtype: 'success', result: 'Continued.' });
  assert.equal((await pending).text, 'Continued.');
  adapter.close();
});

checkAsync('ordinary native resume refuses wrong identity or output before identity without accepting the turn', async () => {
  for (const packet of [
    { type: 'system', subtype: 'init', session_id: '00000000-0000-4000-8000-000000000000' },
    { type: 'assistant', session_id: THREAD_ID, message: { content: [{ type: 'text', text: 'Unconfirmed.' }] } },
    { type: 'result', session_id: THREAD_ID, subtype: 'success', result: 'Unconfirmed.' }
  ]) {
    const transport = fakeTransport(); let closed = false; transport.close = () => { closed = true; };
    const adapter = new ClaudeCliAdapter({ transport, expectedResumeThreadId: THREAD_ID });
    adapter.threadId = THREAD_ID;
    const events = []; adapter.onEvent(event => events.push(event));
    const pending = adapter.sendTurn({ threadId: THREAD_ID, text: 'Continue.' });
    transport.emit(packet);
    await assert.rejects(pending, error => error.code === 'CLAUDE_RESUME_IDENTITY_MISMATCH');
    assert.equal(closed, true);
    assert.ok(!events.some(event => ['turn_accepted', 'assistant_text', 'turn_completed'].includes(event.type)));
  }
});

/* COMPATIBILITY BY FEATURE, NEVER BY A PINNED VERSION (rc-0922).
 *
 * The owner: "we should really be able to handle these automatically so we
 * dont need to try to parent the codex version all the time", then "expand to
 * the other providers too". A Claude that lacked an option the engine passes
 * used to fail at start with no clear reason, and one without --effort failed
 * on every start that asked for an effort. Now the program's own --help is read
 * once per copy: a missing required option refuses the start by name, a
 * missing --effort is left out and named on the session, and a copy
 * ToolsEnabled installed into its own folder never updates itself mid-session.
 * The fixture is a real executable standing in for claude, answering --help
 * from the recorded 2.1.280 listing. */
const { startClaudeSession: startForFeatures } = require('../../src/lib/agent-engine/claude-cli-process');
const HELP_2_1_280 = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-help-2.1.280.txt'), 'utf8');

function fakeClaude(dir, help) {
  const file = path.join(dir, 'claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
const out = process.env.FAKE_CLAUDE_OUT;
if (process.argv.includes('--help')) { fs.appendFileSync(out + '.help', 'x'); process.stdout.write(${JSON.stringify(help)}); process.exit(0); }
if (process.argv.includes('--version')) { process.stdout.write('2.1.280 (Claude Code)\\n'); process.exit(0); }
fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), autoUpdaterOff: process.env.DISABLE_AUTOUPDATER || null }));
process.stdin.resume();
`, { mode: 0o755 });
  return file;
}

async function launched(out) {
  for (let i = 0; i < 200 && !fs.existsSync(out); i++) await new Promise(resolve => setTimeout(resolve, 25));
  return fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
}

if (process.platform !== 'win32') {
  checkAsync('a Claude that lacks a required option is refused by name, and no session starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-features-old-'));
    try {
      const out = path.join(dir, 'session.json');
      const command = fakeClaude(path.join(dir, 'bin'), HELP_2_1_280.replace(/^ {2}--tools .*$/m, ''));
      await assert.rejects(startForFeatures({ command, cwd: dir, env: { PATH: '/usr/bin:/bin', FAKE_CLAUDE_OUT: out }, threadOptions: {} }),
        error => error.code === 'CLAUDE_CLI_UPDATE_NEEDED' && /does not support --tools\. Update Claude Code, then start again\./.test(error.message));
      assert.equal(fs.existsSync(out), false, 'a session was started on a Claude that cannot run it');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  checkAsync('a Claude without --effort starts without it, and the session says what it could not use', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-features-effort-'));
    let session = null;
    try {
      const out = path.join(dir, 'session.json');
      const command = fakeClaude(path.join(dir, 'bin'), HELP_2_1_280.replace(/^ *--effort .*$/m, ''));
      session = await startForFeatures({ command, cwd: dir, env: { PATH: '/usr/bin:/bin', FAKE_CLAUDE_OUT: out }, threadOptions: { effort: 'high' } });
      const child = await launched(out);
      assert.ok(child, 'the session child never started');
      assert.ok(!child.argv.includes('--effort'), `an option this Claude does not list was passed: ${child.argv.join(' ')}`);
      assert.ok(child.argv.includes('--print') && child.argv.includes('--tools'));
      assert.deepEqual({ ...session.cliFeatures, missingRequired: [...session.cliFeatures.missingRequired], missingOptional: [...session.cliFeatures.missingOptional] },
        { state: 'ready-with-limits', missingRequired: [], missingOptional: ['--effort'] });
    } finally { if (session) session.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  checkAsync('the help is read once per copy, again after the copy changes, and a copy ToolsEnabled owns never updates itself', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-features-owned-'));
    const sessions = [];
    try {
      const owned = path.join(dir, 'providers');
      const ownedBin = path.join(owned, 'claude', '2.1.280', 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
      const personBin = path.join(dir, 'person-bin');
      for (const [bin, name, expected] of [[ownedBin, 'owned', '1'], [personBin, 'person', null]]) {
        const out = path.join(dir, `${name}.json`);
        const command = fakeClaude(bin, HELP_2_1_280);
        const env = { PATH: '/usr/bin:/bin', FAKE_CLAUDE_OUT: out, TOOLSENABLED_PROVIDERS_ROOT: owned };
        sessions.push(await startForFeatures({ command, cwd: dir, env, threadOptions: { effort: 'high' } }));
        const child = await launched(out);
        assert.equal(child.autoUpdaterOff, expected, `${name} copy: self-update switch ${child.autoUpdaterOff}`);
        assert.ok(child.argv.includes('--effort'), 'a Claude that lists --effort must be given the requested effort');
        assert.equal(sessions.at(-1).cliFeatures.state, 'ready');
        fs.rmSync(out);
        sessions.push(await startForFeatures({ command, cwd: dir, env, threadOptions: {} }));
        await launched(out);
        assert.equal(fs.readFileSync(`${out}.help`, 'utf8'), 'x', `${name} copy: --help was asked again for the same unchanged program`);
        fs.appendFileSync(command, '\n// updated outside the app\n');
        fs.rmSync(out);
        sessions.push(await startForFeatures({ command, cwd: dir, env, threadOptions: {} }));
        await launched(out);
        assert.equal(fs.readFileSync(`${out}.help`, 'utf8'), 'xx', `${name} copy: a changed program was not asked again`);
      }
    } finally { for (const session of sessions) session.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

process.once('beforeExit', () => {
  process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'} - claude-cli-process (${failures} failing)\n`);
  process.exitCode = failures === 0 ? 0 : 1;
});
