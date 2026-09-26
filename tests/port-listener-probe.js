'use strict';

// Live-local regression for the dashboard listener probe.  A protected S4U
// listener can be invisible to Get-NetTCPConnection while `netstat -ano` can
// still see it.  The probe merges both read-only inventories; this test proves
// it can identify a real disposable loopback listener by PID without starting
// or stopping any scheduled task.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const { once } = require('node:events');
const serviceControl = require('../src/lib/service-control');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'tools', 'port-listener-probe.ps1');
const POWERSHELL = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function startListener() {
  const child = spawn(process.execPath, ['-e', [
    "const net=require('node:net');",
    "const server=net.createServer();",
    "server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port,pid:process.pid})+'\\n'));",
    "process.on('SIGTERM',()=>server.close(()=>process.exit(0)));"
  ].join('')], {
    cwd: ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  let text = '';
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('listener did not report a port within 10 seconds')), 10_000);
    child.stdout.on('data', chunk => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(text.slice(0, newline))); } catch (error) { reject(error); }
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`listener exited before ready (${code})`)));
  });
  return { child, ready };
}

(async () => {
  const { child, ready } = await startListener();
  try {
    const listener = await ready;
    let result;
    if (process.platform === 'win32') {
      const stdout = execFileSync(POWERSHELL, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PROBE, '-Port', String(listener.port)
      ], { cwd: ROOT, encoding: 'utf8', timeout: 15_000, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const raw = JSON.parse(String(stdout).trim());
      assert.ok(Array.isArray(raw.sources) && raw.sources.includes('netstat'), 'the netstat cross-check must be recorded');
      result = raw;
    } else {
      result = serviceControl.defaultProbe(listener.port);
    }
    assert.equal(result.port, listener.port);
    const matched = result.listeners.find(item => item && item.pid === listener.pid && item.localAddress === '127.0.0.1');
    assert.ok(matched, `the probe must find the disposable listener PID ${listener.pid}; received ${JSON.stringify(result)}`);
    assert.equal(typeof matched.accessible, 'boolean');
    assert.equal(typeof matched.startTime, 'string', 'the probe fixture must carry its direct process start time');
    assert.match(matched.startTime, process.platform === 'win32'
      ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/
      : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'the direct process start time must use the platform inventory\'s UTC format');
    console.log('Port listener probe tests passed (the native inventory finds a real loopback listener).');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
