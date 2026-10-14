'use strict';

// DOES AN AGENT RUNNING PREFLIGHT ACTUALLY SEE THE AUTHORIZATION, AND ITS LIMITS.
//
// Owner directive 2026-08-11: "Literally this has to be read off from settings
// or something to agents clearly, my settings are do it under my authorized
// name - ive authorized you ... the only thing that should be waiting on me is
// accepting the purchase list and pressing post on instagram".
//
// The measured failure was agents reaching an identity-bearing action, finding
// no machine-readable authorization, and stopping -- one lane stopped 18 times
// on 18 attempts. So the thing under test is not "the record exists" and not
// "the source mentions it". It is: RUN the surface an agent is required to run,
// and read what came out.
//
// Source-text assertions cannot see reachability -- dead code matches a grep as
// happily as live code -- so every assertion below reads the STDOUT of a real
// `node tools/agent-preflight.js` process, or the real rendered onboarding
// packet. If someone deletes the wiring but leaves the module, these go red.
//
// BOTH DIRECTIONS ARE PINNED, because this feature has two opposite failure
// modes and only one of them is obvious:
//
//   remove the grant       -> agents stop again on work he authorized.
//   remove a reservation   -> agents do something he kept for himself.
//
// The second is the dangerous half: a record that grants without reserving is a
// blank cheque. Both are covered below, and both were mutation-tested.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const PREFLIGHT = path.join(REPO, 'tools', 'agent-preflight.js');
const RECORD = path.join(REPO, 'config', 'owner-authorization.json');

// The reservations the owner named, by id. This is an INSTALLATION pin, not a
// product rule: the shipped product lets any user configure their own reserved
// list, so src/lib/owner-authorization.js deliberately does not hardcode these.
// This checkout is his, so his three are pinned here -- which is what makes
// "delete a reservation from the record" fail a NAMED test rather than sail
// through as a structurally valid record.
const OWNER_RESERVED_IDS = ['purchase-approval', 'instagram-post', 'government-identity-document'];

function readRecord() {
  return JSON.parse(fs.readFileSync(RECORD, 'utf8'));
}

function runPreflight(args = []) {
  const result = spawnSync(process.execPath, [PREFLIGHT, ...args], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(result.error, undefined, `preflight failed to spawn: ${result.error && result.error.message}`);
  assert.equal(result.status, 0, `preflight exited ${result.status}: ${(result.stderr || '').slice(0, 500)}`);
  return result.stdout || '';
}

// --- the grant reaches the surface agents are required to run ----------------

test('preflight output tells a session it is authorized to act under the owner\'s name', () => {
  const stdout = runPreflight();
  const record = readRecord();

  assert.match(stdout, /AUTHORIZED/, 'preflight must state the authorization state');
  assert.ok(
    stdout.includes("the owner has authorized agents to act under the owner's identity"),
    "preflight must say plainly that the owner authorized acting under the owner's identity; without this sentence the "
    + '18-times-stopped failure returns'
  );
  assert.ok(
    stdout.includes('Stopping an in-scope action for lack of authorization is now itself the error'),
    'preflight must tell the session that stopping for lack of authorization is the error, not the safe choice'
  );
  assert.ok(stdout.includes(record.publisherIdentity), 'preflight must name the publisher identity to release under');

  for (const item of record.inScope) {
    assert.ok(stdout.includes(item.statement), `preflight dropped in-scope entry "${item.id}" from its output`);
  }
});

// --- the reservations reach it too, from the same render ---------------------

test('preflight output carries every reservation the record makes', () => {
  const stdout = runPreflight();
  const record = readRecord();

  assert.ok(
    stdout.includes('RESERVED TO OWNER'),
    'preflight must head the reserved list explicitly; a grant shown without its limits is a blank cheque'
  );
  for (const item of record.reserved) {
    assert.ok(
      stdout.includes(item.statement),
      `preflight dropped reservation "${item.id}" from its output -- the session would believe it may do this`
    );
    if (item.agentsMayNot) {
      assert.ok(
        stdout.includes(item.agentsMayNot),
        `preflight showed reservation "${item.id}" without its "may NOT" clause, which is where the actual limit lives`
      );
    }
  }
});

test('the record still reserves each of the three things the owner kept for himself', () => {
  const record = readRecord();
  const ids = record.reserved.map(item => item.id);
  for (const id of OWNER_RESERVED_IDS) {
    assert.ok(
      ids.includes(id),
      `reservation "${id}" is gone from config/owner-authorization.json. The owner reserved approving the purchase `
      + 'list, pressing post on Instagram, and anything needing his passport or government ID. Removing one does not '
      + 'make the record invalid -- it makes it wrong, and agents would act on it.'
    );
  }
});

test('preflight states that the authorization is not a safety bypass', () => {
  const stdout = runPreflight();
  const record = readRecord();

  assert.ok(
    stdout.includes('THIS IS NOT A SAFETY BYPASS'),
    'preflight must say the authorization is not a bypass; the next agent reads this looking for permission'
  );
  for (const clause of record.doesNotGrant) {
    assert.ok(stdout.includes(clause), `preflight dropped a "does not grant" clause: ${clause.slice(0, 60)}`);
  }
});

// --- the automatic paths, not only the one a session must remember to run ----

test('the SessionStart hook envelope carries the grant and every reservation', () => {
  const stdout = runPreflight(['--hook']);
  const envelope = JSON.parse(stdout);
  const context = envelope.hookSpecificOutput.additionalContext;
  const record = readRecord();

  assert.ok(context.includes('OWNER AUTHORIZATION ON FILE'), 'the hook envelope must carry the authorization');
  for (const item of record.reserved) {
    assert.ok(
      context.includes(item.statement),
      `the hook envelope dropped reservation "${item.id}"; this is the automatic path, so a session may never see anything else`
    );
  }
  assert.ok(context.includes('THIS IS NOT A SAFETY BYPASS'), 'the hook envelope must not present the grant without its limits');
});

test('the onboarding packet carries the grant and every reservation', () => {
  const { buildOnboardingText } = require('../../src/lib/agent-onboarding');
  const rendered = buildOnboardingText({ scope: 'minimal' });
  const record = readRecord();

  assert.ok(rendered.includes('OWNER AUTHORIZATION ON FILE'), 'the onboarding packet must carry the authorization');
  for (const item of record.reserved) {
    assert.ok(rendered.includes(item.statement), `the onboarding packet dropped reservation "${item.id}"`);
  }
  // The packet drops sections that exceed its byte cap. The authorization rides
  // in the header block for exactly that reason, and 'minimal' is the tightest
  // cap the product ships, so this is the case that would lose it first.
  assert.ok(rendered.includes('THIS IS NOT A SAFETY BYPASS'), 'the minimal packet must not truncate away the limits');
});

// --- the dangerous half, refused at the read AND the render boundary ---------

test('a record that authorizes without reserving anything is refused', () => {
  const { readAuthorization } = require('../../src/lib/owner-authorization');
  const record = readRecord();
  record.reserved = [];
  const fsImpl = {
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1024 }),
    readFileSync: () => JSON.stringify(record)
  };

  const view = readAuthorization({ root: REPO, fsImpl });
  assert.equal(view.state, 'INVALID', 'a grant with no reservations must not read as AUTHORIZED');
  assert.equal(view.authorized, false);
  assert.ok(
    view.reasons.some(reason => reason.includes('blank cheque')),
    `the refusal must name the blank-cheque failure, not just say "invalid": ${view.reasons.join('; ')}`
  );
});

test('a forged projection claiming AUTHORIZED with no reservations will not render as a grant', () => {
  const { authorizationLines, authorizationHeadline } = require('../../src/lib/owner-authorization');
  // Not reachable from the file reader -- this is a caller handing the renderer
  // an object that never passed validation. An adversarial review did exactly
  // this and got back a grant printed under an empty "RESERVED TO OWNER" heading.
  const forged = {
    state: 'AUTHORIZED', authorized: true, authorizedOn: 'whenever', subject: 'anything',
    publisherIdentity: 'anyone', record: 'x', inScope: [], reserved: [], doesNotGrant: [], decisionProcedure: []
  };

  const lines = authorizationLines(forged).join('\n');
  assert.ok(lines.includes('NOT AUTHORIZED'), 'a malformed grant must render as a refusal, not as a grant');
  assert.ok(lines.includes('blank cheque'), 'the refusal must say why');
  assert.ok(!lines.includes('RESERVED TO OWNER'), 'it must not print the reserved heading with nothing under it');
  assert.ok(authorizationHeadline(forged).includes('may NOT act under the owner'), 'the compact form must refuse too');
});

test('validation cannot be undone after it passes', () => {
  const { readAuthorization } = require('../../src/lib/owner-authorization');
  const view = readAuthorization({ root: REPO });
  assert.equal(view.state, 'AUTHORIZED');
  // Object.freeze() is shallow; an adversarial review emptied the reservations
  // of an already-validated view and kept state AUTHORIZED.
  // Assert the property that matters -- the reservations survive -- rather than
  // a specific engine error string, which varies by operation and Node version.
  assert.throws(() => view.record.reserved.splice(0), TypeError, 'emptying a validated record must throw, not silently succeed');
  assert.equal(view.record.reserved.length, OWNER_RESERVED_IDS.length, 'the reservations must survive the attempt');
  assert.equal(view.state, 'AUTHORIZED', 'and the state must be unchanged by it');
});

test('a missing record reads as NOT authorized rather than as permission', () => {
  const { readAuthorization } = require('../../src/lib/owner-authorization');
  const fsImpl = {
    lstatSync: () => { const error = new Error('nope'); error.code = 'ENOENT'; throw error; },
    readFileSync: () => { throw new Error('unreachable'); }
  };
  const view = readAuthorization({ root: REPO, fsImpl });
  assert.equal(view.state, 'MISSING');
  assert.equal(view.authorized, false, 'absence of a record must never read as a grant');
});

test('a record that disappears after stat is an unreadable measurement, not definitely missing', () => {
  const { readAuthorization } = require('../../src/lib/owner-authorization');
  const fsImpl = {
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1024 }),
    readFileSync: () => { const error = new Error('vanished during read'); error.code = 'ENOENT'; throw error; }
  };
  const view = readAuthorization({ root: REPO, fsImpl });
  assert.equal(view.state, 'INVALID', 'a failed read cannot establish that the previously observed record is missing');
  assert.equal(view.authorized, false);
  assert.ok(view.reasons.some(reason => reason.includes('could not be read (ENOENT)')));
});
