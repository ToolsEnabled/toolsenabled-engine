'use strict';
// THE CACHE READ'S OPTIONS: how old a reading may be, what an unusable
// threshold answers, and what the note may say.
//
// No real home is touched. The "cache" is a string an injected fsImpl hands
// back, and the test records every filename that fsImpl was asked for so the
// assertion that only `.claude.json` is ever named is a measurement.
//
// The limits array is the one Claude Code 2.1.258 wrote on 2026-09-02 (see
// tests/multi-account/usage-windows.test.js), so the read is exercised on the
// real kinds and the real active flag.
//
//   node --test tests/multi-account/claude-allowance.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CACHE_LEAF, NOT_MEASURED, claudeAllowance } = require('../../src/lib/multi-account/claude-allowance.js');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEKLY_RESET = '2026-09-03T17:00:00.426044+00:00';

const LIVE_RAW_LIMITS = [
  { kind: 'session', group: 'session', percent: 21, severity: 'normal', resets_at: '2026-09-02T16:50:00.425796+00:00', scope: null, is_active: false },
  { kind: 'weekly_all', group: 'weekly', percent: 25, severity: 'normal', resets_at: '2026-09-03T17:00:00.425819+00:00', scope: null, is_active: false },
  { kind: 'weekly_scoped', group: 'weekly', percent: 46, severity: 'normal', resets_at: WEEKLY_RESET, scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true }
];

function cacheText({ ageMs }) {
  return JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now() - ageMs,
      accountUuid: 'account-uuid-not-a-secret',
      utilization: { limits: LIVE_RAW_LIMITS }
    }
  });
}

function fakeFs(text) {
  const opened = [];
  return {
    opened,
    readFileSync(file) {
      opened.push(path.basename(file));
      return text;
    }
  };
}

test('a cache older than the default budget is not measured; a longer budget reads it', () => {
  const fsImpl = fakeFs(cacheText({ ageMs: 30 * MINUTE }));
  assert.equal(claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 99 }), NOT_MEASURED,
    'thirty minutes is beyond the fifteen-minute default');

  const aged = claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 99, freshnessBudgetMs: 2 * HOUR });
  assert.equal(aged.usedPercent, 46, 'the binding window is the active scoped weekly ceiling');
  assert.equal(aged.windows.hourly.usedPercent, 21);
  assert.equal(aged.windows.weekly.usedPercent, 46);
  assert.equal(aged.windows.weekly.label, 'weekly_scoped · Fable');
  assert.equal(aged.resetsAt, WEEKLY_RESET);
  assert.equal(aged.exhausted, false);
  assert.equal(aged.thresholdInvalid, false);
  assert.ok(Object.isFrozen(aged));
  assert.deepEqual([...new Set(fsImpl.opened)], [CACHE_LEAF], 'only the cache file is ever named');
  assert.equal(CACHE_LEAF, '.claude.json');
});

test('a cache beyond even the given budget stays not measured', () => {
  const fsImpl = fakeFs(cacheText({ ageMs: 3 * HOUR }));
  assert.equal(claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 99, freshnessBudgetMs: 2 * HOUR }), NOT_MEASURED);
});

test('a fresh cache reads under the default budget with no option given', () => {
  const fsImpl = fakeFs(cacheText({ ageMs: 10 * MINUTE }));
  const fresh = claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 99 });
  assert.equal(fresh.usedPercent, 46);
});

test('an unusable freshness budget answers not measured rather than throwing or reading unbounded', () => {
  for (const freshnessBudgetMs of [0, -5, 'an hour', Number.NaN, null]) {
    const fsImpl = fakeFs(cacheText({ ageMs: 1 * MINUTE }));
    assert.equal(claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 99, freshnessBudgetMs }), NOT_MEASURED,
      `budget ${String(freshnessBudgetMs)} must not become a reading`);
  }
});

test('the note names the window and the figure and carries no timestamp', () => {
  const fsImpl = fakeFs(cacheText({ ageMs: 1 * MINUTE }));
  const measured = claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 99 });
  assert.equal(measured.note, '46% of its weekly allowance is used.');
  assert.doesNotMatch(measured.note, /\d{4}-\d{2}-\d{2}T/, 'the raw reset time belongs on the window, not in the sentence');
  assert.doesNotMatch(measured.note, /resets/);
  assert.ok(measured.note.split(/\s+/).length < 25);
});

test('the threshold is applied when valid and reported invalid when not', () => {
  const fsImpl = fakeFs(cacheText({ ageMs: 1 * MINUTE }));
  assert.equal(claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 46 }).exhausted, true, 'at the threshold is spent');
  assert.equal(claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 40 }).exhausted, true);
  assert.equal(claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 47 }).exhausted, false);
  assert.equal(claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 0 }).exhausted, true, 'zero is a valid, if severe, threshold here as in health.js');

  for (const exhaustedAtPercent of [undefined, Number.NaN, -1, 101, '50', null]) {
    const answer = claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent });
    assert.equal(answer.thresholdInvalid, true, `threshold ${String(exhaustedAtPercent)} must be reported invalid`);
    assert.equal(answer.exhausted, false, 'an invalid threshold never calls an account spent');
    assert.equal(answer.usedPercent, 46, 'the reading itself is still reported');
  }
});

test('not measured has a stable shape and names no threshold fault', () => {
  assert.deepEqual(NOT_MEASURED, {
    windows: { hourly: null, weekly: null, weeklyWindows: [] },
    usedPercent: null,
    resetsAt: null,
    exhausted: false,
    thresholdInvalid: false,
    note: null
  });
  assert.ok(Object.isFrozen(NOT_MEASURED));
  const fsImpl = fakeFs('{}');
  assert.equal(claudeAllowance('', { fsImpl, exhaustedAtPercent: 99 }), NOT_MEASURED);
  assert.equal(claudeAllowance(null, { fsImpl, exhaustedAtPercent: 99 }), NOT_MEASURED);
  assert.deepEqual(fsImpl.opened, [], 'no home named, nothing opened');
  assert.equal(claudeAllowance('/home/.claude-a', { fsImpl, exhaustedAtPercent: 99 }), NOT_MEASURED, 'a cache without the key is nothing');
  const throwing = { readFileSync() { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
  assert.equal(claudeAllowance('/home/.claude-a', { fsImpl: throwing, exhaustedAtPercent: 99 }), NOT_MEASURED);
});

/* THE CACHE ROUTE, READ OFF REAL BYTES, WITH A NON-ASCII WINDOW LABEL.
 *
 * Every test above hands the reader a JavaScript string, so none of them can
 * see how the file is DECODED -- and the decode is the part that has already
 * gone wrong once on the sibling route. The live `get_usage` reader used to
 * call chunk.toString('utf8') per stdout chunk and tore any character whose
 * bytes straddled a chunk boundary into two U+FFFD (repaired 2026-09-03,
 * proved in tests/providers/claude-usage-probe.test.js). THIS route -- the
 * cache Claude Code writes, which is what an idle account is read from -- had
 * no equivalent guard, and it carries the same provider-written text: the
 * model display name that ../../src/lib/multi-account/usage-windows.js puts
 * into a window's `label` and the accounts menu prints.
 *
 * So this one writes a real file, as real UTF-8 bytes, and reads it with the
 * real fs through claudeAllowance()'s own `readFileSync(cacheFile, 'utf8')`.
 * A reader that drops that encoding, or names any other one, cannot pass.
 *
 * AND THE ROUND TRIP IS NOT THE WHOLE ASSERTION. A fixture and an expectation
 * that are the same literal would agree with each other even if THIS file were
 * re-encoded, so the label is also held against the two shapes a wrong decode
 * produces: the replacement character a torn read leaves, and the lead byte
 * mojibake starts with. Either of those, from either source, is red. */
// U+00E9 is two UTF-8 bytes and U+4E2D is three, so both cross the one-byte
// assumption a latin1 read makes, and neither is ASCII in any encoding.
const NON_ASCII_MODEL = 'Café 中 Model';
const REPLACEMENT_CHARACTER = /�/;          // what a torn character decodes to
const MOJIBAKE_LEAD_BYTE = /[Ãâ]/;     // what UTF-8 bytes read as latin1 begin with

test('a non-ASCII window label survives the cache read as one character, not as bytes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-allowance-utf8-'));
  try {
    const limits = LIVE_RAW_LIMITS.map(limit => (limit.kind === 'weekly_scoped'
      ? { ...limit, scope: { model: { id: null, display_name: NON_ASCII_MODEL }, surface: null } }
      : limit));
    fs.writeFileSync(path.join(home, CACHE_LEAF), Buffer.from(JSON.stringify({
      cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization: { limits } }
    }), 'utf8'));

    const measured = claudeAllowance(home, { exhaustedAtPercent: 99 });
    assert.notEqual(measured, NOT_MEASURED, 'the real cache file was not read at all');
    assert.equal(measured.windows.weekly.model, NON_ASCII_MODEL);
    assert.equal(measured.windows.weekly.label, `weekly_scoped · ${NON_ASCII_MODEL}`);
    assert.doesNotMatch(measured.windows.weekly.label, REPLACEMENT_CHARACTER, 'a character was torn in half by the read');
    assert.doesNotMatch(measured.windows.weekly.label, MOJIBAKE_LEAD_BYTE, 'the label came back double-encoded');
    assert.equal(measured.windows.weeklyWindows.at(-1).label, `weekly_scoped · ${NON_ASCII_MODEL}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
