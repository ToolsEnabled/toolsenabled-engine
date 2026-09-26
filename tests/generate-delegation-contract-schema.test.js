'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE = path.join(__dirname, '..', 'tools', 'generate-delegation-contract-schema.js');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-schema-generator-'));
const tool = path.join(fixture, 'tools', path.basename(SOURCE));
const output = path.join(fixture, 'schemas', 'generated', 'delegation-contracts.schema.json');

function run(...args) {
  return spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
}

function assertRefused(result, message) {
  assert.equal(result.status, 1, `refusal must use exit code 1: ${message}`);
  assert.match(result.stderr, new RegExp(message));
  assert.equal(result.stdout, '');
}

try {
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'src', 'lib'), { recursive: true });
  fs.copyFileSync(SOURCE, tool);
  fs.writeFileSync(path.join(fixture, 'src', 'lib', 'delegation-contracts.js'), [
    "'use strict';",
    "module.exports.schemaDocument = () => ({ zebra: 2, alpha: { delta: 4, beta: 3 } });",
    ''
  ].join('\n'));

  const generated = run();
  assert.equal(generated.status, 0, 'generation must use exit code 0');
  assert.equal(generated.stderr, '');
  assert.equal(generated.stdout, 'Delegation contract schema generated.\n');
  assert.equal(fs.readFileSync(output, 'utf8'), [
    '{',
    '  "alpha": {',
    '    "beta": 3,',
    '    "delta": 4',
    '  },',
    '  "zebra": 2',
    '}',
    ''
  ].join('\n'));

  const verified = run('--check');
  assert.equal(verified.status, 0, 'a current schema check must use exit code 0');
  assert.equal(verified.stderr, '');
  assert.equal(verified.stdout, 'Delegation contract schema verified.\n');

  assertRefused(run('--write'), 'only --check is supported');
  assertRefused(run('--check', '--write'), 'only --check is supported');

  fs.writeFileSync(output, '{"stale":true}\n');
  assertRefused(run('--check'), 'delegation contract schema is stale');

  fs.rmSync(output);
  assertRefused(run('--check'), 'delegation contract schema is stale');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
