'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function childEnv(root) {
  const env = { ...process.env, TOOLSENABLED_STATE_ROOT: root, OPENSHELL_SANDBOX: '' };
  for (const name of Object.keys(env)) {
    if (name.startsWith('TOOLSENABLED_AUDIT_') || ['TOOLSENABLED_STATE_PATH', 'TOOLSENABLED_VAULT_PATH'].includes(name))
      delete env[name];
  }
  return env;
}

test('a signal closes the MCP state database and settles WAL sidecars', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mcp-close-'));
  const file = path.join(root, 'state', 'toolsenabled.sqlite3');
  const child = spawn(process.execPath, [path.join(__dirname, '../src/mcp-server.js')], {
    env: childEnv(root),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(`${file}-wal`) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(fs.existsSync(`${file}-wal`), true, 'MCP state DB did not open');
    await new Promise(resolve => setTimeout(resolve, 100));
    child.kill('SIGTERM');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP child did not exit')), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    assert.equal(fs.existsSync(`${file}-wal`), false);
    assert.equal(fs.existsSync(`${file}-shm`), false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('closing stdin releases the state DB while the transport process stays alive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mcp-stdin-close-'));
  const file = path.join(root, 'state', 'toolsenabled.sqlite3');
  const script = `require(${JSON.stringify(path.join(__dirname, '../src/mcp-server.js'))}).start(); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', script], {
    env: childEnv(root),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(`${file}-wal`) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(fs.existsSync(`${file}-wal`), true, 'MCP WAL did not open');
    child.stdin.end();
    const closeDeadline = Date.now() + 3000;
    while (fs.existsSync(`${file}-wal`) && Date.now() < closeDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(child.exitCode, null, 'fixture process exited before the close check');
    assert.equal(fs.existsSync(`${file}-wal`), false);
    assert.equal(fs.existsSync(`${file}-shm`), false);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
