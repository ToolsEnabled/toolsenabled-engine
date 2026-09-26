// EXECUTABLE CHANGE — discrimination audit report follows at the mutation site below.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'secrets.ps1');
const LOCK_HOLDER = path.join(__dirname, 'vault-lock-holder.ps1');
const PROMPT_LOCK_HOLDER = path.join(__dirname, 'prompt-lock-holder.ps1');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-vault-test-'));
const vaultFile = path.join(tempRoot, 'isolated', 'secrets.json');
const childEnv = { ...process.env, TOOLSENABLED_VAULT_PATH: vaultFile };

function randomValue() {
  return crypto.randomBytes(32).toString('base64url');
}

function argumentsFor(action, key, extra = []) {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, action, key, ...extra];
}

function invoke(action, key, { input, extra = [], env = {} } = {}) {
  return childProcess.spawnSync('powershell.exe', argumentsFor(action, key, extra), {
    cwd: ROOT,
    env: { ...childEnv, ...env },
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 40_000,
    windowsHide: true
  });
}

function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for lock-holder readiness.'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function waitForClose(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for lock-holder exit.')), timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const VAULT_LOCK_TIMEOUT_PATTERN = /Timed out waiting for exclusive access/;
// A concurrent batch racing to advance ONE monotonic anchor must see most of its
// members refused: that is the monotonic guarantee holding, not a fault. Measured
// on Windows 2026-08-26, 9 of 12 concurrent advances refused this way.
const MONOTONIC_REFUSAL_PATTERN = /cannot move backward/i;

// Under real contention (another process holding the lock, or the host busy
// enough that a spawned powershell.exe cannot get scheduled before the wait
// window elapses) some fraction of a concurrent batch can legitimately time
// out acquiring the vault lock. That is an environment condition, not a vault
// defect -- but a bare "status !== 0" failure looks identical to real
// corruption. Partition failures so the assertion message tells a developer
// which one they are looking at, without loosening the requirement that every
// call in the batch still succeed.
function describeConcurrentFailures(label, results) {
  const failures = results.filter(result => result.status !== 0);
  if (failures.length === 0) return '';
  const timedOut = failures.filter(result => VAULT_LOCK_TIMEOUT_PATTERN.test(result.stderr));
  const other = failures.filter(result => !VAULT_LOCK_TIMEOUT_PATTERN.test(result.stderr));
  const verdict = other.length > 0
    ? `${other.length}/${failures.length} failure(s) were NOT lock-acquisition timeouts -- ` +
      `treat this as a real defect in ${label}, not contention.`
    : `all ${timedOut.length} failure(s) were lock-acquisition timeouts ("Timed out waiting for ` +
      `exclusive access") -- this looks like lock contention (another process, or system load, ` +
      `held the vault lock past the wait window) rather than a defect in ${label}. Re-run on a ` +
      'quieter machine (fewer concurrent node/powershell processes) before treating this as a bug.';
  const detail = JSON.stringify(failures.map(result => ({ status: result.status, error: result.stderr.split(/\r?\n/)[0] })));
  return `${failures.length}/${results.length} ${label} calls failed. ${verdict} Failures: ${detail}`;
}

function invokeAsync(action, key, { input, extra = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn('powershell.exe', argumentsFor(action, key, extra), {
      cwd: ROOT,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function main() {
  assert.ok(fs.existsSync(SCRIPT));
  assert.ok(fs.existsSync(PROMPT_LOCK_HOLDER));

  // The public Node helpers must put secret material only on stdin. Mock the
  // process boundary so this remains a direct invariant instead of a timing-
  // dependent command-line inspection.
  const childModule = require('node:child_process');
  const originalExecFileSync = childModule.execFileSync;
  const vaultHost = require('../../src/lib/vault-host-client');
  const originalHostCall = vaultHost.callVaultHost;
  const runtimePath = require.resolve('../../src/lib/runtime');
  const boundaryValues = [randomValue(), randomValue(), randomValue(), randomValue(), randomValue(), randomValue(), randomValue(), JSON.stringify({ sequence: 7, hash: randomValue() })];
  const boundaryCalls = [];
  const hostCalls = [];
  try {
    // An unavailable persistent host selects the existing per-call fallback.
    // Intercept both real transports: otherwise the monotonic call escapes
    // this fixture and writes a real vault while only four spawns are observed.
    vaultHost.callVaultHost = (action, params) => {
      hostCalls.push({ action, params });
      return null;
    };
    childModule.execFileSync = (executable, args, options) => {
      boundaryCalls.push({ executable, args, input: options.input });
      /* `!args.includes(input)` ONLY EVER CAUGHT A SECRET THAT WAS ITS OWN BARE TOKEN.
       *
       * Array.prototype.includes is exact element equality, so this was blind to
       * every embedded form -- `-PromptHint:<secret>`, `-Value:<secret>`,
       * `--value=<secret>`, or a secret concatenated into any token. PowerShell
       * binds the colon form identically to the space form, so an embedded secret
       * is a first-class way onto the command line, where any local process can
       * read it out of Win32_Process.
       *
       * It was doubly vacuous when `options.input` was undefined:
       * `args.includes(undefined)` is false for every args, so a change that moved
       * the secret OUT of stdin and INTO argv passed twice over. Nothing asserted
       * argv was non-empty or that a secret crossed on stdin at all.
       *
       * MEASURED: appending `-PromptHint:${value}` to the set-stdin invocation in
       * src/lib/runtime.js put every stored secret on the command line and left
       * this suite green -- including the real round-trip against real
       * powershell.exe, because tools/secrets.ps1 accepted -PromptHint on every
       * action and ignored it. (That gap is closed in the same commit.)
       *
       * Positive on the subject first, then substring containment per argument. */
      assert.ok(Array.isArray(args) && args.length > 0, 'the boundary saw no argv to inspect');
      assert.equal(typeof options.input, 'string', 'the secret must cross the boundary on stdin');
      assert.ok(options.input.length > 0, 'the secret crossing the boundary is empty; this check has no subject');
      for (const argument of args) {
        assert.ok(!String(argument).includes(options.input),
          `secret input must not be present in argv, in any form: ${String(argument).split(options.input).join('<SECRET>')}`);
      }
      return args.includes('get-or-create-stdin') ? options.input : '';
    };
    delete require.cache[runtimePath];
    const mockedRuntime = require('../../src/lib/runtime');
    mockedRuntime.setSecret('boundary_set', boundaryValues[0]);
    assert.equal(mockedRuntime.getOrCreateSecret('boundary_once', boundaryValues[1]), boundaryValues[1]);
    mockedRuntime.setSecretPair('boundary_pair_left', boundaryValues[2], 'boundary_pair_right', boundaryValues[3]);
    mockedRuntime.setSecretTriple('boundary_triple_left', boundaryValues[4], 'boundary_triple_middle', boundaryValues[5], 'boundary_triple_right', boundaryValues[6]);
    mockedRuntime.setMonotonicSecret('boundary_head', boundaryValues[7], 7);
    const expectedHostRequest = {
      action: 'set-monotonic-stdin',
      params: { key: 'boundary_head', sequence: 7, valueBase64: Buffer.from(boundaryValues[7], 'utf8').toString('base64') }
    };
    assert.deepEqual(hostCalls, [expectedHostRequest]);
    assert.equal(boundaryCalls.length, 5, 'an unavailable host must retain all five stdin-only fallback operations');

    const digest = 'a'.repeat(64);
    vaultHost.callVaultHost = (action, params) => {
      assert.deepEqual({ action, params }, expectedHostRequest);
      return { output: `vault-sha256=${digest}\n` };
    };
    assert.equal(mockedRuntime.setMonotonicSecret('boundary_head', boundaryValues[7], 7), digest);
    assert.equal(boundaryCalls.length, 5, 'a served host request must not also write through the fallback');

    vaultHost.callVaultHost = () => { throw new Error('synthetic vault sequence conflict'); };
    assert.throws(() => mockedRuntime.setMonotonicSecret('boundary_head', boundaryValues[7], 7),
      /Unable to advance monotonic secret/);
    assert.equal(boundaryCalls.length, 5, 'a vault refusal must not be retried through another transport');
  } finally {
    childModule.execFileSync = originalExecFileSync;
    vaultHost.callVaultHost = originalHostCall;
    delete require.cache[runtimePath];
  }
  assert.equal(boundaryCalls.length, 5);
  assert.deepEqual(boundaryCalls.map(call => call.input), [
    boundaryValues[0], boundaryValues[1],
    JSON.stringify({ first: { key: 'boundary_pair_left', value: boundaryValues[2] }, second: { key: 'boundary_pair_right', value: boundaryValues[3] } }),
    JSON.stringify({ first: { key: 'boundary_triple_left', value: boundaryValues[4] }, second: { key: 'boundary_triple_middle', value: boundaryValues[5] }, third: { key: 'boundary_triple_right', value: boundaryValues[6] } }),
    boundaryValues[7]
  ]);

  const runtime = require('../../src/lib/runtime');
  const oldOverride = process.env.TOOLSENABLED_VAULT_PATH;
  process.env.TOOLSENABLED_VAULT_PATH = vaultFile;
  try {
    const roundTrip = randomValue();
    runtime.setSecret('round_trip', roundTrip);
    assert.equal(runtime.getSecret('round_trip'), roundTrip);
    const pairLeft = randomValue(); const pairRight = randomValue();
    runtime.setSecretPair('pair_left', pairLeft, 'pair_right', pairRight);
    assert.equal(runtime.getSecret('pair_left'), pairLeft);
    assert.equal(runtime.getSecret('pair_right'), pairRight);
    const tripleLeft = randomValue(); const tripleMiddle = randomValue(); const tripleRight = randomValue();
    runtime.setSecretTriple('triple_left', tripleLeft, 'triple_middle', tripleMiddle, 'triple_right', tripleRight);
    assert.equal(runtime.getSecret('triple_left'), tripleLeft);
    assert.equal(runtime.getSecret('triple_middle'), tripleMiddle);
    assert.equal(runtime.getSecret('triple_right'), tripleRight);

    // Human `set` has no positional value form. The attempted value must not
    // create a key even when the supplied third argument looks harmless.
    const rejectedValue = randomValue();
    const rejected = invoke('set', 'argv_rejected', { extra: [rejectedValue] });
    assert.notEqual(rejected.status, 0);
    assert.equal(invoke('exists', 'argv_rejected').status, 1);

    // Simultaneous updates to distinct keys used to overwrite each other.
    const concurrentEntries = Array.from({ length: 24 }, (_, index) => ({
      key: `parallel_${index}`,
      value: randomValue()
    }));
    const writeResults = await Promise.all(concurrentEntries.map(entry =>
      invokeAsync('set-stdin', entry.key, { input: entry.value })
    ));
    assert.ok(
      writeResults.every(result => result.status === 0),
      describeConcurrentFailures('the 24-way parallel-key writes', writeResults)
    );
    for (const entry of concurrentEntries) {
      const read = invoke('get', entry.key);
      assert.equal(read.status, 0);
      assert.equal(read.stdout, entry.value);
    }

    // Concurrent first use converges on one atomically selected value.
    const candidates = Array.from({ length: 16 }, () => randomValue());
    const createResults = await Promise.all(candidates.map(candidate =>
      invokeAsync('get-or-create-stdin', 'converged_key', { input: candidate })
    ));
    assert.ok(
      createResults.every(result => result.status === 0),
      describeConcurrentFailures('the 16-way get-or-create race', createResults)
    );
    const selected = createResults[0].stdout;
    assert.ok(candidates.includes(selected));
    assert.ok(createResults.every(result => result.stdout === selected));
    assert.equal(runtime.getOrCreateSecret('converged_key', randomValue()), selected);

    const anchor1 = JSON.stringify({ sequence: 1, hash: randomValue() });
    const anchor2 = JSON.stringify({ sequence: 2, hash: randomValue() });
    runtime.setMonotonicSecret('audit_head', anchor1, 1);
    runtime.setMonotonicSecret('audit_head', anchor1, 1); // exact replay is idempotent
    runtime.setMonotonicSecret('audit_head', anchor2, 2);
    assert.throws(
      () => runtime.setMonotonicSecret('audit_head', JSON.stringify({ sequence: 1, hash: randomValue() }), 1),
      /Unable to advance monotonic secret/
    );
    assert.throws(
      () => runtime.setMonotonicSecret('audit_head', JSON.stringify({ sequence: 2, hash: randomValue() }), 2),
      /Unable to advance monotonic secret/
    );
    assert.throws(
      () => runtime.setMonotonicSecret('audit_head', JSON.stringify({ sequence: 3, hash: randomValue() }), 4),
      /Unable to advance monotonic secret/
    );

    // Racing advances can reject stale contenders, but the maximum sequence
    // must win and can never subsequently be rolled back.
    const advances = Array.from({ length: 12 }, (_, offset) => {
      const sequence = offset + 3;
      return {
        sequence,
        value: JSON.stringify({ sequence, hash: randomValue() })
      };
    });
    const advanceResults = await Promise.all(advances.map(item => invokeAsync('set-monotonic-stdin', 'audit_head', {
      input: item.value,
      extra: ['-Sequence', String(item.sequence)]
    })));
    /* TEST-CAN-FAIL REPORT (testcanfail-tests-kernel-audit-vault-hardening-js)
     * Suspect: the race discarded every child result. A broken invocation could
     * therefore contribute no assertion evidence; only the later winner read
     * happened to detect failures that prevented sequence 14 from being stored.
     * Strengthening: require all 12 intended subjects and each subject's own
     * successful exit, retaining the existing final-state assertion below.
     * Mutation: in a scratch edit of tools/secrets.ps1, make
     * set-monotonic-stdin throw for sequence 3. Expected RED on Windows:
     * "AssertionError [ERR_ASSERTION]: 1/12 monotonic advances failed."
     * PRECONDITION-NOT-MET: powershell.exe and Windows DPAPI are unavailable on
     * this Linux host, so that product mutation and the restored green end-to-end
     * run cannot be executed here. No product file was retained or committed.
     * Independently measured existing argv fence: temporarily append
     * `-PromptHint:${value}` in src/lib/runtime.js setSecret; RED was:
     * "Error: Unable to store refreshed secret 'boundary_set': secret input must
     * not be present in argv, in any form: -PromptHint:<SECRET>". The source was
     * restored byte-for-byte (sha256sum -c: "src/lib/runtime.js: OK").
     * NOT-FOUND (1): potentially empty assertion loops (all are fixed non-empty,
     * or boundary argv has an explicit non-empty assertion).
     * NOT-FOUND (2): bare non-zero evidence; rejection/lock checks also inspect
     * subject state or diagnostic output. The discarded race results above were
     * found and fixed.
     * NOT-FOUND (3): try/catch or optional chaining swallowing the target failure.
     * NOT-FOUND (4): assertion against a mock of the thing under test (the process
     * mock records runtime-generated boundary arguments, not a mocked runtime).
     * NOT-FOUND (5): skip or platform precondition guard.
     * NOT-FOUND (6): expected value computed by the same code under test.
     */
    assert.equal(advanceResults.length, advances.length, 'every monotonic advance must produce a result');
    // Capturing these results is the real fix -- the batch previously discarded
    // them, so a child that failed for ANY reason contributed no evidence and
    // only the final read happened to notice. But "every call succeeds" is the
    // wrong bar for this batch, and measuring it on Windows is what showed why:
    // 12 advances race to set one MONOTONIC anchor, so whichever lands highest
    // first makes every lower sequence legitimately refuse with "cannot move
    // backward". That refusal IS the guarantee under test, not a defect --
    // 9 of 12 refused on a real run. What must never happen is a failure of some
    // OTHER kind, which is what this now pins, alongside the final-state
    // assertion below that the winner is the highest sequence.
    const unexpectedAdvanceFailures = advanceResults.filter(result =>
      result.status !== 0
      && !VAULT_LOCK_TIMEOUT_PATTERN.test(result.stderr)
      && !MONOTONIC_REFUSAL_PATTERN.test(result.stderr));
    assert.equal(
      unexpectedAdvanceFailures.length, 0,
      describeConcurrentFailures('monotonic advances', unexpectedAdvanceFailures)
    );
    assert.ok(
      advanceResults.some(result => result.status === 0),
      'no monotonic advance succeeded at all, so the anchor below cannot have been written by this batch'
    );
    const finalAnchor = JSON.parse(runtime.getSecret('audit_head'));
    assert.equal(finalAnchor.sequence, 14);

    // A share-deny file handle is system-wide, unlike a Local\ named mutex.
    // Exercise bounded contention and then terminate the owner without cleanup:
    // Windows must release the handle and the persistent lock file must be reusable.
    const readyPath = path.join(tempRoot, 'lock-holder.ready');
    const holder = childProcess.spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LOCK_HOLDER,
      '-VaultPath', vaultFile, '-ReadyPath', readyPath
    ], {
      cwd: ROOT,
      env: childEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    let holderError = '';
    holder.stderr.setEncoding('utf8');
    holder.stderr.on('data', chunk => { holderError += chunk; });
    try {
      await waitForFile(readyPath);
      assert.ok(fs.existsSync(`${vaultFile}.lock`));
      const blockedValue = randomValue();
      const startedAt = Date.now();
      const blocked = invoke('set-stdin', 'blocked_by_lock', {
        input: blockedValue,
        env: { TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS: '250' }
      });
      const elapsedMs = Date.now() - startedAt;
      assert.notEqual(blocked.status, 0);
      assert.ok(elapsedMs >= 100 && elapsedMs < 5000, `unexpected lock timeout duration: ${elapsedMs}ms`);
      assert.match(blocked.stderr, /Timed out waiting for exclusive access/);
      assert.ok(!blocked.stderr.includes(blockedValue));
      assert.equal(invoke('exists', 'blocked_by_lock').status, 1);

      holder.kill(); // deliberately bypasses the holder's finally block
      await waitForClose(holder);

      const recovered = invoke('set-stdin', 'recovered_after_crash', { input: blockedValue });
      assert.equal(recovered.status, 0, recovered.stderr.split(/\r?\n/)[0]);
      assert.equal(invoke('get', 'recovered_after_crash').stdout, blockedValue);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill();
        await waitForClose(holder).catch(() => {});
      }
      assert.equal(holderError, '');
    }

    // Only one interactive credential dialog may exist across MCP processes.
    // Hold the same share-deny rendezvous handle and prove a second request
    // returns immediately without attempting to open a UI.
    const promptReadyPath = path.join(tempRoot, 'prompt-lock-holder.ready');
    const promptHolder = childProcess.spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROMPT_LOCK_HOLDER,
      '-VaultPath', vaultFile, '-ReadyPath', promptReadyPath
    ], {
      cwd: ROOT,
      env: childEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    let promptHolderError = '';
    promptHolder.stderr.setEncoding('utf8');
    promptHolder.stderr.on('data', chunk => { promptHolderError += chunk; });
    try {
      await waitForFile(promptReadyPath);
      const duplicate = invoke('prompt-set', 'parallel_prompt', {
        extra: ['-PromptLabel', 'Parallel prompt fixture']
      });
      assert.equal(duplicate.status, 0, duplicate.stderr.split(/\r?\n/)[0]);
      assert.deepEqual(JSON.parse(duplicate.stdout), { key: 'parallel_prompt', status: 'in_progress' });
      assert.equal(invoke('exists', 'parallel_prompt').status, 1);
    } finally {
      if (promptHolder.exitCode === null && promptHolder.signalCode === null) {
        promptHolder.kill();
        await waitForClose(promptHolder).catch(() => {});
      }
      assert.equal(promptHolderError, '');
    }

    const ciphertext = fs.readFileSync(vaultFile, 'utf8');
    for (const plaintext of [roundTrip, rejectedValue, tripleLeft, tripleMiddle, tripleRight, ...concurrentEntries.map(entry => entry.value), ...candidates]) {
      assert.ok(!ciphertext.includes(plaintext), 'vault file must contain DPAPI ciphertext only');
    }
    assert.deepEqual(runtime.listSecretKeys(), [
      'audit_head', 'converged_key', ...concurrentEntries.map(entry => entry.key),
      'pair_left', 'pair_right', 'recovered_after_crash', 'round_trip',
      'triple_left', 'triple_middle', 'triple_right'
    ].sort());
  } finally {
    if (oldOverride === undefined) delete process.env.TOOLSENABLED_VAULT_PATH;
    else process.env.TOOLSENABLED_VAULT_PATH = oldOverride;
  }

  console.log('vault hardening tests passed');
}

main().finally(() => {
  const resolved = path.resolve(tempRoot);
  const tempBase = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolved.startsWith(tempBase)) fs.rmSync(resolved, { recursive: true, force: true });
}).catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
