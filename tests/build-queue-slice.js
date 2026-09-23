'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const slice = require('../src/lib/build-queue-slice');
const { renderPhase } = require('../src/lib/build-queue-writer');

function expectCode(callback, code) {
  assert.throws(callback, error => error && error.code === code);
}

const writerPhase = renderPhase({
  phaseId: 'Q3',
  title: 'Writer envelope',
  authority: 'R50 (directiveId: queue-slice-fixture)',
  instructions: 'Exact **markdown** with CRLF\r\n---\r\nand unicode \uD83E\uDDF5.'
}).toString('utf8');

const fixture = [
  '# Queue', '',
  '## Q1 \u2014 Alpha', '',
  '**Status:** OPEN planned work', '',
  '**Authority:** R1 (directiveId: alpha)', '',
  '**Build:**', 'Keep legacy prose as-is.', '', '---', '',
  '## Q2 - Beta', '',
  '**Status:** PARTIAL started', '',
  '**Authority:** R2 (directiveId: beta)', '',
  '**Build:**', 'Also exact.', '', '---', '',
  writerPhase
].join('\n');

{
  const first = slice.projectPackageQueueSlice({ queueMarkdown: fixture, packageId: 'fleet.queue', phaseIds: ['Q3', 'Q1'] });
  const second = slice.projectPackageQueueSlice({ queueMarkdown: fixture, packageId: 'fleet.queue', phaseIds: ['Q1', 'Q3'] });
  assert.deepEqual(first, second, 'source order, not caller order, determines a slice');
  assert.deepEqual(first.phaseIds, ['Q1', 'Q3']);
  assert.equal(first.phases[0].status, 'OPEN');
  assert.equal(first.phases[0].statusLine, '**Status:** OPEN planned work');
  assert.equal(first.phases[0].authority, 'R1 (directiveId: alpha)');
  assert.equal(first.phases[0].verbatimInstructions, null, 'legacy prose is carried in phaseMarkdown, never relabelled as verbatim');
  assert.ok(first.phases[0].phaseMarkdown.includes('Keep legacy prose as-is.'));
  assert.equal(first.phases[1].verbatimInstructions, 'Exact **markdown** with CRLF\r\n---\r\nand unicode \uD83E\uDDF5.');
  assert.equal(first.phases[1].verbatimInstructionBytes, Buffer.byteLength(first.phases[1].verbatimInstructions, 'utf8'));
  assert.deepEqual(first.phases.map(phase => [phase.id, phase.sourceRange.startByte < phase.sourceRange.endByte]), [['Q1', true], ['Q3', true]]);
  for (const phase of first.phases) {
    const raw = Buffer.from(fixture, 'utf8').subarray(phase.sourceRange.startByte, phase.sourceRange.endByte);
    assert.equal(raw.toString('utf8'), phase.phaseMarkdown, `${phase.id} carries the source byte span without rewriting it`);
  }
}

{
  const generated = slice.generatePackageQueueSlices({
    queueMarkdown: fixture,
    assignments: { 'fleet.writer': ['Q3'], 'fleet.legacy': ['Q2'] }
  });
  assert.deepEqual(Object.keys(generated.slices), ['fleet.legacy', 'fleet.writer'], 'package keys are deterministic');
  assert.deepEqual(generated.unassignedPhaseIds, ['Q1']);
  expectCode(() => slice.generatePackageQueueSlices({
    queueMarkdown: fixture,
    assignments: { 'fleet.one': ['Q1'], 'fleet.two': ['Q1'] }
  }), 'QUEUE_SLICE_PHASE_COLLISION');
  expectCode(() => slice.projectPackageQueueSlice({ queueMarkdown: fixture, packageId: 'fleet.queue', phaseIds: ['Q99'] }), 'QUEUE_SLICE_PHASE_UNKNOWN');
}

{
  const projected = slice.projectPackageQueueSlice({ queueMarkdown: fixture, packageId: 'fleet.queue', phaseIds: ['Q3'] });
  const serialized = slice.serializePackageQueueSlice(projected);
  const envelope = JSON.parse(serialized);
  assert.deepEqual(
    slice.parseSerializedPackageQueueSlice(serialized, { expectedSha256: envelope.sliceSha256 }),
    envelope.slice,
    'serialized queue slice is reversible without field rewriting'
  );
  expectCode(() => slice.parseSerializedPackageQueueSlice(serialized), 'QUEUE_SLICE_EXPECTED_RECEIPT_REQUIRED');
  const tampered = JSON.parse(serialized);
  tampered.slice.phases[0].phaseMarkdown = tampered.slice.phases[0].phaseMarkdown.replace('Writer envelope', 'Changed');
  expectCode(() => slice.parseSerializedPackageQueueSlice(JSON.stringify(tampered), { expectedSha256: envelope.sliceSha256 }), 'QUEUE_SLICE_SERIALIZED_TAMPERED');

  for (const mutate of [
    value => { value.slice.packageId = 'owner.ledger'; },
    value => { value.slice.phaseIds = ['Q1']; },
    value => { value.slice.sourceSha256 = '0'.repeat(64); },
    value => { value.slice.sourceBytes += 1; },
    value => { value.slice.phases[0].sourceRange.startByte += 1; }
  ]) {
    const changed = JSON.parse(serialized);
    mutate(changed);
    changed.sliceSha256 = require('node:crypto').createHash('sha256').update(JSON.stringify(changed.slice)).digest('hex');
    expectCode(
      () => slice.parseSerializedPackageQueueSlice(JSON.stringify(changed), { expectedSha256: envelope.sliceSha256 }),
      'QUEUE_SLICE_SERIALIZED_TAMPERED'
    );
  }
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-queue-slice-readonly-'));
  const queueFile = path.join(root, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, fixture, 'utf8');
  try {
    const before = fs.readFileSync(queueFile, 'utf8');
    const blocks = slice.parseQueueBlocks(before);
    const actual = slice.projectPackageQueueSlice({ queueMarkdown: before, packageId: 'fleet.readonly', phaseIds: [blocks[0].id] });
    const after = fs.readFileSync(queueFile, 'utf8');
    assert.equal(after, before, 'projection accepts BUILD-QUEUE text read-only and never changes the supplied queue');
    assert.equal(actual.sourceSha256, require('node:crypto').createHash('sha256').update(before).digest('hex'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  expectCode(() => slice.parseQueueBlocks(fixture.replace('**Status:** OPEN planned work', '**Status:** OPEN\n**Status:** DONE')), 'QUEUE_PHASE_AMBIGUOUS');
  expectCode(() => slice.parseQueueBlocks(fixture.replace(/bytes=\d+/, 'bytes=1')), 'QUEUE_SLICE_INSTRUCTION_MALFORMED');
  expectCode(() => slice.projectPackageQueueSlice({ queueMarkdown: fixture, packageId: 'BAD PACKAGE', phaseIds: ['Q1'] }), 'QUEUE_SLICE_PACKAGE_INVALID');
}

console.log('build-queue-slice: 5 contract groups passed');
