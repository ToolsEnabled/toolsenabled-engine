// EXECUTABLE CHANGE
//
// Discrimination report (2026-08-26):
// - VACUOUS COLLECTIONS: strengthened each loop census with an explicit
//   non-empty assertion. Mutating LICENCE_DOCS to `[]` made this test RED:
//   `AssertionError [ERR_ASSERTION]: licence document census must not be empty`.
//   Mutating PROSE_DOCS to `[]` made it RED:
//   `AssertionError [ERR_ASSERTION]: licence prose document census must not be empty`.
//   Mutating STALE_CLAIM_DOCS to `[]` made it RED:
//   `AssertionError [ERR_ASSERTION]: stale-claim document census must not be empty`.
// - PROCESS EVIDENCE: the third-party generator's zero exit status was not by
//   itself evidence that its check path ran. Mutating the generator to exit 0
//   before loading its implementation stayed GREEN before this change. With
//   the assertion below it is RED:
//   `THIRD-PARTY-LICENSES.md check did not report its own success marker.`
// - NOT-FOUND: no assertion expects a non-zero exit or a merely truthy process
//   result; no try/catch or optional chain swallows an asserted failure; no
//   subject is replaced by a mock; and no expected product value is computed
//   by the same product code it checks.
// - PRECONDITION: no interface-half checkout exists at either configured
//   candidate in this environment, so the counterpart comparison could not be
//   mutation-tested. The test reports that condition as a warning, not a pass.
// - RESTORATION: every temporary mutation was restored byte-for-byte. Final
//   run: `🎉 Source-licence drift tests passed successfully!`

'use strict';

// SOURCE-LICENSE DRIFT GATE.
//
// NOT ABOUT PRODUCT LICENCE KEYS. `tests/license-provider.js` and
// `tests/license-trust-pinning.test.js` cover entitlements -- what a paying
// customer is allowed to run. This file covers the opposite direction: the
// copyright licence this SOURCE is published under. The word collides; the
// subjects do not.
//
// WHAT WENT WRONG, and why a test rather than a checklist item.
//
// ToolsEnabled is built as two halves in two separate git repositories: this
// one (the runtime and the MCP capability layer) and the desktop interface. The
// interface half was relicensed -- AGPL-3.0-or-later declared, LICENSE, NOTICE,
// THIRD-PARTY-LICENSES.md and COMMERCIAL-LICENSE.md all shipped -- and this
// half was left declaring `"license": "UNLICENSED"` with no LICENSE file at
// all. For as long as that lasted, the same product asserted two incompatible
// things about itself, and the half that said "all rights reserved" was the
// half that actually holds the engine.
//
// Nobody chose that. It is what happens when one fact is written down in two
// places and only one of them has a reason to be edited. So the fact is pinned
// here, once, and asserted against every copy of it that exists.
//
// WHAT THIS GATE DOES NOT DO. It does not decide the licence. The position was
// settled elsewhere and this file only enforces it:
//
//   - The owner's directive of 2026-08-12: relicense both halves from
//     AGPL-3.0-or-later to MIT ("lets launch MIT license priority first").
//     This superseded the earlier ruling in
//     docs/coordinator/R1162-MONETIZATION-FINAL-DECISION.md §2.1, which had set
//     AGPL-3.0 plus a CLA. That document is left as the historical record of
//     what was decided at the time; it is not the live position.
//   - The interface half's LICENSING.md, which is where the move from AGPL to
//     MIT is argued, and its package.json, which declares `MIT`.
//
// Changing the licence means editing the recorded decision and both halves.
// Editing this constant alone will fail against the other half, which is the
// entire point.
//
// WHY THE RELICENSING WAS AVAILABLE AT ALL, recorded here because it is the
// fact that stops being true. Every line was written by one copyright holder,
// and neither dependency tree contains any copyleft component, so there was
// nobody to ask. That is a one-time position: the first outside contribution
// merged without a stated provenance ends it permanently. tools/check-dco.js
// and CONTRIBUTING.md exist to keep the option open, and are the reason this
// gate now also requires CONTRIBUTING.md to be present.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// THE PINNED POSITION
// ---------------------------------------------------------------------------

// SPDX identifier, matching the interface half's package.json exactly.
const SPDX = 'MIT';

// THE MIT TEXT IS PINNED IN TWO PARTS, and the split is the point.
//
// Unlike the AGPL, which is a fixed document reproduced verbatim, the MIT
// licence embeds the copyright line inside the grant itself. So hashing the
// whole file would pin the YEAR and the HOLDER NAME into a constant, and this
// gate would turn red every January on a file nobody touched. A gate that
// reddens on a correct file is a gate somebody deletes.
//
// Instead: the normative body -- every line except the copyright line -- is
// hashed, so changing a single WORD of the permission or warranty text is
// caught. The copyright line is checked separately, by shape, so the year may
// advance and the holder is still asserted.
const MIT_BODY_SHA256 = 'c9b7c49cdeb4ccab2f2cb69e67f3405518e4bcf611bd3b01de101b070659d11d';

// The copyright line must name a year and the holder. `(c)` rather than the ©
// character is deliberate: it survives every encoding this file will be read
// through, which a legal notice has to.
const COPYRIGHT_LINE = /^Copyright \(c\) (\d{4}) Joshua Pinckard$/m;

// Split a licence file into its copyright line and everything else.
//
// CRLF is normalised first, so the digest tracks the TEXT and not the
// line-ending convention. This repository pins `* -text` in .gitattributes so
// its own bytes are stable, but the other half does not, and a clone made under
// core.autocrlf=true gets a CRLF LICENSE whose raw digest differs while the
// licence itself is untouched. A changed WORD still changes the digest, which is
// the tampering this actually guards against.
function splitLicence(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const copyright = lines.find((line) => /^Copyright \(c\)/.test(line)) || null;
  const body = lines.filter((line) => !/^Copyright \(c\)/.test(line)).join('\n');
  return { copyright, body };
}

function licenceBodyDigest(file) {
  const { body } = splitLicence(fs.readFileSync(file, 'utf8'));
  return crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
}

// Assert a LICENSE file is the MIT licence with a sane copyright line. Used for
// this half and for the counterpart, so the two cannot be checked differently.
function checkMitLicence(file, label) {
  const text = fs.readFileSync(file, 'utf8');
  const { copyright } = splitLicence(text);
  const got = licenceBodyDigest(file);

  check(
    got === MIT_BODY_SHA256,
    `${label} is not the standard MIT License text.\n` +
      `      expected body sha256 ${MIT_BODY_SHA256}\n` +
      `      actual   body sha256 ${got}\n` +
      '      The licence body must be the standard wording -- a modified copy is a\n' +
      '      different licence wearing the name. Project-specific wording belongs in NOTICE.'
  );

  if (!check(copyright, `${label} has no "Copyright (c) <year> <holder>" line. MIT places the copyright notice inside the grant; without it the grant names nobody.`)) {
    return got;
  }

  const match = COPYRIGHT_LINE.exec(copyright);
  if (check(match, `${label} copyright line reads "${copyright}", which does not match "Copyright (c) <year> Joshua Pinckard".`)) {
    const year = Number(match[1]);
    const now = new Date().getUTCFullYear();
    // A future year is a typo; a year before the project existed is a copy-paste
    // from somewhere else. Both are worth catching, neither is worth pinning to
    // an exact value that needs editing every January.
    check(
      year >= 2026 && year <= now,
      `${label} claims copyright year ${year}; expected between 2026 and ${now}.`
    );
  }
  return got;
}

// `private: true` is NOT a contradiction of an open-source licence and must not
// be "fixed" to false. It is an npm-registry flag and nothing else: it blocks
// `npm publish`, and it has no effect whatever on publishing source to GitHub.
// Neither half is an npm package -- this one is a runtime started from its own
// entry points -- so publishing either to the registry would be an accident,
// and the flag is what prevents it. The interface half keeps it true alongside
// its MIT declaration; flipping it here would create the very divergence this
// file exists to catch.
const PRIVATE = true;

// Documents in this repository that state the licence, and therefore go stale
// as a pair with package.json.
// CONTRIBUTING.md is in this list because the relicensing option it protects is
// the thing this whole file is really guarding. A repository that declares MIT
// but never says what terms inbound code arrives under is one merge away from
// being unable to state its own provenance.
const LICENCE_DOCS = [
  'LICENSE',
  'NOTICE',
  'THIRD-PARTY-LICENSES.md',
  'CONTRIBUTORS.md',
  'CONTRIBUTING.md'
];

// Prose files where an appended paragraph is the realistic edit. Measured on
// the interface half 2026-08-11: NOTICE carried the same trademark paragraph
// twice, verbatim, and shipped that way inside the installer -- because every
// check that existed was still true. THIRD-PARTY-LICENSES.md is excluded on
// purpose: it reproduces whole licence bodies, so identical Apache-2.0 blocks
// repeat legitimately.
const PROSE_DOCS = ['NOTICE', 'CONTRIBUTORS.md'];
const STALE_CLAIM_DOCS = ['TERMS-OF-SERVICE.md', ...LICENCE_DOCS];
const MINIMUM_PARAGRAPH = 60;

// Where the other half may be checked out on this machine. Explicit, not
// discovered: this repository sits on a Desktop holding ~150 transient app
// worktrees, and sweeping them would compare against a hundred abandoned
// detached checkouts whose staleness is not drift and cannot be fixed from
// here. Override with TOOLSENABLED_APP_HALF (path.delimiter-separated).
const COUNTERPART_CANDIDATES = [
  path.join(path.dirname(ROOT), 'desktop-app'),
  path.join(path.dirname(ROOT), 'mission-control')
];

// ---------------------------------------------------------------------------

const failures = [];
function check(condition, message) {
  if (condition) return true;
  failures.push(message);
  return false;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// --- 1. This half declares the pinned position -----------------------------

function testEngineDeclaration() {
  console.log('🧪 This half declares the recorded licence...');
  const pkg = readJson(path.join(ROOT, 'package.json'));
  assert.ok(pkg, 'root package.json is unreadable');

  check(
    pkg.license === SPDX,
    `package.json declares "license": ${JSON.stringify(pkg.license)}, expected ${JSON.stringify(SPDX)}.\n` +
      '      The owner relicensed both halves to MIT on 2026-08-12. A declaration of\n' +
      '      "UNLICENSED" means all rights reserved -- nobody may legally use, copy or\n' +
      '      redistribute this half; a declaration of AGPL-3.0-or-later is the licence\n' +
      '      this project moved OFF, and either one contradicts the LICENSE file that\n' +
      '      ships beside it. If the licence is genuinely changing again, change the\n' +
      '      recorded decision and BOTH halves -- not this constant alone.'
  );

  check(
    pkg.private === PRIVATE,
    `package.json declares "private": ${JSON.stringify(pkg.private)}, expected ${JSON.stringify(PRIVATE)}.\n` +
      '      This flag only blocks `npm publish`; it does not gate publishing source.\n' +
      '      Both halves keep it true, and they have to agree.'
  );

  console.log(`  ✅ license=${pkg.license} private=${pkg.private}`);
}

// --- 2. The grant is actually in the box -----------------------------------

function testGrantFilesPresent() {
  console.log('🧪 The licence documents exist and are not empty...');
  assert.ok(LICENCE_DOCS.length > 0, 'licence document census must not be empty');
  for (const doc of LICENCE_DOCS) {
    const file = path.join(ROOT, doc);
    if (!check(fs.existsSync(file), `${doc} is missing from the repository root. A licence field in package.json is a claim; ${doc} is what makes it a grant.`)) {
      continue;
    }
    check(fs.readFileSync(file, 'utf8').trim().length > 0, `${doc} exists but is empty`);
  }

  const license = path.join(ROOT, 'LICENSE');
  if (fs.existsSync(license)) {
    const got = checkMitLicence(license, 'LICENSE');
    console.log(`  ✅ LICENSE is the standard MIT License (body ${got.slice(0, 12)}…)`);
  }
}

// --- 3. Attribution is real, not decorative --------------------------------

function testThirdPartyNoticesCurrent() {
  console.log('🧪 Third-party attribution matches the installed tree...');
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'tools/gen-third-party-licenses.js'), '--check'],
    { cwd: ROOT, encoding: 'utf8' }
  );
  const reportedCurrent =
    /^THIRD-PARTY NOTICES: current — \d+ production package\(s\) attributed\s*$/.test(result.stdout || '');
  check(
    result.status === 0 && reportedCurrent,
    'THIRD-PARTY-LICENSES.md does not match the installed dependency tree.\n' +
      `      ${String(result.stderr || result.stdout || '').trim().split('\n').join('\n      ')}\n` +
      '      THIRD-PARTY-LICENSES.md check did not report its own success marker.'
  );
  if (result.status === 0 && reportedCurrent) console.log(`  ✅ ${String(result.stdout).trim()}`);
}

function testNoDuplicatedParagraphs() {
  console.log('🧪 Licence prose does not repeat itself...');
  assert.ok(PROSE_DOCS.length > 0, 'licence prose document census must not be empty');
  for (const doc of PROSE_DOCS) {
    const file = path.join(ROOT, doc);
    if (!fs.existsSync(file)) continue;
    const counts = new Map();
    for (const block of fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
      const trimmed = block.trim();
      if (trimmed.length < MINIMUM_PARAGRAPH) continue;
      counts.set(trimmed, (counts.get(trimmed) || 0) + 1);
    }
    for (const [block, n] of counts) {
      check(
        n === 1,
        `${doc} repeats the same paragraph ${n} times verbatim: "${block.split('\n')[0].slice(0, 80)}…"\n` +
          '      A licence notice that states something twice was appended to without\n' +
          '      being read. Remove the duplicate.'
      );
    }
  }
  console.log('  ✅ no duplicated paragraphs');
}

// --- 4. No document still describes this half as proprietary ---------------

function testNoStaleProprietaryClaim() {
  console.log('🧪 No document still calls this half proprietary...');
  // Narrow and exact. TERMS-OF-SERVICE.md §3 used to tell readers -- correctly
  // at the time -- that package.json declared UNLICENSED and that the software
  // was therefore all-rights-reserved. That sentence became false the moment
  // the licence landed, and a customer-facing legal document that denies its
  // own repository's LICENSE file is worse than one that says nothing.
  const claim = '"license": "UNLICENSED"';
  assert.ok(STALE_CLAIM_DOCS.length > 0, 'stale-claim document census must not be empty');
  for (const doc of STALE_CLAIM_DOCS) {
    const file = path.join(ROOT, doc);
    if (!fs.existsSync(file)) continue;
    check(
      !fs.readFileSync(file, 'utf8').includes(claim),
      `${doc} still tells readers this repository declares ${claim}. ` +
        'It no longer does; update the document to match the LICENSE that now ships.'
    );
  }
  console.log('  ✅ no stale all-rights-reserved claim');
}

// --- 5. The other half agrees ----------------------------------------------

function counterpartRoots() {
  const fromEnv = (process.env.TOOLSENABLED_APP_HALF || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  // An env var that names a path which does not exist is a misconfiguration,
  // not an absence: someone meant to compare and silently compared nothing.
  for (const dir of fromEnv) {
    check(
      fs.existsSync(path.join(dir, 'package.json')),
      `TOOLSENABLED_APP_HALF names "${dir}", which has no package.json. ` +
        'Point it at the interface half\'s checkout root, or unset it.'
    );
  }

  const roots = [...fromEnv, ...COUNTERPART_CANDIDATES].filter((dir) =>
    fs.existsSync(path.join(dir, 'package.json'))
  );
  return [...new Set(roots)];
}

function testCounterpartAgrees() {
  console.log('🧪 The interface half declares the same licence...');
  const roots = counterpartRoots();

  if (!roots.length) {
    // Not a pass and not a failure: nothing to compare. Say so in the words a
    // reader needs, because "no counterpart checkout" printed as a tick is how
    // a cross-repository check quietly stops checking.
    console.log(
      '  ⚠️  no interface-half checkout on this machine; compared nothing. ' +
        `Tried: ${COUNTERPART_CANDIDATES.join(', ')}. ` +
        'Set TOOLSENABLED_APP_HALF to compare. The pinned position above still ' +
        'binds this half.'
    );
    return;
  }

  for (const dir of roots) {
    // Remember where the failure list stood, so the per-root verdict below
    // reports what actually happened. Printing a tick after appending a failure
    // is the exact reporting defect this repository keeps finding in its own
    // instruments -- a green line beside a red result is worse than no line.
    const before = failures.length;

    const pkg = readJson(path.join(dir, 'package.json'));
    if (!check(pkg, `${dir} has an unreadable package.json`)) continue;

    const licenseFile = path.join(dir, 'LICENSE');
    const hasLicenseFile = fs.existsSync(licenseFile);
    const declares = typeof pkg.license === 'string' && pkg.license.length > 0;

    // A checkout that declares NOTHING has not taken a position -- it is a half
    // still awaiting the same work this file records, not a half asserting a
    // different licence. Report it; do not fail this repository's suite for a
    // state that cannot be fixed from inside this repository.
    if (!declares && !hasLicenseFile) {
      console.log(`  ⚠️  ${dir} declares no licence at all (not yet relicensed) — nothing to conflict with`);
      continue;
    }

    if (declares) {
      check(
        pkg.license === SPDX,
        `${dir} declares "license": ${JSON.stringify(pkg.license)} while this half declares ` +
          `${JSON.stringify(SPDX)}.\n` +
          '      The two halves are one product and cannot be under two licences.\n' +
          '      Settle which is correct against the recorded decision, then change BOTH.'
      );
      check(
        pkg.private === PRIVATE,
        `${dir} declares "private": ${JSON.stringify(pkg.private)} while this half declares ` +
          `${JSON.stringify(PRIVATE)}. The halves must agree on npm-publishability.`
      );
    }

    if (hasLicenseFile) {
      checkMitLicence(licenseFile, `${dir} LICENSE`);
    } else {
      check(
        false,
        `${dir} declares "license": ${JSON.stringify(pkg.license)} but ships no LICENSE file. ` +
          'A declaration without the text is not a grant.'
      );
    }

    if (failures.length === before) {
      console.log(`  ✅ ${dir} agrees: ${pkg.license}`);
    } else {
      console.log(`  ❌ ${dir} disagrees — see failures below`);
    }
  }
}

// ---------------------------------------------------------------------------

testEngineDeclaration();
testGrantFilesPresent();
testThirdPartyNoticesCurrent();
testNoDuplicatedParagraphs();
testNoStaleProprietaryClaim();
testCounterpartAgrees();

if (failures.length) {
  console.error(`\n❌ SOURCE-LICENCE DRIFT: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nThis gate fails rather than warns because a licence is the one property of\n' +
      'published software that cannot be corrected after the fact: every copy already\n' +
      'taken keeps whatever terms it was handed.\n'
  );
  process.exit(1);
}

console.log('🎉 Source-licence drift tests passed successfully!');
