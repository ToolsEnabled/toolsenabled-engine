'use strict';

// The legacy delivery switch for the scheduled agent digest and Duo notice.
// Email is the only selectable transport. Historical config values name no
// live provider and resolve to email with a named fallback reason; they are not
// silently aliased onto another channel.
//
// Product-native owner alarms use the agent-comms journal directly rather than
// selecting a transport here. Those bounded callers may still record their
// truthful outcome in state/owner-delivery.json, so operational status can show
// where an attempt actually went without advertising agent-comms as a legacy
// digest transport.
//
// Every attempt record is bounded and atomic. It stores purpose, channel,
// outcome, an error code, and content sizes, never message text. That matters
// for the Duo path, whose body can contain a short-lived second factor.

const fs = require('node:fs');
const path = require('node:path');

const { rootPath, readJson } = require('./runtime');
const { loadRegistry } = require('./service-registry');

const CONFIG_FILE = () => rootPath('config', 'owner-delivery.json');
// Redirectable, and tests/lib/isolated-environment.js sets it for every
// isolated run. Without that, a test that exercises the send path writes its
// synthetic failures into the PRODUCTION record and makes `--status` report a
// delivery outage that never happened -- which is exactly the lie this record
// exists to prevent.
const RECORD_FILE = () => process.env.TOOLSENABLED_OWNER_DELIVERY_PATH
  || rootPath('state', 'owner-delivery.json');
const RECORD_VERSION = 1;
const RECENT_LIMIT = 20;

// 'discord-text' was a fifth channel until 2026-08-22. Discord left the product
// entirely (owner ruling, O4). A config that still names it is not special-
// cased: normalizeChannel() returns null for it exactly as for any unknown
// value, and resolveChannel() falls back to the default with its existing
// typed reason -- the owner sees why, nothing is silently rewritten.
const CHANNELS = Object.freeze(['email']);
// The four telegram-* values are NOT special-cased into an alias, exactly as
// 'discord-text' was not when Discord left. normalizeChannel() returns null for
// them like any unknown value and resolveChannel() falls back to the default
// carrying its existing typed reason, so an installation whose config still says
// 'telegram-image-full' is TOLD why it is getting email instead of having its
// stored choice quietly rewritten underneath it.
const CHANNEL_ALIASES = Object.freeze({});
const DEFAULT_CHANNEL = 'email';
// The local owner journal is not a selectable transport in this legacy
// delivery switch, but bounded callers that use the product-native channel
// still record its truthful outcome here.
const DELIVERY_RECORD_CHANNELS = Object.freeze([...CHANNELS, 'agent-comms']);
// This is the FALLBACK used when config/owner-delivery.json is missing or
// unreadable, so it must track the real service, not a frozen copy of it --
// derived from the same authority as everything else this session. The
// config file's own dashboardUrl field is left alone: it sits beside
// genuinely owner-editable fields (channel, emailAccount) and is registered
// as owner-configurable, not as a mirror that must always match.
/* RESOLVED WHEN IT IS NEEDED, NOT WHEN THIS FILE IS LOADED.
 *
 * This used to be a module-level const. On a CUSTOMER MACHINE that meant this
 * module could not be required at all: the shipped default service registry
 * (capability-defaults/config/service-registry.json) declares NO services --
 * deliberately, because the builder's own registry describes the builder's own
 * machines and none of that is any business of a customer -- so reading
 * `.dashboard.port` off it threw `TypeError: Cannot read properties of
 * undefined` before a single line of this module ran. Verified against the
 * registry actually installed on this machine.
 *
 * A module-scope throw is the worst shape available: it takes down every
 * importer, whether or not they were going to use the value, and it does it
 * with a raw TypeError rather than one of this product's named refusals. That
 * is how a Telegram module's identical line came to make the coordinator's
 * whole escalation path unloadable.
 *
 * So it is a function, and a caller that genuinely needs the port gets a NAMED
 * refusal naming the thing that is missing. A caller that does not need it is
 * not punished for importing the file. */
let defaultDashboardUrlCache = null;
function defaultDashboardUrl() {
  if (defaultDashboardUrlCache === null) {
    const services = loadRegistry().services || {};
    const dashboard = services.dashboard;
    if (!dashboard || typeof dashboard.port !== 'number') {
      const error = new Error('This installation declares no dashboard service, so there is no address to send anybody to.');
      error.code = 'SERVICE_DASHBOARD_UNDECLARED';
      throw error;
    }
    defaultDashboardUrlCache = `http://127.0.0.1:${dashboard.port}`;
  }
  return defaultDashboardUrlCache;
}
const ENV_OVERRIDE = 'TOOLSENABLED_OWNER_DELIVERY_CHANNEL';
const PURPOSE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function normalizeChannel(value) {
  if (typeof value !== 'string' || !value) return null;
  const resolved = CHANNEL_ALIASES[value] || value;
  return CHANNELS.includes(resolved) ? resolved : null;
}

class OwnerDeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnerDeliveryError';
    this.code = code;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeCode(error) {
  if (!error) return 'unknown';
  if (typeof error.code === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.code)) return error.code;
  const name = typeof error.name === 'string' ? error.name : '';
  if (/^[A-Za-z0-9_.:-]{1,40}$/.test(name) && name !== 'Error') return name;
  // Messages can carry arbitrary provider text; keep the recorded reason short
  // and free of anything credential-shaped or personal.
  const message = typeof error.message === 'string' ? error.message : '';
  return message.replace(/[^A-Za-z0-9 ._:'-]/g, ' ').trim().slice(0, 80) || 'error';
}

// ---------------------------------------------------------------------------
// Channel resolution -- the single setting.
// ---------------------------------------------------------------------------

/**
 * Resolve the owner-facing delivery channel.
 *
 * Precedence: explicit override > TOOLSENABLED_OWNER_DELIVERY_CHANNEL >
 * config/owner-delivery.json > 'email'. A value that is present but not a
 * known channel never silently wins; it degrades to the default and the reason
 * is reported so `--status` can show it.
 */
function resolveChannel(options = {}) {
  const env = options.env || process.env;
  const file = options.file || CONFIG_FILE();

  const declaredOverride = options.channel;
  if (declaredOverride !== undefined && declaredOverride !== null) {
    const normalized = normalizeChannel(declaredOverride);
    if (!normalized) {
      throw new OwnerDeliveryError('OWNER_DELIVERY_CHANNEL_INVALID',
        `channel must be one of ${CHANNELS.join(', ')}.`);
    }
    return { channel: normalized, source: 'explicit', reason: null, config: readDeliveryConfig(file).config };
  }

  const fromEnv = env[ENV_OVERRIDE];
  const { config, configError } = readDeliveryConfig(file);

  if (typeof fromEnv === 'string' && fromEnv.length) {
    const normalized = normalizeChannel(fromEnv);
    if (normalized) return { channel: normalized, source: 'env', reason: null, config };
    return {
      channel: DEFAULT_CHANNEL,
      source: 'default',
      reason: `${ENV_OVERRIDE} is not one of ${CHANNELS.join('/')}; using the ${DEFAULT_CHANNEL} default`,
      config
    };
  }

  if (configError) {
    return { channel: DEFAULT_CHANNEL, source: 'default', reason: configError, config };
  }
  if (config.channel === null) {
    return {
      channel: DEFAULT_CHANNEL,
      source: 'default',
      reason: `config/owner-delivery.json declares no channel; using the ${DEFAULT_CHANNEL} default`,
      config
    };
  }
  const normalizedConfig = normalizeChannel(config.channel);
  if (!normalizedConfig) {
    return {
      channel: DEFAULT_CHANNEL,
      source: 'default',
      reason: `config/owner-delivery.json channel is not one of ${CHANNELS.join('/')}; using the ${DEFAULT_CHANNEL} default`,
      config
    };
  }
  return { channel: normalizedConfig, source: 'config', reason: null, config };
}

function readDeliveryConfig(file = CONFIG_FILE()) {
  let raw;
  try {
    raw = readJson(file, null);
  } catch (error) {
    return {
      config: { channel: null, emailAccount: null, dashboardUrl: defaultDashboardUrl() },
      configError: `config/owner-delivery.json is unreadable (${safeCode(error)}); using the ${DEFAULT_CHANNEL} default`
    };
  }
  if (raw === null) {
    return {
      config: { channel: null, emailAccount: null, dashboardUrl: defaultDashboardUrl() },
      configError: `config/owner-delivery.json is absent; using the ${DEFAULT_CHANNEL} default`
    };
  }
  if (!isObject(raw)) {
    return {
      config: { channel: null, emailAccount: null, dashboardUrl: defaultDashboardUrl() },
      configError: `config/owner-delivery.json is not an object; using the ${DEFAULT_CHANNEL} default`
    };
  }
  return {
    config: {
      channel: typeof raw.channel === 'string' ? raw.channel : null,
      emailAccount: typeof raw.emailAccount === 'string' && raw.emailAccount ? raw.emailAccount : null,
      dashboardUrl: typeof raw.dashboardUrl === 'string' && /^https?:\/\//.test(raw.dashboardUrl)
        ? raw.dashboardUrl : defaultDashboardUrl()
    },
    configError: null
  };
}

// ---------------------------------------------------------------------------
// Durable delivery record. Small, bounded, and text-free by construction.
// ---------------------------------------------------------------------------

function emptyRecord() {
  return {
    version: RECORD_VERSION,
    updatedAtMs: null,
    consecutiveFailures: 0,
    lastSuccess: null,
    lastFailure: null,
    recent: []
  };
}

function readDeliveryRecord(file = RECORD_FILE()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyRecord();
    return { ...emptyRecord(), unreadable: safeCode(error) };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ...emptyRecord(), unreadable: 'invalid-json' }; }
  if (!isObject(parsed) || parsed.version !== RECORD_VERSION || !Array.isArray(parsed.recent)) {
    return { ...emptyRecord(), unreadable: 'unrecognized-shape' };
  }
  return {
    version: RECORD_VERSION,
    updatedAtMs: Number.isSafeInteger(parsed.updatedAtMs) ? parsed.updatedAtMs : null,
    consecutiveFailures: Number.isSafeInteger(parsed.consecutiveFailures) && parsed.consecutiveFailures >= 0
      ? parsed.consecutiveFailures : 0,
    lastSuccess: isObject(parsed.lastSuccess) ? parsed.lastSuccess : null,
    lastFailure: isObject(parsed.lastFailure) ? parsed.lastFailure : null,
    recent: parsed.recent.filter(isObject).slice(-RECENT_LIMIT)
  };
}

function writeDeliveryRecord(record, file = RECORD_FILE()) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
}

/**
 * Persist one delivery attempt. NOTHING from the message body is stored --
 * only its length -- because the Duo relay's body can carry a short-lived
 * second factor.
 *
 * Recording must never be the thing that breaks a delivery, so a write failure
 * degrades to a returned flag rather than throwing over a message that was in
 * fact sent.
 */
function recordDelivery(attempt, dependencies = {}) {
  const file = dependencies.recordFile || RECORD_FILE();
  const nowMs = (dependencies.now || Date.now)();
  const purpose = PURPOSE_RE.test(String(attempt.purpose || '')) ? attempt.purpose : 'unspecified';
  const entry = {
    atMs: nowMs,
    purpose,
    channel: DELIVERY_RECORD_CHANNELS.includes(attempt.channel) ? attempt.channel : 'unknown',
    // What was actually delivered, independent of the selected channel.
    rendered: ['image', 'document', 'text', 'email'].includes(attempt.rendered) ? attempt.rendered : null,
    ok: attempt.ok === true,
    code: attempt.ok === true ? null : String(attempt.code || 'error').slice(0, 80),
    // A degraded-but-delivered attempt is a success WITH a named reason, never
    // a silent one -- the owner should learn the picture is missing.
    degradedReason: typeof attempt.degradedReason === 'string' ? attempt.degradedReason.slice(0, 80) : null,
    characters: Number.isSafeInteger(attempt.characters) ? attempt.characters : null,
    imageBytes: Number.isSafeInteger(attempt.imageBytes) ? attempt.imageBytes : null,
    truncated: attempt.truncated === true
  };

  let persisted = false;
  try {
    const record = readDeliveryRecord(file);
    // An unreadable record is not an empty history.  Treating it as one here
    // used to overwrite the evidence we could not read and then report a
    // definite failure streak derived from that fabricated empty baseline.
    // Refuse this bookkeeping attempt instead; `persisted: false` carries the
    // uncertainty without masking the independently known delivery outcome.
    if (record.unreadable) {
      throw new OwnerDeliveryError('OWNER_DELIVERY_RECORD_UNREADABLE',
        `The existing owner-delivery record is unreadable (${record.unreadable}).`);
    }
    record.version = RECORD_VERSION;
    record.updatedAtMs = nowMs;
    record.consecutiveFailures = entry.ok ? 0 : record.consecutiveFailures + 1;
    if (entry.ok) record.lastSuccess = entry; else record.lastFailure = entry;
    record.recent = [...record.recent, entry].slice(-RECENT_LIMIT);
    delete record.unreadable;
    writeDeliveryRecord(record, file);
    persisted = true;
  } catch (bookkeepingError) {
    // BOOKKEEPING THAT DID NOT LAND IS ITSELF A FACT, AND IT USED TO VANISH.
    //
    // This catch said "reported below". Nothing below reported it. The audit
    // trace beneath fires only when the DELIVERY failed and carries the
    // delivery's own code, and `persisted` is returned to callers that all
    // discard it -- agent-digest/index.js (twice) and duo-owner-relay.js
    // (three times) all call recordDelivery() as a bare statement. So a write
    // failure here left no trace anywhere, in this process or on disk.
    //
    // WHAT THAT COSTS is the thing this file is written to protect.
    // `consecutiveFailures` is the streak, and a streak that cannot be written
    // does not advance: a run of failed deliveries to the owner can leave the
    // record sitting at its old value. deliveryStatus() -- "Honest read-back
    // for --status and any operator view" -- then publishes that value, plus
    // lastFailure and recent, as definite fact, because it only withholds them
    // when the record is UNREADABLE. A record that reads cleanly and is stale
    // has no such guard. And when the delivery itself SUCCEEDED, the failed
    // bookkeeping was the only thing that would have said so.
    //
    // So it goes to the same signed channel the failed-delivery trace uses,
    // under its own action and with the reason, carrying a code and never
    // content -- the rule that trace already keeps. `persisted: false` is still
    // returned; this is what makes it visible to somebody who never asked.
    try {
      (dependencies.record || require('./audit').record)('owner.delivery_unrecorded', entry.channel, {
        purpose: entry.purpose,
        ok: entry.ok,
        code: safeCode(bookkeepingError)
      });
    } catch { /* the same rule as below: bookkeeping must not become a crash */ }
  }

  if (!entry.ok) {
    // A failed send writes no provider audit record of its own, so this is the
    // only signed trace that the owner was supposed to hear something and did
    // not. It carries a code, never content.
    try {
      (dependencies.record || require('./audit').record)('owner.delivery_failed', entry.channel, {
        purpose: entry.purpose, code: entry.code, characters: entry.characters
      });
    } catch { /* auditing must not turn a delivery failure into a crash */ }
  }
  return { entry, persisted };
}

/** Honest read-back for `--status` and any operator view. */
function deliveryStatus(dependencies = {}) {
  const file = dependencies.recordFile || RECORD_FILE();
  const record = readDeliveryRecord(file);
  const resolved = resolveChannel(dependencies.channelOptions || {});
  const recordUnreadable = record.unreadable || null;
  return {
    channel: resolved.channel,
    channelSource: resolved.source,
    channelReason: resolved.reason,
    recordFile: path.resolve(file),
    recordUnreadable,
    // The empty values returned alongside `unreadable` are only safe internal
    // scaffolding.  Publishing them used to turn a failed contributing read
    // into the definite claims "zero failures" and "no recent attempts".
    consecutiveFailures: recordUnreadable ? null : record.consecutiveFailures,
    lastSuccess: recordUnreadable ? null : record.lastSuccess,
    lastFailure: recordUnreadable ? null : record.lastFailure,
    recent: recordUnreadable ? null : record.recent.slice(-5)
  };
}

// ---------------------------------------------------------------------------
// Transports.
// ---------------------------------------------------------------------------

/**
 * The maintained email transport used by the legacy delivery switch.
 */
async function sendEmailToOwner({ subject, text, html = null, account = null }, dependencies = {}) {
  const accounts = dependencies.accounts || require('./google-accounts');
  const gmail = dependencies.gmail || require('./providers/google');
  const alias = accounts.resolve(account || undefined);
  const registry = accounts.load();
  const email = registry.accounts[alias] && registry.accounts[alias].email;
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new OwnerDeliveryError('OWNER_DELIVERY_RECIPIENT_UNRESOLVED',
      `Google account '${alias}' has no registered address to deliver to.`);
  }
  return gmail.gmailSend({ to: email, subject, text, html, account: account || undefined });
}

module.exports = Object.freeze({
  CHANNELS,
  CHANNEL_ALIASES,
  CONFIG_FILE,
  DEFAULT_CHANNEL,
  DELIVERY_RECORD_CHANNELS,
  defaultDashboardUrl,
  ENV_OVERRIDE,
  OwnerDeliveryError,
  RECORD_FILE,
  deliveryStatus,
  normalizeChannel,
  readDeliveryConfig,
  readDeliveryRecord,
  recordDelivery,
  resolveChannel,
  safeCode,
  sendEmailToOwner
});
