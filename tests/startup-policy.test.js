// EXECUTABLE CHANGE
//
// Test-can-fail report (testcanfail-tests-startup-policy-test-js)
// Strengthened assertions and mutation evidence:
// - "the registrar census is non-empty": temporarily moved every tools/*.ps1
//   registrar out of the product tree. RED output:
//     FAIL the registrar census is non-empty
//          no top-level PowerShell registrars were found, so the registrar policy checks would pass vacuously
// - "the wired registrar census is non-empty": temporarily renamed every
//   New-ToolsEnabledTaskTriggers call in tools/*.ps1. Before this assertion was
//   added, both assertions over `wired` stayed green because `wired` was empty.
//   RED output after the fix:
//     FAIL the wired registrar census is non-empty
//          no registrar calls New-ToolsEnabledTaskTriggers, so the helper-wiring checks would pass vacuously
// Every temporarily mutated registrar was restored byte-for-byte (73/73 SHA-256
// checks passed). The restored run quoted both strengthened checks as green:
//     ok  the registrar census is non-empty
//     ok  the wired registrar census is non-empty
// The full restored file could not be green in this Linux environment because
// its required Windows PowerShell executable is unavailable; the named
// precondition failure is:
//     spawnSync C:\Windows/System32/WindowsPowerShell/v1.0/powershell.exe ENOENT
// Shape census:
// - EMPTY LOOP/COLLECTION: FIXED for the two self-selecting `wired` assertions;
//   the two-element keeper/rendezvous loop is intrinsically non-empty, and the
//   onDemand loop already has an explicit `onDemand.length > 0` assertion.
// - EXIT STATUS/TRUTHY RETURN: NOT-FOUND. execFileSync output is asserted; no
//   assertion treats a non-zero child exit or a truthy child return as evidence.
// - SWALLOWED FAILURE: NOT-FOUND. try/finally blocks only clean temporary files;
//   `check` records caught failures and sets a failing process exit code.
// - MOCK OF SUBJECT: NOT-FOUND. This file uses repository files and PowerShell,
//   with no mocks of the startup policy.
// - SKIP/PRECONDITION GUARD: NOT-FOUND. There are no skips or platform guards;
//   the missing Windows executable fails loudly rather than making a no-op.
// - SAME-CODE EXPECTATION: NOT-FOUND. Expected trigger class names, booleans,
//   registry values, and source patterns are independent constants.
'use strict';
// startup.services_at_logon -- the switch that decides whether ToolsEnabled
// starts when the computer does (owner directive 2026-08-13: "toolsenabled
// should startup on start if a user chooses that setting. i dont." and "dont
// hardcode it its a setting").
//
// The regression this file exists to prevent is not subtle and it already
// happened once: sixteen registrars each carried their own
//
//     (New-ScheduledTaskTrigger -AtStartup),
//     (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
//
// so the answer to "does this start with Windows" was copied, not decided. A
// seventeenth registrar written by copying its neighbour puts it straight back,
// and nothing would have failed. So the structural checks below are as much the
// point as the behavioural ones.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const HELPER = path.join(TOOLS, 'lib', 'StartupPolicy.ps1');
const SETTING_ID = 'startup.services_at_logon';
const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

let passed = 0;
const failures = [];
function check(description, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${description}`); }
  catch (error) { failures.push({ description, error }); console.log(`  FAIL ${description}\n       ${error && error.message}`); }
}

console.log('startup-policy');

// ---- the switch is declared, and declared as OFF -----------------------------
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'settings-registry.json'), 'utf8'));
const entry = registry.entries.find(e => e.id === SETTING_ID);

check('the switch exists in the settings registry', () => {
  assert.ok(entry, `${SETTING_ID} is absent from config/settings-registry.json`);
});

check('it is a toggle and it defaults to OFF', () => {
  assert.strictEqual(entry.control, 'toggle');
  // The default is the whole point. A default of true would mean the product
  // still starts itself on a machine whose owner never chose that.
  assert.strictEqual(entry.default, false, 'default must be false: nothing starts with Windows unless asked');
});

check('it names what enforces it and where it came from', () => {
  assert.ok(String(entry.enforcedBy || '').trim(), 'enforcedBy must not be empty: an unenforced toggle is a lie');
  assert.ok(String(entry.derivedFrom || '').trim(), 'derivedFrom must not be empty');
});

check('it carries a human-readable title', () => {
  assert.ok(String(registry.titles[SETTING_ID] || '').trim(), `titles is missing ${SETTING_ID}`);
});

// ---- no registrar may name a startup trigger itself --------------------------
const registrars = fs.readdirSync(TOOLS)
  .filter(name => name.endsWith('.ps1'))
  .map(name => ({ name, text: fs.readFileSync(path.join(TOOLS, name), 'utf8') }));

check('the registrar census is non-empty', () => {
  assert.ok(registrars.length > 0,
    'no top-level PowerShell registrars were found, so the registrar policy checks would pass vacuously');
});

const LITERAL = /New-ScheduledTaskTrigger\s+-At(?:Startup|LogOn)/;

check('no registrar under tools/ hardcodes AtStartup or AtLogOn', () => {
  const offenders = registrars.filter(f => LITERAL.test(f.text)).map(f => f.name);
  assert.deepStrictEqual(offenders, [],
    `these name a startup trigger directly instead of asking the switch: ${offenders.join(', ')}`);
});

check('tools/lib/StartupPolicy.ps1 is the single place that names them', () => {
  const helper = fs.readFileSync(HELPER, 'utf8');
  const live = helper.split(/\r?\n/).filter(line => !line.trim().startsWith('#') && LITERAL.test(line));
  assert.ok(live.length > 0, 'the helper should be the one file that builds these triggers');
});

const wired = registrars.filter(f => /New-ToolsEnabledTaskTriggers/.test(f.text));

check('the wired registrar census is non-empty', () => {
  assert.ok(wired.length > 0,
    'no registrar calls New-ToolsEnabledTaskTriggers, so the helper-wiring checks would pass vacuously');
});

check('every registrar that builds triggers dot-sources the helper', () => {
  const missing = wired.filter(f => !/StartupPolicy\.ps1/.test(f.text)).map(f => f.name);
  assert.deepStrictEqual(missing, [], `call the helper without loading it: ${missing.join(', ')}`);
});

check('every wired registrar also makes the task Enabled state follow the switch', () => {
  // Dropping the boot/sign-in triggers is NOT sufficient on its own: these tasks
  // also carry a repetition trigger with -StartWhenAvailable, which restarts the
  // service within minutes of a boot regardless. Registering disabled is what
  // actually honours the switch.
  const missing = wired.filter(f => !/Test-ToolsEnabledTaskShouldBeEnabled/.test(f.text)).map(f => f.name);
  assert.deepStrictEqual(missing, [], `gate triggers but not runnability: ${missing.join(', ')}`);
});

// ---- the helper actually behaves that way ------------------------------------
function triggerClassesWith(settingsDocument, extraArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-startup-'));
  const valuesPath = path.join(dir, 'settings.json');
  if (settingsDocument !== null) fs.writeFileSync(valuesPath, JSON.stringify(settingsDocument));
  const script = `
    . '${HELPER.replace(/'/g, "''")}'
    $env:USERDOMAIN = 'WORKGROUP'
    $env:USERNAME = 'synthetic-missing-task-owner'
    $rep = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 9999)
    $t = New-ToolsEnabledTaskTriggers -Repeating $rep ${extraArgs}
    $names = @($t | ForEach-Object { $_.CimClass.CimClassName })
    $logon = @($t | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })
    $ownerMatches = $logon.Count -eq 0 -or $logon[0].UserId -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    "$($names -join ',')|$(Test-ToolsEnabledTaskShouldBeEnabled)|$ownerMatches"
  `;
  try {
    const out = execFileSync(POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        encoding: 'utf8', timeout: 90000, windowsHide: true, shell: false,
        env: Object.assign({}, process.env, { TOOLSENABLED_SETTINGS_PATH: valuesPath })
      });
    const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop() || '';
    const [names, enabled, ownerMatches] = line.split('|');
    assert.equal(ownerMatches, 'True', 'logon triggers belong to the actual token owner despite misleading environment names');
    return { classes: (names || '').split(',').filter(Boolean), enabled: String(enabled).trim() === 'True' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function storedSwitch(value) {
  return {
    revision: 1,
    values: { [SETTING_ID]: value },
    provenance: { [SETTING_ID]: { source: 'user', atMs: 0, directive: null } }
  };
}

check('OFF (the default): no boot trigger, no sign-in trigger, and the task is not runnable', () => {
  const result = triggerClassesWith(null, '-IncludeStartup -IncludeLogon');
  assert.ok(!result.classes.includes('MSFT_TaskBootTrigger'), `boot trigger survived: ${result.classes}`);
  assert.ok(!result.classes.includes('MSFT_TaskLogonTrigger'), `sign-in trigger survived: ${result.classes}`);
  assert.ok(result.classes.includes('MSFT_TaskTimeTrigger'), 'the cadence trigger must remain');
  assert.strictEqual(result.enabled, false, 'with the switch off the task must be registered disabled');
});

check('ON: boot and sign-in triggers come back and the task is runnable', () => {
  const result = triggerClassesWith(storedSwitch(true), '-IncludeStartup -IncludeLogon');
  assert.ok(result.classes.includes('MSFT_TaskBootTrigger'), `boot trigger missing: ${result.classes}`);
  assert.ok(result.classes.includes('MSFT_TaskLogonTrigger'), `sign-in trigger missing: ${result.classes}`);
  assert.strictEqual(result.enabled, true);
});

check('ON without -IncludeLogon adds no sign-in trigger the caller never had', () => {
  // logs-retention-task.ps1 registers AtStartup and no sign-in trigger. A helper
  // that always added -AtLogOn would give it a trigger it never had, so turning
  // the switch on would change more than the switch claims to.
  const result = triggerClassesWith(storedSwitch(true), '-IncludeStartup');
  assert.ok(result.classes.includes('MSFT_TaskBootTrigger'));
  assert.ok(!result.classes.includes('MSFT_TaskLogonTrigger'), `unrequested sign-in trigger: ${result.classes}`);
});

// ON-DEMAND: the second task shape. No cadence trigger, and with the switch off
// no trigger at all -- so Windows can never launch it and only an explicit
// Start-ScheduledTask (i.e. a person pressing a feature's ON control) can. That
// is what lets it stay ENABLED without contradicting the switch, and it is what
// makes "the direct link stays on until the user turns it off" implementable
// without exempting anything from the switch.
function onDemandWith(settingsDocument, extraArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-startup-od-'));
  const valuesPath = path.join(dir, 'settings.json');
  if (settingsDocument !== null) fs.writeFileSync(valuesPath, JSON.stringify(settingsDocument));
  // ASSIGN, THEN COUNT -- exactly as the registrars do. Wrapping the CALL in
  // @( ) reports 1 for an empty set, because the helper returns ,$triggers and
  // @( ) then collects that single pipeline object. Measuring it the wrong way
  // here would have hidden the bug it is meant to catch.
  const script = `
    . '${HELPER.replace(/'/g, "''")}'
    $t = New-ToolsEnabledTaskTriggers -OnDemand ${extraArgs}
    $names = @($t | ForEach-Object { $_.CimClass.CimClassName })
    "$($names -join ',')|$(Test-ToolsEnabledTaskShouldBeEnabled -OnDemand)|$(@($t).Count)"
  `;
  try {
    const out = execFileSync(POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        encoding: 'utf8', timeout: 90000, windowsHide: true, shell: false,
        env: Object.assign({}, process.env, { TOOLSENABLED_SETTINGS_PATH: valuesPath })
      });
    const line = String(out).trim().split(/\r?\n/).filter(Boolean).pop() || '';
    const [names, enabled, count] = line.split('|');
    return {
      classes: (names || '').split(',').filter(Boolean),
      enabled: String(enabled).trim() === 'True',
      count: Number(String(count).trim())
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

check('on-demand, switch OFF: no trigger at all, and the task stays startable', () => {
  const result = onDemandWith(null, '-IncludeLogon');
  assert.strictEqual(result.count, 0, `an on-demand task must get NO trigger with the switch off, got: ${result.classes}`);
  // The empty-set fallback that keeps cadence-driven registrars valid must NOT
  // apply here: handing this shape a sign-in trigger would make it self-start
  // with the switch off, which is the one thing this file exists to prevent.
  assert.ok(!result.classes.includes('MSFT_TaskLogonTrigger'), 'the fallback sign-in trigger must be suppressed');
  assert.strictEqual(result.enabled, true, 'enabled means startable, not self-starting: disabling it would break the ON press while protecting against nothing');
});

check('on-demand, switch ON: the sign-in trigger comes back like any other task', () => {
  const result = onDemandWith(storedSwitch(true), '-IncludeLogon');
  assert.ok(result.classes.includes('MSFT_TaskLogonTrigger'), `sign-in trigger missing: ${result.classes}`);
  assert.ok(!result.classes.includes('MSFT_TaskTimeTrigger'), 'an on-demand task never gets a cadence trigger');
  assert.strictEqual(result.enabled, true);
});

check('on-demand never asks for a boot trigger it was not given', () => {
  // The two direct-link tasks deliberately ask for -IncludeLogon only: they
  // reach the DPAPI vault, and user-scope DPAPI is unavailable to an S4U task
  // before the first interactive sign-in.
  const result = onDemandWith(storedSwitch(true), '-IncludeLogon');
  assert.ok(!result.classes.includes('MSFT_TaskBootTrigger'), `unrequested boot trigger: ${result.classes}`);
});

check('the FRA keeper and the rendezvous both register as on-demand, with no cadence trigger', () => {
  // The regression this pins: the keeper carried a 2-minute repetition, which is
  // a startup trigger in disguise (StartWhenAvailable re-arms it after a boot),
  // so honouring the switch meant registering it DISABLED -- and a disabled
  // keeper never starts FRA at all. The listener only survived because someone
  // had enabled the task by hand, and the next run of the registrar or of
  // apply-startup-policy.ps1 would have switched FRA off for good.
  const keeper = fs.readFileSync(path.join(ROOT, 'tools', 'fra-keeper-task.ps1'), 'utf8');
  assert.match(keeper, /New-ToolsEnabledTaskTriggers -OnDemand -IncludeLogon/);
  assert.ok(!/-RepetitionInterval/.test(keeper), 'the keeper must not carry a cadence trigger');
  assert.match(keeper, /Test-ToolsEnabledTaskShouldBeEnabled -OnDemand/);
  assert.match(keeper, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/, 'a resident loop must not be killed by a time limit');
  assert.match(keeper, /--resident/, 'the task must drive the resident loop');

  const engine = fs.readFileSync(path.join(ROOT, 'packages', 'servercontrol', 'Mechanical-Connect.ps1'), 'utf8');
  assert.match(engine, /New-ToolsEnabledTaskTriggers -OnDemand -IncludeLogon/);

  // Both must omit -Trigger entirely when the set is empty, because
  // Register-ScheduledTask rejects an empty one.
  for (const [name, text] of [['keeper', keeper], ['rendezvous', engine]]) {
    assert.ok(/Count -gt 0/.test(text) && /\['Trigger'\]/.test(text),
      `${name} must omit -Trigger when the on-demand trigger set is empty`);

    // AND THEY MUST MEASURE IT BY ASSIGNING FIRST. `@(New-ToolsEnabledTaskTriggers ...)`
    // around the call reports 1 for an empty set -- the helper returns ,$triggers,
    // so the empty array survives as one pipeline object and @( ) collects it --
    // which would pass Register-ScheduledTask an empty -Trigger and make
    // registration fail on exactly the machines where the startup switch is off,
    // i.e. every machine by default. This was a real bug in the rendezvous
    // registrar, caught only because the test measured it the same wrong way.
    assert.ok(!/\$triggers\s*=\s*@\(New-ToolsEnabledTaskTriggers/.test(text),
      `${name} must assign the trigger set before counting it, not wrap the call in @( )`);
  }
});

check('apply-startup-policy exempts on-demand tasks instead of disabling them', () => {
  const applier = fs.readFileSync(path.join(ROOT, 'tools', 'apply-startup-policy.ps1'), 'utf8');
  assert.match(applier, /onDemand/, 'the sweep must know about the registry onDemand flag');
  assert.match(applier, /\$onDemandTasks/);
  // It reuses the registry's existing flag rather than inventing a second word:
  // uac-delegation-helper has carried onDemand since before this concept existed,
  // and that task was being disabled by this sweep -- which would have broken
  // every elevated request.
  //
  // This used to assert on a `fra-keeper` entry with declaredArgv ['--resident'].
  // That entry is not in config/managed-processes.json and never has been: the
  // committed file is the SHIPPED DEFAULT registry, which declares only the four
  // subsystems a fresh installation can reach and leaves declaredArgv empty
  // everywhere on purpose (see its own $comment). The old assertion was written
  // against the builder's untracked local registry, so it could be satisfied
  // only by committing that copy -- which carries two real Windows account names
  // and a real cloud project id. It pinned a fixture, not a behaviour.
  //
  // What the sweep actually promises is flag-driven exemption, so that is what
  // is checked here, against whatever the registry declares.
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'managed-processes.json'), 'utf8'));
  const entries = Object.entries(registry.processes);
  const onDemand = entries.filter(([, entry]) => entry.onDemand === true);
  assert.ok(onDemand.length > 0,
    'no registry entry declares onDemand, so the exemption branch in the sweep is dead code that nothing exercises');

  // The documented real case: this task is on-demand and must survive the sweep.
  assert.strictEqual(registry.processes['uac-delegation-helper'].onDemand, true,
    'uac-delegation-helper is the task whose disabling broke every elevated request');

  // The sweep keys its exemption set by taskName ($onDemandTasks[$name]), and
  // only adds a name when it is truthy. An on-demand entry carrying no taskName
  // would therefore fall through and be DISABLED -- silently, because the sweep
  // reports it as an ordinary task. Every on-demand entry must be addressable.
  for (const [id, entry] of onDemand) {
    assert.ok(typeof entry.taskName === 'string' && entry.taskName.length > 0,
      `on-demand entry "${id}" has no taskName, so the sweep cannot exempt it and will disable it`);
  }
});

check('a stored true with NO provenance is rejected, exactly as src/lib/settings.js rejects it', () => {
  // Two readers of one switch that disagree about what counts as a value is the
  // same bug as not having the switch.
  const result = triggerClassesWith({ revision: 1, values: { [SETTING_ID]: true } }, '-IncludeStartup -IncludeLogon');
  assert.ok(!result.classes.includes('MSFT_TaskBootTrigger'), 'a value with no provenance must not turn autostart on');
  assert.strictEqual(result.enabled, false);
});

check('an unreadable settings file falls back to OFF, never to ON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-startup-bad-'));
  const valuesPath = path.join(dir, 'settings.json');
  fs.writeFileSync(valuesPath, '{ this is not json');
  try {
    const out = execFileSync(POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `. '${HELPER.replace(/'/g, "''")}'; Test-ToolsEnabledStartsAtLogon`],
      {
        encoding: 'utf8', timeout: 90000, windowsHide: true, shell: false,
        env: Object.assign({}, process.env, { TOOLSENABLED_SETTINGS_PATH: valuesPath })
      });
    assert.strictEqual(String(out).trim(), 'False', 'a broken settings file must never read as "start with Windows"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('the helper never sets StrictMode, which would leak into all 18 callers', () => {
  const helper = fs.readFileSync(HELPER, 'utf8');
  const live = helper.split(/\r?\n/).filter(line => !line.trim().startsWith('#'));
  assert.ok(!live.some(line => /Set-StrictMode/.test(line)),
    'Set-StrictMode is scoped to the caller, so a dot-sourced library must not set it');
});

console.log(`\nstartup-policy: ${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`FAILED: ${failure.description}\n${failure.error && failure.error.stack}`);
  process.exitCode = 1;
}
