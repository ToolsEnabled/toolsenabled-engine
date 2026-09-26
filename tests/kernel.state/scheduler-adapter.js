// EXECUTABLE CHANGE
//
// Discriminating-assertion audit:
// - SAME-CODE EXPECTATION: legacyXml used legacyRunnerArguments, the function whose
//   output inspectLegacyXml validates. Mutating legacyRunnerArguments to append
//   `--mutant` stayed green: "scheduler adapter tests passed". The fixture now
//   spells out the independently expected command line. Under the same mutation it
//   goes red with: "AssertionError [ERR_ASSERTION]: Expected values to be strictly
//   equal: + actual - expected; + 'foreign'; - 'present'".
// - NOT-FOUND: empty loop/forEach; exit-status/truthy-return-only evidence;
//   swallowed failure via try/catch or optional chaining; assertion against a mock
//   of the subject; platform skip or silently disabling precondition.
// - RESTORATION: src/lib/scheduler-adapter.js was restored byte-for-byte (SHA-256
//   before/after 0aac4b2e9867bf3adaaf92270919d96b69ba511c59f7dc243fff1a668f52ca8c).
//   Restored run: "scheduler adapter tests passed". Unmet preconditions: none.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SchedulerAdapterError,
  TASK_NOT_FOUND_HRESULT,
  buildTaskXml,
  createWindowsSchedulerAdapter,
  inspectLegacyXml,
  inspectXml,
  resolveCurrentPrincipalIdentity,
  resolveCurrentPrincipalId,
  resolveCurrentPrincipalName,
  runnerArguments,
  unsignedStatus
} = require('../../src/lib/scheduler-adapter');
const { SCHEDULER_RUN_RECOVERY_MS, SCHEDULER_TASK_EXECUTION_LIMIT } = require('../../src/lib/scheduler-constants');

const FIXTURE_NODE_PATH = path.join(os.tmpdir(), 'fixture-runtime', 'Program Files', 'nodejs', 'node.exe');
const FIXTURE_RUNNER_PATH = path.join(os.tmpdir(), 'fixture-runtime', 'Tools Enabled', 'src', 'job-runner.js');
const FIXTURE_DRIVE_ROOT = path.parse(FIXTURE_RUNNER_PATH).root;

const roots = [];
function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-scheduler-adapter-'));
  roots.push(root);
  return root;
}

function spec(overrides = {}) {
  return {
    version: 1,
    installationId: 'a'.repeat(32),
    jobId: 'scheduler-job-test',
    generation: 3,
    taskName: '\\ToolsEnabled-v2-aaaaaaaaaaaa-c33bbbe86cda8f92-g3',
    ownershipMarker: 'c'.repeat(64),
    nodePath: FIXTURE_NODE_PATH,
    runnerPath: FIXTURE_RUNNER_PATH,
    principalId: 'S-1-5-21-111111111-222222222-333333333-1001',
    schedule: 'minutes',
    intervalMinutes: 7,
    ...overrides
  };
}

function legacySpec(overrides = {}) {
  const registrationDate = '2026-07-22T20:16:32';
  return {
    name: 'legacy-owner', taskName: '\\ToolsEnabled-legacy-owner',
    nodePath: FIXTURE_NODE_PATH,
    runnerPath: FIXTURE_RUNNER_PATH,
    principalId: 'S-1-5-21-111111111-222222222-333333333-1001',
    principalName: 'DESKTOP\\owner', createdAtMs: Date.parse(registrationDate) - 2_000,
    schedule: 'hourly', registrationDate, ...overrides
  };
}

function legacyXml(input) {
  const task = legacySpec(input);
  const trigger = task.schedule === 'daily'
    ? `<CalendarTrigger><StartBoundary>${task.registrationDate.slice(0, 10)}T00:05:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`
    : `<TimeTrigger><StartBoundary>${task.registrationDate.slice(0, 16)}:00</StartBoundary><Repetition><Interval>PT1H</Interval></Repetition></TimeTrigger>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Date>${task.registrationDate}</Date><Author>${task.principalName}</Author><URI>${task.taskName}</URI></RegistrationInfo>
  <Triggers>${trigger}</Triggers>
  <Principals><Principal id="Author"><UserId>${task.principalId}</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals>
  <Settings><DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>true</StopIfGoingOnBatteries><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><IdleSettings><Duration>PT10M</Duration><WaitTimeout>PT1H</WaitTimeout><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings></Settings>
  <Actions Context="Author"><Exec><Command>/d</Command><Arguments>/s /c ""${task.nodePath}" "${task.runnerPath}" "${task.name}""</Arguments></Exec></Actions>
</Task>`;
}

function response(status, stdout = '', stderr = '') { return { status, stdout, stderr }; }
function notFound() { return response(TASK_NOT_FOUND_HRESULT | 0, '', 'localized detail'); }

function fakeAdapter(steps) {
  const calls = [];
  const root = temporary();
  const adapter = createWindowsSchedulerAdapter({
    tempRoot: root,
    run(command, args) {
      calls.push({ command, args: [...args], xml: args.includes('/xml') && args[0] === '/create' ? fs.readFileSync(args[args.indexOf('/xml') + 1], 'utf16le') : null });
      assert.ok(steps.length, `Unexpected scheduler command: ${args.join(' ')}`);
      const step = steps.shift();
      if (typeof step === 'function') return step(command, args, calls.at(-1));
      return step;
    }
  });
  return { adapter, calls, root, steps };
}

try {
  const task = spec();
  const xml = buildTaskXml(task);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<UserId>S-1-5-21-/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.doesNotMatch(xml, /SYSTEM/i);
  assert.match(xml, /<Interval>PT7M<\/Interval>/);
  assert.match(xml, /<TimeTrigger>/);
  assert.doesNotMatch(xml, /<CalendarTrigger>/);
  assert.match(xml, /<ExecutionTimeLimit>PT23H<\/ExecutionTimeLimit>/);
  assert.equal(SCHEDULER_TASK_EXECUTION_LIMIT, 'PT23H');
  assert.ok(SCHEDULER_RUN_RECOVERY_MS > 23 * 60 * 60 * 1000);
  assert.match(xml, /<UseUnifiedSchedulingEngine>true<\/UseUnifiedSchedulingEngine>/);
  assert.equal(inspectXml(xml, task).state, 'present');
  const serviceNormalized = xml
    .replace('      <Enabled>true</Enabled>\n', '')
    .replace('      <RunLevel>LeastPrivilege</RunLevel>\n', '')
    .replace('    <AllowHardTerminate>true</AllowHardTerminate>\n', '')
    .replace('    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n', '')
    .replace('    <AllowStartOnDemand>true</AllowStartOnDemand>\n', '')
    .replace('    <Enabled>true</Enabled>\n', '')
    .replace('    <Hidden>false</Hidden>\n', '')
    .replace('    <RunOnlyIfIdle>false</RunOnlyIfIdle>\n', '')
    .replace('    <WakeToRun>false</WakeToRun>\n', '')
    .replace('    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>\n', '')
    .replace('    <Priority>7</Priority>\n', '');
  assert.equal(inspectXml(serviceNormalized, task).state, 'present', 'Windows may omit fields whose defaults equal the requested semantics.');
  assert.equal(inspectXml(xml.replace('PT7M', 'PT8M'), task).state, 'owned-drift');
  assert.equal(inspectXml(xml.replace('<StartBoundary>2000-01-01T00:05:00</StartBoundary>', '<StartBoundary>2000-01-02T00:05:00</StartBoundary>'), task).state, 'owned-drift');
  const daily = spec({ schedule: 'daily', intervalMinutes: null });
  const dailyXml = buildTaskXml(daily);
  assert.match(dailyXml, /<CalendarTrigger>/);
  assert.doesNotMatch(dailyXml, /<TimeTrigger>/);
  assert.equal(inspectXml(dailyXml, daily).state, 'present');
  assert.equal(inspectXml(dailyXml.replace('<DaysInterval>1</DaysInterval>', '<DaysInterval>2</DaysInterval>'), daily).state, 'owned-drift');
  assert.equal(inspectXml(xml.replace('<Enabled>true</Enabled>\n    <Hidden>', '<Enabled>false</Enabled>\n    <Hidden>'), task).state, 'owned-drift');
  assert.equal(inspectXml(xml.replace('</Triggers>', '<CalendarTrigger><StartBoundary>2000-01-01T00:05:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>'), task).state, 'owned-drift');
  assert.equal(inspectXml(xml.replace('</Actions>', `<Exec><Command>${task.nodePath}</Command><Arguments>unexpected</Arguments><WorkingDirectory>${FIXTURE_DRIVE_ROOT}</WorkingDirectory></Exec></Actions>`), task).state, 'owned-drift');
  assert.equal(inspectXml(xml.replace('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>'), task).state, 'owned-drift');
  assert.equal(inspectXml(xml.replace(task.ownershipMarker, 'd'.repeat(64)), task).state, 'foreign');
  assert.ok(runnerArguments(task).startsWith(`"${task.runnerPath}" --installation-id `));
  assert.equal(unsignedStatus(-2147024894), TASK_NOT_FOUND_HRESULT);
  assert.equal(resolveCurrentPrincipalId({ run: () => response(0, '"DESKTOP\\user","S-1-5-21-1-2-3-1001"\r\n') }), 'S-1-5-21-1-2-3-1001');
  assert.equal(resolveCurrentPrincipalName({ run: () => response(0, '"DESKTOP\\user","S-1-5-21-1-2-3-1001"\r\n') }), 'DESKTOP\\user');
  assert.deepEqual(resolveCurrentPrincipalIdentity({ run: () => response(0, '"DESKTOP\\user","S-1-5-21-1-2-3-1001"\r\n') }), {
    principalName: 'DESKTOP\\user', principalId: 'S-1-5-21-1-2-3-1001'
  });
  assert.throws(() => resolveCurrentPrincipalId({ run: () => response(5, '', 'denied') }), /could not be resolved/);
  assert.throws(() => buildTaskXml(spec({ intervalMinutes: 1440 })), /1 through 1439/);
  assert.throws(() => buildTaskXml(spec({ taskName: `\\${'x'.repeat(239)}` })), /238/);
  assert.throws(() => buildTaskXml(spec({ taskName: '\\ToolsEnabled-v2-aaaaaaaaaaaa-0000000000000000-g3' })), /deterministic name/);
  assert.throws(() => buildTaskXml(spec({ ownershipMarker: 'not-a-marker' })), /ownershipMarker/);
  assert.throws(() => buildTaskXml(spec({ jobId: 'foreign-job' })), /jobId/);
  assert.throws(() => buildTaskXml(spec({ principalId: 'DESKTOP\\user' })), /Windows SID/);

  const legacyHourly = legacySpec();
  const legacyHourlyXml = legacyXml(legacyHourly);
  const legacyDaily = legacySpec({ schedule: 'daily' });
  const legacyDailyXml = legacyXml(legacyDaily);
  assert.equal(inspectLegacyXml(legacyHourlyXml, legacyHourly).state, 'present');
  assert.equal(inspectLegacyXml(legacyDailyXml, legacyDaily).state, 'present');
  assert.match(inspectLegacyXml(legacyHourlyXml, legacyHourly).evidenceHash, /^[a-f0-9]{64}$/);
  for (const tampered of [
    legacyHourlyXml.replace('job-runner.js', 'other-runner.js'),
    legacyHourlyXml.replace(legacyHourly.principalId, 'S-1-5-21-111111111-222222222-333333333-1002'),
    legacyHourlyXml.replace(legacyHourly.principalName, 'DESKTOP\\someone-else'),
    legacyHourlyXml.replace(legacyHourly.registrationDate, '2026-07-22T20:30:32'),
    legacyHourlyXml.replace('PT1H', 'PT2H'),
    legacyHourlyXml.replace('</Actions>', '<Exec><Command>/d</Command><Arguments>extra</Arguments></Exec></Actions>'),
    legacyHourlyXml.replace('</Exec>', `<WorkingDirectory>${FIXTURE_DRIVE_ROOT}</WorkingDirectory></Exec>`),
    legacyHourlyXml.replace('</Task>', '<Data>foreign</Data></Task>')
  ]) assert.equal(inspectLegacyXml(tampered, legacyHourly).state, 'foreign');
  assert.throws(() => inspectLegacyXml(legacyHourlyXml, { ...legacyHourly, createdAtMs: undefined }), /createdAtMs/);

  {
    const fake = fakeAdapter([notFound(), response(0, xml)]);
    assert.equal(fake.adapter.inspect(task).state, 'absent');
    assert.equal(fake.adapter.inspect(task).state, 'present');
    assert.deepEqual(fake.calls.map(call => call.args.slice(0, 2)), [['/query', '/tn'], ['/query', '/tn']]);
  }

  {
    const fake = fakeAdapter([response(-2147024891, '', 'access denied')]);
    assert.equal(fake.adapter.inspect(task).state, 'unknown');
  }

  {
    const fake = fakeAdapter([() => { const error = new Error('timed out'); error.code = 'ETIMEDOUT'; throw error; }]);
    const observed = fake.adapter.inspect(task);
    assert.equal(observed.state, 'unknown');
    assert.equal(observed.commandErrorCode, 'ETIMEDOUT');
  }

  {
    const mutations = [];
    const fake = fakeAdapter([
      notFound(),
      (command, args, call) => {
        assert.equal(command, 'schtasks.exe');
        assert.deepEqual(args.slice(0, 3), ['/create', '/tn', task.taskName]);
        assert.equal(args.includes('/f'), false, 'Immutable task creation must never overwrite an existing task.');
        assert.equal(inspectXml(call.xml, task).state, 'present');
        return response(5, '', 'ambiguous create result');
      },
      response(0, xml)
    ]);
    const result = fake.adapter.ensure(task, { beforeMutation: event => mutations.push(event.operation) });
    assert.equal(result.changed, true);
    assert.equal(result.observation.state, 'present', 'Observed exact state wins over an ambiguous command status.');
    assert.deepEqual(mutations, ['create']);
    assert.deepEqual(fs.readdirSync(fake.root), [], 'Temporary task XML is removed after the command.');
  }

  {
    const fake = fakeAdapter([
      notFound(),
      () => { const error = new Error('create timed out'); error.code = 'ETIMEDOUT'; throw error; },
      response(0, xml)
    ]);
    const result = fake.adapter.ensure(task, { beforeMutation() {} });
    assert.equal(result.observation.state, 'present', 'A thrown create is inspected before its outcome is classified.');
  }

  {
    const fake = fakeAdapter([notFound()]);
    assert.throws(() => fake.adapter.ensure(task, { beforeMutation() { throw new Error('audit unavailable'); } }), /audit unavailable/);
    assert.equal(fake.calls.length, 1, 'A failed pre-effect gate runs no mutation and needs no post-effect query.');
  }

  {
    const drifted = xml.replace('PT7M', 'PT8M');
    const mutations = [];
    const fake = fakeAdapter([
      response(0, drifted), response(0), notFound(), response(0), response(0, xml)
    ]);
    const result = fake.adapter.ensure(task, { beforeMutation: event => mutations.push(event.operation) });
    assert.equal(result.observation.state, 'present');
    assert.deepEqual(mutations, ['delete', 'create']);
    assert.deepEqual(fake.calls[1].args, ['/delete', '/tn', task.taskName, '/f', '/hresult']);
  }

  {
    const foreign = xml.replace(task.ownershipMarker, 'd'.repeat(64));
    const fake = fakeAdapter([response(0, foreign)]);
    assert.throws(() => fake.adapter.ensure(task), error => error instanceof SchedulerAdapterError && error.code === 'SCHEDULER_FOREIGN_TASK' && error.retryable === false);
    assert.equal(fake.calls.length, 1);
  }

  {
    const fake = fakeAdapter([response(-2147024891, '', 'denied')]);
    assert.throws(() => fake.adapter.ensure(task), error => error.code === 'SCHEDULER_INSPECTION_UNKNOWN' && error.uncertain === true);
    assert.equal(fake.calls.length, 1);
  }

  {
    const mutations = [];
    const fake = fakeAdapter([response(0, xml), response(5, '', 'ambiguous delete'), notFound()]);
    const result = fake.adapter.remove(task, { beforeMutation: event => mutations.push(event.operation) });
    assert.equal(result.observation.state, 'absent');
    assert.deepEqual(mutations, ['delete']);
  }

  {
    const legacyUnbound = { ...task };
    delete legacyUnbound.principalId;
    assert.throws(() => buildTaskXml(legacyUnbound), /principalId/, 'Principal-less legacy definitions can never be created.');
    const fake = fakeAdapter([]);
    assert.throws(() => fake.adapter.remove(legacyUnbound), /principalId/,
      'The strict adapter requires provider-side ephemeral principal enrichment even for deletion.');
  }

  {
    const fake = fakeAdapter([
      response(0, xml),
      () => { const error = new Error('delete timed out'); error.code = 'ETIMEDOUT'; throw error; },
      notFound()
    ]);
    const result = fake.adapter.remove(task, { beforeMutation() {} });
    assert.equal(result.observation.state, 'absent', 'A thrown delete is inspected before its outcome is classified.');
  }

  {
    const foreign = xml.replace(task.ownershipMarker, 'd'.repeat(64));
    const fake = fakeAdapter([response(0, foreign)]);
    assert.throws(() => fake.adapter.remove(task), error => error.code === 'SCHEDULER_FOREIGN_TASK' && error.retryable === false);
    assert.equal(fake.calls.length, 1, 'A foreign task is never deleted.');
  }

  {
    const fake = fakeAdapter([response(0, xml), response(0), response(-2147024891, '', 'service unavailable')]);
    assert.throws(() => fake.adapter.remove(task), error => error.code === 'SCHEDULER_DELETE_UNCERTAIN' && error.uncertain === true);
  }

  {
    const fake = fakeAdapter([notFound()]);
    assert.equal(fake.adapter.removeLegacy(legacyHourly).changed, false);
    assert.equal(fake.calls.length, 1, 'An absent legacy task causes no mutation.');
  }

  {
    const intents = [];
    const fake = fakeAdapter([response(0, legacyHourlyXml), response(5, '', 'ambiguous delete'), notFound()]);
    const removed = fake.adapter.removeLegacy(legacyHourly, {
      beforeMutation: event => {
        assert.match(event.observation.evidenceHash, /^[a-f0-9]{64}$/);
        intents.push(event.operation);
      }
    });
    assert.equal(removed.changed, true);
    assert.deepEqual(intents, ['delete']);
    assert.deepEqual(fake.calls[1].args, ['/delete', '/tn', legacyHourly.taskName, '/f', '/hresult']);
  }

  {
    const foreign = legacyHourlyXml.replace('job-runner.js', 'foreign.js');
    const fake = fakeAdapter([response(0, foreign)]);
    assert.throws(() => fake.adapter.removeLegacy(legacyHourly), error => error.code === 'SCHEDULER_LEGACY_TASK_CONFLICT');
    assert.equal(fake.calls.length, 1, 'A legacy name alone never authorizes deletion.');
  }

  {
    const fake = fakeAdapter([response(0, legacyHourlyXml)]);
    assert.throws(() => fake.adapter.removeLegacy(legacyHourly, { beforeMutation() { throw new Error('audit unavailable'); } }), /audit unavailable/);
    assert.equal(fake.calls.length, 1, 'A failed durable intent prevents legacy deletion.');
  }

  {
    const fake = fakeAdapter([response(-2147024891, '', 'denied')]);
    assert.throws(() => fake.adapter.removeLegacy(legacyHourly), error => error.code === 'SCHEDULER_LEGACY_INSPECTION_UNKNOWN');
    assert.equal(fake.calls.length, 1);
  }

  {
    const changed = legacyHourlyXml.replace(legacyHourly.principalId, 'S-1-5-21-111111111-222222222-333333333-1002');
    const fake = fakeAdapter([response(0, legacyHourlyXml), response(0), response(0, changed)]);
    assert.throws(() => fake.adapter.removeLegacy(legacyHourly, { beforeMutation() {} }), error => error.code === 'SCHEDULER_LEGACY_OWNERSHIP_CHANGED');
  }

  process.stdout.write('scheduler adapter tests passed\n');
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
