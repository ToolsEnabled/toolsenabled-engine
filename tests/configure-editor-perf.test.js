// EXECUTABLE CHANGE
// testcanfail-tests-configure-editor-perf-test-js
//
// Mutation report: temporarily replacing DEFAULT_SETTINGS with Object.freeze({})
// left both Object.entries loops with zero iterations. The fresh-create test
// incorrectly remained green. Each loop now has an independent cardinality
// assertion; under that mutation each reports:
//   AssertionError [ERR_ASSERTION]: DEFAULT_SETTINGS must contain settings for a fresh create
//   AssertionError [ERR_ASSERTION]: DEFAULT_SETTINGS must contain settings for the drift guard
// The product file was restored byte-for-byte (SHA-256 before/after:
// e9ee25955e6a576ea3df838540e008a5e7bea86be8681fba05767e7a1d36221b).
// Restored run: the fresh-create test is `ok`; the complete file cannot be
// green because the committed .vscode/settings.json precondition is absent in
// this checkout, producing ENOENT in the existing drift-guard test.
// NOT-FOUND: exit-status/truthy-return-only evidence; swallowed failures via
// try/catch or optional chaining; mocks of the subject; file-wide skips or
// platform precondition guards; expected values computed by subject code.

'use strict';

// Q116.5 -- proves the four contract properties tools/configure-editor-perf.js
// must hold as PRODUCT behaviour on a customer machine: clearly disclosed,
// idempotent, non-destructive, reversible. Each test operates in its own
// throwaway directory so a real .vscode/settings.json is never touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const editorPerf = require('../tools/configure-editor-perf');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-editor-perf-'));
}

function settingsPath(dir) {
  return path.join(dir, editorPerf.RELATIVE_TARGET);
}

function markerPath(dir) {
  return path.join(dir, editorPerf.MARKER_RELATIVE);
}

function writeSettings(dir, text) {
  fs.mkdirSync(path.dirname(settingsPath(dir)), { recursive: true });
  fs.writeFileSync(settingsPath(dir), text, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function silentLog() { /* tests assert on return values and file state, not console noise */ }

test('creating fresh: no .vscode/settings.json exists yet', () => {
  const dir = tempDir();
  const result = editorPerf.apply(dir, { log: silentLog });
  assert.equal(result.status, 'create');
  assert.equal(result.changed, true);
  const written = readJson(settingsPath(dir));
  assert.notEqual(Object.keys(editorPerf.DEFAULT_SETTINGS).length, 0,
    'DEFAULT_SETTINGS must contain settings for a fresh create');
  for (const [key, value] of Object.entries(editorPerf.DEFAULT_SETTINGS)) {
    assert.deepEqual(written[key], value, `expected ${key} to be written`);
  }
  // Disclosure is real content in the file, not a side channel the customer
  // could miss by not reading a console.
  assert.ok(Array.isArray(written['//']) && written['//'].length > 0, 'a disclosure comment key must be present');
  assert.ok(fs.existsSync(markerPath(dir)), 'a marker recording what this tool added must exist');
});

test('idempotent: applying twice changes nothing the second time', () => {
  const dir = tempDir();
  editorPerf.apply(dir, { log: silentLog });
  const settingsAfterFirst = fs.readFileSync(settingsPath(dir), 'utf8');
  const markerAfterFirst = fs.readFileSync(markerPath(dir), 'utf8');

  const second = editorPerf.apply(dir, { log: silentLog });
  assert.equal(second.status, 'already-applied');
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(settingsPath(dir), 'utf8'), settingsAfterFirst, 'settings.json must be byte-identical after a no-op run');
  assert.equal(fs.readFileSync(markerPath(dir), 'utf8'), markerAfterFirst, 'the marker must not be rewritten on a no-op run');
});

test('non-destructive: an existing key the user set is never overwritten, even when it disagrees with our default', () => {
  const dir = tempDir();
  writeSettings(dir, JSON.stringify({
    'search.followSymlinks': true,
    'git.autofetch': true,
    'files.watcherExclude': { '**/node_modules/**': true, '**/my-custom-dir/**': false }
  }, null, 2));

  const result = editorPerf.apply(dir, { log: silentLog });
  assert.equal(result.status, 'merge');
  const written = readJson(settingsPath(dir));

  // Values the user set, including ones that conflict with our defaults, survive untouched.
  assert.equal(written['search.followSymlinks'], true, 'user override must survive');
  assert.equal(written['git.autofetch'], true, 'user override must survive');
  assert.equal(written['files.watcherExclude']['**/my-custom-dir/**'], false, 'user sub-entry must survive');
  assert.equal(written['files.watcherExclude']['**/node_modules/**'], true, 'pre-existing sub-entry must be untouched');

  // Missing keys/entries are still filled in.
  assert.equal(written['git.autorefresh'], false, 'missing top-level default must be added');
  assert.equal(written['files.watcherExclude']['**/logs/**'], true, 'missing sub-entry must be filled in on an existing object key');
  assert.equal(written['search.exclude']['**/logs'], true, 'a wholly-missing top-level key must be added in full');

  // The tool never invents a disclosure block inside an existing file (that
  // would be adding content the user did not ask for beyond the declared keys).
  assert.equal(Object.prototype.hasOwnProperty.call(written, '//'), false);
});

test('a scalar/array where an object was expected is left alone entirely, not coerced', () => {
  const dir = tempDir();
  writeSettings(dir, JSON.stringify({ 'files.watcherExclude': false }, null, 2));
  const result = editorPerf.apply(dir, { log: silentLog });
  const written = readJson(settingsPath(dir));
  assert.equal(written['files.watcherExclude'], false, 'a non-object value for a normally-mergeable key must be left exactly as the user set it');
  assert.equal(result.changed, true, 'other missing defaults are still applied around it');
});

test('unparseable (JSONC comments): left completely untouched, byte-for-byte', () => {
  const dir = tempDir();
  const commented = '{\n  // I like my comments\n  "editor.tabSize": 2,\n}\n';
  writeSettings(dir, commented);
  const result = editorPerf.apply(dir, { log: silentLog });
  assert.equal(result.status, 'unparseable');
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(settingsPath(dir), 'utf8'), commented, 'a commented file must never be rewritten');
  assert.equal(fs.existsSync(markerPath(dir)), false, 'no marker is written when nothing was changed');
});

test('not an object (e.g. a JSON array at the top level): left untouched', () => {
  const dir = tempDir();
  const arrayContent = '[1, 2, 3]\n';
  writeSettings(dir, arrayContent);
  const result = editorPerf.apply(dir, { log: silentLog });
  assert.equal(result.status, 'not-an-object');
  assert.equal(fs.readFileSync(settingsPath(dir), 'utf8'), arrayContent);
});

test('reversible: undo after a fresh create removes the file entirely', () => {
  const dir = tempDir();
  editorPerf.apply(dir, { log: silentLog });
  assert.ok(fs.existsSync(settingsPath(dir)));

  const result = editorPerf.undo(dir, { log: silentLog });
  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(settingsPath(dir)), false, 'a file this tool created from nothing is fully removed on undo');
  assert.equal(fs.existsSync(markerPath(dir)), false, 'the marker is cleared once undo completes');
});

test('reversible: undo after a merge removes only what this tool added, keeping the user\'s own keys', () => {
  const dir = tempDir();
  writeSettings(dir, JSON.stringify({ 'editor.tabSize': 4, 'search.followSymlinks': true }, null, 2));
  editorPerf.apply(dir, { log: silentLog });

  const result = editorPerf.undo(dir, { log: silentLog });
  assert.equal(result.changed, true);
  const written = readJson(settingsPath(dir));
  assert.equal(written['editor.tabSize'], 4, 'a key that predates this tool must survive undo');
  assert.equal(written['search.followSymlinks'], true, 'a key that predates this tool must survive undo');
  assert.equal(Object.prototype.hasOwnProperty.call(written, 'git.autorefresh'), false, 'a key this tool added must be gone after undo');
  assert.equal(Object.prototype.hasOwnProperty.call(written, 'files.watcherExclude'), false, 'a key this tool added must be gone after undo');
});

test('reversible but safe: undo leaves a key alone if the user customized it after this tool set it', () => {
  const dir = tempDir();
  editorPerf.apply(dir, { log: silentLog });

  // The user (or something else) edits a value this tool set, in between apply and undo.
  const current = readJson(settingsPath(dir));
  current['git.autorefresh'] = true; // tool had set this to false
  delete current['//'];
  fs.writeFileSync(settingsPath(dir), `${JSON.stringify(current, null, 2)}\n`, 'utf8');

  const result = editorPerf.undo(dir, { log: silentLog });
  assert.ok(result.keptTop.includes('git.autorefresh'), 'a since-modified key must be reported as kept, not silently dropped');
  const written = readJson(settingsPath(dir));
  assert.equal(written['git.autorefresh'], true, 'the user\'s post-apply edit must survive undo');
});

test('undo with no prior apply is a safe no-op', () => {
  const dir = tempDir();
  const result = editorPerf.undo(dir, { log: silentLog });
  assert.equal(result.changed, false);
});

test('running apply twice with an intervening manual addition only fills the new gap, and is still idempotent after that', () => {
  const dir = tempDir();
  writeSettings(dir, JSON.stringify({ 'files.watcherExclude': { '**/logs/**': true } }, null, 2));
  editorPerf.apply(dir, { log: silentLog });
  const afterFirst = readJson(settingsPath(dir));
  assert.equal(afterFirst['files.watcherExclude']['**/node_modules/**'], true);
  assert.equal(afterFirst['files.watcherExclude']['**/logs/**'], true, 'the pre-existing entry must be unchanged');

  const second = editorPerf.apply(dir, { log: silentLog });
  assert.equal(second.status, 'already-applied');
});

test('DEFAULT_SETTINGS round-trips through a fresh generated profile (drift guard)', () => {
  assert.notEqual(Object.keys(editorPerf.DEFAULT_SETTINGS).length, 0,
    'DEFAULT_SETTINGS must contain settings for the drift guard');
  const dir = tempDir();
  const result = editorPerf.apply(dir, { log: silentLog });
  assert.equal(result.status, 'create');
  const committed = readJson(settingsPath(dir));
  for (const [key, value] of Object.entries(editorPerf.DEFAULT_SETTINGS)) {
    assert.deepEqual(committed[key], value, `fresh generated settings disagree with DEFAULT_SETTINGS on ${key}`);
  }
});
