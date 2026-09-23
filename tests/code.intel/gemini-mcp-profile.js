'use strict';

// The checked-in Gemini project registration is the documented Gemini agent
// profile. Keep it semantically aligned with the Codex agent profile, except
// for the one deliberate omission: gcloud.account_inspect.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TOOL_ALLOWLIST_ENV,
  listTools,
  parseToolAllowlist
} = require('../../src/lib/tool-registry');

const ROOT = path.resolve(__dirname, '..', '..');
const codexPath = path.join(ROOT, 'adapters', 'codex', 'config.toml.example');
const claudeExamplePath = path.join(ROOT, 'adapters', 'claude', 'mcp.json.example');
const geminiExamplePath = path.join(ROOT, 'adapters', 'gemini', 'settings.json.example');
const CODE_TOOLS = [
  'code.status',
  'code.goto_definition',
  'code.find_references',
  'code.document_symbols',
  'code.workspace_symbols',
  'code.diagnostics',
  'code.hover'
].sort();

function commaList(value) {
  return value.split(',').map(item => item.trim()).filter(Boolean).sort();
}

// Exercise the customer onboarding template as an installed profile without
// reading an operator's untracked .gemini/settings.json. Filling the one path
// placeholder in a temp directory models the documented copy-and-customize
// step while keeping the fixture portable and free of personal paths.
const geminiExample = JSON.parse(fs.readFileSync(geminiExamplePath, 'utf8'));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-mcp-profile-'));
const geminiPath = path.join(fixtureRoot, '.gemini', 'settings.json');
fs.mkdirSync(path.dirname(geminiPath), { recursive: true });
const installedFixture = structuredClone(geminiExample);
installedFixture.mcpServers.toolsenabled.args = [path.join(ROOT, 'tools', 'mcp-owner-proxy.js')];
fs.writeFileSync(geminiPath, `${JSON.stringify(installedFixture, null, 2)}\n`, 'utf8');
process.once('exit', () => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

const gemini = JSON.parse(fs.readFileSync(geminiPath, 'utf8'));
const server = gemini?.mcpServers?.toolsenabled;
assert.ok(server, 'Gemini settings must define mcpServers.toolsenabled');
assert.equal(server.command, 'node');
assert.deepEqual(server.args, [path.join(ROOT, 'tools', 'mcp-owner-proxy.js')]);
assert.equal(path.isAbsolute(server.args[0]), true, 'an installed Gemini profile must use an absolute proxy path');
assert.equal(server.env?.TOOLSENABLED_AGENT_ACTOR, 'gemini');

const geminiAllowlist = server.env?.TOOLSENABLED_TOOL_ALLOWLIST;
assert.equal(typeof geminiAllowlist, 'string', 'Gemini profile must define an allowlist');
assert.ok(commaList(geminiAllowlist).includes('code.*'), 'Gemini profile must expose semantic code tools');

const codexSource = fs.readFileSync(codexPath, 'utf8');
const codexMatch = /^TOOLSENABLED_TOOL_ALLOWLIST\s*=\s*"([^"]+)"/m.exec(codexSource);
assert.ok(codexMatch, 'Codex example must retain a parseable allowlist');
assert.equal(commaList(codexMatch[1]).some(selector => selector.startsWith('telegram.')), false,
  'the shipped Codex profile must not grant a removed provider capability');
const expectedGeminiSelectors = commaList(codexMatch[1]).filter(selector => selector !== 'gcloud.account_inspect');
assert.deepEqual(commaList(geminiAllowlist), expectedGeminiSelectors,
  'Gemini must match the Codex agent profile except for gcloud.account_inspect');

// adapters/gemini/settings.json.example is the portable onboarding template a
// fresh Gemini install would copy (parallel to adapters/codex/config.toml.example
// and adapters/claude/mcp.json.example) — it must stay in lockstep with the same
// derived allowlist, not a hand-maintained copy that can drift.
const geminiExampleServer = geminiExample?.mcpServers?.toolsenabled;
assert.ok(geminiExampleServer, 'adapters/gemini/settings.json.example must define mcpServers.toolsenabled');
assert.equal(geminiExampleServer.command, 'node');
assert.equal(geminiExampleServer.env?.TOOLSENABLED_AGENT_ACTOR, 'gemini');
const geminiExampleAllowlist = geminiExampleServer.env?.TOOLSENABLED_TOOL_ALLOWLIST;
assert.equal(typeof geminiExampleAllowlist, 'string', 'Gemini example must define an allowlist');
assert.deepEqual(commaList(geminiExampleAllowlist), expectedGeminiSelectors,
  'adapters/gemini/settings.json.example must match the Codex agent profile except for gcloud.account_inspect');
assert.deepEqual(commaList(geminiExampleAllowlist), commaList(geminiAllowlist),
  'adapters/gemini/settings.json.example must match the isolated installed-profile fixture');

// The template's launch shape (command + absolute-path args, no project-relative
// cwd) should mirror the Claude portable template, not the project-local .gemini
// registration (which uses a relative path + cwd because it only ever runs from
// this checked-out repo).
const claudeExample = JSON.parse(fs.readFileSync(claudeExamplePath, 'utf8'));
const claudeExampleServer = claudeExample?.mcpServers?.toolsenabled;
assert.ok(Array.isArray(geminiExampleServer.args) && geminiExampleServer.args.length === 1,
  'Gemini example must launch mcp-owner-proxy.js with a single absolute-path arg');
assert.ok(/mcp-owner-proxy\.js$/.test(geminiExampleServer.args[0]));
assert.equal(path.extname(geminiExampleServer.args[0]), '.js');
assert.equal(geminiExampleServer.args[0], claudeExampleServer.args[0],
  'Gemini and Claude portable templates should point at the same install path convention');

const prior = process.env[TOOL_ALLOWLIST_ENV];
try {
  process.env[TOOL_ALLOWLIST_ENV] = geminiAllowlist;
  assert.deepEqual([...parseToolAllowlist(geminiAllowlist)].sort(), commaList(geminiAllowlist),
    'Gemini allowlist must remain accepted by the broker parser');
  const exposed = listTools().map(tool => tool.name).sort();
  for (const tool of CODE_TOOLS) {
    assert.ok(exposed.includes(tool), `Gemini profile must expose ${tool}`);
  }
  assert.ok(!exposed.includes('gcloud.account_inspect'),
    'Gemini profile intentionally excludes gcloud.account_inspect');

  // Re-run the same expansion directly against the portable template's own
  // allowlist string (not just the live .gemini/settings.json copy), so a
  // future edit to adapters/gemini/settings.json.example alone still fails
  // this test if it stops expanding cleanly against the real registry.
  process.env[TOOL_ALLOWLIST_ENV] = geminiExampleAllowlist;
  assert.deepEqual([...parseToolAllowlist(geminiExampleAllowlist)].sort(), commaList(geminiExampleAllowlist),
    'adapters/gemini/settings.json.example allowlist must remain accepted by the broker parser');
  const exampleExposed = listTools().map(tool => tool.name).sort();
  assert.deepEqual(exampleExposed, exposed,
    'adapters/gemini/settings.json.example must expand to the exact same tool set as the installed-profile fixture');

  console.log(`Gemini MCP profile tests passed (${exposed.length} exposed tools, ${CODE_TOOLS.length} semantic code tools).`);
} finally {
  if (prior === undefined) delete process.env[TOOL_ALLOWLIST_ENV];
  else process.env[TOOL_ALLOWLIST_ENV] = prior;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
