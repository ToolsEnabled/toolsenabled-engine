'use strict';

// Provider-neutral, opt-in interaction contract. No approval grants, defaults,
// credential custody, browser navigation, or persistence belongs here.
const { validate } = require('../schema-validator');
const { plaintextCredentialPattern } = require('../secret-patterns');
const LIMIT = 65_536;
function invalid() { throw Object.assign(new TypeError('Invalid or unsupported input data'), { code: 'AGENT_INPUT_INVALID' }); }
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null || Object.getOwnPropertySymbols(value).length) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.entries(fields).some(([k, d]) => ['__proto__', 'prototype', 'constructor'].includes(k) || !Object.hasOwn(d, 'value'))) invalid();
  return fields;
}
function boundedData(value) {
  let nodes = 0, characters = 0;
  function copy(v, depth) {
    if (++nodes > 4096 || depth > 8) invalid();
    if (typeof v === 'string') { characters += v.length; if (characters > LIMIT) invalid(); return v; }
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) {
      if (v.length > 256) invalid();
      return Object.freeze(v.map(x => copy(x, depth + 1)));
    }
    const output = {};
    for (const [k, d] of Object.entries(record(v))) {
      characters += k.length;
      if (characters > LIMIT) invalid();
      output[k] = copy(d.value, depth + 1);
    }
    return Object.freeze(output);
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > LIMIT) invalid();
  return result;
}
function text(v, max = 512) { if (typeof v !== 'string' || !v.length || v.length > max) invalid(); return v; }
function keys(value, allowed) { if (Object.keys(record(value)).some(k => !allowed.includes(k))) invalid(); }

// Provider context is untrusted disclosure, never authority or a response.
// Only this normalized projection crosses the private terminal boundary. Raw
// parameters, descriptions, persistence preferences and display prose do not.
function safeToolName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value)
    && !plaintextCredentialPattern().test(value);
}
function safeRelativeTarget(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_. /-]{1,512}$/.test(value)
    && !value.startsWith('/') && value === value.trim()
    && !value.split('/').some(part => !part || part === '.' || part === '..')
    && !/(?:^|\/)(?:\.env(?:\.|$)|[^/]*(?:secret|token|credential|password|api[_-]?key|private[_-]?key|authorization)[^/]*)(?:\/|$)/i.test(value)
    && !plaintextCredentialPattern().test(value);
}
// The context an input request carries when its adapter supplies none. Each
// adapter turns its own provider's metadata into this shape in its own module;
// this contract only validates the projection.
const MISSING_CONTEXT = Object.freeze({ purpose: 'unknown', status: 'missing', parametersOmitted: true });
function validateInputContext(context) {
  keys(context, ['purpose', 'status', 'parametersOmitted', 'toolName', 'target']);
  if (!['unknown', 'mcp-tool-approval', 'provider-approval'].includes(context.purpose)
      || !['missing', 'recognized', 'unrecognized', 'malformed'].includes(context.status)
      || context.parametersOmitted !== true
      || (context.status === 'recognized') !== (context.purpose === 'mcp-tool-approval')
      || context.status === 'missing' && (context.purpose !== 'unknown' || context.toolName !== undefined || context.target !== undefined)
      || context.status === 'malformed' && (context.purpose !== 'provider-approval' || context.toolName !== undefined || context.target !== undefined)
      || context.toolName !== undefined && !safeToolName(context.toolName)
      || context.target !== undefined && !safeRelativeTarget(context.target)) invalid();
}

// Only the schema subset this implementation can actually enforce is admitted.
// In particular arbitrary regexes, refs, nested objects and extension keywords
// are not executed or silently ignored. A caller can always cancel such input.
function formSchema(schema) {
  keys(schema, ['type', 'title', 'description', 'properties', 'required', 'additionalProperties']);
  if (schema.type !== 'object' || !schema.properties) invalid();
  const properties = record(schema.properties);
  if (Object.keys(properties).length > 64 || schema.additionalProperties !== undefined && schema.additionalProperties !== false) invalid();
  const required = schema.required ?? [];
  if (!Array.isArray(required) || new Set(required).size !== required.length || required.some(k => typeof k !== 'string' || !Object.hasOwn(properties, k))) invalid();
  const output = { type: 'object', properties: {}, required, additionalProperties: false };
  for (const [name, { value: field }] of Object.entries(properties)) {
    text(name, 128);
    keys(field, ['type', 'title', 'description', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'format', 'enum', 'enumNames', 'oneOf', 'items', 'minItems', 'maxItems']);
    for (const k of ['title', 'description']) if (field[k] !== undefined) text(field[k], 4096);
    if (!['string', 'boolean', 'number', 'integer', 'array'].includes(field.type)) invalid();
    const target = { type: field.type };
    for (const k of ['minimum', 'maximum']) {
      if (field[k] !== undefined) {
        if (!['number', 'integer'].includes(field.type) || !Number.isFinite(field[k])) invalid();
        target[k] = field[k];
      }
    }
    for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (field[k] !== undefined) {
        if (field.type !== (k.endsWith('Length') ? 'string' : 'array') || !Number.isSafeInteger(field[k]) || field[k] < 0 || field[k] > LIMIT) invalid();
        target[k] = field[k];
      }
    }
    if (field.format !== undefined && (field.type !== 'string' || !['email', 'uri', 'date', 'date-time'].includes(field.format))) invalid();
    if (field.enum !== undefined || field.oneOf !== undefined) {
      if (field.type !== 'string' || field.enum !== undefined && field.oneOf !== undefined) invalid();
      target.enum = choices(field.enum, field.oneOf);
    }
    if (field.enumNames !== undefined && (!target.enum || !Array.isArray(field.enumNames) || field.enumNames.length !== target.enum.length || field.enumNames.some(x => typeof x !== 'string'))) invalid();
    if (field.type === 'array') {
      keys(field.items, ['type', 'enum', 'anyOf']);
      if (field.items.type !== undefined && field.items.type !== 'string' || field.items.enum !== undefined && field.items.anyOf !== undefined) invalid();
      target.items = { type: 'string', enum: choices(field.items.enum, field.items.anyOf) };
      target.maxItems = Math.min(target.maxItems ?? 64, 64);
    } else if (field.items !== undefined) invalid();
    // schema-validator rejects negative minimums despite JSON Schema allowing
    // them. Numeric limits are checked here on answer instead of delegated.
    delete target.minimum; delete target.maximum;
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) invalid();
    output.properties[name] = target;
  }
  return output;
}
function choices(values, titled) {
  if (titled !== undefined) {
    if (!Array.isArray(titled)) invalid();
    values = titled.map(v => { keys(v, ['const', 'title']); if (v.title !== undefined) text(v.title, 4096); return v.const; });
  }
  if (!Array.isArray(values) || !values.length || values.length > 128 || values.some(v => typeof v !== 'string')) invalid();
  return values;
}
function validateInputRequest(value) {
  const request = boundedData(value);
  keys(request, ['inputId', 'threadId', 'turnId', 'kind', 'sourceName', 'message', 'schema', 'url', 'context']);
  const context = request.context === undefined ? MISSING_CONTEXT : request.context;
  validateInputContext(context);
  for (const k of ['inputId', 'threadId', 'turnId', 'sourceName']) text(request[k]);
  text(request.message, 16_384);
  if (request.kind === 'form') {
    if (request.url !== undefined) invalid();
    formSchema(request.schema);
  } else if (request.kind === 'url') {
    if (request.schema !== undefined) invalid();
    text(request.url, 8192);
    const url = new URL(request.url);
    if (url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) invalid();
  } else invalid();
  return Object.freeze({ ...request, context });
}
function validFormat(format, value) {
  if (!format) return true;
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === 'uri') { try { return Boolean(new URL(value).protocol); } catch { return false; } }
  const match = /^(\d{4}-\d{2}-\d{2})(?:[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2})))?$/.exec(value);
  if (!match || format === 'date' && value.length !== 10 || format === 'date-time' && value.length <= 10) return false;
  if (match[2] !== undefined && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
      || Number(match[6] || 0) > 23 || Number(match[7] || 0) > 59)) return false;
  return Number.isFinite(Date.parse(value)) && new Date(match[1]).toISOString().slice(0, 10) === match[1];
}
function validateInputResponse(value, request) {
  const response = boundedData(value);
  keys(response, ['action', 'content']);
  if (!['accept', 'decline', 'cancel'].includes(response.action)) invalid();
  if (response.action !== 'accept' || request.kind === 'url') {
    if (response.content !== undefined && response.content !== null) invalid();
    return Object.freeze({ action: response.action, content: null });
  }
  record(response.content);
  const schema = formSchema(request.schema);
  if (validate(schema, response.content).length) invalid();
  for (const [name, value] of Object.entries(response.content)) {
    const field = request.schema.properties[name];
    if (typeof value === 'number' && (field.minimum !== undefined && value < field.minimum || field.maximum !== undefined && value > field.maximum)) invalid();
    if (typeof value === 'string' && !validFormat(field.format, value)) invalid();
  }
  return Object.freeze({ action: 'accept', content: response.content });
}

module.exports = { validateInputRequest, validateInputResponse, MISSING_CONTEXT,
  // For an adapter's own context projection.
  boundedData, record, safeToolName, safeRelativeTarget };
