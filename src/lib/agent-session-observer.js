'use strict';

// OBSERVED agent type, read from provider session records.
//
// `controller-launch-record.js` records the type the controller DECLARED at
// spawn time. This module records the type a provider ACTUALLY ran, read from
// the provider's own local session records. The two are deliberately separate
// and are reconciled -- never merged -- by
// `agent-attribution-projection.js`, exactly as agent-org.js keeps declared
// org separate from observed ledger activity.
//
// Hard invariants, in the order they matter:
//
//  1. NEVER read message content. Session transcripts hold the owner's
//     prompts, provider output, tool arguments, and tool results. This module
//     extracts a fixed, closed set of structural discriminators (record type,
//     model id, effort label, entrypoint, session id, timestamp) and passes
//     every one of them through a strict allowlist regex before it can leave
//     the module. A field that fails its regex becomes null with a reason --
//     it is never emitted "best effort". That regex gate, not the field list
//     alone, is what makes a content leak structurally impossible: even if a
//     future provider moved prose into `model`, the value could not escape.
//
//  2. NEVER invent or estimate a type or tier. The provider's own recorded
//     model id and effort label are facts and are reported as read. The
//     cheap/standard/premium COST tier is reported only where this repo has a
//     recorded rate card for that exact model id (see COST_TIER_BY_MODEL);
//     everywhere else it is `unknown` with a stated reason. Ordering model
//     names by assumed price would be a guess, and a guessed tier is exactly
//     the defect this observer exists to prevent.
//
//  3. NEVER claim more coverage than was read. Provider transcript corpora can
//     be large. Every scan is bounded by file count, per-file head/tail byte
//     windows, and age; hitting any bound downgrades `coverage` to 'partial'
//     and appends a note, rather than silently truncating.
//
// Provider record shapes this reader supports:
//
//   Claude Code -- %USERPROFILE%\.claude\projects\<slug>\<sessionId>.jsonl
//     `type:"assistant"` records carry `message.model` (claude-opus-5,
//     claude-sonnet-5, claude-fable-5, claude-haiku-4-5-20251001), a
//     TOP-LEVEL `effort` (max | xhigh | high), `message.usage.service_tier`
//     and `message.usage.speed`, plus `entrypoint`
//     (claude-vscode = interactive IDE session, sdk-cli = SDK/subagent run),
//     `isSidechain`, `version`, `gitBranch`, `cwd`, `sessionId`.
//
//   Claude Code subagents -- <sessionId>\subagents\**\agent-<id>.jsonl with a
//     sibling `agent-<id>.meta.json`. The meta file is where the harness's own
//     DECLARED agent type lives, and it is the single richest thing either
//     provider exposes:
//       {"agentType":"general-purpose","name":"worker","spawnDepth":1,
//        "model":"sonnet","parentAgentId":"<opaque-id>", ...}
//     `agentType` and `name` identify the observed agent type directly;
//     `model` there is the harness's requested ALIAS (sonnet) while
//     the transcript's `message.model` is the concrete id actually served
//     (claude-sonnet-5). Both are kept, never collapsed. The meta file's
//     `description` and `toolUseId` are deliberately NOT read: the first is
//     free-form model-authored prose and the second is a correlation id with
//     no dashboard value.
//
//   Codex CLI -- %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-<iso>-<uuid>.jsonl
//     `type:"turn_context"` records carry `payload.model` (gpt-5.6-sol,
//     gpt-5.6-terra, gpt-5.6-luna, codex-auto-review) and `payload.effort`
//     (ultra | max | xhigh | high | medium | low). `type:"session_meta"`
//     (first line) carries `payload.originator`, `payload.thread_source`
//     ('user' | 'subagent'), `payload.parent_thread_id`,
//     `payload.agent_path`, `payload.cli_version`, `payload.git.branch`.
//
// A session's type is not necessarily constant. The observation
// carries both the latest observed type and a bounded mix, rather than
// collapsing to one value that would be wrong most of the time.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const PROVIDERS = Object.freeze(['claude', 'codex']);
const OBSERVATION_METHOD = 'session-file-metadata-scan';
const ROOT_INSPECTION_FAILED = 'AGENT_SESSION_ROOT_INSPECTION_FAILED';
const COST_TIERS = Object.freeze(['cheap', 'standard', 'premium']);
const SESSION_KINDS = Object.freeze(['interactive', 'subagent', 'unknown']);

// --- bounds ------------------------------------------------------------------

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 200;
// The Codex `session_meta` line (the only place thread_source/originator/
// agent_path live) is the FIRST line of a rollout and measured ~19 KB on this
// machine. 256 KiB of head is far past that with room for format drift.
const HEAD_BYTES = 256 * 1024;
// Model and effort appear on every assistant record / turn_context, so the
// tail is where the CURRENT type lives. 1 MiB comfortably spans several turns
// even when large tool results sit between them.
const TAIL_BYTES = 1024 * 1024;
const MAX_MODEL_MIX = 8;
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_ENTRIES = 20_000;

// --- the allowlist gate (invariant 1) ----------------------------------------

// Deliberately narrow. A provider model id, an effort label, a service tier,
// and an entrypoint are all lowercase slugs in both formats; prose is not.
const TOKEN_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;
const SELECTED_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const VERSION_RE = /^[0-9][0-9A-Za-z._-]{0,31}$/;
// Codex's own spawn label for a subagent thread, e.g.
// "/root/terra_q17_baseline_review". Provider-supplied and therefore
// untrusted; bounded to a slug path so it can carry no markup or prose.
const AGENT_PATH_RE = /^\/[A-Za-z0-9][A-Za-z0-9_./-]{0,119}$/;
// Claude subagent identity, from the transcript filename and its sibling
// meta file. `name` and `agentType` are chosen by the spawning model, so they
// are treated as untrusted labels and bounded to a slug.
const AGENT_FILE_RE = /^agent-([0-9a-f]{8,64})\.jsonl$/;
const AGENT_ID_RE = /^[0-9a-f]{8,64}$/;
const AGENT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
// Claude project layout: <root>/<project-slug>/<sessionId>.jsonl for a top
// level session, or <root>/<project-slug>/<sessionId>/subagents/**/agent-*.jsonl
// for a subagent. Anything else under that tree (tool-results/*.txt,
// workflows/*.json, and any future sibling) is out of scope by construction
// rather than by hoping its records fail the type filter.
const CLAUDE_SESSION_FILE_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}\.jsonl$/;
const MAX_AGENT_META_BYTES = 64 * 1024;
const MAX_SPAWN_DEPTH = 64;
// Second gate, borrowed verbatim in spirit from controller-launch-record.js:
// nothing secret-shaped leaves this module even if it satisfied a shape regex.
const SENSITIVE = /(?:-----BEGIN|\bbearer\s+|\b(?:token|password|cookie|otp|secret)\b|AIza[0-9A-Za-z_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})/i;

/**
 * The single choke point every observed string passes through. Returns the
 * value only if it is a string matching `pattern` and carrying nothing
 * secret-shaped; otherwise null. There is no "close enough" branch.
 */
function gate(value, pattern) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!pattern.test(value)) return null;
  if (SENSITIVE.test(value)) return null;
  return value;
}

function msOf(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

function isoOrNull(ms) {
  return Number.isSafeInteger(ms) && ms >= 0 ? new Date(ms).toISOString() : null;
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// --- cost tier: recorded rate card only (invariant 2) ------------------------

// Product-level Codex tier classification. The cheap/standard/premium
// vocabulary is controller-launch-record.js's TIERS, reused so declared and
// observed tiers are directly comparable, and it matches
// controller-projection.js's ROSTER_TIER_BY_AGENT_ID for the same three tiers.
//
// There is deliberately NO Claude entry. No product tier mapping for Anthropic
// model classes is declared here, and ordering model names by assumed price
// would invent a taxonomy.
// Claude's observed MODEL and EFFORT are still reported in full -- only the
// cost bucket stays unknown, and it says why.
const RATE_CARD_SOURCE = 'built-in Codex tier classification (Luna cheap / Terra standard / Sol premium)';
const COST_TIER_BY_MODEL = Object.freeze({
  'gpt-5.6-luna': 'cheap',
  'gpt-5.6-terra': 'standard',
  'gpt-5.6-sol': 'premium'
});

const NO_RATE_CARD_REASON = Object.freeze({
  claude: 'no product tier mapping for Anthropic model classes is declared; ranking model names by assumed price would be a guess',
  codex: 'this model id has no entry in the Codex tier map (only gpt-5.6-luna/terra/sol do)'
});

/**
 * Resolve the cost tier for an observed model id, or `unknown` with a stated
 * reason. Never falls back to a default tier: an unmapped model is a fact
 * about this repo's records, not a reason to guess.
 */
function costTierForModel(provider, model, overrides) {
  const table = plain(overrides) ? overrides : COST_TIER_BY_MODEL;
  if (model === null) {
    return { costTier: 'unknown', costTierSource: null, costTierReason: 'no model id was observed in the scanned window' };
  }
  const mapped = Object.hasOwn(table, model) ? table[model] : null;
  if (mapped && COST_TIERS.includes(mapped)) {
    return { costTier: mapped, costTierSource: RATE_CARD_SOURCE, costTierReason: null };
  }
  return {
    costTier: 'unknown',
    costTierSource: null,
    costTierReason: NO_RATE_CARD_REASON[provider] || 'no recorded rate card covers this provider'
  };
}

// --- bounded file scan -------------------------------------------------------

function scanFiles(root, { accept, maxAgeMs, nowMs }) {
  const found = [];
  let readErrors = 0;
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_ENTRIES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { readErrors += 1; return; }
    for (const entry of entries) {
      if (visited >= MAX_SCAN_ENTRIES) return;
      visited += 1;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      if (!accept(entry.name)) continue;
      let stat;
      try { stat = fs.statSync(full); }
      catch { readErrors += 1; continue; }
      if (nowMs - stat.mtimeMs > maxAgeMs) continue;
      found.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(root, 0);
  // Newest first: when the file cap cuts the scan short, the freshest activity
  // is what survives, and `coverage` says the rest was not read.
  return {
    files: found.sort((left, right) => right.mtimeMs - left.mtimeMs),
    readErrors
  };
}

// Reads a bounded head window and a bounded tail window and returns COMPLETE
// lines only. A partial line at either boundary is discarded rather than
// parsed: half a JSON record cannot yield a trustworthy field, and a lenient
// parse is how content leaks start.
function readEdges(file, size) {
  let handle;
  try { handle = fs.openSync(file, 'r'); }
  catch { return { head: [], tail: [], truncated: false, readError: true }; }
  try {
    const headLength = Math.min(size, HEAD_BYTES);
    const headBuffer = Buffer.allocUnsafe(headLength);
    const headRead = fs.readSync(handle, headBuffer, 0, headLength, 0);
    const headChunk = headBuffer.subarray(0, headRead);
    const headEnd = headChunk.lastIndexOf(0x0a);
    const head = headEnd < 0 ? [] : headChunk.subarray(0, headEnd).toString('utf8').split('\n');

    // Never let the tail window overlap the head window: a line read twice
    // would inflate the per-type record counts this module reports.
    const tailStart = Math.max(headLength, size - TAIL_BYTES);
    let tail = [];
    if (size > tailStart) {
      const tailLength = size - tailStart;
      const tailBuffer = Buffer.allocUnsafe(tailLength);
      const tailRead = fs.readSync(handle, tailBuffer, 0, tailLength, tailStart);
      const tailChunk = tailBuffer.subarray(0, tailRead);
      // Drop the leading partial line unless the tail window began at byte 0.
      const firstNewline = tailStart === 0 ? -1 : tailChunk.indexOf(0x0a);
      const body = firstNewline < 0 && tailStart !== 0 ? Buffer.alloc(0) : tailChunk.subarray(firstNewline + 1);
      const lastNewline = body.lastIndexOf(0x0a);
      const complete = lastNewline < 0 ? body : body.subarray(0, lastNewline);
      tail = complete.length === 0 ? [] : complete.toString('utf8').split('\n');
    }
    return { head, tail, truncated: size > HEAD_BYTES + TAIL_BYTES, readError: false };
  } catch {
    return { head: [], tail: [], truncated: false, readError: true };
  } finally {
    try { fs.closeSync(handle); } catch { /* the read result already stands */ }
  }
}

// --- per-provider metadata readers -------------------------------------------
//
// Both readers touch ONLY the fields named in the module header. Neither ever
// dereferences `message.content`, `payload.content`, `payload.text`,
// `toolUseResult`, `arguments`, or `instructions`.

function newState(provider, sourceRef) {
  return {
    provider,
    sourceRef,
    sessionId: null,
    parentSessionId: null,
    surface: null,
    threadSource: null,
    declaredAgentPath: null,
    cliVersion: null,
    gitBranch: null,
    workspace: null,
    serviceTier: null,
    agentId: null,
    parentAgentId: null,
    agentType: null,
    agentName: null,
    declaredModelAlias: null,
    spawnDepth: null,
    agentMetaSource: null,
    agentMetaUnknownReason: null,
    parseErrors: 0,
    latest: null,        // { model, effort, atMs }
    mix: new Map(),      // `${model}|${effort}` -> { model, effort, records, lastAtMs }
    recordCount: 0,
    firstAtMs: null,
    lastAtMs: null
  };
}

function noteType(state, model, effort, atMs) {
  const key = `${model}|${effort}`;
  const entry = state.mix.get(key) || { model, effort, records: 0, lastAtMs: null };
  entry.records += 1;
  if (atMs !== null && (entry.lastAtMs === null || atMs > entry.lastAtMs)) entry.lastAtMs = atMs;
  state.mix.set(key, entry);
  if (state.latest === null || atMs === null || state.latest.atMs === null || atMs >= state.latest.atMs) {
    state.latest = { model, effort, atMs };
  }
}

function noteTime(state, atMs) {
  if (atMs === null) return;
  if (state.firstAtMs === null || atMs < state.firstAtMs) state.firstAtMs = atMs;
  if (state.lastAtMs === null || atMs > state.lastAtMs) state.lastAtMs = atMs;
}

function claudeLineToState(line, state) {
  if (line.length < 32) return;
  let record;
  try { record = JSON.parse(line); }
  catch { state.parseErrors += 1; return; }
  if (!plain(record) || record.type !== 'assistant') return;
  const message = plain(record.message) ? record.message : null;
  if (!message) return;

  state.recordCount += 1;
  const atMs = msOf(record.timestamp);
  noteTime(state, atMs);

  if (state.sessionId === null) state.sessionId = gate(record.sessionId, UUID_RE);
  if (state.surface === null) state.surface = gate(record.entrypoint, TOKEN_RE);
  if (state.cliVersion === null) state.cliVersion = gate(record.version, VERSION_RE);
  if (state.gitBranch === null) state.gitBranch = gate(record.gitBranch, BRANCH_RE);
  if (state.workspace === null && typeof record.cwd === 'string') {
    // Only the workspace folder NAME, never the full path: the project
    // identity is the useful part and the directory layout is not.
    state.workspace = gate(path.basename(record.cwd.replace(/[\\/]+$/, '')), WORKSPACE_RE);
  }
  if (state.threadSource === null && typeof record.isSidechain === 'boolean') {
    state.threadSource = record.isSidechain ? 'sidechain' : 'user';
  }
  const usage = plain(message.usage) ? message.usage : null;
  if (usage && state.serviceTier === null) state.serviceTier = gate(usage.service_tier, TOKEN_RE);

  const model = gate(message.model, TOKEN_RE);
  // `effort` is top level on the assistant record, not inside message.usage.
  const effort = gate(record.effort, TOKEN_RE);
  if (model !== null) noteType(state, model, effort, atMs);
}

function codexLineToState(line, state) {
  if (line.length < 32) return;
  // Cheap prefilter: skip the overwhelming majority of rollout lines
  // (reasoning, messages, function calls, token counts) without parsing them
  // at all. Nothing that survives this filter carries message content.
  if (!line.includes('"turn_context"') && !line.includes('"session_meta"')) return;
  let record;
  try { record = JSON.parse(line); }
  catch { state.parseErrors += 1; return; }
  if (!plain(record)) return;
  const payload = plain(record.payload) ? record.payload : null;
  if (!payload) return;
  const atMs = msOf(record.timestamp);

  if (record.type === 'session_meta') {
    noteTime(state, atMs);
    if (state.sessionId === null) state.sessionId = gate(payload.id, UUID_RE) || gate(payload.session_id, UUID_RE);
    if (state.parentSessionId === null) state.parentSessionId = gate(payload.parent_thread_id, UUID_RE);
    if (state.surface === null) {
      // `originator` is "codex_vscode" or "Codex Desktop" depending on build;
      // lowercase-and-slug it so it survives the token gate as one stable
      // discriminator rather than being dropped as unrecognised.
      const originator = typeof payload.originator === 'string'
        ? payload.originator.toLowerCase().replace(/\s+/g, '-')
        : null;
      state.surface = gate(originator, TOKEN_RE);
    }
    if (state.threadSource === null) state.threadSource = gate(payload.thread_source, TOKEN_RE);
    if (state.declaredAgentPath === null) state.declaredAgentPath = gate(payload.agent_path, AGENT_PATH_RE);
    if (state.cliVersion === null) state.cliVersion = gate(payload.cli_version, VERSION_RE);
    if (state.gitBranch === null && plain(payload.git)) state.gitBranch = gate(payload.git.branch, BRANCH_RE);
    if (state.workspace === null && typeof payload.cwd === 'string') {
      state.workspace = gate(path.basename(payload.cwd.replace(/[\\/]+$/, '')), WORKSPACE_RE);
    }
    return;
  }

  if (record.type !== 'turn_context') return;
  state.recordCount += 1;
  noteTime(state, atMs);
  const model = gate(payload.model, TOKEN_RE);
  const effort = gate(payload.effort, TOKEN_RE);
  if (model !== null) noteType(state, model, effort, atMs);
}

// --- Claude subagent identity (the declared type inside the harness) ---------

/**
 * Read the sibling `agent-<id>.meta.json` for a Claude subagent transcript.
 * Every field passes the same allowlist gate as everything else, and
 * `description` (free-form prose written by the spawning model) is never
 * touched. A missing, oversized, or malformed meta file leaves the identity
 * fields null -- it is never partially guessed from the transcript.
 */
function enrichClaudeAgent(file, state) {
  const match = AGENT_FILE_RE.exec(path.basename(file));
  if (!match) return;
  state.agentId = gate(match[1], AGENT_ID_RE);
  const metaFile = file.replace(/\.jsonl$/, '.meta.json');
  let raw;
  try {
    const stat = fs.statSync(metaFile);
    if (!stat.isFile()) {
      state.agentMetaUnknownReason = 'the sibling agent meta path is not a regular file';
      return;
    }
    if (stat.size > MAX_AGENT_META_BYTES) {
      state.agentMetaUnknownReason = 'the sibling agent meta file exceeded the bounded read size';
      return;
    }
    raw = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch (error) {
    state.agentMetaUnknownReason = error && error.code === 'ENOENT'
      ? 'no agent-<id>.meta.json accompanied this transcript'
      : 'the sibling agent meta file could not be read or parsed';
    return;
  }
  if (!plain(raw)) {
    state.agentMetaUnknownReason = 'the sibling agent meta file did not contain an object';
    return;
  }
  state.agentType = gate(raw.agentType, AGENT_LABEL_RE);
  state.agentName = gate(raw.name, AGENT_LABEL_RE);
  state.declaredModelAlias = gate(raw.model, TOKEN_RE);
  state.parentAgentId = gate(raw.parentAgentId, AGENT_ID_RE);
  state.spawnDepth = Number.isSafeInteger(raw.spawnDepth) && raw.spawnDepth >= 0 && raw.spawnDepth <= MAX_SPAWN_DEPTH
    ? raw.spawnDepth
    : null;
  state.agentMetaSource = 'claude-subagent-meta';
}

// --- observation assembly ----------------------------------------------------

function classifyKind(state) {
  if (state.provider === 'claude') {
    // Subagent evidence wins over entrypoint: a sidechain transcript carries
    // the PARENT's entrypoint (claude-vscode), so checking entrypoint first
    // would report every subagent as an interactive owner session.
    if (state.agentId !== null) return { kind: 'subagent', kindReason: 'subagents/agent-*.jsonl transcript' };
    if (state.threadSource === 'sidechain') return { kind: 'subagent', kindReason: 'isSidechain true' };
    if (state.surface === 'sdk-cli') return { kind: 'subagent', kindReason: 'entrypoint sdk-cli (SDK/headless run, not an owner-driven IDE session)' };
    if (state.surface === 'claude-vscode') return { kind: 'interactive', kindReason: 'entrypoint claude-vscode' };
    return { kind: 'unknown', kindReason: 'no entrypoint discriminator was observed in the scanned window' };
  }
  if (state.threadSource === 'subagent') return { kind: 'subagent', kindReason: 'session_meta.thread_source subagent' };
  if (state.threadSource === 'user') return { kind: 'interactive', kindReason: 'session_meta.thread_source user' };
  return { kind: 'unknown', kindReason: 'session_meta was not reached in the scanned head window' };
}

function toObservation(state, options) {
  const model = state.latest ? state.latest.model : null;
  const effort = state.latest ? state.latest.effort : null;
  const tier = costTierForModel(state.provider, model, options.costTierTable);
  const { kind, kindReason } = classifyKind(state);

  const mix = [...state.mix.values()]
    .sort((left, right) => (right.lastAtMs || 0) - (left.lastAtMs || 0) || right.records - left.records)
    .slice(0, MAX_MODEL_MIX)
    .map(entry => Object.freeze({
      model: entry.model,
      effort: entry.effort,
      records: entry.records,
      lastObservedAt: isoOrNull(entry.lastAtMs)
    }));

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    origin: 'observed',
    provider: state.provider,
    // sourceRef is the stable per-observation identity. sessionId alone is
    // NOT unique: every Claude subagent transcript carries its parent's
    // sessionId, so ten subagents of one session share one sessionId.
    observationRef: state.sourceRef,
    sessionId: state.sessionId,
    parentSessionId: state.parentSessionId,
    sourceRef: state.sourceRef,
    agentId: state.agentId,
    parentAgentId: state.parentAgentId,
    agentType: state.agentType,
    agentName: state.agentName,
    spawnDepth: state.spawnDepth,
    declaredModelAlias: state.declaredModelAlias,
    agentMetaSource: state.agentMetaSource,
    agentTypeUnknownReason: state.agentType === null
      ? (state.provider === 'codex'
        ? 'the Codex rollout format records no agent-type field; session_meta.agent_path is the closest label it exposes'
        : (state.agentId === null
          ? 'this is a top-level Claude session, not an agent-<id>.jsonl subagent transcript'
          : (state.agentMetaUnknownReason || 'the sibling agent meta file contained no valid agentType field')))
      : null,
    surface: state.surface,
    threadSource: state.threadSource,
    kind,
    kindReason,
    declaredAgentPath: state.declaredAgentPath,
    cliVersion: state.cliVersion,
    gitBranch: state.gitBranch,
    workspace: state.workspace,
    serviceTier: state.serviceTier,
    model,
    modelSource: model === null ? null
      : (state.provider === 'claude' ? 'assistant.message.model' : 'turn_context.payload.model'),
    modelUnknownReason: model === null
      ? 'no model-bearing record was present in the scanned head/tail window'
      : null,
    effort,
    effortSource: effort === null ? null
      : (state.provider === 'claude' ? 'assistant.effort' : 'turn_context.payload.effort'),
    effortUnknownReason: effort === null
      ? (model === null
        ? 'no model-bearing record was present in the scanned head/tail window'
        : 'this provider record carried a model but no effort label')
      : null,
    ...tier,
    // A single string a dashboard can render without re-deriving anything, and
    // which reads honestly when a part is missing.
    typeLabel: model === null ? 'unknown' : (effort === null ? model : `${model} (${effort})`),
    modelMix: Object.freeze(mix),
    typeChangedDuringSession: mix.length > 1,
    firstObservedAt: isoOrNull(state.firstAtMs),
    firstObservedAtMs: state.firstAtMs,
    observedAt: isoOrNull(state.lastAtMs),
    observedAtMs: state.lastAtMs,
    recordCount: state.recordCount,
    method: OBSERVATION_METHOD
  });
}

function sourceRefOf(file) {
  return crypto.createHash('sha256').update(`toolsenabled.agent-session-observer.v${SCHEMA_VERSION}\0${file}`).digest('base64url').slice(0, 22);
}

function claudeRoot(home) { return path.join(home, '.claude', 'projects'); }
function codexRoot(home) { return path.join(home, '.codex', 'sessions'); }

const ACCEPT = Object.freeze({
  claude: name => CLAUDE_SESSION_FILE_RE.test(name) || AGENT_FILE_RE.test(name),
  codex: name => name.startsWith('rollout-') && name.endsWith('.jsonl')
});
const ENRICH = Object.freeze({
  claude: enrichClaudeAgent,
  codex: () => {}
});

function observeProvider({ provider, root, parseLine, options, nowMs }) {
  const selected = options.selectedSessionIds;
  const maxAgeMs = selected ? Number.MAX_SAFE_INTEGER : Number.isSafeInteger(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const maxFiles = Number.isSafeInteger(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES;
  const notes = [];
  let rootPresent;
  let rootInspectionError = false;
  try { rootPresent = fs.statSync(root).isDirectory(); }
  catch (error) {
    rootPresent = false;
    rootInspectionError = !error || error.code !== 'ENOENT';
  }
  if (!rootPresent) {
    // An absent root is NOT "no agents ran". It is an unobservable provider,
    // and the projection must be able to say so.
    return {
      sessions: [],
      scan: Object.freeze({
        provider,
        rootPresent: rootInspectionError ? null : false,
        inspectionErrorCode: rootInspectionError ? ROOT_INSPECTION_FAILED : null,
        filesSeen: 0,
        filesRead: 0,
        truncatedFiles: 0
      }),
      coverage: 'unavailable',
      notes: [rootInspectionError
        ? `${provider}: the local session record root could not be inspected, so ${provider} sessions were not measured; this does NOT claim the root is absent`
        : `${provider}: no local session record root is present, so no ${provider} session is observable`]
    };
  }

  const accept = name => ACCEPT[provider](name) && (!selected || selected.some(id =>
    name.toLowerCase() === `${id}.jsonl` || (provider === 'codex' && name.toLowerCase().endsWith(`-${id}.jsonl`))));
  const scan = scanFiles(root, { accept, maxAgeMs, nowMs });
  const files = scan.files;
  const enrich = ENRICH[provider];
  let coverage = 'complete';
  if (scan.readErrors > 0) {
    coverage = 'partial';
    notes.push(`${provider}: ${scan.readErrors} filesystem location(s) could not be read, so the session scan is incomplete`);
  }
  if (files.length > maxFiles) {
    coverage = 'partial';
    notes.push(`${provider}: ${files.length} session files were in the age window but only the ${maxFiles} newest were read`);
  }
  const sessions = [];
  let truncatedFiles = 0;
  let filesRead = 0;
  let fileReadErrors = 0;
  let parseErrors = 0;
  for (const candidate of files.slice(0, maxFiles)) {
    const { head, tail, truncated, readError } = readEdges(candidate.file, candidate.size);
    if (readError) {
      fileReadErrors += 1;
      continue;
    }
    filesRead += 1;
    if (truncated) truncatedFiles += 1;
    const state = newState(provider, sourceRefOf(candidate.file));
    enrich(candidate.file, state);
    for (const line of head) parseLine(line, state);
    for (const line of tail) parseLine(line, state);
    parseErrors += state.parseErrors;
    if (state.recordCount === 0 && state.sessionId === null) continue;
    const observation = toObservation(state, options);
    // A matching filename is only a candidate, never source identity proof.
    if (selected && !selected.includes(String(observation.sessionId || '').toLowerCase())) {
      parseErrors += 1;
      continue;
    }
    sessions.push(observation);
    // A trusted in-process host can retain the source behind an opaque,
    // owner-bound receipt. Paths never enter the public observation, and this
    // callback receives the same metadata-only record as every other reader.
    // JSON tool callers cannot supply a function.
    if (typeof options.onSource === 'function') options.onSource(candidate.file, observation);
  }
  if (truncatedFiles > 0) {
    coverage = coverage === 'complete' ? 'partial' : coverage;
    notes.push(`${provider}: ${truncatedFiles} session file(s) exceeded the head+tail byte window, so their middle was not read`);
  }
  if (fileReadErrors > 0) {
    coverage = 'partial';
    notes.push(`${provider}: ${fileReadErrors} discovered session file(s) could not be read, so their sessions are unavailable`);
  }
  if (parseErrors > 0) {
    coverage = 'partial';
    notes.push(`${provider}: ${parseErrors} complete session record line(s) could not be parsed, so record-derived counts and statuses are incomplete`);
  }
  return {
    sessions,
    scan: Object.freeze({ provider, rootPresent: true, inspectionErrorCode: null, filesSeen: files.length, filesRead, truncatedFiles }),
    coverage,
    notes
  };
}

/**
 * Observe the agent type actually running in each recent local Claude Code and
 * Codex CLI session. Returns metadata only -- see the module header's
 * invariants. `options.home`, `options.claudeRoot`, `options.codexRoot`,
 * `options.maxFiles`, `options.maxAgeMs`, `options.maxSessions`,
 * `options.costTierTable`, and `options.nowMs` are all injectable so the
 * caller (and the tests) never depend on this machine's real corpora.
 */
function observeAgentSessions(options = {}) {
  if (options.selectedSessionIds !== undefined) {
    if (!Array.isArray(options.selectedSessionIds) || options.selectedSessionIds.length === 0
        || options.selectedSessionIds.length > 8 || options.selectedSessionIds.some(id => typeof id !== 'string' || !SELECTED_SESSION_ID_RE.test(id))) {
      throw new TypeError('Choose between one and eight saved session identifiers.');
    }
    options = { ...options, selectedSessionIds: [...new Set(options.selectedSessionIds.map(id => id.toLowerCase()))] };
  }
  const nowMs = Number.isSafeInteger(options.nowMs) ? options.nowMs : Date.now();
  const home = typeof options.home === 'string' && options.home ? options.home : os.homedir();
  const maxSessions = Number.isSafeInteger(options.maxSessions) ? options.maxSessions : DEFAULT_MAX_SESSIONS;

  const requested = options.providers === undefined ? PROVIDERS : options.providers;
  if (!Array.isArray(requested) || requested.length === 0 || requested.some(provider => !PROVIDERS.includes(provider))) {
    throw new TypeError('Session discovery requires supported provider names');
  }
  const observed = [...new Set(requested)].map(provider => observeProvider({
    provider,
    root: provider === 'claude'
      ? typeof options.claudeRoot === 'string' ? options.claudeRoot : claudeRoot(home)
      : typeof options.codexRoot === 'string' ? options.codexRoot : codexRoot(home),
    parseLine: provider === 'claude' ? claudeLineToState : codexLineToState,
    options, nowMs
  }));

  const notes = observed.flatMap(result => result.notes);
  const all = observed.flatMap(result => result.sessions)
    .sort((left, right) => (right.observedAtMs || 0) - (left.observedAtMs || 0));
  let sessions = all;
  let coverage = observed.some(result => result.coverage === 'partial') ? 'partial' : 'complete';
  if (observed.every(result => result.coverage === 'unavailable')) coverage = 'unavailable';
  else if (observed.some(result => result.coverage === 'unavailable')) coverage = 'partial';
  if (all.length > maxSessions) {
    sessions = all.slice(0, maxSessions);
    coverage = 'partial';
    notes.push(`${all.length} sessions were observed but only the ${maxSessions} most recent are reported`);
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    generatedAtMs: nowMs,
    method: OBSERVATION_METHOD,
    coverage,
    coverageNotes: Object.freeze(notes),
    scans: Object.freeze(observed.map(result => result.scan)),
    sessions: Object.freeze(sessions)
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  PROVIDERS,
  COST_TIERS,
  SESSION_KINDS,
  OBSERVATION_METHOD,
  ROOT_INSPECTION_FAILED,
  COST_TIER_BY_MODEL,
  RATE_CARD_SOURCE,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_SESSIONS,
  HEAD_BYTES,
  TAIL_BYTES,
  costTierForModel,
  claudeLineToState,
  codexLineToState,
  observeAgentSessions
});
