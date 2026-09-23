'use strict';
/* THE PROVIDER MODULES THIS REGISTRY DOES NOT LOAD UNTIL A TOOL NEEDS THEM.
 *
 * src/lib/tool-registry.js is required on every engine start and used to pull
 * its whole provider set with it. A require-graph probe on 2026-09-03 showed
 * most of that set is never touched while the module body evaluates -- the
 * registry only closes over those modules, and the closure runs when a tool is
 * invoked -- so they now load on first use through `deferred(() => require())`
 * accessors, and call sites read `provider().method(args)`.
 *
 * MEASURED 2026-09-03, interleaved A/B on fresh node processes, two runs:
 * require('src/lib/tool-registry.js') median 427.94 -> 259.36 ms and
 * 382.70 -> 197.89 ms; src/mcp-server.js, the real engine start, median
 * 554.35 -> 305.51 ms and 425.59 -> 263.91 ms. Wall time drifts on a machine
 * running twenty lanes; the module count does not, and it is what this file
 * asserts on: 157 -> 84 modules for the registry, 160 -> 90 for the server.
 *
 * WHAT THIS FILE HAS TO PROVE, AND WHY EACH HALF EXISTS.
 *
 * 1. The saving is real. A bare require of the registry must not pull these
 *    modules in. Asserted BY NAMED PATH against require.cache -- never by a
 *    module count, which two different sets of the same size would pass.
 *
 * 2. Nothing lost its implementation. A deferred require is a require that can
 *    silently never happen: the handler closure still exists, the tool is still
 *    registered and still answers `tools/list`, and the call fails only when
 *    somebody makes it. So every moved module is proven reachable by CALLING one
 *    of its tools and observing that module arrive in require.cache, with the
 *    call refused only for reasons that are not a missing implementation.
 *
 * The two tools whose own gate refuses before their handler runs (http.request
 * needs a one-time approval token, workspace.* is FRA-only and this session is
 * local) are asserted on their named refusal instead. Reaching their handlers
 * would mean handing a test the authority the gate exists to withhold.
 */

const isolated = require('./lib/isolated-environment').activate('tool-registry-deferred-providers');
// These probes exercise provider loading with deliberately missing credentials.
// They must never open an owner dialog on the real interactive desktop.
process.env.TOOLSENABLED_DEFER_CREDENTIAL_PROMPTS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { executeTool } = require('./helpers/dispatch');

void isolated;

const ROOT = path.resolve(__dirname, '..');
const absolute = relative => path.resolve(ROOT, relative);
const isLoaded = relative => Object.prototype.hasOwnProperty.call(require.cache, absolute(relative));

// Every deferred module, the tool that reaches it, and arguments good enough to
// clear that tool's schema. The arguments name nothing real: what is under test
// is which module the dispatch reaches, not what the provider then answers.
const REACHED_BY_CALLING = [
  ['src/lib/providers/scheduler.js', 'scheduler.list', {}],
  ['src/lib/providers/agent-comms-local.js', 'agent_comms.local_roster', { from: 'claude' }],
  ['src/lib/providers/launch.js', 'launch.detect', { cwd: ROOT }],
  ['src/lib/providers/remote-playwright.js', 'browser.playwright_status', {}],
  ['src/lib/providers/workstation.js', 'workstation.status', {}],
  ['src/lib/providers/host-control.js', 'host.list_dir', {}],
  ['src/lib/providers/code-intel.js', 'code.status', {}],
  ['src/lib/providers/repo-files.js', 'repo.list_dir', {}],
  ['src/lib/providers/agent-sandbox.js', 'sandbox.doctor', {}],
  ['src/lib/providers/customer-model.js', 'model.customer_complete', { prompt: 'hello there' }],
  ['src/lib/providers/instagram.js', 'instagram.verify', {}],
  ['src/lib/providers/paddle.js', 'paddle.doctor', {}],
  ['src/lib/providers/github.js', 'github.repo_get', { owner: 'octocat', repo: 'hello-world' }],
  ['src/lib/providers/web.js', 'web.extract', { evidenceId: 'evidence-0001' }],
  ['src/lib/providers/pay.js', 'pay.check', {}],
  ['src/lib/providers/duo-desktop.js', 'duo.desktop_status', {}],
  ['src/lib/providers/google.js', 'gmail.list', {}],
  ['src/lib/providers/drive.js', 'drive.find', { name: 'Reports' }],
  ['src/lib/providers/gcloud-account-login.js', 'gcloud.account_login', { account: 'someone@example.com' }],
  ['src/lib/providers/billing.js', 'billing.checkout_status', { sessionId: 'cs_test_0123456789' }],
  ['src/lib/providers/tasks.js', 'task.list', {}],
  ['src/lib/providers/memory.js', 'memory.search', { query: 'anything' }],
  ['src/lib/providers/reminders.js', 'personal_calendar.list', {}],
  ['src/lib/providers/deployment.js', 'deployment.detect', {}],
  ['src/lib/providers/extension.js', 'extension.validate', {}],
  ['src/lib/providers/firebase.js', 'firebase.doctor', {}],
  ['src/lib/providers/infrastructure.js', 'gcloud.doctor', {}],
  ['src/lib/providers/model.js', 'model.complete', { prompt: 'hello there' }],
  ['src/lib/providers/research-hermes.js', 'research.hermes_complete', { prompt: 'hello' }],
  ['src/lib/providers/research-strong.js', 'research.local_tiers_status', {}],
  ['src/lib/providers/iphone-handoff.js', 'iphone.handoff_status', {}],
  ['src/lib/providers/owner-prompt-queue.js', 'owner_prompts.status', {}],
  ['src/lib/desktop.js', 'clipboard.read', {}],
  ['src/lib/search.js', 'search.status', {}],
  ['src/lib/mission-bridge/owner-prompts.js', 'purchase.decision', { promptId: 'prompt-0001' }],
  // The broker controls: lazyControl already deferred CONSTRUCTION, the
  // classes themselves are now required inside the same factory.
  ['src/lib/providers/overnight-advisory.js', 'overnight_advisory.lifecycle_status', {}],
  ['src/lib/providers/overnight-advisory-runtime.js', 'overnight_advisory.lifecycle_status', {}],
  ['src/lib/providers/research.js', 'research.project_list', {}],
  ['src/lib/providers/research-runs-runtime.js', 'research.lifecycle_status', {}]
];

// Deferred too, but their own tool's gate refuses before the handler. Named
// here so they are covered rather than quietly dropped from the list above.
// Every tool that reaches these three modules is gated the same way, so there
// is no cheaper door: http.* and stripe.* want a one-time approval token from
// system.ask, and workspace.* is FRA-only while this session is local.
const REFUSED_BEFORE_THE_HANDLER = [
  ['src/lib/providers/http-request.js', 'http.request',
    { method: 'GET', url: 'https://example.com/' }, 'APPROVAL_REQUIRED'],
  ['src/lib/providers/stripe.js', 'stripe.cardholder_create',
    { name: 'A Person', billing: { line1: '1 Road', city: 'Town', state: 'CA', country: 'US', postalCode: '90001' } },
    'APPROVAL_REQUIRED'],
  ['src/lib/providers/fra-workspace-handles.js', 'workspace.list',
    {}, 'PERMISSION_LOCAL_FRA_ONLY_REFUSED']
];

// Still arriving on a bare require, through an edge that is not this file's:
// system-status.js requires providers/firebase and providers/infrastructure,
// scoped-approvals.js requires desktop, and providers/model-role is eager on
// purpose (model.role_complete's schema is built from it) and requires
// providers/model. Named, so the day one of those edges moves this list is the
// thing that tells us.
const LOADED_THROUGH_ANOTHER_MODULE = [
  'src/lib/providers/firebase.js',
  'src/lib/providers/infrastructure.js',
  'src/lib/desktop.js',
  'src/lib/providers/model.js'
];

const ALL_DEFERRED = [
  ...REACHED_BY_CALLING.map(row => row[0]),
  ...REFUSED_BEFORE_THE_HANDLER.map(row => row[0])
];

const MISSING_IMPLEMENTATION = /is not a function|Cannot read propert|Cannot find module|undefined/i;

test('a bare require of the tool registry loads no deferred provider', () => {
  // helpers/dispatch already required the registry above, which is the shape a
  // start has: the registry loaded, nothing dispatched yet.
  const stillEager = ALL_DEFERRED.filter(isLoaded).sort();
  assert.deepEqual(stillEager, [...LOADED_THROUGH_ANOTHER_MODULE].sort(),
    'requiring the tool registry pulled in a provider it was supposed to leave alone');
});

test('the registry still answers for every tool it registers', () => {
  const { listTools, getTool } = require('../src/lib/tool-registry.js');
  const names = listTools().map(tool => tool.name);
  for (const [, tool] of [...REACHED_BY_CALLING, ...REFUSED_BEFORE_THE_HANDLER]) {
    assert.ok(names.includes(tool), `${tool} disappeared from the registry`);
    assert.equal(getTool(tool).name, tool);
  }
});

test('calling one tool from each deferred module reaches that module', async () => {
  const notReached = [];
  const lostImplementation = [];
  for (const [relative, tool, args] of REACHED_BY_CALLING) {
    let failure = null;
    try {
      await executeTool(tool, args, {});
    } catch (error) {
      failure = error;
    }
    if (!isLoaded(relative)) notReached.push(`${tool} -> ${relative}`);
    if (tool === 'instagram.verify') {
      assert.equal(failure?.code, 'SECRET_NOT_CONFIGURED',
        'the Instagram loading probe must refuse missing credentials without queuing an owner prompt');
    }
    // A provider that is absent or half-wired does not refuse by name; it dies
    // on an undefined member. Any NAMED product refusal is a real answer from a
    // real implementation and is what an unconfigured machine should say.
    if (failure && !failure.code && MISSING_IMPLEMENTATION.test(String(failure.message))) {
      lostImplementation.push(`${tool}: ${failure.message}`);
    }
  }
  assert.deepEqual(notReached, [], 'a tool did not reach the module that implements it');
  assert.deepEqual(lostImplementation, [], 'a tool reached no implementation');
  assert.equal(fs.existsSync(path.join(process.env.TOOLSENABLED_STATE_ROOT, 'state', 'owner-prompt-queue.json')), false,
    'provider loading probes must leave no synthetic requests for the owner');
});

test('a gate that refuses before the handler still refuses by name', async () => {
  for (const [, tool, args, code] of REFUSED_BEFORE_THE_HANDLER) {
    await assert.rejects(() => executeTool(tool, args, {}), error => {
      assert.equal(error.code, code, `${tool} refused with ${error.code}, expected ${code}`);
      return true;
    });
  }
});

test('a deferred accessor hands back the live module, not a copy of it', async () => {
  // Memoisation must not snapshot: a provider keeps state in its own module
  // scope, and a test or a later call has to see the same object the first call
  // used. Proven by changing the module after it is loaded and dispatching
  // again through the registry.
  if (process.platform === 'win32') await executeTool('scheduler.list', {}, {});
  else await assert.rejects(() => executeTool('scheduler.list', {}, {}), { code: 'SCHEDULER_PLATFORM_UNSUPPORTED' });
  const scheduler = require('../src/lib/providers/scheduler');
  const original = scheduler.list;
  const answer = { proof: 'live-module-scheduler-list' };
  scheduler.list = () => answer;
  try {
    const result = await executeTool('scheduler.list', {}, {});
    assert.deepEqual(result, answer);
  } finally {
    scheduler.list = original;
  }
});
