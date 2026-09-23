#!/usr/bin/env node
'use strict';

// Capture happens because the owner's turn ARRIVED, before an agent can forget
// it. This hook writes only to the unclassified owner-capture spool. It never
// creates an R-id and never decides whether "ok", "yes", or a longer turn is a
// request. That judgement remains in tools/owner-spool-review.js and
// tools/owner-capture.js.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const spool = require('../src/lib/owner-capture-spool');
const { statePath } = require('../src/lib/runtime-state-root');

const DEFAULT_LEDGER = statePath('reports', 'OWNER-REQUEST-LEDGER.json');
const FALLBACK_FILE_NAME = 'ingress-fallback.jsonl';
const FALLBACK_VERSION = 1;
const AGENT_OR_RELAY_ORIGINS = new Set(['agent', 'assistant', 'peer', 'relay', 'task-notification',
  // Machine-injected schedule firings. Discovered 2026-08-12: a session's
  // hourly cron loop delivered its own prompt through UserPromptSubmit with
  // none of the markers above, so the spool gained one fake "owner turn" per
  // hour, dressed in the owner's provenance. If the harness ever labels these
  // (source: cron/scheduled/machine), they are excluded here mechanically.
  'cron', 'scheduled', 'machine']);

// The harness does NOT reliably label injected prompts (the 2026-08-12 cron
// firings arrived indistinguishable from typed input), so schedulers running
// inside a session mark their own prompts instead: a prompt whose first
// non-whitespace content is this exact token is machine-injected by
// declaration and never enters the owner spool. The owner typing the token
// deliberately is the owner declaring the same thing. A QUOTED occurrence
// later in a turn ("the sentinel is [machine-scheduled]") does not match and
// is preserved -- only a leading token excludes. Owner authorization for this
// exclusion: in-session, 2026-08-12, "ok fix it" on the shadow cycle-3
// pollution finding.
const MACHINE_SCHEDULED_SENTINEL = '[machine-scheduled]';

// Harness-injected notification wrappers, detected structurally. The
// AGENT_OR_RELAY_ORIGINS entry 'task-notification' declares the intent, but
// measured 2026-08-12: the harness delivers background-task notifications
// through UserPromptSubmit with NO source label -- 15 of 33 pending "owner
// turns" were <task-notification> wrappers. These prefixes are emitted by the
// harness itself, never typed; a genuine turn QUOTING one mid-text still
// spools byte-for-byte because only the leading position matches.
const HARNESS_NOTIFICATION_PREFIXES = Object.freeze(['<task-notification>', '[SYSTEM NOTIFICATION']);

class OwnerIngressError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnerIngressError';
    this.code = code;
  }
}

function fallbackFileForLedger(ledgerFile) {
  return path.join(path.dirname(path.resolve(ledgerFile)), spool.SPOOL_DIRECTORY_NAME, FALLBACK_FILE_NAME);
}

function parseArgs(argv) {
  const out = { status: false, ledger: null, fallback: null, source: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--status') out.status = true;
    else if (token === '--help' || token === '-h') out.help = true;
    else if (token === '--ledger' || token === '--fallback' || token === '--source') {
      const value = argv[index + 1];
      if (!value) throw new OwnerIngressError('OWNER_INGRESS_USAGE', `${token} requires a value`);
      // A malformed --source must REFUSE, not fall back to the default: a hook
      // that silently mislabels provenance is the failure this flag exists to
      // avoid, and a typo in a hooks.json is exactly how it would happen.
      if (token === '--source' && !SOURCE_RE.test(value)) {
        throw new OwnerIngressError(
          'OWNER_INGRESS_SOURCE_INVALID',
          `--source must look like "<harness>/<event>" (lowercase harness, e.g. codex/UserPromptSubmit); got "${value.slice(0, 60)}"`
        );
      }
      out[token.slice(2)] = value;
      index += 1;
    } else {
      throw new OwnerIngressError('OWNER_INGRESS_USAGE', `Unexpected argument: ${token}`);
    }
  }
  return out;
}

async function readStdin(stream = process.stdin) {
  if (stream.isTTY) return '';
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function isMarkedAgentOrRelay(event) {
  const originKind = event && event.origin && typeof event.origin.kind === 'string'
    ? event.origin.kind.toLowerCase()
    : null;
  if (originKind && originKind !== 'human') return true;
  if (event && (event.isSidechain === true || event.isMeta === true)) return true;
  if (event && (typeof event.agent_id === 'string' || typeof event.agent_type === 'string')) return true;
  const source = event && typeof event.source === 'string' ? event.source.toLowerCase() : null;
  return source ? AGENT_OR_RELAY_ORIGINS.has(source) : false;
}

function classifyHookEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { action: 'malformed', reason: 'event-not-object' };
  }
  if (event.hook_event_name !== undefined && event.hook_event_name !== 'UserPromptSubmit') {
    return { action: 'ignore', reason: 'not-user-prompt-submit' };
  }
  if (isMarkedAgentOrRelay(event)) return { action: 'ignore', reason: 'agent-or-relay-marker' };
  if (typeof event.prompt !== 'string') return { action: 'malformed', reason: 'prompt-not-string' };
  if (!event.prompt.trim()) return { action: 'ignore', reason: 'empty-prompt' };
  const head = event.prompt.trimStart();
  if (head.startsWith(MACHINE_SCHEDULED_SENTINEL)) {
    return { action: 'ignore', reason: 'machine-scheduled-sentinel' };
  }
  if (HARNESS_NOTIFICATION_PREFIXES.some(prefix => head.startsWith(prefix))) {
    return { action: 'ignore', reason: 'harness-notification-marker' };
  }
  return { action: 'spool', text: event.prompt };
}

function safeEventMetadata(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  return {
    hookEventName: typeof event.hook_event_name === 'string' ? event.hook_event_name : null,
    sessionId: typeof event.session_id === 'string' ? event.session_id : null,
    originKind: event.origin && typeof event.origin.kind === 'string' ? event.origin.kind : null
  };
}

function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const descriptor = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function appendFallback(file, {
  text = null,
  rawStdin = null,
  event = null,
  reason,
  error = null,
  now = new Date()
}) {
  const record = {
    version: FALLBACK_VERSION,
    kind: 'owner-ingress-fallback',
    id: crypto.randomUUID(),
    spooledAt: now.toISOString(),
    text,
    rawStdin,
    event: safeEventMetadata(event),
    reason,
    error: error ? {
      code: typeof error.code === 'string' ? error.code : null,
      message: typeof error.message === 'string' ? error.message.slice(0, 2000) : String(error).slice(0, 2000)
    } : null
  };
  appendJsonLine(file, record);
  return record;
}

function verifySpoolHandle(handle, expectedText) {
  if (!handle || typeof handle.file !== 'string') {
    throw new OwnerIngressError('OWNER_INGRESS_SPOOL_HANDLE_INVALID', 'The owner-capture spool returned no durable file handle.');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(handle.file, 'utf8'));
  } catch (error) {
    throw new OwnerIngressError('OWNER_INGRESS_SPOOL_VERIFY_FAILED', `The owner-capture spool record could not be read back: ${error.message}`);
  }
  if (!parsed || parsed.text !== expectedText) {
    throw new OwnerIngressError('OWNER_INGRESS_SPOOL_BYTES_MISMATCH', 'The owner-capture spool did not preserve the submitted prompt byte-for-byte.');
  }
  return handle;
}

// `source` names the HARNESS the owner turn arrived through, and it is written
// verbatim into the capture spool as provenance. It was hardcoded to
// claude-code/UserPromptSubmit while Claude was the only wired harness; Codex
// has no UserPromptSubmit hook at all, so every Codex owner turn is currently
// lost. Wiring Codex to this tool WITHOUT parameterising this field would be
// worse than the loss: it would stamp Codex turns with a Claude provenance
// string, and provenance that lies is the exact defect the ledger's
// anti-fabrication fence exists to prevent. So the default is unchanged (the
// Claude hook keeps its exact current behaviour and needs no edit) and the
// Codex hook passes --source explicitly.
const DEFAULT_INGRESS_SOURCE = 'claude-code/UserPromptSubmit';
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,39}(?:\/[A-Za-z0-9._-]{1,40})?$/;

function captureHookEvent(event, {
  ledgerFile = DEFAULT_LEDGER,
  fallbackFile = fallbackFileForLedger(ledgerFile),
  spoolModule = spool,
  source = DEFAULT_INGRESS_SOURCE,
  now = new Date()
} = {}) {
  const classification = classifyHookEvent(event);
  if (classification.action !== 'spool') return classification;

  try {
    const handle = spoolModule.writeAhead(path.resolve(ledgerFile), {
      mode: 'ingress',
      id: null,
      text: classification.text,
      interpretation: null,
      actor: 'owner-ingress-hook',
      source,
      gates: [],
      status: null,
      scope: null,
      threadId: typeof event.session_id === 'string' ? event.session_id : null,
      provenanceClass: null,
      proposal: null,
      now
    });
    verifySpoolHandle(handle, classification.text);
    return { action: 'spooled', id: handle.name, file: handle.file };
  } catch (error) {
    const fallback = appendFallback(fallbackFile, {
      text: classification.text,
      event,
      reason: 'spool-module-failure',
      error,
      now
    });
    return { action: 'fallback', id: fallback.id, file: path.resolve(fallbackFile) };
  }
}

function captureRawInput(raw, options = {}) {
  let event;
  try {
    event = JSON.parse(raw);
  } catch (error) {
    const ledgerFile = options.ledgerFile || DEFAULT_LEDGER;
    const fallbackFile = options.fallbackFile || fallbackFileForLedger(ledgerFile);
    const fallback = appendFallback(fallbackFile, {
      rawStdin: raw,
      reason: 'invalid-hook-json',
      error,
      now: options.now || new Date()
    });
    return { action: 'fallback-malformed', id: fallback.id, file: path.resolve(fallbackFile) };
  }

  const classification = classifyHookEvent(event);
  if (classification.action === 'malformed') {
    const ledgerFile = options.ledgerFile || DEFAULT_LEDGER;
    const fallbackFile = options.fallbackFile || fallbackFileForLedger(ledgerFile);
    const fallback = appendFallback(fallbackFile, {
      rawStdin: raw,
      event,
      reason: classification.reason,
      now: options.now || new Date()
    });
    return { action: 'fallback-malformed', id: fallback.id, file: path.resolve(fallbackFile) };
  }
  return captureHookEvent(event, options);
}

function readFallbackJournal(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // A journal which has never been created contains no fallback records. Any
    // other read failure is not evidence of an empty journal and must not turn
    // an unmeasured queue into a definite zero.
    if (error && error.code === 'ENOENT') return [];
    throw new OwnerIngressError(
      'OWNER_INGRESS_FALLBACK_READ_FAILED',
      `The fallback journal could not be read: ${error.message}`
    );
  }
  const records = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch (error) {
      // Skipping a torn line made the pending count look complete while one of
      // its contributing records was unreadable. Refuse the count instead.
      throw new OwnerIngressError(
        'OWNER_INGRESS_FALLBACK_INVALID',
        `The fallback journal has invalid JSON on line ${index + 1}: ${error.message}`
      );
    }
  }
  return records;
}

function fallbackPending(file) {
  const records = readFallbackJournal(file);
  const resolved = new Set(records
    .filter(record => record.kind === 'owner-ingress-fallback-resolution' && typeof record.targetId === 'string')
    .map(record => record.targetId));
  return records.filter(record => record.kind === 'owner-ingress-fallback'
    && typeof record.id === 'string'
    && typeof record.text === 'string'
    && record.text.trim()
    && !resolved.has(record.id));
}

/* The unclassified owner turns held by ONE spool, as review rows. Split out of
   listUnclassifiedIngress so a caller can ask the same honest question of a
   second spool: the product spools a person's turn under the r-ledger anchor
   (src/lib/r-ledger-proposals.js), not beside this ledger, and a reviewer that
   reads only one of the two answers "clean" for a queue it never looked in. */
function spoolPending({ ledgerFile, spoolModule = spool } = {}) {
  let primary;
  try {
    const resolvedLedger = path.resolve(ledgerFile);
    const pending = spoolModule.listPending(resolvedLedger);

    // The default spool reader historically collapses readdir and record-read
    // failures into []. Audit its input directory independently so --status
    // cannot report a definite count after scanning fewer files than exist.
    if (spoolModule === spool) {
      const directory = spool.pendingDirectory(resolvedLedger);
      let names;
      try {
        names = fs.readdirSync(directory)
          .filter(name => name.endsWith('.json') && !name.endsWith('.tmp'));
      } catch (error) {
        if (error && error.code === 'ENOENT') names = [];
        else throw error;
      }
      if (pending.length !== names.length) {
        throw new OwnerIngressError(
          'OWNER_INGRESS_PRIMARY_INCOMPLETE',
          `The primary spool exposed ${pending.length} readable records for ${names.length} pending files.`
        );
      }
    }

    primary = pending
      .filter(record => record && record.mode === 'ingress' && typeof record.text === 'string' && record.text.trim())
      .map(record => ({
        storage: 'spool',
        id: record.name,
        when: record.spooledAt,
        text: record.text,
        file: record.file,
        record
      }));
  } catch (error) {
    if (error instanceof OwnerIngressError) throw error;
    throw new OwnerIngressError(
      'OWNER_INGRESS_PRIMARY_READ_FAILED',
      `The primary owner-capture spool could not be read: ${error.message}`
    );
  }
  return primary;
}

function listUnclassifiedIngress({
  ledgerFile = DEFAULT_LEDGER,
  fallbackFile = fallbackFileForLedger(ledgerFile),
  spoolModule = spool
} = {}) {
  const primary = spoolPending({ ledgerFile, spoolModule });

  const fallback = fallbackPending(path.resolve(fallbackFile)).map(record => ({
    storage: 'fallback',
    id: record.id,
    when: record.spooledAt,
    text: record.text,
    file: path.resolve(fallbackFile),
    record
  }));
  return [...primary, ...fallback].sort((a, b) => String(a.when).localeCompare(String(b.when)));
}

function statusLine(records, now = new Date()) {
  if (!records.length) return '0 owner turns spooled and unclassified, oldest none';
  const times = records.map(record => Date.parse(record.when)).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : null;
  const age = oldest === null ? 'unknown' : `${(Math.max(0, now.getTime() - oldest) / 3600_000).toFixed(1)}h`;
  return `${records.length} owner turns spooled and unclassified, oldest ${age}`;
}

function getStatus(options = {}) {
  const records = listUnclassifiedIngress(options);
  return { count: records.length, records, line: statusLine(records, options.now || new Date()) };
}

function appendFallbackResolution(file, { targetId, outcome, reason = null, ledgerId = null, actor = 'owner-spool-review', now = new Date() }) {
  const record = {
    version: FALLBACK_VERSION,
    kind: 'owner-ingress-fallback-resolution',
    targetId,
    outcome,
    reason,
    ledgerId,
    actor,
    resolvedAt: now.toISOString()
  };
  appendJsonLine(file, record);
  return record;
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node tools/owner-ingress-spool.js [--source HARNESS/EVENT] < UserPromptSubmit-hook.json',
    '  node tools/owner-ingress-spool.js --status [--ledger FILE] [--fallback FILE]',
    '',
    `--source records which harness the turn arrived through (default ${DEFAULT_INGRESS_SOURCE}).`,
    'Successful hook capture is silent. --status emits one line for prompt injection.',
    ''
  ].join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { printUsage(); return 0; }
  const ledgerFile = args.ledger ? path.resolve(args.ledger) : DEFAULT_LEDGER;
  const fallbackFile = args.fallback ? path.resolve(args.fallback) : fallbackFileForLedger(ledgerFile);
  if (args.status) {
    process.stdout.write(`${getStatus({ ledgerFile, fallbackFile }).line}\n`);
    return 0;
  }
  const raw = await readStdin();
  if (!raw) {
    throw new OwnerIngressError(
      'OWNER_INGRESS_EMPTY_INPUT',
      'No hook event was received on stdin; refusing to report a successful capture.'
    );
  }
  const source = args.source || DEFAULT_INGRESS_SOURCE;
  captureRawInput(raw, { ledgerFile, fallbackFile, source });
  return 0;
}

if (require.main === module) {
  main().then(
    code => { process.exitCode = code; },
    error => {
      const code = error && error.code ? error.code : 'OWNER_INGRESS_FAILED';
      process.stderr.write(`${code}: ${error && error.message ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = Object.freeze({
  DEFAULT_LEDGER,
  DEFAULT_INGRESS_SOURCE,
  FALLBACK_FILE_NAME,
  FALLBACK_VERSION,
  MACHINE_SCHEDULED_SENTINEL,
  HARNESS_NOTIFICATION_PREFIXES,
  OwnerIngressError,
  fallbackFileForLedger,
  parseArgs,
  readStdin,
  isMarkedAgentOrRelay,
  classifyHookEvent,
  appendFallback,
  verifySpoolHandle,
  captureHookEvent,
  captureRawInput,
  readFallbackJournal,
  fallbackPending,
  spoolPending,
  listUnclassifiedIngress,
  statusLine,
  getStatus,
  getIngressStatus: getStatus,
  appendFallbackResolution,
  main
});
