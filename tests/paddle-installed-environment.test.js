'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paddle-installed-choice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed-state');
  const explicit = path.join(root, 'explicit-root');
  for (const directory of [installed, explicit]) fs.mkdirSync(path.join(directory, 'config'), { recursive: true });
  const module = require.resolve('../src/lib/paddle-environment');
  const invoke = argument => {
    const code = `process.stdout.write(JSON.stringify(require(${JSON.stringify(module)}).resolvePaddleEnvironment(${JSON.stringify(argument)})));`;
    const result = spawnSync(process.execPath, ['-e', code], {
      env: { ...process.env, TOOLSENABLED_STATE_ROOT: installed }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { installed, explicit, invoke };
}

test('native installed reads select the recorded merchant environment without changing program configuration', t => {
  const f = fixture(t);
  const installedFile = path.join(f.installed, 'config/paddle-environment.json');
  const explicitFile = path.join(f.explicit, 'config/paddle-environment.json');
  fs.writeFileSync(installedFile, '{"environment":"live"}\n');
  fs.writeFileSync(explicitFile, '{"environment":"sandbox"}\n');
  const chosen = f.invoke({});
  assert.equal(chosen.configPath, installedFile);
  assert.equal(chosen.environment, 'live');
  assert.equal(chosen.recorded, true);
  assert.equal(chosen.profile.webhookVaultKey, 'paddle_live_webhook_secret');
  assert.equal(chosen.profile.apiRoot, 'https://api.paddle.com');
  const explicit = f.invoke({ root: f.explicit });
  assert.equal(explicit.configPath, explicitFile);
  assert.equal(explicit.environment, 'sandbox');
  assert.equal(explicit.recorded, true);
  const byPath = f.invoke({ root: f.explicit, configPath: installedFile });
  assert.deepEqual(byPath, chosen);
  assert.equal(fs.readFileSync(installedFile, 'utf8'), '{"environment":"live"}\n');
  assert.equal(fs.readFileSync(explicitFile, 'utf8'), '{"environment":"sandbox"}\n');
});

test('an absent or invalid installed choice still fails closed and never imports another root', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.explicit, 'config/paddle-environment.json'), '{"environment":"live"}\n');
  const absent = f.invoke({});
  assert.equal(absent.configPath, path.join(f.installed, 'config/paddle-environment.json'));
  assert.equal(absent.environment, 'sandbox');
  assert.equal(absent.reason, 'absent');
  assert.equal(absent.recorded, false);
  assert.equal(absent.profile.chargesRealMoney, false);
  fs.writeFileSync(absent.configPath, '{"environment":"production"}\n');
  const invalid = f.invoke({});
  assert.equal(invalid.environment, 'sandbox');
  assert.equal(invalid.reason, 'unrecognised');
  assert.equal(invalid.recorded, false);
});
