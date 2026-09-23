'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, getSecret } = require('../../src/lib/runtime');

function missingSecretIsSanitized() {
  const key = `missing_runtime_${process.pid}_${Date.now()}`;
  assert.throws(
    () => getSecret(key),
    error => {
      assert.equal(error.message, `Secret '${key}' is not configured.`);
      assert.doesNotMatch(error.message, /secrets\.ps1|At .*line|Desktop|ToolsEnabled/i);
      return true;
    }
  );
}

function windowsBatchArgumentsAreGuarded() {
  if (process.platform !== 'win32') {
    console.log('SKIP runtime-security: Windows batch argument guards (Windows-only check)');
    return;
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-runtime-security-'));
  const script = path.join(temporary, 'argument-probe.cmd');
  fs.writeFileSync(script, '@echo off\r\necho SAFE:%~1\r\n', 'ascii');

  try {
    const safe = run(script, ['normal-value']);
    assert.equal(safe.status, 0);
    assert.match(safe.stdout, /SAFE:normal-value/);

    // Firebase uses this exact database identifier during normal operation.
    const firestoreDefault = run(script, ['(default)']);
    assert.equal(firestoreDefault.status, 0);
    assert.match(firestoreDefault.stdout, /SAFE:\(default\)/);

    const unsafe = [
      'x&whoami', 'x|whoami', 'x>file', 'x<input', 'x^y', '(anything-else)',
      'double"quote', '%PATH%', '!PATH!', 'line\rbreak', 'line\nbreak', 'nul\0byte'
    ];
    for (const argument of unsafe) {
      assert.throws(
        () => run(script, [argument]),
        error => {
          assert.match(error.message, /^Unsafe Windows batch argument at index 0;/);
          assert.doesNotMatch(error.message, new RegExp(argument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          return true;
        }
      );
    }

    // Native executables do not cross the cmd.exe parser boundary and therefore
    // retain ordinary argv semantics.
    const native = run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'x&y']);
    assert.equal(native.status, 0);
    assert.equal(native.stdout, 'x&y');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

missingSecretIsSanitized();
windowsBatchArgumentsAreGuarded();
console.log('Runtime security tests passed.');
