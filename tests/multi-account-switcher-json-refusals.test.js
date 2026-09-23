'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { assertAccountProfilePath } = require('../src/lib/account-profile-boundary.js');

const { MultiAccountError } = require('../src/lib/multi-account/registry.js');
const { readState, syncCodexPin } = require('../src/lib/multi-account/switcher.js');

function assertScratchPath(value) {
  if (process.platform === 'win32') {
    return assertAccountProfilePath(value, {
      profileRoot: String.raw`C:\Users\ToolsEnabled-Dev`, requireOwnedProfile: true,
      resolveProfileShortPath: () => null,
    });
  }
  return value;
}

function scratchDirectory(prefix) {
  const parent = process.platform === 'win32'
    ? String.raw`C:\Users\ToolsEnabled-Dev\AppData\Local\Temp` : os.tmpdir();
  // Admission precedes creation and repeats before recursive cleanup. The
  // account boundary checks every parent for reparse points and final escape.
  assertScratchPath(parent);
  return assertScratchPath(fs.mkdtempSync(path.join(parent, prefix)));
}

function removeScratch(directory) {
  assertScratchPath(directory);
  fs.rmSync(directory, { recursive: true, force: true });
}

function refusingFs(contents) {
  const effects = { mkdir: [], write: [] };
  return {
    effects,
    readFileSync(file, encoding) {
      assert.strictEqual(encoding, 'utf8');
      return contents;
    },
    mkdirSync(...args) { effects.mkdir.push(args); },
    writeFileSync(...args) { effects.write.push(args); }
  };
}

function captureRefusal(operation) {
  let refusal;
  try {
    operation();
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal instanceof MultiAccountError, 'the public operation must throw MultiAccountError');
  return refusal;
}

{
  /* A file system that cannot rename cannot quarantine: the refusal stands. */
  const statePath = '/test/state.json';
  const fsImpl = refusingFs('{ definitely not JSON');
  const refusal = captureRefusal(() => readState(statePath, { fsImpl }));

  assert.strictEqual(refusal.code, 'ACCOUNTS_JSON_INVALID');
  assert.match(refusal.message, /invalid\. Refusing to infer an empty value\./);
  assert.strictEqual(refusal.details.file, statePath);
  assert.match(refusal.details.cause, /JSON/);
  assert.deepStrictEqual(fsImpl.effects, { mkdir: [], write: [] },
    'invalid persisted state must not be replaced with inferred state');
}

{
  /* With a rename available the bytes are moved aside under a name that says
     what they are, nothing is written over them, and the record starts again
     from nothing -- the brownout case of 2026-09-02. */
  const statePath = '/test/state.json';
  const fsImpl = refusingFs('\u0000\u0000\u0000\u0000');
  const renames = [];
  const directories = [];
  fsImpl.mkdtempSync = prefix => { directories.push(prefix); return `${prefix}fixture`; };
  fsImpl.renameSync = (from, to) => { renames.push([from, to]); };
  const state = readState(statePath, { fsImpl, now: () => new Date('2026-09-02T18:30:00.000Z') });
  const target = path.join('/test/state.json.corrupt-2026-09-02T18-30-00-000Z-fixture', 'state.json');
  assert.deepStrictEqual(directories, ['/test/state.json.corrupt-2026-09-02T18-30-00-000Z-']);
  assert.deepStrictEqual(renames, [[statePath, target]]);
  assert.deepStrictEqual(fsImpl.effects, { mkdir: [], write: [] }, 'quarantine does not rewrite state bytes');
  assert.strictEqual(state.activeAccount, null);
  assert.strictEqual(state.activeByProvider, null);
  assert.deepStrictEqual(state.history, []);
  assert.strictEqual(state.quarantined.from, statePath);
  assert.strictEqual(state.quarantined.to, target);
  assert.match(state.quarantined.cause, /JSON/);
}

{
  const pinPath = '/test/codex.json';
  const fsImpl = refusingFs('[]');
  const refusal = captureRefusal(() => syncCodexPin(
    pinPath,
    { profileDir: '/profiles/account-a' },
    { fsImpl }
  ));

  assert.strictEqual(refusal.code, 'ACCOUNTS_JSON_INVALID');
  assert.match(refusal.message, /must contain an object\. Refusing to infer an empty value\./);
  assert.deepStrictEqual(refusal.details, { file: pinPath });
  assert.deepStrictEqual(fsImpl.effects, { mkdir: [], write: [] },
    'a non-object pin must not be overwritten or have its directory touched');
}

{
  const scratch = scratchDirectory('fra-state-quarantine-');
  try {
    const statePath = path.join(scratch, 'state.json');
    const now = () => new Date('2026-09-02T18:30:00.000Z');
    const previous = `${statePath}.corrupt-2026-09-02T18-30-00-000Z`;
    fs.writeFileSync(previous, 'previous backup');
    const saved = [];
    for (const bytes of ['{ first damaged record', '\u0000second damaged record']) {
      fs.writeFileSync(statePath, bytes);
      const result = readState(statePath, { now });
      saved.push(result.quarantined.to);
      assert.equal(fs.readFileSync(result.quarantined.to, 'utf8'), bytes);
      assert.equal(fs.existsSync(statePath), false);
    }
    assert.equal(new Set(saved).size, 2, 'same-clock quarantines must have distinct destinations');
    assert.equal(fs.readFileSync(previous, 'utf8'), 'previous backup');
    assert.deepEqual(saved.map(file => fs.readFileSync(file, 'utf8')), ['{ first damaged record', '\u0000second damaged record']);
  } finally { removeScratch(scratch); }
}

{
  const scratch = scratchDirectory('fra-state-quarantine-failure-');
  try {
    const statePath = path.join(scratch, 'state.json');
    fs.writeFileSync(statePath, '{ damaged state');
    assert.throws(() => readState(statePath, { fsImpl: {
      ...fs, renameSync() { throw Object.assign(new Error('rename refused'), { code: 'EACCES' }); }
    } }), { code: 'EACCES' });
    assert.equal(fs.readFileSync(statePath, 'utf8'), '{ damaged state');
    assert.deepEqual(fs.readdirSync(scratch), ['state.json'], 'failed rename must remove only its empty reserved directory');
  } finally { removeScratch(scratch); }
}

console.log('5/5 ACCOUNTS_JSON_INVALID driven refusals and state quarantine cases passed');
