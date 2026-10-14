#!/usr/bin/env node
'use strict';

// THE BUILD QUEUE AS A PROJECTION OF WHAT THE OWNER ACTUALLY ASKED FOR.
//
// MEASURED ON THIS TREE 2026-08-12, before this tool existed:
//
//   node tools/build-queue-provenance.js   ->  exit 6
//   "606 of 669 unfinished ledger entries are named by no queue phase."
//
// CLAUDE.md and STANDING-ORDERS RECORD 3 (owner request R107) both say the root
// BUILD-QUEUE.md and the package slices it declares are the single list of
// queued work. So roughly 90% of what the owner asked for was structurally
// unbuildable: captured in R, reachable by no builder loop, and invisible to
// every "what is left" question anyone asks the queue.
//
// WHY A GENERATOR AND NOT 606 MORE PHASES OF MARKDOWN. The defect is not that
// somebody forgot to type 606 phases. It is that the queue was a SECOND,
// HAND-MAINTAINED list of the same facts as the ledger, and two hand-maintained
// lists of the same facts diverge -- that divergence IS the bug. Hand-writing
// the backlog into a 473 KB Markdown file would make the same drift larger and
// slower to notice. This makes one of the two lists derived, so divergence
// becomes a failing test instead of an archaeology project.
//
// WHAT IS PROJECTED, AND FROM WHERE. Exactly the ACTIVE gates, read through
// tools/ledger-query.js's processOpenGates -- the same code path that produces
// reports/OPEN-GATES.md, which every agent reads at SESSION-BOOT. "Active" is
// not this tool's opinion: it is the ledger's own lifecycle projection, after
// reviewed scope rules, supersession, clause retirement and archive retirement
// have each had their say. When the scope classification is re-run and a
// different set of gates becomes active, re-running this tool is the whole of
// the update. Nothing here is a snapshot and nothing here is hardcoded.
//
// WHAT IS DELIBERATELY NOT PROJECTED. An unfinished ledger entry with no ACTIVE
// gate gets no phase. A phase whose acceptance criteria would be empty is a
// wish, not queued work, and inventing criteria to fill it would be exactly the
// hand-authored guessing this tool exists to end. Those entries stay visible as
// orphans under `node tools/build-queue-provenance.js`, which is the honest
// place for them: named, counted, and not pretending to be buildable.
//
// PHASE IDS: WHY THEY ARE ALLOCATED APPEND-ONLY AND NOT DERIVED FROM THE R-ID.
// The obvious design -- phase id = f(R-id), e.g. R1548 -> Q9154800 -- was built
// first and then MEASURED against the rest of the corpus, and it breaks the
// queue: src/lib/build-queue-writer.js's parseStrictQueue refuses any
// "## Q<digit>" heading outside `Q\d{1,3}`, so an 8-digit id makes
// appendQueuePhase and transitionQueuePhase throw QUEUE_PHASE_MALFORMED for the
// WHOLE corpus -- root and every slice. Verified 2026-08-12: baseline 81 phases
// parse; with derived ids, QUEUE_PHASE_MALFORMED on the first generated
// heading. So generated ids live in the same Q1-Q999 space as every other
// phase, and they are allocated the same way: through build-queue-writer's own
// nextPhaseId, which already scans live headings, Completed receipts and slice
// markers. One allocator, seeing everything (STANDING-ORDERS SYNC rule 8: two
// allocators that cannot see each other collide forever).
//
// An id, once given to an R-id, is that R-id's forever. It is recorded in this
// file's own phase markers, and when a request stops having an active gate its
// id is retired into "## Retired generated phase ids" as a receipt rather than
// released -- the exact construct build-queue-writer already reads to keep a
// closed id reserved. Re-numbering on every run would recreate the Q99 defect
// named in SYNC rule 7 at 198x scale: an id that silently comes to mean a
// different owner request is how a Q-number acquires authority nobody granted
// it, which is the same mechanism that produced the phantom R1228.
//
// CAPACITY IS FINITE AND THIS TOOL SAYS SO. Q1-Q999 is the whole space and
// nextPhaseId throws at 999. Today: 198 phases, allocated above the corpus high
// water mark. If every currently unresolved gate were classified active the
// projection would be about 373 phases. That fits, with headroom, but it is not
// unlimited, and this tool fails loudly rather than wrapping or reusing.
//
// A GENERATED TITLE MUST NEVER BECOME A CITATION. src/lib/build-queue-provenance.js
// reads R-ids from citation position only: the heading and the Authority lines.
// Gate text is the ledger's stored text and is emitted UNALTERED in the phase
// body, but a gate whose text mentions an R-number or an R-numbered decision
// document gets a structural heading instead of a text one. No ledger prose can
// be promoted into a citation by this tool. (Measured today: 7 of 653 active
// gates mention an R-number, and one of those -- R10.1 -- does not exist.)
//
// CLAIMING HAPPENS IN THE LEDGER, NOT IN THIS FILE. A generated phase's Status
// is projected from its ledger entry's status, so `transitionQueuePhase
// --claim`'s in-place edit would be erased by the next run and is reported as
// drift. That is the correct direction for a projection: to say "someone is on
// this", move the ledger entry to in-progress.
//
// NO TIMESTAMP, ON PURPOSE. The slice is a function of the ledger, the archive,
// the scope store and its own prior id assignments -- nothing else. A generated
// timestamp or revision stamp would manufacture drift on every run where
// nothing about the queued work actually changed, and a check that cries wolf
// gets switched off.
//
// BOUNDARIES. This tool never writes reports/OWNER-REQUEST-LEDGER.json
// (tools/owner-capture.js owns it). It writes queue/owner.ledger.md and this
// package's receipt in queue/manifest.json. It touches BUILD-QUEUE.md only
// under --declare, and then only the package index block, through that file's
// own renderQueueIndex + compare-and-swap installer, with a byte fence proving
// nothing outside the index changed.
//
// Exit codes: 0 clean * 2 usage * 3 the on-disk slice has drifted * 4 a source
// could not be read or projected * 5 the slice is not declared by
// BUILD-QUEUE.md's package index or by queue/manifest.json.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ledgerQuery = require('./ledger-query');
const { assertManifest, replaceRootCas } = require('./build-queue-migrate');
const scopeStore = require('../src/lib/owner-request-scope-store');
const { queueSlicePath } = require('../src/lib/build-queue-package-contract');
const {
  INDEX_HEADING,
  parseQueueIndex,
  removeQueueIndex,
  renderQueueIndex
} = require('../src/lib/build-queue-corpus');
const { nextPhaseId } = require('../src/lib/build-queue-writer');

const ROOT = path.join(__dirname, '..');
const PACKAGE_ID = 'owner.ledger';
const SLICE_RELATIVE_PATH = queueSlicePath(PACKAGE_ID);
const SLICE_FILE = path.join(ROOT, ...SLICE_RELATIVE_PATH.split('/'));
const MANIFEST_FILE = path.join(ROOT, 'queue', 'manifest.json');
const QUEUE_ROOT_FILE = path.join(ROOT, 'BUILD-QUEUE.md');
const GENERATOR = 'tools/queue-from-ledger.js';

const REQUEST_ID_RE = /^R(\d{1,4})(?:\.(\d{1,2}))?$/;
const PHASE_MARKER_RE = /^<!-- queue-from-ledger:v1 phase=(Q[1-9]\d{0,2}) request=(R\d{1,4}(?:\.\d{1,2})?) activeGates=(\d+) -->$/;
const RETIRED_RECEIPT_RE = /^- \*\*(Q[1-9]\d{0,2}) — (R\d{1,4}(?:\.\d{1,2})?):\*\* /;
const RETIRED_HEADING = '## Retired generated phase ids';
const MAX_PHASE_NUMBER = 999;

// Citation shapes, copied from src/lib/build-queue-provenance.js. Kept as
// literals because their job on this side is the opposite one: not "find a
// citation" but "refuse to manufacture one".
const RID_TOKEN = /\bR\d{2,}(?:\.\d+)?\b/;
const DECISION_DOC_REF = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-R\d{2,}(?:\.\d+)?\.md\b/;
const TITLE_LIMIT = 96;

// Ledger status -> queue status. An unmapped status becomes BLOCKED with the
// raw value stated: the safe direction is "a builder does not pick this up on a
// guess", never "assume it is open".
const QUEUE_STATUS = Object.freeze({
  open: 'OPEN',
  'in-progress': 'IN-PROGRESS',
  partial: 'PARTIAL',
  'blocked-external': 'BLOCKED — blocked-external in the ledger: it needs owner action or a provider-side change'
});

class QueueFromLedgerError extends Error {
  constructor(message, exitCode = 4) {
    super(message);
    this.name = 'QueueFromLedgerError';
    this.exitCode = exitCode;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function phaseNumber(phaseId) {
  return Number.parseInt(String(phaseId).slice(1), 10);
}

function requestSortKey(requestId) {
  const match = REQUEST_ID_RE.exec(String(requestId));
  if (!match) return [Number.MAX_SAFE_INTEGER, 0];
  return [Number(match[1]), match[2] === undefined ? 0 : Number(match[2])];
}

function byRequestId(left, right) {
  const a = requestSortKey(left);
  const b = requestSortKey(right);
  return (a[0] - b[0]) || (a[1] - b[1]) || String(left).localeCompare(String(right));
}

function queueStatusFor(ledgerStatus) {
  const mapped = QUEUE_STATUS[String(ledgerStatus)];
  if (mapped) return mapped;
  return `BLOCKED — this generator has no queue-status mapping for ledger status \`${String(ledgerStatus)}\`; nothing is dispatched on a guess`;
}

/**
 * The heading text. Uses the first active gate's own words when they carry no
 * citation shape, and a purely structural title otherwise. See the header note:
 * a heading is a citation position, so ledger prose may never land there
 * unfiltered.
 */
function titleFor(requestId, gates) {
  const structural = `${requestId} — ${gates.length} active gate${gates.length === 1 ? '' : 's'} in the owner request ledger`;
  const first = String(gates[0] && gates[0].instruction ? gates[0].instruction : '').replace(/\s+/g, ' ').trim();
  if (!first || RID_TOKEN.test(first) || DECISION_DOC_REF.test(first)) return structural;
  if (first.length <= TITLE_LIMIT) return `${requestId}: ${first}`;
  const cut = first.lastIndexOf(' ', TITLE_LIMIT);
  const head = (cut > 0 ? first.slice(0, cut) : first.slice(0, TITLE_LIMIT)).trim();
  return `${requestId}: ${head}…`;
}

function readIfPresent(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new QueueFromLedgerError(`Could not read ${file}: ${error.message}`, 4);
  }
}

/**
 * Recover this slice's existing id assignments from its own text. Both the live
 * phase markers and the retired receipts are read, because a retired id is
 * still spoken for. A line that opens like either construct but fails its exact
 * grammar throws rather than being skipped -- silently under-reading the
 * reservations is how an id gets handed out twice.
 */
function readAssignments(sliceMarkdown) {
  const assigned = new Map();
  const retired = new Map();
  const usedNumbers = new Set();
  if (typeof sliceMarkdown !== 'string' || !sliceMarkdown) return { assigned, retired, usedNumbers };
  for (const line of sliceMarkdown.split(/\r\n|\n/)) {
    if (line.startsWith('<!-- queue-from-ledger:v1 ')) {
      const match = PHASE_MARKER_RE.exec(line);
      if (!match) throw new QueueFromLedgerError(`Unrecognized generated phase marker in ${SLICE_RELATIVE_PATH}: ${line.slice(0, 120)}`, 3);
      if (assigned.has(match[2]) || retired.has(match[2])) throw new QueueFromLedgerError(`${match[2]} appears twice in ${SLICE_RELATIVE_PATH}.`, 3);
      assigned.set(match[2], match[1]);
      usedNumbers.add(phaseNumber(match[1]));
    } else if (line.startsWith('- **Q')) {
      const match = RETIRED_RECEIPT_RE.exec(line);
      if (!match) throw new QueueFromLedgerError(`Unrecognized retired-id receipt in ${SLICE_RELATIVE_PATH}: ${line.slice(0, 120)}`, 3);
      if (assigned.has(match[2]) || retired.has(match[2])) throw new QueueFromLedgerError(`${match[2]} appears twice in ${SLICE_RELATIVE_PATH}.`, 3);
      retired.set(match[2], match[1]);
      usedNumbers.add(phaseNumber(match[1]));
    }
  }
  if (usedNumbers.size !== assigned.size + retired.size) {
    throw new QueueFromLedgerError(`${SLICE_RELATIVE_PATH} assigns one phase id to more than one owner request.`, 3);
  }
  return { assigned, retired, usedNumbers };
}

/**
 * The corpus this slice must not collide with: the root queue plus every other
 * declared slice. nextPhaseId over that text is the first number no other part
 * of the queue has ever used, including Completed receipts and slice markers.
 */
function corpusHighWaterMark(rootFile = QUEUE_ROOT_FILE) {
  const rootMarkdown = readIfPresent(rootFile);
  if (rootMarkdown === null) throw new QueueFromLedgerError(`${rootFile} is missing; refusing to allocate phase ids without seeing the queue.`, 4);
  const texts = [rootMarkdown];
  for (const entry of parseQueueIndex(rootMarkdown)) {
    if (entry.path === SLICE_RELATIVE_PATH) continue;
    const text = readIfPresent(path.join(path.dirname(rootFile), ...entry.path.split('/')));
    if (text === null) throw new QueueFromLedgerError(`Declared slice ${entry.path} is missing; refusing to allocate phase ids against an incomplete corpus.`, 4);
    texts.push(text);
  }
  return phaseNumber(nextPhaseId(texts.join('\n')));
}

function renderPhase(entry) {
  const { requestId, phaseId, gates, requestStatus, ownerAuthorityLabel, totalGateCount } = entry;
  const lines = [];
  lines.push(`<!-- queue-from-ledger:v1 phase=${phaseId} request=${requestId} activeGates=${gates.length} -->`);
  lines.push(`## ${phaseId} — ${titleFor(requestId, gates)}`);
  lines.push('');
  lines.push(`**Status:** ${queueStatusFor(requestStatus)}`);
  lines.push(`**Package:** ${PACKAGE_ID}.`);
  lines.push(`**Authority:** ${requestId}; directiveId: owner-request-ledger:${requestId}`);
  // The Authority line says WHERE this phase came from. This line says whether
  // the record can show the OWNER asked for it. Both, always, in that order --
  // a phase that cites a ledger id without stating its provenance class is how
  // an agent's default acquires the owner's voice.
  lines.push(`**Owner authority:** ${ownerAuthorityLabel}`);
  // WHAT THIS REQUEST ALREADY PERMITS. A builder that reads only its own phase
  // must not have to go looking for permission that was recorded on the same
  // entry; on 2026-08-12 two lanes stopped work because the approval was real
  // and lived nowhere they read.
  for (const record of entry.authorizations) {
    lines.push(`**${record.kind === 'grant' ? 'Authorized' : 'Forbidden'} (${record.ref}):** `
      + `${record.subject || record.instruction}`);
  }
  lines.push(`**Source:** \`reports/OWNER-REQUEST-LEDGER.json\` → ${requestId}; ${gates.length} of ${totalGateCount} recorded gate${totalGateCount === 1 ? '' : 's'} currently active.`);
  lines.push('');
  lines.push('**Acceptance criteria — the ledger\'s own active gates, stored text, unaltered:**');
  lines.push('');
  for (const gate of gates) lines.push(`${gate.gateIndex + 1}. ${gate.instruction}`);
  lines.push('');
  lines.push('Closing this phase means recording each gate above as met, with evidence, in');
  lines.push('`reports/OWNER-REQUEST-LEDGER.json`. Editing this file closes nothing: it is');
  lines.push(`regenerated from the ledger by \`node ${GENERATOR} --write\`.`);
  lines.push('');
  return lines.join('\n');
}

function renderRetired(retired) {
  const lines = [RETIRED_HEADING, ''];
  lines.push('An id is retired, never released, when its owner request stops having an active');
  lines.push('gate. `src/lib/build-queue-writer.js` reads these receipts, so a retired id can');
  lines.push('never be handed to a different request. Retiring is not closing: the ledger');
  lines.push('entry itself records whether the work was done, superseded or descoped.');
  lines.push('');
  const rows = [...retired.entries()].sort((left, right) => phaseNumber(left[1]) - phaseNumber(right[1]));
  if (rows.length === 0) lines.push('None yet.');
  for (const [requestId, phaseId] of rows) {
    lines.push(`- **${phaseId} — ${requestId}:** retired; ${requestId} has no active gate in the owner request ledger. Reserved, never reused.`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * The permissions block. It sits above the phases, is never filtered by
 * lifecycle, and is rendered even when it is empty -- an empty section that
 * says "none declared" is what stops a reader concluding "none exist" from a
 * section that simply was not printed.
 */
function renderAuthorizations(authorizations) {
  const lines = ['## Authorizations on file — read this before stopping for lack of permission', ''];
  lines.push(
    'Not queued work and not filtered by lifecycle: finishing, superseding or retiring',
    'the task an authorization covered does not withdraw the authorization. Only an entry',
    'that explicitly revokes it does.',
    ''
  );
  if (authorizations.inForce.length === 0) {
    lines.push(authorizations.counts.undeclaredClauses > 0
      ? `None declared. ${authorizations.counts.undeclaredClauses} clause`
        + `${authorizations.counts.undeclaredClauses === 1 ? '' : 's'} in the ledger carry no `
        + '`clauseKind`, so this means "nothing has been classified as a permission", not '
        + '"the owner has permitted nothing".'
      : 'None on file. Every clause in the ledger is declared work.', '');
  }
  for (const record of authorizations.inForce) {
    lines.push(`${ledgerQuery.renderAuthorizationLine(record)}`);
  }
  if (authorizations.inForce.length > 0) lines.push('');
  return lines.join('\n');
}

function renderSlice(projection) {
  const { entries, gateCount, citableGateCount, statusCounts, retired, authorizations } = projection;
  const statusLine = Object.keys(statusCounts).sort()
    .map(status => `${status} ${statusCounts[status]}`).join(', ') || 'none';
  const header = [
    '<!-- GENERATED FILE — DO NOT HAND-EDIT.',
    `     Written by \`node ${GENERATOR} --write\` from reports/OWNER-REQUEST-LEDGER.json,`,
    '     reports/OWNER-REQUEST-LEDGER-ARCHIVE.json and the reviewed scope store, through the',
    '     same active-gate projection that produces reports/OPEN-GATES.md.',
    '     Hand edits are erased on the next run and are caught by',
    `     \`node ${GENERATOR}\` (exit 3) and \`node tests/queue-from-ledger.js\`. -->`,
    '',
    `# Owner-directive queue slice — package \`${PACKAGE_ID}\` — GENERATED FILE, DO NOT HAND-EDIT`,
    '',
    'Every phase below is a projection of one owner-request-ledger entry that still has at',
    'least one ACTIVE gate, ordered by R-id. A phase\'s authority is its R-id and nothing',
    'else: a Q-number is not evidence that the owner asked for anything, and each id here',
    'belongs to its R-id permanently (see "Retired generated phase ids" at the end).',
    '',
    'To change what is queued here, change the ledger. To change WHICH gates are active,',
    'change the scope classification. Then re-run the generator; do not edit this file.',
    'To say a phase is being worked, move its ledger entry to `in-progress` — an in-place',
    'claim on this file is drift and will be erased.',
    '',
    `- Phases: ${entries.length} (one per owner request with active gates)`,
    `- Active gates carried as acceptance criteria: ${gateCount}`,
    `- Of those active gates, ${citableGateCount} can show the owner's authority and ${gateCount - citableGateCount} cannot.`,
    '  A gate that is not OWNER STATED or OWNER RATIFIED may still be worth doing, but it',
    '  MUST NOT be described back to the owner as his own requirement.',
    `- Queue status distribution: ${statusLine}.`,
    '',
    'This file carries no timestamp on purpose: it is a function of its sources alone, so a',
    `stamp could only manufacture drift. \`node ${GENERATOR}\` is the freshness check.`,
    '',
    '---',
    ''
  ].join('\n');
  // An empty projection says so in words. A file that just stops after the
  // header reads like a truncated write; this reads like the answer it is, and
  // names the two different reasons a reader might be looking at it.
  const body = entries.length === 0
    ? [
      '## No queued owner-directive work',
      '',
      'No owner request in `reports/OWNER-REQUEST-LEDGER.json` currently has an ACTIVE gate,',
      'so this package queues nothing. That is the correct rendering of two different',
      'situations and the ledger itself tells them apart:',
      '',
      '- a fresh record with no requests in it yet — the normal state of a new install; or',
      '- a record whose every gate is met, superseded, retired or held back by scope',
      '  classification.',
      '',
      'This is not an error and not a truncated file. Any phase id that was ever issued',
      'here is listed under "Retired generated phase ids" below and is still reserved for',
      'the exact request it was issued to, so a request that becomes active again returns',
      'with its original id.',
      ''
    ].join('\n')
    : entries.map(renderPhase).join('\n');
  return `${header}\n${renderAuthorizations(authorizations)}\n${body}\n${renderRetired(retired)}`;
}

/**
 * Read the ledger, the archive and the scope store, and group the ACTIVE gates
 * by request. Deliberately delegates every lifecycle judgement to
 * tools/ledger-query.js: a second implementation of "which gate counts" would
 * be a second source of truth, which is the class of defect being fixed.
 */
async function projectActiveGates(options = {}) {
  const ledgerFile = options.ledgerFile || ledgerQuery.LEDGER_PATH;
  const archiveFile = options.archiveFile || ledgerQuery.ARCHIVE_PATH;
  let ledger;
  let archive;
  let rules;
  try {
    ledger = await ledgerQuery.readLedger(ledgerFile);
    archive = await ledgerQuery.readArchiveState(archiveFile);
    rules = scopeStore.readScopeStore(
      options.scopeStoreFile === undefined ? {} : { file: options.scopeStoreFile }
    ).rules;
  } catch (error) {
    throw new QueueFromLedgerError(`Could not read the ledger sources: ${error.message}`, 4);
  }
  if (!Array.isArray(ledger)) {
    throw new QueueFromLedgerError(`${ledgerFile} did not yield a requests array.`, 4);
  }
  /* AN EMPTY RECORD IS A RECORD, NOT A READ FAILURE.
   *
   * This used to be `ledger.length === 0 -> throw exit 4`, reasoning that
   * "absence is never a pass" and that an empty projection would silently
   * delete the queued backlog. Measured 2026-08-12, on the ledger the owner had
   * just reset to zero at his own direction:
   *   node tools/queue-from-ledger.js --check  ->  exit 4, 72 ms
   *   "contains no requests; refusing to project an empty queue from it."
   * A fresh install is exactly that state, so the queue generator refused to
   * run for every new user, on the first command they would ever give it.
   *
   * The old guard conflated two different facts. "Unreadable" is still a hard
   * failure and is raised above by ledgerQuery.readLedger -- missing file exit
   * 2, malformed JSON or wrong shape exit 3. Only a file that parses cleanly
   * and genuinely holds zero requests reaches this line, and about that file
   * the honest projection is an empty one.
   *
   * Nor can the deletion it feared be silent. An id that loses its active gate
   * is not released: it is written into "Retired generated phase ids" with its
   * own R-id and stays reserved for it (see renderRetired and the reinstatement
   * branch in buildSlice), the run reports retiredIds, and if the requests come
   * back they get their original phase ids back. And leaving a stale slice on
   * disk instead -- the "no-op" alternative -- would republish work the record
   * no longer contains, which is the two-diverging-lists defect this tool was
   * built to end.
   */
  try {
    return {
      ledger,
      gateProjection: ledgerQuery.processOpenGates(ledger, {
        scopeRules: rules,
        classifiedMode: rules.length > 0,
        retiredRequests: archive.requests,
        retirements: archive.retirements
      })
    };
  } catch (error) {
    throw new QueueFromLedgerError(`The active-gate projection failed: ${error.message}`, 4);
  }
}

async function buildSlice(options = {}) {
  const { ledger, gateProjection } = await projectActiveGates(options);
  const requestById = new Map(ledger.map(request => [request.id, request]));

  const byRequest = new Map();
  for (const gate of gateProjection.active) {
    if (!byRequest.has(gate.requestId)) byRequest.set(gate.requestId, []);
    byRequest.get(gate.requestId).push(gate);
  }
  const activeRequestIds = [...byRequest.keys()].sort(byRequestId);

  const priorText = options.sliceMarkdown === undefined ? readIfPresent(SLICE_FILE) : options.sliceMarkdown;
  const prior = readAssignments(priorText);
  const used = new Set(prior.usedNumbers);
  const assigned = new Map(prior.assigned);
  let candidate = Math.max(
    options.highWaterMark === undefined ? corpusHighWaterMark(options.rootFile) : options.highWaterMark,
    used.size === 0 ? 1 : Math.max(...used) + 1
  );

  for (const requestId of activeRequestIds) {
    if (assigned.has(requestId)) continue;
    if (prior.retired.has(requestId)) {
      // The request became active again. Its own id comes back; a second id
      // would leave the first pointing at a request that already has one.
      assigned.set(requestId, prior.retired.get(requestId));
      prior.retired.delete(requestId);
      continue;
    }
    while (used.has(candidate)) candidate += 1;
    if (candidate > MAX_PHASE_NUMBER) {
      throw new QueueFromLedgerError(
        `Queue phase ids are exhausted at Q${MAX_PHASE_NUMBER}: ${activeRequestIds.length} owner requests have active gates and the corpus has no free id left. `
        + 'This is a real capacity limit of the Q1-Q999 phase-id space, not a transient failure; it needs a decision, not a retry.',
        4
      );
    }
    assigned.set(requestId, `Q${candidate}`);
    used.add(candidate);
    candidate += 1;
  }

  // Anything previously assigned that is no longer active retires; its id stays
  // spoken for.
  const retired = new Map(prior.retired);
  for (const [requestId, phaseId] of assigned) {
    if (!byRequest.has(requestId)) retired.set(requestId, phaseId);
  }
  for (const requestId of retired.keys()) assigned.delete(requestId);

  const authorizations = gateProjection.authorizations;
  const authorizationsByRequest = new Map();
  for (const record of authorizations.inForce) {
    const values = authorizationsByRequest.get(record.requestId) || [];
    values.push(record);
    authorizationsByRequest.set(record.requestId, values);
  }

  const entries = activeRequestIds.map(requestId => {
    const gates = byRequest.get(requestId).slice().sort((a, b) => a.gateIndex - b.gateIndex);
    const request = requestById.get(requestId);
    return {
      requestId,
      phaseId: assigned.get(requestId),
      gates,
      authorizations: authorizationsByRequest.get(requestId) || [],
      requestStatus: gates[0].requestStatus,
      ownerAuthorityLabel: gates[0].ownerAuthority.label,
      totalGateCount: request && Array.isArray(request.gates) ? request.gates.length : gates.length
    };
  });

  const statusCounts = {};
  for (const entry of entries) {
    const status = String(entry.requestStatus);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  const projection = {
    entries,
    retired,
    authorizations,
    gateCount: gateProjection.active.length,
    citableGateCount: gateProjection.ownerAuthority.citableAsOwnerRequirement,
    statusCounts,
    counts: gateProjection.counts
  };
  const markdown = renderSlice(projection);
  return { projection, markdown, sha256: sha256(markdown), bytes: Buffer.byteLength(markdown, 'utf8') };
}

/** Is the slice declared by BUILD-QUEUE.md's package index? */
function rootIndexDeclaration(rootFile = QUEUE_ROOT_FILE) {
  const rootMarkdown = readIfPresent(rootFile);
  if (rootMarkdown === null) return { declared: false, reason: `${rootFile} is missing.` };
  let index;
  try { index = parseQueueIndex(rootMarkdown); }
  catch (error) { return { declared: false, reason: `BUILD-QUEUE.md's package index is unreadable: ${error.message}` }; }
  const declared = index.some(entry => entry.packageId === PACKAGE_ID && entry.path === SLICE_RELATIVE_PATH);
  return {
    declared,
    packageIds: index.map(entry => entry.packageId),
    reason: declared ? null : `BUILD-QUEUE.md's package index does not declare \`${PACKAGE_ID}\`: ${SLICE_RELATIVE_PATH}. Nothing reads an undeclared slice, so its phases are not queued work.`
  };
}

/**
 * Add this package to BUILD-QUEUE.md's index block, and change nothing else.
 *
 * BUILD-QUEUE.md is write-protected and STANDING-ORDERS SYNC rule 7 forbids
 * hand-editing a file that has a writer, so this composes that file's own
 * pieces: renderQueueIndex to emit the block, removeQueueIndex to prove nothing
 * outside it moved, and build-queue-migrate's compare-and-swap installer (lock,
 * read fence, recovery file, post-write verify) to install it.
 */
function declareInRootIndex({ rootFile = QUEUE_ROOT_FILE, apply = false } = {}) {
  const previous = readIfPresent(rootFile);
  if (previous === null) throw new QueueFromLedgerError(`${rootFile} is missing.`, 4);
  const index = parseQueueIndex(previous);
  if (index.some(entry => entry.packageId === PACKAGE_ID)) {
    return { changed: false, applied: false, packageIds: index.map(entry => entry.packageId) };
  }
  const headingStart = previous.indexOf(INDEX_HEADING);
  if (headingStart < 0) throw new QueueFromLedgerError(`${rootFile} has no package queue index to declare into.`, 4);
  const without = removeQueueIndex(previous);
  const packageIds = [...index.map(entry => entry.packageId), PACKAGE_ID];
  const next = without.slice(0, headingStart) + renderQueueIndex(packageIds) + without.slice(headingStart);
  // The byte fence: strip the index from both, and everything else must be
  // identical. Without this, a rendering bug could rewrite the queue body while
  // reporting an index-only change.
  if (removeQueueIndex(next) !== without) {
    throw new QueueFromLedgerError('Refusing to install a root queue whose non-index bytes changed.', 4);
  }
  const reparsed = parseQueueIndex(next);
  if (reparsed.length !== packageIds.length || !reparsed.some(entry => entry.packageId === PACKAGE_ID && entry.path === SLICE_RELATIVE_PATH)) {
    throw new QueueFromLedgerError('The rewritten package index did not parse back to the intended slice set.', 4);
  }
  if (apply) replaceRootCas(rootFile, previous, next);
  return { changed: true, applied: apply, packageIds: reparsed.map(entry => entry.packageId) };
}

function readManifest(manifestFile = MANIFEST_FILE) {
  const raw = readIfPresent(manifestFile);
  if (raw === null) throw new QueueFromLedgerError(`${manifestFile} is missing.`, 5);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new QueueFromLedgerError(`${manifestFile} is not valid JSON: ${error.message}`, 5); }
  try { assertManifest(parsed); }
  catch (error) { throw new QueueFromLedgerError(`${manifestFile} does not satisfy the migration manifest schema: ${error.message}`, 5); }
  return parsed;
}

/**
 * Declare (or re-stamp) this package's slice receipt in queue/manifest.json,
 * leaving every other field byte-identical. Re-validated through
 * tools/build-queue-migrate.js's own assertManifest before it is written, so
 * this cannot quietly break that file's exact schema.
 */
function manifestWithSlice(manifest, receipt) {
  const next = {
    ...manifest,
    slices: [
      ...manifest.slices.filter(slice => slice.packageId !== PACKAGE_ID),
      { packageId: PACKAGE_ID, path: SLICE_RELATIVE_PATH, sha256: receipt.sha256, bytes: receipt.bytes }
    ].sort((left, right) => left.packageId.localeCompare(right.packageId))
  };
  assertManifest(next);
  return `${JSON.stringify(next, null, 2)}\n`;
}

function manifestReceipt(manifest) {
  return manifest.slices.find(slice => slice.packageId === PACKAGE_ID) || null;
}

function parseArgs(argv) {
  const options = { write: false, declare: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === '--write') options.write = true;
    else if (arg === '--check') options.write = false;
    else if (arg === '--declare') options.declare = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new QueueFromLedgerError(`unknown argument: ${arg}`, 2);
  }
  if (options.declare && !options.write) throw new QueueFromLedgerError('--declare edits BUILD-QUEUE.md\'s index and must be run with --write.', 2);
  return options;
}

const USAGE = [
  `usage: node ${GENERATOR} [--check] [--write [--declare]] [--json]`,
  '',
  'Projects every owner-request-ledger entry that still has an ACTIVE gate into',
  `${SLICE_RELATIVE_PATH}, one phase per request, ordered by R-id, each citing its`,
  'R-id as authority and carrying its active gates as acceptance criteria.',
  '',
  '  (no flags) / --check   read-only. Exit 3 if the on-disk slice has drifted from',
  '                         the ledger, 5 if the slice is not declared.',
  '  --write                rewrite the slice and re-stamp its receipt in',
  '                         queue/manifest.json.',
  '  --write --declare      also add this package to BUILD-QUEUE.md\'s package index',
  '                         (index block only, compare-and-swap, byte-fenced).',
  '  --json                 machine-readable result on stdout.',
  '',
  'Never writes reports/OWNER-REQUEST-LEDGER.json.',
  ''
].join('\n');

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const built = await buildSlice();
  const onDisk = readIfPresent(SLICE_FILE);
  const manifest = readManifest();
  const receipt = manifestReceipt(manifest);
  const declaration = rootIndexDeclaration();

  // A missing slice is only an unambiguous first-run state when neither queue
  // registry says that the slice already exists. Once either registry names
  // it, the file is also the sole durable record of the append-only R-id ->
  // Q-id assignments. Treating ENOENT as an empty prior slice here used to let
  // --write allocate replacement ids and report a successful regeneration,
  // even though the assignments could not be recovered. Refuse instead.
  if (onDisk === null && (receipt || declaration.declared)) {
    const registries = [
      receipt ? 'queue/manifest.json' : null,
      declaration.declared ? "BUILD-QUEUE.md's package index" : null
    ].filter(Boolean).join(' and ');
    throw new QueueFromLedgerError(
      `${SLICE_RELATIVE_PATH} is missing but ${registries} declares it; refusing to regenerate without its append-only phase-id assignments.`,
      4
    );
  }

  const result = {
    schemaVersion: 1,
    action: options.write ? 'write' : 'check',
    packageId: PACKAGE_ID,
    slice: SLICE_RELATIVE_PATH,
    phases: built.projection.entries.length,
    retiredIds: built.projection.retired.size,
    activeGates: built.projection.gateCount,
    gatesShowingOwnerAuthority: built.projection.citableGateCount,
    authorizationsInForce: built.projection.authorizations.inForce.length,
    undeclaredClauses: built.projection.authorizations.counts.undeclaredClauses,
    phaseIdRange: built.projection.entries.length
      ? `${built.projection.entries.reduce((a, e) => Math.min(a, phaseNumber(e.phaseId)), Infinity)}..${built.projection.entries.reduce((a, e) => Math.max(a, phaseNumber(e.phaseId)), 0)}`
      : 'none',
    sha256: built.sha256,
    bytes: built.bytes,
    sliceMatchesLedger: onDisk === built.markdown,
    manifestReceiptCurrent: Boolean(receipt && receipt.sha256 === built.sha256 && receipt.bytes === built.bytes),
    declaredInManifest: Boolean(receipt),
    declaredInRootIndex: false
  };

  if (options.write) {
    fs.mkdirSync(path.dirname(SLICE_FILE), { recursive: true });
    fs.writeFileSync(SLICE_FILE, built.markdown, 'utf8');
    fs.writeFileSync(MANIFEST_FILE, manifestWithSlice(manifest, built), 'utf8');
    result.wrote = [SLICE_RELATIVE_PATH, 'queue/manifest.json'];
    result.sliceMatchesLedger = true;
    result.manifestReceiptCurrent = true;
    result.declaredInManifest = true;
    if (options.declare) {
      const declaration = declareInRootIndex({ apply: true });
      if (declaration.changed) result.wrote.push('BUILD-QUEUE.md (package index block only)');
    }
  }

  result.declaredInRootIndex = declaration.declared;

  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const lines = [
      'QUEUE FROM LEDGER -- the build queue as a projection of the owner request ledger',
      '',
      `  package        ${PACKAGE_ID}`,
      `  slice          ${SLICE_RELATIVE_PATH} (${result.bytes} bytes, sha256 ${result.sha256.slice(0, 16)}…)`,
      `  phases         ${result.phases} in Q${result.phaseIdRange}, one per owner request with at least one active gate`,
      `  retired ids    ${result.retiredIds} reserved, never reused`,
      `  gates          ${result.activeGates} active gates carried as acceptance criteria`,
      `  attribution    ${result.gatesShowingOwnerAuthority} of ${result.activeGates} active gates can show the owner's authority`,
      `  authorizations ${result.authorizationsInForce} in force; ${result.undeclaredClauses} clause${result.undeclaredClauses === 1 ? '' : 's'} declare no kind`,
      `  declared       BUILD-QUEUE.md index: ${result.declaredInRootIndex ? 'yes' : 'NO'}; queue/manifest.json: ${result.declaredInManifest ? 'yes' : 'NO'}`,
      ''
    ];
    if (options.write) lines.push(`  WROTE ${result.wrote.join(', ')}.`, '');
    else if (!result.sliceMatchesLedger) {
      lines.push(onDisk === null
        ? `  DRIFT: ${SLICE_RELATIVE_PATH} does not exist. Run \`node ${GENERATOR} --write\`.`
        : `  DRIFT: ${SLICE_RELATIVE_PATH} is not what the ledger currently projects.`,
      '  Either it was hand-edited or the ledger moved. Regenerate; do not edit it.', '');
    } else if (!result.manifestReceiptCurrent) {
      lines.push('  DRIFT: queue/manifest.json\'s receipt for this slice is stale.', '');
    } else if (!result.declaredInRootIndex) {
      lines.push(`  UNDECLARED: ${declaration.reason}`, '');
    } else {
      lines.push('  The slice matches the ledger, its receipt is current, and it is declared.', '');
    }
    process.stdout.write(lines.join('\n'));
  }

  if (!result.sliceMatchesLedger || !result.manifestReceiptCurrent) return 3;
  if (!result.declaredInRootIndex || !result.declaredInManifest) return 5;
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof QueueFromLedgerError ? error.exitCode : 1;
  });
}

module.exports = Object.freeze({
  MANIFEST_FILE,
  PACKAGE_ID,
  QueueFromLedgerError,
  SLICE_FILE,
  SLICE_RELATIVE_PATH,
  USAGE,
  buildSlice,
  corpusHighWaterMark,
  declareInRootIndex,
  main,
  manifestReceipt,
  manifestWithSlice,
  projectActiveGates,
  queueStatusFor,
  readAssignments,
  readManifest,
  renderSlice,
  rootIndexDeclaration,
  titleFor
});
