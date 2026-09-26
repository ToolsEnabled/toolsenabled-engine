'use strict';
/* WHAT THE TOOL LIST PROMISES ABOUT scheduler.*, AND WHAT THE PROVIDER DOES.
 *
 * MEASURED on Linux 2026-09-24 against the pre-fix tree: tools/list carried
 * scheduler.list, scheduler.create, scheduler.remove and scheduler.reconcile
 * with the same descriptions Windows gets, and every one of them refused with
 * SCHEDULER_PLATFORM_UNSUPPORTED -- providers/scheduler.js drives Windows Task
 * Scheduler through scheduler-adapter.js and this build has no adapter for any
 * other platform. Four advertised capabilities, zero of them reachable, and
 * nothing in the advertisement said so.
 *
 * The four definitions cannot just be omitted on a non-Windows host:
 * config/toolsenabled.policy.json ships three of them inside
 * approvals.actions, and tool-registry.js#assertApprovalPolicyCompatible
 * refuses an approval policy that names an unregistered tool, so the registry
 * would fail to build while the module loads. The guarantee this file holds
 * instead is that the ADVERTISEMENT states the limit, in the same words the
 * refusal will use.
 *
 * WHAT EACH HALF PROVES.
 *
 * 1. The platform fact and the sentence are separate things, and only the
 *    fact is platform-decided. The sentence is one constant on every host, so
 *    the capability corpus built out of these descriptions re-derives the same
 *    bytes wherever it is built -- asserted, because a future edit that makes
 *    the wording depend on process.platform turns
 *    `npm run test:capability-index` into a gate whose colour is the runner's.
 *
 * 2. The live advertisement carries it. Read off listTools() -- the exact view
 *    an MCP client is served -- which is the assertion that went red before
 *    the fix.
 *
 * 3. The advertisement is not a guess about the provider. On a platform with
 *    no adapter the provider is CALLED and the refusal it gives is matched
 *    against the code the description names. A description promising a refusal
 *    code the provider no longer throws would be a new lie, quieter than the
 *    one this replaced.
 */

const isolated = require('./lib/isolated-environment').activate('scheduler-tools-advertise-windows-only');
const assert = require('node:assert/strict');
const test = require('node:test');

void isolated;

const { SCHEDULER_WINDOWS_ONLY_NOTICE, schedulingSupported } = require('../src/lib/scheduled-actions');
const { listTools } = require('../src/lib/tool-registry');

const SCHEDULER_TOOLS = Object.freeze([
  'scheduler.list', 'scheduler.create', 'scheduler.remove', 'scheduler.reconcile'
]);

function advertised() {
  return listTools().filter(entry => entry.name.startsWith('scheduler.'));
}

test('scheduling support is decided by platform; the sentence describing it is not', () => {
  assert.equal(schedulingSupported('win32'), true);
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    assert.equal(schedulingSupported(platform), false, `${platform} has no scheduler adapter in this build`);
  }
  assert.equal(typeof SCHEDULER_WINDOWS_ONLY_NOTICE, 'string');
  assert.match(SCHEDULER_WINDOWS_ONLY_NOTICE, /Windows-only in this build/);
  assert.match(SCHEDULER_WINDOWS_ONLY_NOTICE, /SCHEDULER_PLATFORM_UNSUPPORTED/);
});

test('every advertised scheduler tool states the Windows-only limit', () => {
  const tools = advertised();
  assert.deepEqual(tools.map(entry => entry.name).sort(), [...SCHEDULER_TOOLS].sort(),
    'all four scheduler tools stay registered -- the approval policy names three of them');
  for (const entry of tools) {
    assert.ok(entry.description.endsWith(SCHEDULER_WINDOWS_ONLY_NOTICE),
      `${entry.name} is advertised without the platform notice: ${entry.description}`);
    assert.match(entry.description, /SCHEDULER_PLATFORM_UNSUPPORTED/,
      `${entry.name} does not name the refusal a caller will actually receive`);
  }
});

test('the refusal a caller receives is the one the description names', () => {
  // The provider is constructed here rather than reused from its module
  // singleton so the adapter-less platform is named by this test instead of
  // inherited from the runner, and so nothing in it can reach a real job
  // store: ensureInitialized() refuses before the state store is opened.
  const { createSchedulerProvider } = require('../src/lib/providers/scheduler');
  const provider = createSchedulerProvider({ platform: 'linux' });
  // Arguments good enough to pass every check that runs BEFORE the platform
  // gate, so what this measures is the platform refusal and not a schema one.
  const CALLS = Object.freeze({
    list: {},
    create: {
      name: 'advertised-then-refused', schedule: 'hourly', action: 'gmail.send',
      args: { to: 'owner@example.test', subject: 'scheduled', text: 'body' }
    },
    remove: { name: 'advertised-then-refused' },
    reconcile: {}
  });
  for (const [operation, input] of Object.entries(CALLS)) {
    assert.throws(() => provider[operation](input),
      error => {
        assert.equal(error.code, 'SCHEDULER_PLATFORM_UNSUPPORTED',
          `scheduler.${operation} refused with ${error.code}; the advertisement promises SCHEDULER_PLATFORM_UNSUPPORTED`);
        return true;
      },
      `scheduler.${operation} must refuse on a platform with no adapter`);
  }
  for (const entry of advertised()) {
    assert.ok(entry.description.includes('SCHEDULER_PLATFORM_UNSUPPORTED'),
      `${entry.name} must advertise the refusal code the provider just threw`);
  }
});
