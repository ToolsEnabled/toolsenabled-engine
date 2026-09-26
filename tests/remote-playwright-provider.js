'use strict';

const assert = require('node:assert/strict');
const { normalizeRequest } = require('../src/lib/providers/remote-playwright');

assert.deepEqual(normalizeRequest({ name: 'browser_snapshot', arguments: {} }), {
  tool: 'browser_snapshot', arguments: {}
});
assert.throws(() => normalizeRequest({ name: 'browser_evaluate', arguments: {} }),
  error => error && error.code === 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL');
assert.throws(() => normalizeRequest({ name: 'browser_navigate', arguments: { url: 'file:///secret' } }),
  error => error && error.code === 'BROWSER_NAVIGATION_URL_FORBIDDEN');

console.log('Remote Playwright provider boundary tests passed.');

// Execute both shipping producers and the real optional-policy facade. Only
// persisted configuration, the canonical writer and browser/transport I/O are
// injected. No browser, process, owner setting or audit store is opened.
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { resolveRuntimePolicy } = require('../src/lib/runtime-policy');
function browserFixture(initiallyEnabled = false) {
  let invalid = false, enabled = initiallyEnabled, refusal = false, activeError = null, sequence = 0;
  let transport = async () => ({ response: { result: { content: [{ type: 'text', text: 'page' }] } } });
  const audits = [], calls = [], upstream = [], client = [], retirements = [];
  const sentinel = () => Object.assign(Error('Synthetic audit unavailable.'), { code: 'TEST_AUDIT_UNAVAILABLE' });
  const canonical = {
    redact: value => value,
    requireRecord(action, target, details) {
      audits.push({ action, target, details, required: true });
      if (refusal) throw sentinel();
      return { durable: true, signed: true, eventId: 'event-' + (++sequence) };
    },
    record(action, target, details) {
      audits.push({ action, target, details, required: false });
      if (refusal) throw sentinel();
      return { durable: true, signed: true, eventId: 'event-' + (++sequence) };
    }
  };
  function load(relative, stubs) {
    const file = path.join(__dirname, '..', relative), localRequire = createRequire(file);
    const source = fs.readFileSync(file, 'utf8').replace(/^#![^\n]*\n/, '\n');
    const module = { exports: {} };
    vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + source + '\n})', { filename: file })(
      spec => Object.hasOwn(stubs, spec) ? stubs[spec] : localRequire(spec), module, module.exports, file, path.dirname(file));
    return module.exports;
  }
  const operation = load('src/lib/operation-audit.js', {
    './runtime-policy': { runtimePolicy: () => resolveRuntimePolicy({ values: { 'audit.enabled': enabled },
      provenance: { 'audit.enabled': { source: 'user' } }, rejected: invalid ? [{ id: 'audit.enabled' }] : [] }) },
    './audit-admission': { retireDefaultAdmissionQueue: async () => { retirements.push(true); } },
    './audit': canonical
  });
  const assertActive = () => { if (activeError) throw Object.assign(Error(activeError), { code: activeError }); };
  const gateway = load('src/playwright-gateway.js', {
    './lib/audit': canonical, './lib/operation-audit': operation, './lib/policy': { assertActive }
  });
  const provider = load('src/lib/providers/remote-playwright.js', {
    '../audit': canonical, '../operation-audit': operation,
    '../browser-owner': { status: () => ({ owned: true, generation: 'synthetic-owned-browser' }) },
    '../policy': { assertActive },
    '../../../tools/playwright-call': {
      validateRequestObject: require('../tools/playwright-call').validateRequestObject,
      listTools: async () => { calls.push('tools'); return [{ name: 'browser_snapshot' }]; },
      executeOneShot: async request => { calls.push(request); return transport(); },
      PlaywrightSession: class { constructor() { throw Error('Unexpected persistent browser transport'); } }
    }, '../../playwright-gateway': gateway
  });
  const session = gateway.createGatewaySession({
    writeUpstream: line => upstream.push(JSON.parse(line)),
    writeClient: line => client.push(JSON.parse(line))
  });
  return { provider, gateway, session, operation, audits, calls, upstream, client, retirements,
    setInvalid: () => { invalid = true; }, setEnabled: value => { enabled = value; }, refuseAudit: () => { refusal = true; },
    refuseActive: code => { activeError = code; }, setTransport: value => { transport = value; } };
}
const requestLine = (id, name = 'browser_snapshot', args = {}, extra = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args }, ...extra });
const responseLine = (id, result = { content: [{ type: 'text', text: 'page' }] }) =>
  JSON.stringify({ jsonrpc: '2.0', id, result });
const tabsResult = count => ({ content: [{ type: 'text', text: Array.from({ length: count }, (_, i) => '- ' + i + ': tab').join('\n') }] });

test('Basic browser discovery, status and snapshot never enter canonical audit', async () => {
  const f = browserFixture(); f.refuseAudit();
  assert.equal(f.provider.status().owned, true);
  assert.deepEqual((await f.provider.tools()).tools, [{ name: 'browser_snapshot' }]);
  const result = await f.provider.call({ name: 'browser_snapshot', arguments: {} });
  assert.equal(result.ok, true);
  assert.equal(result[Symbol.for('toolsenabled.playwright.result')].content[0].text, 'page');
  assert.deepEqual(f.audits, []);
  assert.equal(f.calls.length, 2);
});

for (const required of [false, true]) test('browser facade retains its admitted policy through a toggle: ' + required, async () => {
  const f = browserFixture(required); let release;
  f.setTransport(() => new Promise(resolve => { release = resolve; }));
  const pending = f.provider.call({ name: 'browser_snapshot', arguments: {}, auditPolicy: { required: !required } });
  assert.equal(f.calls.length, 1);
  f.setEnabled(!required);
  release({ response: { result: { isError: true, content: [{ type: 'text', text: 'refused by browser' }] } } });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.recovery, /Never automatically replay/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.audits.map(x => x.action), required
    ? ['browser.playwright_call.intent', 'browser.playwright_call.result'] : []);
  await f.provider.tools();
  assert.equal(f.audits.length, 2, 'only the request admitted while audit was enabled records a pair');
});

test('required facade intent refusal stops before dispatch and permission remains independent', async () => {
  const f = browserFixture(true); f.refuseAudit();
  await assert.rejects(f.provider.call({ name: 'browser_snapshot', arguments: {} }), { code: 'TEST_AUDIT_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
  const basic = browserFixture(); basic.refuseActive('BROWSER_SESSION_CHANGED');
  await assert.rejects(basic.provider.call({ name: 'browser_snapshot', arguments: {} }), { code: 'BROWSER_SESSION_CHANGED' });
  assert.equal(basic.calls.length, 0); assert.deepEqual(basic.audits, []);
});

for (const required of [false, true]) test('gateway keeps request policy for delayed matching completion: ' + required, () => {
  const f = browserFixture(required);
  f.session.clientLine(requestLine(1, 'browser_snapshot', {}, { auditPolicy: { required: !required } }));
  assert.equal(f.upstream.length, 1); assert.equal(f.session.pendingCount(), 1);
  f.setEnabled(!required);
  f.session.serverLine(responseLine('wrong-id'));
  assert.equal(f.session.pendingCount(), 1);
  f.session.serverLine(responseLine(1));
  assert.equal(f.session.pendingCount(), 0);
  assert.deepEqual(f.audits.map(x => x.action), required ? ['playwright.tool.intent', 'playwright.tool.succeeded'] : []);
  if (required) assert.equal(f.audits[1].details.intentEventId, 'event-1');
  f.session.serverLine(responseLine(1));
  assert.equal(f.upstream.length, 1);
  assert.equal(f.audits.length, required ? 2 : 0);
});

for (const required of [false, true]) test('gateway preserves tab-close policy across live preflight and terminal cleanup: ' + required, async () => {
  const f = browserFixture(required);
  const pending = f.session.clientLine(requestLine('close', 'browser_tabs', { action: 'close' }));
  assert.equal(f.upstream.length, 1);
  const query = f.upstream[0]; assert.equal(query.params.arguments.action, 'list');
  f.setEnabled(!required);
  f.session.serverLine(responseLine(query.id, tabsResult(2)));
  await pending;
  assert.equal(f.upstream.length, 2); assert.equal(f.upstream[1].id, 'close');
  assert.equal(f.client.length, 0, 'the internal preflight remains private');
  f.session.upstreamClosed(1);
  assert.equal(f.session.pendingCount(), 0);
  assert.deepEqual(f.audits.map(x => x.action), required ? ['playwright.tool.intent', 'playwright.tool.failed'] : []);
  if (required) assert.equal(f.audits[1].details.intentEventId, 'event-1');
  f.session.upstreamClosed(1);
  assert.equal(f.audits.length, required ? 2 : 0);
  assert.equal(f.upstream.length, 2, 'unknown close is never replayed');
});

test('Basic gateway still refuses unsafe calls, missing owner request, duplicate IDs and changed ownership', async () => {
  const f = browserFixture();
  for (const [id, name, args, code] of [
    [1, 'browser_evaluate', { function: '() => 1' }, 'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL'],
    [2, 'browser_file_upload', { paths: ['report.pdf'] }, 'EGRESS_GATES_REQUIRED']
  ]) {
    f.session.clientLine(requestLine(id, name, args));
    assert.equal(f.upstream.length, 0);
    assert.equal(f.client.at(-1).result.structuredContent.error.code, code);
  }
  f.session.clientLine(requestLine(3));
  f.session.clientLine(requestLine(3));
  assert.equal(f.upstream.length, 1);
  assert.equal(f.client.at(-1).result.structuredContent.error.code, 'JSONRPC_DUPLICATE_ID');
  f.refuseActive('BROWSER_SESSION_CHANGED');
  f.session.clientLine(requestLine(4));
  assert.equal(f.upstream.length, 1);
  assert.equal(f.client.at(-1).result.structuredContent.error.code, 'BROWSER_SESSION_CHANGED');
  f.session.upstreamClosed(1);
  assert.deepEqual(f.audits, []);
});

test('gateway requires either a genuine intent ID or the exact admitted Basic receipt', () => {
  const f = browserFixture();
  for (const invalid of [
    { eventId: null }, { eventId: '', durable: true },
    { ...f.operation.skippedStatus('playwright.tool.intent', 'browser_snapshot'), target: 'wrong' },
    { ...f.operation.skippedStatus('playwright.tool.intent', 'browser_snapshot'), signed: true }
  ]) {
    const forwarded = [], responses = [];
    const session = f.gateway.createGatewaySession({
      auditApi: { requireRecord: () => invalid, record() {} },
      assertActiveFn() {}, writeUpstream: line => forwarded.push(line), writeClient: line => responses.push(JSON.parse(line))
    });
    session.clientLine(requestLine(1));
    assert.equal(forwarded.length, 0);
    assert.equal(responses[0].result.structuredContent.error.code, 'AUDIT_INVALID_RESULT');
  }
  f.setEnabled(true); f.refuseAudit();
  f.session.clientLine(requestLine(2));
  assert.equal(f.upstream.length, 0);
  assert.equal(f.client[0].result.structuredContent.error.code, 'TEST_AUDIT_UNAVAILABLE');
});

test('browser request inherits a previously admitted registry policy rather than rereading a later choice', async () => {
  const f = browserFixture(true), admitted = f.operation.capturePolicy()
  f.setEnabled(false)
  await f.operation.withPolicy(admitted, () => f.provider.call({ name: 'browser_snapshot', arguments: {} }))
  assert.deepEqual(f.audits.map(x => x.action), ['browser.playwright_call.intent', 'browser.playwright_call.result'])
  assert.equal(f.calls.length, 1)
})

test('unknown trusted browser audit configuration refuses before transport or optional writer', async () => {
  const f = browserFixture(); f.setInvalid()
  assert.throws(() => f.provider.status(), { code: 'AUDIT_POLICY_INVALID' })
  await assert.rejects(f.provider.tools(), { code: 'AUDIT_POLICY_INVALID' })
  await assert.rejects(f.provider.call({ name: 'browser_snapshot', arguments: {} }), { code: 'AUDIT_POLICY_INVALID' })
  f.session.clientLine(requestLine('unknown', 'browser_snapshot', {}, { auditPolicy: { required: false } }))
  assert.equal(f.client[0].result.structuredContent.error.code, 'AUDIT_POLICY_INVALID')
  assert.equal(f.session.pendingCount(), 0)
  assert.deepEqual([f.upstream.length, f.calls.length, f.audits.length, f.retirements.length], [0, 0, 0, 0])
})
