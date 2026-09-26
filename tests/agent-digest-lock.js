'use strict';

// Cross-process single-instance guard for the digest tick.
//
// This exists because of a real production finding (2026-07-28): the digest
// was started manually (`node src/agent-digest.js --serve`) outside its
// registered Scheduled Task. DigestSchedule's JsonSettingsStore has no
// cross-process locking, and AgentDigestService.tick() is single-flight only
// WITHIN one process. If the task's own trigger had fired while that manual
// process was still alive, Windows would not have treated it as a duplicate
// (it didn't start the manual one), and two ticking processes could both have
// read the same unfired slot before either persisted markFired() -- a real
// double-send. These tests prove the lock closes exactly that gap.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const {
  AgentDigestLockError,
  AgentDigestLockUnreadableError,
  acquireLock,
  pidAlive,
  releaseLock,
} = require('../src/lib/agent-digest/lock');

let checks = 0;
function check(label, run) { run(); checks += 1; process.stdout.write(`  ok ${label}\n`); }

function waitUntil(predicate, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error(message);
}

function windowsTicks(iso) {
  return String(621355968000000000n + (BigInt(Date.parse(iso)) * 10_000n));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-digest-lock-'));
try {
  check('a second process cannot acquire the lock while the holder is alive -- the exact double-tick race', () => {
    const file = path.join(dir, 'a.lock');
    const first = acquireLock(file, { pid: 111, isAlive: pid => pid === 111 });
    assert.ok(fs.existsSync(file));
    assert.throws(
      () => acquireLock(file, { pid: 222, isAlive: pid => pid === 111 }),
      error => error instanceof AgentDigestLockError && error.code === 'AGENT_DIGEST_ALREADY_RUNNING' && error.holderPid === 111
    );
    first.release();
  });

  function shortContention(phase, releaseAtMs, publishGraceMs) {
    const file = path.join(dir, `responsive-${phase}-${releaseAtMs}.lock`);
    const claims = `${file}.claims`;
    const firstPid = 211;
    let releaseFirst;
    if (phase === 'choosing') {
      const hash = crypto.createHash('sha256').update(`pid-compat:${firstPid}`).digest('hex');
      const choosing = path.join(claims, `choosing.p.${firstPid}.${hash}.${crypto.randomUUID()}.claim`);
      fs.mkdirSync(claims, { recursive: true });
      fs.writeFileSync(choosing, '', { flag: 'wx' });
      releaseFirst = () => { if (fs.existsSync(choosing)) fs.unlinkSync(choosing); };
    } else {
      const first = acquireLock(file, { pid: firstPid, isAlive: () => true });
      releaseFirst = () => first.release();
    }
    const realNow = Date.now;
    const startedAt = realNow();
    const tickets = new Set();
    let waitedMs = 0;
    let lock;
    Date.now = () => startedAt + waitedMs;
    try {
      lock = acquireLock(file, {
        pid: 212,
        isAlive: () => true,
        publishGraceMs,
        sleep(ms) {
          for (const name of fs.readdirSync(claims)) {
            if (name.startsWith('ticket.') && name.includes('.p.212.')) tickets.add(name);
          }
          waitedMs += ms;
          if (waitedMs >= releaseAtMs) releaseFirst();
        },
      });
      assert.ok(waitedMs >= releaseAtMs, 'the contender entered before the earlier claim released');
      assert.ok(waitedMs <= releaseAtMs + 50,
        `a released ${phase} claim left the contender asleep until ${waitedMs} ms`);
      assert.equal(tickets.size, 1, 'waiting must retain one queue ticket');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, lock.nonce);
    } finally {
      Date.now = realNow;
      releaseFirst();
      if (lock) lock.release();
    }
  }

  check('a short earlier ticket does not turn a ten-second grace into seconds of oversleep', () => {
    shortContention('ticket', 75, 10_000);
  });

  check('a short choosing claim is observed promptly within a ten-second grace', () => {
    shortContention('choosing', 75, 10_000);
  });

  check('prompt contention polls keep the original ticket until a late release inside the full grace', () => {
    shortContention('ticket', 925, 1000);
  });

  check('a holder that outlives the grace still refuses after the full budget', () => {
    const file = path.join(dir, 'responsive-still-held.lock');
    const first = acquireLock(file, { pid: 213, isAlive: () => true });
    const realNow = Date.now;
    const startedAt = realNow();
    let waitedMs = 0;
    Date.now = () => startedAt + waitedMs;
    try {
      assert.throws(() => acquireLock(file, {
        pid: 214,
        isAlive: () => true,
        publishGraceMs: 1000,
        sleep(ms) { waitedMs += ms; },
      }), error => error instanceof AgentDigestLockError && error.holderPid === 213);
      assert.ok(waitedMs >= 1000 && waitedMs <= 1050,
        `contention shortened or extended the grace to ${waitedMs} ms`);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, first.nonce);
      assert.equal(fs.readdirSync(`${file}.claims`).length, 1,
        'the refused contender must remove only its own claim');
    } finally {
      Date.now = realNow;
      first.release();
    }
  });

  check('a lock abandoned by a dead process (kill, crash, reboot) is reclaimed, not stuck forever', () => {
    const file = path.join(dir, 'b.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: 999, startedAt: new Date().toISOString() }));
    const lock = acquireLock(file, { pid: 333, isAlive: pid => pid === 333 }); // 999 is not alive
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 333);
    lock.release();
    assert.ok(!fs.existsSync(file), 'release must remove a lock this process owns');
  });

  check('an unreadable lock never becomes a definite stale/absent answer', () => {
    const file = path.join(dir, 'c.lock');
    fs.writeFileSync(file, '{not json');
    assert.throws(
      () => acquireLock(file, { pid: 444, isAlive: () => true, publishGraceMs: 0, polls: 0 }),
      error => error instanceof AgentDigestLockUnreadableError &&
        error.code === 'AGENT_DIGEST_LOCK_UNREADABLE' &&
        /does NOT claim the lock is absent/.test(error.message)
    );
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json', 'could-not-tell must not reclaim the lock');
  });

  check('fixed status becomes visible only after its complete JSON bytes are durable', () => {
    const file = path.join(dir, 'atomic-status.lock');
    const originalLink = fs.linkSync;
    let inspected = false;
    fs.linkSync = function inspectBeforePublication(staged, target) {
      if (path.resolve(target) === path.resolve(file)) {
        inspected = true;
        assert.equal(fs.existsSync(file), false, 'the public status path existed before complete publication');
        const complete = JSON.parse(fs.readFileSync(staged, 'utf8'));
        assert.equal(complete.pid, 445);
        assert.equal(typeof complete.processStartIdentity, 'string');
      }
      return originalLink.call(fs, staged, target);
    };
    let lock;
    try {
      lock = acquireLock(file, { pid: 445, isAlive: () => true });
    } finally {
      fs.linkSync = originalLink;
    }
    assert.equal(inspected, true, 'status publication did not use the atomic complete-file link');
    lock.release();
  });

  check('CONTROL: a definitely stale dead-holder lock is still reclaimed', () => {
    const file = path.join(dir, 'c-control.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: 1234 }));
    const lock = acquireLock(file, { pid: 444, isAlive: () => false });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 444);
    lock.release();
  });

  check('release only ever removes a lock this process itself owns', () => {
    const file = path.join(dir, 'd.lock');
    const lock = acquireLock(file, { pid: 555, isAlive: () => true });
    // A different pid's release must not delete someone else's live lock.
    releaseLock(file, 666, lock.nonce);
    assert.ok(fs.existsSync(file), 'a foreign pid must not be able to release another process\'s lock');
    releaseLock(file, 555, lock.nonce);
    assert.ok(!fs.existsSync(file));
  });

  check('release requires the exact nonce even when Windows reuses the same pid', () => {
    const file = path.join(dir, 'same-pid-replacement.lock');
    const lock = acquireLock(file, { pid: 556, isAlive: () => true });
    fs.unlinkSync(file);
    fs.writeFileSync(file, JSON.stringify({
      pid: 556, startedAt: '2026-01-01T00:00:01.000Z', nonce: 'replacement-generation'
    }), { flag: 'wx' });
    lock.release();
    releaseLock(file, 556);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, 'replacement-generation');
    fs.rmSync(file, { force: true });
  });

  check('release is idempotent -- calling it twice (e.g. from both a catch and a finally) never throws', () => {
    const file = path.join(dir, 'e.lock');
    const lock = acquireLock(file, { pid: 777, isAlive: () => true });
    lock.release();
    assert.doesNotThrow(() => lock.release());
  });

  check('after a release, the same lock can be acquired again immediately (a clean --once/--serve restart)', () => {
    const file = path.join(dir, 'f.lock');
    const first = acquireLock(file, { pid: 888, isAlive: () => true });
    first.release();
    const second = acquireLock(file, { pid: 889, isAlive: () => true });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 889);
    second.release();
  });

  check('stale reclamation never unlinks a replacement acquired after the liveness probe', () => {
    const file = path.join(dir, 'stale-replaced.lock');
    fs.writeFileSync(file, JSON.stringify({
      pid: 901, startedAt: '2026-01-01T00:00:00.000Z', nonce: 'old-generation'
    }));
    let replaced = false;
    assert.throws(
      () => acquireLock(file, {
        pid: 903,
        isAlive: pid => {
          if (pid === 901 && !replaced) {
            replaced = true;
            fs.unlinkSync(file);
            fs.writeFileSync(file, JSON.stringify({
              pid: 902, startedAt: '2026-01-01T00:00:01.000Z', nonce: 'new-generation'
            }), { flag: 'wx' });
            return false;
          }
          return pid === 902;
        }
      }),
      error => error instanceof AgentDigestLockError && error.holderPid === 902
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      pid: 902, startedAt: '2026-01-01T00:00:01.000Z', nonce: 'new-generation'
    }, 'the stale reclaimer removed the replacement lock');
    fs.rmSync(file, { force: true });
  });

  check('a byte-identical legacy replacement is reclassified after quarantine before deletion', () => {
    const file = path.join(dir, 'stale-byte-identical-replaced.lock');
    const startedAt = '2026-09-01T10:00:00.000Z';
    const bytes = JSON.stringify({ pid: 905, startedAt, nonce: 'legacy-generation' });
    fs.writeFileSync(file, bytes);
    let replacementIdentity = null;
    let replacementPublished = false;
    const originalRename = fs.renameSync;
    fs.renameSync = function replaceImmediatelyBeforeQuarantine(source, target) {
      if (!replacementPublished && path.resolve(source) === path.resolve(file)
          && String(target).includes('.stale.')) {
        fs.unlinkSync(file);
        fs.writeFileSync(file, bytes, { flag: 'wx' });
        replacementIdentity = `win32:${windowsTicks('2026-09-01T10:00:01.000Z')}`;
        replacementPublished = true;
      }
      return originalRename.call(fs, source, target);
    };
    try {
      assert.throws(
        () => acquireLock(file, {
          pid: 906,
          isAlive: contenderPid => contenderPid === 905 || contenderPid === 906,
          getProcessIdentity: contenderPid => {
            if (contenderPid === 906) return `win32:${windowsTicks('2026-09-01T09:59:00.000Z')}`;
            if (contenderPid === 905) return replacementIdentity;
            return null;
          },
          publishGraceMs: 0,
          polls: 0,
        }),
        error => error instanceof AgentDigestLockError && error.holderPid === 905
      );
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(replacementPublished, true, 'the byte-identical replacement interleave was not reached');
    assert.equal(fs.readFileSync(file, 'utf8'), bytes,
      'the byte-identical live replacement was deleted after only a pre-move liveness check');
    fs.rmSync(file, { force: true });
  });

  check('legacy guard reclamation never unlinks a replacement generation', () => {
    const file = path.join(dir, 'guard-replaced.lock');
    const guardFile = `${file}.reclaiming`;
    fs.writeFileSync(file, JSON.stringify({
      pid: 911, startedAt: '2026-01-01T00:00:00.000Z', nonce: 'stale-main'
    }));
    fs.writeFileSync(guardFile, JSON.stringify({
      pid: 912, startedAt: '2026-01-01T00:00:01.000Z', nonce: 'stale-guard'
    }));
    const replacement = {
      pid: 913, startedAt: '2026-01-01T00:00:02.000Z', nonce: 'replacement-guard'
    };

    const originalRename = fs.renameSync;
    let replacementPublished = false;
    fs.renameSync = function interleavedRename(source, target) {
      const result = originalRename.call(fs, source, target);
      if (!replacementPublished && path.resolve(source) === path.resolve(guardFile)) {
        replacementPublished = true;
        fs.writeFileSync(guardFile, JSON.stringify(replacement), { flag: 'wx' });
      }
      return result;
    };
    try {
      assert.throws(
        () => acquireLock(file, { pid: 914, isAlive: contenderPid => contenderPid === 913 }),
        error => error instanceof AgentDigestLockError && error.holderPid === 913
      );
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(replacementPublished, true, 'the replacement was not inserted in the reclaim interval');
    assert.deepEqual(JSON.parse(fs.readFileSync(guardFile, 'utf8')), replacement,
      'stale guard cleanup deleted the replacement generation');
    fs.rmSync(file, { force: true });
    fs.rmSync(guardFile, { force: true });
  });

  check('a reclaim guard abandoned by a crashed process does not wedge the stale main lock', () => {
    const file = path.join(dir, 'crashed-reclaimer.lock');
    fs.writeFileSync(file, JSON.stringify({
      pid: 921, startedAt: '2026-01-01T00:00:00.000Z', nonce: 'stale-main'
    }));
    fs.writeFileSync(`${file}.reclaiming`, JSON.stringify({
      pid: 922, startedAt: '2026-01-01T00:00:01.000Z', nonce: 'dead-reclaimer'
    }));
    const lock = acquireLock(file, { pid: 923, isAlive: () => false });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, lock.nonce);
    assert.equal(fs.existsSync(`${file}.reclaiming`), false);
    lock.release();
  });

  check('stale-quarantine garbage collection cannot unwind an already-published acquisition', () => {
    const file = path.join(dir, 'stale-quarantine-cleanup-failure.lock');
    fs.writeFileSync(file, JSON.stringify({
      pid: 924, startedAt: '2026-01-01T00:00:00.000Z', nonce: 'dead-legacy'
    }));
    const identities = new Map([
      [925, `win32:${windowsTicks('2026-09-01T10:10:00.000Z')}`],
    ]);
    const originalUnlink = fs.unlinkSync;
    let deniedCleanup = false;
    fs.unlinkSync = function failStaleQuarantineCleanup(candidate) {
      if (!deniedCleanup && path.resolve(candidate).startsWith(path.resolve(file) + '.stale.')) {
        deniedCleanup = true;
        const error = new Error('simulated stale quarantine cleanup denial');
        error.code = 'EPERM';
        throw error;
      }
      return originalUnlink.call(fs, candidate);
    };
    let lock;
    try {
      lock = acquireLock(file, {
        pid: 925,
        isAlive: contenderPid => identities.has(contenderPid),
        getProcessIdentity: contenderPid => identities.get(contenderPid) || null,
        publishGraceMs: 0,
        polls: 0,
      });
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    assert.equal(deniedCleanup, true, 'the stale-quarantine cleanup failure was not injected');
    const status = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(status.nonce, lock.nonce, 'the returned handle does not own the published status');
    assert.ok(fs.existsSync(path.join(`${file}.claims`, status.claimName)),
      'acquisition unwind removed the authoritative claim behind the live-looking fixed status');
    lock.release();
    for (const candidate of fs.readdirSync(dir)) {
      if (candidate.startsWith(`${path.basename(file)}.stale.`)) {
        fs.rmSync(path.join(dir, candidate), { force: true });
      }
    }
  });

  check('an exact process-start identity reclaims a recycled pid without letting the old handle release the replacement', () => {
    const file = path.join(dir, 'recycled-pid.lock');
    let generation = 'win32:638712864000000000';
    const identity = pid => pid === 930 ? generation : null;
    const first = acquireLock(file, {
      pid: 930, isAlive: () => true, getProcessIdentity: identity
    });
    generation = 'win32:638739648000000000';
    const second = acquireLock(file, {
      pid: 930, isAlive: () => true, getProcessIdentity: identity
    });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, second.nonce,
      'the recycled pid remained wedged on its earlier process generation');
    first.release();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, second.nonce,
      'the old same-pid handle released the replacement generation');
    second.release();
  });

  check('recycled pids cannot wedge legacy main or reclaim-guard records', () => {
    const file = path.join(dir, 'legacy-recycled.lock');
    fs.writeFileSync(file, JSON.stringify({
      pid: 931, startedAt: '2026-01-01T00:00:00.000Z', nonce: 'legacy-main'
    }));
    fs.writeFileSync(`${file}.reclaiming`, JSON.stringify({
      pid: 932, startedAt: '2026-01-01T00:00:01.000Z', nonce: 'legacy-guard'
    }));
    const identities = new Map([
      [931, `win32:${windowsTicks('2026-02-01T00:00:00.000Z')}`],
      [932, `win32:${windowsTicks('2026-02-01T00:00:00.000Z')}`],
      [933, `win32:${windowsTicks('2026-01-15T00:00:00.000Z')}`],
    ]);
    const lock = acquireLock(file, {
      pid: 933,
      isAlive: () => true,
      getProcessIdentity: pid => identities.get(pid) || null,
    });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 933);
    assert.equal(fs.existsSync(`${file}.reclaiming`), false,
      'a legacy guard owned by a recycled pid remained wedged');
    lock.release();
  });

  check('a malformed authoritative claim is uncertainty, never permission to acquire', () => {
    const file = path.join(dir, 'malformed-claim.lock');
    const claims = `${file}.claims`;
    const malformed = path.join(claims, 'ticket.1.00000000-0000-4000-8000-000000000001.json');
    fs.mkdirSync(claims, { recursive: true });
    fs.writeFileSync(malformed, JSON.stringify({ pid: 940 }));
    assert.throws(
      () => acquireLock(file, {
        pid: 941, isAlive: () => false, publishGraceMs: 0, polls: 0
      }),
      error => error instanceof AgentDigestLockUnreadableError
        && error.code === 'AGENT_DIGEST_LOCK_UNREADABLE'
    );
    assert.equal(fs.existsSync(malformed), true, 'an unreadable claim was silently deleted');
  });

  check('a zero-byte claim left by a crash remains exactly classifiable by its unique filename', () => {
    const file = path.join(dir, 'zero-byte-claim.lock');
    const claims = `${file}.claims`;
    const oldIdentity = 'win32:638712864000000000';
    const oldHash = crypto.createHash('sha256').update(oldIdentity).digest('hex');
    const crashed = path.join(claims,
      `choosing.e.945.${oldHash}.00000000-0000-4000-8000-000000000045.claim`);
    fs.mkdirSync(claims, { recursive: true });
    fs.writeFileSync(crashed, '', { flag: 'wx' });
    const lock = acquireLock(file, {
      pid: 946,
      isAlive: () => true,
      getProcessIdentity: pid => pid === 945
        ? 'win32:638739648000000000' : 'win32:638721504000000000',
      publishGraceMs: 0,
      polls: 0,
    });
    assert.equal(fs.existsSync(crashed), false,
      'a crashed claim with a recycled pid remained wedged because its body was empty');
    lock.release();
  });

  check('a proven-stale maximum ticket cannot starve all future contenders', () => {
    const file = path.join(dir, 'stale-maximum-ticket.lock');
    const claims = `${file}.claims`;
    const stalePid = 947;
    const staleHash = crypto.createHash('sha256').update(`pid-compat:${stalePid}`).digest('hex');
    const staleClaim = path.join(claims,
      `ticket.${Number.MAX_SAFE_INTEGER}.p.${stalePid}.${staleHash}.00000000-0000-4000-8000-000000000047.claim`);
    fs.mkdirSync(claims, { recursive: true });
    fs.writeFileSync(staleClaim, '', { flag: 'wx' });
    const lock = acquireLock(file, {
      pid: 948,
      isAlive: contenderPid => contenderPid === 948,
      publishGraceMs: 0,
      polls: 0,
    });
    assert.equal(fs.existsSync(staleClaim), false,
      'the dead maximum ticket survived and will overflow every future ticket allocation');
    lock.release();
  });

  check('real simultaneous processes elect exactly one holder', () => {
    const file = path.join(dir, 'multiprocess.lock');
    const gateFile = path.join(dir, 'multiprocess.go');
    const releaseFile = path.join(dir, 'multiprocess.release');
    const modulePath = require.resolve('../src/lib/agent-digest/lock');
    const resultFiles = Array.from({ length: 4 }, (_, index) => path.join(dir, `multiprocess-${index}.json`));
    const doneFiles = resultFiles.map(result => `${result}.done`);
    const childSource = [
      "'use strict';",
      "const fs = require('node:fs');",
      'const [modulePath, lockFile, gateFile, releaseFile, resultFile, doneFile] = process.argv.slice(1);',
      'const { acquireLock } = require(modulePath);',
      'const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
      'let lock = null;',
      'try {',
      '  while (!fs.existsSync(gateFile)) sleep(5);',
      '  lock = acquireLock(lockFile);',
      "  fs.writeFileSync(resultFile, JSON.stringify({ state: 'acquired', pid: process.pid }), { flag: 'wx' });",
      '  while (!fs.existsSync(releaseFile)) sleep(5);',
      '} catch (error) {',
      "  fs.writeFileSync(resultFile, JSON.stringify({ state: 'refused', pid: process.pid, code: error && error.code, message: error && error.message }), { flag: 'wx' });",
      '} finally {',
      '  if (lock) lock.release();',
      "  fs.writeFileSync(doneFile, 'done', { flag: 'wx' });",
      '}',
    ].join('\n');
    const children = resultFiles.map((resultFile, index) => spawn(process.execPath, [
      '-e', childSource, modulePath, file, gateFile, releaseFile, resultFile, doneFiles[index]
    ], { cwd: dir, windowsHide: true, stdio: 'ignore' }));
    try {
      fs.writeFileSync(gateFile, 'go', { flag: 'wx' });
      waitUntil(() => resultFiles.every(resultFile => {
        try { JSON.parse(fs.readFileSync(resultFile, 'utf8')); return true; }
        catch { return false; }
      }), 'the multiprocess contenders did not all publish a result');
      const results = resultFiles.map(resultFile => JSON.parse(fs.readFileSync(resultFile, 'utf8')));
      const acquired = results.filter(result => result.state === 'acquired');
      const refused = results.filter(result => result.state === 'refused');
      assert.equal(acquired.length, 1, `expected one holder, got ${JSON.stringify(results)}`);
      assert.equal(refused.length, 3, `expected three refusals, got ${JSON.stringify(results)}`);
      assert.ok(refused.every(result => result.code === 'AGENT_DIGEST_ALREADY_RUNNING'),
        `a contender failed ambiguously: ${JSON.stringify(results)}`);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, acquired[0].pid,
        'fixed status does not name the elected claim holder');
    } finally {
      fs.writeFileSync(releaseFile, 'release');
      try { waitUntil(() => doneFiles.every(doneFile => fs.existsSync(doneFile)),
        'the multiprocess children did not exit after release', 10_000); } catch { /* assertion below retains evidence */ }
      for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
    }
    assert.equal(fs.existsSync(file), false, 'the elected process left fixed status behind');
    assert.ok(!fs.existsSync(`${file}.claims`) || fs.readdirSync(`${file}.claims`).length === 0,
      'a contender left an authoritative claim behind');
  });

  check('nested directories for the lock path are created on demand, like every other state file here', () => {
    const file = path.join(dir, 'nested', 'deep', 'g.lock');
    const lock = acquireLock(file, { pid: 900, isAlive: () => true });
    assert.ok(fs.existsSync(file));
    lock.release();
  });

  check('pidAlive reflects a real, currently-running process (this test process itself)', () => {
    assert.equal(pidAlive(process.pid), true);
    // A pid this large is astronomically unlikely to exist on any real machine.
    assert.equal(pidAlive(2 ** 30), false);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(-1), false);
    assert.equal(pidAlive(NaN), false);
  });

  check('a custom liveness wrapper cannot downgrade the real process to PID-only ownership', () => {
    const file = path.join(dir, 'real-pid-custom-liveness.lock');
    const lock = acquireLock(file, { isAlive: contenderPid => contenderPid === process.pid });
    const status = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(status.identityMode, 'exact');
    assert.match(status.processStartIdentity, /^(?:win32|linux):/,
      'the real holder did not publish an OS process-generation identity');
    lock.release();
  });

  check('the lock error names the exact holder pid so an operator can diagnose it without guessing', () => {
    const file = path.join(dir, 'h.lock');
    const first = acquireLock(file, { pid: 4242, isAlive: pid => pid === 4242 });
    try {
      acquireLock(file, { pid: 5000, isAlive: pid => pid === 4242 });
      assert.fail('expected AgentDigestLockError');
    } catch (error) {
      assert.match(error.message, /PID 4242/);
      assert.match(error.message, /double-send/);
    }
    first.release();
  });

  process.stdout.write(`Agent digest lock tests passed (${checks} checks: the cross-process double-tick race is closed).\n`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}
