#!/usr/bin/env node
'use strict';

const alerts = require('../src/lib/resource-alerts');

class ResourceAlertsCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResourceAlertsCliError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ResourceAlertsCliError(code, message);
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail('RESOURCE_ALERTS_CLI_INVALID', `${flag} requires a value.`);
  return value;
}

function parseArgs(argv) {
  const parsed = {
    sample: false,
    evaluate: false,
    list: false,
    setRule: null,
    clear: null,
    setBy: 'coordinator-cli',
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sample') parsed.sample = true;
    else if (arg === '--evaluate') parsed.evaluate = true;
    else if (arg === '--list') parsed.list = true;
    else if (arg === '--set-rule') {
      parsed.setRule = requireValue(argv, index, '--set-rule');
      index += 1;
    } else if (arg === '--clear') {
      parsed.clear = requireValue(argv, index, '--clear');
      index += 1;
    } else if (arg === '--set-by') {
      parsed.setBy = requireValue(argv, index, '--set-by');
      index += 1;
    } else if (arg === '--help' || arg === '-h') parsed.help = true;
    else fail('RESOURCE_ALERTS_CLI_INVALID', `Unknown argument: ${arg}.`);
  }
  const mutations = [parsed.setRule, parsed.clear].filter(Boolean).length;
  const reads = [parsed.sample, parsed.evaluate, parsed.list].filter(Boolean).length;
  if (!parsed.help && mutations + reads === 0) fail('RESOURCE_ALERTS_CLI_INVALID', 'Choose an operation.');
  if (mutations > 1 || (mutations && reads) || (parsed.list && (parsed.sample || parsed.evaluate))) {
    fail('RESOURCE_ALERTS_CLI_INVALID', 'Rule changes and --list cannot be combined with sampling or evaluation.');
  }
  return Object.freeze(parsed);
}

function helpText() {
  return [
    'Usage:',
    '  node tools/resource-alerts.js --sample [--evaluate]',
    '  node tools/resource-alerts.js --evaluate',
    '  node tools/resource-alerts.js --set-rule "cpu>90 for 10m" [--set-by coordinator]',
    '  node tools/resource-alerts.js --list',
    '  node tools/resource-alerts.js --clear <id>'
  ].join('\n');
}

function safeError(error) {
  return {
    ok: false,
    code: error && typeof error.code === 'string' ? error.code : 'RESOURCE_ALERTS_UNEXPECTED',
    message: error && error.message ? String(error.message).slice(0, 512) : 'Resource alerts command failed.'
  };
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { ok: true, help: helpText() };
  if (parsed.setRule) {
    const expression = alerts.parseRuleExpression(parsed.setRule);
    const rule = alerts.setRule({ ...expression, setBy: parsed.setBy });
    return { ok: true, action: 'RULE_SET', rule };
  }
  if (parsed.clear) {
    const rule = alerts.clearRule(parsed.clear);
    return { ok: true, action: 'RULE_CLEARED', rule };
  }
  if (parsed.list) return { ok: true, action: 'RULE_LIST', rules: alerts.readRules() };

  let sample = null;
  if (parsed.sample) sample = await alerts.recordSample();
  const sampleUnknown = sample && sample.state === 'UNKNOWN';
  const evaluation = parsed.evaluate
    ? alerts.evaluateRules({ samplerFailure: sampleUnknown })
    : null;
  return { ok: !sampleUnknown, sample, evaluation };
}

if (require.main === module) {
  main().then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ ResourceAlertsCliError, main, parseArgs });
