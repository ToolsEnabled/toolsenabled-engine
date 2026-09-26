'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deployment = require('../../src/lib/providers/deployment');
const firebase = require('../../src/lib/providers/firebase');
const launch = require('../../src/lib/providers/launch');

(async () => {
  assert.deepEqual(deployment.commandFor('vercel'), ['-y', 'vercel@56.4.1', '--prod', '--yes']);
  assert.deepEqual(deployment.commandFor('cloudflare'), ['-y', 'wrangler@4.113.0', 'deploy']);
  assert.deepEqual(deployment.providerEnvironment('vercel', key => `secret:${key}`), { VERCEL_TOKEN: 'secret:vercel_token' });
  assert.deepEqual(deployment.providerEnvironment('cloudflare', key => `secret:${key}`), {
    CLOUDFLARE_API_TOKEN: 'secret:cloudflare_api_token', CLOUDFLARE_ACCOUNT_ID: 'secret:cloudflare_account_id'
  });

  assert.throws(() => firebase.projectCreate({ projectId: 'valid-project-id', displayName: 'bad\r\nname' }), /displayName/);
  assert.throws(() => firebase.appCreate({ projectId: 'INVALID', platform: 'WEB', displayName: 'web' }), /projectId/);
  assert.throws(() => firebase.appCreate({ projectId: 'valid-project-id', platform: 'web', displayName: 'web', packageName: 'not-used.example' }), /not used/);
  assert.throws(() => firebase.deploy({ projectId: 'INVALID', cwd: process.cwd() }), /projectId/);

  const nonexistent = path.join(os.tmpdir(), `toolsenabled-missing-${process.pid}`);
  assert.throws(() => launch.detect(nonexistent), /does not exist/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-empty-project-'));
  try {
    await assert.rejects(launch.execute({ cwd: empty }), /No actionable/);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }

  console.log('Provider input tests passed.');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
