'use strict';
/* T31 WALK — new-send forwarding after replacement through the real modules.
 *
 * Not a unit test: this builds a real directory file and a real broker file on
 * disk and drives the same provider the app calls, so the receipt shows what a
 * person would actually get. Every step prints what was asked and what came
 * back. Nothing here stubs the directory, the broker or the resolver.
 *
 * This does not yet prove recovery of a message read by the old app session.
 * The app's predecessor-inbox drain needs a separate pre-replacement step.
 *
 *   node tools/t31-walk.js --scratch-root <existing absolute directory>
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const suppliedRoot = process.argv[2] === '--scratch-root' && process.argv.length === 4
  ? process.argv[3] : null;
if (!suppliedRoot || !path.isAbsolute(suppliedRoot)) {
  throw new Error('Use --scratch-root with an existing absolute directory for isolated walk state.');
}
const scratchBase = fs.realpathSync(suppliedRoot);
const scratch = fs.mkdtempSync(path.join(scratchBase, 't31-walk-'));
if (path.dirname(scratch) !== scratchBase) throw new Error('Walk scratch escaped the supplied directory.');
os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
// Configure every state-store path before loading any product module. Supplying
// only directoryFile and brokerFile leaves fabric history in the ambient store.
require('../tests/lib/isolated-environment').configure(scratch);
process.env.TEMP = scratch;
process.env.TMP = scratch;

const { createTreeNodeDirectory, agentIdForSession } = require('../src/lib/agent-comms/tree-node-directory.js');
const { createLocalAgentMessageProvider } = require('../src/lib/providers/agent-comms-local.js');

const directoryFile = path.join(scratch, 'tree-nodes.json');
const brokerFile = path.join(scratch, 'local-broker.json');

let clock = 1_000_000;
const now = () => clock;
const tick = ms => { clock += ms; };

const directory = createTreeNodeDirectory({ file: directoryFile, now, pidIsAlive: () => true });
const provider = createLocalAgentMessageProvider({ directory, brokerFile, now });
const managerContext = Object.freeze({
  agentSessionId: 'sess-manager',
  agentPrincipal: Object.freeze({ kind: 'agent-session', sessionId: 'sess-manager', agentId: agentIdForSession('sess-manager') })
});

let step = 0;
const say = (what, detail) => {
  step += 1;
  console.log(`\n[${String(step).padStart(2, '0')}] ${what}`);
  if (detail !== undefined) console.log('     ' + JSON.stringify(detail));
};
let failures = 0;
const expect = (label, actual, wanted) => {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failures += 1;
  console.log(`     ${ok ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (wanted ${JSON.stringify(wanted)})`}`);
};

async function main() {
  console.log('T31 WALK — new-send forwarding after replacement');
  console.log('scratch: ' + scratch.replaceAll('\\', '/'));

  // --- The person starts a tree: a Manager and a Worker under it.
  say('The person starts a Manager and a Worker beneath it.');
  directory.registerNode({ sessionId: 'sess-manager', nodeName: 'Manager', nodeKey: 'node-1-manager', treeKey: 'node-1-manager' });
  directory.registerNode({ sessionId: 'sess-worker-a', nodeName: 'Worker 4', managerSessionId: 'sess-manager',
    managerName: 'Manager', nodeKey: 'node-2-worker', treeKey: 'node-1-manager' });
  const workerBefore = agentIdForSession('sess-worker-a');
  console.log('     Worker 4 address before the move: ' + workerBefore);

  // --- An ordinary message, so the baseline is real.
  say('Manager writes to Worker 4 while it is running.');
  const first = await provider.send({ from: 'Manager', to: 'Worker 4', body: 'Start on the census.' }, managerContext);
  expect('accepted', first.accepted, true);
  expect('landed on the running Worker', first.to, 'Worker 4');
  const baselinePage = await provider.inbox({ agentId: workerBefore, cursor: 0, limit: 25 });
  expect('baseline inbox contains one message', baselinePage.page?.records?.map(record => record.message?.body),
    ['Manager: Start on the census.']);

  say('Worker 4 misses a heartbeat while Manager remains active.');
  tick(90_001);
  directory.heartbeatNode({ sessionId: 'sess-manager' });
  const gap = provider.roster({ from: 'Manager' }, managerContext).unavailable.find(row => row.nodeName === 'Worker 4');
  expect('the row is shown as transient, not a confirmed stop', gap?.transient, true);
  expect('the row retains its last-seen heartbeat', gap?.lastSeenAt, 1_000_000);
  expect('the status explains the missed heartbeat', gap?.status, 'heartbeat-overdue');

  // --- The person stops it and continues it on another account. The app
  //     starts a NEW session for the same saved circle.
  say('The person replaces Worker 4 with a new session of the same saved circle.');
  tick(1000);
  directory.registerNode({ sessionId: 'sess-worker-b', nodeName: 'Worker 4', managerSessionId: 'sess-manager',
    managerName: 'Manager', nodeKey: 'node-2-worker', treeKey: 'node-1-manager', replacesSessionId: 'sess-worker-a' });
  const workerAfter = agentIdForSession('sess-worker-b');
  console.log('     Worker 4 address after the move:  ' + workerAfter);
  expect('the address really did change', workerBefore !== workerAfter, true);

  // --- THE DEFECT THIS FIXES: a message addressed to the old address.
  say('Manager sends a NEW message after replacement, using the OLD address.');
  const toOld = await provider.send({ from: 'Manager', to: workerBefore, body: 'Did the census finish?' }, managerContext);
  expect('accepted rather than refused', toOld.accepted, true);

  say('Worker 4 reads the new session inbox.');
  const page = await provider.inbox({ agentId: workerAfter, cursor: 0, limit: 25 });
  const bodies = (page.page?.records || []).map(record => record.message?.body);
  console.log('     inbox: ' + JSON.stringify(bodies));
  expect('exactly one forwarded message arrived', bodies, ['Manager: Did the census finish?']);

  // --- The naming half, as the math tree's manager met it.
  say('A second tree appears, with its own Controller, and the person links the two trees.');
  directory.registerNode({ sessionId: 'sess-ctrl-ours', nodeName: 'Controller (da02fefa)', managerSessionId: 'sess-manager',
    managerName: 'Manager', nodeKey: 'node-7-ours', treeKey: 'node-1-manager' });
  directory.registerNode({ sessionId: 'sess-ctrl-theirs', nodeName: 'Controller (850c7379)', nodeKey: 'node-9-theirs', treeKey: 'node-9-theirs' });
  directory.setLink({ from: 'node-1-manager', to: 'node-9-theirs' });

  say('The Manager reads its roster, the way the math tree\'s manager did before it chose wrong.');
  const rosterAnswer = provider.roster({ from: 'Manager' }, managerContext);
  const roster = rosterAnswer.reachable;
  for (const row of roster) console.log(`     ${row.nodeName}  relation=${row.relation}  tree=${row.treeKey}  lastSeen=${row.lastSeenAt}  transient=${row.transient}`);
  expect('all live rows have a last-seen timestamp', roster.every(row => Number.isFinite(row.lastSeenAt)), true);
  expect('all live rows explicitly clear the transient flag', roster.every(row => row.transient === false), true);
  expect('the replacement appears once as reachable', roster.filter(row => row.nodeName === 'Worker 4').length, 1);
  expect('the predecessor is not also shown as stopped', rosterAnswer.unavailable.filter(row => row.nodeName === 'Worker 4').length, 0);
  const ours = roster.find(row => row.nodeName === 'Controller (da02fefa)');
  const theirs = roster.find(row => row.nodeName === 'Controller (850c7379)');
  expect('own Controller is marked as a report', ours?.relation, 'reports-to-sender');
  expect('linked Controller is marked as linked', theirs?.relation, 'linked-agent');
  expect('the two Controllers show different trees', ours?.treeKey !== theirs?.treeKey, true);

  say('The Manager types the bare name "Controller" while TWO are reachable.');
  const ambiguous = await provider.send({ from: 'Manager', to: 'Controller', body: 'ping' }, managerContext);
  console.log('     answer: ' + JSON.stringify(ambiguous.reason || ambiguous.code || ambiguous));
  expect('refused rather than guessed', ambiguous.accepted, false);
  expect('both choices are named', /Controller \(da02fefa\)/.test(ambiguous.reason) && /Controller \(850c7379\)/.test(ambiguous.reason), true);

  say('The person removes the link; now only one Controller is reachable and the bare name should work.');
  directory.setLink({ from: 'node-1-manager', to: 'node-9-theirs', connected: false });
  const bare = await provider.send({ from: 'Manager', to: 'Controller', body: 'ping' }, managerContext);
  expect('a bare unique name resolves', bare.accepted, true);
  expect('and lands on the only reachable Controller', bare.to, 'Controller (da02fefa)');

  say('A name that matches nothing.');
  const unknown = await provider.send({ from: 'Manager', to: 'Contoller', body: 'ping' }, managerContext);
  console.log('     answer: ' + JSON.stringify(unknown.reason || unknown.code || unknown));
  expect('refused', unknown.accepted, false);
  expect('the reachable near-match is named', /Controller \(da02fefa\)/.test(unknown.reason), true);

  say('A Controller starts six reports with cached manager labels and no manager session IDs.');
  const rootBefore = { sessionId: 'drift-controller-before', nodeName: 'Controller (continued)',
    nodeKey: 'drift-controller-node', treeKey: 'drift-tree' };
  directory.registerNode(rootBefore);
  const reports = Array.from({ length: 6 }, (_, index) => ({
    sessionId: `drift-report-${index}`, nodeName: `Report ${index + 1}`,
    nodeKey: `drift-report-node-${index}`, treeKey: rootBefore.treeKey, managerName: rootBefore.nodeName
  }));
  for (const report of reports) directory.registerNode(report);
  const contextFor = sessionId => ({ agentSessionId: sessionId,
    agentPrincipal: { kind: 'agent-session', sessionId, agentId: agentIdForSession(sessionId) } });
  const reportContext = contextFor(reports[0].sessionId);
  const initial = await provider.send({ from: reports[0].nodeName, to: rootBefore.nodeName,
    body: 'Before continuation.' }, reportContext);
  expect('the original manager receives its report', initial.accepted, true);

  say('The Controller continues with the same nodeKey, a new session, and a bare display name.');
  directory.unregisterNode({ sessionId: rootBefore.sessionId });
  const rootAfter = { ...rootBefore, sessionId: 'drift-controller-after', nodeName: 'Controller' };
  directory.registerNode(rootAfter);
  const rootContext = contextFor(rootAfter.sessionId);
  const afterRoster = provider.roster({ from: 'Controller' }, rootContext);
  console.log('     roster: ' + JSON.stringify(afterRoster));
  expect('all six reports remain reachable', afterRoster.reachable.map(row => row.nodeName), reports.map(row => row.nodeName));
  expect('all six retain the reports-to-sender relationship', afterRoster.reachable.every(row => row.relation === 'reports-to-sender'), true);

  say('A report sends to the new bare name and its cached suffixed name; the Controller replies.');
  for (const [to, body] of [['Controller', 'Bare name after continuation.'], [rootBefore.nodeName, 'Cached name after continuation.']]) {
    const sent = await provider.send({ from: reports[0].nodeName, to, body }, reportContext);
    console.log('     send: ' + JSON.stringify(sent));
    expect('new send is accepted', sent.accepted, true);
  }
  const reply = await provider.send({ from: 'Controller', to: reports[0].nodeName, body: 'Reply after continuation.' }, rootContext);
  expect('the return direction remains connected', reply.accepted, true);
  const managerInbox = await provider.inbox({ agentId: agentIdForSession(rootAfter.sessionId), cursor: 0, limit: 25 });
  expect('each new message arrives exactly once', managerInbox.page.records.map(row => row.message.body),
    ['Report 1: Bare name after continuation.', 'Report 1: Cached name after continuation.']);
  const reportInbox = await provider.inbox({ agentId: agentIdForSession(reports[0].sessionId), cursor: 0, limit: 25 });
  expect('the reply arrives exactly once', reportInbox.page.records.map(row => row.message.body), ['Controller: Reply after continuation.']);

  say('The report re-registers its unchanged cached brief after the manager continuation.');
  directory.registerNode(reports[0]);
  const refreshed = provider.roster({ from: reports[0].nodeName }, reportContext);
  console.log('     roster: ' + JSON.stringify(refreshed));
  expect('it still has one current manager', refreshed.reachable.map(row => [row.nodeName, row.relation]), [['Controller', 'manager']]);
  expect('there is no unresolved or stopped phantom manager', refreshed.unavailable, []);

  console.log(`\n=== ${failures === 0 ? 'WALK GREEN' : `WALK RED: ${failures} expectation(s) failed`} ===`);
  console.log('evidence: ' + scratch.replaceAll('\\', '/'));
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(error => {
  console.error('WALK ABORTED: ' + (error && error.stack || error));
  process.exitCode = 1;
});
