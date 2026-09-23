'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { createMissionBridgeServer } = require('../src/lib/mission-bridge/server');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

const org = declaredOrg();
const actor = enabledControllerId(org);
const planSha256 = 'a'.repeat(64);
const requestTarget = Object.freeze({ targetKind: 'request', requestId: 'R54' });
const ruleTarget = Object.freeze({ targetKind: 'rule', requestId: 'R55', ruleKey: 'fixture.rule' });
let checks = 0;
function equal(actual, expected, message) { checks += 1; assert.deepEqual(actual, expected, message); }
async function rejects(work, code) { checks += 1; await assert.rejects(work, error => error?.code === code, `expected ${code}`); }

function archiveResult({ operation, dryRun }) {
  const candidates = [{ ...requestTarget, reason: { code: 'completed', detail: 'status done and every declared gate is met:true', supersedingRequestIds: [] } }];
  const restorables = operation === 'restore' ? [requestTarget, ruleTarget] : [];
  return { planSha256, candidates, restorables, inconsistencies: [{ id: 'R56', code: 'DONE_WITH_UNMET_GATE', reason: 'status is done but gate 1 is not met:true; retained in the active ledger' }], activeCount: dryRun ? 3 : 2, archiveCount: dryRun ? 0 : 1, dryRun, appliedTarget: dryRun ? null : (operation === 'restore' ? ruleTarget : requestTarget), changedCount: dryRun ? 0 : 1 };
}
function auditFixture() {
  const events = [];
  return { events, requireRecord(action, target, details) { const sequence = events.length + 1; const eventHash = crypto.createHash('sha256').update(JSON.stringify({ action, target, details, sequence })).digest('hex'); events.push({ action, target, details, sequence, eventHash }); return { durable: true, anchored: true, sequence, eventHash }; } };
}
async function post(baseUrl, token, body) { const response = await fetch(`${baseUrl}/v1/actions/ledger-archive`, { method: 'POST', headers: { origin: 'http://127.0.0.1:4600', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ledger-archive-'));
  const runtimeFile = path.join(root, 'runtime.json'); const audit = auditFixture(); const policyCalls = []; const archiveCalls = [];
  const actions = createMissionActions({ roots: { primary: root }, actor, audit, clock: () => Date.parse('2026-08-07T12:00:00.000Z'), policy: { assertActive(action, options) { policyCalls.push({ action, options }); } }, archiveLedger(input) { archiveCalls.push(input); if (!input.dryRun) { assert.equal(input.retiredBy, actor); assert.deepEqual(input.target, requestTarget); } return archiveResult(input); } });
  try {
    const noPreview = createMissionActions({ roots: { primary: root }, actor, audit, policy: { assertActive() {} }, archiveLedger(input) { return archiveResult(input); } });
    await rejects(() => noPreview.ledgerArchive({ operation: 'archive', dryRun: false, target: requestTarget }), 'BRIDGE_LEDGER_ARCHIVE_CONFIRMATION_REQUIRED');

    const preview = await actions.ledgerArchive({ operation: 'archive', dryRun: true, target: requestTarget });
    equal(preview.receipt.action, 'ledger-archive', 'preview returns the one typed lifecycle action');
    equal(preview.receipt.candidates.map(item => item.requestId), ['R54'], 'preview returns bounded per-target candidates');
    equal(audit.events.at(-1).action, 'owner.request.ledger.archive.preview', 'archive preview is durably audited');
    const moved = await actions.ledgerArchive({ operation: 'archive', dryRun: false, target: requestTarget });
    equal(moved.receipt.appliedTarget, requestTarget, 'execution applies only the admitted exact target');
    equal(moved.receipt.changedCount, 1, 'execution reports one mutation');
    equal(archiveCalls.slice(-2), [{ operation: 'archive', dryRun: true }, { operation: 'archive', dryRun: false, expectedPlanSha256: planSha256, target: requestTarget, retiredBy: actor }], 'bridge injects its trusted actor and never takes it from public input');
    equal(policyCalls.every(call => call.action === 'mission.bridge.ledger-archive' && call.options.outward === true), true, 'every lifecycle request checks policy');
    equal(audit.events.at(-1).details.appliedTarget, requestTarget, 'audit records the exact target only');

    await rejects(() => actions.ledgerArchive({ operation: 'archive', dryRun: false, target: { targetKind: 'request', requestId: 'R54', ids: ['R54'] } }), 'BRIDGE_INPUT_INVALID');
    await rejects(() => actions.ledgerArchive({ operation: 'archive', dryRun: false, target: requestTarget, retiredBy: 'attacker' }), 'BRIDGE_INPUT_INVALID');
    await rejects(() => actions.ledgerArchive({ operation: 'archive', dryRun: false, target: requestTarget }), 'BRIDGE_LEDGER_ARCHIVE_CONFIRMATION_REQUIRED');

    const restoreCalls = [];
    const restoreActions = createMissionActions({ roots: { primary: root }, actor, audit, policy: { assertActive() {} }, archiveLedger(input) { restoreCalls.push(input); return archiveResult(input); } });
    await restoreActions.ledgerArchive({ operation: 'restore', dryRun: true, target: ruleTarget });
    const restored = await restoreActions.ledgerArchive({ operation: 'restore', dryRun: false, target: ruleTarget });
    equal(restored.receipt.appliedTarget, ruleTarget, 'restore uses the same per-target lifecycle vocabulary');
    equal(restoreCalls.at(-1), { operation: 'restore', dryRun: false, expectedPlanSha256: planSha256, target: ruleTarget, retiredBy: actor }, 'restore preserves trusted actor injection');

    let guardedCalls = 0;
    const guarded = createMissionActions({ roots: { primary: root }, actor, audit, policy: { assertActive(_action, options) { if (options.outward) throw new Error('kill switch active'); } }, archiveLedger() { guardedCalls += 1; return archiveResult({ operation: 'archive', dryRun: true }); } });
    await rejects(() => guarded.ledgerArchive({ operation: 'archive', dryRun: true, target: requestTarget }), 'BRIDGE_GUARD_REFUSED');
    equal(guardedCalls, 0, 'guard refusal happens before the lifecycle mechanism is called');

    const tokenBuffer = crypto.randomBytes(32); const bootstrapProof = crypto.randomBytes(32); const bridge = createMissionBridgeServer({ token: tokenBuffer, bootstrapProof, allowedOrigins: ['http://127.0.0.1:4600'], actions, runtimeFile, allowTestRuntimeFile: true, allowTestPortZero: true, runtimeDependencies: { platform: 'test' } });
    const address = await bridge.listen(0);
    try {
      const bootstrapResponse = await fetch(`${address.baseUrl}/v1/bootstrap?proof=${bootstrapProof.toString('base64url')}`, { headers: { origin: 'http://127.0.0.1:4600' } }); const bootstrap = await bootstrapResponse.json();
      equal(bootstrap.capabilities.includes('ledger-archive'), true, 'loopback bootstrap retains the named lifecycle route');
      const response = await post(address.baseUrl, bootstrap.token, { operation: 'archive', dryRun: true, target: requestTarget });
      equal(response.status, 200, 'authorized loopback route reaches the bounded preview');
      equal(response.body.receipt.action, 'ledger-archive', 'server returns the typed lifecycle receipt');
      const malformed = await post(address.baseUrl, bootstrap.token, { operation: 'archive', dryRun: true, target: { targetKind: 'request', requestId: 'R54', ids: ['R54'] } });
      equal(malformed.status, 400, 'server refuses bulk-shaped targets');
      equal(malformed.body.error.code, 'BRIDGE_INPUT_INVALID', 'bulk target refusal remains typed');
    } finally { await bridge.close(); }
    process.stdout.write(`mission-bridge-ledger-archive: ${checks} checks passed\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { process.stderr.write(`${error?.code || 'ERROR'}: ${error.stack || error}\n`); process.exitCode = 1; });
