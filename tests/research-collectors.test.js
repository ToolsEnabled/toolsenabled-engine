// Mutation check:
// Replaced the stdout schema guard `if (problems.length)` with `if (false)`.
// The edit landed in src/lib/research/collectors.js and was verified before running.
// This isolated test file went red because the schema-invalid record was collected.

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CollectorError,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_ENTRIES,
  MAX_RECORD_BYTES,
  MAX_RECORDS,
  collect,
  globToRegExp,
  schemaProblems
} = require('../src/lib/research/collectors');

test('stdout-json collects valid objects and refuses malformed or schema-invalid lines', () => {
  const result = collect({
    collector: { kind: 'stdout-json' },
    resultSchema: { fields: { score: 'number' }, required: ['score'] },
    stdout: [
      JSON.stringify({ score: 7, label: 'kept' }),
      'not json',
      JSON.stringify({ score: 'seven' })
    ].join('\n')
  });

  assert.deepEqual(result, {
    records: [{ recordKind: 'summary', record: { score: 7, label: 'kept' } }],
    refused: [
      { reason: 'stdout line 2 could not be parsed as a JSON object' },
      { reason: 'field "score" is string, the experiment declared number' }
    ],
    dropped: 0
  });
});

test('typed artifact-glob inlines valid JSON with measured provenance and refuses malformed content', t => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-collectors-'));
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(artifactDir, 'nested'));
  fs.writeFileSync(path.join(artifactDir, 'nested', 'result.json'), JSON.stringify({ score: 9 }));
  fs.writeFileSync(path.join(artifactDir, 'nested', 'raw.json'), 'not-json');
  fs.writeFileSync(path.join(artifactDir, 'ignored.txt'), 'ignore me');

  const result = collect({
    collector: { kind: 'artifact-glob', pattern: '**/*.json', recordKind: 'measurement' },
    artifactDir,
    resultSchema: { fields: { score: 'number' }, required: ['score'] }
  });

  assert.equal(result.records.length, 1);
  const content = Buffer.from('{"score":9}');
  assert.deepEqual(result.records[0], {
    recordKind: 'measurement',
    record: { score: 9, artifactPath: 'nested/result.json', _toolsEnabledArtifact: {
      bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex')
    } },
    artifactPath: 'nested/result.json'
  });
  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0].reason, /nested\/raw.json.*could not be parsed.*required by its schema/);
  assert.equal(result.dropped, 0);
});

test('artifact-glob reports an unavailable read as unknown while preserving the absent-directory answer', t => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-collectors-reads-'));
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
  const originalReaddirSync = fs.readdirSync;
  try {
    fs.readdirSync = () => { throw Object.assign(new Error('device busy'), { code: 'EIO' }); };
    assert.throws(
      () => collect({ collector: { kind: 'artifact-glob', pattern: '**/*' }, artifactDir }),
      error => error instanceof CollectorError &&
        error.code === 'RESEARCH_COLLECTOR_ARTIFACTS_UNAVAILABLE' &&
        error.details.causeCode === 'EIO' &&
        /does NOT claim that any artifact is absent/.test(error.message)
    );

    // Control: ENOENT was the legitimate empty/absent result before this guard.
    fs.readdirSync = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    assert.deepEqual(
      collect({ collector: { kind: 'artifact-glob', pattern: '**/*' }, artifactDir }),
      { records: [], refused: [{ reason: 'artifact directory "." could not be read (ENOENT)' }], dropped: 0 }
    );
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
});

test('exported validation helpers report schema failures and reject upward traversal', () => {
  assert.deepEqual(
    schemaProblems({ count: '2' }, { fields: { count: 'number' }, required: ['name'] }),
    ['required field "name" is missing', 'field "count" is string, the experiment declared number']
  );
  assert.equal(globToRegExp('runs/?/*.json').test('runs/a/result.json'), true);
  assert.equal(globToRegExp('**/*.json').test('result.json'), true);
  assert.equal(globToRegExp('**/*.json').test('one/two/result.json'), true);
  assert.throws(
    () => globToRegExp('../secrets/*'),
    error => error instanceof CollectorError && error.code === 'RESEARCH_COLLECTOR_PATTERN_INVALID'
  );
});

test('collect returns no records for none and rejects unsupported collector kinds', () => {
  assert.deepEqual(collect({ collector: { kind: 'none' } }), { records: [], refused: [], dropped: 0 });
  assert.throws(
    () => collect({ collector: { kind: 'mystery' } }),
    error => error instanceof CollectorError && error.code === 'RESEARCH_COLLECTOR_UNSUPPORTED'
  );
});

function artifactFixture(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `research-collectors-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('unsupported schemas and non-finite JSON cannot silently weaken validation', () => {
  for (const resultSchema of [[], { fields: [] }, { fields: null }, { required: 'score' },
    { fields: { score: 'integer' } }, { fields: { score: 'number' }, minimum: 0 }, { additionalProperties: false }]) {
    assert.throws(() => collect({ collector: { kind: 'none' }, resultSchema }), error => error.code === 'RESEARCH_RESULT_SCHEMA_UNSUPPORTED');
  }
  for (const stdout of ['{"score":1e999}', '{"nested":[{"value":-1e999}]}']) {
    const collected = collect({ collector: { kind: 'stdout-json' }, stdout });
    assert.equal(collected.records.length, 0);
    assert.match(collected.refused[0].reason, /not a finite number/);
  }
  const optionalNull = collect({ collector: { kind: 'stdout-json' }, stdout: '{"score":null}', resultSchema: { fields: { score: 'number' } } });
  assert.equal(optionalNull.records.length, 0);
  assert.match(optionalNull.refused[0].reason, /is null/);
  const pretty = collect({ collector: { kind: 'stdout-json' }, stdout: '{\n  "score": 7,\n  "ok": true\n}', resultSchema: { fields: { score: 'number', ok: 'boolean' }, required: ['score'] } });
  assert.deepEqual(pretty.records, [{ recordKind: 'summary', record: { score: 7, ok: true } }]);
  assert.deepEqual(pretty.refused, []);
});

test('stdout limits explicitly report omitted records and count UTF-8 bytes', () => {
  const many = collect({ collector: { kind: 'stdout-json' }, stdout: Array.from({ length: MAX_RECORDS + 1 }, (_, n) => JSON.stringify({ n })).join('\n') });
  assert.equal(many.records.length, MAX_RECORDS);
  assert.equal(many.dropped, 1);
  const oversized = collect({ collector: { kind: 'stdout-json' }, stdout: JSON.stringify({ text: '€'.repeat(Math.ceil(MAX_RECORD_BYTES / 3)) }) });
  assert.equal(oversized.records.length, 0);
  assert.match(oversized.refused[0].reason, /exceeds.*bytes/);
});

test('large typed artifacts still validate their payload while untyped raw artifacts retain measured hashes', t => {
  const artifactDir = artifactFixture(t, 'typed');
  const valid = JSON.stringify({ score: 4, padding: 'x'.repeat(5000) });
  const invalid = JSON.stringify({ score: 'four', padding: 'x'.repeat(5000) });
  fs.writeFileSync(path.join(artifactDir, 'valid.json'), valid);
  fs.writeFileSync(path.join(artifactDir, 'invalid.json'), invalid);
  const typed = collect({ collector: { kind: 'artifact-glob', pattern: '**/*.json' }, artifactDir, resultSchema: { fields: { score: 'number' }, required: ['score'] } });
  assert.equal(typed.records.length, 1);
  assert.equal(typed.records[0].record.score, 4);
  assert.equal(typed.records[0].record.padding.length, 5000);
  assert.deepEqual(typed.records[0].record._toolsEnabledArtifact, {
    bytes: Buffer.byteLength(valid), sha256: crypto.createHash('sha256').update(valid).digest('hex')
  });
  assert.equal(typed.refused.length, 1);
  assert.match(typed.refused[0].reason, /invalid.json.*score.*string/);
  fs.writeFileSync(path.join(artifactDir, 'raw.bin'), Buffer.from([0, 1, 255, 4]));
  const raw = collect({ collector: { kind: 'artifact-glob', pattern: '*.bin' }, artifactDir, resultSchema: {} });
  const provenance = { bytes: 4, sha256: crypto.createHash('sha256').update(Buffer.from([0, 1, 255, 4])).digest('hex') };
  assert.deepEqual(raw.records, [{ recordKind: 'artifact', artifactPath: 'raw.bin', record: { artifactPath: 'raw.bin', ...provenance, _toolsEnabledArtifact: provenance } }]);
  assert.deepEqual(raw.refused, []);
});

test('typed artifacts refuse forged provenance, non-finite payloads, and oversize records', t => {
  const artifactDir = artifactFixture(t, 'provenance');
  const samples = {
    'path.json': '{"score":1,"artifactPath":"elsewhere.json"}',
    'hash.json': '{"score":1,"_toolsEnabledArtifact":{"sha256":"forged"}}',
    'infinite.json': '{"score":1e999}',
    'oversize.json': JSON.stringify({ score: 1, padding: 'x'.repeat(MAX_RECORD_BYTES) }),
    'null.json': 'null', 'array.json': '[{"score":1}]'
  };
  for (const [name, content] of Object.entries(samples)) fs.writeFileSync(path.join(artifactDir, name), content);
  const result = collect({ collector: { kind: 'artifact-glob', pattern: '*.json' }, artifactDir, resultSchema: { fields: { score: 'number' }, required: ['score'] } });
  assert.deepEqual(result.records, []);
  assert.equal(result.refused.length, Object.keys(samples).length);
  assert.ok(result.refused.some(entry => /reserved.*provenance/.test(entry.reason)));
  assert.ok(result.refused.some(entry => /typed record.*limit/.test(entry.reason)));
  assert.ok(result.refused.some(entry => /not a finite number/.test(entry.reason)));
});

test('artifact inspection refuses oversized or growing files without accepting a partial hash', t => {
  const artifactDir = artifactFixture(t, 'growth');
  const tooLarge = path.join(artifactDir, 'large.bin');
  fs.writeFileSync(tooLarge, '');
  fs.truncateSync(tooLarge, MAX_ARTIFACT_BYTES + 1);
  let result = collect({ collector: { kind: 'artifact-glob', pattern: '*.bin' }, artifactDir });
  assert.equal(result.records.length, 0);
  assert.match(result.refused[0].reason, /inspection limit.*incomplete/);
  const growing = path.join(artifactDir, 'growing.json');
  fs.writeFileSync(growing, '{"score":1}');
  const originalRead = fs.readSync;
  let reads = 0;
  try {
    fs.readSync = (...args) => {
      if (reads++ === 0) fs.appendFileSync(growing, ' ');
      return originalRead(...args);
    };
    result = collect({ collector: { kind: 'artifact-glob', pattern: '*.json' }, artifactDir, resultSchema: { fields: { score: 'number' } } });
  } finally { fs.readSync = originalRead; }
  assert.equal(result.records.length, 0);
  assert.match(result.refused[0].reason, /changed.*during inspection.*incomplete/);
});

test('directory-only scans and link traversal are explicitly incomplete, not empty success', t => {
  const fixtureDir = artifactFixture(t, 'scan');
  const artifactDir = path.join(fixtureDir, 'artifacts');
  const target = path.join(fixtureDir, 'target');
  fs.mkdirSync(artifactDir);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'result.json'), '{"score":1}');
  fs.symlinkSync(target, path.join(artifactDir, 'linked'), 'junction');
  const linked = collect({ collector: { kind: 'artifact-glob', pattern: '**/*.json' }, artifactDir });
  assert.equal(linked.records.length, 0);
  assert.match(linked.refused[0].reason, /link.*not followed/);
  assert.throws(() => collect({ collector: { kind: 'artifact-glob', pattern: '*.json' }, artifactDir: path.join(artifactDir, 'linked') }), error => error.code === 'RESEARCH_COLLECTOR_PATTERN_INVALID');
  const originalReaddir = fs.readdirSync;
  try {
    fs.readdirSync = () => Array.from({ length: MAX_ARTIFACT_ENTRIES + 1 }, (_, index) => ({
      name: `empty-${index}`, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false
    }));
    const bounded = collect({ collector: { kind: 'artifact-glob', pattern: '**/*.json' }, artifactDir });
    assert.equal(bounded.records.length, 0);
    assert.match(bounded.refused[0].reason, /inspection limit.*incomplete/);
  } finally { fs.readdirSync = originalReaddir; }
});
