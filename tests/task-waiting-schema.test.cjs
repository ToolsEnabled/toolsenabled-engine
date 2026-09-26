'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const engineRoot = process.env.T850_ENGINE_ROOT || path.resolve(__dirname, '..');
const registryRoot = process.env.T850_REGISTRY_ROOT || path.resolve(__dirname, '..');
const registryPath = path.join(registryRoot, 'src', 'lib', 'tool-registry.js');
const schemaValidator = require(path.join(engineRoot, 'src', 'lib', 'schema-validator.js'));

function balancedCall(source, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('t_ledger.progress schema call is unbalanced');
}

function progressSchema() {
  const source = fs.readFileSync(registryPath, 'utf8');
  const defineStart = source.indexOf("define('t_ledger.progress'");
  assert.notEqual(defineStart, -1, 'the progress tool must remain registered');
  const schemaStart = source.indexOf('schema({', defineStart);
  assert.notEqual(schemaStart, -1, 'the progress tool must expose an input schema');
  const expression = balancedCall(source, schemaStart);
  return vm.runInNewContext(`(${expression})`, {
    schema: (properties, required) => ({
      type: 'object',
      additionalProperties: false,
      properties,
      required
    }),
    ledgerActor: { type: 'string', minLength: 1 },
    choice: (enumValues, description) => ({ type: 'string', enum: enumValues, description })
  });
}

test('t_ledger.progress validates the optional waitingFor array at the tool boundary', () => {
  const schema = progressSchema();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Array.from(schema.required), ['actor', 'id', 'status', 'reason']);
  assert.equal(schema.properties.waitingFor.type, 'array');
  assert.equal(schema.properties.waitingFor.maxItems, 16);
  assert.equal(schema.properties.waitingFor.uniqueItems, true);
  assert.deepEqual(schemaValidator.assertValid(schema, {
    actor: 'codex',
    id: 'T1',
    status: 'in-progress',
    reason: 'synthetic schema control'
  }).id, 'T1');
  assert.deepEqual(schemaValidator.assertValid(schema, {
    actor: 'codex',
    id: 'T1',
    status: 'in-progress',
    reason: 'synthetic schema wait',
    waitingFor: ['T2', 'T10']
  }).waitingFor, ['T2', 'T10']);
  assert.throws(() => schemaValidator.assertValid(schema, {
    actor: 'codex',
    id: 'T1',
    status: 'in-progress',
    reason: 'duplicate wait',
    waitingFor: ['T2', 'T2']
  }));
  assert.throws(() => schemaValidator.assertValid(schema, {
    actor: 'codex',
    id: 'T1',
    status: 'in-progress',
    reason: 'too many waits',
    waitingFor: Array.from({ length: 17 }, (_, index) => `T${index + 2}`)
  }));
  assert.throws(() => schemaValidator.assertValid(schema, {
    actor: 'codex',
    id: 'T1',
    status: 'in-progress',
    reason: 'unknown property',
    unexpected: true
  }));
});
