'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const command = path.join(__dirname, '../bin/toolsenabled-host.js');

test('host help exits cleanly when its terminal reader closes the pipe', async () => {
  const child = spawn(process.execPath, [command, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  // Close the actual OS pipe before the command writes, without host setup.
  child.stdout.destroy();
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0);
  assert.equal(stderr, '');
});
