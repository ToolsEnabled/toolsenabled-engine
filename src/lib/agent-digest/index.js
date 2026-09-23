'use strict';

// Production wiring for the agentic-workflow digest.
//
// ARCHITECTURAL CONSTRAINT (R46): this service calls the selected
// owner-delivery transport DIRECTLY, in-process, with a plain Node require. It
// must never be routed through an MCP client session -- the controller's own
// session has a restricted tool set and a bounded lifetime, so anything behind
// it would stop working silently the moment that session exited. The digest has
// to survive session exits and machine reboots, so it owns its own process.
//
// Calling the providers directly keeps every existing boundary intact: each
// one calls assertActive() (kill switch + policy) and writes its own signed
// audit record. Nothing here bypasses either.
//
// DELIVERY CHANNEL (R84). The transport is NOT decided here. It comes from
// src/lib/owner-delivery.js, which reads the single `channel` setting in
// config/owner-delivery.json. That used to be one of four values, three of them
// Telegram; since 2026-08-23 'email' is the only one left. The branch below is
// still the only place that reads it, so adding the owner's chosen replacement
// is one branch here and one config edit, and it is still structurally
// impossible for one slot to deliver on two channels: the branch is exclusive.
//
// TRANSPORT DOWN AT SLOT TIME: the slot is SKIPPED WITH A DURABLE RECORD, not
// queued and not re-routed. Reasoning in the send() comment below.

const path = require('node:path');
const { rootPath, readJson } = require('../runtime');
const ownerDelivery = require('../owner-delivery');
const { DigestSchedule, JsonSettingsStore, normalizeGrid } = require('./schedule');
const { collectDigestState, collectFallbackState, digestFingerprint } = require('./collect');
const { renderDigest, renderFallback } = require('./render');
const { AgentDigestService, DEFAULT_TICK_MS, DEFAULT_TIMEOUT_MS } = require('./service');

const CONFIG_FILE = () => rootPath('config', 'agent-digest.json');
const STATE_FILE = () => rootPath('state', 'agent-digest.json');
const FINGERPRINT_KEY = 'agent_digest_last_fingerprint';

// A SENDING SYSTEM IS SWITCHED ON BY A STATEMENT, NEVER BY SILENCE.
//
// This read `raw.enabled !== false` over `readJson(file, {})`, and readJson
// returns the fallback for ENOENT. So a MISSING config/agent-digest.json --
// a fresh checkout, a payload that did not carry the file, a config a user
// deleted precisely to stop the mails -- produced `{}`, and `{}.enabled !==
// false` is true. Deleting the configuration for an emailing subsystem turned
// it ON. That is absence read as consent on an outward-sending surface, which
// is the worst place in the product to have it.
//
// Now only the literal `true` enables it, and the config states WHY it is off
// so `--status` and the service log can say which absence they met rather than
// printing a bare "disabled". The shipped config/agent-digest.json carries
// `"enabled": true`, so nothing about the configured installation changes.
function loadConfig(file = CONFIG_FILE()) {
  const present = readJson(file, null);
  const raw = present || {};
  const config = {
    enabled: raw.enabled === true,
    enabledReason: raw.enabled === true
      ? null
      : (present === null
        ? `no configuration file at ${file}, so the digest is withheld rather than assumed`
        : (raw.enabled === false
          ? 'the configuration sets enabled: false'
          : 'the configuration does not set enabled: true, and the digest is not enabled by silence')),
    account: typeof raw.account === 'string' && raw.account ? raw.account : undefined,
    tickMs: Number.isFinite(raw.tickSeconds) && raw.tickSeconds > 0 ? Math.round(raw.tickSeconds * 1000) : DEFAULT_TICK_MS,
    generationTimeoutMs: Number.isFinite(raw.generationTimeoutMs) && raw.generationTimeoutMs > 0
      ? raw.generationTimeoutMs : DEFAULT_TIMEOUT_MS,
    grid: raw.grid === undefined ? undefined : normalizeGrid(raw.grid)
  };
  return config;
}

// The recipient is the configured Google account's own address, resolved from
// the existing config/google-accounts.profile.json registry. No new copy of
// the owner's email is introduced by this feature, and the address is never
// written into a digest body, a log line, or a memory record.
function resolveRecipient(config, accounts = require('../google-accounts')) {
  const alias = accounts.resolve(config.account);
  const registry = accounts.load();
  const email = registry.accounts[alias] && registry.accounts[alias].email;
  if (typeof email !== 'string' || !email.includes('@')) {
    throw Object.assign(new Error(`Google account '${alias}' has no registered address to send the digest to.`),
      { code: 'AGENT_DIGEST_RECIPIENT_UNRESOLVED' });
  }
  return { alias, email };
}

function readFingerprint(store) {
  const raw = store.getSetting(FINGERPRINT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`The persisted agent digest fingerprint could not be parsed: ${error.message}`),
      { code: 'AGENT_DIGEST_FINGERPRINT_INVALID', cause: error });
  }
}

function writeFingerprint(store, fingerprint) {
  store.setSetting(FINGERPRINT_KEY, JSON.stringify(fingerprint));
}

function createProviderGateway(log) {
  try {
    const { CliProviderGateway } = require('../providers/cli-provider-gateway');
    return new CliProviderGateway();
  } catch (error) {
    log('error', `agent digest could not open the provider gateway: ${error && error.code ? error.code : 'error'}`);
    return null;
  }
}

function createAgentDigestService(overrides = {}) {
  const log = overrides.log || (() => {});
  const config = overrides.config || loadConfig();
  const store = overrides.store || new JsonSettingsStore(overrides.stateFile || STATE_FILE());
  const schedule = overrides.schedule || new DigestSchedule({ store, defaults: config.grid });
  // The durable-run control adapter left with the local worker integration; a
  // digest process may still be handed one explicitly, otherwise runs are a
  // named DATA GAP in the message, never a silent zero.
  const runControl = overrides.runControl !== undefined ? overrides.runControl : null;
  const providerGateway = overrides.providerGateway !== undefined ? overrides.providerGateway : createProviderGateway(log);
  const auditModule = overrides.auditModule || require('../audit');
  const auditDependencies = overrides.auditDependencies || {};
  const gmail = overrides.gmail || require('../providers/google');

  const delivery = overrides.delivery || ownerDelivery;
  const imageRenderer = overrides.imageRenderer !== undefined ? overrides.imageRenderer : null;
  const channelOptions = overrides.channelOptions || {};
  const resolveDeliveryChannel = overrides.resolveChannel || (() => delivery.resolveChannel(channelOptions));

  // The banner the NEXT message carries when the previous one never arrived.
  // A channel that is down cannot tell him it failed, so the next message does.
  const previousFailure = overrides.previousFailure !== undefined ? overrides.previousFailure : (() => {
    const status = delivery.deliveryStatus({ ...overrides.deliveryDependencies, channelOptions });
    if (!status.lastFailure || status.consecutiveFailures === 0) return null;
    return { ...status.lastFailure, consecutiveFailures: status.consecutiveFailures };
  });

  /* THE DEFAULT IS NOW RESOLVED WHEN ASKED FOR, so it can refuse. It used to be
     a module-level constant in owner-delivery, which meant a registry that
     declares no dashboard -- the SHIPPED default on every customer machine --
     threw a raw TypeError while that module was still being loaded. Resolution
     failures must propagate: an unreadable channel or registry does not prove
     that the digest has no dashboard URL. */
  const resolvedDashboardChannel = resolveDeliveryChannel();
  const dashboardUrl = resolvedDashboardChannel.config.dashboardUrl || delivery.defaultDashboardUrl();

  const generate = overrides.generate || (async ({ fireKey, kind }) => {
    const state = await collectDigestState({
      nowMs: Date.now(), auditModule, auditDependencies, runControl, providerGateway,
      previous: readFingerprint(store)
    });
    const message = renderDigest({
      state, kind, fireKey, mode: 'full', dashboardUrl,
      previousFailure: typeof previousFailure === 'function' ? previousFailure() : previousFailure
    });
    message.state = state;
    message.fingerprint = digestFingerprint(state);
    return message;
  });

  const fallback = overrides.fallback || (async ({ fireKey, kind, reason }) => {
    const state = collectFallbackState({ nowMs: Date.now(), auditModule, auditDependencies, reason });
    const message = renderFallback({
      state, kind, fireKey, dashboardUrl,
      previousFailure: typeof previousFailure === 'function' ? previousFailure() : previousFailure
    });
    message.state = state;
    return message;
  });

  // The image path, isolated so a missing/failing Playwright can never take
  // the report down with it. A failure here degrades to the text report and is
  // reported as a named degradedReason -- never a silent text send, and never
  // a broken or empty picture.
  const renderImage = overrides.renderImage || (async message => {
    const renderer = imageRenderer || require('./render-image');
    const { image } = await renderer.renderReportImage({
      state: message.state,
      kind: message.kind,
      fireKey: message.fireKey,
      mode: message.mode
    });
    return image;
  });

  const send = overrides.send || (async message => {
    const resolved = resolveDeliveryChannel();
    const deliveryDependencies = overrides.deliveryDependencies || {};
    const purpose = 'agent-digest';
    let attempt = { channel: resolved.channel, purpose };

    try {
      // ONE BRANCH LEFT. There were four channels and three of them were Telegram;
      // they went with the connector on 2026-08-23. This is deliberately still
      // written as a branch on the resolved channel rather than collapsed to an
      // unconditional email send: resolveChannel() is the thing that decides, and
      // when the owner picks a replacement channel it gets added HERE, beside this
      // one, exactly as the telegram branches were. The `else` is not dead code --
      // it is what makes a future unknown channel fail loudly instead of silently
      // emailing.
      if (resolved.channel === 'email') {
        const { email } = resolveRecipient(config);
        const result = await gmail.gmailSend({
          to: email, subject: message.subject, text: message.text,
          html: typeof message.html === 'string' ? message.html : null,
          account: config.account
        });
        attempt = { ...attempt, ok: true, rendered: 'email', characters: message.text.length };
        delivery.recordDelivery(attempt, deliveryDependencies);
        if (message.fingerprint) writeFingerprint(store, message.fingerprint);
        return result;
      }
      throw new delivery.OwnerDeliveryError('OWNER_DELIVERY_CHANNEL_UNSUPPORTED',
        `The agent digest has no sender for the '${resolved.channel}' channel.`);
    } catch (error) {
      // A failed delivery is RECORDED, never swallowed, and the delta baseline
      // deliberately does NOT advance -- so the next digest that does arrive
      // still covers the window the owner never saw, instead of telling him
      // nothing moved.
      //
      // BRIDGE DOWN AT SLOT TIME -> SKIP WITH A RECORD. Not queued: a digest
      // is a snapshot with a timestamp in it, and delivering 08:00's state at
      // 14:00 is a lie with a fresh notification sound; the hourly cadence
      // means the next slot supersedes it anyway. Not silently re-routed to
      // email either: the owner just said to move off email, and an automatic
      // fallback would quietly undo the instruction and hide the outage. So
      // the slot is skipped, the failure is durable in
      // state/owner-delivery.json, `--status` shows it, a signed audit event
      // records it, and the next message that DOES land opens with a banner
      // saying a previous delivery failed.
      delivery.recordDelivery({ ...attempt, ok: false, code: delivery.safeCode(error) },
        overrides.deliveryDependencies || {});
      throw error;
    }
  });

  const service = new AgentDigestService({
    schedule, generate, fallback, send, log,
    timeoutMs: config.generationTimeoutMs,
    tickMs: config.tickMs
  });
  return {
    config, schedule, service, store, generate, fallback, send, renderImage,
    channel: resolveDeliveryChannel, dashboardUrl
  };
}

module.exports = {
  CONFIG_FILE, FINGERPRINT_KEY, STATE_FILE,
  createAgentDigestService, loadConfig, readFingerprint, resolveRecipient, writeFingerprint,
  configPath: () => path.resolve(CONFIG_FILE())
};
