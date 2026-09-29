#!/usr/bin/env node
// GREPSAVER Phase 2 — deterministic fact extractor for system cards.
// Read-only against target systems. See GREPSAVER-PLAN.md §5.
//
// Usage: node tools/grepsaver-extract.js <system-path> [--json]
//
// Emits the deterministic facts a card author (agent or human) starts from:
// top-level file map, run/build/test commands with provenance, port facts
// cross-referenced from ServerControl\servers.json, git or manifest identity,
// and an inventory of existing docs. Judgment sections (purpose, invariants,
// gotchas, confidence) are the card author's job, not this script's.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');
const lib = require('./grepsaver-lib.js');

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', '.next', '.open-next', 'dist', 'build']);

function fail(msg) {
  process.stderr.write(`grepsaver-extract: ${msg}\n`);
  process.exit(2);
}

function topLevel(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    const stat = fs.statSync(p);
    out.push({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      size: entry.isDirectory() ? null : stat.size,
      mtime: stat.mtime.toISOString(),
      skipped: entry.isDirectory() && SKIP_DIRS.has(entry.name) ? true : undefined,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function packageScripts(root) {
  // Root package.json plus one level of subdirectories (suite/, app/, etc.).
  const found = [];
  const candidates = [path.join(root, 'package.json')];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      candidates.push(path.join(root, entry.name, 'package.json'));
    }
  }
  for (const pj of candidates) {
    let source;
    try {
      source = fs.readFileSync(pj, 'utf8');
    } catch (error) {
      // A candidate that genuinely does not exist contains no scripts. Any
      // other read failure means the inventory could not be established.
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    const parsed = JSON.parse(source);
    if (parsed.scripts && Object.keys(parsed.scripts).length) {
      found.push({
        file: path.relative(root, pj).replace(/\\/g, '/'),
        name: parsed.name || null,
        scripts: parsed.scripts,
        provenance: 'package.json script',
      });
    }
  }
  return found;
}

function readmeCommands(root) {
  // Fenced code blocks in top-level README*/CLAUDE.md whose lines look like commands.
  const cmds = [];
  const docNames = fs.readdirSync(root).filter((n) => /^(readme[^/\\]*|claude\.md|agents\.md)$/i.test(n));
  for (const name of docNames) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    const fences = text.match(/```[^\n]*\n[\s\S]*?```/g) || [];
    for (const fence of fences) {
      for (const line of fence.split('\n').slice(1, -1)) {
        const t = line.trim();
        if (/^(npm|npx|node|python|pip|pwsh|powershell|\.\\|\.\/|dotnet|cargo|go |git )/i.test(t)) {
          // Secret-like fence content must never be quoted into a card (plan §7).
          cmds.push({ command: lib.looksSecret(t) ? '[REDACTED — secret-like content]' : t, provenance: `${name} fence` });
        }
      }
    }
  }
  return cmds.slice(0, 40);
}

function docsInventory(root) {
  return fs.readdirSync(root)
    .filter((n) => /^(readme|claude|agents|plan|progress|contributing)/i.test(n) && /\.(md|txt)$/i.test(n))
    .sort();
}

function gitIdentity(root) {
  const run = (args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false, env: safeLaunchEnvironment() }).trim();
  // Establish the ordinary non-repository case from the filesystem, rather
  // than translating every git failure (timeout, missing binary, corrupt
  // repository, or unreadable metadata) into the definite answer "not git".
  let cursor = root;
  while (true) {
    try {
      fs.lstatSync(path.join(cursor, '.git'));
      break;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return { isGit: false };
    cursor = parent;
  }

  // A system nested below some unrelated repository is still not itself a
  // repository.  Return that answer from the filesystem discovery above
  // instead of invoking Git from the child path.  Apart from doing needless
  // work, that invocation can fail before `--show-toplevel` produces an answer
  // when the parent repository is malformed, unreadable, or owned by another
  // account (Git's safe-directory refusal).  Such a parent must not make an
  // otherwise ordinary system impossible to inventory.
  if (path.resolve(cursor) !== path.resolve(root)) {
    return { isGit: false, note: `inside a parent git repo at ${cursor}` };
  }

  const top = run(['rev-parse', '--show-toplevel']);
  // Only treat as a git system if the target itself is the repo root
  // (otherwise we'd report a parent repo's identity as this system's).
  if (path.resolve(top) !== path.resolve(root)) {
    return { isGit: false, note: `inside a parent git repo at ${top}` };
  }
  const head = run(['rev-parse', 'HEAD']);
  const dirty = run(['status', '--porcelain']).length > 0;
  return { isGit: true, head, dirty };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const mIdx = args.indexOf('--manifest');
  const manifest = mIdx >= 0 ? (args[mIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const positional = args.filter((a, i) => a !== '--json' && a !== '--manifest' && (mIdx < 0 || i !== mIdx + 1));
  const target = positional[0];
  if (!target) fail('usage: node tools/grepsaver-extract.js <system-path> [--json] [--manifest a,b,c]');
  const root = path.resolve(target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`not a directory: ${root}`);

  const report = {
    extracted_at: new Date().toISOString(),
    source_path: root,
    git: gitIdentity(root),
    // §6 manifest-hash on request, via the same shared recipe the checker uses.
    manifest_fingerprint: manifest ? lib.fingerprintManifest(root, manifest) : undefined,
    servers: lib.serverFacts(root),
    docs: docsInventory(root),
    package_scripts: packageScripts(root),
    readme_commands: readmeCommands(root),
    top_level: topLevel(root),
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const w = (s) => process.stdout.write(s + '\n');
  w(`# grepsaver-extract — ${root}`);
  w(`extracted_at: ${report.extracted_at}`);
  w(report.git.isGit ? `git: HEAD ${report.git.head}${report.git.dirty ? ' (dirty)' : ''}` : `git: not a repo${report.git.note ? ' (' + report.git.note + ')' : ''}`);
  if (report.manifest_fingerprint) {
    w(`manifest fingerprint: ${report.manifest_fingerprint.value}`);
    if (report.manifest_fingerprint.missingEntries.length) w(`  WARNING — missing manifest entries: ${report.manifest_fingerprint.missingEntries.join(', ')}`);
  }
  if (report.servers.length) { w('servers (from ServerControl servers.json):'); report.servers.forEach((s) => w(`  - ${s.name}: port ${s.port} (${s.url}) workdir ${s.workDir}`)); }
  if (report.docs.length) w(`docs: ${report.docs.join(', ')}`);
  for (const pj of report.package_scripts) { w(`scripts in ${pj.file}${pj.name ? ' (' + pj.name + ')' : ''}:`); Object.entries(pj.scripts).forEach(([k, v]) => w(`  - npm run ${k}  ->  ${v}`)); }
  if (report.readme_commands.length) { w('commands found in doc fences (UNTRUSTED — verify before running):'); report.readme_commands.forEach((c) => w(`  - ${c.command}   [${c.provenance}]`)); }
  w('top-level entries:');
  report.top_level.forEach((e) => w(`  ${e.type === 'dir' ? 'd' : 'f'} ${e.name}${e.size !== null ? ' (' + e.size + ' B)' : ''}${e.skipped ? ' [skipped-class dir]' : ''}`));
}

// Guarded so other grepsaver tools (grepsaver-reindex.js) can `require()`
// this file's helper functions without re-running the CLI. check.js already
// invokes this file only as a subprocess (`node grepsaver-extract.js ... --json`),
// so this guard changes nothing about existing behavior.
if (require.main === module) main();

module.exports = { topLevel, packageScripts, readmeCommands, docsInventory, gitIdentity, SKIP_DIRS };
