'use strict';

// tools/git-destructive-reflog-check.js
//
// R1162 follow-up (git-safety-guard lane, 2026-08-10): in both real incidents
// that motivated tools/standing-orders-hook.js's GIT-DESTRUCTIVE-DIRTY-TREE
// guard, DIAGNOSIS took longer than recovery. One agent had to diff 38 files
// by hand before concluding an unscoped `git stash` was the cause; another
// only confirmed a bare `git reset` by manually reading `git reflog` after
// the fact. This tool answers the question either of them would have wanted
// asked first: "did a whole-tree destructive git operation run here in the
// last N minutes, and when?" -- one command, not a manual reflog read.
//
// WHAT THIS CAN ACTUALLY SEE, AND WHY -- read this before trusting a clean
// result:
//
//   `git reset` (any flavour: bare, --soft, --mixed, --hard) moves HEAD, so
//   it always leaves a reflog entry on HEAD itself, verified against a real
//   repo: `%gs` is literally "reset: moving to <target>" for every flavour,
//   matching the exact phrase the Case 2 incident report used to confirm its
//   own cause. This is the most reliable signal this tool has.
//
//   `git stash` (push/save -- the operations that create a stash) commit the
//   snapshot onto `refs/stash`, so they leave a reflog entry there, verified
//   the same way. But `git stash pop`/`drop`/`clear` also touch that ref and
//   its reflog, and this tool cannot tell creation apart from removal by the
//   reflog subject alone -- every refs/stash reflog entry in the window is
//   reported as a stash-history event, not specifically "a stash was
//   created". Read the `subject` field before concluding which one happened.
//
//   `git checkout .` / `git restore .` / `git clean` are INVISIBLE to this
//   tool, on purpose of git's own design, not a gap in this script: none of
//   the three ever moves a ref (checkout of a path, restore, and clean all
//   change working-tree/untracked-file CONTENTS only), so git itself keeps
//   no reflog trace of any of them, under any flags, in any repository. A
//   CLEAN result from this tool is not evidence those three didn't run --
//   see the loud caveat this prints on every clean result, always, not only
//   in --json output.
//
// Same conventions as tools/check-single-copy-work.js: three exit codes
// (never a boolean), invocation through src/lib/proc/run.js's runChecked
// (spawnSync, explicit argv, no shell string -- STANDING-ORDERS.md Class
// SYNC, rule 2: never misread a git command's status), and a real,
// distinguished INDETERMINATE result whenever this cannot actually be
// evaluated (no repo at the given root, git missing, timeout) -- never
// silently reported as "clean" instead.

const path = require('node:path');
const { runChecked, RUN_STATUS } = require('../src/lib/proc/run');

const EXIT_CODES = Object.freeze({
  CLEAN: 0,
  FOUND: 1,
  INDETERMINATE: 2
});

const DEFAULT_MINUTES = 60;
const GIT_TIMEOUT_MS = 10_000;
const REFLOG_FORMAT = '%H|%gd|%gs';
// %gd is the reflog SELECTOR; with --date=iso-strict it becomes
// "HEAD@{<iso-timestamp>}" -- the actual time of the reflog EVENT. This is
// NOT the same as %ad/%cd, which report the pointed-at COMMIT's author/
// commit date and stay frozen at the original commit time even for a later
// reset -- verified live: a `git reset` run at 13:00:51 against a commit
// authored at 13:00:12 reports %ad as 13:00:12 (wrong) and %gd's embedded
// date as 13:00:51 (right). Using %ad here would silently misdate every
// finding to the wrong moment.
const CAVEAT_LINES = Object.freeze([
  'This tool can only see git reset (any flavour) and git stash create/pop/drop/clear -- both move a ref.',
  'git checkout ./git restore ./git clean move no ref and leave NO reflog trace under any flags: a clean result here is not proof one of those three did not run.'
]);

function gitReflog(root, ref, timeoutMs) {
  return runChecked('git', ['reflog', 'show', ref, '--date=iso-strict', `--format=${REFLOG_FORMAT}`], {
    cwd: root,
    timeoutMs: timeoutMs ?? GIT_TIMEOUT_MS
  });
}

function parseReflogLines(stdout) {
  const entries = [];
  const rejectedLines = [];
  stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach(line => {
      const parts = line.split('|');
      const sha = parts[0];
      const selector = parts[1] || '';
      const subject = parts.slice(2).join('|');
      const dateMatch = selector.match(/@\{(.+)\}$/);
      const iso = dateMatch ? dateMatch[1] : null;
      const epochMs = iso ? Date.parse(iso) : NaN;
      if (!Number.isFinite(epochMs)) {
        rejectedLines.push(line);
        return;
      }
      entries.push({ sha, selector, subject, iso, epochMs });
    });
  return { entries, rejectedLines };
}

// `git reset` of ANY flavour reports this exact subject shape -- verified
// live for bare, --soft, --mixed, and --hard against the same repo.
const RESET_SUBJECT_RE = /^reset:\s+moving to/i;

function checkHeadReflog(root, sinceMs, timeoutMs) {
  const result = gitReflog(root, 'HEAD', timeoutMs);
  if (result.status !== RUN_STATUS.SUCCESS) {
    return { determined: false, reason: result.reason || `git reflog show HEAD did not succeed (status: ${result.status})`, findings: [] };
  }
  const parsed = parseReflogLines(result.stdout);
  if (parsed.rejectedLines.length > 0) {
    return {
      determined: false,
      reason: `git reflog show HEAD returned ${parsed.rejectedLines.length} line(s) whose event timestamps could not be parsed`,
      findings: []
    };
  }
  const findings = parsed.entries
    .filter(entry => entry.epochMs >= sinceMs && RESET_SUBJECT_RE.test(entry.subject))
    .map(entry => ({ ref: 'HEAD', kind: 'git reset', subject: entry.subject, at: entry.iso, sha: entry.sha }));
  return { determined: true, findings };
}

// refs/stash does not exist until the first stash this repository has ever
// had -- git reports that as a real, ordinary command FAILURE ("unknown
// revision"/"ambiguous argument"), and this is a genuine CLEAN answer ("no
// stash history here"), not a "could not determine" one. Any other failure
// (e.g. no repository at all) stays indeterminate.
const NO_STASH_HISTORY_RE = /unknown revision|ambiguous argument 'refs\/stash'|only has \d+ entries|bad revision 'refs\/stash'/i;

function checkStashReflog(root, sinceMs, timeoutMs) {
  const result = gitReflog(root, 'refs/stash', timeoutMs);
  if (result.status !== RUN_STATUS.SUCCESS) {
    if (NO_STASH_HISTORY_RE.test(`${result.stdout}${result.stderr}`)) {
      return { determined: true, findings: [] };
    }
    return { determined: false, reason: result.reason || `git reflog show refs/stash did not succeed (status: ${result.status})`, findings: [] };
  }
  const parsed = parseReflogLines(result.stdout);
  if (parsed.rejectedLines.length > 0) {
    return {
      determined: false,
      reason: `git reflog show refs/stash returned ${parsed.rejectedLines.length} line(s) whose event timestamps could not be parsed`,
      findings: []
    };
  }
  const findings = parsed.entries
    .filter(entry => entry.epochMs >= sinceMs)
    .map(entry => ({ ref: 'refs/stash', kind: 'git stash (create/pop/drop/clear -- indistinguishable by subject alone)', subject: entry.subject, at: entry.iso, sha: entry.sha }));
  return { determined: true, findings };
}

/**
 * checkDestructiveReflog({ root, minutes, nowMs }) -> {
 *   exitCode, status: 'clean' | 'found' | 'indeterminate',
 *   root, minutes, sinceIso, findings: [{ref, kind, subject, at, sha}],
 *   caveats: [string], reasons: [string] (only when indeterminate),
 *   durationMs
 * }
 */
function checkDestructiveReflog(options = {}) {
  const startedAt = Date.now();
  const invalidOptions = [];
  const optionsAreObject = options !== null && typeof options === 'object' && !Array.isArray(options);
  if (!optionsAreObject) {
    invalidOptions.push('options must be an object');
    options = {};
  }
  const hasRoot = Object.hasOwn(options, 'root');
  const hasMinutes = Object.hasOwn(options, 'minutes');
  const hasNowMs = Object.hasOwn(options, 'nowMs');
  const hasTimeoutMs = Object.hasOwn(options, 'timeoutMs');
  if (hasRoot && (typeof options.root !== 'string' || options.root.length === 0)) {
    invalidOptions.push('root must be a non-empty string when provided');
  }
  if (hasMinutes && (!Number.isFinite(options.minutes) || options.minutes <= 0)) {
    invalidOptions.push('minutes must be a positive finite number when provided');
  }
  if (hasNowMs && !Number.isFinite(options.nowMs)) {
    invalidOptions.push('nowMs must be a finite number when provided');
  }
  if (hasTimeoutMs && options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
    invalidOptions.push('timeoutMs must be a non-negative finite number when provided');
  }

  const root = !hasRoot || invalidOptions.some(reason => reason.startsWith('root '))
    ? process.cwd()
    : path.resolve(options.root);
  const minutes = hasMinutes && Number.isFinite(options.minutes) && options.minutes > 0 ? options.minutes : DEFAULT_MINUTES;
  const nowMs = hasNowMs && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const sinceMs = nowMs - minutes * 60_000;
  const timeoutMs = options.timeoutMs;

  if (invalidOptions.length > 0) {
    return Object.freeze({
      exitCode: EXIT_CODES.INDETERMINATE,
      status: 'indeterminate',
      root,
      minutes,
      sinceIso: new Date(sinceMs).toISOString(),
      findings: Object.freeze([]),
      caveats: CAVEAT_LINES,
      reasons: Object.freeze(invalidOptions),
      durationMs: Date.now() - startedAt
    });
  }

  const head = checkHeadReflog(root, sinceMs, timeoutMs);
  const stash = checkStashReflog(root, sinceMs, timeoutMs);

  const reasons = [];
  if (!head.determined) reasons.push(`HEAD: ${head.reason}`);
  if (!stash.determined) reasons.push(`refs/stash: ${stash.reason}`);

  if (reasons.length > 0) {
    return Object.freeze({
      exitCode: EXIT_CODES.INDETERMINATE,
      status: 'indeterminate',
      root,
      minutes,
      sinceIso: new Date(sinceMs).toISOString(),
      findings: Object.freeze([]),
      caveats: CAVEAT_LINES,
      reasons: Object.freeze(reasons),
      durationMs: Date.now() - startedAt
    });
  }

  const findings = [...head.findings, ...stash.findings].sort((a, b) => (a.at < b.at ? 1 : -1)); // newest first
  return Object.freeze({
    exitCode: findings.length > 0 ? EXIT_CODES.FOUND : EXIT_CODES.CLEAN,
    status: findings.length > 0 ? 'found' : 'clean',
    root,
    minutes,
    sinceIso: new Date(sinceMs).toISOString(),
    findings: Object.freeze(findings),
    caveats: CAVEAT_LINES,
    reasons: Object.freeze([]),
    durationMs: Date.now() - startedAt
  });
}

function formatReport(result) {
  const lines = [];
  if (result.status === 'indeterminate') {
    lines.push(`git-destructive-reflog-check: COULD NOT DETERMINE -- ${result.root} (last ${result.minutes}m, ${result.durationMs}ms)`);
    for (const reason of result.reasons) lines.push(`  - ${reason}`);
  } else if (result.status === 'clean') {
    lines.push(`git-destructive-reflog-check: clean -- no git reset or git stash reflog activity in ${result.root} since ${result.sinceIso} (${result.durationMs}ms)`);
  } else {
    lines.push(`git-destructive-reflog-check: FOUND ${result.findings.length} whole-tree-shaped event(s) in ${result.root} since ${result.sinceIso}`);
    for (const finding of result.findings) {
      lines.push(`  - ${finding.at}  [${finding.ref}] ${finding.kind}: ${finding.subject} (${finding.sha.slice(0, 12)})`);
    }
    lines.push(`  (${result.durationMs}ms)`);
  }
  lines.push('  caveats:');
  for (const caveat of result.caveats) lines.push(`    - ${caveat}`);
  return lines.join('\n');
}

if (require.main === module) {
  const rootFlagIndex = process.argv.indexOf('--root');
  const rootValue = rootFlagIndex >= 0 ? process.argv[rootFlagIndex + 1] : process.cwd();
  const root = rootFlagIndex >= 0 && (rootValue === undefined || rootValue.startsWith('--')) ? null : rootValue;
  const minutesFlagIndex = process.argv.indexOf('--minutes');
  const minutes = minutesFlagIndex >= 0 ? Number(process.argv[minutesFlagIndex + 1]) : DEFAULT_MINUTES;
  const asJson = process.argv.includes('--json');

  const result = checkDestructiveReflog({ root, minutes });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.status === 'indeterminate') {
    process.stderr.write(`${formatReport(result)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  process.exitCode = result.exitCode;
}

module.exports = { checkDestructiveReflog, formatReport, EXIT_CODES, CAVEAT_LINES };
