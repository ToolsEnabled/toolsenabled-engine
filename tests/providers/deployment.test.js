/*
 * Mutation: changed VERCEL_CLI from 'vercel@56.4.1' to 'vercel@56.4.0'.
 * Mutation landed: yes, confirmed by matching the edited module line.
 * Isolated test went red: yes, exiting 1 on the pinned-version assertion.
 * The module was restored and its original SHA-256 was confirmed afterward.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const deployment = require('../../src/lib/providers/deployment');

test('exports pinned CLI versions and provider-specific npx arguments', () => {
  assert.equal(deployment.VERCEL_CLI, 'vercel@56.4.1');
  assert.equal(deployment.WRANGLER_CLI, 'wrangler@4.113.0');
  assert.deepEqual(deployment.commandFor('vercel'), ['-y', 'vercel@56.4.1', '--prod', '--yes']);
  assert.deepEqual(deployment.commandFor('cloudflare'), ['-y', 'wrangler@4.113.0', 'deploy']);
  assert.throws(
    () => deployment.commandFor('firebase'),
    /Unsupported deployment provider 'firebase'/
  );
});

test('builds each provider environment from the documented secret names', () => {
  const reads = [];
  const readSecret = name => {
    reads.push(name);
    return `value-for-${name}`;
  };

  assert.deepEqual(deployment.providerEnvironment('vercel', readSecret), {
    VERCEL_TOKEN: 'value-for-vercel_token'
  });
  assert.deepEqual(deployment.providerEnvironment('cloudflare', readSecret), {
    CLOUDFLARE_API_TOKEN: 'value-for-cloudflare_api_token',
    CLOUDFLARE_ACCOUNT_ID: 'value-for-cloudflare_account_id'
  });
  assert.deepEqual(deployment.providerEnvironment('firebase', readSecret), {});
  assert.deepEqual(reads, ['vercel_token', 'cloudflare_api_token', 'cloudflare_account_id']);
});

test('detect reads only the synthetic deployment configuration', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-provider-test-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  await t.test('detect reports an empty configured project', () => {
    assert.deepEqual(deployment.detect(fixture), {
      cwd: path.resolve(fixture),
      providers: [],
      defaultProvider: null
    });
  });

  await t.test('detect recognizes configurations in deterministic provider order', () => {
    fs.writeFileSync(path.join(fixture, 'wrangler.jsonc'), '{}');
    fs.mkdirSync(path.join(fixture, '.vercel'));
    fs.writeFileSync(path.join(fixture, 'firebase.json'), '{}');

    assert.deepEqual(deployment.detect(fixture), {
      cwd: path.resolve(fixture),
      providers: ['firebase', 'vercel', 'cloudflare'],
      defaultProvider: 'firebase'
    });
  });

  await t.test('detect rejects a missing deployment directory', () => {
    const missing = path.join(fixture, 'not-present');
    assert.throws(
      () => deployment.detect(missing),
      error => error instanceof Error && error.message === `Deployment directory does not exist: ${missing}`
    );
  });
});
