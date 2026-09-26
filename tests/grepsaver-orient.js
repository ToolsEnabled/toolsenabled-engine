// Tests for the GREPSAVER orientation capability.
// Deterministic and offline: no MCP server, no provider, no network.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// systems.json is intentionally per-machine generated output. Build a complete
// customer-neutral card corpus in disposable storage before loading the module,
// then prove the shipped in-memory fallback rather than importing a builder's
// ignored context index.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grepsaver-orient-unit-'));
const fixtureContext = path.join(fixtureRoot, 'context');
fs.mkdirSync(fixtureContext);
for (const system of [
  { id: 'alpha-service', namespace: 'alpha' },
  { id: 'beta-worker', namespace: 'beta' }
]) {
  const source = path.join(fixtureRoot, system.id);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'marker.txt'), `${system.id}\n`, 'utf8');
  fs.writeFileSync(path.join(fixtureContext, `${system.id}.md`), [
    '---',
    `system: ${system.id}`,
    `source_path: ${source}`,
    'fingerprint: manifest-hash:sha256:fixture',
    'fingerprint_type: manifest',
    'manifest:',
    '  - marker.txt',
    'generated: 2026-01-01',
    'reviewed_on: PENDING',
    'generator: grepsaver-orient-test',
    '---',
    `# ${system.id}`,
    '',
    '## Entry points',
    `- \`${system.id}/index.js\` is the fixture entry point.`,
    ''
  ].join('\n'), 'utf8');
}
fs.writeFileSync(path.join(fixtureContext, 'DOCS.md'), [
  '# Documentation Router',
  '- alpha-service routing guide: docs/alpha-service.md',
  '- beta-worker routing guide: docs/beta-worker.md',
  '## Anti-routes',
  '- Do not treat orientation maps as runtime authority.',
  ''
].join('\n'), 'utf8');
fs.writeFileSync(path.join(fixtureContext, 'toolsenabled-tools.md'), [
  '## alpha (1)',
  '- `alpha.inspect` - inspect alpha-service',
  '## beta (1)',
  '- `beta.inspect` - inspect beta-worker',
  ''
].join('\n'), 'utf8');

const previousContext = process.env.TOOLSENABLED_GREPSAVER_CONTEXT;
process.env.TOOLSENABLED_GREPSAVER_CONTEXT = fixtureContext;
const { orient, renderMarkdown, tokenize, outlineCard } = require('../tools/grepsaver-orient');

let checks = 0;
const check = (label, fn) => {
  fn();
  checks += 1;
  void label;
};

// --- tokenize ---------------------------------------------------------------

check('tokenize drops stopwords and single characters', () => {
  assert.deepStrictEqual(tokenize('What is the a b durable worker'), ['durable', 'worker']);
});

check('tokenize splits on punctuation and lowercases', () => {
  assert.deepStrictEqual(tokenize('Provider/Release-Gate'), ['provider', 'release', 'gate']);
});

check('tokenize returns empty for a query with no searchable terms', () => {
  assert.deepStrictEqual(tokenize('the a is of'), []);
});

// --- outlineCard ------------------------------------------------------------

check('outlineCard keeps headings and load-bearing bullets, drops prose', () => {
  const outline = outlineCard([
    '# Example card',
    '',
    'This is ordinary prose that should not survive.',
    '## Entry points',
    '- `server/index.js` is the entry point.',
    '- it just explains something with no path',
    ''
  ].join('\n'));
  assert.ok(outline.includes('# Example card'));
  assert.ok(outline.includes('## Entry points'));
  assert.ok(outline.some(line => line.includes('server/index.js')));
  assert.ok(!outline.some(line => line.includes('ordinary prose')));
  assert.ok(!outline.some(line => line.includes('no path')));
});

check('outlineCard never emits a secret-shaped line', () => {
  const outline = outlineCard([
    '## Keys',
    '- token is `ghp_abcdefghijklmnopqrstuvwxyz0123456789` in config.json',
    '- `safe.js` is the entry point.'
  ].join('\n'));
  assert.ok(!outline.some(line => line.includes('ghp_')), 'secret-shaped bullet must be dropped');
  assert.ok(outline.some(line => line.includes('safe.js')), 'non-secret bullet must survive');
});

check('outlineCard is bounded', () => {
  const many = Array.from({ length: 200 }, (_, index) => `## Heading ${index}`).join('\n');
  assert.ok(outlineCard(many).length <= 24);
});

check('outlineCard tolerates an absent card', () => {
  assert.deepStrictEqual(outlineCard(null), []);
});

// --- orient -----------------------------------------------------------------

check('orient rejects a query with no searchable terms', () => {
  assert.throws(() => orient('the a of is'), error => error.code === 'GREPSAVER_ORIENT_EMPTY_QUERY');
});

check('orient returns a versioned, explicitly untrusted packet', () => {
  const packet = orient('alpha-service');
  assert.strictEqual(packet.schemaVersion, 'grepsaver-orientation-v1');
  assert.strictEqual(packet.contentTrust, 'untrusted');
  assert.match(packet.trust, /maps, not authority/);
  assert.strictEqual(packet.index.source, 'generated-in-memory');
  assert.strictEqual(fs.existsSync(path.join(fixtureContext, 'systems.json')), false,
    'the in-memory fallback must not write a hidden fixture');
});

check('orient ranks the system named in the query first', () => {
  const packet = orient('alpha-service');
  assert.ok(packet.cards.length > 0, 'the alpha-service card must match its own name');
  assert.strictEqual(packet.cards[0].id, 'alpha-service');
});

check('orient surfaces card freshness rather than smoothing it over', () => {
  const packet = orient('alpha-service');
  const card = packet.cards[0];
  assert.ok(typeof card.status === 'string' && card.status.length > 0);
  assert.ok(Object.prototype.hasOwnProperty.call(card, 'staleSince'));
});

check('orient honours the result limit', () => {
  const packet = orient('alpha service beta worker', { limit: 1 });
  assert.strictEqual(packet.cards.length, 1);
});

check('orient clamps an absurd limit instead of trusting it', () => {
  const packet = orient('alpha service beta worker', { limit: 9999 });
  assert.ok(packet.cards.length <= 10);
});

check('orient reports a coverage gap instead of returning a weak match', () => {
  const packet = orient('zzzqqqxxx nonexistentsystemname');
  assert.strictEqual(packet.cards.length, 0);
  assert.strictEqual(packet.coverage.state, 'no-carded-system-matched');
  assert.match(packet.coverage.advice, /uncarded/);
});

check('orient measures in bytes and refuses to call them tokens', () => {
  const packet = orient('alpha-service');
  assert.strictEqual(packet.measurement.unit, 'bytes');
  assert.ok(packet.measurement.returnedBytes > 0);
  assert.ok(packet.measurement.sourceBytesAvoidedUpperBound >= 0);
  assert.match(packet.measurement.note, /not a token or cost saving/);
  // The whole packet must never assert a token saving anywhere.
  assert.ok(!/tokens? saved/i.test(JSON.stringify(packet)));
});

check('orient carries the doc-router anti-routes so known token wasters are visible', () => {
  const packet = orient('alpha-service');
  assert.ok(Array.isArray(packet.antiRoutes));
  assert.ok(packet.antiRoutes.length > 0, 'the doc router defines anti-routes; they must reach the packet');
});

check('orient matches tool namespaces from the generated digest', () => {
  const packet = orient('alpha verification');
  assert.ok(Array.isArray(packet.toolNamespaces));
  assert.ok(packet.toolNamespaces.some(entry => entry.namespace === 'alpha'), 'the alpha namespace must match an alpha query');
  for (const entry of packet.toolNamespaces) {
    assert.ok(Number.isInteger(entry.toolCount) && entry.toolCount > 0);
  }
});

check('orient never emits a secret-shaped string anywhere in the packet', () => {
  const serialized = JSON.stringify(orient('alpha-service vault secrets'));
  for (const pattern of [/sk_live_/, /ghp_[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{20,}/, /BEGIN [A-Z ]*PRIVATE KEY/]) {
    assert.ok(!pattern.test(serialized), `packet must not contain ${pattern}`);
  }
});

// --- renderMarkdown ---------------------------------------------------------

check('renderMarkdown produces the trust note and a byte-labelled measurement', () => {
  const text = renderMarkdown(orient('alpha-service'));
  assert.match(text, /# Orientation: alpha-service/);
  assert.match(text, /maps, not authority/);
  assert.match(text, /Bytes, not tokens/);
});

check('renderMarkdown states the coverage gap when nothing matched', () => {
  const text = renderMarkdown(orient('zzzqqqxxx nonexistentsystemname'));
  assert.match(text, /No carded system matched/);
});

check('a corrupt generated index is refused instead of silently replaced', () => {
  const systemsPath = path.join(fixtureContext, 'systems.json');
  fs.writeFileSync(systemsPath, '{ not json', 'utf8');
  try {
    assert.throws(() => orient('alpha-service'), error => error.code === 'GREPSAVER_SYSTEMS_INDEX_INVALID');
  } finally {
    fs.unlinkSync(systemsPath);
  }
});

if (previousContext === undefined) delete process.env.TOOLSENABLED_GREPSAVER_CONTEXT;
else process.env.TOOLSENABLED_GREPSAVER_CONTEXT = previousContext;
fs.rmSync(fixtureRoot, { recursive: true, force: true });

console.log(`GREPSAVER orientation tests passed (${checks} assertions).`);
