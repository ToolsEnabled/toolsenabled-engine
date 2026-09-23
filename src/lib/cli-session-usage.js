'use strict';

// Officially-recorded local usage for the two CLIs that never reach the durable-run
// broker lifecycle.
//
// Why this module exists: the durable-run broker (since removed with the local worker integration) was the only
// writer of metered provider operations into the signed ledger, and a run is
// metered only if the broker launched it. Gemini fleet runs and the local
// sidecar go through it; Claude Code and Codex CLI are separate processes
// talking straight to Anthropic/OpenAI, so nothing about them ever reached the
// ledger and the dashboard rendered them as "0 operations" -- indistinguishable
// from a provider that genuinely did no work.
//
// Both CLIs do, however, persist the provider's OWN reported usage numbers into
// local session records. This module reads exactly those numbers and nothing
// else.
//
// Hard invariants, in the order they matter:
//  1. Never infer, estimate, extrapolate, or fabricate. Nothing here derives a
//     token count from bytes, characters, durations, or message content. A
//     figure the source does not record stays null forever -- see the explicit
//     `durationMs: null` for Claude Code and `outputBytes: null` for both.
//  2. Never read message text. Only numeric usage fields and a handful of
//     structural discriminators (record type, entrypoint, request id,
//     timestamp) are ever extracted, and only numbers/enums are ever returned.
//     Session transcripts hold the owner's prompts and provider output; this
//     module must not become a way for that content to reach a projection.
//  3. Never double count. Both formats have a specific, verified duplication
//     hazard (documented per reader below) and both are handled exactly, not
//     approximately.
//  4. Never claim more coverage than was actually read. Every scan is bounded
//     by file count, byte budget, and age; hitting a bound downgrades
//     `coverage` to 'partial' rather than silently truncating.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA_VERSION = 1;
// A signed, content-free observation of what a local CLI session record set
// reported. This is the parent evidence the controller projection reads; it is
// NOT a MeterRecord (see the note in ingestProviders() below for why).
const CLI_SESSION_USAGE_ACTION = 'controller.cli_session.usage';
const SOURCE_KIND = 'local-session-record';
const PROVIDERS = Object.freeze(['claude', 'codex']);
const OBSERVATION_ID_PREFIX = 'obs_';
const OBSERVATION_ID_RE = /^obs_[A-Za-z0-9_-]{16,64}$/;

function observationId(provider, ranges, coverage) {
  // Preserve the original identity for complete observations so deploying this
  // fix cannot cause already-recorded byte ranges to be credited again. A
  // partial observation is materially different evidence, however: in
  // particular, an empty bounded/failed scan must not collide with an empty
  // complete scan and lose its coverage downgrade during downstream
  // observation-ID deduplication.
  const coverageIdentity = coverage === 'partial' ? '\0partial' : '';
  const digest = crypto.createHash('sha256')
    .update(`toolsenabled.cli-session-usage.v1\0${provider}\0${ranges.join('\n')}${coverageIdentity}`)
    .digest('base64url')
    .slice(0, 32);
  return `${OBSERVATION_ID_PREFIX}${digest}`;
}

// Bounds. These exist because the two corpora are large (~1.4 GB of Claude
// transcripts and ~4.7 GB of Codex rollouts on this machine) and an unbounded
// read would be both slow and a memory hazard.
const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_BYTES = 192 * 1024 * 1024;
// A single delta is read into one buffer, so one pathological file (the largest
// Codex rollout here is 274 MB) must never be allowed to allocate itself. Past
// this size the file is skipped and `coverage` says so; incremental runs read
// only the appended tail and never come close.
const MAX_FILE_CHUNK_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CURSOR_ENTRIES = 2048;
const MAX_RECENT_KEYS = 64;
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_ENTRIES = 20_000;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isOptionalCount(value) {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function isoOrNull(ms) {
  return Number.isSafeInteger(ms) && ms >= 0 ? new Date(ms).toISOString() : null;
}

function emptyObservation(provider, brokerExcluded) {
  return {
    schemaVersion: SCHEMA_VERSION,
    provider,
    // Identifies the exact byte ranges this observation credits, so the same
    // range can never be counted twice inside one projection window. The
    // persisted cursor already prevents a re-read in the normal case; this
    // covers the case where the cursor write fails after the ledger write
    // succeeded, which would otherwise re-credit the same usage on the next
    // run. Deriving it from ranges (not from a timestamp or a random id) is
    // what makes ingestion idempotent rather than merely usually-correct.
    observationId: OBSERVATION_ID_PREFIX,
    sourceKind: SOURCE_KIND,
    // True only when this reader can PROVE it excluded the sessions the broker
    // lifecycle already meters, so the two sources can be safely added. See
    // the Claude reader (entrypoint partition) and the Codex reader (no such
    // partition exists in the rollout format).
    brokerExcluded,
    coverage: 'complete',
    operationCount: 0,
    reportedTokens: null,
    durationMs: null,
    outputBytes: null,
    transcriptCount: 0,
    window: { startedAt: null, endedAt: null }
  };
}

// --- bounded filesystem scan ------------------------------------------------

function scanFiles(root, { suffix, maxAgeMs, nowMs }) {
  const found = [];
  let readFailed = false;
  // Files the age bound excluded are returned too, NOT silently dropped. A file
  // outside the age window that this reader's cursor has already fully consumed
  // is a correct, permanent exclusion -- this is an incremental reader, and
  // re-scanning years of already-read history on every run is the wrong
  // failure mode in the other direction. But the age check runs before the
  // cursor is ever consulted, so on its own it cannot tell "fully read" apart
  // from "never read" -- a fresh install pointed at a pre-existing week-plus of
  // CLI history hits this exact bound on every run, forever, with no signal.
  // The caller has the cursor; it makes the call this function cannot.
  const agedOut = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_ENTRIES) { readFailed = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { readFailed = true; return; }
    for (const entry of entries) {
      if (visited >= MAX_SCAN_ENTRIES) { readFailed = true; return; }
      visited += 1;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      let stat;
      try { stat = fs.statSync(full); }
      catch { readFailed = true; continue; }
      if (nowMs - stat.mtimeMs > maxAgeMs) { agedOut.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs }); continue; }
      found.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(root, 0);
  // Newest first: when a byte budget cuts the scan short, the freshest activity
  // is the part that survives, and `coverage` says the rest was not read.
  return {
    files: found.sort((left, right) => right.mtimeMs - left.mtimeMs),
    agedOut,
    readFailed
  };
}

// Reads only the bytes appended since the previous run. Returns whole lines
// only: a trailing partial line is left unconsumed so the next run re-reads it
// from its true start. `from` is always a previous newline boundary (or 0), so
// UTF-8 decoding never begins mid-character.
function readAppendedLines(file, from, size) {
  if (size <= from) return { lines: [], consumed: from, readFailed: false };
  let handle;
  try { handle = fs.openSync(file, 'r'); }
  catch { return { lines: [], consumed: from, readFailed: true }; }
  try {
    const length = size - from;
    const buffer = Buffer.allocUnsafe(length);
    const read = fs.readSync(handle, buffer, 0, length, from);
    if (read !== length) return { lines: [], consumed: from, readFailed: true };
    const chunk = buffer.subarray(0, read);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], consumed: from, readFailed: false };
    const complete = chunk.subarray(0, lastNewline + 1).toString('utf8');
    return { lines: complete.split('\n'), consumed: from + lastNewline + 1, readFailed: false };
  } catch {
    return { lines: [], consumed: from, readFailed: true };
  } finally {
    try { fs.closeSync(handle); } catch { /* the read result already stands */ }
  }
}

// --- Claude Code -----------------------------------------------------------
//
// Layout: %USERPROFILE%\.claude\projects\<project-slug>\<sessionId>.jsonl, plus
// subagent transcripts under <sessionId>\subagents\**\agent-*.jsonl. Only
// `type: "assistant"` records carry `message.usage`, and that object is the
// Anthropic API's own usage payload written through verbatim.
//
// DUPLICATION HAZARD (verified on this machine, 2026-07-28): one assistant API
// response is written once per content block, so a message with text plus N
// tool_use blocks appears as N+1 JSONL records carrying the IDENTICAL usage
// object. Measured on one 20 MB session: 2,365 usage records for 1,150 unique
// `requestId`s, and naive summation over-counted output tokens 2.43x. `requestId`
// is 1:1 with `message.id` and present on 100% of usage records, so grouping by
// it and taking one usage object per group is exact -- not an approximation.
//
// BROKER OVERLAP: a broker-launched `claude -p` run also writes a transcript
// here, which would double count against the broker lifecycle meter.
// Those records carry `entrypoint: "sdk-cli"` while interactive sessions carry
// `entrypoint: "claude-vscode"`, so they are excluded outright and the two
// measurement sources stay disjoint by construction (brokerExcluded: true).
function claudeUsageFromLine(line, state) {
  if (line.length < 32 || !line.includes('"usage"')) return;
  let record;
  try { record = JSON.parse(line); }
  catch { state.readFailed = true; return; }
  if (!record || typeof record !== 'object' || record.type !== 'assistant') return;
  if (record.entrypoint === 'sdk-cli') return;
  const message = record.message;
  const usage = message && typeof message === 'object' ? message.usage : null;
  if (!usage || typeof usage !== 'object') return;
  const key = typeof record.requestId === 'string' ? record.requestId
    : typeof message.id === 'string' ? message.id : null;
  if (!key) { state.readFailed = true; return; }
  if (state.seen.has(key)) return;
  if (![usage.input_tokens, usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens, usage.output_tokens].every(isOptionalCount) ||
      !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) {
    state.readFailed = true;
    return;
  }
  state.seen.add(key);
  state.recent.push(key);
  while (state.recent.length > MAX_RECENT_KEYS) state.seen.delete(state.recent.shift());
  // The provider's own four reported token buckets. Cache reads and cache
  // writes are real processed tokens the provider reported, so they are
  // included; nothing here is computed from anything but these four fields.
  state.tokens += count(usage.input_tokens) + count(usage.cache_creation_input_tokens)
    + count(usage.cache_read_input_tokens) + count(usage.output_tokens);
  state.operations += 1;
  const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
  if (Number.isSafeInteger(at)) {
    if (state.startedAtMs === null || at < state.startedAtMs) state.startedAtMs = at;
    if (state.endedAtMs === null || at > state.endedAtMs) state.endedAtMs = at;
  }
}

// --- Codex CLI -------------------------------------------------------------
//
// Layout: %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-<iso>-<uuid>.jsonl.
// Token usage is recorded as
//   {"type":"event_msg","payload":{"type":"token_count","info":{
//      "total_token_usage":{...,"total_tokens":N},
//      "last_token_usage":{...,"total_tokens":M}}}}
//
// DUPLICATION HAZARD (verified on this machine, 2026-07-28): `total_token_usage`
// is a running cumulative total for the thread and `last_token_usage` is the
// most recent call's delta -- but they do not agree. On a 966-line rollout,
// summing `last_token_usage.total_tokens` gave 13,318,969 against a final
// `total_token_usage.total_tokens` of 13,163,589, because two context-compaction
// calls reported a `last_token_usage` that the running total deliberately does
// not absorb. The cumulative field is the authoritative one, so this reader
// credits monotonic increases in `total_token_usage` and treats a decrease as a
// new thread segment (a resumed thread appends to the same file and restarts the
// counter) crediting that segment's own total. That is exact under incremental
// re-reads and never re-credits a byte range already consumed.
//
// BROKER OVERLAP: the rollout format carries no reliable discriminator for a
// broker-launched `codex exec` run (`session_meta.payload.originator` is absent
// on most files here), so this reader cannot prove disjointness and reports
// brokerExcluded: false. The controller projection refuses to add two sources
// it cannot prove disjoint rather than publishing a possibly double-counted
// number.
function codexUsageFromLine(line, state) {
  if (line.length < 32 || !line.includes('token_count')) {
    if (line.includes('task_complete')) codexDurationFromLine(line, state);
    return;
  }
  let record;
  try { record = JSON.parse(line); }
  catch { state.readFailed = true; return; }
  const payload = record && typeof record === 'object' && record.type === 'event_msg' ? record.payload : null;
  if (!payload || typeof payload !== 'object' || payload.type !== 'token_count') return;
  const info = payload.info;
  const total = info && typeof info === 'object' && info.total_token_usage && typeof info.total_token_usage === 'object'
    ? info.total_token_usage.total_tokens : null;
  if (!Number.isSafeInteger(total) || total < 0) { state.readFailed = true; return; }
  if (state.previousTotal === null || total < state.previousTotal) state.tokens += total;
  else state.tokens += total - state.previousTotal;
  state.previousTotal = total;
  state.operations += 1;
  const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
  if (Number.isSafeInteger(at)) {
    if (state.startedAtMs === null || at < state.startedAtMs) state.startedAtMs = at;
    if (state.endedAtMs === null || at > state.endedAtMs) state.endedAtMs = at;
  }
}

// Codex records its own turn wall time; Claude Code records none. Only the
// numeric `duration_ms` is read -- the sibling `last_agent_message` field on the
// same record is provider output text and is never touched.
function codexDurationFromLine(line, state) {
  let record;
  try { record = JSON.parse(line); }
  catch { state.readFailed = true; return; }
  const payload = record && typeof record === 'object' && record.type === 'event_msg' ? record.payload : null;
  if (!payload || typeof payload !== 'object' || payload.type !== 'task_complete') return;
  const durationMs = payload.duration_ms;
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 86_400_000) {
    state.readFailed = true;
    return;
  }
  state.durationMs += durationMs;
  state.durationEvidence += 1;
}

// --- shared bounded reader -------------------------------------------------

function collectProvider({ provider, root, suffix, brokerExcluded, parseLine, cursor, options }) {
  const nowMs = Number.isSafeInteger(options.nowMs) ? options.nowMs : Date.now();
  const maxFiles = Number.isSafeInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES;
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
  const maxAgeMs = Number.isSafeInteger(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const observation = emptyObservation(provider, brokerExcluded);
  const nextCursor = {};
  let rootExists = false;
  try { rootExists = fs.statSync(root).isDirectory(); }
  catch (error) {
    // A genuinely absent record root means the source is unavailable. Other
    // stat failures (for example EACCES or EIO) do not establish absence and
    // must refuse the collection instead of returning the same answer.
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) rootExists = false;
    else throw error;
  }
  if (!rootExists) {
    // No local record set at all is NOT zero usage. Report it as an absent
    // source so the projection can keep the column unavailable.
    return { observation: null, cursor: cursor && typeof cursor === 'object' ? cursor : {} };
  }
  const { files, agedOut, readFailed: scanFailed } = scanFiles(root, { suffix, maxAgeMs, nowMs });
  if (scanFailed) observation.coverage = 'partial';
  // An aged-out file the cursor has NOT fully consumed is truncation, not scope.
  // `from < size` covers both "never seen" (no cursor entry, from = 0) and "seen
  // partway, more was appended since" -- both mean bytes exist that this scan
  // will never read, this run or any future one, because the file will only get
  // older. That is exactly what invariant #4 promises `coverage` will admit to.
  for (const old of agedOut) {
    const previous = cursor && typeof cursor === 'object' ? cursor[old.file] : null;
    const previousSize = previous && Number.isSafeInteger(previous.consumed) ? previous.consumed : 0;
    if (previousSize < old.size) { observation.coverage = 'partial'; break; }
  }
  let budget = maxBytes;
  let scanned = 0;
  const ranges = [];
  const aggregate = {
    tokens: 0, operations: 0, durationMs: 0, durationEvidence: 0,
    startedAtMs: null, endedAtMs: null
  };
  for (const candidate of files) {
    const previous = cursor && typeof cursor === 'object' ? cursor[candidate.file] : null;
    const previousSize = previous && Number.isSafeInteger(previous.consumed) ? previous.consumed : 0;
    // A file that shrank was rotated or rewritten; the stored offset no longer
    // describes it, so it is re-read from the start rather than silently
    // skipping or mis-crediting a region.
    const from = previousSize <= candidate.size ? previousSize : 0;
    if (from === candidate.size) {
      nextCursor[candidate.file] = previous || { consumed: candidate.size };
      continue;
    }
    if (scanned >= maxFiles || budget <= 0) { observation.coverage = 'partial'; break; }
    const wanted = candidate.size - from;
    // One oversized file must not starve every other file behind it. Skip it,
    // leave its cursor untouched so a later run with a bigger budget can still
    // pick it up, and say out loud that this scan was incomplete. Reading a
    // partial tail instead would silently drop whole records.
    if (wanted > budget || wanted > MAX_FILE_CHUNK_BYTES) { observation.coverage = 'partial'; continue; }
    const { lines, consumed, readFailed } = readAppendedLines(candidate.file, from, candidate.size);
    budget -= wanted;
    scanned += 1;
    if (readFailed) observation.coverage = 'partial';
    if (consumed > from) ranges.push(`${candidate.file}\0${from}\0${consumed}`);
    const state = {
      tokens: 0, operations: 0, durationMs: 0, durationEvidence: 0,
      startedAtMs: null, endedAtMs: null, readFailed: false,
      seen: new Set(previous && Array.isArray(previous.recentKeys) ? previous.recentKeys : []),
      recent: previous && Array.isArray(previous.recentKeys) ? [...previous.recentKeys] : [],
      previousTotal: previous && Number.isSafeInteger(previous.previousTotal) ? previous.previousTotal : null
    };
    for (const line of lines) parseLine(line, state);
    if (state.readFailed) observation.coverage = 'partial';
    aggregate.tokens += state.tokens;
    aggregate.operations += state.operations;
    aggregate.durationMs += state.durationMs;
    aggregate.durationEvidence += state.durationEvidence;
    if (state.startedAtMs !== null && (aggregate.startedAtMs === null || state.startedAtMs < aggregate.startedAtMs)) aggregate.startedAtMs = state.startedAtMs;
    if (state.endedAtMs !== null && (aggregate.endedAtMs === null || state.endedAtMs > aggregate.endedAtMs)) aggregate.endedAtMs = state.endedAtMs;
    nextCursor[candidate.file] = {
      consumed,
      recentKeys: state.recent.slice(-MAX_RECENT_KEYS),
      previousTotal: state.previousTotal
    };
    if (state.operations > 0) observation.transcriptCount += 1;
  }
  // Files that were in range but never reached keep their prior cursor so a
  // later run resumes exactly where this one stopped.
  if (cursor && typeof cursor === 'object') {
    for (const [file, entry] of Object.entries(cursor)) {
      if (!Object.hasOwn(nextCursor, file)) nextCursor[file] = entry;
    }
  }
  observation.observationId = observationId(provider, ranges.sort(), observation.coverage);
  observation.operationCount = aggregate.operations;
  observation.reportedTokens = aggregate.operations > 0 ? aggregate.tokens : null;
  observation.durationMs = aggregate.durationEvidence > 0 ? aggregate.durationMs : null;
  observation.outputBytes = null;
  observation.window = {
    startedAt: isoOrNull(aggregate.startedAtMs),
    endedAt: isoOrNull(aggregate.endedAtMs)
  };
  return { observation, cursor: pruneCursor(nextCursor) };
}

// Cursor entries are inserted newest-file-first, then the carried-over entries
// for files that fell outside this run's age window. Keeping the HEAD of that
// order is what bounds the cursor without discarding the offsets that are about
// to be needed again -- dropping a live file's offset would make the next run
// re-read it from byte zero and credit the same usage twice.
function pruneCursor(cursor) {
  const entries = Object.entries(cursor);
  if (entries.length <= MAX_CURSOR_ENTRIES) return cursor;
  return Object.fromEntries(entries.slice(0, MAX_CURSOR_ENTRIES));
}

function claudeRoot(home) {
  return path.join(home, '.claude', 'projects');
}

function codexRoot(home) {
  return path.join(home, '.codex', 'sessions');
}

// Reads both CLIs once. `cursors` is the persisted per-file byte/dedup state
// from the previous run; the returned `cursors` must be written back or the
// next run re-reads (and re-credits) the same byte ranges.
function collectCliSessionUsage(options = {}) {
  const home = typeof options.home === 'string' && options.home ? options.home : os.homedir();
  const cursors = options.cursors && typeof options.cursors === 'object' ? options.cursors : {};
  const claude = collectProvider({
    provider: 'claude',
    root: typeof options.claudeRoot === 'string' ? options.claudeRoot : claudeRoot(home),
    suffix: '.jsonl',
    brokerExcluded: true,
    parseLine: claudeUsageFromLine,
    cursor: cursors.claude,
    options
  });
  const codex = collectProvider({
    provider: 'codex',
    root: typeof options.codexRoot === 'string' ? options.codexRoot : codexRoot(home),
    suffix: '.jsonl',
    brokerExcluded: false,
    parseLine: codexUsageFromLine,
    cursor: cursors.codex,
    options
  });
  return {
    observations: [claude.observation, codex.observation].filter(Boolean),
    cursors: { claude: claude.cursor, codex: codex.cursor }
  };
}

// --- audit payload -----------------------------------------------------------

const REASONABLE_COUNT = 1_000_000_000_000;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nullableCount(value, maximum) {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= maximum) ? value : undefined;
}

// Reads one signed `controller.cli_session.usage` event back out of an audit
// tail. Mirrors controller-meter-ledger.js's recordFromAuditEvent(): accepts
// either the stored envelope or audit.tail()'s flattened shape, and returns
// null (never a partial guess) for anything that is not a well-formed
// observation.
function usageFromAuditEvent(event) {
  if (!isObject(event)) return null;
  const auditEvent = isObject(event.event) ? event.event : event;
  if (auditEvent.action !== CLI_SESSION_USAGE_ACTION) return null;
  const details = auditEvent.details;
  if (!isObject(details) || details.schemaVersion !== SCHEMA_VERSION) return null;
  if (!PROVIDERS.includes(details.provider) || details.sourceKind !== SOURCE_KIND) return null;
  if (typeof details.observationId !== 'string' || !OBSERVATION_ID_RE.test(details.observationId)) return null;
  if (typeof details.brokerExcluded !== 'boolean') return null;
  if (!['complete', 'partial'].includes(details.coverage)) return null;
  const operationCount = nullableCount(details.operationCount, REASONABLE_COUNT);
  const reportedTokens = nullableCount(details.reportedTokens, REASONABLE_COUNT);
  const durationMs = nullableCount(details.durationMs, REASONABLE_COUNT);
  const outputBytes = nullableCount(details.outputBytes, REASONABLE_COUNT);
  const transcriptCount = nullableCount(details.transcriptCount, REASONABLE_COUNT);
  if (operationCount === undefined || reportedTokens === undefined || durationMs === undefined ||
      outputBytes === undefined || transcriptCount === undefined) return null;
  if (!Number.isSafeInteger(operationCount) || !Number.isSafeInteger(transcriptCount)) return null;
  return Object.freeze({
    provider: details.provider,
    observationId: details.observationId,
    sourceKind: SOURCE_KIND,
    brokerExcluded: details.brokerExcluded,
    coverage: details.coverage,
    operationCount,
    reportedTokens,
    durationMs,
    outputBytes,
    transcriptCount
  });
}

module.exports = Object.freeze({
  CLI_SESSION_USAGE_ACTION,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  PROVIDERS,
  SCHEMA_VERSION,
  SOURCE_KIND,
  claudeUsageFromLine,
  codexUsageFromLine,
  collectCliSessionUsage,
  usageFromAuditEvent
});
