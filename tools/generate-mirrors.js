#!/usr/bin/env node
'use strict';
// Generator for the tracked example templates and the reviewed
// process-visibility PowerShell block below. Each output is derived directly
// from the authority read by its generator function.
//
// USAGE: node tools/generate-mirrors.js [--check]
//   (no flag)  writes every registered generated mirror it can generate here.
//   --check    writes to a temp file and diffs against the real one; exits 1
//              on any difference. Safe to run in CI -- never touches the
//              real files.
//
// EXIT CODES. Non-zero means a mirror on disk disagrees with what this
// generator would write. Generated source artifacts must depend only on
// customer-neutral repository inputs; machine-local runtime configuration is
// built by the runtime that consumes it, never by this source generator.

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const BANNER = 'GENERATED -- do not edit. Produced by tools/generate-mirrors.js; edit the authority it reads, then re-run this script.';

// --- extractor: machine-roots ------------------------------------------
//
// The two registered machine-roots generated mirrors are onboarding
// TEMPLATES (adapters/*/*.example) parsed by tests/code.intel/gemini-mcp-profile.js,
// which asserts structural properties (script name, allowlist contents) but
// does not pin an exact drive path -- confirmed by reading that test before
// this generator was written.
//
// They used to regenerate to THIS machine's own root, on the reasoning that a
// real current path beats a stale hand-edited one. That reasoning traded one
// defect for another: a shipped, TRACKED example template containing a real
// person's filesystem root is a personal-data leak regardless of whether the
// path happens to be current, and "regenerate" made it self-healing in
// exactly the wrong direction -- every run re-introduced whichever machine
// generated it last. A template's job is to show the SHAPE of a valid entry,
// not to assert a specific person's directory, so these two now carry a
// fixed, obviously-a-placeholder path instead. The structural test above
// still passes: it checks the script name and allowlist, never an exact
// drive letter.
//
// The native-agent MCP document is deliberately absent from this list. It is
// runtime state, not a source mirror: the launcher derives the exact local
// interpreter and src/mcp-server.js from its own installed location, writes a
// one-run document, verifies it, and removes it when the child settles. A
// tracked descriptor tied to a named peer made every fresh installation fail
// this generator and once shipped an `undefined\\src\\mcp-server.js` path.
// Deliberately not a real path on any registered machine: obviously a
// placeholder to a human copying the template, and -- same property the
// "current machine root" approach was trying to get right -- it can never go
// stale, because it never claimed to be anyone's real checkout in the first
// place.
const PORTABLE_TEMPLATE_ROOT_PLACEHOLDER = 'C:\\path\\to\\your\\toolsenabled-checkout';

function machineRoots() {
  const escape = value => JSON.stringify(value).slice(1, -1); // JSON string body, backslashes escaped

  return [
    {
      file: 'adapters/claude/mcp.json.example',
      content: JSON.stringify({
        _comment: `${BANNER} The path below is a PLACEHOLDER, not a real machine's root -- copy this file, drop the ".example" suffix, and replace it with where your own checkout actually lives.`,
        mcpServers: {
          toolsenabled: {
            command: 'node',
            args: [`${PORTABLE_TEMPLATE_ROOT_PLACEHOLDER}\\tools\\mcp-owner-proxy.js`],
            env: {
              TOOLSENABLED_AGENT_ACTOR: 'claude',
              TOOLSENABLED_TOOL_ALLOWLIST: 'system.*,task.*,memory.*,search.*,code.*,research.hermes_complete,research.strong_complete,research.local_tiers_status,overnight_advisory.*,sandbox.*,gcloud.account_inspect,audit.status,audit.tail,duo.*,clipboard.*,screen.*,ocr.read,window.*,model.complete,http.request,web.search'
            }
          }
        }
      }, null, 2) + '\n'
    },
    {
      file: 'adapters/gemini/settings.json.example',
      content: JSON.stringify({
        _comment: `${BANNER} The path below is a PLACEHOLDER, not a real machine's root -- copy this file, drop the ".example" suffix, and replace it with where your own checkout actually lives.`,
        mcpServers: {
          toolsenabled: {
            command: 'node',
            args: [`${PORTABLE_TEMPLATE_ROOT_PLACEHOLDER}\\tools\\mcp-owner-proxy.js`],
            env: {
              TOOLSENABLED_AGENT_ACTOR: 'gemini',
              TOOLSENABLED_TOOL_ALLOWLIST: 'system.*,task.*,memory.*,search.*,code.*,research.hermes_complete,research.strong_complete,research.local_tiers_status,overnight_advisory.*,sandbox.*,audit.status,audit.tail,duo.*,clipboard.*,screen.*,ocr.read,window.*,model.complete,http.request,web.search'
            }
          }
        }
      }, null, 2) + '\n'
    }
  ].map(entry => { void escape; return entry; }); // escape kept for symmetry with the ps1 extractor's manual escaping; JSON.stringify already handles JS-side escaping here.
}

// --- extractor: process-visibility-task-names --------------------------
//
// The JS side (src/lib/supervision/process-visibility-targets.js) is a
// SECURITY ALLOWLIST for an elevated collector, hand-curated against
// config/managed-processes.json with documented exclusions (e.g. "ToolsEnabled
// Owner Host" is deliberately absent -- its DPAPI boundary makes it unsuitable
// for this collector, per that file's own comment). Which processes belong on
// an elevated allowlist is a security decision, not a pure function of the
// process registry, so the JS allowlist is human-reviewed rather than derived.
//
// The PowerShell side has no such judgment to make: it only needs to match
// whatever the JS side already decided. So it generates FROM the JS module's
// own BASE_TASK_NAMES export (the reviewed list), not from the raw config --
// one human-reviewed list, one mechanical mirror of it, instead of two lists
// that can drift from each other.
function processVisibilityTaskNames() {
  // BASE_TASK_NAMES is the generated block. Until 2026-08-22 the .ps1 appended
  // a conditional Discord entry outside the block, which is why this reads the
  // base list rather than TASK_NAMES; the two are identical now and the
  // distinction is kept only so the generated block stays a named thing.
  const { BASE_TASK_NAMES } = require('../src/lib/supervision/process-visibility-targets');
  const psArrayLines = BASE_TASK_NAMES.map(name => `  '${name.replace(/'/g, "''")}'`).join(',\n');
  return [{
    file: 'tools/collect-process-visibility.ps1',
    // This does not rewrite the whole file -- collect-process-visibility.ps1
    // has real collection logic around this one array. Instead it rewrites
    // ONLY the $TargetTaskNames block between two anchor comments, which the
    // .ps1 must carry for this to work. See applyPs1Block() below.
    ps1Block: `# GENERATE-MIRRORS:BEGIN process-visibility-task-names\n# ${BANNER}\n$TargetTaskNames = @(\n${psArrayLines}\n)\n# GENERATE-MIRRORS:END process-visibility-task-names`
  }];
}

function applyPs1Block(filePath, block) {
  const beginMarker = '# GENERATE-MIRRORS:BEGIN process-visibility-task-names';
  const endMarker = '# GENERATE-MIRRORS:END process-visibility-task-names';
  const existing = fs.readFileSync(filePath, 'utf8');
  const start = existing.indexOf(beginMarker);
  const end = existing.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${filePath}: missing GENERATE-MIRRORS anchor comments; refusing to guess where the generated block belongs.`);
  }
  return existing.slice(0, start) + block + existing.slice(end + endMarker.length);
}

function writeIfDifferent(filePath, content, { check }) {
  const absolute = path.join(ROOT, filePath);
  const previous = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
  if (previous === content) return { file: filePath, changed: false };
  if (check) return { file: filePath, changed: true, wouldWrite: true };
  fs.writeFileSync(absolute, content, 'utf8');
  return { file: filePath, changed: true };
}

// Given a repository-relative path, return the exact string this generator
// would write there right now, or null if this generator does not own the file.
// This is exported so callers can compare the generated output without writing.
//
function computeExpectedContent(relativeFile) {
  const normalized = relativeFile.replace(/\\/g, '/');
  for (const entry of machineRoots()) {
    if (entry.file === normalized) return entry.content;
  }
  for (const entry of processVisibilityTaskNames()) {
    if (entry.file === normalized) return applyPs1Block(path.join(ROOT, entry.file), entry.ps1Block);
  }
  return null;
}

function run({ check = false } = {}) {
  const results = [];
  for (const entry of machineRoots()) {
    results.push(writeIfDifferent(entry.file, entry.content, { check }));
  }
  for (const entry of processVisibilityTaskNames()) {
    const absolute = path.join(ROOT, entry.file);
    const content = applyPs1Block(absolute, entry.ps1Block);
    results.push(writeIfDifferent(entry.file, content, { check }));
  }
  return results;
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const results = run({ check });
  for (const r of results) {
    console.log(`  ${r.changed ? (check ? 'WOULD CHANGE' : 'wrote') : 'unchanged'}  ${r.file}`);
  }
  if (check && results.some(r => r.changed)) {
    console.error('generate-mirrors --check: generated files are stale. Run `node tools/generate-mirrors.js` to update them.');
    process.exitCode = 1;
  }
}

module.exports = { run, machineRoots, processVisibilityTaskNames, computeExpectedContent };
