// Mutation check:
// In src/lib/setup/pairing.js, changed pairedConfirmation's "Paired with" prefix
// to "Connected to". The edit landed (confirmed in the module diff).
// This isolated test file went red with exit code 1 on that mutation.

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  pairingStatus,
  inviteInstruction,
  pairedConfirmation,
  peerRegistryPath
} = require('../../src/lib/setup/pairing');

test('pairing exports turn concrete setup values into customer-facing behaviour', () => {
  const missingRegistry = {
    readFileSync() {
      const error = new Error('missing fixture');
      error.code = 'ENOENT';
      throw error;
    }
  };

  assert.deepEqual(pairingStatus('/computer-a', { fs: missingRegistry }), {
    paired: false,
    count: 0,
    computers: [],
    summary: 'This computer is working on its own. Nothing needs to be set up.',
    nextStep: 'add-computer'
  });

  assert.deepEqual(inviteInstruction({
    bind: '192.0.2.14',
    port: 4319,
    code: 'orchid-7',
    minutes: 5,
    fingerprint: 'SHA256:example',
    joinCommand: 'toolsenabled pair join'
  }), [
    '',
    'On the other computer, open ToolsEnabled setup and run:',
    '',
    '  toolsenabled pair join --address 192.0.2.14:4319 --code orchid-7',
    '',
    'This code works once and stops working in 5 minute(s).',
    'Read it off this screen and type it on the other computer. Do not send it anywhere --',
    'not by message, not by email. Nobody ever needs to be told this code except you.',
    '',
    'If the other computer shows a fingerprint, check it matches this one: SHA256:example',
    ''
  ]);

  assert.equal(
    pairedConfirmation('Studio PC', 'SHA256:studio'),
    'Paired with Studio PC. Check that SHA256:studio is the fingerprint shown on the other computer.'
  );
  assert.equal(
    peerRegistryPath(path.join('relative', 'install')),
    path.join(path.resolve('relative', 'install'), 'config', 'peers.profile.json')
  );
});
