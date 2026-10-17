'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function auditEnv(root, overrides = {}) {
  return { ...process.env, OPENSHELL_SANDBOX: '1', TOOLSENABLED_STATE_ROOT: root,
    TOOLSENABLED_AUDIT_DB: path.join(root, 'state', 'audit.sqlite3'),
    TOOLSENABLED_AUDIT_JSONL_PATH: path.join(root, 'logs', 'actions.jsonl'),
    TOOLSENABLED_AUDIT_TEXT_PATH: path.join(root, 'logs', 'actions.log'),
    TOOLSENABLED_AUDIT_EMERGENCY_PATH: path.join(root, 'logs', 'audit-emergency.jsonl'),
    ...overrides };
}

test('audit tail and verify JSON do not initialize an absent audit store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-audit-view-'));
  const run = (...args) => spawnSync(process.execPath,
    [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'audit', ...args],
    { env: auditEnv(root), encoding: 'utf8' });
  try {
    const tail = run('--json');
    assert.equal(tail.status, 0, tail.stderr);
    const page = JSON.parse(tail.stdout);
    assert.equal(page.schema, 'ai.toolsenabled/fleet-audit/v1');
    assert.deepEqual(page.records, []);
    const verify = run('verify', '--json');
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(JSON.parse(verify.stdout).verification.reason, 'not-initialized');
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('audit pane refuses a DB beyond its bounded scratch-copy budget', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-large-audit-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  const file = path.join(state, 'audit.sqlite3');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'audit', '--json'], {
      env: auditEnv(root), encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /The Fleet audit log is too large to view: .*64 MiB view copy limit/);
    // A size bound is permanent: the hook must not ask the person to reload.
    const hook = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'),
      'fleet-command', '--input', '/fleet/audit', '--surface', 'codex-hook', '--emit'], { env: auditEnv(root), encoding: 'utf8' });
    assert.equal(hook.status, 0, hook.stderr);
    const shown = JSON.parse(hook.stdout);
    assert.match(shown.reason, /audit log is too large to view/);
    assert.doesNotMatch(shown.reason, /unavailable or changed|Reload the view/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('audit verify reads an existing ledger without changing its directory or database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-audit-view-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  const file = path.join(state, 'audit.sqlite3');
  try {
    require('../src/lib/audit-store').createAuditStore({ file }).close();
    const before = fs.readdirSync(state).sort();
    const bytes = fs.readFileSync(file);
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'audit', 'verify', '--json'], {
      env: auditEnv(root), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).verification.valid, true);
    assert.deepEqual(fs.readdirSync(state).sort(), before);
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('audit tail labels rows unverified until explicit verify', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-audit-explicit-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  try {
    require('../src/lib/audit-store').createAuditStore({ file: path.join(state, 'audit.sqlite3') }).close();
    const entry = path.join(__dirname, '../bin/toolsenabled-openshell.js');
    const env = auditEnv(root);
    const tail = spawnSync(process.execPath, [entry, 'audit', '--json'], { env, encoding: 'utf8' });
    assert.equal(tail.status, 0, tail.stderr);
    const page = JSON.parse(tail.stdout);
    assert.equal(page.verification.valid, null);
    assert.equal(page.verification.fresh, false);
    assert.equal(page.verification.reason, 'not-verified');
    assert.match(require('../src/lib/fleet-text-view').render('audit', page, { surface: 'codex-hook' }).title, /\(unverified\)/);
    const verified = spawnSync(process.execPath, [entry, 'audit', 'verify', '--json'], { env, encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).verification.valid, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('audit tail shows a validated cached signed head without a full-chain walk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-audit-head-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  const file = path.join(state, 'audit.sqlite3');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = { keyId: `audit-test-${crypto.randomUUID()}`, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: bytes => crypto.sign(null, bytes, privateKey) };
  try {
    const store = require('../src/lib/audit-store').createAuditStore({ file });
    store.registerKey(signer);
    const { event } = store.appendEvent({ eventId: `audit-test-${crypto.randomUUID()}`, occurredAtMs: 1, createdAtMs: 1,
      event: { timestamp: '1970-01-01T00:00:00.001Z', action: 'probe', target: 'cached-head', details: {} } }, signer);
    store.close();
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'audit', '--json'], {
      env: auditEnv(root), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const page = JSON.parse(result.stdout);
    assert.equal(page.verification.valid, null);
    assert.equal(page.verification.fresh, false);
    assert.equal(page.verification.cachedHead.sequence, event.sequence);
    assert.equal(page.verification.cachedHead.eventHash, event.eventHash);
    const { DatabaseSync } = require('node:sqlite');
    const altered = new DatabaseSync(file);
    altered.prepare("UPDATE audit_events SET signature = ? WHERE sequence = 1")
      .run('A'.repeat(88));
    altered.close();
    const damaged = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'audit', '--json'], {
      env: auditEnv(root), encoding: 'utf8'
    });
    assert.equal(damaged.status, 0, damaged.stderr);
    assert.equal(JSON.parse(damaged.stdout).verification.cachedHead, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('archive verification is explicit and refuses a malformed cold segment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-audit-archive-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  const file = path.join(state, 'audit.sqlite3');
  try {
    require('../src/lib/audit-store').createAuditStore({ file }).close();
    fs.writeFileSync(path.join(state, 'audit-archive.jsonl'), 'not-json\n');
    const run = (...args) => spawnSync(process.execPath,
      [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'audit', 'verify', '--json', ...args],
      { env: auditEnv(root), encoding: 'utf8' });
    const ordinary = run();
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.equal(JSON.parse(ordinary.stdout).archive, null);
    const explicit = run('--include-archive');
    assert.equal(explicit.status, 1);
    assert.equal(JSON.parse(explicit.stdout).archive.valid, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('archive larger than the pane bound is not checked without failing hot verification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-audit-large-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  try {
    require('../src/lib/audit-store').createAuditStore({ file: path.join(state, 'audit.sqlite3') }).close();
    const archiveFile = path.join(state, 'audit-archive.jsonl');
    fs.writeFileSync(archiveFile, '');
    fs.truncateSync(archiveFile, 16 * 1024 * 1024 + 1);
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'),
      'audit', 'verify', '--include-archive', '--json'], {
      env: auditEnv(root), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const page = JSON.parse(result.stdout);
    assert.equal(page.verification.valid, true);
    assert.equal(page.archive.valid, null);
    assert.match(page.archive.reason, /not-checked/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('audit verify revision changes when projection verification changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-audit-revision-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  try {
    require('../src/lib/audit-store').createAuditStore({ file: path.join(state, 'audit.sqlite3') }).close();
    const entry = path.join(__dirname, '../bin/toolsenabled-openshell.js');
    const env = auditEnv(root);
    const first = spawnSync(process.execPath, [entry, 'audit', 'verify', '--json'], { env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const revision = JSON.parse(first.stdout).revision;
    fs.mkdirSync(path.join(root, 'logs'));
    fs.writeFileSync(path.join(root, 'logs', 'actions.jsonl'), 'invalid-projection\n');
    const stale = spawnSync(process.execPath, [entry, 'audit', 'verify', '--json', '--revision', revision], { env, encoding: 'utf8' });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /view changed/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('audit override verification never initializes an unrelated selected state root', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-audit-override-'));
  const root = path.join(scratch, 'absent-state');
  const file = path.join(scratch, 'audit.sqlite3');
  try {
    require('../src/lib/audit-store').createAuditStore({ file }).close();
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/toolsenabled-openshell.js'), 'audit', 'verify', '--json'], {
      env: auditEnv(root, { TOOLSENABLED_AUDIT_DB: file }), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(root), false);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

// A real engine-signed chain (derived audit-ed25519 key id, projections and
// vault in the scratch root), tampered on a copy in each way a reader of the
// tail could be misled. The cached head may only ever be described as a
// cached head; "verified" belongs to a full verification.
function buildSignedChain(root, count) {
  const audit = path.join(__dirname, '../src/lib/audit.js');
  const built = spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(audit)}).recordBatch(Array.from({ length: ${count} }, (_, i) => ` +
    "({ action: 'task.list', target: 'fleet', details: { i } })));"], { env: auditEnv(root), encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
}

function tamperChain(file, mode) {
  const store = require('../src/lib/audit-store');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    const head = db.prepare('SELECT * FROM audit_events ORDER BY sequence DESC LIMIT 1').get();
    const middle = db.prepare('SELECT * FROM audit_events ORDER BY sequence LIMIT 1 OFFSET 9').get();
    if (mode === 'mid-content') {
      const event = JSON.parse(middle.event_json); event.target = 'changed-middle';
      db.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = ?').run(store.canonicalJson(event), middle.sequence);
    } else if (mode === 'mid-delete') {
      db.prepare('DELETE FROM audit_events WHERE sequence = ?').run(middle.sequence);
    } else if (mode === 'head-signature') {
      db.prepare('UPDATE audit_events SET signature = ? WHERE sequence = ?').run(`${'A'.repeat(86)}==`, head.sequence);
    } else if (mode === 'head-content') {
      const event = JSON.parse(head.event_json); event.target = 'changed-head';
      db.prepare('UPDATE audit_events SET event_json = ? WHERE sequence = ?').run(store.canonicalJson(event), head.sequence);
    } else if (mode === 'keyswap-head-forged') {
      // Other key material under the SAME derived key id, then a head signed by it.
      assert.match(head.key_id, /^audit-ed25519-/);
      const other = crypto.generateKeyPairSync('ed25519');
      const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      db.prepare('UPDATE audit_keys SET public_key_pem = ?, public_key_hash = ? WHERE key_id = ?')
        .run(otherPem, store.publicKeyHash(otherPem).hash, head.key_id);
      const event = JSON.parse(head.event_json); event.target = 'forged-head'; event.action = 'ledger.apply.intent';
      const eventJson = store.canonicalJson(event);
      const eventHash = store.sha256(store.eventHashInput({ sequence: head.sequence, eventId: head.event_id,
        occurredAtMs: head.occurred_at_ms, eventJson, previousHash: head.previous_hash, keyId: head.key_id,
        createdAtMs: head.created_at_ms }));
      const signature = crypto.sign(null, Buffer.from(eventHash, 'hex'), other.privateKey).toString('base64');
      db.prepare('UPDATE audit_events SET event_json = ?, event_hash = ?, signature = ? WHERE sequence = ?')
        .run(eventJson, eventHash, signature, head.sequence);
    } else if (mode === 'drop-head') {
      db.prepare('DELETE FROM audit_events WHERE sequence = ?').run(head.sequence);
    } else if (mode !== 'none') throw new Error(`unknown tamper mode ${mode}`);
  } finally { db.close(); }
}

test('audit tail never says verified from the cached head and keeps a marker on tampered chains', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-audit-tamper-'));
  const entry = path.join(__dirname, '../bin/toolsenabled-openshell.js');
  const base = path.join(scratch, 'base');
  const problems = [];
  const check = (ok, mode, what) => { if (!ok) problems.push(`${mode}: ${what}`); };
  try {
    buildSignedChain(base, 30);
    const cases = [
      ['none', null, false],
      ['mid-content', 'event-hash', false],
      ['mid-delete', 'sequence-gap', false],
      ['head-signature', 'signature', true],
      ['head-content', 'event-hash', true],
      ['keyswap-head-forged', 'public-key-identity', true],
      ['drop-head', 'sink-ahead-of-head', false]
    ];
    for (const [mode, verifyReason, headRejected] of cases) {
      const root = path.join(scratch, mode);
      fs.cpSync(base, root, { recursive: true });
      tamperChain(path.join(root, 'state', 'audit.sqlite3'), mode);
      const env = auditEnv(root);
      const run = (...args) => spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 30000 });
      const firstLine = value => String(value).split('\n')[0];

      // The full verifier is the reference: it must see every tamper.
      const verified = run('audit', 'verify', '--json');
      const verification = JSON.parse(verified.stdout).verification;
      if (verifyReason === null) {
        assert.equal(verified.status, 0, `${mode}: ${verified.stderr}`);
        assert.equal(verification.valid, true, mode);
      } else {
        assert.equal(verified.status, 1, mode);
        assert.equal(verification.valid, false, mode);
        assert.equal(verification.reason, verifyReason, mode);
      }

      const tail = run('audit', '--json');
      assert.equal(tail.status, 0, `${mode}: ${tail.stderr}`);
      const page = JSON.parse(tail.stdout);
      check(page.verification.valid === null, mode, `tail JSON valid=${page.verification.valid}`);
      if (headRejected) {
        check(page.verification.cachedHead === null, mode,
          `tail JSON accepted cached head ${JSON.stringify(page.verification.cachedHead?.sequence)}`);
        check(page.verification.reason === 'signed-head-invalid', mode, `tail JSON reason ${page.verification.reason}`);
      }

      const human = run('audit');
      assert.equal(human.status, 0, `${mode}: ${human.stderr}`);
      const claim = human.stdout.match(/^.*\bverified event.*$/m);
      check(!claim, mode, `human tail says "${claim && claim[0]}"`);
      check(new RegExp(`^${page.total} event\\(s\\), not verified$`, 'm').test(human.stdout), mode,
        'human tail lacks "N event(s), not verified"');

      const marker = headRejected ? /^Fleet · Audit \(head signature invalid\) · / : /^Fleet · Audit \(unverified\) · /;
      const text = run('audit', '--text');
      assert.equal(text.status, 0, `${mode}: ${text.stderr}`);
      check(marker.test(text.stdout), mode, `--text title "${firstLine(text.stdout)}"`);
      const hook = run('fleet-command', '--input', '/fleet/audit', '--surface', 'codex-hook', '--emit');
      assert.equal(hook.status, 0, `${mode}: ${hook.stderr}`);
      const shown = JSON.parse(hook.stdout);
      assert.equal(shown.decision, 'block', mode);
      check(marker.test(shown.reason), mode, `codex hook title "${firstLine(shown.reason)}"`);
    }
    assert.deepEqual(problems, []);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('audit verify --text always prints its verdict, passing or failed', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-audit-verdict-'));
  const entry = path.join(__dirname, '../bin/toolsenabled-openshell.js');
  try {
    const clean = path.join(scratch, 'clean');
    buildSignedChain(clean, 12);
    const changed = path.join(scratch, 'changed');
    fs.cpSync(clean, changed, { recursive: true });
    tamperChain(path.join(changed, 'state', 'audit.sqlite3'), 'mid-content');
    for (const surface of ['plain', 'console']) {
      const passed = spawnSync(process.execPath, [entry, 'audit', 'verify', '--text', '--surface', surface],
        { env: auditEnv(clean), encoding: 'utf8' });
      assert.equal(passed.status, 0, passed.stderr);
      assert.match(passed.stdout, /^Verify: ledger and projections valid \(anchor not checked\)$/m, surface);
      const failed = spawnSync(process.execPath, [entry, 'audit', 'verify', '--text', '--surface', surface],
        { env: auditEnv(changed), encoding: 'utf8' });
      assert.equal(failed.status, 1, surface);
      assert.match(failed.stdout, /^Fleet · Audit \(verification FAILED\) · /, surface);
      assert.match(failed.stdout, /^Verify: FAILED \(event-hash\)$/m, surface);
      assert.doesNotMatch(failed.stdout, /Nothing in this view/, surface);
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('audit tail projection excludes event details and caps untrusted fields', () => {
  const { projectEvent } = require('../src/lib/fleet-audit-view');
  const row = projectEvent({ sequence: 1, eventId: 'event-0001', eventHash: 'a'.repeat(64),
    keyId: 'key-0001', occurredAtMs: 1,
    event: { action: 'probe', target: 'x', details: { private: 'marker-never-display' } } });
  assert.equal(row.action, 'probe');
  assert.equal(JSON.stringify(row).includes('marker-never-display'), false);
});
