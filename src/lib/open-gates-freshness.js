'use strict';

// Shared freshness check for reports/OPEN-GATES.md against the live
// reports/OWNER-REQUEST-LEDGER.json revision.
//
// WHY THIS IS ITS OWN MODULE (2026-08-10). This logic previously lived only
// inline in tools/agent-preflight.js, reachable exclusively by an agent
// remembering to run that tool by hand -- and measured stale in this same
// session (digest stamped revision 730, live ledger at 732) before anyone
// noticed. A second, independent consumer (an advisory .githooks/pre-push
// check, so staleness is also loud at push time rather than only when
// someone thinks to ask) needs the exact same STALE/FRESH/MISSING/UNSTAMPED
// verdict. Two copies of "is the digest stale" is the same defect class one
// level up -- a fork that drifts silently -- so this is the single source
// both callers require().
//
// Deliberately dependency-free and read-only: no writes, no network, no
// require of anything that itself has side effects on load.
//
// TWO AXES, NOT ONE (2026-08-12). The revision stamp answers "was this built
// from the current ledger". It cannot answer "was this built by the current
// renderer". MEASURED that day: tools/ledger-query.js had gained an
// "Authorizations on file" section, reports/OPEN-GATES.md contained 0
// occurrences of it, and this check said FRESH -- correctly, on the only axis
// it had, because the stamped revision equalled the live one. A feature can be
// shipped in code and absent from the published surface with every gate green.
// So a shape check now runs alongside the revision check, against the same
// contract the renderer emits from.
//
// AN UNANSWERABLE AXIS MUST NOT SILENCE AN ANSWERABLE ONE (2026-08-13).
// MEASURED: the same digest, missing the "Authorizations on file" section,
// with a valid ledger reported INCOMPLETE and exit 1 -- and with a
// BOM-prefixed ledger reported INDETERMINATE and exit 0. The INDETERMINATE
// early return sat ABOVE the shape check, so anything that made the ledger
// unparseable turned a failing gate green. The shape axis reads only the
// digest; it never needed the ledger at all. On Windows this is not exotic:
// PowerShell writes a UTF-8 BOM by default and this repo's tooling is full of
// PowerShell, so "someone re-saved the ledger" was a one-keystroke path to a
// green gate over a broken digest.
//
// The rule this file now holds: INDETERMINATE means "THIS SPECIFIC QUESTION
// needed the ledger and could not be answered", never "stop evaluating". Every
// verdict reachable without the ledger is still reached, and the ledger's own
// condition is reported as a separate, structured fact (see LEDGER_STATE) so a
// caller can tell EMPTY from UNREADABLE -- different facts, and only one of
// them is ever normal.
const fs = require('node:fs');
const path = require('node:path');
const { checkDigestSections, describeDigestShortfall } = require('./open-gates-digest-contract');

const DEFAULT_REPO = path.resolve(__dirname, '..', '..');

/**
 * The condition of the live ledger, reported alongside every verdict. This is
 * deliberately NOT folded into `state`: `state` is a verdict about the DIGEST,
 * and "the ledger is empty" is a fact about the LEDGER. Callers (the CLI's
 * exit-code contract, tools/agent-preflight.js) key off `state`; this field is
 * what lets them, and a human, tell an empty ledger from an unreadable one
 * without parsing prose.
 *
 * ABSENT / UNREADABLE / EMPTY / MALFORMED are never normal in this repo and
 * each names a different remedy. NO_REVISION means the JSON parsed and simply
 * carries no numeric `revision`, which is a schema fault, not an I/O fault.
 */
const LEDGER_STATE = Object.freeze({
  OK: 'OK',
  ABSENT: 'ABSENT',
  UNREADABLE: 'UNREADABLE',
  EMPTY: 'EMPTY',
  MALFORMED: 'MALFORMED',
  NO_REVISION: 'NO_REVISION'
});

// Cross-file contract: must accept exactly what tools/ledger-query.js's
// stampLedgerRevision() writes (pinned by tests/agent-preflight.js and by
// tests/open-gates-freshness-check.js). If either side's format drifts, this
// silently reports UNSTAMPED forever -- the same failure this whole check
// exists to prevent, moved one level up.
const STAMP_LINE_RE = /^Ledger revision: (\d+) \(updated ([^)]+)\)$/m;

/**
 * Drop a leading U+FEFF.
 *
 * WHY, ON THIS MACHINE SPECIFICALLY. `JSON.parse('\uFEFF{}')` throws, and
 * PowerShell's Set-Content/Out-File write a UTF-8 BOM by default -- as does
 * every Windows editor that offers "UTF-8 with BOM". A BOM-prefixed but
 * otherwise byte-identical ledger is a valid ledger that one encoder chose to
 * label; treating it as corrupt is a bug in the reader, not a fault in the
 * file, and it is what most JSON tooling already strips. Same reasoning for the
 * digest: a BOM ahead of `Open gates: 0` made the header-line contract check
 * report a missing line that is plainly present (MEASURED 2026-08-13: false
 * INCOMPLETE, "missing header line(s): \"Open gates:\"").
 *
 * This is an ENCODING concern, so it lives at the file-read boundary rather
 * than inside the shape contract -- the renderer side hands checkDigestSections
 * an in-memory string that never has one.
 *
 * It fixes only the encoding case. It deliberately does NOT make an unreadable
 * ledger harmless; that is what the axis separation below is for.
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * Read the live ledger's revision, naming exactly how it failed.
 *
 * @returns {{revision: number|null, ledger: {state: string, detail: string|null}}}
 */
function readLedgerRevision(ledgerPath) {
  const fault = (state, detail) => ({ revision: null, ledger: { state, detail: detail || null } });
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    const code = (error && error.code) || 'READ_FAILED';
    // ENOENT is a different fact from EACCES/EISDIR/EBUSY: "nobody has written
    // it yet" vs "it exists and this process cannot have it".
    if (code === 'ENOENT') return fault(LEDGER_STATE.ABSENT, code);
    return fault(LEDGER_STATE.UNREADABLE, code);
  }
  const text = stripBom(raw);
  // EMPTY before MALFORMED: a zero-byte file is the signature of a truncated
  // or half-finished write, and "not parseable JSON" would describe it in a way
  // that sends the reader looking for a syntax error that does not exist.
  if (text.trim() === '') {
    return fault(LEDGER_STATE.EMPTY,
      raw.length === 0 ? 'zero bytes' : `${raw.length} character(s), all whitespace or BOM`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fault(LEDGER_STATE.MALFORMED, (error && error.message) || 'JSON.parse failed');
  }
  if (!parsed || typeof parsed.revision !== 'number') {
    return fault(LEDGER_STATE.NO_REVISION, 'parsed, but `revision` is not a number');
  }
  return { revision: parsed.revision, ledger: { state: LEDGER_STATE.OK, detail: null } };
}

/** One clause naming why the revision axis could not be evaluated. */
function describeLedgerFault(ledger) {
  const detail = ledger.detail ? ` (${ledger.detail})` : '';
  switch (ledger.state) {
    case LEDGER_STATE.ABSENT: return `the live ledger file does not exist${detail}`;
    case LEDGER_STATE.UNREADABLE: return `the live ledger file exists but could not be read${detail}`;
    case LEDGER_STATE.EMPTY: return `the live ledger file is empty${detail} -- it is not merely unparsed, there is nothing in it`;
    case LEDGER_STATE.MALFORMED: return `the live ledger is not parseable JSON${detail}`;
    case LEDGER_STATE.NO_REVISION: return `the live ledger has no readable \`revision\` field${detail}`;
    default: return `the live ledger revision could not be read${detail}`;
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.ledgerPath] defaults to <repo>/reports/OWNER-REQUEST-LEDGER.json
 * @param {string} [options.digestPath] defaults to <repo>/reports/OPEN-GATES.md
 * @returns {{state: 'FRESH'|'STALE'|'INCOMPLETE'|'MISSING'|'UNREADABLE'|'UNSTAMPED'|'INDETERMINATE', liveRevision: number|null, digestRevision: number|null, message: string|null, sections: {complete: boolean, missing: string[], outOfOrder: string[], missingLines: string[]}|null, ledger: {state: 'OK'|'ABSENT'|'UNREADABLE'|'EMPTY'|'MALFORMED'|'NO_REVISION', detail: string|null}}}
 */
function checkOpenGatesFreshness(options = {}) {
  // reports/ is runtime state: on an install it lives under the per-user state
  // root, not beside the program. Resolved at call time, like every writer.
  const { statePath } = require('./runtime-state-root');
  const ledgerPath = options.ledgerPath || statePath('reports', 'OWNER-REQUEST-LEDGER.json');
  const digestPath = options.digestPath || statePath('reports', 'OPEN-GATES.md');

  const { revision: liveRevision, ledger } = readLedgerRevision(ledgerPath);

  let digestText;
  try {
    digestText = stripBom(fs.readFileSync(digestPath, 'utf8'));
  } catch (error) {
    const code = (error && error.code) || 'READ_FAILED';
    // Only ENOENT establishes absence. EACCES/EISDIR/EBUSY and other read
    // failures establish nothing about the digest's contents, so keep them
    // distinct and fail closed rather than confidently reporting MISSING.
    if (code !== 'ENOENT') {
      return {
        state: 'UNREADABLE', liveRevision, digestRevision: null, sections: null, ledger,
        message: `reports/OPEN-GATES.md could not be read (${code}); its freshness was not measured.`
      };
    }
    return {
      state: 'MISSING', liveRevision, digestRevision: null, sections: null, ledger,
      message: 'reports/OPEN-GATES.md does not exist. Run `node tools/ledger-query.js open --gates --write`.'
    };
  }
  // Computed once, before any early return that carries it, so every verdict
  // below reports the shape it actually saw rather than leaving the field null
  // and letting a caller read that as "checked, and fine".
  const sections = checkDigestSections(digestText);
  const match = digestText.match(STAMP_LINE_RE);
  if (!match) {
    return {
      state: 'UNSTAMPED', liveRevision, digestRevision: null, sections, ledger,
      message: 'reports/OPEN-GATES.md has no ledger-revision stamp (predates R1162 P1) so its freshness cannot be confirmed. Regenerate it with `node tools/ledger-query.js open --gates --write`.'
    };
  }
  const digestRevision = Number(match[1]);

  // ORDER OF THE THREE VERDICTS BELOW IS THE FIX. The ledger-dependent branch
  // used to run first and return, so an unreadable ledger skipped the shape
  // check entirely. Now each verdict is reached exactly when its own inputs are
  // available:
  //   STALE          needs the ledger  -- guarded on liveRevision !== null
  //   INCOMPLETE     needs only the digest -- always reached
  //   INDETERMINATE  is the LAST resort, and only for the revision question
  if (liveRevision !== null && digestRevision !== liveRevision) {
    return {
      state: 'STALE', liveRevision, digestRevision, sections, ledger,
      message: `reports/OPEN-GATES.md is stamped revision ${digestRevision} but the live ledger is at `
        + `revision ${liveRevision} (${liveRevision - digestRevision} revision(s) behind). Directives newer `
        + 'than the digest\'s stamp are invisible to any agent that reads only OPEN-GATES.md. Regenerate it '
        + 'with `node tools/ledger-query.js open --gates --write` before trusting it for SESSION-BOOT.'
    };
  }
  // STALE is reported first when both are true: a digest built from an older
  // ledger is also usually built by an older renderer, and one command fixes
  // both. This branch is what a digest that is current in content and a
  // version behind in shape lands on -- the case that shipped on 2026-08-12
  // with every gate green.
  if (!sections.complete) {
    return {
      state: 'INCOMPLETE', liveRevision, digestRevision, sections, ledger,
      // When the ledger could not be read the shortfall is still real -- but
      // the stock sentence ("its revision stamp is current") would be an
      // unearned claim, so the message says which axis actually ran.
      message: describeDigestShortfall(sections, {
        revisionUnverified: liveRevision === null ? describeLedgerFault(ledger) : null
      })
    };
  }
  if (liveRevision === null) {
    return {
      state: 'INDETERMINATE', liveRevision: null, digestRevision, sections, ledger,
      message: `Digest freshness is unconfirmed on the revision axis only: ${describeLedgerFault(ledger)}. `
        + 'The shape axis does not need the ledger and was evaluated -- the digest matches the current '
        + 'renderer\'s contract -- so nothing checkable was skipped. An unreadable ledger is not evidence '
        + 'the digest is stale, which is why this is not a failure; it is also not a normal state, so fix '
        + 'reports/OWNER-REQUEST-LEDGER.json before relying on this verdict.'
    };
  }
  return { state: 'FRESH', liveRevision, digestRevision, sections, ledger, message: null };
}

module.exports = { checkOpenGatesFreshness, STAMP_LINE_RE, LEDGER_STATE };
