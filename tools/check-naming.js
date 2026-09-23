#!/usr/bin/env node
'use strict';

// Naming-convention ratchet. See docs/NAMING-CONVENTIONS.md for what the conventions
// are and, more importantly, for the list of names that are INTERFACES and must never
// be renamed at all.
//
// WHY A RATCHET AND NOT A LINTER. A check that fails on day one against 723 pre-existing
// files is a check somebody switches off within the week, and then it protects nothing.
// This one records today's state as a baseline, fails when a new violation appears, and
// tells you to re-pin when drift is fixed (so the improvement is locked in deliberately
// rather than silently absorbed).
//
// It deliberately does NOT demand that existing drift be fixed. Stopping the bleeding is
// worth more than a mass rename, and mass renames here are dangerous: the `.test.js`
// suffix is read by tools/test-census.js as a classification signal, and 723 test paths
// are enumerated by name across dozens of npm scripts and run.js manifests.
//
// BY NAME, NEVER BY COUNT (2026-08-25)
// ------------------------------------
// Every rule below used to produce a NUMBER, and the baseline pinned that number. A
// number cannot see a swap. Measured in this tree on 2026-08-25, against the committed
// baseline of the day:
//
//   * src/lib/coordinator-audit-events.js line 332 hashes with the domain
//     'coordinator.audit.capability-profile.v1'. Renaming it to
//     'coordinator.audit.capability-dossier.v1' -- which changes every capability-profile
//     hash this repo has ever persisted -- left the count at 113 and the gate printed
//     "naming ratchet OK", exit 0. The rule NAMED AFTER that exact event did not fire.
//   * Worse, the pinned floor was 99 while the tree measured 113, so the gate carried a
//     14-name cushion. DELETING the domain outright (113 -> 112) also exited 0, and the
//     gate reported the deletion as "new domains added". A gate that describes a removal
//     as an addition is not merely quiet; it is arguing for the wrong conclusion.
//
// The same blindness applied to the other two rules: a new camelCase file added in the
// same commit that fixed an old one kept the count equal and passed.
//
// So the baseline records WHICH names exist, not how many. A rename is then what it
// actually is -- one name removed and one name added -- and both are printed. This is
// the same decision tools/check-chain-runner.js made ("By step ID, never by count: a
// count lets a newly broken step hide behind a newly fixed one") and that
// tools/test-ratchet.mjs made after it. This file was the last count-pinned gate.
//
// ABSENCE IS NOT CONSENT. Every missing or unreadable record means REFUSE, never
// "tolerate" and never "re-seed from whatever the tree is right now" -- re-seeding lets
// a run ratify itself as the standard it was about to be judged against. Writing the
// baseline is always a separate, deliberate flag. See tests/capability-recall-eval.js,
// which had this same defect removed the same day.
//
// Usage:
//   node tools/check-naming.js                     check against the baseline
//   node tools/check-naming.js --update-baseline   re-pin (refuses while anything regressed)
//   node tools/check-naming.js --seed-baseline     establish a baseline where none is readable
//   node tools/check-naming.js --baseline <path>   rule against a different record (a FLAG,
//                                                  so a reviewer sees the substitution)

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASELINE_PATH = path.join(ROOT, 'config', 'naming-baseline.json');

const EXIT_OK = 0;
const EXIT_RATCHET = 1;
// Distinct from EXIT_RATCHET on purpose, and borrowed from check-chain-runner: "I could
// not read my own record" must never be reported with the same byte as "I read it and
// the tree was fine", and must never be 0.
const EXIT_UNTRUSTED = 2;

// Tracked files PLUS untracked-but-not-ignored ones.
//
// `git ls-files` alone lists only what is already committed, which means a brand new
// badly-named file is invisible to this check until AFTER it lands -- precisely the
// moment the check is least useful. Measured: a camelCase probe file dropped into
// src/lib/ was not counted at all until it was staged. Including `--others
// --exclude-standard` catches it while it can still be renamed for free, and respects
// .gitignore so generated output and node_modules stay out.
function trackedFiles() {
  const tracked = execSync('git ls-files', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1e8,
    env: safeLaunchEnvironment(process.env, { context: 'check naming tracked files' })
  });
  const untracked = execSync('git ls-files --others --exclude-standard', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1e8,
    env: safeLaunchEnvironment(process.env, { context: 'check naming untracked files' })
  });
  return [...tracked.split('\n'), ...untracked.split('\n')]
    .map(line => line.trim()).filter(Boolean)
    .filter(file => !isVendoredDependency(file));
}

// Vendored third-party trees are OUR files by git's reckoning and NOT ours by any
// other. `provider-runtimes/gemini-quota/node_modules` is committed on purpose -- 698
// tracked files -- so `git ls-files` lists it, and `git ls-files` does not consult
// .gitignore. (The comment above is true only of the --others --exclude-standard call.)
// Measured at engine e2d443c5: without this filter the ratchet reported 53 violations,
// 53 of 53 inside that vendored tree and 0 in engine source, which would refuse every
// cut for names upstream chose. We do not rename other people's packages, so they are
// not candidates for this check at all.
function isVendoredDependency(file) {
  return file.split('/').includes('node_modules');
}

// Each rule NAMES what it finds. A rule must be cheap and unambiguous: a rule that needs
// judgement produces arguments instead of fixes.
//
// `polarity` says what the named set means, and therefore which direction is the failure:
//
//   'violations'  the names are things that are WRONG. A name APPEARING is the
//                 regression; a name leaving is drift fixed, and must be re-pinned.
//   'identities'  the names are things that MUST CONTINUE TO EXIST. A name LEAVING is
//                 the regression; a name appearing is a new identity, and must be
//                 re-pinned so that it too is protected from then on.
//
// Both directions block. An improvement that does not have to be recorded is an
// improvement the ratchet forgets, and a name that was never recorded can be deleted
// tomorrow for free -- which is exactly the 14-name cushion measured above.
const RULES = [
  {
    id: 'source-basename-not-kebab',
    polarity: 'violations',
    describe: 'source file basenames must be kebab-case',
    names(files) {
      return files.filter(file => {
        if (!/\.(js|mjs|cjs)$/.test(file)) return false;
        // Strip the extension and any single meaningful suffix (.test, .schema, .types).
        const base = path.basename(file).replace(/\.(js|mjs|cjs)$/, '').replace(/\.(test|schema|types|d)$/, '');
        // A dotted remainder is a package-tree name (kernel.state) and is legitimate.
        if (base.includes('.')) return false;
        return !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(base);
      });
    }
  },
  {
    id: 'test-dir-singular',
    polarity: 'violations',
    describe: 'test directories should be tests/ (plural); packages/internal-vcs/test is a known exception',
    names(files) {
      return files.filter(file => /(^|\/)test\//.test(file) && !file.startsWith('packages/internal-vcs/'));
    }
  },
  {
    id: 'interface-name-renamed',
    polarity: 'identities',
    describe: 'INTERFACE NAMES must not disappear: the coordinator.* hash domains are persisted identity',
    // These literals are hash-domain prefixes. Renaming one silently invalidates every
    // stored capability profile and authorization derived from it -- and because the old
    // name simply stops appearing while the new one starts, only a by-name record can
    // tell that apart from an ordinary edit. The detector is unchanged from the
    // count-pinned version on purpose: the comparison is what was broken, not the match.
    names(files) {
      const found = new Set();
      for (const file of files) {
        if (!/^src\/.*\.js$/.test(file)) continue;
        /* NAMES, NOT A COUNT -- a count is invariant under a rename, which is how
           the rule named for renames passed on one. And an UNREADABLE file still
           throws: skipping it silently would report "no such name here" about a
           file nobody managed to read, which is the same could-not-look collapse
           this ratchet exists to catch in the tree it measures. */
        let text;
        try {
          text = fs.readFileSync(path.join(ROOT, file), 'utf8');
        } catch (error) {
          throw new Error(`could not measure interface names in ${file}`, { cause: error });
        }
        for (const literal of text.match(/'coordinator.[a-z0-9.-]+'/g) || []) {
          // Store the domain itself, not the quoted source token.
          found.add(literal.slice(1, -1));
        }
      }
      return [...found];
    }
  }
];

const RULES_BY_ID = new Map(RULES.map(rule => [rule.id, rule]));

/** Measure the tree: rule id -> sorted, de-duplicated array of names. */
function measure(files = trackedFiles()) {
  /* THE EMPTY-ENUMERATION REFUSAL IS KEPT. With zero files every rule returns an
     empty set and the ratchet passes having measured nothing -- a green built out
     of a git invocation that answered nothing, which is the most expensive kind
     of pass this repository has. */
  if (files.length === 0) {
    throw new Error('REFUSING naming check: git reported zero tracked or untracked files');
  }
  const measured = {};
  for (const rule of RULES) {
    measured[rule.id] = [...new Set(rule.names(files))].sort((left, right) => left.localeCompare(right, 'en'));
  }
  return measured;
}

/**
 * Read the baseline, refusing anything this gate cannot trust.
 *
 * Returns { present, legacy, names, problems }. `problems` is non-empty only for a file
 * that EXISTS and cannot be believed; an untrustworthy baseline is a refusal (exit 2),
 * never a quiet fallback, because silently ignoring a corrupted record hides the
 * corruption for exactly as long as the tree happens to be clean.
 *
 * `legacy:true` is the narrow, recognisable case of a pre-2026-08-25 count-pinned file.
 * It is kept distinct from "malformed" because the two want opposite handling: a legacy
 * record can be migrated with --seed-baseline, whereas a corrupted one must be restored
 * from git rather than written over.
 */
function readBaseline(baselinePath, displayPath = baselinePath) {
  const empty = { present: false, legacy: false, names: {}, document: null, problems: [], path: baselinePath };
  if (!fs.existsSync(baselinePath)) return empty;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    return { ...empty, problems: [`${displayPath} is not valid JSON: ${error.message}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...empty, problems: [`${displayPath} is not a JSON object`] };
  }
  if (parsed.names === undefined) {
    if (parsed.counts !== undefined) {
      return {
        ...empty,
        legacy: true,
        document: parsed,
        problems: [
          `${displayPath} is in the old count-pinned format (a "counts" object and no "names").`,
          '  A count cannot see a rename: it reports one name removed and one added as no change at all.',
          '  Re-establish it deliberately with:  node tools/check-naming.js --seed-baseline'
        ]
      };
    }
    return { ...empty, problems: [`${displayPath} has no "names" object`] };
  }
  if (!parsed.names || typeof parsed.names !== 'object' || Array.isArray(parsed.names)) {
    return { ...empty, problems: [`${displayPath} has a "names" field that is not an object`] };
  }

  const problems = [];
  const names = {};
  for (const [ruleId, listed] of Object.entries(parsed.names)) {
    const where = `${displayPath} rule "${ruleId}"`;
    if (!Array.isArray(listed)) {
      problems.push(`${where} is not an array of names`);
      continue;
    }
    const seen = new Set();
    let usable = true;
    for (const [index, name] of listed.entries()) {
      if (typeof name !== 'string' || name.trim() === '') {
        // An entry that is not a usable name cannot match anything in the tree, and must
        // not be shrugged off: a reader would see N protected identities in the file and
        // a gate that actually protects N-1.
        problems.push(`${where} entry ${index + 1} is not a non-empty string`);
        usable = false;
        continue;
      }
      if (seen.has(name)) {
        problems.push(`${where} lists "${name}" twice`);
        usable = false;
        continue;
      }
      seen.add(name);
    }
    if (usable) names[ruleId] = seen;
  }

  return { present: true, legacy: false, names, document: parsed, problems, path: baselinePath };
}

/**
 * Rule on a measured tree against a baseline. Pure: no I/O, so the verdict is testable
 * without a tree that has been deliberately broken.
 */
function rate({ measured, baseline }) {
  const lines = [];
  const regressions = [];
  const repins = [];
  const notes = [];

  if (baseline.problems.length > 0) {
    lines.push('NAMING RATCHET: the baseline cannot be trusted, so this tree was not ruled on.');
    for (const problem of baseline.problems) lines.push(`  - ${problem}`);
    lines.push('  A gate that cannot read its own record must not pass anything.');
    return { code: EXIT_UNTRUSTED, lines, regressions, repins, notes };
  }

  for (const rule of RULES) {
    const now = new Set(measured[rule.id]);
    const then = baseline.names[rule.id];
    if (then === undefined) {
      // Absence is not consent. A rule with no record is a rule nobody pinned, and
      // treating that as "nothing to compare, therefore fine" is how a gate goes quiet.
      regressions.push(`${rule.id}: not in the baseline at all (${now.size} name(s) measured). Record it deliberately with --seed-baseline.`);
      continue;
    }
    const added = [...now].filter(name => !then.has(name)).sort((a, b) => a.localeCompare(b, 'en'));
    const removed = [...then].filter(name => !now.has(name)).sort((a, b) => a.localeCompare(b, 'en'));

    if (rule.polarity === 'identities') {
      // A rename shows up here as BOTH halves, and the removed half is the failure.
      for (const name of removed) {
        regressions.push(`${rule.id}: '${name}' NO LONGER EXISTS in the tree. ${rule.describe}`);
      }
      if (removed.length > 0 && added.length > 0) {
        // Say the word. The old count-pinned gate could not distinguish this shape from
        // no change at all, so the one thing the report must not do is leave the reader
        // to notice for themselves that the two lists are the two halves of one edit.
        notes.push(`${rule.id}: ${removed.length} name(s) left and ${added.length} arrived in the same change -- that shape is a RENAME, not a removal plus an unrelated addition.`);
        notes.push(`  gone:    ${removed.map(name => `'${name}'`).join(', ')}`);
        notes.push(`  arrived: ${added.map(name => `'${name}'`).join(', ')}`);
      }
      for (const name of added) {
        repins.push(`${rule.id}: '${name}' is new. Re-pin so it is protected from now on.`);
      }
      continue;
    }

    for (const name of added) {
      regressions.push(`${rule.id}: '${name}' is a new violation. ${rule.describe}`);
    }
    for (const name of removed) {
      repins.push(`${rule.id}: '${name}' no longer violates. Re-pin so the fix is locked in.`);
    }
  }

  // A baselined rule id that matches no rule is immunity granted to nothing -- until
  // somebody adds a rule with that id back, at which point it is immunity granted
  // invisibly. check-chain-runner blocks on the same shape for the same reason.
  const stale = Object.keys(baseline.names).filter(id => !RULES_BY_ID.has(id));
  for (const id of stale) {
    regressions.push(`baseline lists rule "${id}", which is not a rule of this gate. The rule was renamed or removed; delete the entry so it cannot silently re-arm.`);
  }

  let code = EXIT_OK;
  if (regressions.length > 0) {
    lines.push('NAMING REGRESSION:');
    for (const line of regressions) lines.push(`  ${line}`);
    for (const line of notes) lines.push(`  ${line}`);
    lines.push('');
    lines.push('See docs/NAMING-CONVENTIONS.md. Fix the name rather than re-pinning the baseline.');
    code = EXIT_RATCHET;
  }
  if (repins.length > 0) {
    lines.push('');
    lines.push('NAMING BASELINE IS BEHIND THE TREE:');
    for (const line of repins) lines.push(`  ${line}`);
    if (regressions.length === 0) for (const line of notes) lines.push(`  ${line}`);
    lines.push('');
    lines.push('Not a defect on its own, but the record must keep up or the ratchet stops');
    lines.push('ratcheting: a name that was never written down can be deleted tomorrow for free.');
    lines.push('  node tools/check-naming.js --update-baseline');
    code = code === EXIT_OK ? EXIT_RATCHET : code;
  }
  if (code === EXIT_OK) lines.push('naming ratchet OK');

  return { code, lines, regressions, repins, notes };
}

function writeBaseline(baselinePath, measured, previous) {
  const document = (previous && typeof previous === 'object' && !Array.isArray(previous)) ? { ...previous } : {};
  delete document.counts; // the old format's field; leaving it would invite reading the wrong one
  document.comment = [
    'Naming-convention ratchet, BY NAME rather than by count.',
    'A count cannot see a rename: remove one identifier and add another in the same change',
    'and the number is unmoved. So this file lists WHICH names exist.',
    'interface-name-renamed lists the coordinator.* hash domains, which are PERSISTED IDENTITY:',
    'a name disappearing from that list is a failure, never an improvement, because it',
    'silently invalidates every stored capability profile and authorization.',
    'Never edit this file to make a red gate go green.'
  ];
  document.recordedAt = new Date().toISOString().slice(0, 10);
  document.names = {};
  for (const rule of RULES) document.names[rule.id] = measured[rule.id];
  fs.writeFileSync(baselinePath, `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

/** Is this path something git is tracking? When git cannot answer, say yes and refuse. */
function isTracked(filePath) {
  try {
    const relative = path.relative(ROOT, filePath).split(path.sep).join('/');
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    return execSync(`git ls-files -- "${relative}"`, {
      cwd: ROOT,
      encoding: 'utf8',
      env: safeLaunchEnvironment(process.env, { context: 'check naming baseline' })
    }).trim().length > 0;
  } catch {
    return true; // when git cannot answer, refuse rather than re-pin
  }
}

function main(argv) {
  const args = argv.slice(2);
  // `--update` is kept as an alias: it is the flag this file has documented since it was
  // written, and removing it would turn a working habit into a silent no-op.
  const update = args.includes('--update-baseline') || args.includes('--update');
  const seed = args.includes('--seed-baseline');
  const baselineFlag = args.indexOf('--baseline');
  // A FLAG, deliberately not an environment variable: this gate is neutered by pointing
  // it at a record that already lists everything, so the substitution has to be visible
  // on the command line a reviewer reads.
  const baselinePath = baselineFlag >= 0 && args[baselineFlag + 1]
    ? path.resolve(ROOT, args[baselineFlag + 1])
    : DEFAULT_BASELINE_PATH;

  if (update && seed) {
    // --update-baseline asks "record today's state, having checked nothing regressed";
    // --seed-baseline says "there is no state to check against". Answering both at once
    // would let a regression be recorded as though it had been reviewed.
    process.stderr.write('--update-baseline and --seed-baseline are mutually exclusive\n');
    return EXIT_UNTRUSTED;
  }

  const measured = measure();
  for (const rule of RULES) {
    process.stdout.write(`  ${String(measured[rule.id].length).padStart(5)}  ${rule.id}\n`);
  }

  const relative = path.relative(ROOT, baselinePath).split(path.sep).join('/');
  const shown = (!relative || relative.startsWith('..')) ? baselinePath : relative;
  const baseline = readBaseline(baselinePath, shown);

  if (!baseline.present && baseline.problems.length === 0) {
    // MISSING. This used to write the file and exit 0 whenever git said the path was not
    // tracked -- which re-pins every rule to whatever the tree currently is, including
    // the identity list whose entire job is to refuse a disappearance. A vanished record
    // must never read as green, and must never be replaced by the run being judged.
    if (seed) {
      writeBaseline(baselinePath, measured, null);
      process.stdout.write(`\nNAMING BASELINE SEEDED DELIBERATELY from this tree -> ${shown}\n`);
      for (const rule of RULES) {
        process.stdout.write(`  ${rule.id}: ${measured[rule.id].length} name(s) recorded\n`);
      }
      process.stdout.write('Commit that file, and read the list before you do.\n');
      return EXIT_OK;
    }
    process.stdout.write(`\nNAMING BASELINE MISSING: ${shown} is absent from disk.\n`);
    if (isTracked(baselinePath)) {
      process.stdout.write('It is tracked by git, so its absence means it was deleted, not that this is a first run.\n');
      process.stdout.write('REFUSING to re-pin from the current tree. Restore it first:\n');
      process.stdout.write(`  git checkout -- ${shown}\n`);
    } else {
      process.stdout.write('REFUSING to seed it from the run it would then be judging.\n');
      process.stdout.write('If there is genuinely no record yet, establish one deliberately:\n');
      process.stdout.write('  node tools/check-naming.js --seed-baseline\n');
    }
    return EXIT_RATCHET;
  }

  if (baseline.problems.length > 0) {
    // A legacy count-pinned record is the one unreadable state that may be migrated,
    // because it is a format this gate deliberately retired rather than a file somebody
    // corrupted. Anything else must be restored from git, not written over.
    if (seed && baseline.legacy) {
      writeBaseline(baselinePath, measured, baseline.document);
      process.stdout.write(`\nNAMING BASELINE MIGRATED from counts to names -> ${shown}\n`);
      for (const rule of RULES) {
        process.stdout.write(`  ${rule.id}: ${measured[rule.id].length} name(s) recorded\n`);
      }
      process.stdout.write('Commit that file, and read the list before you do.\n');
      return EXIT_OK;
    }
    if (seed) {
      process.stdout.write(`\nREFUSING to seed over ${shown}: it exists but cannot be read.\n`);
      process.stdout.write('An unreadable record is not a missing one. Restore it from git instead.\n');
    }
    const verdict = rate({ measured, baseline });
    process.stdout.write('\n');
    for (const line of verdict.lines) process.stdout.write(`${line}\n`);
    return EXIT_UNTRUSTED;
  }

  if (seed) {
    // Refusing here is the whole point of the flag being separate: --seed-baseline exists
    // to establish a record where none can be read, never to replace one that can.
    process.stdout.write(`\nREFUSING to seed: ${shown} already exists and is readable.\n`);
    process.stdout.write('Use --update-baseline, which checks that nothing regressed before it writes.\n');
    return EXIT_RATCHET;
  }

  const verdict = rate({ measured, baseline });

  if (update) {
    if (verdict.regressions.length > 0) {
      process.stdout.write('\nREFUSING to re-pin while something has regressed:\n');
      for (const line of verdict.regressions) process.stdout.write(`  ${line}\n`);
      return EXIT_RATCHET;
    }
    writeBaseline(baselinePath, measured, baseline.document);
    process.stdout.write(`\nbaseline re-pinned -> ${shown}\n`);
    for (const line of verdict.repins) process.stdout.write(`  ${line}\n`);
    return EXIT_OK;
  }

  process.stdout.write('\n');
  for (const line of verdict.lines) process.stdout.write(`${line}\n`);
  return verdict.code;
}

module.exports = {
  RULES,
  measure,
  readBaseline,
  rate,
  writeBaseline,
  EXIT_OK,
  EXIT_RATCHET,
  EXIT_UNTRUSTED,
  DEFAULT_BASELINE_PATH
};

if (require.main === module) {
  process.exitCode = main(process.argv);
}
