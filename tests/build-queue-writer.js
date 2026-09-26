'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireLock } = require('../src/lib/agent-digest/lock');
const writer = require('../src/lib/build-queue-writer');
const corpus = require('../src/lib/build-queue-corpus');

const fixture = [
  '# Queue', '',
  '## Q1 — Existing phase', '',
  '**Status:** OPEN', '',
  '**Authority:** R1 (directiveId: directive-existing)', '',
  '**Build:**', 'Keep this exact.', ''
].join('\n');

function tempQueue(content = fixture) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'build-queue-writer-'));
  const file = path.join(directory, 'BUILD-QUEUE.md');
  fs.writeFileSync(file, content, 'utf8');
  return { directory, file };
}

function remove(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function expectCode(callback, code) {
  assert.throws(callback, error => error && error.code === code);
}

function phase(instructions = 'Do not rewrite this instruction.\n\n- Preserve markdown exactly.\n---\nStill instruction text.') {
  return {
    title: 'Round-trip contract',
    authority: 'R69 (directiveId: directive-round-trip)',
    instructions
  };
}

{
  // existsSync used to turn any lookup failure into false, so an inaccessible
  // queue was confidently reported as missing. Preserve non-ENOENT uncertainty
  // for both writer entry points while retaining the deliberate missing-file
  // refusal.
  const unavailable = path.join(os.tmpdir(), `build-queue-writer-unavailable-${process.pid}`);
  const originalStat = fs.statSync;
  const denied = Object.assign(new Error('lookup could not be completed'), { code: 'EACCES' });
  fs.statSync = candidate => {
    if (candidate === unavailable) throw denied;
    return originalStat(candidate);
  };
  try {
    assert.throws(
      () => writer.appendQueuePhase({ queueFile: unavailable, expectedHash: '0'.repeat(64), phase: phase() }),
      error => error === denied,
      'append must preserve an indeterminate queue lookup instead of reporting QUEUE_NOT_FOUND'
    );
    assert.throws(
      () => writer.transitionQueuePhase({
        queueFile: unavailable,
        expectedHash: '0'.repeat(64),
        phaseId: 'Q1',
        action: 'claim',
        actor: 'agent'
      }),
      error => error === denied,
      'transition must preserve an indeterminate queue lookup instead of reporting QUEUE_NOT_FOUND'
    );
  } finally {
    fs.statSync = originalStat;
  }
  expectCode(
    () => writer.appendQueuePhase({ queueFile: unavailable, expectedHash: '0'.repeat(64), phase: phase() }),
    'QUEUE_NOT_FOUND'
  );
}

// Reproduces the exact 2026-08-04 production defect: Q99 closed correctly
// per protocol (body deleted, one receipt left in "## Completed"), which
// freed Q99 for reuse because nextPhaseId only ever scanned live headings.
// Q1 stays live and low-numbered; Q2 exists *only* as a Completed receipt --
// its "## Q2" body is already gone, exactly like every phase this queue has
// ever closed.
const retiredOnlyFixture = [
  '# Queue', '',
  '## Q1 — Existing phase', '',
  '**Status:** OPEN', '',
  '**Authority:** R1 (directiveId: directive-existing)', '',
  '**Build:**', 'Keep this exact.', '',
  '---', '',
  '## Completed — do not rebuild', '',
  '- **Q2: Retired phase:** DONE 2026-08-01 (closed and deleted from the live section; only this receipt remains, exactly like Q99.)',
  ''
].join('\n');

// Reproduces Q50/Q74's package-slice relocation: a phase's body moved out of
// the root into queue/<package>.md, leaving only this marker behind. The id
// must stay reserved even when a caller (a CLI, a test, a future tool) hands
// nextPhaseId just the root text instead of the slice-composed corpus.
const slicedOnlyFixture = [
  '# Queue', '',
  '## Q1 — Existing phase', '',
  '**Status:** OPEN', '',
  '**Authority:** R1 (directiveId: directive-existing)', '',
  '**Build:**', 'Keep this exact.', '',
  '---', '',
  '<!-- build-queue-slice:v1 phase=Q5 package=repo-protocol -->',
  ''
].join('\n');

{
  const input = phase('Exact **markdown**, quotes "here", CRLF\r\nand a --- divider.');
  const rendered = writer.renderPhase({ ...input, phaseId: 'Q2' });
  const recovered = writer.parseRenderedPhase(rendered);
  assert.ok(rendered.toString('utf8').includes('Q2 \u2014 Round-trip contract'), 'new queue phases emit the canonical U+2014 heading delimiter');
  assert.deepEqual(writer.parseStrictQueue('## Q2 \u2014 Canonical heading\n\n**Status:** OPEN\n'), [{ id: 'Q2', title: 'Canonical heading', statusCount: 1 }], 'strict parser accepts the actual U+2014 queue grammar');
  assert.equal(recovered.phaseId, 'Q2');
  assert.equal(recovered.title, input.title);
  assert.equal(recovered.status, 'OPEN');
  assert.equal(recovered.authority, input.authority);
  assert.equal(recovered.instructions, input.instructions, 'instruction text round-trips byte-for-byte through the writer envelope');
}

{
  const { directory, file } = tempQueue();
  try {
    const before = fs.readFileSync(file, 'utf8');
    const originalOpen = fs.openSync;
    const originalFsync = fs.fsyncSync;
    const descriptorPaths = new Map();
    const fsyncTargets = [];
    fs.openSync = (...args) => {
      const descriptor = originalOpen(...args);
      descriptorPaths.set(descriptor, String(args[0]));
      return descriptor;
    };
    fs.fsyncSync = descriptor => {
      fsyncTargets.push(descriptorPaths.get(descriptor) || '<unknown>');
      return originalFsync(descriptor);
    };
    let result;
    try {
      result = writer.appendQueuePhase({ queueFile: file, expectedHash: writer.sha256(before), phase: phase() });
    } finally {
      fs.openSync = originalOpen;
      fs.fsyncSync = originalFsync;
    }
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(result.phaseId, 'Q2');
    assert.equal(result.previousHash, writer.sha256(before));
    assert.equal(result.nextHash, writer.sha256(after));
    assert.ok(after.startsWith(before), 'append leaves all existing queue bytes untouched');
    assert.equal(writer.parseRenderedPhase(Buffer.from(result.rendered)).instructions, phase().instructions);
    assert.equal(fs.existsSync(`${file}.lock`), false, 'lock is released after an atomic replacement');
    assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false, 'temporary sibling is cleaned up');
    assert.ok(fsyncTargets.some(target => target.endsWith('.tmp')), 'atomic replacement fsyncs the staged queue sibling before rename');
  } finally { remove(directory); }
}

{
  const { directory, file } = tempQueue();
  try {
    const before = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, '\nmanual concurrent edit\n', 'utf8');
    const changed = fs.readFileSync(file, 'utf8');
    expectCode(() => writer.appendQueuePhase({ queueFile: file, expectedHash: writer.sha256(before), phase: phase() }), 'QUEUE_CONCURRENT_EDIT');
    assert.equal(fs.readFileSync(file, 'utf8'), changed, 'CAS refusal is byte-untouched');
  } finally { remove(directory); }
}

{
  const { directory, file } = tempQueue();
  try {
    const before = fs.readFileSync(file, 'utf8');
    const lock = acquireLock(`${file}.lock`);
    try {
      expectCode(() => writer.appendQueuePhase({ queueFile: file, expectedHash: writer.sha256(before), phase: phase() }), 'QUEUE_LOCKED');
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'lock refusal does not alter the queue');
    } finally { lock.release(); }
  } finally { remove(directory); }
}

{
  const malformed = fixture.replace('**Status:** OPEN', '**Status:** OPEN\n**Status:** DONE');
  expectCode(() => writer.parseStrictQueue(malformed), 'QUEUE_PHASE_AMBIGUOUS');
  const duplicate = `${fixture}\n## Q1 — Duplicate\n\n**Status:** OPEN\n`;
  expectCode(() => writer.parseStrictQueue(duplicate), 'QUEUE_PHASE_AMBIGUOUS');
  expectCode(() => writer.parseStrictQueue(fixture.replace('## Q1 — Existing phase', '## Q1 missing delimiter')), 'QUEUE_PHASE_MALFORMED');
  const { directory, file } = tempQueue();
  try {
    const before = fs.readFileSync(file, 'utf8');
    expectCode(() => writer.appendQueuePhase({
      queueFile: file,
      expectedHash: writer.sha256(before),
      phase: { ...phase(), phaseId: 'Q3' }
    }), 'QUEUE_PHASE_NOT_NEXT');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'bad next id never changes queue bytes');
  } finally { remove(directory); }
}

{
  const { directory, file } = tempQueue();
  const queueDirectory = path.join(directory, 'queue');
  fs.mkdirSync(queueDirectory);
  const rootBefore = `# Queue\n\n${corpus.renderQueueIndex(['repo-protocol'])}${fixture}`;
  const sliceFile = path.join(queueDirectory, 'repo-protocol.md');
  const sliceBefore = fixture.replace(/Q1/g, 'Q2').replace('Existing phase', 'Package phase');
  fs.writeFileSync(file, rootBefore, 'utf8');
  fs.writeFileSync(sliceFile, sliceBefore, 'utf8');
  try {
    const before = corpus.readQueueCorpus(file);
    const result = writer.appendQueuePhase({
      queueFile: file,
      expectedHash: before.sha256,
      packageId: 'repo-protocol',
      phase: phase()
    });
    const after = corpus.readQueueCorpus(file);
    assert.equal(result.phaseId, 'Q3');
    assert.equal(result.packageId, 'repo-protocol');
    assert.equal(result.queuePath, 'queue/repo-protocol.md');
    assert.equal(result.nextHash, after.sha256);
    assert.equal(fs.readFileSync(file, 'utf8'), rootBefore, 'a package append leaves root protocol/index bytes untouched');
    assert.ok(fs.readFileSync(sliceFile, 'utf8').startsWith(sliceBefore), 'a package append preserves existing slice bytes');
    expectCode(() => writer.appendQueuePhase({
      queueFile: file,
      expectedHash: after.sha256,
      packageId: 'missing.package',
      phase: phase()
    }), 'QUEUE_PACKAGE_NOT_INDEXED');
  } finally { remove(directory); }
}

{
  // Regression for the exact 2026-08-03 production outage: Q81's Status line
  // read "IN PROGRESS" (a space) instead of the documented "IN-PROGRESS"
  // (a hyphen). parseStrictQueue silently classified that as an undocumented
  // Status line, which took out nextPhaseId/appendQueuePhase for the whole
  // queue and forced every phase to be hand-edited. A malformed status must
  // fail loudly here so it cannot silently disable the writer again.
  const spacedInProgress = fixture.replace('**Status:** OPEN', '**Status:** IN PROGRESS (typo: space instead of hyphen)');
  expectCode(() => writer.parseStrictQueue(spacedInProgress), 'QUEUE_PHASE_MALFORMED');
  expectCode(() => writer.nextPhaseId(spacedInProgress), 'QUEUE_PHASE_MALFORMED');
  // The sibling typo class observed in the same incident: a status keyword
  // that is not in the documented grammar at all (Q82's "QUEUED SECONDARY").
  const undocumentedKeyword = fixture.replace('**Status:** OPEN', '**Status:** QUEUED SECONDARY (not a documented status keyword)');
  expectCode(() => writer.parseStrictQueue(undocumentedKeyword), 'QUEUE_PHASE_MALFORMED');
  console.log('build-queue-writer: Q81-class status typo regression passed (space-for-hyphen and undocumented keywords fail loudly).');
}

{
  // A complete owned corpus keeps the production outage regression portable:
  // live headings, completed receipts and package-slice markers all reserve
  // ids, while the strict parser still validates every live Status line.
  const corpusFixture = [
    '# BUILD-QUEUE', '',
    '## Q7 - Live fixture phase', '',
    '**Status:** OPEN', '',
    '**Authority:** R7 (directiveId: fixture-live)', '',
    '**Build:**', 'Fixture work.', '',
    '---', '',
    '## Completed - do not rebuild', '',
    '- **Q19: Completed fixture:** DONE 2026-08-04 (body deleted; receipt retained.)', '',
    '<!-- build-queue-slice:v1 phase=Q23 package=repo-protocol -->', ''
  ].join('\n');
  const { directory, file } = tempQueue(corpusFixture);
  let fixtureNextId;
  let fixtureMarkdown;
  try {
    fixtureMarkdown = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => { fixtureNextId = writer.nextPhaseId(fixtureMarkdown); }, 'the complete fixture corpus satisfies the strict writer grammar');
    assert.match(fixtureNextId, /^Q[1-9]\d{0,2}$/, 'nextPhaseId returns a well-formed id against the complete corpus');
    assert.equal(fs.readFileSync(file, 'utf8'), corpusFixture, 'calculating the next id is read-only');
  } finally {
    remove(directory);
  }

  const liveMarkdown = fixtureMarkdown;
  const liveNextId = fixtureNextId;

  // Recompute the ceiling independently (a separate regex pass over the raw
  // bytes, not a call into the writer under test) from every place an id is
  // assigned. The allocated id must exceed that ceiling.
  let independentCeiling = 0;
  for (const match of liveMarkdown.matchAll(/^##\s+(Q[1-9]\d{0,2})\s+(?:—|-)\s+.+$/gm)) {
    independentCeiling = Math.max(independentCeiling, Number.parseInt(match[1].slice(1), 10));
  }
  for (const match of liveMarkdown.matchAll(/^-\s+\*\*(Q[1-9]\d{0,2})\b/gm)) {
    independentCeiling = Math.max(independentCeiling, Number.parseInt(match[1].slice(1), 10));
  }
  for (const match of liveMarkdown.matchAll(/^<!-- build-queue-slice:v1 phase=(Q[1-9]\d{0,2}) package=[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\s*-->/gm)) {
    independentCeiling = Math.max(independentCeiling, Number.parseInt(match[1].slice(1), 10));
  }
  const liveNextNumber = Number.parseInt(liveNextId.slice(1), 10);
  assert.ok(
    liveNextNumber > independentCeiling,
    `nextPhaseId must exceed every id assigned in the complete fixture (got ${liveNextId}, independent ceiling Q${independentCeiling})`
  );
  assert.equal(liveNextId, 'Q24', 'the known combined fixture allocates past its Q23 ceiling');
  console.log(`build-queue-writer: complete fixture corpus parses cleanly, next id is ${liveNextId} (independent ceiling Q${independentCeiling}).`);
}

{
  // Required regression: the exact live scenario that shipped the defect --
  // a phase id that appears *only* in a Completed-ledger receipt, because
  // its "## Q<id>" body was already deleted per protocol. The allocator
  // must not hand that id back out.
  assert.equal(
    writer.nextPhaseId(retiredOnlyFixture),
    'Q3',
    'a phase id retired only into the Completed ledger must not be reused'
  );

  const { directory, file } = tempQueue(retiredOnlyFixture);
  try {
    const before = fs.readFileSync(file, 'utf8');
    expectCode(() => writer.appendQueuePhase({
      queueFile: file,
      expectedHash: writer.sha256(before),
      phase: { ...phase(), phaseId: 'Q2' }
    }), 'QUEUE_PHASE_NOT_NEXT');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'refusing a retired id never changes queue bytes');
    const result = writer.appendQueuePhase({ queueFile: file, expectedHash: writer.sha256(before), phase: phase() });
    assert.equal(result.phaseId, 'Q3', 'appendQueuePhase allocates past a Completed-only receipt end to end');
  } finally { remove(directory); }

  // Sibling regression for Q50/Q74-style package slices: an id relocated
  // into queue/<package>.md leaves only a marker in the root. That marker
  // alone (no live heading, no Completed receipt) must still reserve the id.
  assert.equal(
    writer.nextPhaseId(slicedOnlyFixture),
    'Q6',
    'a phase id relocated into a package-slice marker must be reserved from root-only text'
  );
  console.log('build-queue-writer: retired-receipt and package-slice-marker id-reuse regressions passed.');
}

{
  // Fail closed rather than guess: a line that opens exactly like a
  // Completed receipt or a slice marker but does not match the id grammar
  // is a format drift, not something to silently skip (which is how the
  // Completed ledger went unread in the first place).
  const malformedReceipt = retiredOnlyFixture.replace('- **Q2: Retired phase:**', '- **Q2a: Retired phase:**');
  expectCode(() => writer.nextPhaseId(malformedReceipt), 'QUEUE_RETIRED_RECEIPT_MALFORMED');

  const malformedMarker = slicedOnlyFixture.replace(
    '<!-- build-queue-slice:v1 phase=Q5 package=repo-protocol -->',
    '<!-- build-queue-slice:v1 phase=Q5x package=repo-protocol -->'
  );
  expectCode(() => writer.nextPhaseId(malformedMarker), 'QUEUE_SLICE_MARKER_MALFORMED');
  console.log('build-queue-writer: malformed retired-receipt and slice-marker lines fail closed.');
}

console.log('build-queue-writer: 11 contract groups passed');
