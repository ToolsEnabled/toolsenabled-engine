'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { collectPackageRecords } = require('../tools/package-check');

const ROOT = path.resolve(__dirname, '..');
const PROVIDER_IDS = [
  'providers.chrome-web-store', 'providers.billing',
  'providers.gateway', 'providers.github', 'providers.google.suite',
  'providers.infrastructure', 'providers.iphone.handoff', 'providers.launch',
  'providers.messaging', 'providers.misc', 'providers.research',
  'providers.sandbox', 'providers.video', 'providers.web'
];
const REQUIRED_HEADINGS = [
  '## Purpose', '## Public API', '## Allowed dependencies', '## Action classes',
  '## Must not do', '## Verification'
];

// Collect every omission and fail once with the full list.  Asserting inside
// the loop made this suite stop at the first stale charter, so its output
// measured how far it got rather than how much was wrong.
const findings = [];
const record = message => { findings.push(message); };
const check = (condition, message) => { if (!condition) record(message); };

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'packages.json'), 'utf8'));
const owner = new Map(manifest.packages.flatMap(entry => entry.files.map(file => [file, entry.id])));
const manifestIds = new Set(manifest.packages.map(entry => entry.id));
const observed = new Map(PROVIDER_IDS.map(id => [id, new Set()]));
for (const edge of collectPackageRecords(ROOT).requireEdges) {
  const from = owner.get(edge.from);
  const to = owner.get(edge.to);
  if (from && to && from !== to && observed.has(from)) observed.get(from).add(to);
}

for (const id of PROVIDER_IDS) {
  check(manifestIds.has(id), `${id} is not a current Q46 package family`);
  const charterPath = path.join(ROOT, 'packages', id, 'PACKAGE.md');
  if (!fs.existsSync(charterPath)) {
    record(`${id} charter is missing`);
    continue;
  }
  const text = fs.readFileSync(charterPath, 'utf8');
  check(Buffer.byteLength(text) <= 2048, `${id} charter exceeds 2 KB (${Buffer.byteLength(text)} bytes)`);
  for (const heading of REQUIRED_HEADINGS) {
    check(new RegExp(`^${heading}$`, 'm').test(text), `${id} missing ${heading}`);
  }
  for (const dependency of observed.get(id)) {
    const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    check(new RegExp('`' + escaped + '`').test(text), `${id} omits Q46-observed dependency ${dependency}`);
  }
}

if (findings.length) {
  for (const finding of findings) console.error(`- ${finding}`);
  assert.fail(`${findings.length} provider charter omission(s); the full list is printed above:\n${findings.map(finding => `  - ${finding}`).join('\n')}`);
}

console.log('Q49 provider-family charters are bounded and corroborated by current Q46 require edges.');
