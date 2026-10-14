'use strict';

// 1.0.50 review L6: THE audit.tail TOOL DOES NOT HAND OTHER SESSIONS' COMMAND
// LINES TO A GUIDED CALLER.
//
// host.exec.intent records the full command line, and audit.tail (local-read,
// on the Guided and Guarded surfaces) returned it after scrub(), which left
// `mysql -p...`, `curl -u user:...` and `sshpass -p ...` intact. The tool view
// now shows a command only as its length. audit.tail() itself feeds metrics,
// attribution and the digest, so it is replaced here with a synthetic ledger
// and the TOOL is driven through executeTool().
//
// NO CREDENTIAL VALUE APPEARS HERE: every "secret" is a labelled canary.

require('./lib/isolated-environment').activate('audit-tail-command-withheld');

const assert = require('node:assert/strict');
const test = require('node:test');

const audit = require('../src/lib/audit');
const registry = require('../src/lib/tool-registry');

const COMMANDS = Object.freeze([
  'mysql -pCANARY-mysql-pass -u root app',
  'curl -u someone:CANARY-curl-pass https://example.invalid/api',
  'sshpass -p CANARY-ssh-pass ssh host true'
]);
const LEDGER = Object.freeze([
  ...COMMANDS.map((command, index) => ({
    action: 'host.exec.intent', target: '/\x68ome/someone/project', sequence: index + 1,
    details: { shell: 'bash', timeoutMs: 120000, command }
  })),
  { action: 'controller.agent.launch', target: 'lane-1', sequence: 4,
    details: { verificationCommand: { command: 'npm', args: ['test', '--token=CANARY-arg'] } } },
  { action: 'host.read_file.intent', target: '/\x68ome/someone/project/readme.md', sequence: 5, details: { bytes: 42 } }
]);

const originalTail = audit.tail;
test.after(() => { audit.tail = originalTail; });

test('the audit.tail tool shows a command line only as its length', async () => {
  const asked = [];
  audit.tail = limit => { asked.push(limit); return JSON.parse(JSON.stringify(LEDGER)); };
  const CONFINED = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
  const rows = await registry.executeTool('audit.tail', { limit: 200 }, { permissionSession: CONFINED });
  assert.deepEqual(asked, [200], 'the tool reads the ledger tail once, at the requested size');
  const text = JSON.stringify(rows);
  assert.equal(/CANARY/.test(text), false, `no inline credential may reach the caller: ${text}`);
  for (const [index, command] of COMMANDS.entries()) {
    assert.equal(rows[index].details.command, `[command withheld: ${command.length} characters]`);
    assert.equal(rows[index].details.shell, 'bash', 'the rest of the row is unchanged');
    assert.equal(rows[index].details.timeoutMs, 120000);
    assert.equal(rows[index].action, 'host.exec.intent');
  }
  assert.deepEqual(rows[3].details.verificationCommand, {
    command: '[command withheld: 3 characters]', args: '[arguments withheld: 2]'
  });
  assert.deepEqual(rows[4], LEDGER[4], 'rows without a command are returned as they were');
});

test('audit.tail() itself is unchanged for the in-process readers', () => {
  const events = [{ action: 'host.exec.intent', details: { command: 'echo CANARY-internal' } }];
  assert.deepEqual(audit.withholdCommandText(events[0]).details, { command: '[command withheld: 20 characters]' });
  assert.equal(events[0].details.command, 'echo CANARY-internal', 'the helper must not mutate what it was given');
});
