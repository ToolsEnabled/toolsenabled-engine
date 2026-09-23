'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const forms = require('../src/lib/owner-form-contract');

// A refusal here must remain a side-effect-free lookup failure: callers must
// not accidentally turn an unknown public form identifier into an attempted
// prompt launch or persistence operation.
const sideEffects = [];
const guardedMethods = [
  [childProcess, 'exec'],
  [childProcess, 'execFile'],
  [childProcess, 'execFileSync'],
  [childProcess, 'execSync'],
  [childProcess, 'fork'],
  [childProcess, 'spawn'],
  [childProcess, 'spawnSync'],
  [fs, 'appendFile'],
  [fs, 'appendFileSync'],
  [fs, 'createWriteStream'],
  [fs, 'write'],
  [fs, 'writeFile'],
  [fs, 'writeFileSync'],
  [fs, 'writeSync']
];
const originals = guardedMethods.map(([owner, method]) => [owner, method, owner[method]]);
for (const [owner, method] of guardedMethods) {
  owner[method] = (...args) => {
    sideEffects.push({ method, args });
    throw new Error(`Unexpected side effect through ${method}`);
  };
}

try {
  for (const drive of [
    ['form', () => forms.form('not_a_registered_form')],
    ['describe', () => forms.describe('not_a_registered_form')],
    ['assertAcknowledgement', () => forms.assertAcknowledgement('not_a_registered_form', {})]
  ]) {
    assert.throws(drive[1], error => {
      assert.equal(error.code, 'OWNER_FORM_UNAVAILABLE', `${drive[0]} refusal code`);
      assert.equal(error.message, 'The requested owner form is unavailable.', `${drive[0]} refusal message`);
      return true;
    });
  }
  assert.deepEqual(sideEffects, [], 'unknown forms must not write or spawn');
} finally {
  for (const [owner, method, original] of originals) owner[method] = original;
}

for (const formId of ['credential_value', 'payment_card_default']) {
  const description = forms.describe(formId);
  assert.equal(description.formId, formId);
  assert.ok(description.fields.length >= 1);
  for (const field of description.fields) {
    assert.equal(field.required, true);
    assert.ok(field.instruction.length > 0);
    assert.ok(field.format.length > 0);
    assert.ok(field.example.length > 0);
  }
  assert.deepEqual(forms.assertAcknowledgement(formId, description.acknowledgement), description.acknowledgement);
}
const paymentDescription = forms.describe('payment_card_default');
assert.throws(() => forms.assertAcknowledgement('payment_card_default', { ...paymentDescription.acknowledgement, contractHash: '0'.repeat(64) }), error => error.code === 'OWNER_FORM_GUIDANCE_REQUIRED');
assert.throws(() => forms.assertAcknowledgement('payment_card_default', {
  ...paymentDescription.acknowledgement,
  fieldIds: ['given_name,family_name', ...paymentDescription.acknowledgement.fieldIds.slice(2)]
}), error => error.code === 'OWNER_FORM_GUIDANCE_REQUIRED');
assert.throws(() => forms.compileForm({ formId: 'bad', contractVersion: 1, title: 'x', description: 'x', fields: [{ id: 'id', label: 'x', format: 'x', example: 'x', required: true }] }), error => error.code === 'OWNER_FORM_CONTRACT_INVALID');
process.stdout.write('Owner form contract tests passed.\n');
