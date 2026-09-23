'use strict';

/*
 * WHAT THE APP'S CLAUDE SESSION IS ALLOWED TO INHERIT.
 *
 * createSessionEnvironment() spreads the WHOLE parent environment and then
 * deletes the variables that would take the session somewhere other than the
 * owner's Claude.ai subscription. Deletion-by-enumeration is only as good as
 * the enumeration, and ANTHROPIC_BASE_URL was missing from it while the three
 * CLAUDE_CODE_USE_* redirectors, the OAuth token and the auth token were all
 * present.
 *
 * That omission is the dangerous kind because it does not fail. A redirected
 * session starts, answers, and looks exactly like a correct one -- while the
 * prompts, the file contents they carry, and whatever credential is attached
 * go to whatever host the variable named. Two sibling modules
 * (cli-provider-gateway.js, subscription-launch-env.js) already stripped it;
 * this was the third launch path and the only one that did not.
 *
 * These assertions are BEHAVIOURAL, on the object the function returns, not
 * source-text matches on the delete statements. A grep for `delete
 * env.ANTHROPIC_BASE_URL` still passes when a caller has stopped routing
 * through this function at all, which is precisely how a scrub ships bypassed.
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createSessionEnvironment } = require('../../src/lib/agent-engine/claude-process');

// `Anthropic_Base_Url` rather than `aNTHROPIC...`: a fix that only handles the
// all-lowercase form looks correct against a lowercase fixture and is not.
function toMixedCase(name) {
  return name.split('_').map((part) => part.charAt(0) + part.slice(1).toLowerCase()).join('_');
}

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

// Every variable that must never survive into the session, each with the
// reason it is here -- so a future reader deleting one has to argue with the
// reason rather than with a bare list.
const MUST_NOT_SURVIVE = Object.freeze({
  ANTHROPIC_BASE_URL: 'redirects every request to an arbitrary host; the session still works, so nothing looks wrong',
  ANTHROPIC_AUTH_TOKEN: 'a second credential that outranks the subscription session',
  CLAUDE_CODE_OAUTH_TOKEN: 'a second credential that outranks the subscription session',
  CLAUDE_CODE_USE_BEDROCK: 'redirects the session to Bedrock',
  CLAUDE_CODE_USE_VERTEX: 'redirects the session to Vertex',
  CLAUDE_CODE_USE_FOUNDRY: 'redirects the session to Foundry'
});

function withEnvironment(overrides, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* ---------- the redirectors and second credentials never survive ---------- */

// Every one is set to a value that would be actively harmful if inherited, so
// a pass means the value was removed rather than merely absent to begin with.
const poisoned = Object.fromEntries(Object.keys(MUST_NOT_SURVIVE).map(key => [key, 'https://attacker.invalid/v1']));

withEnvironment(poisoned, () => {
  const env = createSessionEnvironment(undefined, 'C:/config-dir');
  for (const [key, why] of Object.entries(MUST_NOT_SURVIVE)) {
    check(!Object.hasOwn(env, key),
      `${key} survived into the Claude session environment -- ${why}`);
  }
  // Asserted separately and explicitly: the whole point is that a set value is
  // REMOVED, not that the key happens to be missing on this machine.
  check(process.env.ANTHROPIC_BASE_URL === 'https://attacker.invalid/v1',
    'the fixture failed to set ANTHROPIC_BASE_URL, so the assertion above proved nothing');
});

/* ---------- the scrub is not over-broad ---------- */

withEnvironment({ ...poisoned, MC_UNRELATED_FIXTURE: 'keep-me' }, () => {
  const env = createSessionEnvironment(undefined, 'C:/config-dir');
  check(env.MC_UNRELATED_FIXTURE === 'keep-me',
    'an unrelated environment variable was dropped; this scrub must be a named list, not a filter');
  check(env.CLAUDE_CONFIG_DIR === 'C:/config-dir',
    'CLAUDE_CONFIG_DIR must be set -- it is the isolation the whole fence depends on');
});

/* ---------- the API key is stated, never inherited ---------- */

withEnvironment({ ANTHROPIC_API_KEY: 'inherited-key-that-must-not-leak' }, () => {
  const without = createSessionEnvironment(undefined, 'C:/config-dir');
  check(!Object.hasOwn(without, 'ANTHROPIC_API_KEY'),
    'an ambient ANTHROPIC_API_KEY was inherited; the subscription path must not be billed to a metered key');

  const provided = createSessionEnvironment('explicit-key', 'C:/config-dir');
  check(provided.ANTHROPIC_API_KEY === 'explicit-key',
    'an explicitly supplied key must reach the session');
});

/* ---------- CASE. `delete env.X` is not enough on Windows ---------- */

// Windows environment variables are case-INSENSITIVE; a plain object is not.
// So `delete env.ANTHROPIC_BASE_URL` left `anthropic_base_url` in place and the
// child -- whose OS lookup is case-insensitive -- read it anyway. Measured
// before this was fixed: 2 of 3 casings survived and reached a real child.
//
// `setx anthropic_api_key ...` is an ordinary thing to do on Windows because
// Windows does not care about case, so nothing looks wrong at any point: the
// guard reports success and the child still works.
for (const name of Object.keys(MUST_NOT_SURVIVE).concat(['ANTHROPIC_API_KEY'])) {
  for (const casing of [name.toLowerCase(), toMixedCase(name)]) {
    if (casing === name) continue;
    withEnvironment({ [casing]: 'https://attacker.invalid/v1' }, () => {
      const env = createSessionEnvironment(undefined, 'C:/config-dir');
      check(!Object.keys(env).some((key) => key.toLowerCase() === name.toLowerCase()),
        `${name} set as "${casing}" survived the scrub -- removal is case-sensitive but Windows is not`);
    });
  }
}

// The object check above is necessary and not sufficient: what matters is what
// the CHILD can read. A scrub that tidies the object but hands the variable on
// anyway would pass every assertion above.
withEnvironment({ anthropic_base_url: 'https://attacker.invalid/v1' }, () => {
  const env = createSessionEnvironment(undefined, 'C:/config-dir');
  const child = spawnSync(process.execPath,
    ['-e', 'process.stdout.write(String(process.env.ANTHROPIC_BASE_URL))'],
    { env, encoding: 'utf8', windowsHide: true });
  check(child.stdout === 'undefined',
    `a real child still read ANTHROPIC_BASE_URL as ${JSON.stringify(child.stdout)} after the scrub`);
});

/* ---------- a malformed key is refused rather than silently ignored ---------- */

for (const bad of ['', 42, {}]) {
  assert.throws(() => createSessionEnvironment(bad, 'C:/config-dir'), TypeError,
    `a ${typeof bad} API key must be refused, not quietly treated as absent`);
  checks += 1;
}

console.log(`Claude session environment tests passed (${checks} checks; ${Object.keys(MUST_NOT_SURVIVE).length} redirectors/credentials proven removed).`);
