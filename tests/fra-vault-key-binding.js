// EXECUTABLE CHANGE -- assertion audit report (testcanfail-tests-fra-vault-key-binding-js)
//
// Strengthened assertion: the lane-separation check now compares the live
// listener exports rather than the two unequal literals declared by this test.
// Mutation: src/remote-agent-bridge.js TOKEN_VAULT_KEY was temporarily changed
// from custom.remote_agent_bridge_token to custom.full_remote_access_token.
// RED (node v24.15.0):
//   AssertionError [ERR_ASSERTION]: the FRA and bridge lanes must not share a credential slot
//   actual: 'custom.full_remote_access_token'
//   expected: 'custom.full_remote_access_token'
//   operator: 'notStrictEqual'
// The source was restored byte-for-byte (sha256sum -c and cmp both passed).
// Restored GREEN:
//   FRA and bridge credential slots are bound across 5 FRA and 4 bridge participants in 2 languages.
// Preconditions: system node v20.20.2 lacks node:sqlite; node v24.15.0 was used.
// NOT-FOUND (1): neither loop can be empty; both iterate fixed, nonempty object
// literals, and failed PowerShell parses assert before those objects are built.
// NOT-FOUND (2): no exit-status or truthy process-return assertion exists.
// NOT-FOUND (3): no try/catch or optional chain swallows a test failure.
// NOT-FOUND (4): no mocks are used.
// NOT-FOUND (5): no skip or platform precondition guard exists.
// NOT-FOUND (6), otherwise: expected credential values are independent literals;
// the one exception was the lane-separation assertion strengthened below.

'use strict';

// Bind every module that names an FRA or bridge credential slot to one value.
//
// This test exists because of a real outage. The rendezvous engine wrote the
// converged credential to 'custom.remote_agent_bridge_token' while the FRA
// listener read 'custom.full_remote_access_token'. Both machines reached
// generation 8, both reported a converged pair, and FRA refused every session
// because the slot the writer filled was not the slot the reader opened. Every
// test passed throughout, because no test connected the writer's constant to
// the reader's constant -- they were only ever checked in isolation.
//
// So the assertions here are deliberately cross-module: change any one of these
// constants alone and this fails loudly, naming the file that drifted.
//
// The JavaScript values are read from the live module exports rather than from
// source text, so a renamed constant or a module that stops exporting one is a
// failure rather than a silent pass. The two PowerShell files have no export
// surface, so their constants are parsed -- and a parse that finds nothing is
// itself a failure, for the same reason.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FRA_KEY = 'custom.full_remote_access_token';
const BRIDGE_KEY = 'custom.remote_agent_bridge_token';

const fraServer = require('../src/full-remote-access-bridge');
const fraProxy = require('../tools/remote-agent-mcp-proxy');
const fraEnroll = require('../tools/full-remote-access-enroll-token');
const bridgeServer = require('../src/remote-agent-bridge');

function parsed(relative, pattern, label) {
  const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const match = text.match(pattern);
  // A pattern that stops matching means the constant was renamed or moved. That
  // must fail, never quietly skip: a skipped check is how the original defect
  // survived a full test suite.
  assert.ok(match, `${relative}: could not find ${label} -- the pattern this test binds to no longer matches, so the binding is unverified`);
  return match[1];
}

// ---- the FRA credential: one slot, five modules, two languages -------------

const fraWriters = {
  'packages/servercontrol/Mechanical-Connect.ps1 $script:VaultKey (the rendezvous minter/receiver)':
    parsed('packages/servercontrol/Mechanical-Connect.ps1',
      /\$script:VaultKey\s*=\s*'([^']+)'/, '$script:VaultKey'),
  'packages/servercontrol/Tunnel-Lifecycle.ps1 Secret-Exists FullRemote (the tray readiness check)':
    parsed('packages/servercontrol/Tunnel-Lifecycle.ps1',
      /'FullRemote'[\s\S]{0,200}?default\s*\{\s*'([^']+)'\s*\}/, "the FullRemote lane's key")
};
const fraReaders = {
  'src/full-remote-access-bridge.js FRA_TOKEN_VAULT_KEY (the 8790 listener)': fraServer.FRA_TOKEN_VAULT_KEY,
  'tools/remote-agent-mcp-proxy.js FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY (the client)': fraProxy.FULL_REMOTE_ACCESS_TOKEN_VAULT_KEY,
  'tools/full-remote-access-enroll-token.js VAULT_KEY (enrollment target)': fraEnroll.VAULT_KEY
};

for (const [where, value] of Object.entries({ ...fraWriters, ...fraReaders })) {
  assert.equal(value, FRA_KEY,
    `${where} names ${JSON.stringify(value)}; every FRA participant must name ${JSON.stringify(FRA_KEY)}. A writer and a reader pointing at different slots converges a credential nobody reads.`);
}

// ---- the bridge credential: a different slot, and it must stay different ---

const bridgeParticipants = {
  'src/remote-agent-bridge.js TOKEN_VAULT_KEY (the 8788 listener)': bridgeServer.TOKEN_VAULT_KEY,
  'tools/remote-agent-mcp-proxy.js BRIDGE_TOKEN_VAULT_KEY (the bounded client)': fraProxy.BRIDGE_TOKEN_VAULT_KEY,
  'tools/full-remote-access-enroll-token.js BOOTSTRAP_VAULT_KEY (enrollment bootstrap)': fraEnroll.BOOTSTRAP_VAULT_KEY,
  'packages/servercontrol/Tunnel-Lifecycle.ps1 Secret-Exists Bridge (the tray readiness check)':
    parsed('packages/servercontrol/Tunnel-Lifecycle.ps1',
      /'Bridge'\s*\{\s*'([^']+)'\s*\}/, "the Bridge lane's key")
};

// Use values observed from the product on both sides. Comparing FRA_KEY and
// BRIDGE_KEY here would only prove that this test's two literals differ.
assert.notEqual(fraServer.FRA_TOKEN_VAULT_KEY, bridgeServer.TOKEN_VAULT_KEY,
  'the FRA and bridge lanes must not share a credential slot');

for (const [where, value] of Object.entries(bridgeParticipants)) {
  assert.equal(value, BRIDGE_KEY,
    `${where} names ${JSON.stringify(value)}; every bridge participant must name ${JSON.stringify(BRIDGE_KEY)}.`);
}

// The two lanes are separately credentialed on purpose: FRA is complete agentic
// control, the bridge is a bounded tool subset. Collapsing them onto one slot
// would silently grant the bridge's credential FRA's authority.
// The rendezvous engine converges the FRA credential and must not also write the
// bridge slot -- that is exactly the defect this test was written for.
const engine = fs.readFileSync(path.join(ROOT, 'packages/servercontrol/Mechanical-Connect.ps1'), 'utf8');
assert.ok(!engine.includes(BRIDGE_KEY),
  'the rendezvous engine references the bridge credential slot; it converges the FRA credential and the bridge has its own enrollment path');

console.log(`FRA and bridge credential slots are bound across ${Object.keys(fraWriters).length + Object.keys(fraReaders).length} FRA and ${Object.keys(bridgeParticipants).length} bridge participants in 2 languages.`);
