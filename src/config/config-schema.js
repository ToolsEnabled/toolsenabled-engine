'use strict';

const defaults = require('./defaults');

const PRECEDENCE = Object.freeze(['machine', 'user', 'workspace', 'run']);
const SECRET_KEY_PATTERN = /(?:^|_)(?:api_key|access_key|secret|password|passphrase|credential|authorization|cookie|private_key|client_secret|bearer)(?:_|$)|(?:^|_)token$/;
const SAFE_SECRET_KEYS = new Set(['secret_redaction']);

const SHAPE = Object.freeze({
  version: null,
  server: Object.freeze({
    port: null,
    host: null
  }),
  ollama: Object.freeze({
    host: null,
    port: null,
    defaultModel: null,
    timeoutMs: null
  }),
  engine: Object.freeze({
    maxTokenBudget: null,
    defaultTemperature: null,
    enableThinkingTags: null
  }),
  security: Object.freeze({
    sandboxBoundary: null,
    secretRedaction: null
  })
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const copy = {};
    for (const [key, child] of Object.entries(value)) copy[key] = deepClone(child);
    return copy;
  }
  return value;
}

function assertKnownShape(value, shape, path = 'config') {
  if (!isPlainObject(value)) {
    throw new TypeError(`${path} must be an object`);
  }

  for (const [key, child] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(shape, key)) {
      throw new Error(`Unknown configuration setting: ${path}.${key}`);
    }
    if (shape[key] !== null) {
      assertKnownShape(child, shape[key], `${path}.${key}`);
    }
  }
}

function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeInto(target[key], value);
    } else {
      target[key] = deepClone(value);
    }
  }
  return target;
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${label}: expected boolean`);
  }
}

function requireSafeString(value, label, maximumLength = 253) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function redactRecursive(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const result = value.map(item => redactRecursive(item, seen));
    seen.delete(value);
    return result;
  }

  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[-\s]+/g, '_')
      .toLowerCase();
    if (!SAFE_SECRET_KEYS.has(normalizedKey) && SECRET_KEY_PATTERN.test(normalizedKey)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactRecursive(child, seen);
    }
  }

  seen.delete(value);
  return result;
}

function normalizeLayers(input) {
  if (input === undefined) return [];
  if (!isPlainObject(input)) {
    throw new TypeError('Configuration overrides must be an object');
  }

  const layerKeys = PRECEDENCE.filter(key => Object.prototype.hasOwnProperty.call(input, key));
  if (layerKeys.length === 0) {
    return [{ name: 'legacy', value: input }];
  }

  const mixedKeys = Object.keys(input).filter(key => !PRECEDENCE.includes(key));
  if (mixedKeys.length > 0) {
    throw new Error(
      `Layered configuration cannot mix precedence layers with direct settings: ${mixedKeys.join(', ')}`
    );
  }

  return PRECEDENCE
    .filter(name => Object.prototype.hasOwnProperty.call(input, name))
    .map(name => {
      const value = input[name];
      if (!isPlainObject(value)) {
        throw new TypeError(`Configuration layer '${name}' must be an object`);
      }
      return { name, value };
    });
}

class ConfigSchema {
  constructor(overrides = {}) {
    const layers = normalizeLayers(overrides);
    const merged = deepClone(defaults);

    for (const layer of layers) {
      assertKnownShape(layer.value, SHAPE, layer.name === 'legacy' ? 'config' : layer.name);
      mergeInto(merged, layer.value);
    }

    this.validate(merged);
    this.config = merged;
    this.appliedPrecedence = Object.freeze(layers.map(layer => layer.name));
  }

  static fromLayers(layers = {}) {
    return new ConfigSchema(layers);
  }

  static redact(value) {
    return redactRecursive(value);
  }

  mergeConfig(base, overrides) {
    assertKnownShape(base, SHAPE, 'base');
    assertKnownShape(overrides, SHAPE, 'config');
    const merged = mergeInto(deepClone(base), overrides);
    this.validate(merged);
    return merged;
  }

  validate(cfg) {
    assertKnownShape(cfg, SHAPE);

    if (cfg.version !== defaults.version) {
      throw new Error(`Unsupported configuration version: ${cfg.version}`);
    }

    requireInteger(cfg.server.port, 'server port', 1024, 65535);
    requireSafeString(cfg.server.host, 'server host');
    if (/[/\\\s]/.test(cfg.server.host)) {
      throw new Error(`Invalid server host: ${cfg.server.host}`);
    }

    requireSafeString(cfg.ollama.host, 'Ollama host');
    if (/[/\\\s]/.test(cfg.ollama.host)) {
      throw new Error(`Invalid Ollama host: ${cfg.ollama.host}`);
    }
    requireInteger(cfg.ollama.port, 'Ollama port', 1, 65535);
    requireSafeString(cfg.ollama.defaultModel, 'Ollama default model', 200);
    requireInteger(cfg.ollama.timeoutMs, 'Ollama timeoutMs', 100, 600000);

    requireInteger(cfg.engine.maxTokenBudget, 'maxTokenBudget', 512, 1000000);
    if (
      !Number.isFinite(cfg.engine.defaultTemperature) ||
      cfg.engine.defaultTemperature < 0 ||
      cfg.engine.defaultTemperature > 2
    ) {
      throw new Error(`Invalid temperature setting: ${cfg.engine.defaultTemperature}`);
    }
    requireBoolean(cfg.engine.enableThinkingTags, 'enableThinkingTags');

    requireSafeString(cfg.security.sandboxBoundary, 'sandboxBoundary', 128);
    if (
      cfg.security.sandboxBoundary === '.' ||
      cfg.security.sandboxBoundary === '..' ||
      /[/\\]/.test(cfg.security.sandboxBoundary)
    ) {
      throw new Error(`Invalid sandboxBoundary: ${cfg.security.sandboxBoundary}`);
    }
    requireBoolean(cfg.security.secretRedaction, 'secretRedaction');

    return true;
  }

  exportRedacted(value = this.config) {
    return ConfigSchema.redact(value);
  }
}

ConfigSchema.PRECEDENCE = PRECEDENCE;

module.exports = ConfigSchema;
