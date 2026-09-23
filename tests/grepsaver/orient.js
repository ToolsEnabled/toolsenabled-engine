#!/usr/bin/env node
'use strict';

// Proves the product contract against the real generated card index, rather
// than a hand-picked fixture: every carded topic must execute the CLI route and
// receive its own card, at least one router line, and at least one usable tool
// namespace.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ORIENT = path.join(ROOT, 'tools', 'grepsaver-orient.js');

function orient(systemId, env = process.env) {
  return JSON.parse(execFileSync(process.execPath, [ORIENT, '--json', systemId], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env,
  }));
}

// systems.json is intentionally ignored per-machine output. Prove that a fresh
// clone can orient from its cards without owner/machine corpus or a hidden
// source-tree write.  The fixture is deliberately complete enough to exercise
// every router input, while all paths and facts remain disposable.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grepsaver-orient-'));
const fixtureContext = path.join(fixtureRoot, 'context');
fs.mkdirSync(fixtureContext);
const fixtureSystems = [
  { id: 'alpha-service', namespace: 'alpha' },
  { id: 'beta-worker', namespace: 'beta' },
];
let assertions = 0;
try {
  for (const system of fixtureSystems) {
    const target = path.join(fixtureRoot, system.id);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'marker.txt'), system.id);
    fs.writeFileSync(path.join(fixtureContext, `${system.id}.md`), [
      '---',
      `system: ${system.id}`,
      `source_path: ${target}`,
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
      '',
    ].join('\n'));
  }
  fs.writeFileSync(path.join(fixtureContext, 'DOCS.md'), fixtureSystems
    .map(system => `- ${system.id} routing guide: docs/${system.id}.md`)
    .join('\n') + '\n');
  fs.writeFileSync(path.join(fixtureContext, 'toolsenabled-tools.md'), fixtureSystems
    .map(system => `## ${system.namespace} (1)\n- \`${system.namespace}.inspect\` - inspect ${system.id}\n`)
    .join('\n'));

  const systemsFile = path.join(fixtureContext, 'systems.json');
  assert.equal(fs.existsSync(systemsFile), false, 'fixture starts without the ignored per-machine index'); assertions++;
  for (const system of fixtureSystems) {
    const packet = orient(system.id, { ...process.env, TOOLSENABLED_GREPSAVER_CONTEXT: fixtureContext });
    const card = packet.cards.find((entry) => entry.id === system.id);

    assert.equal(packet.schemaVersion, 'grepsaver-orientation-v1', `${system.id}: packet schema`); assertions++;
    assert.equal(packet.query, system.id, `${system.id}: query echo`); assertions++;
    assert.equal(packet.index.source, 'generated-in-memory', `${system.id}: missing index derives cards in memory`); assertions++;
    assert.equal(packet.coverage.state, 'matched', `${system.id}: carded topic must match`); assertions++;
    assert.ok(card, `${system.id}: returns its own card`); assertions++;
    assert.equal(card.card, `context/${system.id}.md`, `${system.id}: canonical card route`); assertions++;
    assert.ok(Array.isArray(card.outline), `${system.id}: card outline is shaped`); assertions++;
    assert.ok(packet.docRouter.length > 0 && packet.docRouter.every((line) => typeof line === 'string'), `${system.id}: relevant docs route`); assertions++;
    assert.ok(packet.toolNamespaces.some((entry) => entry.namespace === system.namespace && entry.toolCount === 1), `${system.id}: tool namespace route`); assertions++;
    assert.equal(packet.measurement.unit, 'bytes', `${system.id}: measurement unit`); assertions++;
  }
  assert.equal(fs.existsSync(systemsFile), false, 'in-memory orientation never writes systems.json'); assertions++;
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 });
}

process.stdout.write(`grepsaver orient tests passed (${assertions} assertions across ${fixtureSystems.length} disposable carded topics).\n`);
