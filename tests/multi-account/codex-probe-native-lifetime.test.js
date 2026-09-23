'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const isolation = require('../lib/isolated-environment').activate('codex-quota-lifetime');
const { appServerRequest } = require('../../src/lib/multi-account/health');
const { spawnHidden } = require('../../src/lib/proc/hidden-spawn');
const { createStartupCleanup } = require('../../src/lib/agent-engine/codex-startup-cleanup');

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

for (const mode of ['success', 'timeout', 'abort', 'output']) {
  test(`native Codex ${mode} closes the owned root, detached descendant and pipes`, { timeout: 25000 }, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(isolation.root, `quota-${mode}-`)));
    assert.equal(require('../lib/isolated-environment').within(isolation.root, root), true);
    const marker = path.join(root, 'fixture-pids.json');
    const controller = new AbortController();
    const env = {
      SystemRoot: process.env.SystemRoot, SystemDrive: process.env.SystemDrive,
      PATH: process.env.PATH, HOME: root, USERPROFILE: root, TEMP: root, TMP: root,
      APPDATA: root, LOCALAPPDATA: root, CODEX_HOME: root,
      XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_STATE_HOME: root
    };
    let child, closed = false, contained = false;
    try {
      const result = await appServerRequest({ command: process.execPath,
        prefixArgs: [path.resolve(__dirname, '../fixtures/codex-quota-peer.cjs'), mode, marker],
        env, signal: controller.signal, timeoutMs: mode === 'timeout' ? 5000 : 15000,
        spawnImpl(command, args, options) {
          contained = options.containProcessTree === true;
          child = spawnHidden(command, args, { ...options, cwd: root });
          child.once('close', () => { closed = true; });
          if (mode === 'abort') child.stdout.on('data', chunk => {
            if (String(chunk).includes('fixture/ready')) controller.abort();
          });
          return child;
        }
      });
      assert.equal(contained, true);
      assert.equal(closed, true, 'the result must not outrun wrapper/stdio closure');
      assert.equal(result.probeLifecycle, mode === 'abort' ? undefined : 'closed');
      const receipt = await child.jobOutcome;
      assert.ok(['exit', 'terminated'].includes(receipt.type));
      assert.equal(receipt.activeProcesses, 0);
      assert.ok(!receipt.failure);
      assert.ok(!(await child.jobClosed).failure);
      const pids = JSON.parse(fs.readFileSync(marker, 'utf8'));
      for (const pid of Object.values(pids)) {
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        assert.equal(alive(pid), false, 'only this fixture PID is inspected');
      }
      if (mode === 'success') {
        assert.equal(result.transportError, null);
        assert.equal(result.rateLimitsResult.rateLimits.primary.usedPercent, 37);
      } else {
        assert.equal(result.transportError, mode === 'timeout' ? 'timed out after 5000ms'
          : mode === 'abort' ? 'ABORT_ERR' : 'CODEX_ACCOUNT_OUTPUT_LIMIT');
        assert.equal(result.rateLimitsResult, null);
      }
    } finally {
      // Retained handles only, and only if the subject did not already close.
      if (child && !closed) await createStartupCleanup(child).confirmClosed(5000);
    }
  });
}
