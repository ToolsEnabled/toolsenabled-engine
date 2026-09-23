const fs = require('fs').promises;
const path = require('path');
const { selectOpenGates } = require('../src/lib/owner-ledger-open-gates');
const {
  observeLiveRequestOwnership,
  projectRequestStatuses,
  selectGatesMetStatusNotDone
} = require('../src/lib/owner-request-status-projection');
const { projectRequestLifecycle } = require('../src/lib/owner-request-lifecycle-projection');
const {
  validateScopeProposal
} = require('../src/lib/owner-request-scope-proposal');
const {
  DEFAULTS: SCOPE_PROPOSAL_DEFAULTS,
  verifySourceSnapshots
} = require('./owner-scope-proposal');
const scopeStore = require('../src/lib/owner-request-scope-store');
const presence = require('../src/lib/agent-presence');
const {
  describeProvenance,
  provenanceClassOf,
  PROVENANCE_CLASS_MEANING
} = require('../src/lib/owner-request-provenance');
// owner-request-store.js now also carries T (task), A (ask) and P (purchase)
// records in the same ledger file. Every reader below (gates, lifecycle
// projections, BUILD-QUEUE.md, gen-metrics) was written for R rows only, so
// readRequestFile filters to the R family here rather than at each caller.
const { isRequestId } = require('../src/lib/request-id');
// The digest's shape contract. The renderer emits its headings from here and
// refuses to publish a digest that does not satisfy it; the freshness gate
// checks the published file against the same list. See the header of
// src/lib/open-gates-digest-contract.js for why a second copy would be a bug.
const digestContract = require('../src/lib/open-gates-digest-contract');
// The retirement half. `partitionRetired` is the seam ledger-archive.js
// publishes for exactly this reader; see readColdStorage below.
const ledgerArchive = require('./ledger-archive');
// reports/ and state/ are written at runtime; installed they are not the
// program directory. Same resolution ledger-archive.js uses, so both halves
// address the same overlay file.
const { statePath } = require('../src/lib/runtime-state-root');

// The owner ledger is private runtime state, not payload source.  The explicit
// path is also the isolation seam used by the repository runner; without it a
// test (and an installed copy) silently fell back to the checkout's reports/
// directory and either skipped entirely or read the wrong account's ledger.
const configuredLedgerPath = typeof process.env.TOOLSENABLED_OWNER_LEDGER_FILE === 'string'
  ? process.env.TOOLSENABLED_OWNER_LEDGER_FILE.trim()
  : '';
const LEDGER_PATH = configuredLedgerPath
  ? path.resolve(configuredLedgerPath)
  : statePath('reports', 'OWNER-REQUEST-LEDGER.json');
const ARCHIVE_PATH = statePath('reports', 'OWNER-REQUEST-LEDGER-ARCHIVE.json');
/* WHERE RETIREMENTS ACTUALLY LIVE (2026-08-12).
 *
 * tools/ledger-archive.js stopped writing the two-file archive and started
 * appending to a hash-chained overlay. This reader was not moved with it, so
 * the two halves pointed at different files: the writer appended to
 * state/owner-request-disposition-events.jsonl, this file read
 * reports/OWNER-REQUEST-LEDGER-ARCHIVE.json, and partitionRetired -- the
 * function whose whole job is telling this file which ids to withhold -- was
 * exported and imported by nothing. MEASURED consequence: a retirement made
 * today still rendered as an OPEN GATE in the digest every agent reads at boot.
 *
 * ARCHIVE_PATH stays wired underneath it, read-only. It holds 0 requests and 0
 * retirements in this tree, but a record that once meant "retired" must not
 * come back to life because the storage moved, so its retirements are folded
 * into the same projection as legacy `cold` states. */
const OVERLAY_PATH = statePath('state', 'owner-request-disposition-events.jsonl');
const OPEN_GATES_REPORT_PATH = statePath('reports', 'OPEN-GATES.md');
const SCOPE_PROPOSAL_PATH = statePath('reports', 'OWNER-REQUEST-SCOPE-PROPOSAL.json');
const NO_VERBATIM_RECORDED = 'controller interpretation — no verbatim recorded';

class LedgerQueryError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'LedgerQueryError';
    this.exitCode = code;
  }
}

// The preview carries its own watermark rather than the applied store's: it is
// showing what the proposal WOULD do, so the corpus that matters is the one the
// proposal was built from.
async function loadScopeProposalPreview(options = {}) {
  const resolved = {
    proposal: path.resolve(options.proposal || SCOPE_PROPOSAL_PATH),
    ledger: path.resolve(options.ledger || LEDGER_PATH),
    scopeStore: path.resolve(options.scopeStore || SCOPE_PROPOSAL_DEFAULTS.scopeStore)
  };
  let proposal;
  try {
    proposal = JSON.parse(await fs.readFile(resolved.proposal, 'utf8'));
    const validated = validateScopeProposal(proposal);
    verifySourceSnapshots(proposal, resolved);
    return Object.freeze({
      rules: validated.rules,
      reviewedLedgerRevision: proposal.sourceLedger.revision,
      reviewedRequestIds: proposal.entries.map(entry => entry.sourceRequestId)
    });
  } catch (error) {
    if (error instanceof LedgerQueryError) throw error;
    throw new LedgerQueryError(
      `Proposal preview refused by source fence${error?.code ? ` (${error.code})` : ''}: ${error?.message || String(error)}`,
      11
    );
  }
}

async function loadScopeProposalPreviewRules(options = {}) {
  return (await loadScopeProposalPreview(options)).rules;
}

async function readRequestFile(file, label) {
  try {
    const data = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.requests)) {
      throw new LedgerQueryError(`Malformed ${label} shape: expected an object with a requests array.`, 3);
    }
    // R family only: a T/A/P row in the same file must never reach a gate,
    // lifecycle projection, BUILD-QUEUE.md or gen-metrics through this reader.
    return parsed.requests.filter(request => isRequestId(request && request.id, { family: 'R' }));
  } catch (error) {
    if (error instanceof LedgerQueryError) throw error;
    if (error.code === 'ENOENT') throw new LedgerQueryError(`${label} file not found at: ${file}`, 2);
    if (error instanceof SyntaxError) throw new LedgerQueryError(`Malformed JSON in ${label} file: ${file}`, 3);
    throw new LedgerQueryError(`Failed to read ${label} file: ${error.message}`, 4);
  }
}

// The digest below is generated once and then read by every agent
// at SESSION-BOOT; without a stamp, a stale file and a fresh one are visually
// identical. This reads only the two scalar fields needed for the stamp, not
// the (potentially large) requests array, so it stays cheap to call from a
// preflight path that must not add real latency.
async function readLedgerMeta(ledgerPath = LEDGER_PATH) {
  const data = await fs.readFile(ledgerPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new LedgerQueryError(`Malformed JSON in ledger file: ${ledgerPath}`, 3);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LedgerQueryError(`Malformed ledger shape: expected an object at: ${ledgerPath}`, 3);
  }
  return {
    revision: typeof parsed.revision === 'number' ? parsed.revision : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
  };
}

async function readLedger(ledgerPath = LEDGER_PATH, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['includeArchive', 'archivePath'].includes(key))) {
    throw new LedgerQueryError('Ledger read options are invalid.', 6);
  }
  const active = await readRequestFile(ledgerPath, 'ledger');
  if (options.includeArchive !== true) return active;
  const archived = await readRequestFile(options.archivePath || ARCHIVE_PATH, 'archive ledger');
  const byId = new Map(active.map(request => [request.id, request]));
  for (const request of archived) {
    const existing = byId.get(request.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(request)) {
      throw new LedgerQueryError(`Request id "${request.id}" differs between active and archive ledgers.`, 3);
    }
    if (!existing) byId.set(request.id, request);
  }
  return [...byId.values()];
}

async function readArchiveState(archivePath = ARCHIVE_PATH) {
  try {
    const data = await fs.readFile(archivePath, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.requests)
        || (parsed.retirements !== undefined && !Array.isArray(parsed.retirements))) {
      throw new LedgerQueryError('Malformed archive ledger shape: expected requests and optional retirements arrays.', 3);
    }
    return Object.freeze({
      requests: parsed.requests,
      retirements: parsed.retirements || Object.freeze([])
    });
  } catch (error) {
    if (error instanceof LedgerQueryError) throw error;
    if (error.code === 'ENOENT') return Object.freeze({ requests: Object.freeze([]), retirements: Object.freeze([]) });
    if (error instanceof SyntaxError) throw new LedgerQueryError(`Malformed JSON in archive ledger file: ${archivePath}`, 3);
    throw new LedgerQueryError(`Failed to read archive ledger file: ${error.message}`, 4);
  }
}

/* THE COLD-STORAGE SEAM. This is the half that was missing.
 *
 * tools/ledger-archive.js appends dispositions; this turns those appends into
 * the three things the open-gates projection needs:
 *
 *   active          the ledger MINUS anything currently cold
 *   retiredRequests the entries withheld, still whole, still readable
 *   retirements     one provenance record per withheld target
 *
 * Only `cold` is withheld -- COOLING stays in the active lists on purpose,
 * because being seen is what earns the retirement (ledger-archive.js
 * WITHHELD_DISPOSITIONS). Nothing here is deleted: a withheld entry moves from
 * "## Active gates" to "## Retired gates -- preserved, not active" in the same
 * digest, and `ledger-query.js get <id>` still answers in full, because a list
 * may hide an entry and a lookup never may.
 *
 * `legacyReasonCodes: true` maps the overlay's five sharp reason codes down to
 * the three src/lib/owner-request-lifecycle-projection.js accepts, keeping the
 * sharp code at the front of the detail string so the downgrade cannot lie
 * about which evidence class retired the entry.
 */
async function readColdStorage(requests, options = {}) {
  const archivePath = options.archivePath || ARCHIVE_PATH;
  const overlayPath = options.overlayPath || OVERLAY_PATH;
  const archive = await readArchiveState(archivePath);
  for (const retirement of archive.retirements) {
    // The legacy fold in projectOverlay() maps this code by table lookup. An
    // unknown one would silently become `undefined` and then default to
    // `settled` downstream, i.e. a record whose reason nobody can read would
    // start claiming the work was done.
    if (!LEGACY_ARCHIVE_REASON_CODES.includes(retirement?.reason?.code)) {
      throw new LedgerQueryError(
        `Legacy archive retirement for ${retirement?.requestId || '(no id)'} carries unreadable reason code `
          + `"${retirement?.reason?.code}"; refusing to guess what retired it.`,
        3
      );
    }
  }
  const overlay = ledgerArchive.readOverlay(overlayPath);
  const byTarget = ledgerArchive.projectOverlay(overlay.events, archive.retirements);
  // The union is deliberate: entries the OLD delete path removed from the
  // ledger live only in the archive, and they must still be projected as
  // retired rather than vanishing from every surface at once.
  const partition = ledgerArchive.partitionRetired(
    [...requests, ...archive.requests],
    byTarget,
    { legacyReasonCodes: true }
  );
  return Object.freeze({
    active: partition.active,
    retiredRequests: partition.retiredRequests,
    retirements: partition.retirements,
    overlayPath,
    overlayExists: overlay.exists,
    eventCount: overlay.events.length
  });
}

// The three codes src/lib/owner-request-lifecycle-projection.js accepts, and
// the exact set tools/ledger-archive.js maps its sharper vocabulary into.
const LEGACY_ARCHIVE_REASON_CODES = Object.freeze(['completed', 'fully-superseded', 'owner-confirmed']);

function processGet(id, ledger, projectionOptions = {}) {
  const request = ledger.find(item => item.id === id);
  if (!request) throw new LedgerQueryError(`Request with id "${id}" not found.`, 5);
  const gates = Array.isArray(request.gates) ? request.gates : [];
  const projection = projectRequestStatuses([request], projectionOptions)[0];
  const authorizations = projectAuthorizations(ledger);
  return {
    id: request.id,
    status: request.status,
    derivedLabel: projection.derivedLabel,
    ownerText: renderOwnerRequestText(request),
    // `ownerText` alone cannot say whether those words are the OWNER'S words --
    // any writer can put a string in `verbatim`. This is the field that says
    // whether the record can show he said it. Callers rendering an entry as his
    // requirement must check it, or call assertCitableAsOwnerRequirement.
    ownerAuthority: ownerAuthorityOf(request),
    gateCount: gates.length,
    unmetGateCount: gates.filter(g => !g.met).length,
    // A LOOKUP ALWAYS TELLS THE WHOLE TRUTH ABOUT AN ID.
    // Lists can hide an entry -- that is what retirement and cooling are for.
    // A lookup never can, and an authorization is the part a list is most
    // likely to have dropped, so it travels with the entry itself. Both
    // directions are here: what this entry authorizes, and what authorizes it.
    authorizations: Object.freeze({
      declaredHere: Object.freeze(authorizations.all.filter(record => record.requestId === id)),
      revokedByThis: Object.freeze(authorizations.all
        .filter(record => record.revokedBy.some(ref => ref.startsWith(`${id}#`))))
    })
  };
}

// P9's owner-speech boundary. `request` is controller interpretation, not a
// fallback transcript. Consumers that need owner-facing text must call this
// renderer; a missing verbatim always gets the same explicit label.
function renderOwnerRequestText(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('OWNER_REQUEST_RENDER_INVALID_REQUEST');
  }
  return typeof request.verbatim === 'string' ? request.verbatim : NO_VERBATIM_RECORDED;
}

/* EVIDENCE IS CONTENT, NOT A KEY THAT EXISTS.
 *
 * This was `gate.evidence !== undefined && gate.evidence !== null`, which answers
 * "is the field present" and calls that evidence. Gates in this ledger are written
 * with `evidence: ''` when there is nothing to show, so the field is essentially
 * always present: MEASURED against reports/OWNER-REQUEST-LEDGER.json, hasEvidence
 * was `true` for 1099 of 1099 gates. Not one gate could ever report false, so the
 * field carried no information while reading like an assurance. Under this rule
 * 143 of 1099 report true.
 *
 * The predicate is deliberately identical to src/lib/intent-fidelity.js:314, which
 * already had it right. Two spellings of one fact is the shape that produced this
 * bug; if you change one, change both. A whitespace-only string is not evidence --
 * that is the case a presence check cannot see at all. */
function gateHasEvidence(gate) {
  return typeof gate.evidence === 'string' && gate.evidence.trim().length > 0;
}

function processGates(id, ledger) {
  const request = ledger.find(item => item.id === id);
  if (!request) throw new LedgerQueryError(`Request with id "${id}" not found.`, 5);
  const gates = (Array.isArray(request.gates) ? request.gates : []).map((gate, index) => ({
    index,
    met: !!gate.met,
    hasEvidence: gateHasEvidence(gate)
  }));
  return { id: request.id, gates };
}

function processOpen(ledger, projectionOptions = {}) {
  const openStatuses = new Set(['open', 'in-progress', 'partial', 'blocked-external']);
  const labels = new Map(projectRequestStatuses(ledger, projectionOptions).map(item => [item.id, item.derivedLabel]));
  return ledger.filter(request => openStatuses.has(request.status)).map(request => {
    const gates = Array.isArray(request.gates) ? request.gates : [];
    return { id: request.id, status: request.status, derivedLabel: labels.get(request.id), unmetGateCount: gates.filter(g => !g.met).length };
  });
}

function processReconciliation(ledger) {
  return selectGatesMetStatusNotDone(ledger);
}

// Read production presence once per status query. A missing registry is a
// valid empty observation (no live owners); malformed or unreadable state is
// ownership-unknown and therefore cannot produce a stalled label.
function productionOwnershipObservation(options = {}) {
  const presenceApi = options.presenceApi || presence;
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  try {
    const observation = observeLiveRequestOwnership(presenceApi.readRegistry(), {
      nowMs,
      ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive })
    });
    return Object.freeze({ nowMs, ...observation });
  } catch (error) {
    return Object.freeze({
      nowMs,
      ownershipObservedAtMs: null,
      liveOwnerRequestIds: Object.freeze([]),
      coverage: 'unavailable',
      errorCode: typeof error?.code === 'string' ? error.code : 'AGENT_PRESENCE_UNAVAILABLE'
    });
  }
}

/* ============================================================================
 * WHAT THE OWNER ALREADY PERMITTED — the authorization projection.
 *
 * THE INCIDENT, 2026-08-12. Two lanes stopped work on a change the owner had
 * already approved. The approval existed; nothing recorded it anywhere either
 * lane would look. Every surface this ledger publishes answers one question --
 * "what was ASKED FOR" -- and a permission is not a request. It never becomes
 * an unmet gate, so it never appears in OPEN-GATES.md; it is not queued work,
 * so it never appears in a build phase; and when the task it authorized is
 * finished, marking that task done erases the last trace of the permission
 * from every list. An agent doing the honest thing -- checking whether it is
 * allowed -- finds silence, and silence reads as "no".
 *
 * THE FIELD. A ledger gate may declare `clauseKind`:
 *
 *   work         (the default) — something to do. Unchanged behaviour.
 *   grant        — the owner PERMITTED something. Not a task.
 *   prohibition  — the owner FORBADE something. Not a task.
 *
 * A grant or prohibition clause may carry an `authorization` object:
 *
 *   { permits | forbids: "<what, in plain words>",   // what is allowed/refused
 *     scope:   "<who or where it applies>",           // optional, free text
 *     revokes: ["R123", "R124#2"] }                   // optional, see below
 *
 * FOUR RULES, and each one is why the incident happened:
 *
 * 1. AN AUTHORIZATION IS READ FROM THE WHOLE LEDGER, never from the open-gate
 *    set. `met` says whether a task was done; it has nothing to say about
 *    whether a permission is in force, so this projection ignores it.
 * 2. LIFECYCLE CANNOT RETIRE IT. Completed, superseded, cooled, archived --
 *    none of them withdraw a permission, because none of them are the owner
 *    changing his mind. Only an explicit `revokes` naming this id does that.
 * 3. AN UNDECLARED CLAUSE IS WORK, and the count of undeclared clauses is
 *    published. Nothing here guesses a grant out of prose: inferring "he
 *    probably allowed it" from wording is the same defect as inferring his
 *    requirements from an agent's default, one step more dangerous. An empty
 *    grants list on a corpus that never declared any is reported as UNDECLARED,
 *    not as "he permitted nothing".
 * 4. IT CARRIES THE SAME AUTHORITY LABEL AS EVERY OTHER CLAUSE. A grant on an
 *    entry whose provenance is not owner-stated is shown, and shown as a claim
 *    rather than as his permission.
 * ==========================================================================*/
const CLAUSE_KINDS = Object.freeze(['work', 'grant', 'prohibition']);
const AUTHORIZATION_CLAUSE_KINDS = Object.freeze(['grant', 'prohibition']);
const REVOCATION_TARGET_RE = /^R\d{1,4}(?:\.\d{1,2})?(?:#\d{1,3})?$/;

/**
 * The declared kind of one clause. Absent means `work` -- the whole existing
 * corpus predates the field and every clause in it is a task. A PRESENT but
 * unrecognized value is refused rather than defaulted: it is a record making a
 * claim about itself that nothing in this file validates, and quietly reading
 * it as `work` would hide a permission, which is the exact failure being fixed.
 */
function clauseKindOf(gate) {
  if (!gate || typeof gate !== 'object') throw new TypeError('OWNER_CLAUSE_KIND_INVALID');
  if (gate.clauseKind === undefined || gate.clauseKind === null) return 'work';
  if (!CLAUSE_KINDS.includes(gate.clauseKind)) throw new TypeError('OWNER_CLAUSE_KIND_INVALID');
  return gate.clauseKind;
}

function authorizationSubjectOf(gate, kind) {
  const record = gate.authorization;
  if (record === undefined || record === null) return null;
  if (typeof record !== 'object' || Array.isArray(record)) throw new TypeError('OWNER_AUTHORIZATION_INVALID');
  const subject = kind === 'grant' ? record.permits : record.forbids;
  if (subject !== undefined && typeof subject !== 'string') throw new TypeError('OWNER_AUTHORIZATION_INVALID');
  if (record.scope !== undefined && typeof record.scope !== 'string') throw new TypeError('OWNER_AUTHORIZATION_INVALID');
  if (record.revokes !== undefined
      && (!Array.isArray(record.revokes)
        || record.revokes.some(target => typeof target !== 'string' || !REVOCATION_TARGET_RE.test(target)))) {
    throw new TypeError('OWNER_AUTHORIZATION_INVALID');
  }
  return {
    subject: typeof subject === 'string' && subject.trim().length > 0 ? subject : null,
    scope: typeof record.scope === 'string' && record.scope.trim().length > 0 ? record.scope : null,
    revokes: Object.freeze([...(record.revokes || [])])
  };
}

function authorizationRef(requestId, gateIndex) {
  return `${requestId}#${gateIndex + 1}`;
}

/**
 * Every authorization the record holds, in ledger order, whatever the lifecycle
 * state of the entry carrying it. Pure: reads the ledger array it is given and
 * writes nothing.
 */
function projectAuthorizations(ledger) {
  if (!Array.isArray(ledger)) throw new TypeError('OWNER_AUTHORIZATION_INVALID_LEDGER');
  const records = [];
  const revocations = new Map();
  let declaredWorkClauses = 0;
  let undeclaredClauses = 0;
  for (const request of ledger) {
    const gates = Array.isArray(request.gates) ? request.gates : [];
    gates.forEach((gate, gateIndex) => {
      const kind = clauseKindOf(gate);
      if (kind === 'work') {
        if (gate.clauseKind === undefined || gate.clauseKind === null) undeclaredClauses += 1;
        else declaredWorkClauses += 1;
        return;
      }
      const detail = authorizationSubjectOf(gate, kind);
      const record = {
        ref: authorizationRef(request.id, gateIndex),
        requestId: request.id,
        gateIndex,
        kind,
        // The clause's own stored text, unaltered. `subject` is the short
        // machine-readable summary when the capture recorded one; the
        // instruction is always carried so no reader depends on the summary.
        instruction: typeof gate.instruction === 'string' ? gate.instruction : '',
        subject: detail ? detail.subject : null,
        scope: detail ? detail.scope : null,
        revokes: detail ? detail.revokes : Object.freeze([]),
        requestStatus: request.status,
        ownerAuthority: ownerAuthorityOf(request),
        revokedBy: Object.freeze([])
      };
      records.push(record);
      for (const target of record.revokes) {
        const list = revocations.get(target) || [];
        list.push(record.ref);
        revocations.set(target, list);
      }
    });
  }
  // A revocation may name a whole request (`R123`) or one clause (`R123#2`).
  for (const record of records) {
    const byClause = revocations.get(record.ref) || [];
    const byRequest = revocations.get(record.requestId) || [];
    const revokedBy = [...new Set([...byClause, ...byRequest])].filter(ref => ref !== record.ref);
    record.revokedBy = Object.freeze(revokedBy);
  }
  const frozen = records.map(record => Object.freeze(record));
  const inForce = frozen.filter(record => record.revokedBy.length === 0);
  // Revocations that name nothing in this corpus are reported, never dropped: a
  // withdrawal aimed at an id that is not here means either the id is wrong or
  // the record it withdrew is missing, and both need a human.
  const knownTargets = new Set(frozen.flatMap(record => [record.ref, record.requestId]));
  const danglingRevocations = [...revocations.entries()]
    .filter(([target]) => !knownTargets.has(target))
    .map(([target, byRefs]) => Object.freeze({ target, declaredBy: Object.freeze([...byRefs]) }));
  return Object.freeze({
    schemaVersion: 1,
    all: Object.freeze(frozen),
    inForce: Object.freeze(inForce),
    grants: Object.freeze(inForce.filter(record => record.kind === 'grant')),
    prohibitions: Object.freeze(inForce.filter(record => record.kind === 'prohibition')),
    revoked: Object.freeze(frozen.filter(record => record.revokedBy.length > 0)),
    danglingRevocations: Object.freeze(danglingRevocations),
    counts: Object.freeze({
      grants: inForce.filter(record => record.kind === 'grant').length,
      prohibitions: inForce.filter(record => record.kind === 'prohibition').length,
      revoked: frozen.filter(record => record.revokedBy.length > 0).length,
      // How much of the corpus has never said which kind of clause it is. A
      // reader who sees `grants: 0` needs this number to tell "he has permitted
      // nothing" from "nothing has ever been classified".
      undeclaredClauses,
      declaredWorkClauses,
      danglingRevocations: danglingRevocations.length
    })
  });
}

/** One line per authorization, in the form every surface renders it. */
function renderAuthorizationLine(record) {
  const kindLabel = record.kind === 'grant' ? 'AUTHORIZED' : 'FORBIDDEN';
  const authority = record.ownerAuthority && record.ownerAuthority.citableAsOwnerRequirement
    ? 'owner-stated'
    : 'NOT SHOWN TO BE THE OWNER\'S — provenance not recorded';
  const subject = record.subject || record.instruction || '(no text recorded)';
  const scope = record.scope ? ` — scope: ${record.scope}` : '';
  return `- ${record.ref} ${kindLabel}: ${subject}${scope} [${authority}]`;
}

function renderAuthorizationSection(authorizations) {
  const lines = [`${digestContract.heading('authorizations')} — what is already permitted or forbidden`, ''];
  lines.push(
    'These are NOT tasks and they are NOT filtered by lifecycle. A permission is not',
    'withdrawn by the work it authorized being finished, superseded or retired; only an',
    'entry that explicitly revokes it withdraws it. Read this section before stopping',
    'work for lack of authority.',
    ''
  );
  if (authorizations.counts.grants === 0 && authorizations.counts.prohibitions === 0) {
    lines.push(
      authorizations.counts.undeclaredClauses > 0
        ? `None declared. ${authorizations.counts.undeclaredClauses} clause`
          + `${authorizations.counts.undeclaredClauses === 1 ? '' : 's'} in this ledger carry no `
          + '`clauseKind`, so this is "nothing has been classified as a permission", NOT '
          + '"the owner has permitted nothing".'
        : 'None on file. Every clause in this ledger is declared work.',
      ''
    );
  }
  for (const record of authorizations.inForce) lines.push(renderAuthorizationLine(record));
  if (authorizations.inForce.length > 0) lines.push('');
  if (authorizations.revoked.length > 0) {
    lines.push('Withdrawn — kept visible so a reader can see it existed:', '');
    for (const record of authorizations.revoked) {
      lines.push(`${renderAuthorizationLine(record)} — REVOKED by ${record.revokedBy.join(', ')}`);
    }
    lines.push('');
  }
  for (const item of authorizations.danglingRevocations) {
    lines.push(`- WARNING: ${item.declaredBy.join(', ')} revokes \`${item.target}\`, which this ledger does not contain.`);
  }
  if (authorizations.danglingRevocations.length > 0) lines.push('');
  return lines;
}

function gateIndexFromRuleKey(ruleKey) {
  if (typeof ruleKey !== 'string') return null;
  const match = /^(?:request|legacy)\.[a-z0-9.]+\.gate\.(\d{3})$/.exec(ruleKey);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function ruleKeyTargetsOwnRequest(ruleKey, request) {
  if (typeof ruleKey !== 'string' || !request || typeof request.id !== 'string') return false;
  const requestId = request.id.toLowerCase();
  const prefixes = [`request.${requestId}.gate.`, `legacy.${requestId}.gate.`];
  const disposition = request.versioningDisposition;
  if (disposition && disposition.kind === 'legacy-duplicate-version-merge'
      && typeof disposition.rootId === 'string') {
    prefixes.push(`legacy.${disposition.rootId.toLowerCase()}.gate.`);
  }
  return prefixes.some(prefix => ruleKey.startsWith(prefix));
}

/* THE READ-PATH AUTHORITY BOUNDARY (2026-08-11).
 *
 * 65c3735 gave every ledger entry a `provenance` field, but nothing that READS
 * the ledger consulted it. So reports/OPEN-GATES.md -- the digest every agent
 * reads at SESSION-BOOT -- presented its gates uniformly under the heading
 * "Open owner-request gates" when only 9 of 532 entries can show that the owner
 * said anything at all. A reader of that file could not tell his words from
 * another agent's default, which is the mechanism behind his 2026-08-11
 * question: "Why are agent rules stille being pushed as mine".
 *
 * Every gate now carries the authority of the request it came from. The
 * instruction text is never hidden or summarized -- hiding it would lose real
 * requirements and break preservesEveryRequest. It is LABELLED, so citing one as
 * his is a choice made with the answer already on screen.
 *
 * Authority is read from the REQUEST, not the gate: a gate is a sub-instruction
 * of its request and cannot have more authority than the request it decomposes.
 */
function ownerAuthorityOf(request) {
  const described = describeProvenance(request);
  return Object.freeze({
    class: described.class,
    label: described.label,
    citableAsOwnerRequirement: described.citableAsOwnerRequirement
  });
}

function withOwnerAuthority(gates, request) {
  const authority = ownerAuthorityOf(request);
  return gates.map(gate => Object.freeze({ ...gate, ownerAuthority: authority }));
}

function processOpenGates(ledger, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['scopeRules', 'retiredRequests', 'retirements', 'nowMs',
        'classifiedMode', 'reviewedLedgerRevision', 'reviewedRequestIds'].includes(key))
      || (options.classifiedMode !== undefined && typeof options.classifiedMode !== 'boolean')
      || (options.reviewedLedgerRevision !== undefined
        && (!Number.isSafeInteger(options.reviewedLedgerRevision) || options.reviewedLedgerRevision < 0))
      || (options.reviewedRequestIds !== undefined && !Array.isArray(options.reviewedRequestIds))
      || (options.reviewedLedgerRevision === undefined) !== (options.reviewedRequestIds === undefined)) {
    throw new TypeError('OPEN_GATES_PROJECTION_INVALID_OPTIONS');
  }
  const scopeRules = options.scopeRules || [];
  const classifiedMode = options.classifiedMode === true;
  /* WHAT WAS ACTUALLY REVIEWED (see the watermark note in
   * src/lib/owner-request-scope-store.js).
   *
   * Absent watermark => absent knowledge, and this projection will not invent
   * it. Every unmatched gate keeps failing closed exactly as before, because
   * the alternative -- assuming nothing was reviewed and waving all of them
   * through -- would silently reclassify the genuinely-held-back gates as
   * active and destroy the very distinction being drawn here. */
  const reviewedRequestIds = options.reviewedRequestIds
    ? new Set(options.reviewedRequestIds)
    : null;
  const reviewedLedgerRevision = options.reviewedRequestIds
    ? options.reviewedLedgerRevision
    : null;
  const lifecycle = projectRequestLifecycle({
    activeRequests: ledger,
    rules: scopeRules,
    retiredRequests: options.retiredRequests || [],
    retirements: options.retirements || [],
    nowMs: options.nowMs === undefined ? Date.now() : options.nowMs
  });
  const active = [];
  const activePendingClassification = [];
  const unresolved = [];
  const supersededClauses = [];
  const superseded = [];
  const retiredClauses = [];
  const retired = [];
  const unmappedRuleRetirements = [];
  const unmappedRuleSupersessions = [];
  const requestById = new Map(ledger.map(request => [request.id, request]));
  const activeRuleIds = new Set(lifecycle.ruleResolution.activeRuleIds);
  const activeGateIndicesByRequest = new Map();
  for (const rule of scopeRules) {
    const request = requestById.get(rule.sourceRequestId);
    const gateIndex = gateIndexFromRuleKey(rule.ruleKey);
    if (!activeRuleIds.has(rule.ruleId) || gateIndex === null
        || !ruleKeyTargetsOwnRequest(rule.ruleKey, request)) continue;
    const values = activeGateIndicesByRequest.get(request.id) || new Set();
    values.add(gateIndex);
    activeGateIndicesByRequest.set(request.id, values);
  }

  const classifyVisibleRequest = (item, wholeRequestSuperseded) => {
    const openGates = withOwnerAuthority(selectOpenGates([item.request]), item.request);
    const retirementByGate = new Map();
    for (const retirement of item.ruleRetirements || []) {
      const gateIndex = gateIndexFromRuleKey(retirement.ruleKey);
      if (gateIndex === null) {
        unmappedRuleRetirements.push(Object.freeze({ requestId: item.requestId, retirement }));
      } else {
        retirementByGate.set(gateIndex, retirement);
      }
    }
    const supersessionByGate = new Map();
    for (const ruleSupersession of item.ruleSupersessions || []) {
      const gateIndex = gateIndexFromRuleKey(ruleSupersession.ruleKey);
      if (gateIndex === null) {
        unmappedRuleSupersessions.push(Object.freeze({ requestId: item.requestId, ruleSupersession }));
      } else {
        supersessionByGate.set(gateIndex, ruleSupersession);
      }
    }
    for (const gate of openGates) {
      const retirement = retirementByGate.get(gate.gateIndex);
      if (retirement) {
        retiredClauses.push(Object.freeze({ ...gate, state: 'retired-clause', ruleKey: retirement.ruleKey, retirement }));
        continue;
      }
      if (wholeRequestSuperseded) {
        superseded.push(Object.freeze({
          ...gate,
          state: 'superseded',
          supersededBy: item.disposition.supersededBy,
          supersessionReasons: item.disposition.reasons
        }));
        continue;
      }
      const ruleSupersession = supersessionByGate.get(gate.gateIndex);
      if (ruleSupersession) {
        supersededClauses.push(Object.freeze({
          ...gate,
          state: 'superseded-clause',
          ruleKey: ruleSupersession.ruleKey,
          supersededBy: Object.freeze([...new Set(ruleSupersession.winners.map(winner => winner.sourceRequestId))]),
          supersessionReasons: Object.freeze([...new Set(ruleSupersession.winners.map(winner => winner.reason))])
        }));
        continue;
      }
      if (classifiedMode && !activeGateIndicesByRequest.get(item.requestId)?.has(gate.gateIndex)) {
        /* FAIL OPEN FOR REQUESTS NOBODY HAS READ YET.
         *
         * A gate with no active reviewed rule is held back only when the
         * reviewers actually had it in front of them. If the request was minted
         * after the recorded review watermark, "no rule" records review timing,
         * not their judgement, and burying it under "preserved, not active" is
         * how a one-off classification run turned into an expiry date on the
         * owner's voice. It stays ACTIVE and says out loud that it is waiting
         * for classification. */
        if (reviewedRequestIds && !reviewedRequestIds.has(item.requestId)) {
          activePendingClassification.push(Object.freeze({
            ...gate,
            state: 'active-pending-classification',
            reason: 'request-minted-after-reviewed-corpus',
            reviewedLedgerRevision
          }));
          continue;
        }
        unresolved.push(Object.freeze({
          ...gate,
          state: 'unresolved-unclassified',
          reason: 'no-active-reviewed-rule'
        }));
        continue;
      }
      active.push(Object.freeze({ ...gate, state: 'active' }));
    }
  };
  lifecycle.active.forEach(item => classifyVisibleRequest(item, false));
  lifecycle.superseded.forEach(item => classifyVisibleRequest(item, true));
  for (const item of lifecycle.retired) {
    for (const gate of withOwnerAuthority(selectOpenGates([item.request]), item.request)) {
      retired.push(Object.freeze({ ...gate, state: 'retired', retirement: item.retirement }));
    }
  }
  // Pending-classification gates ARE active gates: they are published in the
  // active set, counted in the active total, and included in the authority
  // summary. The separate count exists so the share of the active set that is
  // still awaiting review is a number somebody can read, not a silent blend.
  const activeAll = [...active, ...activePendingClassification];
  const expectedOpenGateCount = selectOpenGates([
    ...ledger,
    ...(options.retiredRequests || [])
  ]).length;
  const projectedOpenGateCount = activeAll.length + unresolved.length + supersededClauses.length
    + superseded.length + retiredClauses.length + retired.length;
  if (projectedOpenGateCount !== expectedOpenGateCount) {
    throw new TypeError('OPEN_GATES_PROJECTION_INCOMPLETE');
  }
  return Object.freeze({
    schemaVersion: 1,
    classifiedMode,
    reviewedLedgerRevision,
    active: Object.freeze(activeAll),
    unresolved: Object.freeze(unresolved),
    supersededClauses: Object.freeze(supersededClauses),
    superseded: Object.freeze(superseded),
    retiredClauses: Object.freeze(retiredClauses),
    retired: Object.freeze(retired),
    unmappedRuleRetirements: Object.freeze(unmappedRuleRetirements),
    unmappedRuleSupersessions: Object.freeze(unmappedRuleSupersessions),
    counts: Object.freeze({
      active: activeAll.length,
      activePendingClassification: activePendingClassification.length,
      unresolved: unresolved.length,
      supersededClauses: supersededClauses.length,
      superseded: superseded.length,
      retiredClauses: retiredClauses.length,
      retired: retired.length,
      unmappedRuleRetirements: unmappedRuleRetirements.length,
      unmappedRuleSupersessions: unmappedRuleSupersessions.length
    }),
    openGateCoverage: Object.freeze({ expected: expectedOpenGateCount, projected: projectedOpenGateCount }),
    // How much of what this digest presents can actually show the owner's
    // authority. Computed over the ACTIVE gates, because those are the ones the
    // header counts as "Open gates" and the ones agents act on.
    ownerAuthority: summarizeGateAuthority(activeAll),
    // Read from the whole corpus, not from the buckets above: an authorization
    // is not an open gate and must survive every lifecycle transition this
    // projection performs. See the authorization note near clauseKindOf.
    //
    // `ledger` here is the ACTIVE set -- cold entries have already been
    // withheld from it by readColdStorage -- so the retired ones are unioned
    // back in explicitly. Without this, retiring an entry would withdraw every
    // permission it declared, which is rule 2 ("lifecycle cannot retire it")
    // broken by the very mechanism that was built to hide finished work.
    authorizations: projectAuthorizations([...ledger, ...(options.retiredRequests || [])]),
    lifecycle
  });
}

/* Count active gates by the authority of the request they decompose.
 *
 * Deliberately computed from the gate records rather than asserted, for the same
 * reason preservesEveryRequest had to stop being a hardcoded `true`: a number
 * that cannot come out wrong carries no information. */
function summarizeGateAuthority(gates) {
  const counts = Object.create(null);
  let citable = 0;
  for (const gate of gates) {
    const klass = gate.ownerAuthority ? gate.ownerAuthority.class : 'unclassified';
    counts[klass] = (counts[klass] || 0) + 1;
    if (gate.ownerAuthority && gate.ownerAuthority.citableAsOwnerRequirement) citable += 1;
  }
  return Object.freeze({
    total: gates.length,
    citableAsOwnerRequirement: citable,
    notCitable: gates.length - citable,
    counts: Object.freeze({ ...counts })
  });
}

// The stamp line's exact format is a small contract with
// agent-preflight.js's freshness check (STAMP_LINE_RE there) -- keep the two
// in sync if this format ever changes.
function stampLedgerRevision(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const { revision, updatedAt } = meta;
  if (typeof revision !== 'number' || typeof updatedAt !== 'string') return null;
  return `Ledger revision: ${revision} (updated ${updatedAt})`;
}

/* Render one gate's stored text, always preceded by whose decision it was.
 *
 * The Authority line comes BEFORE the instruction on purpose. A reader who
 * stops after the quote must already have seen whether the owner said it; a
 * label printed underneath is a label that gets skimmed past. The instruction
 * itself is still emitted byte-for-byte -- this boundary changes attribution,
 * never the owner's words.
 *
 * Note the existing `Provenance:` lines in the superseded sections mean
 * SUPERSESSION reasons, a different thing entirely. This one is deliberately
 * called Authority so the two cannot be confused. */
function pushGateInstruction(lines, gate) {
  const authority = gate.ownerAuthority;
  lines.push(`Authority: ${authority ? authority.label : 'UNSOURCED — provenance not recorded; not the owner\'s requirement'}`, '');
  lines.push('**Ledger gate instruction (stored text)**', '', gate.instruction, '');
}

function renderOpenGatesDigest(projection, meta = null) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)
      || !Array.isArray(projection.active) || !Array.isArray(projection.superseded)
      || !Array.isArray(projection.unresolved)
      || !Array.isArray(projection.supersededClauses) || !Array.isArray(projection.retiredClauses)
      || !Array.isArray(projection.retired) || !Array.isArray(projection.unmappedRuleRetirements)
      || !Array.isArray(projection.unmappedRuleSupersessions) || !projection.counts) {
    throw new TypeError('OPEN_GATES_DIGEST_INVALID_PROJECTION');
  }
  // The two attribution halves are REQUIRED, not optional decoration. They were
  // rendered behind `if (projection.x)` guards, which means a projection that
  // silently stopped carrying them produced a digest missing whole sections and
  // no code path complained -- the measured 2026-08-12 failure, where the
  // published digest carried 0 occurrences of "Authorizations on file" while
  // every gate on the file stayed green.
  if (!projection.ownerAuthority || !projection.authorizations) {
    throw new TypeError('OPEN_GATES_DIGEST_INCOMPLETE_PROJECTION');
  }
  const stamp = stampLedgerRevision(meta);
  const lines = [
    '<!-- GENERATED FILE. Request text comes only from the active/archive ledgers; lifecycle is derived from reviewed scope rules, P3 version metadata, and the retirement records in state/owner-request-disposition-events.jsonl. Do not edit this digest; regenerate it with `node tools/ledger-query.js open --gates --write`. -->',
    digestContract.heading('title'),
    '',
    `Open gates: ${projection.counts.active}`,
    `Open gates awaiting classification (not covered by the recorded review watermark): ${projection.counts.activePendingClassification || 0}`,
    `Unresolved/unclassified gates preserved: ${projection.counts.unresolved}`,
    `Superseded clause gates preserved: ${projection.counts.supersededClauses}`,
    `Superseded gates preserved: ${projection.counts.superseded}`,
    `Retired clause gates preserved: ${projection.counts.retiredClauses}`,
    `Retired gates preserved: ${projection.counts.retired}`,
    `Authorizations in force: ${projection.authorizations.counts.grants} grant`
      + `${projection.authorizations.counts.grants === 1 ? '' : 's'}, `
      + `${projection.authorizations.counts.prohibitions} prohibition`
      + `${projection.authorizations.counts.prohibitions === 1 ? '' : 's'} `
      + `(${projection.authorizations.counts.undeclaredClauses} clause`
      + `${projection.authorizations.counts.undeclaredClauses === 1 ? '' : 's'} undeclared)`,
    stamp || 'Ledger revision: unknown (generated without a readable ledger revision/updatedAt stamp)',
    ''
  ];
  // The attribution header. Everything below is a real, actionable gate; this
  // says which of them the record can show the OWNER asked for. Without it the
  // title "Open owner-request gates" silently claims all of them are his.
  const authority = projection.ownerAuthority;
  lines.push(
    digestContract.heading('authority'),
    '',
    `Of the ${authority.total} active gates below, ${authority.citableAsOwnerRequirement} can show the owner's `
      + `authority and ${authority.notCitable} cannot.`,
    '',
    'Every gate carries an `Authority:` line. A gate that is not OWNER STATED or',
    'OWNER RATIFIED may still be worth doing, but it MUST NOT be described back to',
    'him as his own requirement, and it must not be cited as the constraint that',
    'descopes something he did ask for. Reclassify by establishing where the words',
    'came from -- see `node tools/owner-descope.js` and src/lib/owner-request-provenance.js.',
    ''
  );
  for (const klass of Object.keys(authority.counts).sort()) {
    lines.push(`- ${klass}: ${authority.counts[klass]} — ${PROVENANCE_CLASS_MEANING[klass] || 'unknown class'}`);
  }
  lines.push('');
  // ABOVE the gate list on purpose. An agent that stops reading after the first
  // section it recognizes must already have passed the answer to "am I allowed
  // to do this", because the two lanes that stopped work on 2026-08-12 read
  // exactly this file and found only tasks in it.
  lines.push(...renderAuthorizationSection(projection.authorizations));
  lines.push(digestContract.heading('active'), '');
  if (projection.active.length === 0) {
    lines.push('No active canonical gate currently has `met: false`.', '');
  }
  for (const gate of projection.active) {
    lines.push(`### ${gate.requestId} — request status: ${gate.requestStatus} — gate ${gate.gateIndex + 1}`, '');
    // Say why it is here without demoting it. This gate is as actionable as any
    // other in this section; what it lacks is a reviewed scope rule, because it
    // was recorded after the last classification run rather than declined by it.
    if (gate.state === 'active-pending-classification') {
      lines.push(`Classification: PENDING — not covered by the recorded review watermark`
        + `${typeof gate.reviewedLedgerRevision === 'number' ? ` (ledger revision ${gate.reviewedLedgerRevision})` : ''}`
        + '. It is active until a review says otherwise, not held back by one.', '');
    }
    pushGateInstruction(lines, gate);
  }
  lines.push(digestContract.heading('unresolved'), '');
  if (projection.unresolved.length === 0) lines.push('None.', '');
  for (const gate of projection.unresolved) {
    lines.push(`### ${gate.requestId} — unresolved classification — gate ${gate.gateIndex + 1}`, '');
    lines.push(`Reason: ${gate.reason}`, '');
    pushGateInstruction(lines, gate);
  }
  lines.push(digestContract.heading('superseded-clauses'), '');
  if (projection.supersededClauses.length === 0) lines.push('None.', '');
  for (const gate of projection.supersededClauses) {
    lines.push(`### ${gate.requestId} — clause ${gate.ruleKey} superseded by ${gate.supersededBy.join(', ')} — gate ${gate.gateIndex + 1}`, '');
    lines.push(`Provenance: ${gate.supersessionReasons.join(', ')}`, '');
    pushGateInstruction(lines, gate);
  }
  lines.push(digestContract.heading('superseded'), '');
  if (projection.superseded.length === 0) lines.push('None.', '');
  for (const gate of projection.superseded) {
    lines.push(`### ${gate.requestId} — superseded by ${gate.supersededBy.join(', ')} — gate ${gate.gateIndex + 1}`, '');
    lines.push(`Provenance: ${gate.supersessionReasons.join(', ')}`, '');
    pushGateInstruction(lines, gate);
  }
  lines.push(digestContract.heading('retired-clauses'), '');
  if (projection.retiredClauses.length === 0) lines.push('None.', '');
  for (const gate of projection.retiredClauses) {
    lines.push(`### ${gate.requestId} — clause ${gate.ruleKey} retired — gate ${gate.gateIndex + 1}`, '');
    lines.push(`Retirement: ${gate.retirement.reason.code} — ${gate.retirement.reason.detail}`, '');
    pushGateInstruction(lines, gate);
  }
  lines.push(digestContract.heading('retired'), '');
  if (projection.retired.length === 0) lines.push('None.', '');
  for (const gate of projection.retired) {
    lines.push(`### ${gate.requestId} — retired — gate ${gate.gateIndex + 1}`, '');
    lines.push(`Retirement: ${gate.retirement.reason.code} — ${gate.retirement.reason.detail}`, '');
    pushGateInstruction(lines, gate);
  }
  lines.push(digestContract.heading('unmapped'), '');
  if (projection.unmappedRuleRetirements.length === 0 && projection.unmappedRuleSupersessions.length === 0) {
    lines.push('None.', '');
  }
  for (const item of projection.unmappedRuleRetirements) {
    lines.push(`- ${item.requestId}: retired ruleKey \`${item.retirement.ruleKey}\` does not identify a gate; no gate was hidden.`);
  }
  for (const item of projection.unmappedRuleSupersessions) {
    lines.push(`- ${item.requestId}: superseded ruleKey \`${item.ruleSupersession.ruleKey}\` does not identify a gate; no gate was hidden.`);
  }
  if (projection.unmappedRuleRetirements.length > 0 || projection.unmappedRuleSupersessions.length > 0) lines.push('');
  return lines.join('\n');
}

/* PUBLISH-TIME SELF-CHECK.
 *
 * The reader-side gate (src/lib/open-gates-freshness.js) catches a digest that
 * is already published and already wrong -- after every agent that booted in
 * between has read it. This catches the same defect one step earlier, on the
 * only path that can create it, and it costs one regex pass over a file we
 * just built in memory. Both sides read the same contract, so neither can
 * quietly disagree with the other about which sections exist. */
async function writeOpenGatesDigest(projection, reportPath = OPEN_GATES_REPORT_PATH, meta = null) {
  const markdown = renderOpenGatesDigest(projection, meta);
  const shape = digestContract.checkDigestSections(markdown);
  if (!shape.complete) {
    throw new LedgerQueryError(
      `Refusing to publish an incomplete digest: ${digestContract.describeDigestShortfall(shape)}`,
      12
    );
  }
  await fs.writeFile(reportPath, markdown, 'utf8');
  return reportPath;
}

/* THE ONE ASSEMBLY OF THE DIGEST'S INPUTS.
 *
 * Extracted out of main() so a test can drive the SHIPPED wiring against
 * fixture paths instead of re-deriving it. A test that rebuilds this call by
 * hand proves its own copy works and says nothing about the CLI -- which is
 * exactly how the retirement halves came to be wired to different files with a
 * green suite either side of the gap.
 *
 * @param {object} [options]
 * @param {Array}  [options.ledger]        pre-read active requests; read from ledgerPath when absent
 * @param {string} [options.ledgerPath]
 * @param {string} [options.archivePath]   legacy two-file archive (read-only)
 * @param {string} [options.overlayPath]   state/owner-request-disposition-events.jsonl
 * @param {Array}  [options.scopeRules]    overrides the production scope store
 * @param {boolean}[options.proposalPreview]
 */
async function buildOpenGatesProjection(options = {}) {
  const ledgerPath = options.ledgerPath || LEDGER_PATH;
  const ledger = options.ledger || await readLedger(ledgerPath);
  const cold = await readColdStorage(ledger, {
    archivePath: options.archivePath,
    overlayPath: options.overlayPath
  });
  let rules;
  let watermark = {};
  if (options.scopeRules !== undefined) {
    rules = options.scopeRules;
  } else {
    const source = options.proposalPreview
      ? await loadScopeProposalPreview()
      : scopeStore.readScopeStore();
    rules = source.rules;
    // Only pass the watermark when one was actually recorded. A store written
    // before this field existed has no corpus to compare against, and guessing
    // one would be worse than the fail-closed behaviour it already has.
    if (source.reviewedRequestIds !== undefined) {
      watermark = {
        reviewedLedgerRevision: source.reviewedLedgerRevision,
        reviewedRequestIds: source.reviewedRequestIds
      };
    }
  }
  return processOpenGates(cold.active, {
    scopeRules: rules,
    classifiedMode: Boolean(options.proposalPreview) || rules.length > 0,
    ...watermark,
    // Both halves now come from the same read of the same overlay. Passing
    // retiredRequests from one file and retirements from another is what let a
    // retirement made today still render as an open gate.
    retiredRequests: cold.retiredRequests,
    retirements: cold.retirements
  });
}

async function main(argv = process.argv) {
  const args = argv.slice(2);
  const unknownFlag = args.find(arg => arg.startsWith('--')
    && !['--gates', '--write', '--include-archive', '--proposal-preview'].includes(arg));
  if (unknownFlag) throw new LedgerQueryError(`CLI flags are not permitted unless documented; unsupported flag "${unknownFlag}".`, 6);
  const includeArchive = args.includes('--include-archive');
  const proposalPreview = args.includes('--proposal-preview');
  const positional = args.filter(arg => !['--include-archive', '--proposal-preview'].includes(arg));
  const [command, id] = positional;
  if (!command) throw new LedgerQueryError('A command is required (get, gates, open, reconcile, grants).', 7);
  if (command !== 'open' && command !== 'reconcile' && positional.some(arg => arg.startsWith('--'))) {
    throw new LedgerQueryError('Only --include-archive is permitted for this subcommand.', 6);
  }

  let processor;
  let writeDigest = false;
  let usesStatusProjection = false;
  let statusProjectionOptions = {};
  switch (command) {
    case 'get':
      if (!id || positional.length !== 2) throw new LedgerQueryError('The "get" command requires one id and optionally --include-archive.', 8);
      processor = ledger => processGet(id, ledger, statusProjectionOptions);
      usesStatusProjection = true;
      break;
    case 'gates':
      if (!id || positional.length !== 2) throw new LedgerQueryError('The "gates" command requires one id and optionally --include-archive.', 8);
      processor = ledger => processGates(id, ledger);
      break;
    case 'open':
      if (positional.length === 1) {
        processor = ledger => processOpen(ledger, statusProjectionOptions);
        usesStatusProjection = true;
        break;
      }
      if (id !== '--gates' || positional.length > 3 || (positional.length === 3 && positional[2] !== '--write')) {
        throw new LedgerQueryError('The "open" command accepts only `open`, `open --gates`, or `open --gates --write`, plus optional --include-archive.', 6);
      }
      processor = processOpenGates;
      writeDigest = positional[2] === '--write';
      break;
    case 'reconcile':
      if (positional.length !== 1) throw new LedgerQueryError('The "reconcile" command accepts no positional arguments.', 8);
      processor = processReconciliation;
      break;
    // The one command whose whole job is answering "am I allowed to". It exits
    // 0 on an empty record and says so in words, because "no grants recorded"
    // and "the tool failed" must never look the same to a caller.
    case 'grants':
      if (positional.length !== 1) throw new LedgerQueryError('The "grants" command accepts no positional arguments.', 8);
      processor = projectAuthorizations;
      break;
    default:
      throw new LedgerQueryError(`Unknown command "${command}". Available commands: get, gates, open, reconcile, grants.`, 9);
  }
  if (proposalPreview && processor !== processOpenGates) {
    throw new LedgerQueryError('The --proposal-preview flag is permitted only with `open --gates`.', 6);
  }
  if (proposalPreview && writeDigest) {
    throw new LedgerQueryError('The --proposal-preview path is read-only; inspect its stdout and apply a reviewed proposal before writing OPEN-GATES.', 6);
  }

  const activeLedger = await readLedger(LEDGER_PATH);
  if (usesStatusProjection) {
    const ownership = productionOwnershipObservation();
    statusProjectionOptions = ownership.coverage === 'complete'
      ? {
          nowMs: ownership.nowMs,
          ownershipObservedAtMs: ownership.ownershipObservedAtMs,
          liveOwnerRequestIds: ownership.liveOwnerRequestIds
        }
      : {};
  }
  let result;
  if (processor === processOpenGates) {
    result = await buildOpenGatesProjection({ ledger: activeLedger, proposalPreview });
  } else {
    const ledger = includeArchive
      ? await readLedger(LEDGER_PATH, { includeArchive: true, archivePath: ARCHIVE_PATH })
      : activeLedger;
    result = processor(ledger);
  }
  if (writeDigest) {
    const meta = await readLedgerMeta(LEDGER_PATH);
    await writeOpenGatesDigest(result, OPEN_GATES_REPORT_PATH, meta);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    if (error instanceof LedgerQueryError) {
      console.error(`Error: ${error.message}`);
      process.exit(error.exitCode);
    }
    console.error(`An unexpected error occurred: ${error.message}`);
    process.exit(10);
  });
}

module.exports = {
  readLedger,
  readLedgerMeta,
  readArchiveState,
  readColdStorage,
  buildOpenGatesProjection,
  processGet,
  processGates,
  processOpen,
  processReconciliation,
  productionOwnershipObservation,
  processOpenGates,
  CLAUSE_KINDS,
  AUTHORIZATION_CLAUSE_KINDS,
  clauseKindOf,
  projectAuthorizations,
  renderAuthorizationLine,
  renderAuthorizationSection,
  loadScopeProposalPreview,
  loadScopeProposalPreviewRules,
  renderOwnerRequestText,
  ownerAuthorityOf,
  summarizeGateAuthority,
  NO_VERBATIM_RECORDED,
  renderOpenGatesDigest,
  writeOpenGatesDigest,
  stampLedgerRevision,
  LEDGER_PATH,
  ARCHIVE_PATH,
  OVERLAY_PATH,
  OPEN_GATES_REPORT_PATH,
  SCOPE_PROPOSAL_PATH,
  LedgerQueryError
};
