'use strict';

const isolated = require('./lib/isolated-environment').activate('playwright-smoke');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const packageInfo = require('../package.json');
const { ROOT } = require('../src/lib/runtime');
const audit = require('../src/lib/audit');
const killSwitch = require('../src/lib/kill-switch');
const browserOwner = require('../src/lib/browser-owner');

const profileFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-claude-profile-'));
const claudeSettingsPath = path.join(profileFixture, '.claude', 'settings.json');
fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
fs.writeFileSync(claudeSettingsPath, JSON.stringify({
  permissions: { allow: ['mcp__toolsenabled__*', 'mcp__playwright__*'] }
}, null, 2), 'utf8');
process.once('exit', () => {
  try { fs.rmSync(profileFixture, { recursive: true, force: true }); } catch { /* disposable fixture */ }
});

assert.equal(path.dirname(killSwitch.status().path), isolated.root,
  'browser smoke tests must never inspect or mutate the repository KILLSWITCH');
assert.equal(path.dirname(process.env.TOOLSENABLED_AUDIT_DB), isolated.root);
assert.equal(path.dirname(process.env.TOOLSENABLED_VAULT_PATH), isolated.root);

const launcher = path.join(ROOT, 'tools', 'playwright-mcp.cmd');
const launcherText = fs.readFileSync(launcher, 'utf8');
assert.match(launcherText, /@playwright\/mcp@0\.0\.78\b/, 'Playwright MCP must be pinned to the verified package version.');
assert.doesNotMatch(launcherText, /@playwright\/mcp@latest\b/, 'Playwright MCP must not use the drifting latest tag.');
const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
assert.ok(claudeSettings.permissions.allow.includes('mcp__toolsenabled__*'), 'Claude must allow the ToolsEnabled MCP server.');
assert.ok(claudeSettings.permissions.allow.includes('mcp__playwright__*'), 'Claude must allow the Playwright MCP server.');
const ownedBrowser = browserOwner.start('https://example.com/');
const child = spawn('cmd.exe', ['/d', '/s', '/c', launcher], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
let stderr = '';
let settled = false;
let activatedForTest = false;
child.stderr.on('data', chunk => { stderr += chunk; });

function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
function finish(error) {
  if (settled) return;
  settled = true;
  if (activatedForTest) {
    killSwitch.deactivate();
    activatedForTest = false;
  }
  child.stdin.end();
  setTimeout(() => { if (!child.killed) child.kill(); }, 1000).unref();
  try { browserOwner.stop(ownedBrowser.generation); }
  catch (stopError) {
    if (!error) error = stopError;
  }
  if (error) { console.error(error.stack || error.message); process.exitCode = 1; }
  else console.log('Playwright MCP navigation smoke test passed.');
}

const timeout = setTimeout(() => finish(new Error(`Playwright MCP smoke test timed out. ${stderr}`)), 45_000);
timeout.unref();

lines.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return finish(new Error(`Non-JSON Playwright MCP output: ${line}`)); }
  if (message.id === 1 && message.result) {
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } } });
  } else if (message.id === 2) {
    try {
      assert.ok(message.result, message.error && message.error.message || 'Navigation returned no result.');
      const text = JSON.stringify(message.result);
      assert.match(text, /Example Domain|example\.com/i);
      assert.equal(killSwitch.status().active, false, 'Browser smoke requires an initially inactive kill switch.');
      killSwitch.activate();
      activatedForTest = true;
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.org/should-not-open' } } });
    } catch (error) { finish(error); }
  } else if (message.id === 3) {
    clearTimeout(timeout);
    try {
      assert.equal(message.result && message.result.isError, true);
      assert.match(JSON.stringify(message.result), /KILLSWITCH is active/);
      const recent = JSON.stringify(audit.tail(20));
      assert.match(recent, /playwright\.tool\.succeeded/);
      assert.match(recent, /playwright\.tool\.blocked/);
      finish();
    } catch (error) { finish(error); }
  }
});

child.on('error', finish);
child.on('close', code => { if (!settled) finish(new Error(`Playwright MCP exited ${code}. ${stderr}`)); });
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'toolsenabled-smoke', version: packageInfo.version } } });
