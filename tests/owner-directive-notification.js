'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  directiveNotice,
  notifyCapturedDirective,
  runningAgentIds
} = require('../src/lib/owner-directive-notification');
const { main: captureMain } = require('../tools/owner-capture');
const presence = require('../src/lib/agent-presence');
const { createStateStore } = require('../src/lib/state-store');
const { createLocalAgentCommsRuntime } = require('../src/lib/agent-comms/local-runtime');

let checks = 0;
function check(label, fn) { fn(); checks += 1; void label; }

check('notice contains only bounded capture metadata, never owner text', () => {
  const body = directiveNotice({ id: 'R500', revision: 8, mode: 'new', scope: 'thread' });
  assert.match(body, /R500/);
  assert.match(body, /revision 8/);
  assert.doesNotMatch(body, /verbatim|interpretation/i);
});

check('running-agent projection excludes terminal, stale, and non-running records', () => {
  const records = [
    { agentId: 'live', status: 'running', liveness: 'running' },
    { agentId: 'heartbeat-fault', status: 'running', liveness: 'heartbeat-fault' },
    { agentId: 'stale', status: 'running', liveness: 'stale' },
    { agentId: 'finished', status: 'finished', liveness: 'finished' },
    { agentId: 'starting', status: 'starting', liveness: 'starting' }
  ];
  const ids = runningAgentIds({
    presenceApi: {
      readRegistry() { return { requests: 'fixture' }; },
      rosterRows() { return records; }
    }
  });
  assert.deepEqual(ids, ['live', 'heartbeat-fault']);
});

async function main() {
  const calls = [];
  const identity = agentId => ({ agentId, machineId: 'machine-a' });
  const result = await notifyCapturedDirective(
    { id: 'R501', revision: 9, mode: 'new', scope: 'global' },
    {
      listRunningAgents: () => ['agent-a', 'agent-b'],
      runtimeFactory() {
        return {
          identity,
          fabric: {
            async send(input, authentication) {
              calls.push({ input, authentication });
              return { accepted: true, code: 'FABRIC_DURABLE', mailboxDeliveries: [{ queued: true }] };
            }
          }
        };
      }
    }
  );
  checks += 1;
  assert.deepEqual(result, {
    status: 'notified', attempted: 2, notified: 2, failed: 0,
    deliveries: [
      { recipientId: 'agent-a', delivered: true },
      { recipientId: 'agent-b', delivered: true }
    ]
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.sender.agentId, 'owner');
  assert.equal(calls[0].input.kind, 'notice');
  assert.equal(calls[0].authentication.identity.agentId, 'owner');

  let invalidRecipientsRuntimeCalls = 0;
  const invalidRecipients = await notifyCapturedDirective(
    { id: 'R501-invalid', revision: 9, mode: 'new', scope: 'global' },
    {
      listRunningAgents: () => ({ agentId: 'not-an-array' }),
      runtimeFactory() {
        invalidRecipientsRuntimeCalls += 1;
        throw new Error('runtime must not be created for invalid recipients');
      }
    }
  );
  checks += 1;
  assert.deepEqual(invalidRecipients, {
    status: 'uncertain',
    attempted: 0,
    notified: 0,
    failed: 0,
    code: 'OWNER_DIRECTIVE_NOTIFICATION_RECIPIENTS_INVALID'
  });
  assert.equal(invalidRecipientsRuntimeCalls, 0,
    'refusal must happen before runtime creation, so no delivery process or durable write can start');

  const noAgents = await notifyCapturedDirective({ id: 'R502', revision: 10, mode: 'append', scope: 'unclassified' }, {
    listRunningAgents: () => []
  });
  checks += 1;
  assert.deepEqual(noAgents, { status: 'no-running-agents', attempted: 0, notified: 0, failed: 0 });

  const partial = await notifyCapturedDirective({ id: 'R503', revision: 11, mode: 'new', scope: 'global' }, {
    listRunningAgents: () => ['agent-a'],
    runtimeFactory() {
      return {
        identity,
        fabric: { async send() { return { accepted: false, code: 'FABRIC_REFUSED' }; } }
      };
    }
  });
  checks += 1;
  assert.deepEqual(partial, {
    status: 'partial', attempted: 1, notified: 0, failed: 1,
    deliveries: [{ recipientId: 'agent-a', delivered: false, code: 'FABRIC_REFUSED' }]
  });

  for (const mailboxDeliveries of [undefined, []]) {
    const unconfirmed = await notifyCapturedDirective({ id: 'R503', revision: 11, mode: 'new', scope: 'global' }, {
      listRunningAgents: () => ['agent-a'],
      runtimeFactory() {
        return {
          identity,
          fabric: { async send() { return { accepted: true, mailboxDeliveries }; } }
        };
      }
    });
    checks += 1;
    assert.deepEqual(unconfirmed, {
      status: 'partial', attempted: 1, notified: 0, failed: 1,
      deliveries: [{
        recipientId: 'agent-a',
        delivered: false,
        code: 'OWNER_DIRECTIVE_NOTIFICATION_MAILBOX_DELIVERY_UNCONFIRMED'
      }]
    });
  }

  const uncertain = await notifyCapturedDirective({ id: 'R504', revision: 12, mode: 'new', scope: 'global' }, {
    listRunningAgents() { const error = new Error('presence unavailable'); error.code = 'AGENT_PRESENCE_UNAVAILABLE'; throw error; }
  });
  checks += 1;
  assert.deepEqual(uncertain, {
    status: 'uncertain', attempted: 0, notified: 0, failed: 0, code: 'AGENT_PRESENCE_UNAVAILABLE'
  });

  const commsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-directive-comms-test-'));
  const presenceFile = path.join(commsDirectory, 'presence.json');
  const mailboxDir = path.join(commsDirectory, 'mailbox');
  const orgFile = path.join(commsDirectory, 'agent-org.json');
  const store = createStateStore({ file: path.join(commsDirectory, 'fabric.sqlite3'), ownerId: 'owner-directive-notification-test' });
  fs.writeFileSync(orgFile, JSON.stringify({ agents: [] }), 'utf8');
  const registered = presence.register({
    agentId: 'worker-one', runId: '11111111-1111-4111-8111-111111111111', role: 'worker', tier: 'test',
    reportsTo: 'coordinator-sol', dispatcher: 'coordinator-sol', lane: 'notification-test', territory: 'tests/**',
    currentTask: 'test', brief: 'brief.md', consoleLog: 'test.log', worktree: commsDirectory, launchSpec: 'launch.json',
    pid: null, startedAt: 1000, lastHeartbeat: 1000, status: 'starting', exitCode: null, lastVerdict: null,
    terminalAt: null, staleReason: null, mailboxOffset: 0, respawnCount: 0, verdictConsumedAt: null
  }, { file: presenceFile });
  presence.heartbeat('worker-one', registered.runId, { mailboxOffset: 0, at: 1000 }, { file: presenceFile });
  try {
    const durable = await notifyCapturedDirective({ id: 'R504', revision: 12, mode: 'new', scope: 'global' }, {
      listRunningAgents: () => ['worker-one'],
      runtimeFactory: options => createLocalAgentCommsRuntime({
        ...options, store, presenceFile, mailboxDir, orgFile, brokerFile: path.join(commsDirectory, 'broker.json')
      })
    });
    checks += 1;
    assert.equal(durable.status, 'notified');
    const mailbox = presence.drainMailbox('worker-one', 0, { mailboxDir });
    assert.equal(mailbox.entries.length, 1, 'existing local fabric queued the directive notice in the live agent mailbox');
    assert.match(mailbox.entries[0].prompt, /R504/);
  } finally {
    store.close();
    fs.rmSync(commsDirectory, { recursive: true, force: true });
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-directive-notification-test-'));
  const ledger = path.join(directory, 'OWNER-REQUEST-LEDGER.json');
  fs.writeFileSync(ledger, JSON.stringify({ revision: 0, requests: [] }), 'utf8');
  let persistedBeforeNotify = false;
  try {
    const capture = await captureMain([
      '--ledger', ledger, '--new-id', 'R505', '--interpretation', 'capture ordering test',
      '--actor', 'controller', '--text', 'owner words'
    ], {
      async notify(input) {
        persistedBeforeNotify = fs.existsSync(`${ledger}.bak`)
          && JSON.parse(fs.readFileSync(ledger, 'utf8')).requests.some(entry => entry.id === input.id);
        const error = new Error('fabric unavailable');
        error.code = 'AGENT_COMMS_RELAY_CREDENTIAL_UNAVAILABLE';
        throw error;
      }
    });
    checks += 1;
    assert.equal(persistedBeforeNotify, true, 'notification runs only after the atomic ledger write');
    assert.equal(capture.notification.status, 'uncertain');
    assert.equal(capture.notification.code, 'AGENT_COMMS_RELAY_CREDENTIAL_UNAVAILABLE');
    assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8')).requests[0].id, 'R505', 'notification failure never rolls back capture');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log(`Owner-directive notification tests passed (${checks} checks).`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
