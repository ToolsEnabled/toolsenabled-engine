#!/usr/bin/env node
'use strict';

// One command turning the owner's words into durable ledger state, built to
// close the exact gap that caused R44's "dropped instruction" failure: a
// paraphrase happened at CAPTURE time ("that i had submitted" quietly
// disappeared while writing the summary), long before any agent decided
// what to do with the request. STANDING-ORDERS.md RECORD rule 1a says
// verbatim wins over interpretation -- this tool is the mechanical way that
// rule gets satisfied instead of relying on whoever is transcribing to
// remember to keep every word.
//
// Design constraints that follow directly from the incident:
//   - Verbatim text is APPEND-ONLY. This tool has no flag that can replace or
//     shorten an existing `verbatim` field, only extend it. There is no
//     "--verbatim-full" escape hatch; the only way in is through --text, and
//     --text is always concatenated, never substituted.
//   - Sub-instructions become `gates` (RECORD rule 1), not prose buried in a
//     summary. --gate is repeatable and each one lands as an unmet gate
//     ({instruction, met:false, evidence:''}) that egress-preflight.js's
//     assertGatesMet() can enforce before an outward action.
//   - This tool never marks anything "done". A freshly captured request can
//     only start at open/in-progress/blocked-external -- RECORD rule 2 says a
//     request is never marked done without independent verification, and a
//     capture tool has no verification to offer.
//   - The write is atomic: temp file -> fsync -> read back and JSON-validate
//     the bytes actually on disk -> THEN snapshot the previous content to
//     `<ledger>.bak` -> rename over the original. A crash or a bad write at
//     any point before the rename leaves the original ledger untouched.
//   - A cross-process file lock (reusing the generic PID-staleness pattern
//     already shipped and tested in src/lib/agent-digest/lock.js) serializes
//     concurrent invocations so two captures can never race a
//     read-modify-write and silently drop one of them -- which would be an
//     amusing way for THIS tool to reproduce the exact failure class it
//     exists to close.
//
// Usage:
//   node tools/owner-capture.js --new-id R56 --interpretation "..." \
//     --actor "controller" [--gate "..."]... (--text "..." | piped stdin)
//   node tools/owner-capture.js --request-id R44 --actor "controller" \
//     [--gate "..."]... (--text "..." | piped stdin)
//
// See --help for the full flag reference.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { acquireLock } = require('../src/lib/process-claim-lock');
const spool = require('../src/lib/owner-capture-spool');
const { notifyCapturedDirective } = require('../src/lib/owner-directive-notification');
const { normalizeProvenance } = require('../src/lib/owner-request-provenance');
// reports/ is written at runtime; installed it is not the program directory.
// See src/lib/runtime-state-root.js.
const { statePath } = require('../src/lib/runtime-state-root');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_LEDGER_FILE = statePath('reports', 'OWNER-REQUEST-LEDGER.json');

// The canonical R grammar (src/lib/request-id.js): a root R1..R9999 (legacy
// R01-R09 kept) with dotted refinements, so a rule an agent filed under
// another (R3.1) can carry gates and evidence like any root.
const ID_PATTERN = /^R(?:0\d|[1-9]\d{0,3})(?:\.[1-9]\d*)*$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// MEASURED 2026-09-03: the owner ruled (2026-09-02) that the canonical ledger
// carries four scope tiers -- global, session, tree, thread -- and every other
// writer (src/lib/owner-request-store.js SCOPES, the app's /Request family)
// already speaks all four. This tool was never updated past the two it had
// before that ruling, so `owner-spool-review.js --promote`, the one recovery
// path for a turn an agent read and filed nothing for (see markUnfiled in
// src/lib/owner-capture-spool.js), could not promote it at 'session' or
// 'tree' scope even though shell/agent-host.cjs spoolPersonTurn tags every
// spooled turn scope:'session' at capture time -- the exact tier this tool
// then refused to write back. `node tools/owner-capture.js --new-id R1
// --scope session --thread-id x ...` answered
// OWNER_CAPTURE_SCOPE_INVALID: scope must be global or thread.
const CAPTURE_SCOPES = new Set(['global', 'session', 'tree', 'thread']);
// A capture is a record of what was said, not a verified outcome. RECORD
// rule 2: never mark a request done without independent verification -- so
// "done", "partial", and "not-possible-as-asked" are not reachable through
// this tool at capture time, only through whatever process later verifies
// the work.
const ALLOWED_CAPTURE_STATUSES = new Set(['open', 'in-progress', 'blocked-external']);
const DEFAULT_STATUS = 'open';

const MAX_TEXT_LENGTH = 20000;
const MAX_GATE_LENGTH = 2000;
const MAX_INTERPRETATION_LENGTH = 4000;
const MAX_ACTOR_LENGTH = 200;

// `actor` used to be written to captureLog but never used as an authority
// boundary. That allowed a build-lane brief to be filed as the owner's words
// with actor "codex" (R1098).
//
// The first fix gated on the actor NAME alone, and it was wrong in the other
// direction: it refused `codex` and the local sidecar actor, which can be relays that record
// the owner's actual words. Measured
// against this ledger, `codex` alone had captured 77 owner directives, plus
// `claude` and `codex-assistant` more -- every one of which that gate would
// have blocked. Merging it would have stopped the owner's words being recorded
// at all, which is a worse failure than the one it fixed.
//
// The actor name was never the discriminator. What separates the owner's words
// from an agent's own brief is PROVENANCE: a relay can point at where the text
// came from, and an agent inventing a brief cannot. So:
//   - direct owner identities capture freely
//   - ledger-custody roles capture freely (they hold the file by definition)
//   - EVERY other actor is a relay and must cite --source
// R1098 fails this: a lane brief has no owner-channel source to cite.
const OWNER_CAPTURE_ROLE_PATTERN = /(?:^|[-_ ])(?:controller|coordinator|planning(?:[-_ ](?:and[-_ ])?operations?|[-_ ]ops))(?:$|[-_ ])/i;
// Only the direct owner identity bypasses a source citation. Historical ingress
// actor labels remain valid DATA in old ledger rows, but cannot grant a new
// capture owner authority merely by being supplied on the command line.
const OWNER_INGRESS_ACTORS = new Set(['owner']);
// A source must actually reference something. A bare word is not provenance.
const MIN_SOURCE_LENGTH = 6;
const MAX_SOURCE_LENGTH = 400;

// Q34: a completion claim made from an edit is not runtime evidence.  When a
// caller tries to attach evidence to a runtime-word gate, require a compact
// post-change destination query with recognizable output.  This is deliberately
// a voluntary-writer check, not a chokepoint: the ledger file remains directly
// writable, so this narrows one failure mode without claiming to close it.
const RUNTIME_GATE_WORD_PATTERN = /\b(?:running|registered|live|delivered|sent|deployed|restarts|continuously)\b/i;
const POST_CHANGE_MARKER_PATTERN = /\b(?:post[-\s]?change|after\s+(?:the\s+)?(?:change|deployment|restart|send|delivery))\b/i;
const DESTINATION_QUERY_EVIDENCE = Object.freeze([
  {
    query: /\bGet-ScheduledTask(?:Info)?\b/i,
    output: /\b(?:TaskName|State|LastRunTime|NextRunTime)\b/i
  },
  {
    query: /\b(?:Get-Process|tasklist(?:\.exe)?)\b/i,
    output: /\b(?:ProcessName|Id|PID|Handles|CPU)\b/i
  },
  {
    query: /\b(?:audit\.(?:verify|status)|audit ledger)\b/i,
    output: /\b(?:valid|sequence|head(?:Hash| sequence)?|signaturesValid)\b/i
  },
  {
    query: /\b(?:recipient inbox|inbox\s+(?:search|query|check))\b/i,
    output: /\b(?:from|to|subject|message-id|received):/i
  }
]);

const KNOWN_FLAGS = new Set([
  'text', 'actor', 'source', 'ledger', 'new-id', 'request-id', 'interpretation', 'status', 'scope', 'thread-id', 'gate', 'hedged-gate',
  'provenance', 'proposal'
]);

const TRANSIENT_WRITE_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const WRITE_ATTEMPTS = 8;

class OwnerCaptureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function usageError(message) {
  return new OwnerCaptureError('OWNER_CAPTURE_USAGE', message);
}

// --- argument parsing --------------------------------------------------------

function parseArgs(argv) {
  const out = { gate: [] };
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      out.help = true;
      index += 1;
      continue;
    }
    if (typeof token !== 'string' || !token.startsWith('--') || token.length < 3) {
      throw usageError(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (!KNOWN_FLAGS.has(key)) throw usageError(`Unknown flag: --${key}`);
    const value = argv[index + 1];
    if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) {
      throw usageError(`--${key} requires a value`);
    }
    if (key === 'gate' || key === 'hedged-gate') {
      out.gate.push({ instruction: value, hedged: key === 'hedged-gate' });
    } else {
      if (Object.hasOwn(out, key)) throw usageError(`Duplicate flag: --${key}`);
      out[key] = value;
    }
    index += 2;
  }
  return out;
}

function nonEmptyTrimmed(value, code, message, maxLength) {
  if (typeof value !== 'string') throw new OwnerCaptureError(code, message);
  const trimmed = value.trim();
  if (!trimmed) throw new OwnerCaptureError(code, message);
  if (maxLength && trimmed.length > maxLength) {
    throw new OwnerCaptureError(code, `${message} (exceeds ${maxLength} characters)`);
  }
  return trimmed;
}

function assertCaptureActor(actor, source) {
  if (typeof actor !== 'string' || actor.trim().length === 0) {
    throw new OwnerCaptureError('OWNER_CAPTURE_ACTOR_REQUIRED', '--actor is required.');
  }
  const privileged = OWNER_INGRESS_ACTORS.has(actor.toLowerCase())
    || OWNER_CAPTURE_ROLE_PATTERN.test(actor);
  if (privileged) return actor;

  // Every other actor is treated as a RELAY, not an author. A relay is welcome
  // -- a sidecar actor and codex can genuinely carry the owner's messages -- but it
  // must say where the words came from.
  const cited = typeof source === 'string' ? source.trim() : '';
  if (cited.length < MIN_SOURCE_LENGTH) {
    // Deliberately keeps the original code: this is still "agent text refused",
    // and existing callers and tests pin that contract. Only the reason is more
    // precise now -- the refusal is for missing provenance, not for the actor's
    // name, so an honest relay can satisfy it instead of being locked out.
    throw new OwnerCaptureError(
      'OWNER_CAPTURE_AGENT_TEXT_REFUSED',
      `Actor ${JSON.stringify(actor)} is a relay, not an owner-ingress or ledger-custody identity, `
        + 'so it must cite --source: where these words came from (e.g. an owner-journal message id '
        + 'and timestamp, or an owner-chat sequence). Agent-authored build, review and coordination '
        + 'briefs have no owner-channel source and are refused here.'
    );
  }
  if (cited.length > MAX_SOURCE_LENGTH) {
    throw new OwnerCaptureError('OWNER_CAPTURE_SOURCE_INVALID', `--source exceeds ${MAX_SOURCE_LENGTH} characters.`);
  }
  return actor;
}

async function readStdinIfPiped() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length ? text : null;
}

function printUsage(stream = process.stdout) {
  stream.write(`Usage:
  node tools/owner-capture.js --new-id R56 --interpretation "..." --actor "controller" [--scope global|session|tree|thread] [--thread-id <id>] [--gate "..." | --hedged-gate "..."]... (--text "..." | piped stdin)
  node tools/owner-capture.js --request-id R44 --actor "controller" [--gate "..." | --hedged-gate "..."]... (--text "..." | piped stdin)

Flags:
  --text            The owner's verbatim words. Omit to read from stdin instead (stdin is read only when it is not a TTY).
  --actor           Required. Owner-ingress or ledger-custody role (e.g. "controller"); agent/build-lane actors are refused.
  --new-id          Create a brand-new ledger entry with this id (e.g. R56). Mutually exclusive with --request-id.
  --interpretation  Required with --new-id only. The controller's paraphrase; the tool labels it "(interpretation)" per STANDING-ORDERS RECORD rule 1a.
  --status          Optional with --new-id only. One of: ${[...ALLOWED_CAPTURE_STATUSES].join(', ')}. Default: ${DEFAULT_STATUS}.
  --scope           Optional with --new-id only. One of: ${[...CAPTURE_SCOPES].join(', ')}. Default: global. Anything but global requires --thread-id.
  --thread-id       Stable scope key (session id, tree anchor id, or thread id) for --scope session|tree|thread. Refused with global scope or append mode.
  --request-id      Append --text to an existing entry's verbatim field (append-only; never rewrites existing text). Mutually exclusive with --new-id.
  --gate            Repeatable. A non-hedged sub-instruction recorded as a new unmet gate.
  --hedged-gate     Repeatable. An exploratory (RECORD 1b) sub-instruction recorded with hedged:true.
  --ledger          Optional. Path to the ledger file. Default: reports/OWNER-REQUEST-LEDGER.json.
  --help            Show this message.

Exactly one of --new-id or --request-id is required. This tool never sets status to done/partial/not-possible-as-asked --
capture is not verification.
`);
}

// --- ledger shape ------------------------------------------------------------

function validateLedgerShape(data, ledgerFile) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new OwnerCaptureError('OWNER_CAPTURE_LEDGER_SHAPE', `${ledgerFile} is not a JSON object.`);
  }
  if (!Array.isArray(data.requests)) {
    throw new OwnerCaptureError('OWNER_CAPTURE_LEDGER_SHAPE', `${ledgerFile} has no "requests" array.`);
  }
  const seen = new Set();
  for (const entry of data.requests) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !entry.id) {
      throw new OwnerCaptureError('OWNER_CAPTURE_LEDGER_SHAPE', `${ledgerFile} has a request entry with no string id.`);
    }
    if (seen.has(entry.id)) {
      throw new OwnerCaptureError('OWNER_CAPTURE_LEDGER_SHAPE', `${ledgerFile} has a duplicate request id: ${entry.id}.`);
    }
    seen.add(entry.id);
  }
}

function todayString(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function toGateObject(gate) {
  const input = typeof gate === 'string' ? { instruction: gate, hedged: false } : gate;
  if (!input || typeof input !== 'object' || typeof input.instruction !== 'string' || typeof input.hedged !== 'boolean') {
    throw new OwnerCaptureError('OWNER_CAPTURE_GATE_INVALID', 'A gate must have a string instruction and boolean hedged marker.');
  }
  return {
    instruction: nonEmptyTrimmed(input.instruction, 'OWNER_CAPTURE_GATE_EMPTY', 'A gate instruction must not be empty.', MAX_GATE_LENGTH),
    hedged: input.hedged,
    met: false,
    evidence: ''
  };
}

function normalizeCaptureScope(scope = 'global', threadId = null) {
  if (!CAPTURE_SCOPES.has(scope)) {
    throw new OwnerCaptureError('OWNER_CAPTURE_SCOPE_INVALID', `scope must be one of: ${[...CAPTURE_SCOPES].join(', ')}.`);
  }
  if (scope === 'global') {
    if (threadId !== null) {
      throw new OwnerCaptureError('OWNER_CAPTURE_SCOPE_INVALID', 'global scope requires threadId:null.');
    }
    return { scope, threadId: null };
  }
  if (typeof threadId !== 'string' || !THREAD_ID_PATTERN.test(threadId)) {
    throw new OwnerCaptureError('OWNER_CAPTURE_SCOPE_INVALID', `${scope} scope requires a stable nonempty threadId.`);
  }
  return { scope, threadId };
}

function hasRuntimeGateWord(instruction) {
  return typeof instruction === 'string' && RUNTIME_GATE_WORD_PATTERN.test(instruction);
}

function runtimeEvidenceError(instruction) {
  throw new OwnerCaptureError(
    'OWNER_CAPTURE_RUNTIME_EVIDENCE_REQUIRED',
    `Refusing runtime evidence for gate ${JSON.stringify(instruction)} without captured post-change destination-query output. `
      + 'Include an explicit post-change marker and output from Get-ScheduledTask, a process table, the audit ledger, or a recipient inbox. '
      + 'owner-capture is a voluntary writer, not a chokepoint; the ledger file remains directly writable.'
  );
}

// A blank evidence field remains valid for a new unmet gate.  Once a caller
// tries to attach evidence (or mark a runtime gate met), the evidence must
// carry both a post-change declaration and recognizable destination output.
function assertRuntimeGateEvidence(instruction, evidence, { required = false } = {}) {
  if (!hasRuntimeGateWord(instruction)) return;
  if (typeof evidence !== 'string') runtimeEvidenceError(instruction);
  const captured = evidence.trim();
  if (!captured) {
    if (required) runtimeEvidenceError(instruction);
    return;
  }
  const hasDestinationQueryOutput = DESTINATION_QUERY_EVIDENCE.some(({ query, output }) =>
    query.test(captured) && output.test(captured));
  if (!POST_CHANGE_MARKER_PATTERN.test(captured) || !hasDestinationQueryOutput) {
    runtimeEvidenceError(instruction);
  }
}

// STANDING-ORDERS.md class RECORD, order 2: "Never mark a request done without
// independent verification. Never soften a status."
//
// The authority-inversion guard for gates, in the same explicit-checked-
// invariant style this file already uses for verbatim text. Structurally
// toGateObject() can only ever produce {met:false}, and applyAppend() only
// concatenates -- but "structurally it cannot happen" is exactly what was true
// of the verbatim path too, right up until it needed a checked invariant.
//
// The concrete shape this refuses is not hypothetical: fleet lane s10 shipped a
// `set-gate` command that would have let an agent self-certify its own egress
// gate (GEMINI-LANE-DOCTRINE failure mode 5, "dangerous helpfulness"). It was
// caught in review. This makes the next one fail here instead of depending on a
// reviewer noticing.
//
// Deliberately NOT enforced here: that the evidence AUTHOR differs from the
// EXECUTOR. No actor identity is threaded to gate mutations anywhere in this
// build, so that check could only be guessed -- and honest-unknown says report
// the gap rather than invent an attribution. See the enforcement report.
function assertGatesAppendOnly(id, existingGates, nextGates) {
  const fail = (message) => {
    throw new OwnerCaptureError('OWNER_CAPTURE_GATES_NOT_APPEND_ONLY', `${message} `
      + 'STANDING-ORDERS.md class RECORD, order 2: "Never mark a request done without independent '
      + 'verification. Never soften a status." This writer is append-only by design and has no flag that '
      + 'can satisfy a gate -- an agent may never certify its own precondition. Fleet lane s10 shipped '
      + 'exactly that (a `set-gate` command) and it was caught only by review.');
  };

  if (nextGates.length < existingGates.length) {
    fail(`Refusing a write to ${id} that would drop ${existingGates.length - nextGates.length} existing gate(s).`);
  }
  for (const [index, existing] of existingGates.entries()) {
    const next = nextGates[index];
    if (!next) fail(`Refusing a write to ${id} that would remove existing gate ${index}.`);
    if (next.instruction !== existing.instruction) {
      fail(`Refusing a write to ${id} that would rewrite the instruction of existing gate ${index}.`);
    }
    if (Object.hasOwn(existing, 'hedged') !== Object.hasOwn(next, 'hedged')
        || (Object.hasOwn(existing, 'hedged') && next.hedged !== existing.hedged)) {
      fail(`Refusing a write to ${id} that would change the hedge marker of existing gate ${index}.`);
    }
    if (next.met !== existing.met) {
      assertRuntimeGateEvidence(next.instruction, next.evidence, { required: next.met === true });
      fail(`Refusing a write to ${id} that would change the met status of existing gate ${index} `
        + `(${existing.met} -> ${next.met}).`);
    }
    if (next.evidence !== existing.evidence) {
      assertRuntimeGateEvidence(next.instruction, next.evidence, { required: true });
      fail(`Refusing a write to ${id} that would change the evidence of existing gate ${index}.`);
    }
  }
  for (const gate of nextGates.slice(existingGates.length)) {
    if (gate.met === true || gate.evidence !== '') {
      assertRuntimeGateEvidence(gate.instruction, gate.evidence, { required: gate.met === true || gate.evidence !== '' });
    }
    if (gate.met !== false || gate.evidence !== '') {
      fail(`Refusing a write to ${id} that would create a NEW gate already marked met `
        + `(${JSON.stringify({ met: gate.met, evidence: gate.evidence })}).`);
    }
  }
  return nextGates;
}

// --- entry construction --------------------------------------------------

// EVERY NEW ENTRY CARRIES ITS PROVENANCE. The owner, 2026-08-11: "Why are agent
// rules stille being pushed as mine". They could be because the ledger had no
// field in which an agent's decision and his instruction could differ.
//
// The class is DERIVED from evidence this capture already had to produce, not
// asked for as a free-text claim, so it cannot be inflated by a caller that
// simply says "owner-stated". Two routes reach it, and the record shows which:
//
//   - A cited --source (an owner-journal id, an owner-chat sequence, a session id).
//     This is the strong form: the channel the words arrived on is named.
//   - A privileged owner-ingress or ledger-custody actor with no citation. The
//     role's assertion IS the evidence here -- that is the existing, tested
//     contract from f3ae016, and narrowing it would stop his words being
//     recorded at all, which is a worse failure than the one being fixed. The
//     synthesized source says exactly that and does not overclaim, so a reader
//     can see it is a role assertion rather than a message id.
//
// `--provenance owner-ratified` is available for the agent-proposed/owner-
// approved case, which needs the proposal recorded too.
function deriveCaptureProvenance({ actor, source, declaredClass, proposal, timestamp }) {
  const cited = typeof source === 'string' ? source.trim() : '';
  const privileged = OWNER_INGRESS_ACTORS.has(String(actor).toLowerCase())
    || OWNER_CAPTURE_ROLE_PATTERN.test(String(actor));
  const resolvedSource = cited
    || (privileged
      ? `asserted by owner-ingress/ledger-custody actor ${JSON.stringify(actor)}; no explicit channel `
        + 'citation was given at capture time'
      : '');
  const klass = declaredClass || 'owner-stated';
  if (klass !== 'owner-stated' && klass !== 'owner-ratified') {
    throw new OwnerCaptureError(
      'OWNER_CAPTURE_PROVENANCE_INVALID',
      `--provenance must be "owner-stated" or "owner-ratified"; got ${JSON.stringify(klass)}. `
      + 'owner-capture records the OWNER\'S words; an agent\'s own decision does not belong here '
      + 'under his name.'
    );
  }
  try {
    return normalizeProvenance({
      class: klass,
      source: resolvedSource,
      recordedBy: actor,
      recordedAt: timestamp,
      ...(proposal ? { proposal } : {})
    });
  } catch (error) {
    // Surface the provenance refusal in this tool's own error vocabulary rather
    // than leaking a second error type to callers that pin these codes.
    throw new OwnerCaptureError('OWNER_CAPTURE_PROVENANCE_INVALID', error.message);
  }
}

function applyNewEntry(data, { id, text, interpretation, status, scope = 'global', threadId = null, gates, actor, source, timestamp, provenanceClass, proposal }) {
  assertCaptureActor(actor, source);
  const captureScope = normalizeCaptureScope(scope, threadId);
  if (data.requests.some(entry => entry && entry.id === id)) {
    throw new OwnerCaptureError(
      'OWNER_CAPTURE_ID_EXISTS',
      `Request ${id} already exists; use --request-id ${id} to append to it instead of --new-id.`
    );
  }
  // Derived only once the write is otherwise valid, so the caller sees the
  // specific, cheaper failure (duplicate id, bad scope) rather than a
  // provenance complaint about an entry that was never going to be written.
  const provenance = deriveCaptureProvenance({
    actor, source, declaredClass: provenanceClass, proposal, timestamp
  });
  const entry = {
    id,
    verbatim: text,
    request: `(interpretation) ${interpretation}`,
    status,
    scope: captureScope.scope,
    // The canonical writer (src/lib/owner-request-store.js fileRequest) keys
    // every non-global scope on `scopeKey` and mirrors it into `threadId`
    // ONLY when scope is 'thread' -- the one field this tool and the
    // pre-unification ledger used before scope grew tree/session tiers, and
    // the one every existing reader (owner-request-store's normalizeRecord
    // threadId fallback, display code) still expects for that tier alone. A
    // session- or tree-scoped entry gets scopeKey and no threadId, matching
    // that same shape instead of overloading a field named for a different
    // tier with a session or tree anchor id.
    scopeKey: captureScope.scope === 'global' ? null : captureScope.threadId,
    threadId: captureScope.scope === 'thread' ? captureScope.threadId : null,
    gates: assertGatesAppendOnly(id, [], gates.map(toGateObject)),
    provenance,
    captureLog: [{ at: timestamp, actor, mode: 'new', gatesAdded: gates.length, ...(source ? { source } : {}) }]
  };
  return finalizeLedger(data, [...data.requests, entry]);
}

function applyAppend(data, { id, text, gates, actor, source, timestamp }) {
  assertCaptureActor(actor, source);
  const index = data.requests.findIndex(entry => entry && entry.id === id);
  if (index === -1) {
    throw new OwnerCaptureError(
      'OWNER_CAPTURE_REQUEST_NOT_FOUND',
      `No existing request ${id} in the ledger; use --new-id ${id} to create it instead of --request-id.`
    );
  }
  const existing = data.requests[index];
  const oldVerbatim = typeof existing.verbatim === 'string' ? existing.verbatim : '';
  const newVerbatim = oldVerbatim ? `${oldVerbatim}\n[APPEND ${timestamp}] ${text}` : text;

  // Structurally this can only ever be true given the construction above --
  // kept as an explicit, checked invariant so a future refactor of this
  // function cannot silently reintroduce a path that shortens or rewrites
  // existing verbatim text.
  if (!newVerbatim.startsWith(oldVerbatim) || newVerbatim.length <= oldVerbatim.length) {
    throw new OwnerCaptureError(
      'OWNER_CAPTURE_VERBATIM_NOT_APPEND_ONLY',
      `Refusing a write to ${id} that would not strictly extend the existing verbatim text.`
    );
  }

  const existingGates = Array.isArray(existing.gates) ? existing.gates : [];
  const nextGates = assertGatesAppendOnly(
    id, existingGates,
    gates.length ? [...existingGates, ...gates.map(toGateObject)] : existingGates
  );
  const existingLog = Array.isArray(existing.captureLog) ? existing.captureLog : [];

  const nextEntry = {
    ...existing,
    verbatim: newVerbatim,
    gates: nextGates,
    captureLog: [...existingLog, { at: timestamp, actor, mode: 'append', gatesAdded: gates.length }]
  };
  const nextRequests = [...data.requests];
  nextRequests[index] = nextEntry;
  return finalizeLedger(data, nextRequests);
}

function finalizeLedger(data, nextRequests) {
  return {
    ...data,
    revision: Number.isInteger(data.revision) ? data.revision + 1 : 1,
    updatedAt: todayString(),
    requests: nextRequests
  };
}

// --- locking (reuses the generic, already-tested PID-staleness lock from
// src/lib/agent-digest/lock.js -- that module takes a plain file path and has
// no digest-specific coupling, so applying it to the ledger's own lock file
// is reuse, not borrowing something purpose-built for a different job) ------

function acquireLedgerLock(ledgerFile) {
  try {
    return acquireLock(`${ledgerFile}.lock`);
  } catch (error) {
    if (error && error.code === 'AGENT_DIGEST_ALREADY_RUNNING') {
      const wrapped = new OwnerCaptureError(
        'OWNER_CAPTURE_LEDGER_LOCKED',
        `Another owner-capture write is already in progress (PID ${error.holderPid}). Refusing to race a read-modify-write on the ledger.`
      );
      wrapped.holderPid = error.holderPid;
      throw wrapped;
    }
    throw error;
  }
}

// --- atomic write --------------------------------------------------------

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function renameWithRetry(temporary, target) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(temporary, target);
      return;
    } catch (error) {
      if (!TRANSIENT_WRITE_CODES.has(error?.code) || attempt + 1 >= WRITE_ATTEMPTS) throw error;
      waitSync(25 * (attempt + 1));
    }
  }
}

/**
 * Read-modify-write, made safe the same way every other durable writer in
 * this repo does it: write to a sibling temp file, fsync, read the bytes
 * back off disk and JSON-validate them, THEN snapshot the previous content
 * to `<ledger>.bak`, and only then rename the temp file over the original.
 * Nothing about the original file changes until the very last step, and
 * that step is a single filesystem rename.
 */
function atomicWriteLedgerWithBackup(ledgerFile, previousRaw, nextData) {
  const serialized = JSON.stringify(nextData, null, 2);
  const reparsed = JSON.parse(serialized); // validate before this process writes a single byte
  if (!Array.isArray(reparsed.requests)) {
    throw new OwnerCaptureError('OWNER_CAPTURE_WRITE_VALIDATION_FAILED', 'Serialized ledger failed its own shape check before write.');
  }

  const temporary = `${ledgerFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    // JSON-validate the bytes actually on disk, not just the in-memory string.
    const onDisk = JSON.parse(fs.readFileSync(temporary, 'utf8'));
    if (!Array.isArray(onDisk.requests)) {
      throw new OwnerCaptureError('OWNER_CAPTURE_WRITE_VALIDATION_FAILED', 'Temp file failed shape validation after write.');
    }

    // Only now, with a validated replacement staged, save the pre-write backup.
    fs.writeFileSync(`${ledgerFile}.bak`, previousRaw, 'utf8');
    renameWithRetry(temporary, ledgerFile);
  } finally {
    if (descriptor !== undefined && descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

// --- main ------------------------------------------------------------------

async function main(argv, { notify = notifyCapturedDirective } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return null;
  }

  const ledgerFile = args.ledger ? path.resolve(args.ledger) : DEFAULT_LEDGER_FILE;
  if (!fs.existsSync(ledgerFile)) {
    throw new OwnerCaptureError('OWNER_CAPTURE_LEDGER_NOT_FOUND', `No ledger file at ${ledgerFile}. Refusing to create a new one implicitly.`);
  }

  const source = typeof args.source === 'string' ? args.source : undefined;
  const actor = assertCaptureActor(nonEmptyTrimmed(
    args.actor, 'OWNER_CAPTURE_ACTOR_REQUIRED', '--actor is required (owner ingress, ledger-custody role, or a relay citing --source).', MAX_ACTOR_LENGTH
  ), source);

  const hasNewId = args['new-id'] !== undefined;
  const hasRequestId = args['request-id'] !== undefined;
  if (hasNewId === hasRequestId) {
    throw usageError('Exactly one of --new-id or --request-id is required.');
  }

  let text = args.text;
  if (text === undefined) text = await readStdinIfPiped();
  if (text === null || text === undefined) {
    throw new OwnerCaptureError('OWNER_CAPTURE_TEXT_REQUIRED', 'Provide --text "..." or pipe the owner\'s words on stdin.');
  }
  text = nonEmptyTrimmed(text, 'OWNER_CAPTURE_TEXT_REQUIRED', 'The captured text must not be empty.', MAX_TEXT_LENGTH);

  const gates = args.gate.map((gate, gateIndex) => ({
    instruction: nonEmptyTrimmed(gate.instruction, 'OWNER_CAPTURE_GATE_EMPTY', `--gate #${gateIndex + 1} must not be empty.`, MAX_GATE_LENGTH),
    hedged: gate.hedged
  }));

  let interpretation = null;
  let status = DEFAULT_STATUS;
  let scope = 'global';
  let threadId = null;
  let targetId;

  if (hasNewId) {
    targetId = args['new-id'];
    if (!ID_PATTERN.test(targetId)) throw usageError(`--new-id "${targetId}" does not match the ledger id format (e.g. R56).`);
    interpretation = nonEmptyTrimmed(
      args.interpretation, 'OWNER_CAPTURE_INTERPRETATION_REQUIRED', '--interpretation is required with --new-id.', MAX_INTERPRETATION_LENGTH
    );
    if (args.status !== undefined) {
      status = args.status.trim();
      if (!ALLOWED_CAPTURE_STATUSES.has(status)) {
        throw usageError(`--status "${args.status}" must be one of: ${[...ALLOWED_CAPTURE_STATUSES].join(', ')}.`);
      }
    }
    if (args.scope !== undefined) {
      scope = args.scope.trim();
      if (!CAPTURE_SCOPES.has(scope)) {
        throw usageError(`--scope "${args.scope}" must be one of: ${[...CAPTURE_SCOPES].join(', ')}.`);
      }
    }
    if (scope !== 'global') {
      threadId = args['thread-id'];
      if (typeof threadId !== 'string' || !THREAD_ID_PATTERN.test(threadId)) {
        throw usageError(`--scope ${scope} requires --thread-id matching the stable identifier format.`);
      }
    } else if (args['thread-id'] !== undefined) {
      throw usageError('--thread-id is valid only with --scope session, tree, or thread.');
    }
  } else {
    targetId = args['request-id'];
    if (!ID_PATTERN.test(targetId)) throw usageError(`--request-id "${targetId}" does not match the ledger id format (e.g. R44).`);
    if (args.interpretation !== undefined) {
      throw usageError('--interpretation is only valid with --new-id; an existing entry\'s interpretation is not changed by this tool.');
    }
    if (args.status !== undefined) {
      throw usageError('--status is only valid with --new-id; this tool never changes the status of an existing entry.');
    }
    if (args.scope !== undefined || args['thread-id'] !== undefined) {
      throw usageError('--scope and --thread-id are only valid with --new-id; this tool never changes an existing entry\'s scope.');
    }
    // Provenance is set once, when the entry is created. An append adds the
    // owner's later words to an existing request; it must not be able to
    // RECLASSIFY that request, or an append would become a way to promote an
    // agent-authored entry to owner authority after the fact.
    if (args.provenance !== undefined || args.proposal !== undefined) {
      throw usageError('--provenance and --proposal are only valid with --new-id; this tool never '
        + 'reclassifies the provenance of an existing entry.');
    }
  }

  // WRITE-AHEAD. The owner's words become durable HERE, before the ledger is
  // opened, locked, parsed or written. Everything after this point may fail,
  // crash, or be killed without the words ceasing to exist -- which is the whole
  // difference between "this capture is unfinished, replay it" and the measured
  // behaviour this replaces, where a contended ledger meant the directive was
  // simply gone and nothing said so.
  //
  // Spooling here rather than in the failure path is deliberate: a catch block
  // cannot run if the process is killed between taking the lock and completing
  // the rename, and that window is exactly when the ledger is busiest.
  //
  // Placed AFTER actor validation, also deliberately: an actor refused as an
  // agent-authored brief must not acquire a durable slot in the owner's queue by
  // way of the safety net.
  const spooled = spool.writeAhead(ledgerFile, {
    mode: hasNewId ? 'new' : 'append',
    id: targetId,
    text,
    interpretation,
    actor,
    source,
    gates,
    status,
    scope,
    threadId,
    provenanceClass: args.provenance,
    proposal: args.proposal
  });

  // A capture that did not reach the ledger must SAY SO -- loudly, in the
  // failure, carrying the path to the words. The behaviour being replaced was a
  // lane deciding for itself that it would "write the text somewhere else and
  // move on", and an agent only makes that call when the tool leaves it guessing
  // where the words went. This tells it exactly where they are and forbids the
  // improvisation by name.
  const preserved = (error) => {
    spool.annotatePending(spooled, { code: error && error.code, message: error && error.message });
    const wrapped = new OwnerCaptureError(
      error && error.code ? error.code : 'OWNER_CAPTURE_UNEXPECTED_ERROR',
      `${error && error.message ? error.message : String(error)}\n`
        + `  THE OWNER'S WORDS ARE SAFE ON DISK: ${spooled.file}\n`
        + '  THEY ARE NOT IN THE LEDGER. This capture is UNFINISHED, not finished-elsewhere.\n'
        + `  Replay it with: node tools/owner-capture-reconcile.js --ledger "${ledgerFile}"\n`
        + '  Do NOT re-type these words into some other file and move on. That is the exact\n'
        + '  step that lost a directive on 2026-08-11.'
    );
    wrapped.spoolFile = spooled.file;
    wrapped.cause = error;
    return wrapped;
  };

  let lock;
  try {
    lock = acquireLedgerLock(ledgerFile);
  } catch (error) {
    throw preserved(error);
  }
  try {
    const raw = fs.readFileSync(ledgerFile, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new OwnerCaptureError('OWNER_CAPTURE_LEDGER_INVALID_JSON', `${ledgerFile} is not valid JSON; refusing to modify it.`);
    }
    validateLedgerShape(data, ledgerFile);

    const timestamp = new Date().toISOString();
    const nextData = hasNewId
      ? applyNewEntry(data, { id: targetId, text, interpretation, status, scope, threadId, gates, actor, source, timestamp, provenanceClass: args.provenance, proposal: args.proposal })
      : applyAppend(data, { id: targetId, text, gates, actor, source, timestamp });

    atomicWriteLedgerWithBackup(ledgerFile, raw, nextData);

    // The words are in the ledger, so this record is no longer outstanding. It
    // is MOVED to reconciled/ and kept, never deleted: the spool doubles as a
    // verbatim history that does not depend on the big JSON file staying intact.
    const reconciled = spool.markReconciled(spooled, { revision: nextData.revision });

    const entry = nextData.requests.find(candidate => candidate.id === targetId);
    const summary = {
      ok: true,
      spoolRecord: reconciled.file,
      mode: hasNewId ? 'new' : 'append',
      id: entry.id,
      ledgerFile,
      backupFile: `${ledgerFile}.bak`,
      revision: nextData.revision,
      verbatimLength: entry.verbatim.length,
      gatesTotal: Array.isArray(entry.gates) ? entry.gates.length : 0,
      gatesAdded: gates.length
    };
    try {
      summary.notification = await notify({
        id: entry.id,
        revision: nextData.revision,
        mode: summary.mode,
        scope: hasNewId ? entry.scope : (entry.scope || 'unclassified')
      });
    } catch (error) {
      // notify() may have reached some or all destinations before throwing.
      // Do not turn that unmeasured partial outcome into authoritative zeroes:
      // only the notification subsystem can report its delivery counts.
      summary.notification = {
        status: 'uncertain',
        code: error && typeof error.code === 'string' ? error.code : 'OWNER_DIRECTIVE_NOTIFICATION_FAILED'
      };
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } catch (error) {
    throw preserved(error);
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error && error.code ? error.code : 'OWNER_CAPTURE_UNEXPECTED_ERROR';
    process.stderr.write(`${code}: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseArgs,
  validateLedgerShape,
  applyNewEntry,
  applyAppend,
  finalizeLedger,
  toGateObject,
  normalizeCaptureScope,
  hasRuntimeGateWord,
  assertRuntimeGateEvidence,
  assertGatesAppendOnly,
  assertCaptureActor,
  atomicWriteLedgerWithBackup,
  acquireLedgerLock,
  todayString,
  printUsage,
  OwnerCaptureError,
  ID_PATTERN,
  THREAD_ID_PATTERN,
  CAPTURE_SCOPES,
  ALLOWED_CAPTURE_STATUSES,
  DEFAULT_LEDGER_FILE
};
