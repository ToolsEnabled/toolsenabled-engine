'use strict';
/* The release gate (tools/compliance-check.js) passes on this tree, and each of
 * its checks catches the thing it exists for when that thing is planted in a
 * scratch tree. Private names and paths live outside the repository, so the
 * release check here uses a pattern file that matches nothing. */
require('./lib/isolated-environment').activate('compliance-check');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runAll } = require('../tools/compliance-check');

function withPatterns(t, lines) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-patterns-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'private-patterns.txt');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  const before = process.env.TEFLEET_PRIVATE_PATTERNS_FILE;
  process.env.TEFLEET_PRIVATE_PATTERNS_FILE = file;
  t.after(() => {
    if (before === undefined) delete process.env.TEFLEET_PRIVATE_PATTERNS_FILE;
    else process.env.TEFLEET_PRIVATE_PATTERNS_FILE = before;
  });
}

function byName(results) {
  return Object.fromEntries(results.map(result => [result.name, result]));
}

test('every check passes on this tree', t => {
  withPatterns(t, ['^a-pattern-that-matches-no-file-[0-9]{40}$']);
  const results = byName(runAll());
  for (const name of ['sign-ins', 'settings', 'pass-through', 'rotation', 'levels', 'neutral', 'release']) {
    assert.equal(results[name].ok, true, `${name}: ${results[name].problems.join('; ')}`);
  }
});

test('the release check refuses to pass without the private pattern file', t => {
  const before = process.env.TEFLEET_PRIVATE_PATTERNS_FILE;
  delete process.env.TEFLEET_PRIVATE_PATTERNS_FILE;
  t.after(() => { if (before !== undefined) process.env.TEFLEET_PRIVATE_PATTERNS_FILE = before; });
  const release = byName(runAll()).release;
  assert.equal(release.ok, false);
  assert.match(release.problems.join('\n'), /TEFLEET_PRIVATE_PATTERNS_FILE/);
});

test('each check catches its own planted violation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-planted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  };
  const shipped = ['src/lib/planted.js', 'src/lib/multi-account/router.js', 'src/lib/host-worker-session.js',
    'src/lib/openshell-worker-session.js'];
  write('installer/openshell/SOURCE-ALLOWLIST', `${shipped.join('\n')}\n`);
  write('installer/claude-plugin/SOURCE-ALLOWLIST', '');
  write('public-source/ALLOWLIST.txt', 'src/lib/planted.js\n');
  write('src/lib/planted.js', "const file = '.credentials.json';\nconst who = 'codex';\nconst owner = 'planted-private-name';\nconst other = path.join(home, '.gemini/settings.json');\n");
  write('installer/host/build.sh', "  name: 'toolsenabled-host',\n");
  write('installer/openshell/build.sh', "  name: 'claude-openshell',\n");
  write('src/lib/multi-account/router.js', '');
  write('src/lib/host-worker-session.js', "const settings = { sandbox: 'danger-full-access' };\n");
  write('src/lib/openshell-worker-session.js', '');
  write('src/lib/agent-engine/claude-cli-process.js', 'spawnHidden(command, args, {});\n');
  write('src/lib/agent-engine/codex-process.js', 'spawnHidden(command, args, {});\n');
  write('package.json', JSON.stringify({ name: 'codex-helper', repository: { url: 'https://github.com/example/gemini-fleet' } }));
  withPatterns(t, ['planted-private-name']);

  const results = byName(runAll({ root }));
  const problems = name => results[name].problems.join('\n');
  for (const name of ['sign-ins', 'settings', 'pass-through', 'rotation', 'levels', 'neutral', 'release']) {
    assert.equal(results[name].ok, false, `${name} should fail on the planted tree`);
  }
  assert.match(problems('sign-ins'), /planted\.js names the sign-in file \.credentials\.json/);
  assert.match(problems('pass-through'), /without agentCli: true/);
  assert.match(problems('rotation'), /multi-account\/router\.js/);
  assert.match(problems('levels'), /host-worker-session\.js sets/);
  assert.match(problems('neutral'), /planted\.js names agents in code: codex/);
  assert.match(problems('release'), /planted\.js holds a private path or name/);
  assert.match(problems('release'), /package name "codex-helper" carries a vendor name/);
  assert.match(problems('release'), /package repository "https:\/\/github\.com\/example\/gemini-fleet" carries a vendor name/);
  assert.match(problems('release'), /installer\/openshell\/build\.sh names its archive "claude-openshell"/);
  assert.doesNotMatch(problems('release'), /toolsenabled-host/);
  assert.match(problems('settings'), /planted\.js names an agent settings file/);
});
