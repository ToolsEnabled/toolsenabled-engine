'use strict';

// A WINDOWS SYSTEM BINARY NAMED WITHOUT A PATH IS WHOEVER PATH SAYS IT IS.
//
// MEASURED 2026-08-19. A 272-tool sweep driving the product's own tools found
// scheduler.list and scheduler.reconcile failing with the verbatim refusal
// "The current Windows user SID could not be resolved." That sentence is
// produced in exactly one place: scheduler-adapter.js's
// resolveCurrentPrincipalIdentity(), when `whoami.exe /user /fo csv /nh` exits
// non-zero.
//
// REPRODUCED, on this machine, in a shell whose PATH carries Git for Windows:
//
//     $ whoami.exe /user /fo csv /nh
//     whoami: extra operand '/user'
//     Try 'whoami --help' for more information.
//
// That is GNU coreutils' whoami, shipped by Git for Windows as
// <git>/usr/bin/whoami.exe, resolved ahead of C:\Windows\System32\whoami.exe
// because the call named the program without a path. It rejects the Windows
// switches and exits non-zero, which the adapter turns into
// SCHEDULER_IDENTITY_UNAVAILABLE.
//
// WHAT IS AND IS NOT CLAIMED HERE. It is proven that a PATH containing a
// shadowing whoami.exe produces this exact refusal. It is NOT claimed that
// this was the cause of the sweep's failure -- that would need the failing
// process's own PATH, which was not captured. The fix does not depend on
// which it was: naming a system binary without a path is wrong on any machine
// whose PATH has been reordered, scrubbed, or extended by a developer tool,
// and Git for Windows, MSYS2, Cygwin and WSL interop all ship shadowing
// coreutils builds. It is also a PATH-hijack vector, which is why this repo
// ALREADY made this decision: uac-delegation.js states the rule ("absolute
// path under %SystemRoot%\System32"), and service-control.js,
// uac-delegation-client.js, supervision/observer.js, codex-native-pair.js and
// fra-root-access.js all follow it. scheduler-adapter.js is a site that did
// not.
//
// SystemRoot IS READ, NOT ASSUMED. Windows is not always at C:\Windows --
// imaged machines, non-C: system drives and localized deployments all move it.
// The path must follow the environment and fall back only when it is absent.
//
// Run: node tests/system-binaries-resolve-under-system-root.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../src/lib/scheduler-adapter');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); }
  catch (error) {
    failures += 1;
    console.error(`  FAIL: ${label}\n    ${error.message}`);
  }
}

console.log('system binaries: named by absolute path, never by PATH lookup');

// A run() stand-in that records the command instead of executing anything, and
// answers with a well-formed whoami CSV line so the caller reaches its success
// path. The SID is a documented well-known value, not this machine's.
function recorder(stdout = '"MACHINE\\person","S-1-5-21-1111111111-2222222222-3333333333-1001"') {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout, stderr: '' };
  };
  return { calls, run };
}

// --- 1. THE MEASURED SITE ---------------------------------------------------
check('whoami is invoked by absolute path, not by name', () => {
  const { calls, run } = recorder();
  adapter.resolveCurrentPrincipalIdentity({ run });
  assert.equal(calls.length, 1, `expected one invocation, saw ${calls.length}`);
  const { command } = calls[0];
  assert.ok(path.win32.isAbsolute(command),
    `whoami was invoked as ${JSON.stringify(command)}; whichever whoami.exe PATH finds first will answer`);
  assert.match(command.replace(/\\/g, '/'), /\/System32\/whoami\.exe$/i,
    `whoami resolved to ${command}, which is not the System32 binary`);
});

check('the identity still parses out of a well-formed answer', () => {
  const { run } = recorder();
  const identity = adapter.resolveCurrentPrincipalIdentity({ run });
  assert.equal(identity.principalId, 'S-1-5-21-1111111111-2222222222-3333333333-1001');
  assert.equal(identity.principalName, 'MACHINE\\person');
});

// --- 2. WINDOWS IS NOT ALWAYS AT C:\WINDOWS ---------------------------------
check('the path follows SystemRoot rather than assuming C:\\Windows', () => {
  const keys = ['SystemRoot', 'SYSTEMROOT', 'windir'];
  const saved = keys.map(key => [key, Object.hasOwn(process.env, key) ? process.env[key] : undefined]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.SystemRoot = 'D:\\OtherWindows';
    const { calls, run } = recorder();
    adapter.resolveCurrentPrincipalIdentity({ run });
    assert.match(calls[0].command.replace(/\\/g, '/'), /^D:\/OtherWindows\/System32\/whoami\.exe$/i,
      `the command was ${calls[0].command}; a machine with Windows outside C:\\Windows would run the wrong file or none`);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

check('a missing SystemRoot still produces an absolute path', () => {
  const keys = ['SystemRoot', 'SYSTEMROOT', 'windir'];
  const saved = keys.map(key => [key, Object.hasOwn(process.env, key) ? process.env[key] : undefined]);
  try {
    for (const key of keys) delete process.env[key];
    const { calls, run } = recorder();
    adapter.resolveCurrentPrincipalIdentity({ run });
    assert.ok(path.win32.isAbsolute(calls[0].command), `fell back to ${calls[0].command}`);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

// --- 3. THE FENCE, so the pattern cannot come back --------------------------
// A behavioural test covers the call it drives. This covers the ones it does
// not: the adapter also drives schtasks.exe from four sites, and a future edit
// can add a fifth. Source text is the only instrument that sees all of them.
check('no system binary in scheduler-adapter.js is named without a path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'scheduler-adapter.js'), 'utf8');
  const bare = [...source.matchAll(/\brun\(\s*(['"])([A-Za-z0-9_.-]+\.exe)\1/g)].map(match => match[2]);
  assert.deepEqual(bare, [],
    `these are handed to run() as bare names, so PATH decides which program actually runs: ${bare.join(', ')}`);
});

console.log(failures === 0
  ? '\n✅ system binaries: all checks passed'
  : `\n❌ ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
