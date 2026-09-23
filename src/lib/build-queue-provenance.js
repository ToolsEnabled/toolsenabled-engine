'use strict';

// BUILD-QUEUE PROVENANCE: does every queued item trace to a real request, and
// does every actionable request reach the queue?
//
// WHY THE EXISTING GRAMMAR DOES NOT CATCH THIS.  src/lib/build-queue-writer.js
// already requires an Authority line matching /R\d+\b.*directiveId:/ -- but
// that validates the SHAPE of a citation, never its REFERENT. A well-formed id
// can still be absent from the configured ledger, so both checks are required.
//
// THE ABSENCE CASE.  This codebase's signature defect is absence-read-as-consent
// An unreadable ledger, a ledger with no requests, or a queue phase with no
// citation at all are all findings here, never silent passes. A checker that
// reports "clean" because it could not read the ledger would reproduce the
// very defect it exists to catch.
//
// This module is pure: it takes text in and returns findings.  It reads no
// files, writes nothing, and never mutates the queue or the ledger.

const { isRequestId } = require('./request-id');

const PHASE_HEADING_RE = /^##\s+(Q\d+)\s*(?:[—\-–]\s*)?(.*)$/;
const STATUS_RE = /^\*\*Status:\*\*\s*([A-Z-]+)/;
const AUTHORITY_RE = /^\*\*Authority:\*\*\s*(.+)$/;

// An R-id in CITATION POSITION only.  Deliberately NOT every R-looking token in
// the document: design prose may contain version-like or tier-like R tokens.
// Treating all prose as a citation would create false authority findings.
const RID_TOKEN = /\bR\d{2,}(?:\.\d+)?\b/g;

// A decision document whose filename carries an R-number is itself an authority
// citation. Its referent must exist in the configured ledger.
const DECISION_DOC_REF = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-R(\d{2,})(?:\.\d+)?\.md\b/g;

// Statuses that still represent work the queue is asserting.  A DONE phase's
// provenance is history; a phase that is still steering builders is a claim
// about what the owner wants, and that claim has to resolve.
const PENDING_STATUSES = new Set(['OPEN', 'IN-PROGRESS', 'BLOCKED']);

// Ledger statuses that mean "this directive is not finished".  An unfinished
// directive that no queue phase names is work the owner asked for that no
// builder loop can ever pick up.
const ACTIONABLE_LEDGER_STATUSES = new Set(['open', 'in-progress', 'partial']);

class BuildQueueProvenanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BuildQueueProvenanceError';
    this.code = code;
  }
}

function ridsIn(text) {
  const out = [];
  RID_TOKEN.lastIndex = 0;
  let match;
  while ((match = RID_TOKEN.exec(text)) !== null) out.push(match[0]);
  RID_TOKEN.lastIndex = 0;
  return out;
}

/**
 * Split queue markdown into phases, recording only the text that can carry a
 * provenance citation: the heading and the Authority line(s).
 */
function parsePhases(markdown, file) {
  if (typeof markdown !== 'string') {
    throw new BuildQueueProvenanceError('QUEUE_PROVENANCE_TEXT_INVALID', `${file}: queue markdown must be text.`);
  }
  const phases = [];
  let current = null;
  // An Authority block may wrap across several lines. Reading only the first
  // line would miss a continuation citation and report a sourced phase as
  // unsourced.
  let inAuthority = false;
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    const heading = PHASE_HEADING_RE.exec(line);
    if (heading) {
      current = {
        id: heading[1],
        title: heading[2].trim(),
        file,
        line: index + 1,
        status: null,
        headingText: line,
        authorityLines: [],
        bodyLines: [],
        claimsOwner: false
      };
      phases.push(current);
      inAuthority = false;
      return;
    }
    if (!current) return;
    current.bodyLines.push(line);
    const status = STATUS_RE.exec(line);
    if (status && current.status === null) current.status = status[1];
    const authority = AUTHORITY_RE.exec(line);
    if (authority) {
      current.authorityLines.push({ line: index + 1, text: authority[1] });
      inAuthority = true;
      return;
    }
    if (inAuthority) {
      // The block ends at a blank line or at the next bolded field.
      if (!line.trim() || /^\*\*[A-Z]/.test(line) || /^#{2,}\s/.test(line)) inAuthority = false;
      else current.authorityLines.push({ line: index + 1, text: line });
    }
  });

  for (const phase of phases) {
    const citationText = [phase.headingText, ...phase.authorityLines.map(a => a.text)].join('\n');
    const bodyText = phase.bodyLines.join('\n');
    phase.citationText = citationText;
    phase.rids = [...new Set(ridsIn(citationText))];
    // Decision documents named after an owner request are citations wherever
    // they appear in the phase, not only on the Authority line.
    const decisionRefs = [];
    DECISION_DOC_REF.lastIndex = 0;
    let ref;
    while ((ref = DECISION_DOC_REF.exec(`${citationText}\n${bodyText}`)) !== null) {
      decisionRefs.push({ doc: ref[0], rid: `R${ref[1]}` });
    }
    DECISION_DOC_REF.lastIndex = 0;
    phase.decisionRefs = decisionRefs;
    // "owner request", "owner asked", "Owner request in the active ... session"
    phase.claimsOwner = /\bowner\b/i.test(citationText) || /\bowner request\b/i.test(phase.title);
    phase.hasDirectiveId = /\bdirectiveId:\s*\S/.test(citationText);
  }
  return phases;
}

/**
 * Index a ledger object into the id set and the actionable-directive list.
 * An empty or malformed ledger throws: see THE ABSENCE CASE above.
 */
function indexLedger(ledger, { source = 'ledger' } = {}) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new BuildQueueProvenanceError('QUEUE_PROVENANCE_LEDGER_INVALID', `${source}: the owner request ledger must be an object.`);
  }
  if (!Array.isArray(ledger.requests)) {
    throw new BuildQueueProvenanceError('QUEUE_PROVENANCE_LEDGER_INVALID', `${source}: the owner request ledger has no "requests" array.`);
  }
  if (ledger.requests.length === 0) {
    // An empty ledger would make every citation phantom AND every directive
    // satisfied, i.e. it would produce a confidently wrong answer in both
    // directions. Refuse instead.
    throw new BuildQueueProvenanceError('QUEUE_PROVENANCE_LEDGER_EMPTY', `${source}: the owner request ledger is empty; refusing to judge provenance against it.`);
  }
  const ids = new Set();
  const actionable = [];
  for (let entryIndex = 0; entryIndex < ledger.requests.length; entryIndex += 1) {
    const entry = ledger.requests[entryIndex];
    // Status is optional because authorization flows may supply a valid id
    // without lifecycle state. Refuse what cannot be classified (no id, or a
    // status that is present but empty), accept a valid id whose status is
    // absent, and never silently drop a record.
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.id !== 'string' || !entry.id.trim()
        || (entry.status !== undefined && (typeof entry.status !== 'string' || !entry.status.trim()))) {
      throw new BuildQueueProvenanceError(
        'QUEUE_PROVENANCE_LEDGER_ENTRY_INVALID',
        `${source}: ledger entry at index ${entryIndex} cannot be classified (id required; status optional but never empty); refusing to count around it.`
      );
    }
    // The ledger now also carries T (task), A (ask) and P (purchase) records.
    // A queue phase can only ever cite an R-id (RID_TOKEN), and an open T/P
    // record is not a directive any queue phase could structurally name --
    // so it must never enter `actionable` and produce a false
    // DIRECTIVE_QUEUED_NOWHERE, and it must never enter `ids` either, since
    // this module's whole job is R-referent resolution.
    if (!isRequestId(entry.id, { family: 'R' })) continue;
    ids.add(entry.id);
    const status = String(entry.status || '').toLowerCase();
    if (ACTIONABLE_LEDGER_STATUSES.has(status)) {
      actionable.push({ id: entry.id, status });
    }
  }
  if (ids.size === 0) {
    throw new BuildQueueProvenanceError('QUEUE_PROVENANCE_LEDGER_EMPTY', `${source}: no ledger entry carries an R-family id.`);
  }
  return { ids, actionable, revision: ledger.revision ?? null, entryCount: ledger.requests.length };
}

/**
 * The audit. `sources` is [{ file, markdown }] covering the root queue and every
 * declared package slice; `ledger` is the parsed OWNER-REQUEST-LEDGER object.
 */
function auditQueueProvenance({ sources, ledger, ledgerSource = 'reports/OWNER-REQUEST-LEDGER.json' } = {}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new BuildQueueProvenanceError('QUEUE_PROVENANCE_SOURCES_INVALID', 'At least one queue source is required.');
  }
  const index = indexLedger(ledger, { source: ledgerSource });

  const phases = [];
  for (const source of sources) {
    if (!source || typeof source.file !== 'string' || !source.file) {
      throw new BuildQueueProvenanceError('QUEUE_PROVENANCE_SOURCES_INVALID', 'Every queue source needs a file label.');
    }
    phases.push(...parsePhases(source.markdown, source.file));
  }
  if (phases.length === 0) {
    throw new BuildQueueProvenanceError(
      'QUEUE_PROVENANCE_PHASES_EMPTY',
      'The queue corpus contains no phases; refusing to report a zero-scan result.'
    );
  }

  const findings = [];
  const citedIds = new Set();

  for (const phase of phases) {
    const pending = PENDING_STATUSES.has(String(phase.status));
    for (const rid of phase.rids) {
      citedIds.add(rid);
      if (!index.ids.has(rid)) {
        findings.push({
          code: 'PHANTOM_RID',
          severity: 'error',
          phaseId: phase.id,
          file: phase.file,
          line: phase.line,
          rid,
          status: phase.status,
          message: `${phase.id} cites ${rid} as authority, but ${rid} does not exist in ${ledgerSource}.`
        });
      }
    }
    // A decision document named for a request that does not exist asserts
    // unverifiable authority. Flag it whether or not the phase is pending.
    for (const ref of phase.decisionRefs) {
      citedIds.add(ref.rid);
      if (!index.ids.has(ref.rid)) {
        findings.push({
          code: 'PHANTOM_DECISION_DOC',
          severity: 'error',
          phaseId: phase.id,
          file: phase.file,
          line: phase.line,
          rid: ref.rid,
          doc: ref.doc,
          status: phase.status,
          message: `${phase.id} points at ${ref.doc}, whose name asserts ${ref.rid}; ${ref.rid} does not exist in ${ledgerSource}.`
        });
      }
    }

    // An authority claim with no resolvable id is unverifiable.
    if (phase.rids.length === 0 && phase.decisionRefs.length === 0 && pending) {
      findings.push({
        code: phase.claimsOwner ? 'UNVERIFIABLE_OWNER_CLAIM' : 'NO_PROVENANCE',
        severity: phase.claimsOwner ? 'error' : 'warn',
        phaseId: phase.id,
        file: phase.file,
        line: phase.line,
        status: phase.status,
        message: phase.claimsOwner
          ? `${phase.id} claims owner authority but cites no R-id that can be checked.`
          : `${phase.id} is ${phase.status} with no owner-request provenance of any kind.`
      });
    }
  }

  // The reverse link: a captured directive that reached no queue phase.
  const orphanDirectives = index.actionable
    .filter(entry => !citedIds.has(entry.id))
    .map(entry => ({
      code: 'DIRECTIVE_QUEUED_NOWHERE',
      severity: 'warn',
      rid: entry.id,
      status: entry.status,
      message: `${entry.id} is ${entry.status} in ${ledgerSource} but no queue phase names it.`
    }));

  const phantomRids = [...new Set(findings
    .filter(f => f.code === 'PHANTOM_RID' || f.code === 'PHANTOM_DECISION_DOC')
    .map(f => f.rid))];
  const errors = findings.filter(f => f.severity === 'error');

  return {
    schemaVersion: 1,
    ledgerRevision: index.revision,
    ledgerEntries: index.entryCount,
    files: sources.map(s => s.file),
    phaseCount: phases.length,
    pendingPhaseCount: phases.filter(p => PENDING_STATUSES.has(String(p.status))).length,
    citedIdCount: citedIds.size,
    phantomRids,
    findings,
    orphanDirectives,
    actionableDirectiveCount: index.actionable.length,
    orphanDirectiveCount: orphanDirectives.length,
    errorCount: errors.length,
    warnCount: findings.length - errors.length,
    clean: errors.length === 0
  };
}

/**
 * The writer-side guard: refuse one phase whose authority cites an id the ledger
 * does not contain. Shape validation stays in build-queue-writer.js; this is the
 * referent check that shape validation structurally cannot do.
 */
function assertAuthorityResolves(authority, ledger, { ledgerSource = 'reports/OWNER-REQUEST-LEDGER.json' } = {}) {
  if (typeof authority !== 'string' || !authority.trim()) {
    throw new BuildQueueProvenanceError('QUEUE_PROVENANCE_AUTHORITY_INVALID', 'authority must be a non-empty string.');
  }
  const index = indexLedger(ledger, { source: ledgerSource });
  const rids = [...new Set(ridsIn(authority))];
  if (rids.length === 0) {
    throw new BuildQueueProvenanceError('QUEUE_PROVENANCE_AUTHORITY_UNCITED', 'authority cites no owner request id.');
  }
  const phantom = rids.filter(rid => !index.ids.has(rid));
  if (phantom.length) {
    throw new BuildQueueProvenanceError(
      'QUEUE_PROVENANCE_AUTHORITY_PHANTOM',
      `authority cites ${phantom.join(', ')}, absent from ${ledgerSource}.`
    );
  }
  return rids;
}

module.exports = Object.freeze({
  ACTIONABLE_LEDGER_STATUSES,
  PENDING_STATUSES,
  BuildQueueProvenanceError,
  assertAuthorityResolves,
  auditQueueProvenance,
  indexLedger,
  parsePhases,
  ridsIn
});
