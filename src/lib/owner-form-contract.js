'use strict';

// Owner-input forms are a UI contract, not an invitation to collect values in
// chat. Every field must tell the owner what belongs there, the expected
// format, and an example or unambiguous placeholder. Agents receive this
// public contract and must acknowledge its exact field set before a sensitive
// prompt opens; values never appear in the contract or acknowledgement.
const crypto = require('node:crypto');

function fail(message) {
  const error = new Error(message);
  error.code = 'OWNER_FORM_CONTRACT_INVALID';
  throw error;
}

function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = frozenCopy(item);
    return Object.freeze(out);
  }
  return value;
}

function nonBlank(value, name, max = 400) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > max) fail(`Owner form ${name} must be a bounded non-empty string.`);
  return value.trim();
}

function compileForm(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('Owner form specification must be an object.');
  const formId = nonBlank(spec.formId, 'formId', 100);
  if (!/^[a-z][a-z0-9_]{2,99}$/.test(formId)) fail('Owner form formId is invalid.');
  if (!Number.isSafeInteger(spec.contractVersion) || spec.contractVersion < 1 || spec.contractVersion > 99) fail('Owner form contractVersion is invalid.');
  const title = nonBlank(spec.title, 'title', 160);
  const description = nonBlank(spec.description, 'description', 800);
  if (!Array.isArray(spec.fields) || spec.fields.length < 1 || spec.fields.length > 24) fail('Owner form fields are invalid.');
  const seen = new Set();
  const fields = spec.fields.map((field, index) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) fail('Owner form field is invalid.');
    const id = nonBlank(field.id, `fields[${index}].id`, 80);
    if (!/^[a-z][a-z0-9_]{1,79}$/.test(id) || seen.has(id)) fail('Owner form field id is invalid.');
    seen.add(id);
    return Object.freeze({
      id,
      label: nonBlank(field.label, `fields[${index}].label`, 160),
      instruction: nonBlank(field.instruction, `fields[${index}].instruction`, 400),
      format: nonBlank(field.format, `fields[${index}].format`, 160),
      example: nonBlank(field.example, `fields[${index}].example`, 160),
      sensitive: field.sensitive === true,
      required: field.required === true
    });
  });
  if (fields.some(field => !field.required || !field.instruction || !field.format || !field.example)) fail('Each owner form field requires instruction, format, example, and required=true.');
  return Object.freeze({ formId, contractVersion: spec.contractVersion, title, description, fields: Object.freeze(fields) });
}

const FORMS = Object.freeze({
  credential_value: compileForm({
    formId: 'credential_value',
    contractVersion: 1,
    title: 'ToolsEnabled credential entry',
    description: 'This local form stores one requested credential directly in the encrypted owner vault. The value is not returned to agents, MCP results, logs, reports, or source files.',
    fields: [
      { id: 'credential_value', label: 'Credential value', instruction: 'Paste or type the complete value requested by the visible credential label. Do not add surrounding quotes or explanatory text.', format: 'The exact credential value for the named service', example: 'Paste the complete value from its trusted provider page', sensitive: true, required: true }
    ]
  }),
  payment_card_default: compileForm({
    formId: 'payment_card_default',
    // Version 2: the security-code field left the form. The acknowledgement
    // hash covers formId, contractVersion and fieldIds, so an acknowledgement
    // recorded against the six-field version 1 no longer verifies -- which is
    // correct: an agent holding one would tell the owner to expect a field the
    // window no longer has. src/lib/tool-registry.js's payment_method.card_register
    // schema names the same version and field count; the two move together.
    contractVersion: 2,
    title: 'ToolsEnabled payment method',
    // The same facts the window itself states, so an agent reading the public
    // contract cannot describe this form to the owner more favourably than the
    // window does: WHO can decrypt the record afterwards, that nothing in the
    // product reads it yet, and that the card's security code is not asked for
    // and never stored (owner ruling Q-O4; PCI DSS 3.2 -- see the record-shape
    // comment above Invoke-PaymentCardPrompt in tools/secrets.ps1). The
    // acknowledgement hash covers formId, contractVersion and fieldIds only, so
    // wording can be corrected here without invalidating every caller's stored
    // acknowledgement.
    description: 'This local form keeps payment values out of agent context. '
      + (process.platform === 'linux'
        ? 'The record is sealed in the encrypted owner vault backed by the persistent GNOME/libsecret keyring. Other software with access to that unlocked owner keyring can ask it to open the record. '
        : 'The record is sealed with Windows DPAPI in the local vault on this computer, so any program running under the owner\'s Windows sign-in can ask Windows to open it. ')
      + 'The card\'s security code is not asked for by this form and is never stored anywhere; a purchase asks the owner for it at the moment of spend and discards it. Nothing in ToolsEnabled reads this record yet: storing a card here does not by itself enable a purchase. When available, names are pre-filled from the encrypted owner identity profile. Confirm they match the card, or enter the names manually when no usable profile is available.',
    fields: [
      { id: 'given_name', label: 'First / given name', instruction: 'Confirm the pre-filled given name matches the card, or enter it if blank.', format: 'Name text', example: 'Name on the card; pre-filled when available', sensitive: true, required: true },
      { id: 'family_name', label: 'Last / family name', instruction: 'Confirm the pre-filled family name matches the card, or enter it if blank.', format: 'Name text', example: 'Name on the card; pre-filled when available', sensitive: true, required: true },
      { id: 'card_number', label: 'Card number', instruction: 'Enter the card number from the physical card; spaces are accepted.', format: '12–19 digits', example: '1234 5678 9012 3456', sensitive: true, required: true },
      { id: 'expiration', label: 'Expiration', instruction: 'Enter the expiration with a slash between month and year.', format: 'MM/YY', example: '12/29', sensitive: true, required: true },
      { id: 'postal_code', label: 'Billing postal code', instruction: 'Use the postal code on record with the card issuer.', format: 'Issuer billing postal code', example: 'Your billing ZIP or postal code', sensitive: true, required: true }
    ]
  })
});

function form(formId) {
  if (typeof formId !== 'string' || !Object.prototype.hasOwnProperty.call(FORMS, formId)) {
    const error = new Error('The requested owner form is unavailable.');
    error.code = 'OWNER_FORM_UNAVAILABLE';
    throw error;
  }
  return FORMS[formId];
}

function acknowledgementFor(spec) {
  const fieldIds = spec.fields.map(field => field.id);
  const canonical = JSON.stringify({ formId: spec.formId, contractVersion: spec.contractVersion, fieldIds });
  return Object.freeze({
    formId: spec.formId,
    contractVersion: spec.contractVersion,
    fieldIds: Object.freeze(fieldIds),
    contractHash: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
  });
}

function describe(formId) {
  const spec = form(formId);
  return frozenCopy({ ...spec, acknowledgement: acknowledgementFor(spec) });
}

function assertAcknowledgement(formId, acknowledgement) {
  const expected = acknowledgementFor(form(formId));
  if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)
      || acknowledgement.formId !== expected.formId || acknowledgement.contractVersion !== expected.contractVersion
      || acknowledgement.contractHash !== expected.contractHash || !Array.isArray(acknowledgement.fieldIds)
      || acknowledgement.fieldIds.length !== expected.fieldIds.length
      || acknowledgement.fieldIds.some((fieldId, index) => fieldId !== expected.fieldIds[index])) {
    const error = new Error('Read the owner form guidance and pass its exact acknowledgement before opening this form.');
    error.code = 'OWNER_FORM_GUIDANCE_REQUIRED';
    throw error;
  }
  return expected;
}

module.exports = Object.freeze({ FORMS, acknowledgementFor, assertAcknowledgement, compileForm, describe, form });
