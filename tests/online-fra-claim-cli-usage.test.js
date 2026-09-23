'use strict';

// THE CLAIM CLI'S OWN REFUSALS. tools/online-fra-claim-cli.js calls itself "the
// one surface every other surface drives" -- the tray, the settings walkthrough
// and a bare terminal all go through these verbs -- and it shipped with no test
// of its own. Its library does have tests; the command does not.
//
// These cases drive the real command with real argv and assert only what a
// caller can depend on: one machine-readable object on stdout, the usage code,
// and exit 2. Nothing here pins a message string, so a better-worded refusal
// still passes.
//
// The property worth protecting is the last one: a malformed command refuses
// BEFORE it reaches the account service or this machine's local store. The
// account origin is pointed at a port nothing listens on, so a refusal that
// travelled would come back as a failed request instead of a usage error; and
// the store is pointed at a scratch path that must still not exist afterwards.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repositoryRoot = path.join(__dirname, '..');
const cli = path.join(repositoryRoot, 'tools', 'online-fra-claim-cli.js');

/* Nothing listens on port 1. If a usage refusal ever reached the network this
   would surface as a connection failure, not as the usage code below. */
const deadOrigin = 'http://127.0.0.1:1';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-cli-usage-'));
const storeThatMustNotAppear = path.join(scratch, 'local-store.json');

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      TOOLSENABLED_ACCOUNT_ORIGIN: deadOrigin,
      TOOLSENABLED_VAULT_PATH: storeThatMustNotAppear,
    },
  });
}

const usageCases = [
  { name: 'no verb at all', args: [] },
  { name: 'an unknown verb', args: ['definitely-not-a-verb'] },
  { name: 'open without --name', args: ['open'] },
  { name: 'poll without --token', args: ['poll'] },
  { name: 'wait without --token', args: ['wait'] },
  { name: 'wait with a zero deadline', args: ['wait', '--token', 't', '--deadline-ms', '0'] },
  { name: 'wait with a non-numeric deadline', args: ['wait', '--token', 't', '--deadline-ms', 'soon'] },
];

try {
  for (const usageCase of usageCases) {
    const result = runCli(usageCase.args);

    assert.equal(result.error, undefined, `${usageCase.name}: the command should run to completion`);

    const stdoutLines = result.stdout.split('\n').filter(line => line.length > 0);
    assert.equal(stdoutLines.length, 1,
      `${usageCase.name}: stdout carries exactly one object, got ${stdoutLines.length} lines`);

    let reported;
    try {
      reported = JSON.parse(stdoutLines[0]);
    } catch (parseError) {
      assert.fail(`${usageCase.name}: stdout was not machine-readable JSON (${parseError.message})`);
    }

    assert.ok(reported && typeof reported.error === 'object' && reported.error !== null,
      `${usageCase.name}: the refusal travels as data on stdout`);

    /* CLI_USAGE and not a request failure is the whole point: the command
       decided this was malformed without asking the service anything. */
    assert.equal(reported.error.code, 'CLI_USAGE',
      `${usageCase.name}: refused as a usage error before any request`);

    assert.equal(result.status, 2,
      `${usageCase.name}: a usage refusal exits 2, distinct from 0 (done) and 1 (tried and failed)`);
  }

  assert.equal(fs.existsSync(storeThatMustNotAppear), false,
    'no usage refusal created or touched this machine\'s local store');

  console.log(`online-fra-claim-cli-usage: ${usageCases.length} driven usage refusals passed, `
    + 'none reached the account service or a local store');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
