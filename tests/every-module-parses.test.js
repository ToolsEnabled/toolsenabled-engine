'use strict';

// EVERY MODULE THIS PRODUCT SHIPS MUST AT LEAST PARSE.
//
// WHY THIS FILE EXISTS. src/lib/providers/gemini-agentic.js shipped with a
// SYNTAX ERROR -- an unescaped apostrophe inside a single-quoted string:
//
//     'The configured Vertex account's gcloud ADC credential file ...'
//
// `account's` closed the string, so the file could not be loaded at all, by
// anything, ever. It was committed and shipped in that state.
//
// WHAT IT COST. src/lib/agent-onboarding.js declares `gemini-agentic` to every
// agent as a capability it has, naming that exact path; tools/gemini-agentic-
// run.js is the CLI that runs it and requires it on its third line. So the
// product advertised a capability whose entry point threw before its first
// statement -- the same shape as a declared setting nothing reads, which this
// codebase already calls its signature defect.
//
// WHY NOTHING CAUGHT IT. There was no syntax gate. Every other check in tools/
// reads source as TEXT -- naming, comms names, owner attribution, plain
// language -- and a file that cannot be parsed passes all of them happily,
// because grep does not care whether a quote is closed. The unit tests did not
// catch it either: nothing imports gemini-agentic except a CLI and a manifest
// entry, so no suite ever required it.
//
// A parse is the cheapest possible check and it subsumes an entire class. It is
// deliberately NOT a lint: no style opinion, no rule set, no configuration. The
// only question asked is whether Node could load this file if it wanted to.
//
// IT COMPILES AND DOES NOT RUN. Executing a module would start daemons, open
// databases and spawn PowerShell. vm.Script compiles and stops, so this suite
// is safe to run anywhere, including against a tree mid-edit.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ROOTS = ['src', 'tools', 'sidecars'];

/* Node wraps a CommonJS file in a function before compiling it, which is what
   makes a top-level `return` legal in a module and illegal in a script. Compile
   the wrapped form, or this would report false failures on correct files. */
const WRAP_HEAD = '(function (exports, require, module, __filename, __dirname) {';
const WRAP_TAIL = '\n});';

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs') || entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

const files = [];
for (const name of ROOTS) walk(path.join(ROOT, name), files);

assert.ok(files.length > 200,
  `only ${files.length} modules found under ${ROOTS.join(', ')} -- the walk is broken, and a broken walk `
  + 'passes this suite for the wrong reason');

const broken = [];

for (const file of files) {
  /* A SHEBANG IS NOT A TOKEN. Node strips `#!...` before compiling a module;
     vm.Script does not, so every CLI entry point in this tree reported
     "Invalid or unexpected token" on its first line. 165 false failures on the
     first run, which is a good reminder that a gate is only worth having once
     its own noise is gone -- a check that cries wolf is a check people delete. */
  const source = fs.readFileSync(file, 'utf8').replace(/^#![^\n]*/, '');
  const relative = path.relative(ROOT, file).replace(/\\/g, '/');
  /* An ES module must be parsed as a module, not wrapped. vm.SourceTextModule
     is behind a flag, while treating any error that merely mentions import or
     export as success can hide an unrelated syntax error later in the file.
     Let the current Node executable perform its exact, non-executing module
     syntax check instead. There are few .mjs files, so subprocess cost stays
     small and the gate does not need a second JavaScript parser dependency. */
  const isEsm = file.endsWith('.mjs');
  if (isEsm) {
    const checked = childProcess.spawnSync(process.execPath, ['--check', file], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (checked.error || checked.status !== 0) {
      const output = `${checked.stderr || ''}${checked.stdout || ''}`.trim();
      const message = checked.error ? checked.error.message : output || `node --check exited ${checked.status}`;
      broken.push({ relative, message });
    }
    continue;
  }

  const candidate = WRAP_HEAD + source + WRAP_TAIL;
  try {
    // eslint-disable-next-line no-new
    new vm.Script(candidate, { filename: file });
  } catch (error) {
    const message = String((error && error.message) || 'unknown');
    broken.push({ relative, message });
  }
}

if (broken.length) {
  for (const entry of broken) {
    process.stderr.write(`  ${entry.relative}\n      ${entry.message}\n`);
  }
}

assert.equal(broken.length, 0,
  `${broken.length} module(s) cannot be parsed. A file that does not parse cannot be required by `
  + 'anything, so every feature behind it is dead however complete the rest of it looks.');

process.stdout.write(`every-module-parses: ${files.length} modules parse\n`);
