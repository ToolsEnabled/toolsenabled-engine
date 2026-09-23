/* EXECUTABLE CHANGE
Report testcanfail-tests-owner-delivery-js.

STRENGTHENED: the empty-image capture assertion now proves both the browser
context and browser are closed. Mutation: deleted `await context.close()` from
`captureReportPng`. Before strengthening, the focused scratch run stayed green:
`ok captureReportPng refuses to produce nothing and reports a missing engine honestly`.
After strengthening it went RED:
`AssertionError [ERR_ASSERTION]: the browser context and browser must be closed even when the render fails`
`actual: [ 'browser' ]`
`expected: [ 'context', 'browser' ]`.
The source mutation was restored byte-for-byte (SHA-256
ceea3c437f7a2c7ed5e9c78560bcc0bcee460c73ada73203b88cc4222ca789c9).

NOT-FOUND (1): every loop over a subject-owned collection has an independent
non-emptiness assertion; the remaining loops use non-empty test literals.
NOT-FOUND (2): no exit-status or generic truthy-return assertion is used as
substitute evidence for a subject process's own output.
NOT-FOUND (3): no test-side try/catch or optional chain swallows the failure
under test; the final cleanup catch is cleanup-only.
NOT-FOUND (4): injected fakes observe transport/browser boundaries rather than
replace the delivery/rendering behavior under test.
NOT-FOUND (5): there is no skip or platform guard.
NOT-FOUND (6): exported image dimensions/scaling are also pinned independently
to literal device specifications. The returned `bytes > 0` check merits a
future `bytes === image.length` mutation, but the real-render precondition could
not be met here because the Playwright Chromium executable is absent.

RESTORED GREEN: the strengthened focused scratch run after exact source restore
printed `ok captureReportPng refuses to produce nothing and reports a missing engine honestly`
and `Owner delivery tests passed (13 checks: one channel setting, one surviving channel, honest-unknown, truncation, failure surfacing, Duo relay credential discipline).`
Full-file green precondition not met: Playwright's Chromium headless-shell is
not installed. Node 20 was also insufficient (`ERR_UNKNOWN_BUILTIN_MODULE:
node:sqlite`), so mutation runs used installed Node 22.22.2.
*/
'use strict';

// The isolated runner resolves exactly one already-provisioned Chromium binary
// before it redirects LOCALAPPDATA, then supplies that exact path here.  It
// deliberately does not forward the ambient AppData directory or a browser
// profile.  A direct invocation still uses Playwright's ordinary lookup.
const { chromium: playwrightChromium } = require('playwright');
const isolatedChromiumExecutable = process.env.TOOLSENABLED_TEST_PLAYWRIGHT_EXECUTABLE;
const realChromiumExecutable = isolatedChromiumExecutable || playwrightChromium.executablePath();
const realChromium = Object.freeze({
  launch: options => playwrightChromium.launch({
    ...(options || {}),
    ...(isolatedChromiumExecutable ? { executablePath: isolatedChromiumExecutable } : {})
  })
});

// Owner-facing delivery tests: the single surviving channel, retired-provider
// refusal, provider-neutral delivery records, image rendering, the Duo relay,
// and failure surfacing. Plain `node tests/owner-delivery.js`.
//
// NOTHING REAL IS TOUCHED. Email, owner-channel seams, the vault, the audit
// ledger, the browser, and every state file are injected fakes or temp files.
// No message can reach the owner from this file.

require('./lib/isolated-environment').activate('owner-delivery');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const delivery = require('../src/lib/owner-delivery');
const imageRender = require('../src/lib/agent-digest/render-image');
const { renderDigest, renderFallback, buildQuickMetrics } = require('../src/lib/agent-digest/render');
const duoRelay = require('../src/lib/duo-owner-relay');
const duoDesktop = require('../src/lib/providers/duo-desktop');
const ucrSso = require('../src/lib/ucr-sso');
const { createAgentDigestService } = require('../src/lib/agent-digest');
const { DigestSchedule, MemorySettingsStore } = require('../src/lib/agent-digest/schedule');

// The digest's email path resolves its recipient through the REAL
// src/lib/google-accounts registry, which reads the per-installation,
// gitignored config/google-accounts.profile.json -- one person's Google
// aliases and addresses, and a file a fresh checkout does not have at all.
// This suite must not depend on it, so the roster is replaced here by the
// fixture account the rest of the tree already uses for exactly this
// (tests/desktop.browser/playwright-gateway.js: accta / accta@example.com),
// the same substitution the Duo email check further down makes through
// owner-delivery's own "accounts" dependency seam -- createAgentDigestService
// has no such seam, so the module the digest requires is the injection point.
// resolveRecipient's own behaviour still runs for real against this roster:
// alias resolution, the registered-address lookup, and the refusal on an
// account that is unknown or carries no address.
const FIXTURE_ROSTER = {
  defaultAccount: 'accta',
  accounts: { accta: { email: 'accta@example.com' } }
};
const googleAccounts = require('../src/lib/google-accounts');
googleAccounts.load = () => JSON.parse(JSON.stringify(FIXTURE_ROSTER));
googleAccounts.resolve = selector => {
  const alias = selector === undefined || selector === null || selector === ''
    ? FIXTURE_ROSTER.defaultAccount : String(selector).trim();
  if (!FIXTURE_ROSTER.accounts[alias]) {
    throw Object.assign(new Error(`Unknown Google account '${selector}'.`), { code: 'GOOGLE_ACCOUNT_NOT_FOUND' });
  }
  return alias;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-delivery-'));
let caseIndex = 0;
function tempFile(name) {
  caseIndex += 1;
  const dir = path.join(root, `case-${caseIndex}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

let checks = 0;
const pending = [];
function check(label, run) { pending.push({ label, run }); }

// --- fixtures ---------------------------------------------------------------

const NOW_MS = new Date(2026, 6, 28, 10, 5, 0, 0).getTime();

function meter(overrides = {}) {
  return {
    provider: 'claude',
    operationCount: 10, completedCount: 8, failedCount: 1, timeoutCount: 1, blockedCount: 0,
    operationMeterState: 'available', operationUnavailableReason: null,
    reportedTokenCount: 1234, tokenMeterState: 'available',
    costMicros: 5000, costMeterState: 'available',
    ...overrides
  };
}

function fixtureState(overrides = {}) {
  const state = {
    schemaVersion: 'agent-digest-state-v1',
    observedAtMs: NOW_MS,
    observedAt: new Date(NOW_MS).toISOString(),
    declared: { source: 'config/agent-org.json', revision: 3, agents: [], relationships: [] },
    observed: {
      auditState: 'verified',
      provenance: { state: 'verified', headSequence: 900 },
      freshness: 'fresh',
      eventsInWindow: 42,
      agents: [{ alias: 'worker', agentKind: 'cli', state: 'idle' }],
      phases: [],
      goals: [],
      lifecycle: 'running',
      providerControls: [{ provider: 'gemini', status: 'ok' }],
      runs: { total: 4, active: 2, byStatus: { running: 2, succeeded: 2 }, openHelp: 1, stale: [] },
      meters: {
        state: 'available', unavailableReason: null, skippedCount: 0,
        subscriptionUsage: 'not recorded', savingsState: 'not recorded',
        providers: [meter()],
        waste: { retryOrFailureCount: 0, duplicateReviewCount: 0, cacheMissCount: 0, measuredEvidenceCount: 0, sourceState: 'available' }
      }
    },
    queue: {
      source: 'BUILD-QUEUE.md',
      phases: [
        { id: 'Q1', title: 'one', status: 'IN-PROGRESS', detail: '' },
        { id: 'Q2', title: 'two', status: 'BLOCKED', detail: 'waiting on an elevated PowerShell run' },
        { id: 'Q3', title: 'three', status: 'DONE', detail: '' }
      ],
      counts: { OPEN: 0, 'IN-PROGRESS': 1, DONE: 1, BLOCKED: 1, PARTIAL: 0, UNRECOGNIZED: 0 },
      depth: 2, inFlight: ['Q1'], blocked: ['Q2'], open: []
    },
    delta: {
      available: true, sinceMs: NOW_MS - 3600_000, since: new Date(NOW_MS - 3600_000).toISOString(),
      auditEventsSince: 12, queueDepthBefore: 3, queueDepthAfter: 2,
      movedPhases: [{ id: 'Q3', from: 'IN-PROGRESS', to: 'DONE' }],
      agentChanges: [], activeRunsBefore: 1, activeRunsAfter: 2
    },
    gaps: []
  };
  return { ...state, ...overrides };
}

// A harness that captures the one surviving transport without performing it.
function harness() {
  const calls = { gmail: [], audit: [] };
  const recordFile = tempFile('owner-delivery.json');
  return {
    calls,
    recordFile,
    gmail: {
      gmailSend: async args => { calls.gmail.push(args); return { id: 'gmail-1' }; }
    },
    dependencies: {
      recordFile,
      record: (action, target, payload) => { calls.audit.push({ action, target, payload }); }
    }
  };
}

function configFile(channel) {
  const file = tempFile('owner-delivery-config.json');
  fs.writeFileSync(file, JSON.stringify(channel === null ? {} : { schemaVersion: 1, channel }), 'utf8');
  return file;
}

function digestWiring(channelConfigFile, harnessInstance, extra = {}) {
  const store = new MemorySettingsStore();
  return createAgentDigestService({
    config: { enabled: true, account: 'accta', tickMs: 1000, generationTimeoutMs: 1000 },
    store,
    schedule: new DigestSchedule({ store }),
    runControl: null,
    providerGateway: null,
    gmail: harnessInstance.gmail,
    channelOptions: { file: channelConfigFile, env: {} },
    deliveryDependencies: harnessInstance.dependencies,
    previousFailure: null,
    log: () => {},
    ...extra
  });
}

function message(overrides = {}) {
  const state = fixtureState();
  const rendered = renderDigest({ state, kind: 'digest', fireKey: '2026-07-28|10:00', mode: 'full' });
  return { ...rendered, state, fingerprint: { schemaVersion: 'agent-digest-fingerprint-v1' }, ...overrides };
}

// ============================================================================
// 1. The single setting.
// ============================================================================

check('channel selection honors the config file for every channel that still exists', () => {
  // There is exactly one. That is the point of the assertion: if a channel is
  // ever added back, this loop covers it without being edited.
  assert.deepEqual([...delivery.CHANNELS], ['email']);
  for (const channel of delivery.CHANNELS) {
    const resolved = delivery.resolveChannel({ file: configFile(channel), env: {} });
    assert.equal(resolved.channel, channel);
    assert.equal(resolved.source, 'config');
    assert.equal(resolved.reason, null);
  }
});

check('no Telegram transport survives on the delivery surface', () => {
  // The same shape of assertion the Discord removal left behind, one connector
  // later. Each is named rather than pattern-matched: a transport that comes
  // back as an export is a transport that comes back.
  for (const gone of ['sendTelegramToOwner', 'sendTelegramPhotoToOwner', 'sendTelegramDocumentToOwner', 'sendDiscordToOwner']) {
    assert.equal(gone in delivery, false, gone + ' must not survive on the delivery surface');
  }
  assert.equal(delivery.DEFAULT_CHANNEL, 'email');
});

check('a config still naming a retired channel falls back to the default with a NAMED reason', () => {
  // Discord left on 2026-08-22 and Telegram on 2026-08-23. A machine whose
  // config/owner-delivery.json still names any of their channels is not
  // special-cased: each is an unrecognised value like any other, so the owner
  // gets the same typed fallback reason and nothing is delivered anywhere
  // surprising. Deliberately NOT aliased onto email -- silently rewriting a
  // stored choice is how an owner ends up not knowing where his reports go.
  for (const retired of ['discord-text', 'telegram-image', 'telegram-image-full', 'telegram-text', 'telegram']) {
    assert.equal(delivery.normalizeChannel(retired), null, retired + ' must not normalize to a live channel');
    assert.equal(delivery.CHANNELS.includes(retired), false);
    const resolved = delivery.resolveChannel({ file: configFile(retired), env: {} });
    assert.equal(resolved.channel, delivery.DEFAULT_CHANNEL);
    assert.equal(resolved.source, 'default');
    assert.match(resolved.reason, /is not one of email/);
  }
});

check('the checked-in owner setting resolves cleanly and names no removed channel', () => {
  const resolved = delivery.resolveChannel({
    file: path.join(__dirname, '..', 'config', 'owner-delivery.json'), env: {}
  });
  // The shipped config must not itself be one of the fallback cases above: a
  // default that only works because the fallback catches it is a default nobody
  // has checked.
  assert.equal(resolved.channel, 'email');
  assert.equal(resolved.source, 'config');
  assert.equal(resolved.reason, null);
});

check('an absent config defaults to email with a NAMED reason, never silently', () => {
  const resolved = delivery.resolveChannel({ file: path.join(root, 'does-not-exist.json'), env: {} });
  assert.equal(resolved.channel, 'email');
  assert.equal(resolved.channel, delivery.DEFAULT_CHANNEL);
  assert.equal(resolved.source, 'default');
  assert.match(resolved.reason, /absent/);
});

check('an unrecognized channel degrades to the default WITH a reason rather than winning', () => {
  const resolved = delivery.resolveChannel({ file: configFile('carrier-pigeon'), env: {} });
  assert.equal(resolved.channel, 'email');
  assert.equal(resolved.source, 'default');
  assert.match(resolved.reason, /not one of/);
});

check('the env override still works, and a bad env value never disables delivery', () => {
  const file = configFile('email');
  const resolved = delivery.resolveChannel({ file, env: { [delivery.ENV_OVERRIDE]: 'email' } });
  assert.equal(resolved.channel, 'email');
  assert.equal(resolved.source, 'env');
  const bad = delivery.resolveChannel({ file, env: { [delivery.ENV_OVERRIDE]: 'nope' } });
  assert.equal(bad.channel, 'email');
  assert.match(bad.reason, /not one of/);
  // A retired channel named in the env is a bad value like any other.
  const retired = delivery.resolveChannel({ file, env: { [delivery.ENV_OVERRIDE]: 'telegram-image' } });
  assert.equal(retired.channel, 'email');
  assert.equal(retired.source, 'default');
  assert.match(retired.reason, /not one of/);
});

// ============================================================================
// 2. Exactly one channel per slot.
//
// The Telegram send cases that stood here were removed 2026-08-23 with the
// connector: a photo send, a byte-preserving document send, a plain text send,
// and the image-render-failure degrade path between them. They are not
// replaced -- there is no second channel left for a slot to be delivered on
// twice -- so what survives is the email path and the failure bookkeeping.
// ============================================================================

check('the email path is what a slot now delivers on: html+text, and nothing else', async () => {
  const bench = harness();
  const wiring = digestWiring(configFile('email'), bench);
  await wiring.send(message());
  assert.equal(bench.calls.gmail.length, 1);
  assert.ok(bench.calls.gmail[0].html.includes('<!doctype html>'), 'the HTML renderer must not have rotted');
  assert.ok(bench.calls.gmail[0].text.length > 200);
});

check('a rendered digest no longer carries a telegram view at all', () => {
  // render-telegram.js is deleted. renderDigest/renderFallback must not be left
  // half-wired, quietly emitting an undefined telegram key that a future sender
  // would read as an empty message rather than as a missing one.
  const state = fixtureState();
  for (const view of [renderDigest({ state, kind: 'digest' }), renderFallback({ state, kind: 'digest' })]) {
    assert.equal('telegram' in view, false, 'the telegram view must be gone, not undefined');
    assert.equal('telegramCaption' in view, false, 'the telegram caption must be gone, not undefined');
    assert.equal(typeof view.subject, 'string');
    assert.ok(view.text.length > 0, 'the text view is what email sends and must survive');
    assert.ok(view.html.includes('<!doctype html>'), 'the html view is what email sends and must survive');
  }
});

// ============================================================================
// 3. A failed delivery is recorded, never swallowed.
// ============================================================================

check('consecutive failures accumulate and a success clears them', () => {
  const recordFile = tempFile('owner-delivery.json');
  const dependencies = { recordFile, record: () => {} };
  delivery.recordDelivery({ purpose: 'agent-digest', channel: 'email', ok: false, code: 'E1' }, dependencies);
  delivery.recordDelivery({ purpose: 'agent-digest', channel: 'email', ok: false, code: 'E2' }, dependencies);
  assert.equal(delivery.readDeliveryRecord(recordFile).consecutiveFailures, 2);
  delivery.recordDelivery({ purpose: 'agent-digest', channel: 'email', ok: true, rendered: 'email' }, dependencies);
  const after = delivery.readDeliveryRecord(recordFile);
  assert.equal(after.consecutiveFailures, 0);
  assert.equal(after.lastFailure.code, 'E2', 'the last failure stays visible after recovery');
});

check('the product-native owner journal is recorded truthfully without becoming a selectable legacy channel', () => {
  const recordFile = tempFile('owner-delivery-agent-comms.json');
  const recorded = delivery.recordDelivery({
    purpose: 'iphone-handoff-request', channel: 'agent-comms', ok: true,
    rendered: 'text', characters: 42
  }, { recordFile, record: () => {} });
  assert.equal(recorded.entry.channel, 'agent-comms');
  assert.equal(delivery.readDeliveryRecord(recordFile).lastSuccess.channel, 'agent-comms');
  assert.equal(delivery.CHANNELS.includes('agent-comms'), false,
    'recording the journal outcome must not silently add an unsupported legacy transport selection');
});

check('a bookkeeping write failure is itself recorded, never silently swallowed', () => {
  // The record file already exists but cannot be parsed, so readDeliveryRecord()
  // returns it `unreadable`, and recordDelivery() refuses to write over it --
  // that refusal is the bookkeeping failure under test here, not the send.
  const recordFile = tempFile('owner-delivery-unrecorded.json');
  fs.writeFileSync(recordFile, 'not json', 'utf8');
  const calls = [];
  const dependencies = { recordFile, record: (action, target, details) => { calls.push({ action, target, details }); } };

  // A delivery that SUCCEEDED. Nothing else in this process or on disk speaks
  // for it -- the send has no audit record of its own -- so the bookkeeping
  // trace is the only place this success could ever become visible.
  const success = delivery.recordDelivery(
    { purpose: 'agent-digest', channel: 'email', ok: true, rendered: 'email' }, dependencies);
  assert.equal(success.persisted, false, 'an unreadable record must not be reported as freshly written');
  assert.equal(calls.length, 1,
    'a successful delivery whose bookkeeping failed must leave exactly one trace -- it used to leave none');
  assert.equal(calls[0].action, 'owner.delivery_unrecorded');
  assert.equal(calls[0].target, 'email', 'the trace must name the channel, not just that something failed');
  assert.equal(calls[0].details.ok, true, 'the trace must say the underlying send succeeded');
  assert.equal(calls[0].details.purpose, 'agent-digest');
  assert.equal(calls[0].details.code, 'OWNER_DELIVERY_RECORD_UNREADABLE',
    'the trace must carry the bookkeeping error, not the (nonexistent) send error');

  // A delivery that FAILED, with the same broken record file. Both facts are
  // independently true and must both survive: the send failed for its own
  // reason, AND the streak that failure should have advanced could not be
  // written. One must not crowd out the other.
  calls.length = 0;
  const failure = delivery.recordDelivery(
    { purpose: 'agent-digest', channel: 'email', ok: false, code: 'SMTP_TIMEOUT' }, dependencies);
  assert.equal(failure.persisted, false);
  assert.equal(calls.length, 2, 'a failed send AND a failed bookkeeping write are two facts, not one');
  assert.equal(calls[0].action, 'owner.delivery_unrecorded');
  assert.equal(calls[0].details.code, 'OWNER_DELIVERY_RECORD_UNREADABLE');
  assert.equal(calls[1].action, 'owner.delivery_failed');
  assert.equal(calls[1].details.code, 'SMTP_TIMEOUT',
    'the sends own failure code must survive alongside the bookkeeping one, not be replaced by it');
});
// ============================================================================
// 5. THE TELEGRAM RENDERING SECTION WAS REMOVED 2026-08-23.
//
// Six cases stood here and all six had render-telegram.js as their subject:
// honest-unknown survival, "not recorded" instead of 0, HTML escaping with a
// tag whitelist, line-granular truncation with a dashboard pointer, the hard
// character caps, and the degraded fallback's Telegram view.
//
// FOUR OF THOSE SIX PROPERTIES ARE NOT TELEGRAM-SPECIFIC and are NOT lost --
// they are properties of the text and html views, which email sends and which
// section 6 below and the render suite still cover: honest-unknown rendering,
// "not recorded" over a fabricated 0, escaping, and the degraded-fallback
// banner. What genuinely goes with the connector is the pair that only ever
// described a Telegram message: the 4096-character body cap and the
// 1024-character photo caption cap.
// ============================================================================

// ============================================================================
// 6. The image card.
// ============================================================================

check('the phone card is self-contained, honest about unknowns, and needs no network', () => {
  const state = fixtureState();
  state.observed.meters.providers = [meter({
    provider: 'gemini', operationCount: null, operationMeterState: 'unavailable',
    operationUnavailableReason: 'no-instrumented-source-in-window',
    reportedTokenCount: null, tokenMeterState: 'unavailable', costMicros: null, costMeterState: 'unavailable'
  })];
  state.queue = null;
  const html = imageRender.renderReportCardHtml({ state, kind: 'digest', fireKey: '2026-07-28|10:00' });
  assert.match(html, /operations not recorded \(no-instrumented-source-in-window\)/);
  assert.match(html, /not recorded/);
  assert.doesNotMatch(html, /src="http/, 'the card must embed no remote assets');
  assert.doesNotMatch(html, /<script/i, 'the card must contain no scripts');
  assert.match(html, new RegExp(`width:${imageRender.PHONE_WIDTH}px`), 'the card must be laid out at phone width');
  // A missing metric is drawn as a dashed not-recorded tile, never an empty one.
  assert.match(html, /1px dashed/);
});

check('the card escapes hostile local state before it reaches markup', () => {
  const state = fixtureState();
  state.queue.phases[1].detail = '<img src=x onerror=alert(1)>';
  const html = imageRender.renderReportCardHtml({ state, kind: 'digest' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

check('captureReportPng refuses to produce nothing and reports a missing engine honestly', async () => {
  await assert.rejects(() => imageRender.captureReportPng({ html: '' }),
    error => error.code === 'AGENT_DIGEST_IMAGE_NO_HTML');
  const closed = [];
  const fakeChromium = {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => ({
          route: async () => {}, setContent: async () => {},
          screenshot: async () => Buffer.alloc(0)
        }),
        close: async () => { closed.push('context'); }
      }),
      close: async () => { closed.push('browser'); }
    })
  };
  await assert.rejects(() => imageRender.captureReportPng({ html: '<p>x</p>', chromium: fakeChromium }),
    error => error.code === 'AGENT_DIGEST_IMAGE_EMPTY');
  assert.deepEqual(closed, ['context', 'browser'],
    'the browser context and browser must be closed even when the render fails');
});

check('captureReportPng refuses when it cannot enforce offline rendering', async () => {
  const abortFailure = new Error('request abort failed');
  const fakeChromium = {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => ({
          route: async (_pattern, handler) => handler({ abort: async () => { throw abortFailure; } }),
          setContent: async () => {},
          screenshot: async () => Buffer.from('unexpected image')
        }),
        close: async () => {}
      }),
      close: async () => {}
    })
  };
  await assert.rejects(
    () => imageRender.captureReportPng({ html: '<p>x</p>', chromium: fakeChromium }),
    error => error === abortFailure
  );
});

check('a hung render is abandoned on a bound and still closes its browser', async () => {
  const closed = [];
  const fakeChromium = {
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => ({
          route: async () => {}, setContent: async () => {},
          screenshot: () => new Promise(() => { /* never settles */ })
        }),
        close: async () => {}
      }),
      close: async () => { closed.push('browser'); }
    })
  };
  await assert.rejects(() => imageRender.captureReportPng({ html: '<p>x</p>', chromium: fakeChromium, timeoutMs: 60 }),
    error => error.code === 'AGENT_DIGEST_IMAGE_TIMEOUT');
  assert.deepEqual(closed, ['browser'], 'a timed-out render must not leave a stray browser process');
});

check('captureReportPng requests the iPhone 13 Pro Max viewport and @3x scale factor by default', async () => {
  // Config-level check: confirms the values actually reach Playwright's
  // newContext(), not just that the exported constants have the right numbers.
  let capturedContextArgs = null;
  const fakeChromium = {
    launch: async () => ({
      newContext: async args => {
        capturedContextArgs = args;
        return {
          newPage: async () => ({
            route: async () => {}, setContent: async () => {},
            screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
          }),
          close: async () => {}
        };
      },
      close: async () => {}
    })
  };
  await imageRender.captureReportPng({ html: '<p>x</p>', chromium: fakeChromium });
  assert.deepEqual(capturedContextArgs.viewport, { width: 428, height: 926 },
    'the requested viewport must be the iPhone 13 Pro Max logical size (428x926pt), not the old iPhone-generic 390x844');
  assert.equal(capturedContextArgs.deviceScaleFactor, 3,
    'the requested device scale factor must be @3x, not the old @2x');
});

function pngDimensionsFromBuffer(buffer) {
  assert.ok(Buffer.isBuffer(buffer) && buffer.length >= 24, 'PNG buffer is too small to hold an IHDR header');
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR', 'buffer is not a valid PNG (no IHDR chunk at the expected offset)');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

check('a REAL Playwright render produces the exact iPhone 13 Pro Max physical pixel width -- not a trusted config value', async () => {
  // Apple's published spec (verified against ios-resolution.com and
  // support.apple.com/en-us/111870 rather than assumed): the iPhone 13 Pro Max
  // is 428x926pt logical @3x -> 1284x2778 physical px. This launches a REAL
  // headless Chromium and inspects the REAL returned PNG bytes, because a
  // Playwright/Chromium config can silently cap deviceScaleFactor -- a test
  // that only checks the requested config value would not catch that.
  assert.equal(imageRender.PHONE_WIDTH, 428, 'viewport width must be the iPhone 13 Pro Max logical width');
  assert.equal(imageRender.PHONE_HEIGHT, 926, 'viewport height must be the iPhone 13 Pro Max logical height');
  assert.equal(imageRender.DEVICE_SCALE, 3, 'device scale factor must be the iPhone 13 Pro Max @3x, not the older @2x');
  assert.ok(fs.existsSync(realChromiumExecutable),
    'the real-render assertion requires an already-provisioned Playwright Chromium executable');

  const state = fixtureState();
  const { image, bytes } = await imageRender.renderReportImage({
    state, kind: 'digest', fireKey: '2026-07-28|22:00', mode: 'full', chromium: realChromium
  });
  assert.ok(Buffer.isBuffer(image) && bytes > 0, 'the real render must produce non-empty PNG bytes');

  const { width, height } = pngDimensionsFromBuffer(image);
  assert.equal(width, imageRender.PHONE_WIDTH * imageRender.DEVICE_SCALE,
    'rendered PNG width must be viewport width x device scale factor -- a mismatch means the scale factor was silently capped');
  assert.equal(width, 1284, "must equal Apple's published iPhone 13 Pro Max physical width exactly");

  // Height is deliberately content-defined (fullPage screenshot, "let content
  // define height" from the original build) so no fixed number is asserted --
  // but it must still be an exact multiple of the 3x scale factor, proving the
  // WHOLE captured page was rendered at 3x and not just the initial viewport,
  // and it must be tall enough to hold real card content rather than a blank page.
  assert.equal(height % imageRender.DEVICE_SCALE, 0,
    'rendered height must be an exact multiple of the 3x device scale factor');
  assert.ok(height > imageRender.PHONE_HEIGHT * imageRender.DEVICE_SCALE * 0.5,
    'a real card with fixture content must render taller than half a screen\'s worth of physical pixels');
});

// ============================================================================
// 7. Duo: what is honestly relayable, and no credential anywhere durable.
// ============================================================================

check('with no code on the page the message says approve it in Duo Desktop, and promises nothing else', () => {
  const rendered = duoRelay.renderDuoMessage({ route: 'duo_desktop' });
  assert.equal(rendered.relayed, 'notice');
  assert.match(rendered.text, /Approve it in Duo Desktop on this PC/);
  assert.match(rendered.text, /no code to relay/);
  assert.doesNotMatch(rendered.text, /\bcode is\b|check your (email|messages)/i);
});

check('a real verified-push number is relayed; anything else is refused as a code', () => {
  assert.equal(duoRelay.renderDuoMessage({ code: '37' }).relayed, 'code');
  assert.match(duoRelay.renderDuoMessage({ code: '37' }).text, /Duo verification code: 37/);
  for (const bogus of ['', '   ', 'abc', '<b>1</b>', '1234567890123', null, undefined, 42]) {
    assert.equal(duoRelay.renderDuoMessage({ code: bogus }).relayed, 'notice',
      `a non-code value (${JSON.stringify(bogus)}) must never be presented as his second factor`);
  }
});

check('the Duo code never reaches the delivery record, the audit payload, or a log', async () => {
  // THE CHANNEL CHANGED, THE SECRECY PROPERTY DID NOT. This ran on telegram-text
  // until 2026-08-23; the relay now goes to email like everything else. What is
  // asserted is unchanged and is the whole point of the case: the second factor
  // reaches the owner and reaches nothing durable.
  const bench = harness();
  const gmailCalls = [];
  const result = await duoRelay.notifyOwnerOfDuoPrompt(
    { code: '451', route: 'duo_desktop' },
    {
      ...bench.dependencies,
      channelOptions: { file: configFile('email'), env: {} },
      accounts: { resolve: () => 'alias', load: () => ({ accounts: { alias: { email: 'owner@example.test' } } }) },
      gmail: { gmailSend: async args => { gmailCalls.push(args); return { id: 'x' }; } }
    });
  assert.equal(result.delivered, true);
  assert.equal(result.relayed, 'code');
  // It reached the owner...
  assert.match(gmailCalls[0].text, /451/);
  // ...and nowhere durable.
  const recordText = fs.readFileSync(bench.recordFile, 'utf8');
  assert.doesNotMatch(recordText, /451/, 'the second factor must never be persisted');
  assert.match(recordText, /"purpose": "duo-code"/, 'that a code was relayed is recorded; what it was is not');
  assert.equal(JSON.stringify(bench.calls.audit).includes('451'), false,
    'the second factor must never enter an audit payload');
});

check('the Duo step vocabulary records that a code was relayed but can never carry one', () => {
  assert.ok(duoDesktop.ALLOWED_STEPS.has('duo-verification-code-relayed'));
  for (const step of duoDesktop.ALLOWED_STEPS) {
    assert.doesNotMatch(step, /\d{2,}/, 'a step name must not be able to look like a code');
  }
  // parseLoginResult only admits the fixed vocabulary, so a code cannot ride out in `steps`.
  assert.throws(() => duoDesktop.parseLoginResult(JSON.stringify({ ok: true, steps: ['451'] })),
    error => error.code === 'DUO_DESKTOP_LOGIN_RESULT_INVALID');
});

check('the page code reader accepts only short digit runs and names an unreadable page as indeterminate', async () => {
  const page = text => ({
    locator: () => ({ first: () => ({ isVisible: async () => true, textContent: async () => text }) })
  });
  assert.equal(await ucrSso.readDuoVerificationCode(page(' 37 ')), '37');
  assert.equal(await ucrSso.readDuoVerificationCode(page('Duo Push')), null);
  assert.equal(await ucrSso.readDuoVerificationCode(page('')), null);
  const exploding = { locator: () => { throw new Error('detached'); } };
  await assert.rejects(
    () => ucrSso.readDuoVerificationCode(exploding),
    error => error && error.code === 'DUO_VERIFICATION_CODE_READ_INDETERMINATE'
  );
});

check('an indeterminate Duo relay never throws into the sign-in, and is recorded', async () => {
  const bench = harness();
  const result = await duoRelay.notifyOwnerOfDuoPrompt(
    { route: 'duo_desktop' },
    {
      ...bench.dependencies,
      channelOptions: { file: configFile('email'), env: {} },
      accounts: { resolve: () => 'alias', load: () => ({ accounts: { alias: { email: 'owner@example.test' } } }) },
      gmail: { gmailSend: async () => { const error = new Error('nope'); error.code = 'GMAIL_SEND_FAILED'; throw error; } }
    });
  /* delivered === FALSE, not null. w20 relaxed this to null/'unknown' reasoning
   * that a provider exception may follow acceptance -- but this fixture throws
   * from gmailSend BEFORE anything is accepted, so non-delivery here is
   * MEASURED, not unknown. Reporting a definite failure as indeterminate is the
   * could-not-collapse defect run backwards: it turns an answer the code
   * actually has into a shrug, and a caller that retries on 'unknown' would
   * resend a message that provably never went out. */
  assert.equal(result.delivered, false);
  assert.equal(result.failureCode, 'GMAIL_SEND_FAILED');
  const record = JSON.parse(fs.readFileSync(bench.recordFile, 'utf8'));
  assert.equal(record.lastFailure.purpose, 'duo-notice');
});

check('the Duo relay follows the same single setting as the digest', async () => {
  const bench = harness();
  const gmailCalls = [];
  const result = await duoRelay.notifyOwnerOfDuoPrompt({ route: 'duo_desktop' }, {
    ...bench.dependencies,
    channelOptions: { file: configFile('email'), env: {} },
    accounts: { resolve: () => 'alias', load: () => ({ accounts: { alias: { email: 'owner@example.test' } } }) },
    gmail: { gmailSend: async args => { gmailCalls.push(args); return { id: 'x' }; } }
  });
  assert.equal(result.delivered, true);
  assert.equal(result.channel, 'email');
  assert.equal(gmailCalls.length, 1);
});

check('the Duo relay has no Telegram path left to take', () => {
  // The case this replaces asserted "always text, even on the image channel".
  // The rule it protected -- a second factor is never rendered as a picture --
  // now has no image channel to be tempted by, so what is pinned instead is that
  // the branch itself is gone from the source. A dead branch that references a
  // deleted export would throw TypeError rather than fail closed if a future
  // channel ever made isTelegramChannel true again.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'duo-owner-relay.js'), 'utf8');
  for (const gone of ['sendTelegramToOwner', 'escapeTelegramHtml', 'isTelegramChannel']) {
    assert.equal(source.includes('delivery.' + gone), false,
      'duo-owner-relay must not call delivery.' + gone + ' any more');
  }
  for (const gone of [
    'TELEGRAM_BUDGET', 'TELEGRAM_CAPTION_BUDGET', 'TELEGRAM_CAPTION_MAX_CHARS',
    'TELEGRAM_MAX_CHARS', 'escapeTelegramHtml', 'isTelegramChannel'
  ]) {
    assert.equal(Object.hasOwn(delivery, gone), false,
      `owner-delivery must not export retired provider surface ${gone}`);
  }
});

// ============================================================================
(async () => {
  try {
    for (const { label, run } of pending) {
      await run();
      checks += 1;
      process.stdout.write(`  ok ${label}\n`);
    }
    process.stdout.write(`Owner delivery tests passed (${checks} checks: one channel setting, one surviving channel, `
      + `honest-unknown, truncation, failure surfacing, Duo relay credential discipline).\n`);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch { /* best effort */ }
  }
})();
