'use strict';
/* The OpenShell policy tools on denial lines as OpenShell 0.1.2 actually
 * writes them, and on proposals that would not match the denial they cite. */

const test = require('node:test');
const assert = require('node:assert/strict');

const openshell = require('../src/lib/providers/openshell');
const { toolError } = require('../src/mcp-server');

const INSIDE = { OPENSHELL_SANDBOX: '1' };
// Seen in the hand test's HT-27 log (run16): OpenShell could not tell which program connected.
const UNIDENTIFIED = '[1790708008.405] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED -(0) -> api.anthropic.com:443 [reason:transparent_tcp_identity_unavailable]';
const CURL = '[1790708040.251] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(0) -> example.com:443 [reason:transparent_tcp_policy_denied]';

function fakeClient(denials) {
  const submitted = [];
  return {
    submitted,
    async getDenials() { return { denials, log_available: true }; },
    async submitProposals(body) { submitted.push(body); return { chunk_id: 'chunk-1', status: 'pending' }; },
  };
}

test('a denial whose program OpenShell could not identify is explained as such and needs the program to propose', async () => {
  const client = fakeClient([UNIDENTIFIED]);
  const { denials: [denial] } = await openshell.denials({ env: INSIDE, client });
  assert.equal(denial.understood, true);
  assert.equal(denial.binary, null, '"-" is no program');
  assert.match(denial.explanation, /^A program OpenShell could not identify tried to reach api\.anthropic\.com:443/);
  assert.equal(denial.narrowestProposal, null, 'no rule is drafted for a program called "-"');
  assert.match(denial.proposalNeeds, /absolute path of the program/);
  await assert.rejects(openshell.propose({ denial: UNIDENTIFIED, intent: 'Reach the API.', env: INSIDE, client }),
    { code: 'OPENSHELL_PROPOSAL_NO_BINARY' });
  const result = await openshell.propose({ denial: UNIDENTIFIED, intent: 'Reach the API.', binary: '/usr/bin/curl', env: INSIDE, client });
  assert.deepEqual(result.proposal.operations[0].addRule.rule.binaries, [{ path: '/usr/bin/curl' }]);
  assert.equal(client.submitted.length, 1);
});

test('a proposal allows the program its denial names and no other', async () => {
  const client = fakeClient([CURL]);
  const error = await openshell.propose({ denial: CURL, intent: 'Fetch the page.', binary: '/usr/local/bin/node', env: INSIDE, client })
    .then(() => null, caught => caught);
  assert.equal(error && error.code, 'OPENSHELL_PROPOSAL_BINARY_MISMATCH');
  assert.equal(client.submitted.length, 0, 'nothing was filed');
  assert.match(toolError(error).content[0].text, /^This denial names the program OpenShell blocked, \/usr\/bin\/curl, and a proposal for it allows exactly that program\./);
  const same = await openshell.propose({ denial: CURL, intent: 'Fetch the page.', binary: '/usr/bin/curl', env: INSIDE, client });
  assert.deepEqual(same.proposal.operations[0].addRule.rule.binaries, [{ path: '/usr/bin/curl' }], 'naming the same program is fine');
});

test('denials fill one answer only as far as a CLI keeps a result, and say how many more there are', async () => {
  const lines = [];
  for (let index = 0; index < 60; index += 1) {
    lines.push(`[1790708040.251] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex(0) -> host${index}.example.com:443 [reason:transparent_tcp_policy_denied]`);
  }
  const client = fakeClient(lines);
  const answer = await openshell.denials({ last: 50, env: INSIDE, client });
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= 32 * 1024, 'fits in 32 KiB of result text');
  assert.ok(answer.count >= 10 && answer.count < 50, `a useful number still fits (${answer.count})`);
  assert.equal(answer.moreDenials, 50 - answer.count);
  assert.match(answer.moreDenialsNote, /pass host to list one host's denials/);
  const one = await openshell.denials({ last: 50, host: 'host42.example.com', env: INSIDE, client });
  assert.equal(one.count, 1);
  assert.equal(one.moreDenials, undefined);
  const few = await openshell.denials({ env: INSIDE, client });
  assert.equal(few.count, 10, 'the default ten fit whole');
  assert.equal(few.moreDenials, undefined);
});

test('gateway-host denials never draft or submit a second rule granting another program access', async () => {
  const reach = require('../src/lib/openshell-host-reach');
  const explainer = require('../src/lib/openshell-denial-explainer');
  for (const host of ['host.openshell.internal', 'HOST.OPENSHELL.INTERNAL.', '*.openshell.internal', '**.internal', '**.host.openshell.internal', 'localhost', '127.0.0.1']) {
    assert.ok(reach.endpointReachesHost({ host, port: 49152, path: '/*' }), host);
  }
  assert.equal(reach.endpointReachesHost({ host: 'api.example.com', port: 18795, path: '/mcp/worker' }), null);
  for (const port of [18795, 49152]) {
    const denial = `[1790708040.251] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(0) -> host.openshell.internal:${port} [reason:transparent_tcp_policy_denied]`;
    const client = fakeClient([denial]);
    assert.equal(explainer.explainDenial(denial).suggestedCommand, null);
    const listed = await openshell.denials({ env: INSIDE, client });
    assert.equal(listed.denials[0].narrowestProposal, null);
    assert.equal(listed.denials[0].proposalRefused.code, reach.REFUSAL_CODE);
    await assert.rejects(openshell.propose({ denial, intent: 'Use the host grant.', env: INSIDE, client }), error => {
      assert.equal(error.code, reach.REFUSAL_CODE);
      assert.match(toolError(error).content[0].text, /only the person writes rules/);
      return true;
    });
    assert.equal(client.submitted.length, 0);
  }
});
