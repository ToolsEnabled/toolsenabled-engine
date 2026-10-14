'use strict';

// 1.0.50 review L3: host.read_file / host.list_dir MUST NOT HAND OUT THE
// RELOCATED STATE ROOT OR THE GENERATED CLAUDE TOOL SURFACE.
//
// The credential fence protected state only as `ToolsEnabled*/state`. The
// desktop app sets TOOLSENABLED_STATE_ROOT=<userData>/capability, so on Windows
// the per-boot bearers live in ...\Roaming\ToolsEnabled\capability\state\ and
// the session credentials in ...\Local\ToolsEnabled\agent-tools\...\.mcp.json.
// Neither matched, so both were readable and listed. This drives the real
// exported readFile()/listDir() against real files inside the owner profile.
//
// The state root is also configurable, so the LIVE state directory is checked
// too: this file points TOOLSENABLED_STATE_ROOT at an ordinary-looking folder
// (no ToolsEnabled segment at all) before anything resolves it.
//
// NO CREDENTIAL VALUE APPEARS HERE. Every fixture holds the literal below.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME_FOR_FIXTURES = process.platform === 'linux' ? os.userInfo().homedir : os.homedir();
const folder = fs.mkdtempSync(path.join(HOME_FOR_FIXTURES, 'ordinary-folder-'));
const relocatedStateRoot = path.join(folder, 'relocated-profile', 'capability');
process.env.TOOLSENABLED_STATE_ROOT = relocatedStateRoot;

const assert = require('node:assert/strict');
const test = require('node:test');
const hostControl = require('../src/lib/providers/host-control.js');
const { statePath } = require('../src/lib/runtime-state-root');

const FIXTURE = 'not-a-credential: fixture bytes for the host-control state-root fence';
const NO_AUDIT = Object.freeze({ requireRecordAsync: async () => undefined, recordAsync: async () => undefined });

async function outcome(promiseOrValue) {
  try { return { ok: true, value: await promiseOrValue() }; }
  catch (error) { return { ok: false, error }; }
}
const read = target => outcome(() => hostControl.readFile({ path: target }, NO_AUDIT));
const list = target => outcome(() => hostControl.listDir({ path: target }, NO_AUDIT));
function put(...parts) {
  const file = path.join(folder, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, FIXTURE);
  return file;
}

test.after(() => fs.rmSync(folder, { recursive: true, force: true }));

test('premise: an ordinary file in the fixture folder is readable', async () => {
  const result = await read(put('plain-canary.txt'));
  assert.ok(result.ok, `the fixture folder must itself be ordinary; got ${result.error && result.error.code}`);
});

test('the app-relocated state directory and the agent-tools tree are refused and not listed', async () => {
  const refused = [
    put('AppData', 'Roaming', 'ToolsEnabled', 'capability', 'state', 'mission-bridge-token.json'),
    put('AppData', 'Roaming', 'ToolsEnabled', 'capability', 'state', 'uac-delegation-token.json'),
    put('AppData', 'Roaming', 'ToolsEnabled Test', 'capability', 'state', 'owner-host-capability.json'),
    put('AppData', 'Local', 'ToolsEnabled', 'agent-tools', 'claude', 'standard', '.mcp.json'),
    put('.local', 'share', 'ToolsEnabled', 'agent-tools', 'claude', 'guided', '.mcp.json')
  ];
  for (const file of refused) {
    const result = await read(file);
    assert.equal(result.ok, false, `${path.relative(folder, file)} must not be readable`);
    assert.equal(result.error.code, 'HOST_PATH_FORBIDDEN',
      `${path.relative(folder, file)} must be refused by the credential fence; got ${result.error.code}`);
  }
  const capability = await list(path.join(folder, 'AppData', 'Roaming', 'ToolsEnabled', 'capability'));
  assert.ok(capability.ok, 'the capability folder itself stays listable');
  assert.deepEqual(capability.value.entries.map(entry => entry.name).filter(name => name === 'state'), [],
    'listing the capability folder must not disclose its state directory');
  const services = await list(path.join(folder, 'AppData', 'Local', 'ToolsEnabled'));
  assert.ok(services.ok);
  assert.deepEqual(services.value.entries.map(entry => entry.name).filter(name => name === 'agent-tools'), [],
    'listing the services root must not disclose the agent-tools tree');
});

test('the live state directory is refused wherever the state root was put', async () => {
  const stateDirectory = statePath('state');
  assert.ok(stateDirectory.startsWith(relocatedStateRoot), `premise: the state root was relocated (${stateDirectory})`);
  assert.equal(/ToolsEnabled/i.test(path.relative(HOME_FOR_FIXTURES, stateDirectory)), false,
    'premise: no folder-name pattern can match this state directory');
  const token = put('relocated-profile', 'capability', 'state', 'mission-bridge-token.json');
  const result = await read(token);
  assert.equal(result.ok, false, 'a bearer in the live state directory must not be readable');
  assert.equal(result.error.code, 'HOST_PATH_FORBIDDEN');
  const parent = await list(relocatedStateRoot);
  assert.ok(parent.ok);
  assert.deepEqual(parent.value.entries.map(entry => entry.name).filter(name => name === 'state'), []);
});

test('near misses stay readable: only the state and agent-tools trees are fenced', async () => {
  for (const file of [
    put('AppData', 'Roaming', 'ToolsEnabled', 'capability', 'notes.txt'),
    put('AppData', 'Roaming', 'ToolsEnabled', 'capability', 'statements', 'march.txt'),
    put('projects', 'agent-tools', 'readme.txt'),
    put('projects', 'state', 'readme.txt')
  ]) {
    const result = await read(file);
    assert.ok(result.ok, `${path.relative(folder, file)} is ordinary and must stay readable; got ${result.error && result.error.code}`);
  }
});
