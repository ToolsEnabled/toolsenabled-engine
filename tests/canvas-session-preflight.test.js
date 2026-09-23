'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-session-preflight-'));
const fixtureTools = path.join(fixtureRoot, 'tools');
const fixturePlaywright = path.join(fixtureRoot, 'node_modules', 'playwright-core');
fs.mkdirSync(fixtureTools, { recursive: true });
fs.mkdirSync(fixturePlaywright, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'tools', 'canvas-session-preflight.js'), path.join(fixtureTools, 'canvas-session-preflight.js'));
fs.writeFileSync(path.join(fixturePlaywright, 'index.js'), `
'use strict';
const scenario = process.env.PREFLIGHT_SCENARIO;
exports.chromium = {
  async connectOverCDP(endpoint) {
    if (scenario === 'browser-unavailable') throw new Error('deliberate connection failure');
    process.stderr.write('endpoint=' + endpoint + '\\n');
    const page = {
      url: () => 'https://elearn.ucr.edu/courses/1',
      async evaluate() {
        if (scenario === 'canvas-unavailable') throw new Error('deliberate evaluation failure');
        if (scenario === 'sign-in-required') return { status: 401, authenticated: false };
        return { status: 200, authenticated: true, id: 42, name: 'Test User' };
      },
      async close() {}
    };
    const context = {
      async cookies() {
        if (scenario === 'preflight-unavailable') throw new Error('deliberate cookie failure');
        return [{ domain: '.duosecurity.com', name: 'remembered', value: 'MUST_NOT_LEAK', expires: Date.now() / 1000 + 864000 }];
      },
      pages: () => [page],
      async newPage() { return page; }
    };
    return { contexts: () => scenario === 'no-context' ? [] : [context] };
  }
};
`);

process.on('exit', () => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

function invoke(scenario, ...args) {
  const result = spawnSync(process.execPath, [path.join(fixtureTools, 'canvas-session-preflight.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PREFLIGHT_SCENARIO: scenario }
  });
  assert.equal(result.signal, null, result.stderr);
  return { ...result, body: JSON.parse(result.stdout) };
}

function refusal(scenario, state) {
  const result = invoke(scenario, '--cdp', `http://test.invalid/${scenario}`);
  assert.equal(result.status, 1, `${state} must use the CLI refusal exit code`);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.state, state);
  const explanation = result.body.reason || result.body.guidance;
  assert.equal(typeof explanation, 'string');
  assert.ok(explanation.length > 0, `${state} must explain its refusal`);
  return result;
}

process.stdout.write('canvas-session-preflight\n');

// Pin every early and late refusal independently. Removing any return, or
// merging it into a generic success/failure, makes the corresponding case red.
const browserUnavailable = refusal('browser-unavailable', 'browser-unavailable');
assert.equal(browserUnavailable.body.cdpEndpoint, 'http://test.invalid/browser-unavailable');
refusal('no-context', 'no-context');

const canvasUnavailable = refusal('canvas-unavailable', 'canvas-unavailable');
assert.deepEqual(canvasUnavailable.body.canvas, { host: 'https://elearn.ucr.edu', httpStatus: null });

const signInRequired = refusal('sign-in-required', 'sign-in-required');
assert.equal(signInRequired.body.canvas.httpStatus, 401);
assert.match(signInRequired.body.guidance, /owner-interactive sign-in/);
refusal('preflight-unavailable', 'preflight-unavailable');

// Dependency absence is special because the tool refuses before loading Playwright.
fs.renameSync(fixturePlaywright, `${fixturePlaywright}.disabled`);
try {
  refusal('dependency-unavailable', 'dependency-unavailable');
} finally {
  fs.renameSync(`${fixturePlaywright}.disabled`, fixturePlaywright);
}

// Pin the only named success exit code too, and prove --cdp consumes its value.
const authenticated = invoke('authenticated', '--cdp', 'http://test.invalid/healthy');
assert.equal(authenticated.status, 0, 'authenticated must use the CLI success exit code');
assert.equal(authenticated.body.state, 'authenticated');
assert.equal(authenticated.body.ok, true);
assert.match(authenticated.stderr, /endpoint=http:\/\/test\.invalid\/healthy/);
assert.equal(authenticated.stdout.includes('MUST_NOT_LEAK'), false, 'cookie values must never be emitted');
assert.equal(authenticated.body.duo.hasRememberedDevice, true);

process.stdout.write('  ok  six refusal states and both CLI exit codes are pinned\n');
