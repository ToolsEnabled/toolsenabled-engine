'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, commandExists, getSecret, run } = require('../runtime');
const { assertActive } = require('../policy');
const { record } = require('../audit');
const { describeFailure, interactiveSession } = require('../elevation-refusal');
const firebase = require('./firebase');
const { redactText } = require('./provider-safety');
const VERCEL_CLI = 'vercel@56.4.1';
const WRANGLER_CLI = 'wrangler@4.113.0';

function commandFor(provider) {
  if (provider === 'vercel') return ['-y', VERCEL_CLI, '--prod', '--yes'];
  if (provider === 'cloudflare') return ['-y', WRANGLER_CLI, 'deploy'];
  throw new Error(`Unsupported deployment provider '${provider}'.`);
}

function providerEnvironment(provider, readSecret = getSecret) {
  if (provider === 'vercel') return { VERCEL_TOKEN: readSecret('vercel_token') };
  if (provider === 'cloudflare') return {
    CLOUDFLARE_API_TOKEN: readSecret('cloudflare_api_token'),
    CLOUDFLARE_ACCOUNT_ID: readSecret('cloudflare_account_id')
  };
  return {};
}

function redactProviderStreams(result, environment) {
  const secrets = Object.values(environment || {})
    .filter(value => typeof value === 'string' && value)
    .sort((left, right) => right.length - left.length);
  const redact = value => secrets.reduce((output, secret) => redactText(output, secret, 4 * 1024 * 1024), String(value || ''));
  return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
}

function projectDir(cwd) {
  const target = path.resolve(cwd || ROOT);
  let stats;
  try {
    stats = fs.statSync(target);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new Error(`Deployment directory does not exist: ${target}`);
    }
    throw error;
  }
  if (!stats.isDirectory()) throw new Error(`Deployment directory does not exist: ${target}`);
  return target;
}

function detect(cwd = ROOT) {
  const target = projectDir(cwd);
  const exists = name => {
    try {
      fs.statSync(path.join(target, name));
      return true;
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
      throw error;
    }
  };
  const providers = [];
  if (exists('firebase.json')) providers.push('firebase');
  if (exists('vercel.json') || exists('.vercel')) providers.push('vercel');
  if (exists('wrangler.toml') || exists('wrangler.json') || exists('wrangler.jsonc')) providers.push('cloudflare');
  return { cwd: target, providers, defaultProvider: providers[0] || null };
}

function deploy({ cwd = ROOT, provider = 'auto', projectId, only = '' }) {
  const found = detect(cwd);
  const selected = provider === 'auto' ? found.defaultProvider : String(provider || '').toLowerCase();
  if (!['firebase', 'vercel', 'cloudflare'].includes(selected)) {
    throw Object.assign(new Error('No supported deployment provider was detected. Specify firebase, vercel, or cloudflare after adding its project configuration.'), {
      code: 'DEPLOYMENT_CONFIG_REQUIRED'
    });
  }
  if (selected === 'firebase') {
    if (!projectId) throw new Error('projectId is required for Firebase deployment.');
    return { provider: selected, ...firebase.deploy({ projectId, cwd: found.cwd, only }) };
  }
  if (!commandExists('npx')) throw new Error('npx is required for Vercel and Cloudflare deployment adapters.');
  const action = `${selected}.deploy`;
  assertActive(action);
  const args = commandFor(selected);
  const env = providerEnvironment(selected);
  const result = redactProviderStreams(
    run('npx', args, { cwd: found.cwd, env, timeout: 30 * 60 * 1000 }),
    env
  );
  // A deploy runs the project's own hooks, which are arbitrary code and can ask
  // Windows for administrator rights. See src/lib/elevation-refusal.js for why
  // the child's own words are not repeated as the first line (R1534).
  if (result.status !== 0 || result.timedOut) {
    throw new Error(describeFailure(`Deploying with ${selected}`, {
      exitCode: result.status, stderr: result.stderr, stdout: result.stdout,
      timedOut: result.timedOut === true, interactive: interactiveSession(),
    }));
  }
  record(action, found.cwd, { provider: selected });
  return { provider: selected, ...result };
}

module.exports = { VERCEL_CLI, WRANGLER_CLI, commandFor, detect, deploy, providerEnvironment };
