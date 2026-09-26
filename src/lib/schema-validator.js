'use strict';

const { isDeepStrictEqual } = require('node:util');

const SUPPORTED_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);

class SchemaValidationError extends TypeError {
  constructor(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
      throw new TypeError('SchemaValidationError requires at least one validation error.');
    }
    super(`Invalid input: ${errors.map(error => `${error.path}: ${error.message}`).join('; ')}`);
    this.name = 'SchemaValidationError';
    this.code = 'INVALID_PARAMS';
    this.errors = errors;
  }
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'non-finite number';
  return typeof value;
}

// AN EMPTY BASE NAMES NO FIELD, SO IT MUST NOT PRINT ONE.
//
// `${''}.${property}` used to be the only path this function took, which
// prints a leading dot -- ".path" -- for a caller that asks for property
// names with no root label (see validate() below and its caller in
// tool-registry.js#executeTool). A dot nobody wrote is the same class of
// defect as a field nobody sent: cosmetic in isolation, and confusing at the
// exact moment someone is reading a refusal to find out what to send instead.
function propertyPath(base, property) {
  const isIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property);
  if (!base) return isIdentifier ? property : `[${JSON.stringify(property)}]`;
  return isIdentifier ? `${base}.${property}` : `${base}[${JSON.stringify(property)}]`;
}

function addError(errors, path, keyword, message) {
  errors.push({ path, keyword, message });
}

function assertSchema(schema, path = '$schema', seen = new WeakSet()) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new TypeError(`Schema at ${path} must be an object.`);
  if (seen.has(schema)) throw new TypeError(`Schema at ${path} must not be recursive.`);
  seen.add(schema);
  if (schema.type !== undefined && !SUPPORTED_TYPES.has(schema.type)) throw new TypeError(`Schema at ${path} uses unsupported type '${schema.type}'.`);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new TypeError(`Schema enum at ${path} must be an array.`);
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') throw new TypeError(`Schema uniqueItems at ${path} must be a boolean.`);
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[keyword] !== undefined && (!Number.isFinite(schema[keyword]) || ((keyword.startsWith('min') || keyword.startsWith('max')) && schema[keyword] < 0))) {
      throw new TypeError(`Schema keyword '${keyword}' at ${path} must be a valid non-negative number.`);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') throw new TypeError(`Schema pattern at ${path} must be a string.`);
    try { new RegExp(schema.pattern); } catch { throw new TypeError(`Schema pattern at ${path} is not a valid regular expression.`); }
  }
  if (schema.type === 'object') {
    const properties = schema.properties === undefined ? {} : schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw new TypeError(`Schema properties at ${path} must be an object.`);
    if (schema.additionalProperties !== undefined
      && typeof schema.additionalProperties !== 'boolean'
      && (!schema.additionalProperties || typeof schema.additionalProperties !== 'object' || Array.isArray(schema.additionalProperties))) {
      throw new TypeError(`Schema additionalProperties at ${path} must be a boolean or schema object.`);
    }
    const required = schema.required === undefined ? [] : schema.required;
    if (!Array.isArray(required) || required.some(property => typeof property !== 'string')) throw new TypeError(`Schema required list at ${path} must contain only strings.`);
    for (const property of required) if (!Object.prototype.hasOwnProperty.call(properties, property)) throw new TypeError(`Required schema property '${property}' at ${path} is not declared.`);
    for (const [property, child] of Object.entries(properties)) assertSchema(child, propertyPath(path, property), seen);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      assertSchema(schema.additionalProperties, `${path}.additionalProperties`, seen);
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) assertSchema(schema.items, `${path}.items`, seen);
  seen.delete(schema);
  return schema;
}

function validateNode(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError(`Schema at ${path} must be an object.`);
  }

  const type = schema.type;
  if (type !== undefined && !SUPPORTED_TYPES.has(type)) {
    throw new TypeError(`Schema at ${path} uses unsupported type '${type}'.`);
  }

  let typeMatches = true;
  switch (type) {
    case 'object':
      typeMatches = value !== null && typeof value === 'object' && !Array.isArray(value);
      break;
    case 'array':
      typeMatches = Array.isArray(value);
      break;
    case 'number':
      typeMatches = typeof value === 'number' && Number.isFinite(value);
      break;
    case 'integer':
      typeMatches = typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
      break;
    case 'string':
    case 'boolean':
      typeMatches = typeof value === type;
      break;
    default:
      break;
  }

  if (!typeMatches) {
    addError(errors, path, 'type', `expected ${type}, received ${valueType(value)}`);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'enum')) {
    if (!schema.enum.some(candidate => isDeepStrictEqual(candidate, value))) {
      addError(errors, path, 'enum', `must be one of ${schema.enum.map(candidate => JSON.stringify(candidate)).join(', ')}`);
      return;
    }
  }

  if ((type === 'number' || type === 'integer') && typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) addError(errors, path, 'minimum', `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) addError(errors, path, 'maximum', `must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) addError(errors, path, 'exclusiveMinimum', `must be greater than ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) addError(errors, path, 'exclusiveMaximum', `must be less than ${schema.exclusiveMaximum}`);
  }

  if (type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) addError(errors, path, 'minLength', `must contain at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) addError(errors, path, 'maxLength', `must contain at most ${schema.maxLength} characters; received ${value.length}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) addError(errors, path, 'pattern', `must match ${schema.pattern}`);
  }

  if (type === 'object') {
    const properties = schema.properties === undefined ? {} : schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new TypeError(`Schema properties at ${path} must be an object.`);
    }
    const required = schema.required === undefined ? [] : schema.required;
    if (!Array.isArray(required) || required.some(property => typeof property !== 'string')) {
      throw new TypeError(`Schema required list at ${path} must contain only strings.`);
    }

    for (const property of required) {
      if (!Object.prototype.hasOwnProperty.call(value, property)) {
        addError(errors, propertyPath(path, property), 'required', 'is required');
      }
    }

    for (const [property, propertyValue] of Object.entries(value)) {
      const childPath = propertyPath(path, property);
      if (!Object.prototype.hasOwnProperty.call(properties, property)) {
        if (schema.additionalProperties === false) {
          addError(errors, childPath, 'additionalProperties', 'additional property is not allowed');
        } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          validateNode(schema.additionalProperties, propertyValue, childPath, errors);
        }
        continue;
      }
      validateNode(properties[property], propertyValue, childPath, errors);
    }
  }

  if (type === 'array' && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      validateNode(schema.items, value[index], `${path}[${index}]`, errors);
    }
  }
  if (type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) addError(errors, path, 'minItems', `must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) addError(errors, path, 'maxItems', `must contain at most ${schema.maxItems} items`);
    // TOOL-REGISTRY GAP (measured 2026-09-03): seven array fields across
    // tool-registry.js declared `uniqueItems: true` (the since-removed durable-run submit
    // allowedWorkers, overnight_advisory.submit acceptanceChecklist,
    // scheduler weekdays x2, that submit scope's capabilities, and two owner-form
    // acknowledgement.fieldIds lists) and this function never checked the
    // keyword -- every value type here reached `addError` for minItems and
    // maxItems but uniqueItems was declared and silently never read. A
    // caller could satisfy that submit's `minItems:1, maxItems:4,
    // uniqueItems:true` allowedWorkers with four copies of the same worker
    // and receive zero validation errors: the schema promised rejection the
    // validator never carried out. isDeepStrictEqual matches the equality
    // rule `enum` already uses above, so an item that is itself an object
    // is compared by value, not by reference.
    if (schema.uniqueItems === true) {
      const duplicateIndex = value.findIndex((item, index) => (
        value.findIndex(other => isDeepStrictEqual(other, item)) !== index
      ));
      if (duplicateIndex !== -1) {
        addError(errors, path, 'uniqueItems', `must not contain duplicate items (repeated at index ${duplicateIndex})`);
      }
    }
  }
}

/**
 * Validate a JSON-compatible value against the schema subset used by ToolsEnabled.
 * Returns every input error in deterministic traversal order and throws only when
 * the schema itself is malformed or uses an unsupported type.
 */
function validate(schema, value, options = {}) {
  // '' is a real, distinct choice from "no path given" -- see propertyPath()
  // above -- so it must survive here rather than being read as falsy and
  // silently replaced with '$'. Only an OMITTED path (not a string at all)
  // takes the default.
  const path = typeof options.path === 'string' ? options.path : '$';
  assertSchema(schema);
  const errors = [];
  validateNode(schema, value, path, errors);
  return errors;
}

/** Validate and return the original value, or throw SchemaValidationError. */
function assertValid(schema, value, options = {}) {
  const errors = validate(schema, value, options);
  if (errors.length) throw new SchemaValidationError(errors);
  return value;
}

module.exports = { SchemaValidationError, assertSchema, validate, assertValid };
