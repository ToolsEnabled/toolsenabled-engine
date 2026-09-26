'use strict';

// Public, data-only action API contract. This module has no runtime imports or
// side effects; the desktop's browser copy is generated from these exact bytes.
// API versions are not product release labels or FRA transport versions.
const BRIDGE_API_NAME = 'toolsenabled.mission-bridge';
const BRIDGE_API_MAJOR = 1;
const BRIDGE_API_MINOR = 0;

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const BRIDGE_API_CONTRACT_SCHEMA = freeze({
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'api', 'actions', 'capabilityMeaning', 'automaticWriteRetry'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    api: {
      type: 'object', additionalProperties: false, required: ['name', 'major', 'minor'],
      properties: {
        name: { type: 'string', enum: [BRIDGE_API_NAME] },
        major: { type: 'integer', minimum: 1, maximum: 1000000 },
        minor: { type: 'integer', minimum: 0, maximum: 1000000 },
      },
    },
    actions: {
      type: 'array', minItems: 1, maxItems: 256, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' },
    },
    capabilityMeaning: { type: 'string', enum: ['registered-not-authorized-or-ready'] },
    automaticWriteRetry: { type: 'string', enum: ['never'] },
  },
});

// The wire validator reads the schema above, rather than restating its fields
// in a second handwritten validator. The schema is fixed and closed; this is
// not a public general-purpose JSON Schema implementation.
function matches(schema, value) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'integer') return Number.isSafeInteger(value)
    && (schema.minimum === undefined || value >= schema.minimum)
    && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'string') return typeof value === 'string'
    && (schema.minLength === undefined || value.length >= schema.minLength)
    && (schema.maxLength === undefined || value.length <= schema.maxLength)
    && (schema.pattern === undefined || new RegExp(schema.pattern).test(value));
  if (schema.type === 'array') {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || value.length < schema.minItems || value.length > schema.maxItems) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      const item = descriptors[String(index)];
      if (!item || !Object.hasOwn(item, 'value') || !matches(schema.items, item.value)) return false;
    }
    return !schema.uniqueItems || new Set(value).size === value.length;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return schema.required.every(key => Object.hasOwn(descriptors, key))
      && Reflect.ownKeys(descriptors).every(key => typeof key === 'string'
        && Object.hasOwn(schema.properties, key) && Object.hasOwn(descriptors[key], 'value')
        && matches(schema.properties[key], descriptors[key].value));
  }
  throw new TypeError('The action API contract schema contains an unsupported type.');
}

function validateBridgeApiContract(value) {
  return matches(BRIDGE_API_CONTRACT_SCHEMA, value);
}

function createBridgeApiContract(routes) {
  if (!routes || typeof routes !== 'object' || Array.isArray(routes)) {
    throw new TypeError('The actual bridge action route table is required.');
  }
  const prefix = `/v${BRIDGE_API_MAJOR}/actions/`;
  const keys = Object.keys(routes);
  if (keys.some(route => !route.startsWith(prefix) || typeof routes[route] !== 'string' || !routes[route])) {
    throw new TypeError('The bridge action route table does not match the declared API major version.');
  }
  const descriptor = {
    schemaVersion: 1,
    api: { name: BRIDGE_API_NAME, major: BRIDGE_API_MAJOR, minor: BRIDGE_API_MINOR },
    actions: keys.map(route => route.slice(prefix.length)).sort(),
    capabilityMeaning: 'registered-not-authorized-or-ready',
    automaticWriteRetry: 'never',
  };
  if (!validateBridgeApiContract(descriptor)) throw new TypeError('The bridge route table cannot form a valid API contract.');
  return freeze(descriptor);
}

function assessBridgeApiCompatibility(value, { requiredActions = [] } = {}) {
  if (!Array.isArray(requiredActions) || requiredActions.some(action => !matches(BRIDGE_API_CONTRACT_SCHEMA.properties.actions.items, action))) {
    throw new TypeError('Required action names must be valid API action identifiers.');
  }
  if (!validateBridgeApiContract(value)) return { ok: false, code: 'BRIDGE_API_CONTRACT_INVALID' };
  if (value.api.major !== BRIDGE_API_MAJOR) return { ok: false, code: 'BRIDGE_API_MAJOR_UNSUPPORTED' };
  const missingActions = [...new Set(requiredActions.filter(action => !value.actions.includes(action)))].sort();
  if (missingActions.length) return { ok: false, code: 'BRIDGE_API_ACTION_UNAVAILABLE', missingActions };
  return { ok: true, apiMajor: value.api.major, apiMinor: value.api.minor };
}

module.exports = { BRIDGE_API_NAME, BRIDGE_API_MAJOR, BRIDGE_API_MINOR, BRIDGE_API_CONTRACT_SCHEMA, createBridgeApiContract, validateBridgeApiContract, assessBridgeApiCompatibility };
