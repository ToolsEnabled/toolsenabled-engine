'use strict';

// A checked-in list of test files, for `tests/run-isolated.js --from <path>`.
//
// WHY A FILE INSTEAD OF ARGV
// --------------------------
// Windows caps a whole command line at 8191 characters. package.json's `test`
// script named its 305 test files inline and measured 12,928 characters, so on
// Windows `npm test` died with "The command line is too long." before a single
// suite ran -- not one test failed, because not one test started. The runner
// already accepts a list; a list that long simply belongs in a file.
//
// WHY THE STATIC READERS PARSE IT TOO, AND WHY THAT IS NOT OPTIONAL
// -----------------------------------------------------------------
// tools/test-census.js decides whether a test file is WIRED by looking for its
// path in an npm script command line, and tools/invocation-guard.js gates on
// that answer. Moving 305 paths out of package.json without teaching the census
// about `--from` would have reported 305 genuinely-running suites as orphans --
// the exact blindness tools/check-chain-runner.js's header warns about when it
// explains why the pretest step list must stay on the npm command line. So this
// module is the single reader, and tools/test-census.js and
// tools/invocation-graph.js call it on the same command lines npm runs.
//
// The format is deliberately dull: one repository-relative path per line, `#`
// comments and blank lines ignored. Nothing is interpreted, nothing is globbed,
// and no path is invented -- what the file says is what gets run, in order, so
// the file is as readable as the argv it replaces.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

// Where checked-in lists live. The static readers below match ONLY this
// directory: `--from` means something else in other command lines (PowerShell
// and shell scripts in this repository use it), and a reader that guessed would
// credit reachability it never verified.
const SUITE_LIST_DIRECTORY = 'tests/suites';

const SUITE_LIST_REFERENCE = new RegExp(
  String.raw`(?:^|\s)--from\s+['"]?((?:\.[\\/])?tests[\\/]suites[\\/][\w.-]+\.txt)['"]?(?=\s|$)`,
  'gm'
);

function parseSuiteList(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

// Read one list. Throws with the path in the message: an unreadable list is a
// broken invocation, and failing open here would silently run nothing.
function readSuiteList(listPath) {
  const absolute = path.resolve(ROOT, listPath);
  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new Error(`--from could not read the test list at ${listPath}: ${error.message}`);
  }
  const entries = parseSuiteList(text);
  if (!entries.length) throw new Error(`--from list is empty: ${listPath}`);
  return entries;
}

// Every test path named through `--from` by a command line. Used by the static
// reachability readers, which must not throw on a stale or missing list: a
// command line that points at a list which is not there names no files, and
// saying so quietly is right for a reporter. The RUNNER above throws instead,
// because for it the same condition means the batch cannot run.
function suiteListReferences(commandLine) {
  const files = [];
  for (const match of String(commandLine).matchAll(SUITE_LIST_REFERENCE)) {
    const listPath = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
    let entries;
    try {
      entries = readSuiteList(listPath);
    } catch {
      continue;
    }
    files.push(...entries);
  }
  return files;
}

module.exports = { ROOT, SUITE_LIST_DIRECTORY, parseSuiteList, readSuiteList, suiteListReferences };
