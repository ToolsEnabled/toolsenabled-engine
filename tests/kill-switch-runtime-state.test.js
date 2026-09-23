'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Copy public program source into disposable installations. Every marker,
// adoption record and policy below belongs to this test, never the checkout.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-switch-state-'));
let passed = 0, failed = 0;
function check(name, run) {
  try { run(); passed += 1; console.log('PASS ' + name); }
  catch (error) { failed += 1; console.error('FAIL ' + name + ': ' + error.message); }
}
function fixture(name, packaged = false) {
  const root = path.join(scratch, name), program = path.join(root, 'program');
  fs.cpSync(path.resolve(__dirname, '../src'), path.join(program, 'src'), { recursive: true });
  fs.mkdirSync(path.join(program, 'config'));
  fs.writeFileSync(path.join(program, 'config/toolsenabled.policy.json'), JSON.stringify({ mode: 'autonomous', killswitchFile: 'KILLSWITCH' }));
  if (packaged) fs.writeFileSync(path.join(program, 'PAYLOAD.json'), '{}');
  return { root, program, state: path.join(root, 'owned-state'), marker: path.join(program, 'KILLSWITCH') };
}
function run(f, operation, overrides = {}) {
  const env = { ...process.env, XDG_STATE_HOME: path.join(f.root, 'xdg') };
  delete env.TOOLSENABLED_STATE_ROOT;
  delete env.TOOLSENABLED_KILLSWITCH_PATH;
  Object.assign(env, overrides);
  const source = `try {const ks=require('./src/lib/kill-switch');const policy=require('./src/lib/policy');
    const value=(${operation});console.log(JSON.stringify({ok:true,value}));}
    catch(e){console.log(JSON.stringify({ok:false,code:e.code||null,message:e.message}));}`;
  const child = spawnSync(process.execPath, ['-e', source], { cwd: f.program, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function success(result) { assert.equal(result.ok, true, result.message); return result.value; }

try {
  check('unconfigured source checkout retains its marker path', () => {
    const f = fixture('checkout');
    assert.deepEqual(success(run(f, 'ks.status()')), { active: false, path: f.marker });
  });
  check('explicit marker override retains precedence and relative resolution', () => {
    const f = fixture('override', true);
    fs.mkdirSync(f.marker); // Unused legacy default must not affect the override.
    assert.deepEqual(success(run(f, 'ks.status()', {
      TOOLSENABLED_STATE_ROOT: f.state, TOOLSENABLED_KILLSWITCH_PATH: '  explicit-stop  '
    })), { active: false, path: path.join(f.program, 'explicit-stop') });
  });
  check('configured source writes only its private installation marker', () => {
    const f = fixture('configured');
    fs.writeFileSync(f.marker, 'source marker belongs to another source run\n');
    const env = { TOOLSENABLED_STATE_ROOT: f.state };
    assert.deepEqual(success(run(f, 'ks.activate()', env)), { active: true, path: path.join(f.state, 'KILLSWITCH') });
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'source marker belongs to another source run\n');
    assert.match(fs.readFileSync(path.join(f.state, 'KILLSWITCH'), 'utf8'), /^ToolsEnabled kill switch activated /);
    const blocked = run(f, 'policy.assertActive("http.request")', env);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'KILLSWITCH_ACTIVE');
    assert.equal(blocked.message, "KILLSWITCH is active. 'http.request' was not executed.");
    assert.equal(run(f, 'policy.assertActive("local.read", {outward:false})', env).ok, true);
  });
  check('standalone packaged payload defaults to per-user writable state', () => {
    const f = fixture('packaged', true);
    const expected = path.join(f.root, 'xdg/ToolsEnabled/capability/KILLSWITCH');
    if (process.platform === 'win32') return; // Windows owner fallback has separate native coverage.
    fs.chmodSync(f.program, 0o555);
    try {
      assert.deepEqual(success(run(f, 'ks.activate()')), { active: true, path: expected });
      assert.equal(fs.existsSync(f.marker), false);
    } finally { fs.chmodSync(f.program, 0o755); }
  });
  check('active packaged marker is adopted once without modifying its source', () => {
    const f = fixture('legacy', true), env = { TOOLSENABLED_STATE_ROOT: f.state };
    const bytes = 'legacy active marker\n'; fs.writeFileSync(f.marker, bytes);
    fs.mkdirSync(f.state);
    // Existing installations may already have adopted every older directory.
    fs.writeFileSync(path.join(f.state, '.state-root-adoption.json'), JSON.stringify({
      version: 1, adopted: ['state', 'logs', 'vault', 'captures', 'profiles', 'reports'], pending: []
    }));
    const before = fs.statSync(f.marker);
    assert.deepEqual(success(run(f, 'ks.status()', env)), { active: true, path: path.join(f.state, 'KILLSWITCH') });
    assert.equal(fs.readFileSync(path.join(f.state, 'KILLSWITCH'), 'utf8'), bytes);
    assert.equal(run(f, 'policy.assertActive("http.request")', env).ok, false);
    assert.deepEqual(success(run(f, 'ks.deactivate()', env)), { active: false, path: path.join(f.state, 'KILLSWITCH') });
    assert.deepEqual(success(run(f, 'ks.status()', env)), { active: false, path: path.join(f.state, 'KILLSWITCH') });
    assert.equal(run(f, 'policy.assertActive("http.request")', env).ok, true);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), bytes);
    const after = fs.statSync(f.marker); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
    assert.ok(JSON.parse(fs.readFileSync(path.join(f.state, '.state-root-adoption.json'))).adopted.includes('KILLSWITCH'));
  });
  check('legacy adoption respects a current active destination marker', () => {
    const f = fixture('current-marker', true), env = { TOOLSENABLED_STATE_ROOT: f.state };
    fs.writeFileSync(f.marker, 'legacy\n'); fs.mkdirSync(f.state); fs.writeFileSync(path.join(f.state, 'KILLSWITCH'), 'current\n');
    assert.equal(success(run(f, 'ks.status()', env)).active, true);
    assert.equal(fs.readFileSync(path.join(f.state, 'KILLSWITCH'), 'utf8'), 'current\n');
  });
  check('unsafe legacy marker cannot silently enable outward work', () => {
    const f = fixture('wrong-kind', true), env = { TOOLSENABLED_STATE_ROOT: f.state };
    fs.mkdirSync(f.marker);
    const result = run(f, 'ks.status()', env);
    assert.equal(result.ok, false); assert.equal(result.code, 'ERR_STATE_ROOT_ADOPTION_INDETERMINATE');
    assert.equal(run(f, 'policy.assertActive("http.request")', env).ok, false);
    assert.equal(fs.existsSync(path.join(f.state, 'KILLSWITCH')), false);
  });
  check('uncertain adoption record refuses before losing the active marker', () => {
    const f = fixture('uncertain', true), env = { TOOLSENABLED_STATE_ROOT: f.state };
    fs.writeFileSync(f.marker, 'active\n'); fs.mkdirSync(f.state); fs.writeFileSync(path.join(f.state, '.state-root-adoption.json'), '{invalid');
    const result = run(f, 'ks.status()', env);
    assert.equal(result.ok, false); assert.equal(result.code, 'ERR_STATE_ROOT_ADOPTION_INDETERMINATE');
    assert.equal(fs.existsSync(path.join(f.state, 'KILLSWITCH')), false);
    assert.equal(run(f, 'policy.assertActive("http.request")', env).ok, false);
  });
  if (process.platform !== 'win32') check('linked destination is not mistaken for an adopted active marker', () => {
    const f = fixture('linked-destination', true), env = { TOOLSENABLED_STATE_ROOT: f.state };
    fs.writeFileSync(f.marker, 'active\n'); fs.mkdirSync(f.state);
    fs.symlinkSync(path.join(f.root, 'missing-target'), path.join(f.state, 'KILLSWITCH'));
    const result = run(f, 'ks.status()', env);
    assert.equal(result.ok, false); assert.equal(result.code, 'ERR_STATE_ROOT_ADOPTION_INDETERMINATE');
    assert.equal(fs.existsSync(path.join(f.root, 'missing-target')), false);
  });
  if (process.platform !== 'win32') check('linked legacy marker is refused without following its target', () => {
    const f = fixture('linked-source', true), env = { TOOLSENABLED_STATE_ROOT: f.state };
    const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'outside marker\n');
    fs.symlinkSync(outside, f.marker);
    const result = run(f, 'ks.status()', env);
    assert.equal(result.ok, false); assert.equal(result.code, 'ERR_STATE_ROOT_ADOPTION_INDETERMINATE');
    assert.equal(fs.existsSync(path.join(f.state, 'KILLSWITCH')), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside marker\n');
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`kill-switch runtime state: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
