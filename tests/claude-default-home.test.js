'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const confinement = require('../src/lib/agent-session-confinement');
const { configDirEnvironment } = require('../src/lib/agent-engine/claude-cli-process');
let passed = 0, failed = 0, children = 0;
const cases = [
  ['native selector', 'native'],
  ['provider default', 'default'],
  ['unrelated mixed-case selector on Linux', 'case'],
  ['explicit account overrides native selector', 'explicit']
];
for (const [name, kind] of cases) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-default-home-')));
  const native = path.join(root, 'native'), profile = path.join(root, 'profile'), explicit = path.join(root, 'explicit');
  for (const directory of [native, profile, explicit]) fs.mkdirSync(directory);
  const saved = { ...process.env };
  try {
    // This process never resolves a real sign-in home: all selected, account,
    // fallback-profile and generated-tool directories belong to this fixture.
    for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'CLAUDE_CONFIG_DIR') delete process.env[key];
    process.env.CLAUDE_CONFIG_DIR = native;
    if (kind === 'default' || kind === 'case') delete process.env.CLAUDE_CONFIG_DIR;
    if (kind === 'case') process.env.Claude_Config_Dir = native;
    const expected = kind === 'explicit' ? explicit : kind === 'default' || (kind === 'case' && process.platform !== 'win32')
      ? path.join(profile, '.claude') : native;
    const surface = confinement.prepareClaudeToolSurface(confinement.agentConfinement('standard'), {
      servicesRoot: path.join(root, 'services'), accountHome: profile,
      ...(kind === 'explicit' ? { configDir: explicit, accountName: 'synthetic-account' } : {})
    });
    assert.equal(surface.configDir, expected);
    const environment = configDirEnvironment({ ...surface.env }, surface.configDir);
    const child = spawnSync(process.execPath, ['-e',
      'process.stdout.write(JSON.stringify({ homeMatches: process.env.CLAUDE_CONFIG_DIR === process.env.SYNTHETIC_EXPECTED_HOME }))'],
      { env: { ...environment, SYNTHETIC_EXPECTED_HOME: expected }, encoding: 'utf8', timeout: 10000 });
    children++;
    assert.equal(child.status, 0);
    assert.equal(JSON.parse(child.stdout).homeMatches, true);
    assert.deepEqual(fs.readdirSync(native), []);
    assert.deepEqual(fs.readdirSync(explicit), []);
    assert.deepEqual(fs.readdirSync(profile), []);
    passed++;
    console.log('ok - ' + name);
  } catch (error) {
    failed++;
    console.log('not ok - ' + name + ': ' + error.message);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
console.log(`Claude default home: ${passed} passed, ${failed} failed; ${children} synthetic children`);
process.exitCode = failed ? 1 : 0;
