#!/usr/bin/env node
'use strict';

// DEVELOPER CERTIFICATE OF ORIGIN GATE.
//
// WHAT THIS PROTECTS, and why it exists at all.
//
// On 2026-08-12 this project relicensed from AGPL-3.0-or-later to MIT. That was
// only possible because one person holds copyright in every line: the owner is
// the sole contributor, so there was nobody to ask. Relicensing is the rarest
// thing a published project can do -- most cannot, because the moment code
// arrives from someone who never stated their terms, the project owns work whose
// provenance it cannot state, and no policy written afterwards can fix it.
//
// So this gate has exactly one job: make sure the project can always say, of
// every commit, that its author asserted the right to submit it. That assertion
// is the `Signed-off-by` trailer and the Developer Certificate of Origin 1.1
// that CONTRIBUTING.md reproduces in full.
//
// WHY A DCO RATHER THAN A CLA. Under the AGPL the business model was
// dual-licensing, which genuinely required holding all the copyright -- hence a
// CLA. Under MIT it does not: what is sold is operating a server, not the code,
// and MIT already permits sublicensing of inbound contributions. The reasoning
// is set out in full in CONTRIBUTING.md; this file only enforces the result.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not touch .githooks/commit-msg.
// That hook is live on this machine via core.hooksPath and blocks every commit
// from every agent seat; bolting a sign-off requirement onto it would break
// concurrent sessions the moment it landed, to enforce a rule aimed at outside
// contributors who do not commit through it. The teeth for outside code are
// .github/workflows/dco.yml, which runs on pull requests -- the actual moment
// the risk arrives.
//
//   node tools/check-dco.js            # this branch vs origin/main
//   node tools/check-dco.js <range>    # any git revision range

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Commits authored before the policy was adopted are grandfathered. The entire
// history predates it, and rewriting that history to insert sign-offs nobody
// actually gave would be a worse record than the honest one: a sign-off is a
// statement by a person, and manufacturing it retroactively is a forgery of
// exactly the assertion this gate exists to collect.
//
// The cutoff is the day AFTER the policy landed (it landed 2026-08-12), not the
// day of. Measured when this gate was first run: 60 commits authored on 2026-08-12
// itself, all the copyright holder's own, all predating the CONTRIBUTING.md that
// asks for a sign-off. Failing them would have meant demanding a certificate
// nobody could have known to give -- and a gate that is red on arrival for
// reasons nobody can fix is a gate that gets deleted before it ever catches
// anything.
//
// Nothing is lost by starting here. The sole copyright holder signing off to
// himself certifies nothing he is not already asserting by owning the work; the
// assertion only becomes load-bearing when the author and the copyright holder
// are different people, which is precisely what this cutoff still catches.
const ADOPTED = Date.parse('2026-08-13T00:00:00Z');

const UNIT = '\x1f';

function git(args) {
  // windowsHide: this gate is run by agents on the owner's desktop, and every
  // git call without it flashes a console window (owner directive R193, the
  // quiet-desktop rule). tests/spawn-hygiene.test.js enforces this on every
  // spawn-shaped call site under tools/.
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true, env: require('../src/lib/providers/subscription-launch-env').safeLaunchEnvironment(process.env, { context: 'dco check git' }) });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function revExists(rev) {
  const result = git(['rev-parse', '--verify', '--quiet', rev]);
  if (result.status === 0) return true;
  // rev-parse uses status 1 for a revision that does not exist. Any other
  // result means Git itself could not answer, so do not silently treat an
  // unavailable repository (or a killed process) as an absent base branch.
  if (result.status === 1) return false;
  const detail = result.stderr.trim();
  throw new Error(
    `DCO GATE: cannot determine whether revision "${rev}" exists` +
      (detail ? `\n${detail}` : '')
  );
}

function defaultRange() {
  // Prefer the merge base with the integration branch: on a feature branch that
  // is exactly "the commits this change proposes to add", which is the set a
  // reviewer is being asked to accept.
  for (const base of ['origin/main', 'main']) {
    if (revExists(base)) return `${base}..HEAD`;
  }
  // No integration branch to compare against. Checking the whole history would
  // be honest but useless -- every commit predates ADOPTED and is grandfathered.
  return 'HEAD';
}

function main() {
  const range = process.argv[2] || defaultRange();

  // --no-merges: merge commits are generated by git, not written by a person,
  // so there is no author to certify anything.
  const log = git(['log', '--no-merges', '-z', `--format=%H${UNIT}%aI${UNIT}%an${UNIT}%ae${UNIT}%B`, range]);
  // A BROKEN OBJECT GRAPH IS NOT A DCO FAILURE, AND MUST NOT BE REPORTED AS ONE.
  //
  // MEASURED 2026-09-26 on the 1.0.48 lane: commit 2cb37e32 names a parent
  // (6881ec57) that is absent from every local clone and is published nowhere, so
  // `git log HEAD` writes 61 records and then dies with "Failed to traverse
  // parents". This gate discarded that stdout and exited 1 under the heading
  // "cannot read git history" -- which in a build log sits beside DCO FAIL and
  // reads as a commit missing its sign-off. It is not: it is a damaged repository,
  // and the two want opposite responses from whoever reads the log.
  //
  // So: the records git DID emit are checked, and a truncated walk exits 3 -- not
  // 0, because a guard must never certify commits it could not read, and not 1,
  // because nothing here says a contributor failed to sign off. The commit the walk
  // stopped at and the object it wanted are both named, which is what somebody
  // needs to go and recover it.
  const missingObject = /(?:Could not read|Failed to traverse parents of commit|bad object)\s*([0-9a-f]{7,40})?/i;
  let truncated = null;
  if (log.status !== 0) {
    const stderr = log.stderr.trim();
    const match = missingObject.exec(stderr);
    if (!match || !log.stdout) {
      console.error(`DCO GATE: cannot read git history for range "${range}"`);
      console.error(stderr);
      process.exit(1);
    }
    truncated = { stderr, object: match[1] || null };
  }

  const records = log.stdout.split('\0').filter((entry) => entry.trim().length > 0);
  if (records.length === 0) {
    console.error(
      `DCO GATE: cannot establish compliance because range "${range}" contains no commits`
    );
    process.exit(1);
  }

  const failures = [];
  let checked = 0;
  let grandfathered = 0;

  for (const record of records) {
    const [sha, authoredAt, authorName, authorEmail, ...rest] = record.split(UNIT);
    const body = rest.join(UNIT);
    // A successful `git log` with an incomplete record is not an empty or
    // harmless result: skipping it would let the final counts and PASS omit a
    // commit whose DCO status was never established.
    if (!sha || !authoredAt || !authorName || !authorEmail || rest.length === 0) {
      console.error(`DCO GATE: cannot parse git history record for range "${range}"`);
      process.exit(1);
    }

    const authoredTimestamp = Date.parse(authoredAt);
    if (!Number.isFinite(authoredTimestamp)) {
      console.error(
        `DCO GATE: cannot parse author date "${authoredAt}" for commit ${sha}`
      );
      process.exit(1);
    }

    if (authoredTimestamp < ADOPTED) {
      grandfathered += 1;
      continue;
    }
    checked += 1;

    const signoffs = [];
    for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
      const match = /^\s*Signed-off-by:\s*(.+?)\s*<([^>]+)>\s*$/i.exec(line);
      if (match) signoffs.push({ name: match[1], email: match[2] });
    }

    if (signoffs.length === 0) {
      failures.push(
        `${sha.slice(0, 8)} ${authorName}: no Signed-off-by trailer.\n` +
          '      Fix with: git commit --amend -s   (or `git rebase --signoff` for a range)'
      );
      continue;
    }

    // The sign-off has to be the AUTHOR's. A trailer naming somebody else is not
    // that person certifying anything -- it is this author asserting a
    // certification on their behalf, which is the one thing the DCO cannot mean.
    const authored = signoffs.some(
      (entry) => entry.email.toLowerCase() === String(authorEmail).toLowerCase()
    );
    if (!authored) {
      failures.push(
        `${sha.slice(0, 8)} ${authorName}: signed off by <${signoffs
          .map((entry) => entry.email)
          .join('>, <')}>, but authored by <${authorEmail}>.\n` +
          '      The certificate is a statement by the person who wrote the change;\n' +
          '      it has to carry that person\'s own name and address.'
      );
    }
  }

  if (failures.length) {
    console.error(`\nDCO GATE: FAIL (${failures.length}) -- range: ${range}\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      '\nEvery commit must carry the contributor\'s certification that they have the\n' +
        'right to submit it. See CONTRIBUTING.md for the full Developer Certificate\n' +
        'of Origin 1.1 and what signing off commits you to.\n'
    );
    process.exit(1);
  }

  if (truncated) {
    console.error(
      `\nDCO GATE: NOT MEASURED -- range: ${range} (${checked} checked and clean, ` +
        `${grandfathered} grandfathered as pre-${new Date(ADOPTED).toISOString().slice(0, 10)})\n`
    );
    console.error(
      'Every commit this gate could read carries its sign-off. It could not read all of\n' +
        'them: the walk stopped partway because this repository is missing an object.\n'
    );
    console.error(`  ${truncated.stderr}\n`);
    if (truncated.object) {
      console.error(
        `The missing object is ${truncated.object}. Recover it from whichever clone still\n` +
          'has it and re-run. If it is gone everywhere, the provenance of the commits below\n' +
          'the break cannot be established from this repository, and that is the owner\'s\n' +
          'decision to make -- not something this gate can assume either way.\n'
      );
    }
    console.error(
      'This is exit 3. It is not a PASS, because a guard does not certify what it could\n' +
        'not read, and it is not a DCO FAIL, because no contributor here failed to sign off.\n'
    );
    process.exit(3);
  }

  console.log(
    `DCO GATE: PASS -- range: ${range} (${checked} checked, ` +
      `${grandfathered} grandfathered as pre-${new Date(ADOPTED).toISOString().slice(0, 10)})`
  );
}

main();
