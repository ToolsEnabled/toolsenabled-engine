'use strict';

// WHAT reports/OPEN-GATES.md MUST CONTAIN — the digest's shape contract.
//
// WHY THIS EXISTS (2026-08-12). The revision stamp answers "was this digest
// built from the current ledger". It cannot answer "was this digest built by
// the current renderer", and those are different questions. MEASURED today:
// tools/ledger-query.js gained an "Authorizations on file" section, the
// published reports/OPEN-GATES.md contained 0 occurrences of it, and
// `node tests/open-gates-freshness-check.js` exited 0 anyway -- because the
// stamped revision (1) equalled the live ledger revision (1). The digest was
// perfectly fresh and structurally a version behind, and the only gate on the
// file could not tell.
//
// So freshness has TWO axes and both must be checkable:
//   revision  -- is the content current?          (src/lib/open-gates-freshness.js)
//   shape     -- is the renderer current?         (this file)
//
// A CONTRACT ONLY WORKS IF BOTH SIDES READ THE SAME COPY. The writer
// (tools/ledger-query.js renderOpenGatesDigest) emits these exact heading
// strings from this list, and refuses to publish a digest that does not
// satisfy it; the reader (src/lib/open-gates-freshness.js, and through it
// tools/agent-preflight.js and .githooks/pre-push) checks the published file
// against the same list. A second hand-typed copy of "which sections exist"
// would drift silently, which is the defect one level up.
//
// ADDING A SECTION TO THE DIGEST: add it here, in its published position. The
// next `node tools/check-open-gates-freshness.js` then goes red on every
// digest that predates it, which is exactly the miss that went unnoticed
// today.
//
// Deliberately dependency-free and side-effect-free on load: the freshness
// module that requires it is itself required by a preflight path that must
// stay cheap, and by a git hook that must not be able to fail on a require.

/**
 * The published sections, in the order the digest must present them.
 *
 * `id`       stable key for callers/tests; never rendered.
 * `heading`  the exact markdown line the renderer emits and the reader looks for.
 * `why`      why a reader would be harmed by its absence. Kept next to the
 *            heading so a future editor deleting a section has to read it.
 */
const OPEN_GATES_SECTIONS = Object.freeze([
  Object.freeze({
    id: 'title',
    heading: '# Open owner-request gates',
    why: 'Without it the file is not identifiable as the digest at all.'
  }),
  Object.freeze({
    id: 'authority',
    heading: '## Whose requirements these are',
    why: 'Says which of the gates below the record can show the owner actually asked for.'
  }),
  Object.freeze({
    id: 'authorizations',
    heading: '## Authorizations on file',
    why: 'The permissions half. Two lanes stopped work on 2026-08-12 over a change the '
      + 'owner had authorized, because this file listed only tasks. It must render above '
      + '"## Active gates" so an agent that stops reading at the first task list has '
      + 'already passed the answer to "am I allowed to do this".'
  }),
  Object.freeze({
    id: 'active',
    heading: '## Active gates',
    why: 'The work an agent is expected to act on.'
  }),
  Object.freeze({
    id: 'unresolved',
    heading: '## Unresolved / unclassified gates — preserved, not active',
    why: 'Gates held back by classification are preserved in view, never dropped.'
  }),
  Object.freeze({
    id: 'superseded-clauses',
    heading: '## Superseded clause gates — request remains active',
    why: 'A superseded clause must not read as a superseded request.'
  }),
  Object.freeze({
    id: 'superseded',
    heading: '## Superseded gates — preserved, not active',
    why: 'Superseded requests stay visible with their provenance.'
  }),
  Object.freeze({
    id: 'retired-clauses',
    heading: '## Retired clause gates — request remains active',
    why: 'A retired clause must not read as a retired request.'
  }),
  Object.freeze({
    id: 'retired',
    heading: '## Retired gates — preserved, not active',
    why: 'Where a cold-storage retirement lands. An entry that vanished from '
      + '"## Active gates" must be findable here, or retirement reads as deletion.'
  }),
  Object.freeze({
    id: 'unmapped',
    heading: '## Unmapped clause dispositions — preserved for review',
    why: 'A disposition that identified no gate is reported, never silently discarded.'
  })
]);

/**
 * Summary lines that must appear in the header block. Prefix match: the
 * numbers change every run, the label does not. `Authorizations in force:` is
 * listed because a reader who skims only the header must still be told that
 * permissions are a thing this file carries.
 */
const OPEN_GATES_REQUIRED_LINES = Object.freeze([
  'Open gates:',
  'Authorizations in force:',
  'Ledger revision:'
]);

const SECTION_BY_ID = Object.freeze(Object.fromEntries(
  OPEN_GATES_SECTIONS.map(section => [section.id, section])
));

/** The exact heading line for one section id. Throws on an unknown id so a typo
 *  in the renderer is a crash at write time, not a missing section at read time. */
function heading(id) {
  const section = SECTION_BY_ID[id];
  if (!section) throw new TypeError(`OPEN_GATES_UNKNOWN_SECTION:${id}`);
  return section.heading;
}

/**
 * Check a rendered digest against the contract.
 *
 * Heading matching is line-anchored and prefix-based on purpose: the published
 * headings carry trailing prose (e.g. "## Authorizations on file — what is
 * already permitted or forbidden") which an editor may reword. What must not
 * change silently is that the SECTION EXISTS and sits in the right place, so
 * the stable stem is what is pinned.
 *
 * @param {string} text the digest's full contents
 * @returns {{complete: boolean, missing: string[], outOfOrder: string[], missingLines: string[]}}
 */
function checkDigestSections(text) {
  if (typeof text !== 'string') throw new TypeError('OPEN_GATES_DIGEST_TEXT_INVALID');
  const lines = text.split(/\r?\n/);
  const missing = [];
  const found = [];
  for (const section of OPEN_GATES_SECTIONS) {
    const index = lines.findIndex(line => line.trimEnd() === section.heading
      || line.startsWith(`${section.heading} `));
    if (index === -1) missing.push(section.id);
    else found.push({ id: section.id, index });
  }
  // Order is part of the contract, not a nicety: "## Authorizations on file"
  // below "## Active gates" is the same failure as it being absent for a reader
  // who stops at the first task list.
  const outOfOrder = [];
  for (let i = 1; i < found.length; i += 1) {
    if (found[i].index < found[i - 1].index) outOfOrder.push(`${found[i].id} must render after ${found[i - 1].id}`);
  }
  const missingLines = OPEN_GATES_REQUIRED_LINES
    .filter(prefix => !lines.some(line => line.startsWith(prefix)));
  return {
    complete: missing.length === 0 && outOfOrder.length === 0 && missingLines.length === 0,
    missing,
    outOfOrder,
    missingLines
  };
}

/**
 * One sentence naming what is wrong and the command that fixes it, or null.
 *
 * @param {object} result the value returned by checkDigestSections()
 * @param {object} [options]
 * @param {string|null} [options.revisionUnverified] when set, the reason the
 *   revision axis could NOT be evaluated (e.g. the live ledger was unreadable).
 *   The default sentence asserts "its revision stamp is current", which is a
 *   claim the caller has not earned in that case -- the shape axis needs only
 *   the digest and still holds, and saying so plainly is the point of this
 *   variant. Omit it and the wording is byte-identical to before, which the
 *   writer-side caller in tools/ledger-query.js relies on.
 */
function describeDigestShortfall(result, options = {}) {
  if (!result || typeof result !== 'object'
    || typeof result.complete !== 'boolean'
    || !Array.isArray(result.missing)
    || !Array.isArray(result.outOfOrder)
    || !Array.isArray(result.missingLines)) {
    throw new TypeError('OPEN_GATES_DIGEST_RESULT_INVALID');
  }
  if (result.complete) return null;
  const parts = [];
  if (result.missing.length > 0) {
    parts.push(`missing section(s): ${result.missing
      .map(id => `"${SECTION_BY_ID[id].heading}"`).join(', ')}`);
  }
  if (result.missingLines.length > 0) {
    parts.push(`missing header line(s): ${result.missingLines.map(line => `"${line}"`).join(', ')}`);
  }
  if (result.outOfOrder.length > 0) parts.push(`out of order: ${result.outOfOrder.join('; ')}`);
  const revisionNote = options.revisionUnverified
    ? `Its ledger revision stamp could NOT be verified (${options.revisionUnverified}), so this verdict is the `
      + 'shape axis alone -- which needs only the digest. The file may ALSO be stale; an unreadable ledger '
      + 'cannot show that either way. '
    : 'Its ledger revision stamp is current, so the revision check cannot see this: the file is fresh in content '
      + 'and a version behind in shape. ';
  return `reports/OPEN-GATES.md was produced by an older renderer than the one in this tree (${parts.join('; ')}). `
    + revisionNote + 'Regenerate it with `node tools/ledger-query.js open --gates --write`.';
}

module.exports = {
  OPEN_GATES_SECTIONS,
  OPEN_GATES_REQUIRED_LINES,
  heading,
  checkDigestSections,
  describeDigestShortfall
};
