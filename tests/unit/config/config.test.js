'use strict';

const assert = require('node:assert/strict');
const ConfigSchema = require('../../../src/config/config-schema');

function testDefaultsAndLegacyOverrides() {
  const defaults = new ConfigSchema();
  assert.equal(defaults.config.version, 1);
  assert.equal(defaults.config.server.port, 3888);
  assert.equal(defaults.config.engine.defaultTemperature, 0.2);

  const input = {
    engine: { defaultTemperature: 0.7 },
    ollama: { defaultModel: 'qwen-test:latest' }
  };
  const overridden = new ConfigSchema(input);
  assert.equal(overridden.config.engine.defaultTemperature, 0.7);
  assert.equal(overridden.config.ollama.defaultModel, 'qwen-test:latest');
  assert.equal(overridden.config.server.port, 3888);
  assert.deepEqual(overridden.appliedPrecedence, ['legacy']);
  assert.deepEqual(input, {
    engine: { defaultTemperature: 0.7 },
    ollama: { defaultModel: 'qwen-test:latest' }
  });

  const merged = overridden.mergeConfig(overridden.config, { server: { port: 4555 } });
  assert.equal(merged.server.port, 4555);
  assert.throws(
    () => overridden.mergeConfig(overridden.config, { server: { port: 80 } }),
    /Invalid server port/
  );
}

function testExplicitPrecedence() {
  const schema = ConfigSchema.fromLayers({
    machine: {
      server: { port: 4000 },
      engine: { defaultTemperature: 0.3 }
    },
    user: {
      engine: { defaultTemperature: 0.4 },
      ollama: { defaultModel: 'user-model' }
    },
    workspace: {
      engine: { defaultTemperature: 0.5 }
    },
    run: {
      engine: { defaultTemperature: 0.6 }
    }
  });

  assert.equal(schema.config.server.port, 4000);
  assert.equal(schema.config.ollama.defaultModel, 'user-model');
  assert.equal(schema.config.engine.defaultTemperature, 0.6);
  assert.deepEqual(schema.appliedPrecedence, ['machine', 'user', 'workspace', 'run']);

  assert.throws(
    () => new ConfigSchema({ user: {}, engine: { defaultTemperature: 0.2 } }),
    /cannot mix precedence layers/
  );
  assert.throws(
    () => new ConfigSchema({ user: null }),
    /layer 'user' must be an object/
  );
}

function testUnknownAndHighRiskSettingsAreRejected() {
  assert.throws(
    () => new ConfigSchema({ unknownHighRiskSetting: true }),
    /Unknown configuration setting: config\.unknownHighRiskSetting/
  );
  assert.throws(
    () => new ConfigSchema({ engine: { unboundedExecution: true } }),
    /Unknown configuration setting: config\.engine\.unboundedExecution/
  );
  assert.throws(
    () => new ConfigSchema({ security: { apiToken: 'plain-secret' } }),
    /Unknown configuration setting: config\.security\.apiToken/
  );
  assert.throws(
    () => new ConfigSchema({ run: { server: { bindAllInterfaces: true } } }),
    /Unknown configuration setting: run\.server\.bindAllInterfaces/
  );
}

function testEveryConfigurationValueIsValidated() {
  const invalidCases = [
    [{ version: 2 }, /Unsupported configuration version/],
    [{ server: { port: 80 } }, /Invalid server port/],
    [{ server: { port: 3888.5 } }, /Invalid server port/],
    [{ server: { host: 'http:\/\/localhost' } }, /Invalid server host/],
    [{ ollama: { host: 'bad host' } }, /Invalid Ollama host/],
    [{ ollama: { port: 70000 } }, /Invalid Ollama port/],
    [{ ollama: { defaultModel: ' ' } }, /Invalid Ollama default model/],
    [{ ollama: { timeoutMs: 99 } }, /Invalid Ollama timeoutMs/],
    [{ engine: { maxTokenBudget: 511 } }, /Invalid maxTokenBudget/],
    [{ engine: { maxTokenBudget: 512.5 } }, /Invalid maxTokenBudget/],
    [{ engine: { defaultTemperature: Number.NaN } }, /Invalid temperature setting/],
    [{ engine: { defaultTemperature: 2.1 } }, /Invalid temperature setting/],
    [{ engine: { enableThinkingTags: 'yes' } }, /Invalid enableThinkingTags/],
    [{ security: { sandboxBoundary: '..' } }, /Invalid sandboxBoundary/],
    [{ security: { sandboxBoundary: 'outside\\path' } }, /Invalid sandboxBoundary/],
    [{ security: { secretRedaction: 1 } }, /Invalid secretRedaction/]
  ];

  for (const [value, pattern] of invalidCases) {
    assert.throws(() => new ConfigSchema(value), pattern);
  }
  assert.throws(() => new ConfigSchema([]), /overrides must be an object/);
}

function testRecursiveSecretRedaction() {
  const schema = new ConfigSchema();
  const diagnostics = {
    apiToken: 'top-secret',
    nested: {
      password: 'password',
      safe: 'visible',
      deeper: [{ clientSecret: 'client-secret' }, { privateKey: 'private-key' }]
    },
    Authorization: 'Bearer secret',
    maxTokenBudget: 8192,
    secretRedaction: true
  };

  const redacted = schema.exportRedacted(diagnostics);
  assert.equal(redacted.apiToken, '[REDACTED]');
  assert.equal(redacted.nested.password, '[REDACTED]');
  assert.equal(redacted.nested.safe, 'visible');
  assert.equal(redacted.nested.deeper[0].clientSecret, '[REDACTED]');
  assert.equal(redacted.nested.deeper[1].privateKey, '[REDACTED]');
  assert.equal(redacted.Authorization, '[REDACTED]');
  assert.equal(redacted.maxTokenBudget, 8192);
  assert.equal(redacted.secretRedaction, true);
  assert.equal(diagnostics.apiToken, 'top-secret');

  const exportedConfig = schema.exportRedacted();
  assert.notEqual(exportedConfig, schema.config);
  assert.deepEqual(exportedConfig, schema.config);
}

function run() {
  const tests = [
    testDefaultsAndLegacyOverrides,
    testExplicitPrecedence,
    testUnknownAndHighRiskSettingsAreRejected,
    testEveryConfigurationValueIsValidated,
    testRecursiveSecretRedaction
  ];

  for (const test of tests) {
    test();
    console.log(`  PASS ${test.name}`);
  }
  console.log(`Configuration regression tests passed (${tests.length} groups).`);
}

run();
