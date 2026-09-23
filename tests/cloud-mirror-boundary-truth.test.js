'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BOUNDARY_PATH = path.join(ROOT, 'config', 'cloud-mirror-boundary.json');
const AGENT_ORG_PATH = path.join(ROOT, 'config', 'agent-org.json');
const AGENT_ORG_EXAMPLE_PATH = path.join(ROOT, 'config', 'agent-org.example.json');
const AGENT_ORG_RELATIVE = 'config/agent-org.json';
const cloudMirror = require('../src/lib/cloud-agent/cloud-mirror');

const boundary = cloudMirror.loadBoundary(BOUNDARY_PATH);
const verdict = cloudMirror.classifyForMirror(AGENT_ORG_RELATIVE, boundary);

assert.equal(verdict.klass, 'mirror',
  'the real Cloud Mirror boundary must select the shipped neutral agent org');
assert.equal(boundary.withhold.paths.includes(AGENT_ORG_RELATIVE), false,
  'the real Cloud Mirror boundary must not withhold config/agent-org.json by exact path');
assert.equal(boundary.withhold.prefixes.some(prefix => AGENT_ORG_RELATIVE.startsWith(prefix)), false,
  'the real Cloud Mirror boundary must not withhold config/agent-org.json by prefix');

const selection = cloudMirror.selectMirrorEntries([{
  path: AGENT_ORG_RELATIVE,
  mode: '100644',
  type: 'blob',
  oid: 'a'.repeat(40),
  size: fs.statSync(AGENT_ORG_PATH).size
}], boundary);
assert.deepEqual(selection.withheld, [],
  'the real selection must not put config/agent-org.json in the withheld set');
assert.deepEqual(selection.unclassified, [],
  'the real selection must classify config/agent-org.json explicitly');
assert.equal(selection.included.length, 1,
  'the real selection must include config/agent-org.json in the mirrored snapshot');

function productShape(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { $comment, ...shape } = parsed;
  return shape;
}

assert.deepEqual(productShape(AGENT_ORG_PATH), productShape(AGENT_ORG_EXAMPLE_PATH),
  'the mirrored config/agent-org.json must match the neutral product example');

console.log('cloud mirror boundary truth gate passed (neutral agent org selected, not withheld)');
