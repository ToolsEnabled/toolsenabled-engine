#!/usr/bin/env node
'use strict';

// Pins every refusal emitted by tools/agent-parity.js, plus both of its named
// exit statuses. Each invocation runs the real CLI from an isolated synthetic
// checkout, so the cases supply actual JSON/TOML configuration values rather
// than replacing the parser or inspecting implementation details.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_TOOL = path.join(ROOT, 'tools', 'agent-parity.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-parity-'));

function jsonConfig(allowlist) {
  return JSON.stringify({
    mcpServers: {
      toolsenabled: { env: { TOOLSENABLED_TOOL_ALLOWLIST: allowlist } }
    }
  });
}

function tomlConfig(allowlist) {
  return `[mcp_servers.toolsenabled.env]\nTOOLSENABLED_TOOL_ALLOWLIST = "${allowlist}"\n`;
}

function write(relative, contents) {
  const file = path.join(temp, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function run(args = []) {
  return spawnSync(process.execPath, [path.join(temp, 'tools', 'agent-parity.js'), ...args], {
    cwd: temp,
    env: { ...process.env, HOME: path.join(temp, 'home'), USERPROFILE: path.join(temp, 'home') },
    encoding: 'utf8'
  });
}

function restoreValidConfigs() {
  const all = 'code.*,search.*,memory.*,task.*,audit.*,system.*';
  write('.mcp.json', jsonConfig(all));
  write('.gemini/settings.json', jsonConfig(all));
  write('.codex/config.toml', tomlConfig(all));
  write('home/.codex/config.toml', tomlConfig(all));
}

try {
  write('tools/agent-parity.js', fs.readFileSync(SOURCE_TOOL));
  restoreValidConfigs();

  // Named success exit code and normal human-readable acceptance.
  let result = run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS - every read-only namespace/);

  // The machine-readable path must carry the same named success status.
  result = run(['--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  let report = JSON.parse(result.stdout);
  assert.equal(report.available, true);
  assert.equal(report.violations, 0);

  // Refusal: a required source is absent.
  fs.unlinkSync(path.join(temp, '.mcp.json'));
  result = run(['--json']);
  assert.equal(result.status, 1, 'a missing source must use the named refusal exit code 1');
  report = JSON.parse(result.stdout);
  assert.deepEqual(report.unavailable.map(({ source, reason }) => ({ source, reason })), [{
    source: 'claude/.mcp.json', reason: 'configuration file is missing'
  }]);
  assert.equal(report.available, false);

  // Refusal: a source exists but cannot be parsed/read.
  restoreValidConfigs();
  write('.gemini/settings.json', '{ definitely not JSON');
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /UNAVAILABLE - 1 required parity source\(s\) could not be checked:/);
  assert.match(result.stdout, /gemini\/.gemini .*configuration cannot be read:/);

  // Refusal: readable configuration contains no usable allowlist.
  restoreValidConfigs();
  write('.codex/config.toml', '[mcp_servers.toolsenabled]\ncommand = "node"\n');
  result = run(['--json']);
  assert.equal(result.status, 1);
  report = JSON.parse(result.stdout);
  assert.deepEqual(report.unavailable.map(({ source, reason }) => ({ source, reason })), [{
    source: 'codex/repo', reason: 'no non-empty TOOLSENABLED_TOOL_ALLOWLIST was found'
  }]);

  // Refusal: a non-exempt profile omits a namespace another profile grants.
  restoreValidConfigs();
  write('.mcp.json', jsonConfig('search.*,memory.*,task.*,audit.*,system.*'));
  result = run(['--json']);
  assert.equal(result.status, 1);
  report = JSON.parse(result.stdout);
  assert.equal(report.violations, 1);
  assert.deepEqual(report.findings.map(({ namespace, profile, exempt }) => ({ namespace, profile, exempt })), [{
    namespace: 'code', profile: 'claude/.mcp.json:toolsenabled', exempt: false
  }]);
  assert.match(report.findings[0].reason, /reachable by 3 of 4 profiles but not this one/);

  // A deliberately read-only named profile is the sole accepted exemption.
  restoreValidConfigs();
  write('.mcp.json', JSON.stringify({ mcpServers: {
    toolsenabled: { env: { TOOLSENABLED_TOOL_ALLOWLIST: 'code.*,search.*,memory.*,task.*,audit.*,system.*' } },
    'toolsenabled-readonly': { env: { TOOLSENABLED_TOOL_ALLOWLIST: 'search.*' } }
  } }));
  result = run(['--json']);
  assert.equal(result.status, 0);
  report = JSON.parse(result.stdout);
  assert.equal(report.violations, 0);
  // search is already granted by this fixture. Only the five missing
  // namespaces are findings, and every one must name the explicit exemption.
  assert.deepEqual(
    report.findings.map(({ namespace, profile, exempt }) => ({ namespace, profile, exempt })),
    ['code', 'memory', 'task', 'audit', 'system'].map(namespace => ({
      namespace, profile: 'claude/.mcp.json:toolsenabled-readonly', exempt: true
    }))
  );

  process.stdout.write('agent-parity refusal and exit-code tests passed\n');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
