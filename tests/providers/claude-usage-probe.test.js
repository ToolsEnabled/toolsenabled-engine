'use strict';
// THE ZERO-TOKEN USAGE READ: its spawn, its request, its reply normalisation
// and its refusals, driven through an injected spawn seam.
//
// The success fixture has the SHAPE and KEY SET of the `get_usage` control
// reply Claude Code 2.1.258 answered on 2026-09-02 for a signed-in
// subscription home, with every field this module reads present (the
// `behaviors` block, which it never reads, is omitted). Every figure,
// timestamp, plan name and model name in it is invented: the shape was
// measured, the numbers were not, and nothing here describes a real account.
// The refusal fixture has the shape of the reply the same build gave for an
// empty config directory. Keeping the measured shape matters here for the
// same reason it mattered for the auth probe: the reply's `limits[]` carries
// an `is_active` flag the brief for this module said it would not, and a
// fixture drawn from the brief would have followed the brief.
//
// No real CLI is started and no real home is named. The one file this suite
// opens is the module's own source, to hold it to the credential fence.
//
//   node --test tests/providers/claude-usage-probe.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  APPLICABILITY,
  CONTROL_SUBTYPE,
  DEFAULT_EXIT_GRACE_MS,
  DEFAULT_USAGE_TIMEOUT_MS,
  MAX_STDOUT_CHARS,
  PROBE_ARGS,
  SOURCE,
  UNKNOWN_REASON,
  claudeUsageProbe,
  normalizeUsageReply
} = require('../../src/lib/providers/claude-usage-probe.js');
const { claudeWindows } = require('../../src/lib/multi-account/usage-windows.js');

const PROBE_SOURCE = path.join(__dirname, '..', '..', 'src', 'lib', 'providers', 'claude-usage-probe.js');
const CONFIG_DIR = path.join('C:', 'not-a-real-home', '.claude-personal');
const EXECUTABLE = { command: 'claude-fake', prefixArgs: [] };

// -- fixtures in the measured shape, with invented figures -------------------

const LIVE_RATE_LIMITS = {
  five_hour: { utilization: 11, resets_at: '2031-01-01T01:00:00.000000+00:00', limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day: { utilization: 22, resets_at: '2031-01-07T07:00:00.000000+00:00', limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  seven_day_omelette: null,
  tangelo: null,
  iguana_necktie: null,
  omelette_promotional: null,
  nimbus_quill: { utilization: 0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  cinder_cove: null,
  amber_ladder: null,
  juniper_tide: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null, decimal_places: null, disabled_reason: null, user_disabled: false, spend_limit_reached: false, credits_ever_enabled: false, daily: null, weekly: null },
  limits: [
    { kind: 'session', group: 'session', percent: 11, severity: 'normal', resets_at: '2031-01-01T01:00:00.000000+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 22, severity: 'normal', resets_at: '2031-01-07T07:00:00.000000+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 44, severity: 'normal', resets_at: '2031-01-07T07:00:07.000000+00:00', scope: { model: { id: null, display_name: 'Example Model' }, surface: null }, is_active: true }
  ],
  spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0, severity: 'normal', enabled: false, disabled_reason: null, cap: null, balance: null, auto_reload: null, disclaimer: 'Usage credits cover you when you hit your plan limits.', can_purchase_credits: false, can_toggle: false },
  member_dashboard_available: false,
  model_scoped: [{ display_name: 'Example Model', utilization: 44, resets_at: '2031-01-07T07:00:07.000000+00:00' }]
};

const SESSION = { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 1, total_lines_added: 0, total_lines_removed: 0, model_usage: {} };

const LIVE_REPLY = { session: SESSION, subscription_type: 'sample-plan', rate_limits_available: true, rate_limits: LIVE_RATE_LIMITS };

// The shape of the reply for an empty CLAUDE_CONFIG_DIR, same build. It carries no figures.
const SIGNED_OUT_REPLY = { session: SESSION, subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null };

function controlResponse(requestId, response) {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
}

// -- the spawn seam ---------------------------------------------------------

/* `script(request)` decides what the fake CLI does with the one request the
   probe writes: `lines` (strings, or arrays of chunks for one line) then
   `exitCode`; `hang` to never answer; `error` to fail the spawn. Like the real
   CLI, the fake exits when its stdin is closed -- unless `ignoreEnd`, which
   models a CLI that outstays the grace and has to be killed. */
function fakeSpawn(script) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const handlers = {};
    const events = new EventEmitter();
    let finishJob;
    const jobOutcome = new Promise(resolve => { finishJob = resolve; });
    let plan = null;
    let closed = false;
    const close = code => {
      if (closed) return;
      closed = true;
      setImmediate(() => {
        events.emit('close', code);
        finishJob({ type: 'exit', activeProcesses: 0, exitCode: code });
      });
    };
    const child = {
      stdin: {
        written: '',
        ended: false,
        write(text) {
          this.written += text;
          respond(text);
          return true;
        },
        end() {
          this.ended = true;
          if (!(plan && plan.ignoreEnd)) close(0);
        },
        on() {}
      },
      stdout: { on(event, handler) { if (event === 'data') handlers.data = handler; } },
      stderr: { on() {} },
      killed: false,
      kill() { this.killed = true; close(null); },
      on(event, handler) { events.on(event, handler); return child; },
      once(event, handler) { events.once(event, handler); return child; },
      jobOutcome,
      async terminateJob() { if (!closed) child.kill(); return jobOutcome; }
    };
    function respond(text) {
      const request = JSON.parse(text.trim());
      plan = script(request, child);
      if (!plan || plan.hang) return;
      setImmediate(() => {
        if (plan.error) { events.emit('error', plan.error); close(null); return; }
        for (const line of plan.lines || []) {
          const chunks = Array.isArray(line) ? line : [`${line}\n`];
          for (const chunk of chunks) handlers.data?.(Buffer.from(chunk));
        }
        if (plan.exitCode !== undefined) close(plan.exitCode);
      });
    }
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawnImpl, calls };
}

function probe(spawnImpl, overrides = {}) {
  return claudeUsageProbe({
    configDir: CONFIG_DIR,
    spawnImpl,
    executable: EXECUTABLE,
    baseEnvironment: { PATH: 'p', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'decoy-api-key-DO-NOT-USE' },
    now: () => 1_234,
    exitGraceMs: 20,
    ...overrides
  });
}

// -- success ----------------------------------------------------------------

test('a signed-in reply is normalised to the cache adapter shape, with the provider\'s own active flag', async () => {
  const { spawnImpl, calls } = fakeSpawn(request => ({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'irrelevant' }),
      controlResponse('someone-elses-request', SIGNED_OUT_REPLY),
      // The reply itself arrives split across two chunks.
      [controlResponse(request.request_id, LIVE_REPLY).slice(0, 40), `${controlResponse(request.request_id, LIVE_REPLY).slice(40)}\n`]
    ],
    exitCode: 0
  }));
  const result = await probe(spawnImpl);

  assert.equal(result.status, 'MEASURED');
  assert.equal(result.source, SOURCE);
  assert.equal(SOURCE, 'claude-get-usage');
  assert.equal(result.fetchedAtMs, 1_234);
  assert.equal(result.ageMs, 0);
  assert.equal(result.accountUuid, null);
  assert.equal(result.subscriptionType, 'sample-plan');
  assert.deepEqual(result.limits.map(limit => limit.kind), ['session', 'weekly_all', 'weekly_scoped']);
  assert.deepEqual(result.limits.map(limit => limit.group), ['session', 'weekly', 'weekly']);
  assert.deepEqual(result.limits.map(limit => limit.percent), [11, 22, 44]);
  assert.deepEqual(result.limits.map(limit => limit.isActive), [false, false, true]);
  assert.deepEqual(result.limits.map(limit => limit.applicability), [APPLICABILITY.MEASURED, APPLICABILITY.MEASURED, APPLICABILITY.MEASURED]);
  assert.deepEqual(result.limits.map(limit => limit.index), [0, 1, 2]);
  assert.equal(result.limits[2].model, 'Example Model');
  assert.equal(result.limits[2].resetsAt, '2031-01-07T07:00:07.000000+00:00');
  assert.equal(result.bindingLimit.kind, 'weekly_scoped');
  assert.deepEqual(result.activeLimits.map(limit => limit.kind), ['weekly_scoped']);
  assert.deepEqual(Object.keys(result).sort(),
    ['accountUuid', 'activeLimits', 'ageMs', 'bindingLimit', 'fetchedAtMs', 'limits', 'source', 'status', 'subscriptionType'],
    'the result shape is what usage-windows and the menu consume');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.limits));

  // And usage-windows reads it the way it reads the cache.
  const windows = claudeWindows(result);
  assert.equal(windows.hourly.usedPercent, 11);
  assert.equal(windows.weekly.usedPercent, 44);
  assert.equal(windows.weekly.label, 'weekly_scoped · Example Model');

  // The spawn itself.
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, 'claude-fake');
  assert.deepEqual(call.args, [...PROBE_ARGS]);
  assert.deepEqual([...PROBE_ARGS], ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(call.options.env.CLAUDE_CONFIG_DIR, CONFIG_DIR);
  assert.equal(Object.hasOwn(call.options.env, 'CLAUDECODE'), false, 'the nested-session marker must be removed');
  assert.equal(Object.hasOwn(call.options.env, 'ANTHROPIC_API_KEY'), false, 'the ambient metered key must be scrubbed');
  assert.equal(call.options.env.PATH, 'p');

  // The one request written, and the child's ending.
  const written = call.child.stdin.written.split('\n').filter(Boolean);
  assert.equal(written.length, 1, 'exactly one request, and never a user message');
  const request = JSON.parse(written[0]);
  assert.equal(request.type, 'control_request');
  assert.deepEqual(request.request, { subtype: CONTROL_SUBTYPE });
  assert.equal(CONTROL_SUBTYPE, 'get_usage');
  assert.match(request.request_id, /^usage-\d+-\d+$/);
  assert.equal(call.child.stdin.ended, true, 'stdin is closed so the CLI leaves on its own');
  assert.equal(call.child.killed, false, 'a CLI that leaves when asked is not killed');

  // The scratch cwd was created under the temp root and is gone afterwards.
  assert.equal(path.dirname(call.options.cwd), path.resolve(os.tmpdir()));
  assert.ok(path.basename(call.options.cwd).startsWith('claude-usage-probe-'));
  assert.equal(fs.existsSync(call.options.cwd), false, 'the scratch folder must be removed');
});

test('a reply without the limits array falls back to the named windows, marking the most used one active', async () => {
  const { spawnImpl } = fakeSpawn(request => ({
    lines: [controlResponse(request.request_id, {
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 11, resets_at: '2031-01-01T01:00:00+00:00' },
        seven_day: { utilization: 22, resets_at: '2031-01-07T07:00:00+00:00' },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: null, resets_at: null },
        nimbus_quill: { utilization: 99 }
      }
    })],
    exitCode: 0
  }));
  const result = await probe(spawnImpl);
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.subscriptionType, 'pro');
  assert.deepEqual(result.limits.map(limit => [limit.kind, limit.applicability, limit.percent, limit.isActive]), [
    ['five_hour', APPLICABILITY.MEASURED, 11, false],
    ['seven_day', APPLICABILITY.MEASURED, 22, true],
    ['seven_day_opus', APPLICABILITY.NOT_APPLICABLE, null, false],
    ['seven_day_sonnet', APPLICABILITY.NOT_APPLICABLE, null, false]
  ], 'undocumented buckets are not read; null windows do not apply');
  assert.deepEqual(result.limits.map(limit => limit.group), [null, null, null, null]);
  assert.deepEqual(result.limits.map(limit => limit.model), [null, null, null, null]);
  assert.equal(result.bindingLimit.kind, 'seven_day');
  const windows = claudeWindows(result);
  assert.equal(windows.hourly.usedPercent, 11);
  assert.equal(windows.weekly.usedPercent, 22);

  const drifted = normalizeUsageReply({
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 60 }, limits: [{ kind: 'session', percent: 60 }] }
  }, { now: () => 5 });
  assert.equal(drifted.status, 'MEASURED');
  assert.deepEqual(drifted.limits.map(limit => limit.kind), ['five_hour'],
    'a limits entry without is_active is drift, and the named windows stand in for the whole array');
  assert.equal(drifted.fetchedAtMs, 5);
});

// -- refusals ---------------------------------------------------------------

test('rate limits unavailable is UNKNOWN with a reason, never room', async () => {
  const { spawnImpl } = fakeSpawn(request => ({ lines: [controlResponse(request.request_id, SIGNED_OUT_REPLY)], exitCode: 0 }));
  const result = await probe(spawnImpl);
  assert.deepEqual(result, { status: 'UNKNOWN', reason: UNKNOWN_REASON.RATE_LIMITS_UNAVAILABLE,
    detail: 'No plan rate limits apply to this sign-in. It may be signed out or billing a metered key.' });
  assert.ok(Object.isFrozen(result));

  const named = normalizeUsageReply({ subscription_type: 'pro', rate_limits_available: false, rate_limits: null });
  assert.equal(named.reason, UNKNOWN_REASON.RATE_LIMITS_UNAVAILABLE);
  assert.equal(named.detail, 'No plan rate limits were reported for this pro sign-in.');
});

test('an eligible plan with an unavailable fetch retains unknown usage and its signed-in status', async () => {
  // Claude Code 2.1.259 sets rate_limits_available from plan eligibility.
  // Its get_usage handler returns rate_limits:null when the fetch reports
  // empty_response or unavailable. This is a valid reply, without a figure.
  const reply = { session: SESSION, subscription_type: 'pro',
    rate_limits_available: true, rate_limits: null, behaviors: null };
  const { spawnImpl, calls } = fakeSpawn(request => ({
    lines: [controlResponse(request.request_id, reply)], exitCode: 0
  }));
  const reading = await probe(spawnImpl);
  assert.equal(reading.status, 'UNKNOWN');
  assert.equal(reading.reason, 'CLAUDE_USAGE_FETCH_UNAVAILABLE');
  assert.equal(reading.detail, 'Claude could not retrieve this plan’s allowance just now.');
  assert.equal(Object.hasOwn(reading, 'limits'), false);
  assert.equal(calls.length, 1, 'an unavailable fetch does not trigger another request');
  assert.equal(calls[0].child.stdin.ended, true);

  const { claudeProbeFactory } = require('../../src/lib/multi-account/rotation.js');
  const row = await claudeProbeFactory({
    homeDir: path.join(os.tmpdir(), 'claude-null-limits-fixture'), exhaustedAtPercent: 100,
    authProbe: async () => ({ state: 'indeterminate', capabilityRan: false,
      billingSource: 'subscription', account: 'fixture@example.invalid', plan: 'pro' }),
    usageProbe: async () => reading
  })({ name: 'Fixture', provider: 'claude',
    configDir: path.join(os.tmpdir(), 'claude-null-limits-fixture', '.claude-fixture'), expectEmail: 'fixture@example.invalid' });
  assert.equal(row.status, 'healthy');
  assert.equal(row.canServe, true);
  assert.equal(row.usageStatus, 'unavailable');
  assert.equal(row.usageCode, 'CLAUDE_USAGE_FETCH_UNAVAILABLE');
  assert.equal(row.usedPercent, null);
  assert.equal(row.readAt, null);
  assert.deepEqual(row.windows, { hourly: null, weekly: null, weeklyWindows: [] });
});

test('a timeout closes stdin, kills a CLI that outstays the grace, and answers UNKNOWN', async () => {
  const polite = fakeSpawn(() => ({ hang: true }));
  const result = await probe(polite.spawnImpl, { timeoutMs: 40 });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.reason, UNKNOWN_REASON.TIMEOUT);
  assert.equal(result.detail, 'The Claude CLI gave no usage reply within 40 ms.');
  assert.equal(polite.calls[0].child.stdin.ended, true);
  assert.equal(polite.calls[0].child.killed, false, 'a CLI that leaves on stdin close is not killed');

  const stubborn = fakeSpawn(() => ({ hang: true, ignoreEnd: true }));
  const killed = await probe(stubborn.spawnImpl, { timeoutMs: 40, exitGraceMs: 30 });
  assert.equal(killed.reason, UNKNOWN_REASON.TIMEOUT);
  assert.equal(stubborn.calls[0].child.stdin.ended, true);
  assert.equal(stubborn.calls[0].child.killed, true, 'a CLI that ignores stdin close is killed after the grace');

  assert.equal(DEFAULT_USAGE_TIMEOUT_MS, 20000);
  assert.equal(DEFAULT_EXIT_GRACE_MS, 3000);
});

test('malformed replies are UNKNOWN, each by name', async () => {
  const nonsense = fakeSpawn(request => ({ lines: [controlResponse(request.request_id, 'nonsense')], exitCode: 0 }));
  assert.equal((await probe(nonsense.spawnImpl)).reason, UNKNOWN_REASON.MALFORMED);

  for (const invalid of [undefined, [], 'unreadable', 7]) {
    const invalidLimits = fakeSpawn(request => ({
      lines: [controlResponse(request.request_id, { rate_limits_available: true, rate_limits: invalid })], exitCode: 0
    }));
    assert.equal((await probe(invalidLimits.spawnImpl)).reason, UNKNOWN_REASON.MALFORMED,
      'missing, array, and primitive limits remain malformed');
  }

  const noWindow = fakeSpawn(request => ({ lines: [controlResponse(request.request_id, {
    rate_limits_available: true, rate_limits: { limits: [{ kind: 'weekly_all', percent: null, is_active: false }] }
  })], exitCode: 0 }));
  assert.equal((await probe(noWindow.spawnImpl)).reason, UNKNOWN_REASON.NO_MEASURED_WINDOW);

  const garbage = fakeSpawn(() => ({ lines: ['this is not json', '{"type":"control_response"}', '{"type":"control_response","response":{"subtype":"success","request_id":"other"}}'], exitCode: 1 }));
  const noReply = await probe(garbage.spawnImpl);
  assert.equal(noReply.reason, UNKNOWN_REASON.NO_REPLY);
  assert.equal(noReply.detail, 'The Claude CLI exited (code 1) before answering the usage request.');

  const refused = fakeSpawn(request => ({ lines: [JSON.stringify({
    type: 'control_response',
    response: { subtype: 'error', request_id: request.request_id, error: 'get_usage is not supported in this context SENTINEL-sk-not-a-key' }
  })], exitCode: 0 }));
  const controlError = await probe(refused.spawnImpl);
  assert.equal(controlError.reason, UNKNOWN_REASON.CONTROL_ERROR);
  assert.doesNotMatch(JSON.stringify(controlError), /SENTINEL/, 'provider text is never forwarded into a result');

  assert.equal(normalizeUsageReply(null).reason, UNKNOWN_REASON.MALFORMED);
  assert.equal(normalizeUsageReply([]).reason, UNKNOWN_REASON.MALFORMED);
});

test('stdout beyond the existing bound remains malformed and stops the exchange', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => ({ lines: ['x'.repeat(MAX_STDOUT_CHARS + 1)], exitCode: 0 }));
  const result = await probe(spawnImpl);
  assert.equal(result.reason, UNKNOWN_REASON.MALFORMED);
  assert.equal(result.detail, 'The Claude CLI wrote a great deal of output but no usage reply.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].child.stdin.ended, true);
});

test('spawn faults are UNKNOWN, and nothing is thrown', async () => {
  const throwing = () => { throw Object.assign(new Error('boom'), { code: 'EACCES' }); };
  const thrown = await probe(throwing);
  assert.equal(thrown.reason, UNKNOWN_REASON.SPAWN_FAILED);
  assert.equal(thrown.detail, 'The Claude CLI could not be started (EACCES).');

  const errored = fakeSpawn(() => ({ error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }));
  const missing = await probe(errored.spawnImpl);
  assert.equal(missing.reason, UNKNOWN_REASON.SPAWN_FAILED);
  assert.equal(missing.detail, 'The Claude CLI could not be started (ENOENT).');

  const nothing = await probe(() => undefined);
  assert.equal(nothing.reason, UNKNOWN_REASON.SPAWN_FAILED);
});

test('without an isolated scratch folder the probe does not run at all', async () => {
  let spawned = false;
  const result = await probe(() => { spawned = true; }, {
    fsImpl: { mkdtempSync: () => { throw Object.assign(new Error('no scratch'), { code: 'EROFS' }); }, rmSync() {} }
  });
  assert.equal(result.reason, UNKNOWN_REASON.SCRATCH_UNAVAILABLE);
  assert.equal(result.detail, 'An empty working folder could not be created (EROFS).');
  assert.equal(spawned, false);
});

test('without an account home there is nothing to spawn', async () => {
  let spawned = false;
  for (const configDir of [null, undefined, '', '   ', 42]) {
    const result = await claudeUsageProbe({ configDir, spawnImpl: () => { spawned = true; }, executable: EXECUTABLE, baseEnvironment: { PATH: 'p' } });
    assert.equal(result.reason, UNKNOWN_REASON.CONFIG_DIR_INVALID, `configDir ${String(configDir)}`);
  }
  assert.equal(spawned, false);
});

test('a refused launch environment is UNKNOWN rather than an exception', async () => {
  // A billing credential the scrub cannot remove is the tripwire's own case;
  // the probe must answer, not throw, when the scrub throws.
  let spawned = false;
  const result = await claudeUsageProbe({
    configDir: CONFIG_DIR,
    spawnImpl: () => { spawned = true; },
    executable: EXECUTABLE,
    baseEnvironment: Object.create(null, {
      PATH: { value: 'p', enumerable: true },
      // A getter that throws stands in for any scrub-time fault.
      ANTHROPIC_AUTH_TOKEN: { get() { throw Object.assign(new Error('unreadable'), { code: 'EFAULT' }); }, enumerable: true }
    })
  });
  assert.equal(result.status, 'UNKNOWN');
  assert.ok([UNKNOWN_REASON.ENVIRONMENT_REFUSED, UNKNOWN_REASON.FAULT].includes(result.reason), result.reason);
  assert.equal(spawned, false);
});


/* THE READER DECODES THE STREAM ONCE, NOT ONCE PER CHUNK.
 *
 * The reply is JSON on a pipe and arrives in whatever pieces the OS hands
 * over; the measured one is a few kilobytes, and the success test above
 * already splits it. `chunk.toString('utf8')` decodes each piece on its own,
 * so a character whose UTF-8 bytes straddle the boundary comes back as two
 * U+FFFD -- and the text at risk is the provider's own: the model display
 * name in `limits[].scope.model.display_name`, which usage-windows.js puts
 * straight into a window's `label` and the accounts menu shows.
 *
 * The split here is deliberate and exact: one byte into the two-byte sequence
 * for an accented letter, which is the case a per-chunk decode cannot
 * survive. Run against the reader as it was, this fixture returned a label
 * with two replacement characters where the letter had been. */
test('a character split across two stdout chunks is decoded whole, so a window label is not torn in half', async () => {
  const MODEL = 'Café Model';
  const SPLIT_REPLY = {
    ...LIVE_REPLY,
    rate_limits: {
      ...LIVE_RATE_LIMITS,
      limits: LIVE_RATE_LIMITS.limits.map(limit => (limit.kind === 'weekly_scoped'
        ? { ...limit, scope: { model: { id: null, display_name: MODEL }, surface: null } }
        : limit))
    }
  };
  const { spawnImpl } = fakeSpawn(request => {
    const bytes = Buffer.from(`${controlResponse(request.request_id, SPLIT_REPLY)}\n`, 'utf8');
    const at = bytes.indexOf(Buffer.from('é', 'utf8')) + 1;
    assert.ok(at > 1, 'the fixture no longer carries the character this test is about');
    return { lines: [[bytes.subarray(0, at), bytes.subarray(at)]], exitCode: 0 };
  });

  const result = await probe(spawnImpl);
  assert.equal(result.status, 'MEASURED', result.reason);
  const scoped = result.limits.find(limit => limit.kind === 'weekly_scoped');
  assert.equal(scoped.model, MODEL, 'the provider\'s own text came back changed');
  const windows = claudeWindows(result);
  assert.equal(windows.weekly.label, `weekly_scoped · ${MODEL}`);
  assert.ok(!windows.weekly.label.includes('�'),
    'the label carries a replacement character, so the stream was decoded chunk by chunk');
});
// -- the credential fence, asserted against the source -----------------------

test('the module can read no file and names no sign-in', () => {
  const code = fs.readFileSync(PROBE_SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const forbidden of [
    'readFileSync', 'readFile', 'createReadStream', 'openSync', 'readSync', 'readdirSync',
    'writeFileSync', 'copyFileSync', 'keychain', 'keytar',
    'auth.json', '.credentials', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'
  ]) {
    assert.ok(!code.includes(forbidden),
      `claude-usage-probe.js contains ${forbidden}. It asks the CLI and must never touch a file or a sign-in.`);
  }
  assert.ok(code.includes("safeLaunchEnvironment(baseEnvironment, { context: 'claude usage probe' })"),
    'the probe must run under the one shared scrub');
  assert.ok(code.includes('windowsHide: true'), 'the CLI must never flash a console');
  assert.ok(code.includes('shell: false'));
  assert.ok(code.includes('delete env.CLAUDECODE;'), 'the nested-session marker must be removed by name');
  assert.ok(!/--print|--bare/.test(code), 'no prompt is ever sent, and --bare would bill a metered key');
  assert.equal(PROBE_ARGS.includes('-p'), true);
  assert.equal(PROBE_ARGS.some(arg => /^[^-]/.test(arg) && !['stream-json'].includes(arg)), false,
    'no positional argument: a prompt on the command line would be a user turn');
});
