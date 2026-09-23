'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const isolation = require('../lib/isolated-environment').activate('gemini-quota-sdk');
const { spawnHidden } = require('../../src/lib/proc/hidden-spawn');
const { createStartupCleanup } = require('../../src/lib/agent-engine/codex-startup-cleanup');
const { probeGeminiQuota } = require('../../src/lib/providers/gemini-quota-probe');
const preload = path.resolve(__dirname, '../fixtures/gemini-quota-sdk-preload.mjs');

for (const mode of ['valid', 'refresh', 'delayed-refresh', 'no-identity-cache', 'secret-log', 'quota-failure',
  'no-tier', 'retired-client', 'revoked', 'write-failure', 'replace-before-write', 'replace-during-write', 'timeout', 'cancel']) {
  test(`actual bundled Gemini SDK ${mode} stays within synthetic auth/health/quota transport and closes`, { timeout: 25000 }, async () => {
    const root = fs.mkdtempSync(path.join(isolation.root, `sdk-${mode}-`));
    const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    const leaf = path.join(home, '.gemini', 'oauth_creds.json');
    const refreshing = ['refresh','delayed-refresh','revoked','write-failure','replace-before-write','replace-during-write'].includes(mode);
    const before = JSON.stringify({ access_token: 'synthetic-original', refresh_token: 'synthetic-refresh',
      expiry_date: Date.now() + (refreshing ? -10000 : 3600000) });
    fs.writeFileSync(leaf, before);
    fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } },
      mcpServers: { forbidden: { command: 'must-not-execute' } }, hooks: { BeforeAgent: [{ hooks: [{ type: 'command', command: 'must-not-execute' }] }] } }));
    if (mode !== 'no-identity-cache') fs.writeFileSync(path.join(home, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'stale@example.invalid', old: [] }));
    const evidence = path.join(root, 'guard.json');
    let child, closed = false, output = '';
    const controller = new AbortController();
    let abortTimer;
    try {
      const answer = await probeGeminiQuota({ home, temporaryRoot: root, signal: controller.signal,
        timeoutMs: mode === 'timeout' ? 4000 : 15000,
        baseEnvironment: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH },
        spawnImpl(command, args, options) {
          child = spawnHidden(command, ['--import', pathToFileURL(preload).href, ...args], { ...options,
            env: { ...options.env, TOOLSENABLED_GEMINI_FIXTURE: mode === 'cancel' ? 'timeout' : mode, TOOLSENABLED_GEMINI_EVIDENCE: evidence } });
          child.once('close', () => { closed = true; });
          for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += String(chunk); });
          if (mode === 'cancel') abortTimer = setTimeout(() => controller.abort(), 3000);
          return child;
        }
      });
      clearTimeout(abortTimer);
      assert.equal(closed, true);
      const receipt = await child.jobOutcome;
      assert.equal(receipt.activeProcesses, 0);
      assert.ok(!receipt.failure); assert.ok(!(await child.jobClosed).failure);
      assert.equal(answer.probeLifecycle, mode === 'cancel' ? undefined : 'closed');
      assert.equal(output.includes('synthetic-secret-must-not-escape'), false);
      assert.equal(output.includes('Loaded cached credentials'), false);
      if (['valid','refresh','delayed-refresh','no-identity-cache','secret-log'].includes(mode)) {
        assert.equal(answer.status, 'observed');
        assert.equal(answer.email, 'fixture-current@example.invalid');
        assert.equal(answer.allowanceBuckets.buckets[0].remainingFraction, 0.421875);
        assert.equal(answer.allowanceBuckets.buckets[0].resetsAt, '2026-09-15T01:02:03.123456789Z');
        assert.equal(answer.allowanceBuckets.buckets[1].remainingAmount, '900719925474099312345.125');
        assert.equal(answer.usedPercent, undefined);
        assert.equal(answer.windows, undefined);
      } else {
        assert.equal(answer.status, 'unavailable'); assert.equal(answer.allowanceBuckets, undefined);
      }
      if (mode === 'quota-failure') {
        // Real pinned SDK + owned worker + frame decoder: userinfo succeeded
        // before the independent quota service failed. Retain that distinction
        // all the way through the canonical Start account health boundary.
        assert.equal(answer.email, 'fixture-current@example.invalid');
        const { probeGeminiAccount, STATUS } = require('../../src/lib/multi-account/health');
        const row = await probeGeminiAccount({ name: 'fixture', provider: 'gemini', home,
          expectEmail: 'fixture-current@example.invalid' }, { quotaProbe: async () => answer });
        assert.equal(row.status, STATUS.HEALTHY);
        assert.equal(row.canServe, true);
        assert.equal(row.usageStatus, 'unavailable');
        assert.equal(row.usageCode, 'GEMINI_SERVICE_UNAVAILABLE');
        assert.equal(row.allowanceBuckets, null);
      }
      if (mode === 'retired-client') {
        // The real pinned SDK passes Google's retirement answer through, and the
        // Start account health says so instead of "not provisioned" and unknown.
        assert.equal(answer.code, 'GEMINI_CLIENT_RETIRED');
        assert.equal(answer.email, 'fixture-current@example.invalid');
        const { probeGeminiAccount, STATUS } = require('../../src/lib/multi-account/health');
        const row = await probeGeminiAccount({ name: 'fixture', provider: 'gemini', home,
          expectEmail: 'fixture-current@example.invalid' }, { quotaProbe: async () => answer });
        assert.equal(row.status, STATUS.NOT_PROVISIONED);
        assert.equal(row.canServe, false);
        assert.match(row.reason, /Antigravity/);
      }
      if (mode === 'refresh' || mode === 'delayed-refresh') {
        const after = JSON.parse(fs.readFileSync(leaf, 'utf8'));
        assert.equal(after.access_token, 'synthetic-refreshed'); assert.equal(after.refresh_token, 'synthetic-refresh');
      }
      if (mode === 'write-failure' || mode === 'revoked') assert.equal(fs.readFileSync(leaf, 'utf8'), before);
      if (mode.startsWith('replace-')) assert.equal(JSON.parse(fs.readFileSync(leaf, 'utf8')).access_token, 'synthetic-owner-replacement');
      if (!['timeout','cancel'].includes(mode)) {
        const audit = JSON.parse(fs.readFileSync(evidence, 'utf8'));
        assert.deepEqual(audit.forbidden, []);
        assert.equal(audit.operations.includes('onboardUser'), false);
        if (mode === 'no-tier' || mode === 'retired-client') assert.equal(audit.operations.includes('retrieveUserQuota'), false);
        if (mode === 'delayed-refresh') assert.equal(audit.atomicWriteCompleted, true);
      }
    } finally {
      clearTimeout(abortTimer);
      if (child && !closed) await createStartupCleanup(child).confirmClosed(5000);
    }
  });
}
