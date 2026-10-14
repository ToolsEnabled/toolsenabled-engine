'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const checker = path.join(ROOT, 'tools', 'check-comms-names.js');
const manifestPath = path.join(ROOT, 'config', 'comms-systems.json');
const { doctor } = require('../src/lib/system-status');
const { reservedProviderNamespaces } = require('../tools/check-comms-names');
const { executeTool } = require('./helpers/dispatch');

function run(...args) {
  return spawnSync(process.execPath, [checker, ...args], { cwd: ROOT, encoding: 'utf8' });
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.deepEqual(manifest.systems.map(system => system.id), [
  'agent-comms', 'secure-agent-channel', 'reserved-external-provider-namespaces'
]);
assert.doesNotMatch(JSON.stringify(manifest), /discord/i, 'the manifest must not name a provider the product no longer has');

const valid = run('--identifier', 'agent-comms', '--branch', 'r1162/agentcomms-naming', '--label', 'Agent Comms');
assert.equal(valid.status, 0, valid.stderr);

// COLLISION SUBJECT CHANGED 2026-08-23. This probe used 'internal-telegram',
// which stopped colliding the moment Telegram's reserved provider namespace left
// config/toolsenabled.policy.json with the connector -- the same thing that
// happened to Discord on 2026-08-22. 'internal-instagram' is a namespace the
// policy still declares, so the refusal path is exercised rather than quietly
// passing because nothing collides any more.
const injectedCollision = run('--identifier', 'internal-instagram');
assert.equal(injectedCollision.status, 1, 'deliberately injected reserved-name collision must refuse');
assert.match(injectedCollision.stderr, /reserved provider namespace 'instagram'/);

const historical = run('--historical', '--branch', 'r1162/internal-instagram');
assert.equal(historical.status, 0, historical.stderr);
assert.match(historical.stdout, /historical-or-archived/);
const monetizationDoc = run('--doc', 'docs/coordinator/R1162-MONETIZATION-FABLE-1.md');
assert.equal(monetizationDoc.status, 0, monetizationDoc.stderr);

// Discord left the product on 2026-08-22 (owner ruling, O4). It is not a
// retired-but-reserved namespace any more: the policy does not declare it,
// the guard has no special case for it, the doctor report does not mention
// it, and its tools are simply unknown rather than switched off.
assert.equal(reservedProviderNamespaces().includes('discord'), false, 'policy must not reserve a provider namespace the product does not have');
const report = doctor();
assert.equal(Object.hasOwn(report, 'discord'), false);
assert.equal(Object.hasOwn(report, 'ownerDelivery'), false);
assert.equal(Object.hasOwn(report.credentials, 'discord_bot_token'), false, 'the retired vault keys are not diagnostic inputs');
assert.equal(Object.hasOwn(report.credentialReadiness, 'discordSend'), false);
assert.equal(Object.hasOwn(report.credentialReadiness, 'discordOwnerDelivery'), false);
assert.doesNotMatch(JSON.stringify(report), /discord/i, 'the doctor report must not name Discord anywhere');

// Telegram left the product on 2026-08-23 (owner ruling: "you can rip out
// telegram", because the product now ships its own mobile app). It is held to
// exactly the same standard Discord was one day earlier: not a
// retired-but-reserved namespace, not a switched-off provider, simply not a
// thing this product has.
assert.equal(reservedProviderNamespaces().includes('telegram'), false,
  'policy must not reserve a provider namespace the product does not have');
assert.doesNotMatch(JSON.stringify(manifest), /telegram/i,
  'the manifest must not name a provider the product no longer has');
assert.equal(Object.hasOwn(report, 'telegram'), false);
assert.equal(Object.hasOwn(report.credentials, 'telegram_bot_token'), false,
  'the retired vault keys are not diagnostic inputs');
assert.equal(Object.hasOwn(report.credentials, 'telegram_owner_chat_id'), false);
assert.doesNotMatch(JSON.stringify(report), /telegram/i, 'the doctor report must not name Telegram anywhere');

// Removed provider credentials cannot be newly selected or prompted. Generic
// vault lifecycle tooling remains responsible for deleting historical stored
// values without making these keys live catalogue authority again.
const credentialMetadata = require('../src/lib/credential-metadata');
for (const key of ['telegram_bot_token', 'telegram_owner_chat_id']) {
  assert.equal(Object.hasOwn(credentialMetadata.DEFINITIONS, key), false,
    `${key} must not remain a selectable live credential`);
  assert.equal(credentialMetadata.DIAGNOSTIC_CREDENTIAL_KEYS.includes(key), false,
    `${key} must not be diagnosed as though the product still needed it`);
}
for (const key of ['discord_bot_token', 'discord_owner_channel_id']) {
  assert.ok(Object.hasOwn(credentialMetadata.DEFINITIONS, key),
    `${key} must stay listed so an owner who stored one can still remove it`);
  assert.match(credentialMetadata.DEFINITIONS[key].label, /no longer used; remove it/,
    `${key}'s label must say what to do with it`);
  assert.equal(credentialMetadata.DIAGNOSTIC_CREDENTIAL_KEYS.includes(key), false,
    `${key} must not be diagnosed as though the product still needed it`);
}

// Source-level release guards stay runnable without owner-specific BUILD-QUEUE,
// .gemini, or .mcp fixtures. The fixture-heavy suites exercise the same seams
// when an installation provisions them, but their absence must not hide a
// reintroduced live provider alias, permission, or install-ready claim.
const digestLibrarySource = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'agent-digest', 'index.js'), 'utf8');
const digestCliSource = fs.readFileSync(path.join(ROOT, 'src', 'agent-digest.js'), 'utf8');
assert.doesNotMatch(`${digestLibrarySource}\n${digestCliSource}`, /message\.telegram(?:Caption)?/,
  'digest generation must not recreate removed provider-shaped preview aliases');
assert.doesNotMatch(digestCliSource, /--- TELEGRAM/,
  'the digest CLI must use provider-neutral headings');

const codexProfileSource = fs.readFileSync(path.join(ROOT, 'adapters', 'codex', 'config.toml.example'), 'utf8');
const codexAllowlist = /^TOOLSENABLED_TOOL_ALLOWLIST\s*=\s*"([^"]+)"/m.exec(codexProfileSource);
assert.ok(codexAllowlist, 'Codex example must retain a parseable allowlist');
assert.equal(codexAllowlist[1].split(',').some(selector => selector.trim().startsWith('telegram.')), false,
  'the shipped Codex profile must not grant a removed provider capability');
assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8'), /Telegram/i,
  'the installer must not claim a removed provider or bridge is release-ready');

// Narrow owner-delivery regression: this intentionally avoids the unrelated
// real-Chromium image assertion in tests/owner-delivery.js.
const ownerDelivery = require('../src/lib/owner-delivery');
assert.deepEqual([...ownerDelivery.CHANNELS], ['email']);
assert.equal(ownerDelivery.CHANNELS.includes('agent-comms'), false,
  'the product-native journal is not a selectable legacy digest transport');
assert.equal(ownerDelivery.DELIVERY_RECORD_CHANNELS.includes('agent-comms'), true,
  'product-native owner alarm outcomes must retain their truthful channel');
for (const retiredExport of [
  'TELEGRAM_BUDGET', 'TELEGRAM_CAPTION_BUDGET', 'TELEGRAM_CAPTION_MAX_CHARS',
  'TELEGRAM_MAX_CHARS', 'escapeTelegramHtml', 'isTelegramChannel'
]) {
  assert.equal(Object.hasOwn(ownerDelivery, retiredExport), false,
    `owner-delivery must not export retired provider surface ${retiredExport}`);
}
const deliveryTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-delivery-channel-contract-'));
try {
  const recordFile = path.join(deliveryTemp, 'owner-delivery.json');
  const recorded = ownerDelivery.recordDelivery({
    purpose: 'owner-alarm', channel: 'agent-comms', ok: true,
    rendered: 'text', characters: 17
  }, { recordFile, record: () => {}, now: () => 1_788_000_000_000 });
  assert.equal(recorded.persisted, true);
  assert.equal(recorded.entry.channel, 'agent-comms');
  assert.equal(ownerDelivery.readDeliveryRecord(recordFile).lastSuccess.channel, 'agent-comms');
} finally {
  fs.rmSync(deliveryTemp, { recursive: true, force: true });
}

(async () => {
  for (const tool of [
    'discord.send', 'discord.command.read', 'discord.command.reply',
    // The five telegram.* tools and system.ask_remote, which was implemented by
    // providers/messaging.telegramAskRemote and could not outlive the connector.
    'telegram.send', 'telegram.poll', 'telegram.worker_run',
    'telegram.command.read', 'telegram.command.reply', 'system.ask_remote'
  ]) {
    await assert.rejects(
      executeTool(tool, { channelId: '12345678901234567', text: 'removed-path-probe' }),
      error => error && error.code === 'UNKNOWN_TOOL',
      `${tool} must be unknown, not merely disabled`
    );
  }
  process.stdout.write('comms naming contract passed (manifest, collision refusal, and no Discord or Telegram anywhere).\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
