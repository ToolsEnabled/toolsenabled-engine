#!/usr/bin/env node
'use strict';

// THIRD-PARTY LICENSE NOTICE GENERATOR.
//
// WHY THIS IS GENERATED AND NOT WRITTEN.
//
// A hand-written attribution file is accurate exactly once: on the day someone
// wrote it. Dependencies are then added by people who are thinking about the
// feature, not about notices, and the file silently becomes a claim about a
// dependency tree that no longer exists. That is not a documentation defect --
// an attribution file that omits a redistributed component is an unmet notice
// obligation, and unlike a bug it cannot be fixed retroactively for copies
// already handed out.
//
// So the file is derived from the installed tree, and `--check` proves the
// committed copy still matches what the tree produces. Regenerating is the only
// way to change it, which means a new dependency cannot land without its notice
// landing in the same commit.
//
// WHAT THIS REPOSITORY ACTUALLY REDISTRIBUTES, stated precisely because the
// answer changes what is owed. This half of ToolsEnabled is published as
// source: npm resolves the packages below on the user's own machine from the
// public registry, so today we hand out no copy of them and no notice
// obligation has been triggered yet. The attribution is produced anyway, for
// two reasons. Apache-2.0 §4 attaches the moment anything is packaged for
// distribution -- an installer, a container image, a vendored bundle -- and by
// then the tree has usually changed; and a reader comparing this file against
// package.json is entitled to find every name accounted for rather than a gap
// they have to guess at.
//
// USAGE:
//   node tools/gen-third-party-licenses.js            rewrite the file
//   node tools/gen-third-party-licenses.js --check    fail if it is stale

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'THIRD-PARTY-LICENSES.md');

// Notice-bearing filenames as published by real packages. LICENCE/LICENSE and
// COPYING are the license grant itself; NOTICE is what Apache-2.0 §4(d)
// separately requires to be propagated; ThirdPartyNotices.txt is the
// convention Microsoft-published packages use for code they in turn vendored.
const LICENSE_FILE = /^(LICEN[CS]E|COPYING)(\.[A-Za-z0-9]+)?$/i;
const NOTICE_FILE = /^NOTICE(\.[A-Za-z0-9]+)?$/i;
const THIRD_PARTY_FILE = /^ThirdPartyNotices(\.[A-Za-z0-9]+)?$/i;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Resolve the way Node does -- walk up through node_modules -- rather than
// shelling out to `npm ls`. This has to run inside a test with no network and
// no npm subprocess, and it has to give the same answer every time.
function resolveFrom(startDir, name) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    const manifest = path.join(candidate, 'package.json');
    try {
      if (fs.statSync(manifest).isFile()) return candidate;
    } catch (error) {
      // A missing candidate means Node resolution should continue upward. Any
      // other failure means we could not establish whether this candidate
      // exists; treating (for example) EACCES as absence could misreport a
      // required dependency as uninstalled or an optional one as not present.
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readNoticeFiles(dir, pattern) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const text = fs.readFileSync(path.join(dir, entry.name), 'utf8').replace(/\r\n/g, '\n').trim();
    if (text) out.push({ file: entry.name, text });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function spdxOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  // Ancient packages used `license: {type}` or a `licenses[]` array. Report
  // what is there rather than "unknown", so a human can judge it.
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type || l).join(' OR ');
  return null;
}

/**
 * Walk the production dependency closure. Only `dependencies` are followed:
 * devDependencies are not part of what a user of this runtime receives, and
 * including them would pad the file with notices nobody is owed.
 */
function productionClosure() {
  const root = readJson(path.join(ROOT, 'package.json'));
  if (!root) throw new Error('cannot read root package.json');

  const packages = new Map();
  const problems = [];
  const optionalUnresolved = new Map();
  const queue = Object.keys(root.dependencies || {}).map((name) => ({ name, from: ROOT, via: null }));

  while (queue.length) {
    const { name, from, via } = queue.shift();
    const dir = resolveFrom(from, name);
    if (!dir) {
      problems.push(`"${name}" is declared${via ? ` (via ${via})` : ''} but is not installed`);
      continue;
    }
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg) {
      problems.push(`"${name}" has no readable package.json at ${dir}`);
      continue;
    }
    const key = `${name}@${pkg.version}`;
    if (packages.has(key)) continue;

    packages.set(key, {
      name,
      version: pkg.version,
      spdx: spdxOf(pkg),
      via,
      dir,
      homepage: typeof pkg.homepage === 'string' ? pkg.homepage : null,
      licenses: readNoticeFiles(dir, LICENSE_FILE),
      notices: readNoticeFiles(dir, NOTICE_FILE),
      thirdParty: readNoticeFiles(dir, THIRD_PARTY_FILE)
    });

    for (const dep of Object.keys(pkg.dependencies || {})) {
      queue.push({ name: dep, from: dir, via: name });
    }
    // Optional dependencies are recorded but NOT walked: they are typically
    // platform-gated (fsevents on macOS) and are genuinely absent here. Naming
    // them is what stops a reader finding an unexplained gap between this file
    // and the lockfile.
    for (const [dep, range] of Object.entries(pkg.optionalDependencies || {})) {
      if (resolveFrom(dir, dep)) {
        queue.push({ name: dep, from: dir, via: name });
      } else {
        optionalUnresolved.set(dep, { range, via: name });
      }
    }
  }

  return {
    packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
    optionalUnresolved: [...optionalUnresolved.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    problems
  };
}

function fence(text) {
  // A license body can itself contain a triple backtick. Widen the fence until
  // it cannot be closed early by the content.
  let ticks = '```';
  while (text.includes(ticks)) ticks += '`';
  return `${ticks}text\n${text}\n${ticks}`;
}

function render(closure) {
  const lines = [];
  const push = (...l) => lines.push(...l);

  push(
    '# Third-party licenses',
    '',
    '<!-- GENERATED FILE. Do not edit by hand.',
    '     Regenerate with: node tools/gen-third-party-licenses.js',
    '     Staleness is enforced by tests/source-license-drift.test.js. -->',
    '',
    'The ToolsEnabled runtime is licensed under the MIT License. That grant is made by',
    '[`LICENSE`](LICENSE) and nothing in this file affects it.',
    '',
    'This file runs the other direction: the components below are third-party work with',
    'their own licenses, and those licenses are unaffected by ours. Their texts are',
    'reproduced verbatim from the packages as installed.',
    '',
    '**How these reach a user.** This half of ToolsEnabled is published as source, so npm',
    'resolves these packages on the user\'s own machine from the public registry rather',
    'than this repository handing out copies of them. The notices are reproduced here',
    'anyway, because Apache-2.0 §4 attaches as soon as anything is packaged for',
    'distribution — an installer, an image, a vendored bundle — and the dependency tree',
    'has usually moved on by the time somebody remembers to look.',
    ''
  );

  if (!closure.packages.length) {
    push(
      '## Components',
      '',
      'This runtime currently declares no production dependencies. Nothing third-party is',
      'resolved into what a user receives, so there is nothing to attribute.',
      ''
    );
  } else {
    push('## Components', '', '| Component | Version | License | Role |', '|---|---|---|---|');
    for (const p of closure.packages) {
      const role = p.via ? `Dependency of \`${p.via}\`.` : 'Declared directly in `package.json`.';
      push(`| \`${p.name}\` | ${p.version} | ${p.spdx || '**undeclared**'} | ${role} |`);
    }
    push('');
  }

  if (closure.optionalUnresolved.length) {
    push(
      '### Optional, not installed here',
      '',
      'These are declared as optional dependencies and are not present in this tree —',
      'they are platform-gated and did not install on this platform. They are named so',
      'that a reader comparing this file against `package.json` finds no unexplained gap.',
      ''
    );
    for (const [name, info] of closure.optionalUnresolved) {
      push(`- \`${name}\` (\`${info.range}\`), optional dependency of \`${info.via}\`.`);
    }
    push('');
  }

  push(
    '### Browser binaries',
    '',
    'Playwright drives Chromium, Firefox and WebKit. It downloads those browser builds',
    'onto the machine that runs it, on first use, into a per-user cache outside this',
    'repository. They are not redistributed here and are licensed by their own vendors,',
    'whose notices ship inside each download.',
    ''
  );

  /* WEAK COPYLEFT IS NAMED SEPARATELY, NOT FOLDED INTO "PERMISSIVE".
   *
   * This sentence ships in a published file, and this file is read precisely by
   * people checking whether a licence claim holds. MPL-2.0 is not permissive:
   * it is file-level copyleft that behaves permissively for an UNMODIFIED
   * dependency, which is a different claim and just as short to make. Legal
   * ruled on exactly this wording (2026-08-20) after the FRA lane reported the
   * one such package in the tree rather than self-clearing it. If a package
   * carrying one of these is ever vendored or forked into this repo instead of
   * depended on, the obligation changes shape and it goes back to legal BEFORE
   * that lands. */
  const WEAK_COPYLEFT = new Set(['MPL-2.0', 'EPL-2.0', 'CDDL-1.0', 'CDDL-1.1']);
  const ids = [...new Set(closure.packages.map((p) => p.spdx).filter(Boolean))].sort();
  const weak = ids.filter((id) => WEAK_COPYLEFT.has(id));
  const permissive = ids.filter((id) => !WEAK_COPYLEFT.has(id));
  if (ids.length) {
    push('### Compatibility', '');
    if (permissive.length) {
      push(
        `Permissive: ${permissive.length === 1 ? permissive[0] : permissive.join(', ')}. Terms of this kind can be combined`,
        'into a work distributed under the MIT License, so there is no license conflict with',
        'the grant on ToolsEnabled. What they do impose is notice obligations, which is what',
        'this file discharges.',
        ''
      );
    }
    if (weak.length) {
      push(
        `Weak (file-level) copyleft: ${weak.join(', ')}. Not permissive, and named separately for`,
        'that reason. The obligation attaches to MODIFIED files of those packages; each is used',
        'here as an unmodified dependency, which the licence expressly permits combining into a',
        'larger work under different terms. Anyone modifying or vendoring one of these files',
        'takes on publishing that file under its own licence.',
        ''
      );
    }
  }

  push('---', '', '## Full license texts', '');

  for (const p of closure.packages) {
    push(`### ${p.name} ${p.version} — ${p.spdx || 'license not declared in package.json'}`, '');
    if (p.homepage) push(`Project: ${p.homepage}`, '');

    if (!p.licenses.length) {
      push(
        '**This package ships no license file in `node_modules`, so no text can be',
        'reproduced from it.** Resolve this before packaging anything that includes it.',
        ''
      );
    }
    for (const lic of p.licenses) {
      push(`Reproduced verbatim from \`node_modules/${p.name}/${lic.file}\`.`, '', fence(lic.text), '');
    }
    for (const notice of p.notices) {
      push(
        `Attribution notice, reproduced verbatim from \`node_modules/${p.name}/${notice.file}\`.`,
        'Apache-2.0 §4(d) requires this to travel with redistributions.',
        '',
        fence(notice.text),
        ''
      );
    }
    for (const tp of p.thirdParty) {
      push(
        `\`${p.name}\` vendors third-party code of its own. Its notices, reproduced`,
        `verbatim from \`node_modules/${p.name}/${tp.file}\`:`,
        '',
        fence(tp.text),
        ''
      );
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const closure = productionClosure();

  if (closure.problems.length) {
    console.error('THIRD-PARTY NOTICE GENERATOR: cannot describe the dependency tree');
    for (const p of closure.problems) console.error(`  - ${p}`);
    console.error('\nRun `npm install` first: notices are read from the installed packages,');
    console.error('and a tree that is not installed cannot be attributed honestly.');
    process.exit(1);
  }

  const rendered = render(closure);
  const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') : null;

  if (check) {
    if (existing === rendered) {
      console.log(
        `THIRD-PARTY NOTICES: current — ${closure.packages.length} production package(s) attributed`
      );
      return;
    }
    console.error('THIRD-PARTY NOTICES: STALE\n');
    console.error(
      existing === null
        ? '  THIRD-PARTY-LICENSES.md does not exist.'
        : '  THIRD-PARTY-LICENSES.md does not match the installed dependency tree.'
    );
    console.error('\n  Fix: node tools/gen-third-party-licenses.js');
    console.error('  Do not edit the file by hand; the next regeneration would discard it.\n');
    process.exit(1);
  }

  fs.writeFileSync(OUTPUT, rendered);
  console.log(
    `THIRD-PARTY NOTICES: wrote ${path.relative(ROOT, OUTPUT)} — ` +
      `${closure.packages.length} production package(s) attributed`
  );
}

main();
