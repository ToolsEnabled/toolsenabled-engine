/* Mutation checks (2026-08-27):
 * In requirements.js, changed block-comment replacement from '' to '$&'.
 * Landed: yes; the mutated source contained the exact replacement.
 * Result: RED (exit 1), because comment-only.js became a discovered consumer.
 * Restore: confirmed against the module's pre-mutation SHA-256.
 * Removed the providers/agent-comms.js DEFERRED_PROGRAM_PHASE_7 entry.
 * Landed: yes; the exact table entry was absent after mutation.
 * Result: RED (exit 1), because the driven consumer became an unmapped error.
 * Restore: SHA-256 73a37c0e69faddb41cd276011c6a2bd91d7a943d26974ef7e1b523f02c8d25cf,
 * exactly matching the digest captured before mutation.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const {
  BASE_REQUIREMENTS,
  EXCLUDED_CONSUMERS,
  discoverConsumerFiles,
  requirements,
  validate
} = require('../src/lib/secret-store/requirements');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-store-requirements-'));

function write(relative, contents) {
  const target = path.join(tempRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

try {
  write('config/toolsenabled.policy.json', JSON.stringify({
    http: {
      vaultKeys: {
        zeta: { vaultKey: 'service_zeta' },
        shared: { vaultKey: 'service_alpha' },
        duplicate: { vaultKey: 'service_zeta' }
      }
    }
  }));
  write('config/paddle-environment.json', JSON.stringify({ environment: 'live' }));

  const resolved = requirements(tempRoot, [
    'google_refresh_token__work',
    'google_access_token__alpha',
    'google_client_id__work',
    'google_access_token__alpha',
    'not_a_google_account'
  ]);
  const http = resolved.find(item => item.id === 'http-vault-bindings');
  const paddle = resolved.find(item => item.id === 'paddle');
  const accounts = resolved.filter(item => item.dynamic && item.id.startsWith('google-account:'));

  assert.deepEqual(http.alternatives, [['service_alpha', 'service_zeta']],
    'HTTP vault keys are deduplicated and sorted into one all-required group');
  assert.equal(paddle.label, 'Paddle (live)');
  assert.deepEqual(paddle.alternatives, [['paddle_live_api_key', 'paddle_live_webhook_secret']]);
  assert.deepEqual(accounts.map(item => item.id), ['google-account:alpha', 'google-account:work']);
  assert.deepEqual(accounts[1].alternatives, [
    ['google_access_token__work'],
    ['google_refresh_token__work', 'google_client_id__work', 'google_client_secret__work']
  ]);
  assert.equal(accounts[0].criticality, 'conditional');
  assert.equal(BASE_REQUIREMENTS.find(item => item.id === 'paddle').label, 'Paddle (sandbox)',
    'resolving a live installation must not mutate the exported base contract');

  write('src/lib/z-consumer.js', 'store.getSecret("z");\n');
  write('src/lib/a-consumer.js', 'secretExists("a");\n');
  write('src/lib/comment-only.js', '// getSecret("ignored");\n/* secretExists("ignored"); */\n');
  write('src/lib/runtime.js', 'getOrCreateSecret("runtime-is-explicitly-excluded");\n');
  assert.deepEqual(discoverConsumerFiles(path.join(tempRoot, 'src', 'lib')),
    ['a-consumer.js', 'z-consumer.js']);

  write('src/lib/proven.js', 'const names = "key_one and key_two";\n');
  write('src/lib/dynamic.js', 'module.exports = {};\n');
  const validation = validate(tempRoot, [
    { id: 'proven', sources: ['proven.js', 'missing.js'], alternatives: [['key_one', 'absent_key']] },
    { id: 'dynamic', sources: ['dynamic.js'], alternatives: [['need_not_be_literal']], dynamic: true },
    { id: 'mapped-a', sources: ['a-consumer.js'], alternatives: [] }
  ]);
  assert.deepEqual(validation.errors, [
    { code: 'SECRET_REQUIREMENT_SOURCE_MISSING', integration: 'proven', source: 'missing.js' },
    { code: 'SECRET_REQUIREMENT_KEY_UNPROVEN', integration: 'proven', name: 'absent_key' },
    { code: 'SECRET_REQUIREMENTS_UNMAPPED', source: 'z-consumer.js' }
  ]);
  assert.deepEqual(validation.exclusions, []);
  assert.deepEqual(validation.consumerFiles,
    ['a-consumer.js', 'z-consumer.js']);

  // Drive the deferred agent-comms exclusion through validate(), rather than
  // merely asserting that its table entry exists. Once the fixture is ready,
  // turn writes and process launches into tripwires: a refusal is only safe if
  // validation reports it without trying to mutate or execute anything.
  write('src/lib/providers/agent-comms.js', 'module.exports = () => getSecret("agent_comms_token");\n');
  const forbiddenEffects = [];
  const effectMethods = [
    [fs, 'writeFileSync'],
    [fs, 'appendFileSync'],
    [fs, 'renameSync'],
    [fs, 'unlinkSync'],
    [childProcess, 'spawn'],
    [childProcess, 'spawnSync'],
    [childProcess, 'execFile'],
    [childProcess, 'execFileSync']
  ];
  const originals = effectMethods.map(([owner, name]) => [owner, name, owner[name]]);
  for (const [owner, name] of effectMethods) {
    owner[name] = (...args) => {
      forbiddenEffects.push({ name, args });
      throw new Error(`validate attempted forbidden effect: ${name}`);
    };
  }
  let deferredValidation;
  try {
    deferredValidation = validate(tempRoot, [
      { id: 'mapped-a', sources: ['a-consumer.js'], alternatives: [] },
      { id: 'mapped-z', sources: ['z-consumer.js'], alternatives: [] }
    ]);
  } finally {
    for (const [owner, name, original] of originals) owner[name] = original;
  }
  assert.deepEqual(deferredValidation.errors, []);
  assert.deepEqual(deferredValidation.exclusions, [
    { source: 'providers/agent-comms.js', code: 'DEFERRED_PROGRAM_PHASE_7' }
  ]);
  assert.ok(deferredValidation.consumerFiles.includes('providers/agent-comms.js'));
  assert.deepEqual(forbiddenEffects, [], 'a refused consumer must not write or spawn');

  write('config/toolsenabled.policy.json', JSON.stringify({ http: { vaultKeys: [] } }));
  assert.throws(() => requirements(tempRoot), {
    name: 'TypeError',
    message: /Invalid http\.vaultKeys .* expected an object/
  });

  console.log('secret-store requirements tests passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
