'use strict';

// THE CHECKPOINT MECHANISM IS NOT THE POINT; ITS INVOCATION PATH IS.
//
// tests/audit-checkpoint.test.js already proves createCheckpoint/emitCheckpoint
// are correct. They were correct the whole time, and never ran: on 2026-08-10
// the production audit head anchor was advanced onto an event that exists only
// in a scratch fork, and "fork or truncation?" could only be answered because
// that scratch copy happened to still be on disk. A checkpoint would have
// answered it from a signed head hash.
//
// So this suite asserts the things a correctness test cannot: that something
// which already runs calls it, that the repeated-run floor holds, and -- the
// one that matters most -- that a FAILING checkpoint is not swallowed. A
// checkpointer that fails quietly is worse than no checkpointer, because it
// converts "we have no evidence" into "we believe we have evidence".

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const observer = require('../tools/health-observer.js');
const audit = require('../src/lib/audit.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-wiring-'));
}

function fakeCheckpoint(headSequence) {
  return async ({ outboxDir }) => {
    fs.mkdirSync(outboxDir, { recursive: true });
    const file = path.join(outboxDir, `${Date.now()}-fake-${headSequence}.checkpoint.json`);
    fs.writeFileSync(file, '{}\n', 'utf8');
    return {
      ok: true, file, pendingDelivery: true,
      checkpoint: { body: { headSequence, headHash: 'a'.repeat(64) } }
    };
  };
}

async function main() {
  let failures = 0;
  const fail = (message) => { failures += 1; process.stderr.write(`FAIL ${message}\n`); };

  // 1. The real audit module exposes a checkpoint entry point at all. Without
  //    this the library is unreachable from production by construction.
  assert.equal(typeof audit.checkpoint, 'function', 'audit.checkpoint must exist');

  // 2. audit.checkpoint() must NOT route through prepare(). prepare() reconciles
  //    the head anchor, and reconcileAnchor is what throws
  //    AUDIT_ANCHOR_INTEGRITY_ALARM. A checkpointer that needed it would be
  //    unavailable exactly when its evidence is most needed. Asserted on the
  //    source rather than by execution, because executing prepare() here would
  //    mutate the real ledger.
  const auditSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'audit.js'), 'utf8');
  const body = auditSource.slice(auditSource.indexOf('function checkpoint('));
  const checkpointBody = body.slice(0, body.indexOf('\nfunction '));
  if (/\bprepare\s*\(/.test(checkpointBody)) fail('audit.checkpoint() must not call prepare()');
  if (!/assertLedgerVaultBinding/.test(checkpointBody)) {
    fail('audit.checkpoint() must keep the ledger/vault binding guard');
  }

  // 3. The observer actually emits, and reports the head it captured.
  {
    const outboxDir = path.join(tempDir(), 'outbox');
    const logged = [];
    const result = await observer.emitAuditCheckpoint({
      auditApi: { checkpoint: fakeCheckpoint(4242) },
      outboxDir, now: Date.now(), log: entry => logged.push(entry), warn: () => {}
    });
    if (result.status !== 'emitted') fail(`expected emitted, got ${result.status}`);
    if (result.headSequence !== 4242) fail('emitted checkpoint must report its head sequence');
    if (fs.readdirSync(outboxDir).length !== 1) fail('a checkpoint file must reach the outbox');
    if (logged.length !== 1 || logged[0].event !== 'audit-checkpoint' || logged[0].headSequence !== 4242) {
      fail('an emitted checkpoint must be recorded in the observer log');
    }
    fs.rmSync(path.dirname(outboxDir), { recursive: true, force: true });
  }

  // 4. The interval floor is read from the OUTBOX, not from a timer, so a
  //    restarted observer cannot turn a 15-minute cadence into a hot loop
  //    around a multi-second full-chain verification.
  {
    const outboxDir = path.join(tempDir(), 'outbox');
    const now = Date.now();
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, `${now - 60_000}-recent.checkpoint.json`), '{}\n', 'utf8');
    let called = false;
    const result = await observer.emitAuditCheckpoint({
      auditApi: { checkpoint: async () => { called = true; return {}; } },
      outboxDir, now, log: () => {}, warn: () => {}
    });
    if (result.status !== 'skipped') fail(`a fresh checkpoint must skip, got ${result.status}`);
    if (called) fail('the floor must be enforced before the ledger is verified');
    fs.rmSync(path.dirname(outboxDir), { recursive: true, force: true });
  }

  // 5. THE LOAD-BEARING ONE. A failure is surfaced on every channel, not
  //    swallowed: returned as failed, written to stderr, and escalated into
  //    the owner directive inbox -- pointed at a temp inbox so this test can
  //    exercise real escalation without writing to the owner's actual inbox.
  {
    const directory = tempDir();
    const outboxDir = path.join(directory, 'outbox');
    const inboxFile = path.join(directory, 'directives.jsonl');
    const warnings = [];
    const result = await observer.emitAuditCheckpoint({
      auditApi: {
        checkpoint: async () => {
          throw Object.assign(new Error('Refusing to checkpoint an invalid audit chain.'),
            { code: 'AUDIT_CHECKPOINT_CHAIN_INVALID' });
        }
      },
      outboxDir, now: Date.now(), inboxOverrides: { inboxFile },
      log: () => {}, warn: message => warnings.push(message)
    });
    if (result.status !== 'failed') fail(`a throwing checkpointer must report failed, got ${result.status}`);
    if (result.code !== 'AUDIT_CHECKPOINT_CHAIN_INVALID') fail('the failure code must survive to the caller');
    if (warnings.length !== 1 || !warnings[0].includes('AUDIT_CHECKPOINT_CHAIN_INVALID')) {
      fail('a checkpoint failure must be written to stderr');
    }
    if (!fs.existsSync(inboxFile) || !fs.readFileSync(inboxFile, 'utf8').includes('AUDIT_CHECKPOINT_CHAIN_INVALID')) {
      fail('a checkpoint failure must be escalated to the owner directive inbox');
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }

  // 6. A never-checkpointed installation reads as "no checkpoint", never as
  //    "recent enough". Failing open here would silently retire the mechanism.
  {
    const directory = tempDir();
    assert.equal(observer.newestCheckpointAgeMs(Date.now(), { outboxDir: path.join(directory, 'nope') }), null);
    fs.rmSync(directory, { recursive: true, force: true });
  }

  if (failures > 0) {
    process.stderr.write(`audit checkpoint wiring: ${failures} failure(s)\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('audit checkpoint wiring: 6 checks; 0 failures\n');
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
