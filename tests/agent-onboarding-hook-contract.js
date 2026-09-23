'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const onboarding = require('../src/lib/agent-onboarding');
const { mergeClientHooks } = require('../tools/merge-client-hooks');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'agent-onboarding.js');
const MERGER_CLI = path.join(ROOT, 'tools', 'merge-client-hooks.js');
const CODEX_TEMPLATE = path.join(ROOT, 'config', 'client-hooks', 'codex-hooks.json');
const CLAUDE_TEMPLATE = path.join(ROOT, 'config', 'client-hooks', 'claude-settings.json');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-hook-contract-'));

// Recorded field shapes from the clients' SessionStart/SubagentStart contracts.
// Values are synthetic; the shape, event names, and cwd/model/agent fields are
// what the adapter must continue to accept.
const EVENTS = Object.freeze({
  SessionStart: Object.freeze({
    session_id: 'session-fixture', cwd: runtime, model: 'gpt-5.6-sol',
    hook_event_name: 'SessionStart', source: 'startup'
  }),
  SubagentStart: Object.freeze({
    session_id: 'session-fixture', cwd: runtime, model: 'gpt-5.6-terra',
    hook_event_name: 'SubagentStart', agent_id: 'child-fixture', agent_type: 'observer'
  })
});

function cleanEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('TOOLSENABLED_AGENT_') || key.startsWith('TOOLSENABLED_ONBOARDING_')) delete environment[key];
  }
  return environment;
}

function invoke(client, event, extra = []) {
  return spawnSync(process.execPath, [CLI, '--hook', '--provider', client,
    '--runtime', runtime, '--project', runtime, ...extra], {
    cwd: ROOT,
    input: JSON.stringify(event),
    encoding: 'utf8',
    windowsHide: true,
    env: cleanEnvironment()
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function verifyInstallerMerge(codexTemplate, claudeTemplate) {
  const home = path.join(runtime, 'disposable-in-fence-home');
  const claudeSettings = path.join(home, '.claude', 'settings.json');
  writeJson(claudeSettings, {
    customCustomerSetting: { untouched: true },
    permissions: { allow: ['Read'], deny: ['Bash(rm *)'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'customer-session-hook' }] }] }
  });

  const cliResult = spawnSync(process.execPath, [MERGER_CLI,
    '--settings', claudeSettings, '--template', CLAUDE_TEMPLATE, '--client', 'Claude'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true
  });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.equal(JSON.parse(cliResult.stdout).ok, true);
  const mergedClaude = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
  assert.deepEqual(mergedClaude.customCustomerSetting, { untouched: true });
  assert.deepEqual(mergedClaude.permissions.deny, ['Bash(rm *)']);
  assert.deepEqual(mergedClaude.permissions.allow,
    ['Read', 'mcp__toolsenabled__*', 'mcp__playwright__*']);
  assert.equal(mergedClaude.hooks.SessionStart[0].hooks[0].command, 'customer-session-hook');
  assert.equal(mergedClaude.hooks.SessionStart.length, 3,
    'customer hook plus the two ToolsEnabled SessionStart groups');

  const firstMerge = fs.readFileSync(claudeSettings, 'utf8');
  mergeClientHooks({ settingsPath: claudeSettings, templatePath: CLAUDE_TEMPLATE, clientName: 'Claude' });
  assert.equal(fs.readFileSync(claudeSettings, 'utf8'), firstMerge, 'rerun must be byte-idempotent');

  const codexSettings = path.join(home, 'new-codex-home', '.codex', 'hooks.json');
  mergeClientHooks({ settingsPath: codexSettings, templatePath: CODEX_TEMPLATE, clientName: 'Codex' });
  assert.deepEqual(JSON.parse(fs.readFileSync(codexSettings, 'utf8')), codexTemplate,
    'missing settings and parent directories receive only the neutral Codex template');

  const hostileCases = [
    ['broken JSON', '{'],
    ['top-level array', '[]\n'],
    ['scalar hooks', '{"hooks":"wrong"}\n'],
    ['scalar permissions allow', '{"permissions":{"allow":"Read"}}\n']
  ];
  for (const [name, contents] of hostileCases) {
    const settingsPath = path.join(home, 'hostile', `${name.replaceAll(' ', '-')}.json`);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, contents, 'utf8');
    assert.throws(() => mergeClientHooks({
      settingsPath, templatePath: CLAUDE_TEMPLATE, clientName: 'Claude'
    }), /JSON|object|array/i, name);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), contents, `${name} must remain byte-identical`);
  }

  const protectedSettings = path.join(home, 'protected-settings.json');
  const protectedContents = '{"customer":true}\n';
  fs.writeFileSync(protectedSettings, protectedContents, 'utf8');
  assert.throws(() => mergeClientHooks({
    settingsPath: protectedSettings,
    templatePath: path.join(home, 'missing-template.json'),
    clientName: 'Codex'
  }), /template is missing/i);
  assert.equal(fs.readFileSync(protectedSettings, 'utf8'), protectedContents,
    'missing template must not alter settings');

  const malformedTemplate = path.join(home, 'malformed-template.json');
  fs.writeFileSync(malformedTemplate, '{"hooks":{"SessionStart":"wrong"}}\n', 'utf8');
  assert.throws(() => mergeClientHooks({
    settingsPath: protectedSettings, templatePath: malformedTemplate, clientName: 'Codex'
  }), /template hook.*array/i);
  assert.equal(fs.readFileSync(protectedSettings, 'utf8'), protectedContents,
    'malformed template must not alter settings');

  const installSource = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  assert.match(installSource, /tools\/merge-client-hooks\.js/);
  assert.match(installSource, /config\/client-hooks\/claude-settings\.json/);
  assert.match(installSource, /config\/client-hooks\/codex-hooks\.json/);
  assert.doesNotMatch(installSource, /\.claude\/settings\.json\.template|\.codex\/hooks\.json\.template/);
  assert.doesNotMatch(installSource, /\$required\s*=.*['"]\.mcp\.json['"]/,
    'install must not require a machine-specific MCP file before first-run setup generates it');
  assert.match(installSource, /node tools\/mcsetup\.js run/,
    'install must name the existing first-run command that generates the workspace MCP configuration');

  assert.deepEqual(claudeTemplate.hooks.SessionStart.length, 2);
  for (const [client, template] of [['Codex', codexTemplate], ['Claude', claudeTemplate]]) {
    assert.equal(template.hooks.PreToolUse.length, 1, `${client} installs one ordered PreToolUse group`);
    const serialized = JSON.stringify(template.hooks.PreToolUse[0].hooks);
    for (const file of ['clarify-gate-hook.js', 'no-blocking-prompt-hook.js', 'standing-orders-hook.js']) {
      assert.match(serialized, new RegExp(file.replace('.', '\\.')),
        `${client} installs the promised ${file} enforcement hook`);
    }
  }
}

try {
  const codex = JSON.parse(fs.readFileSync(CODEX_TEMPLATE, 'utf8'));
  const claude = JSON.parse(fs.readFileSync(CLAUDE_TEMPLATE, 'utf8'));
  for (const [client, hooks] of [['codex', codex.hooks], ['claude', claude.hooks]]) {
    for (const eventName of Object.keys(EVENTS)) {
      // Each event is pinned to its exact declared entries -- no silent hook
      // drift in either direction. Claude's SessionStart carries exactly one
      // entry beyond onboarding: the fail-open presence autoregister hook
      // (owner fix directive 2026-08-12, re-pointed here per RECORD 4: pins
      // move to the newest directive, they do not get deleted or loosened).
      // Onboarding must stay FIRST so the packet precedes registration.
      assert.ok(Array.isArray(hooks[eventName]));
      if (client === 'claude' && eventName === 'SessionStart') {
        assert.equal(hooks[eventName].length, 2, 'claude SessionStart: onboarding + autoregister, nothing else');
        assert.match(hooks[eventName][0].hooks[0].args.join(' '), /agent-onboarding\.js/);
        assert.match(hooks[eventName][1].hooks[0].args.join(' '), /claude-session-autoregister\.js/);
      } else {
        assert.equal(hooks[eventName].length, 1);
      }
      for (const group of hooks[eventName]) {
        for (const handler of group.hooks) assert.equal(handler.type, 'command');
      }
      const result = invoke(client, EVENTS[eventName]);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.hookSpecificOutput.hookEventName, eventName);
      if (eventName === 'SubagentStart') {
        assert.equal(result.status, 1, `${client} ${eventName} must fail closed without live role/settings sources`);
        assert.equal(envelope.continue, false);
        assert.match(envelope.stopReason, /AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED/);
        continue;
      }
      assert.equal(result.status, 0, `${client} ${eventName}: ${result.stderr}`);
      assert.equal(envelope.continue, true);
      assert.match(envelope.hookSpecificOutput.additionalContext, /BEGIN TOOLSENABLED DYNAMIC ONBOARDING PACKET v1/);
      assert.match(envelope.hookSpecificOutput.additionalContext, /"projectRoot":".*toolsenabled-hook-contract-/);
      assert.doesNotMatch(envelope.hookSpecificOutput.additionalContext, /coordinator-sol|Claude session is coordinator/i);
    }
  }

  const mutation = invoke('codex', { ...EVENTS.SubagentStart, agent_type: 'builder' });
  assert.equal(mutation.status, 1);
  const refusal = JSON.parse(mutation.stdout);
  assert.equal(refusal.continue, false, 'mutation-capable hooks fail closed without live collision/settings sources');
  assert.equal(refusal.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.match(refusal.stopReason, /AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED/);

  const unknownMutation = invoke('codex', { ...EVENTS.SubagentStart, agent_type: 'general-purpose' });
  assert.equal(unknownMutation.status, 1);
  const unknownRefusal = JSON.parse(unknownMutation.stdout);
  assert.equal(unknownRefusal.continue, false,
    'unknown subagent types fail into the mutation-capable live-context profile');
  assert.match(unknownRefusal.stopReason, /AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED/);

  const missingType = { ...EVENTS.SubagentStart };
  delete missingType.agent_type;
  const missingTypeMutation = invoke('codex', missingType);
  assert.equal(missingTypeMutation.status, 1);
  assert.equal(JSON.parse(missingTypeMutation.stdout).continue, false,
    'a type-less SubagentStart fails into the mutation-capable live-context profile');

  for (const eventName of ['SessionStart', 'SubagentStart']) {
    const definition = codex.hooks[eventName][0].hooks[0];
    assert.match(definition.command, /git rev-parse --show-toplevel/);
    assert.match(definition.commandWindows, /git rev-parse --show-toplevel/);
    assert.match(definition.commandWindows, /Join-Path \$r 'tools\/agent-onboarding\.js'/);
    assert.doesNotMatch(definition.commandWindows, /C:\\Users\\|Desktop\\/i, 'Codex hook root is project-dynamic');
  }
  assert.ok(codex.hooks.SessionStart[0].hooks[0].additionalContextLimit >= onboarding.MAX_RENDERED_BYTES.full);
  assert.ok(codex.hooks.SubagentStart[0].hooks[0].additionalContextLimit >= onboarding.MAX_RENDERED_BYTES.task);

  for (const eventName of ['SessionStart', 'SubagentStart']) {
    const definition = claude.hooks[eventName][0].hooks[0];
    assert.equal(definition.command, 'node');
    assert.equal(definition.args[0], '${CLAUDE_PROJECT_DIR}/tools/agent-onboarding.js');
    assert.equal(Object.hasOwn(definition, 'commandWindows'), false,
      'Claude does not implement the Codex commandWindows field');
    assert.equal(Object.hasOwn(definition, 'additionalContextLimit'), false,
      'Claude does not implement the Codex additionalContextLimit field');
  }

  verifyInstallerMerge(codex, claude);

  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'AGENT-ONBOARDING.md'), 'utf8');
  assert.match(doc, /project hooks run\s+only for trusted repositories/i);
  assert.match(doc, /Codex `\/hooks`/);
  assert.match(doc, /Raw interactive clients that ignore project hooks cannot be mechanically\s+covered/i);
  assert.match(doc, /Shadow Manager is an ordinary read-only advisory role/i);
  assert.match(doc, /It reviews and\s+reports; it is not a service, daemon, global supervisor, dispatcher, or\s+fallback sweep actor/i);
  assert.match(doc, /Elevation under that same\s+principal must remain pinned to the same installation owner and must not select\s+a second ToolsEnabled tree/i);

  const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'payload-boundary.json'), 'utf8'));
  assert.ok(payload.open.paths.includes('docs/AGENT-ONBOARDING.md'),
    'the customer-neutral onboarding directions must be included in the open payload');
  for (const shippedPath of [
    'config/client-hooks/claude-settings.json',
    'config/client-hooks/codex-hooks.json',
    'tools/merge-client-hooks.js'
  ]) assert.ok(payload.open.paths.includes(shippedPath), `${shippedPath} must ship in the open payload`);

  console.log('agent onboarding hook contract passed (2 client-specific schemas, merge refusals, mutation fail-closed, activation gap explicit).');
} finally {
  fs.rmSync(runtime, { recursive: true, force: true });
}
