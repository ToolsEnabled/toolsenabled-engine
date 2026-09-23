// WHAT THIS PINS, AND WHY IT IS A COST TEST RATHER THAN A CALL-COUNT TEST.
//
// validateProjectionState() re-parsed both audit projection files on every
// admission. MEASURED 2026-09-03 on a copy of the owner's Live install
// (actions.jsonl 11.49 MB / 10,053 rows + actions.log 6.63 MB), node v22.14.0,
// this machine: one pass cost a median of 223 ms, synchronously, on the Electron
// main thread. Evidence:
// REPORT-crash-20260903/evidence/E/{bench-audit-projection.txt,fix1-before-after.txt}.
//
// The memo that fixes it applies ONLY when the real filesystem is used, so an
// injected `dependencies.fs` double -- the way every other suite in this tree
// counts an admission's reads -- cannot observe it at all. That leaves two
// things a test can honestly witness, and this file asserts both:
//
//   1. COST. A second parse of an unchanged file of the real size must not pay
//      the full parse again. Asserted as a RATIO against this run's own cold
//      parse, not against a wall-clock constant, so a slow or loaded machine
//      cannot make it flake -- the shipped code's ratio is ~1.0 and the fixed
//      code's is ~0.003.
//   2. THE KEY. The memo is keyed on the file's CONTENT digest, never on its
//      size and mtime, because an in-place rewrite preserving both is exactly
//      the tamper this parse exists to expose. Case 2 rewrites the file with
//      BYTE-IDENTICAL content, which moves the modification time and nothing
//      else: a content key still answers from the memo, a stat key is
//      invalidated and pays the whole parse again. It then rewrites one row in
//      place at identical length and requires the parse to report the NEW bytes.
//
// Discrimination: with the memo removed from src/lib/audit.js, case 1 fails with
// "a repeated parse still paid ... of the cold parse" and case 2 fails with
// "the memo is keyed on the file's stat rather than on its content". Keying the
// memo on statSync() instead of the digest leaves case 1 green and case 2 red.
//
// NOT ASSERTED, and deliberately: this file does not restore the modification
// time after the tamper. Node's utimesSync truncates to whole milliseconds on
// this platform while stat reports fractional ones, so a restored mtime does
// not in fact compare equal -- an assertion built on it would be testing the
// fixture, not the subject. Case 2's first half carries the key question
// instead, and carries it without depending on timestamp precision at all.

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// The parse is internal, so it is reached the way the admission path reaches it:
// through the exported verify surface? No -- that needs a store, a vault and a
// signer, none of which this cost question involves. It is reached instead by
// loading the module a second time with the one function re-exported, which is
// the SAME file, byte for byte, plus one appended line.
function loadParsedProjection() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'audit.js'), 'utf8');
  const probe = path.join(__dirname, '..', 'src', 'lib', `.audit-parse-probe-${process.pid}-${crypto.randomUUID()}.cjs`);
  fs.writeFileSync(probe, `${source}\nmodule.exports.__parsedProjection = parsedProjection;\n`);
  try {
    return require(probe).__parsedProjection;
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

// A projection of the size the owner's install actually carries. Built here, not
// copied from anywhere, so the fixture is independently specified.
const ROWS = 10_000;

function buildJsonlProjection(file) {
  const chunks = [];
  let previousHash = '0'.repeat(64);
  for (let index = 1; index <= ROWS; index += 1) {
    const eventHash = crypto.createHash('sha256').update(`row-${index}`).digest('hex');
    chunks.push(`${JSON.stringify({
      sequence: index,
      eventId: `audit-parse-memo-${String(index).padStart(8, '0')}`,
      timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      action: 'host.exec.result',
      target: `target-${index}`,
      details: { note: 'x'.repeat(700) },
      occurredAtMs: 1_700_000_000_000 + index * 1000,
      previousHash,
      eventHash,
      keyId: 'audit-parse-memo-key',
      signature: 'c'.repeat(86),
      createdAtMs: 1_700_000_000_000 + index * 1000,
    })}\n`);
    previousHash = eventHash;
  }
  fs.writeFileSync(file, chunks.join(''));
  return chunks;
}

function elapsed(fn) {
  const started = process.hrtime.bigint();
  const value = fn();
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, value };
}

test('a repeated parse of an unchanged projection does not pay the full parse again', () => {
  const parsedProjection = loadParsedProjection();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-parse-memo-cost-'));
  const file = path.join(directory, 'actions.jsonl');
  try {
    buildJsonlProjection(file);
    const bytes = fs.statSync(file).size;
    assert.ok(bytes > 7 * 1024 * 1024, `the fixture must be of the real order of size, got ${bytes} bytes`);

    const cold = elapsed(() => parsedProjection(file, 'jsonl'));
    assert.equal(cold.value.length, ROWS, 'the cold parse must read every row');

    // Five repeats, and the CHEAPEST of them is the one asserted: a single
    // sample on a four-core machine shared with other work is noise, and the
    // claim being made is about the floor the code can reach, not the median.
    let cheapest = Infinity;
    let rows = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const again = elapsed(() => parsedProjection(file, 'jsonl'));
      if (again.ms < cheapest) cheapest = again.ms;
      rows = again.value;
    }
    assert.equal(rows.length, ROWS, 'a repeated parse must still answer every row');
    assert.deepEqual(rows[0], cold.value[0], 'a repeated parse must answer the same first row');
    assert.deepEqual(rows[ROWS - 1], cold.value[ROWS - 1], 'a repeated parse must answer the same last row');

    const ratio = cheapest / cold.ms;
    assert.ok(
      ratio < 0.1,
      `a repeated parse still paid ${(ratio * 100).toFixed(1)}% of the cold parse `
      + `(cold ${cold.ms.toFixed(1)} ms, repeat ${cheapest.toFixed(2)} ms over ${bytes} bytes); `
      + 'the admission path re-parses the whole projection on every audited action',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the memo is keyed on the projection\'s CONTENT, not on its size and modification time', () => {
  const parsedProjection = loadParsedProjection();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-parse-memo-key-'));
  const file = path.join(directory, 'actions.jsonl');
  try {
    const chunks = buildJsonlProjection(file);
    const cold = elapsed(() => parsedProjection(file, 'jsonl'));
    const originalHash = cold.value[4_000].eventHash;

    // SAME BYTES, NEW MODIFICATION TIME. A content key still answers from the
    // memo here; a size-and-mtime key is invalidated and pays the whole parse
    // again. That difference is what this case exists to see -- so it is the
    // half of the pair that discriminates the two designs.
    fs.writeFileSync(file, chunks.join(''));
    let cheapest = Infinity;
    let rows = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const again = elapsed(() => parsedProjection(file, 'jsonl'));
      if (again.ms < cheapest) cheapest = again.ms;
      rows = again.value;
    }
    assert.equal(rows.length, ROWS, 'a rewritten-identical projection must still answer every row');
    assert.equal(rows[4_000].eventHash, originalHash, 'identical bytes must answer identical rows');
    assert.ok(
      cheapest / cold.ms < 0.1,
      `after a byte-identical rewrite the parse paid ${((cheapest / cold.ms) * 100).toFixed(1)}% of the cold parse `
      + `(cold ${cold.ms.toFixed(1)} ms, repeat ${cheapest.toFixed(2)} ms); the memo is keyed on the file's `
      + 'stat rather than on its content, which is both slower here and unsound against an in-place rewrite',
    );

    // CHANGED BYTES, SAME LENGTH. Whatever the key, a projection whose content
    // has moved must never be answered from a remembered parse: an in-place
    // rewrite that preserves length is exactly the tamper this parse exposes.
    const tamperedHash = crypto.createHash('sha256').update('tampered-row-4001').digest('hex');
    assert.notEqual(tamperedHash, originalHash, 'the tamper must actually change the value');
    const tampered = chunks.slice();
    tampered[4_000] = tampered[4_000].replace(originalHash, tamperedHash);
    assert.equal(tampered[4_000].length, chunks[4_000].length, 'the tamper must preserve the line length');
    fs.writeFileSync(file, tampered.join(''));
    assert.equal(fs.statSync(file).size, cold.value.length && Buffer.byteLength(chunks.join('')), 'the rewrite must preserve the file size');

    const reparsed = parsedProjection(file, 'jsonl');
    assert.equal(
      reparsed[4_000].eventHash,
      tamperedHash,
      'a rewritten projection was served from the memo: the parse reported the OLD row over bytes that had changed',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
