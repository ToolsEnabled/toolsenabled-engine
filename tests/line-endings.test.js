'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');

// WHAT THIS SUITE MAY ASSERT ON, and why the scope was cut back.
//
// REMOVED 2026-08-13: `path.join(path.dirname(ROOT), 'Start-ToolsEnabled-Admin.cmd')`.
//
// That is C:\Users\owner\Desktop\Start-ToolsEnabled-Admin.cmd -- a file OUTSIDE
// this repository, untracked by it, shipped by nothing here. It went red on
// 2026-08-13 because it is LF, and no commit to this repo could ever turn it
// green: `git check-ignore` on it does not say "ignored", it says "outside
// repository". On every other machine, every fresh clone and every worktree the
// file is simply absent and the entry silently vanished from the list. So the
// check had exactly two possible outcomes -- skipped everywhere, or permanently
// red on one desktop for a reason no change here can fix. That is not a test.
//
// The same reasoning already retired the Portfolio Dashboard block in
// tests/terminal-suppression.test.js: "a different project's config file -- one
// nothing here owns, writes, or can fix." This is that, again.
//
// The Desktop launcher's LF endings are a REAL defect and were reported to the
// owner as an owner action, not silently dropped. If that launcher should be
// under test, the fix is to check it INTO this repo and deploy it to the
// Desktop from here -- then it is ours and this suite covers it automatically.
//
// ALSO CHANGED: the scan is no longer root-only. The previous version derived
// the list from "every *.cmd directly under ROOT", explicitly excluding tools/.
// Measured 2026-08-13: ROOT contains ZERO .cmd files. That scope was empty, so
// the out-of-repo Desktop entry was the ONLY thing keeping the "must validate
// something" guard below from firing. Meanwhile the launchers this repo really
// does ship -- including the Explorer-facing
// packages/servercontrol/Launch Control Panel.cmd -- were never looked at.
//
// The scan now covers ROOT plus the source roots this repo actually ships from,
// which is the same convention tests/spawn-hygiene.test.js (`runtimeRoots`) and
// tests/terminal-suppression.test.js (`scanRoots`) already use.
//
// A plain recursive walk of the whole tree was tried first and was WRONG, in a
// way worth recording. It picked up 81 files instead of 6, because this
// checkout also contains .claude/worktrees/*, .worktrees/*, tmp/* and
// artifacts/* -- other agents' working copies and generated output. A suite
// that reads those is not testing this repo, it is testing whatever another
// lane happens to have on disk at that moment, and it would go red for changes
// made in a worktree that was never committed. Source roots, not a bare walk.
const SOURCE_ROOTS = ['adapters', 'bin', 'docker', 'packages', 'scripts', 'sidecars', 'src', 'tools'];
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'state', 'logs', 'profiles', 'scratch']);
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

function repoBatchFiles() {
  const found = [];
  function walk(directory, recurse) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (recurse) walk(full, true);
      } else if (BATCH_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(full);
      }
    }
  }
  // Root itself, non-recursive: a launcher a user double-clicks belongs here,
  // and this is where the shelved sidecar launcher lived before its scope cut.
  walk(ROOT, false);
  for (const relative of SOURCE_ROOTS) walk(path.join(ROOT, relative), true);
  return found.sort();
}

// WHERE BARE LF ACTUALLY BREAKS A BATCH FILE.
//
// The blanket rule "every .cmd must be CRLF" is the conventional advice, but it
// is not what this repo can assert, and applying it here would have been a
// change with a real cost and no defect behind it. Two facts decide it:
//
//   1. .gitattributes sets `* -text`, disabling ALL end-of-line conversion, so
//      the bytes in the tree are the bytes committed and nothing normalises
//      them for you. Rewriting a file's endings is a genuine content change.
//   2. packages/servercontrol/servercontrol.manifest.json pins
//      "Launch Control Panel.cmd" by sha256 AND by byte count (230). Converting
//      it to CRLF changes both and invalidates the bundle manifest.
//
// So a blanket rule would demand rewriting six tracked files and regenerating a
// signed manifest to satisfy a rule none of those files need. All six are
// linear scripts -- @echo off, a couple of `set`s, one command -- and cmd.exe
// reads those identically either way.
//
// What genuinely does break is the batch parser's line handling in two shapes,
// and both are exactly detectable:
//
//   * LABELS AND GOTO. cmd.exe seeks to a label by BYTE OFFSET and re-reads
//     from there; with LF-only endings that seek can land mid-construct. This
//     is the classic silent batch corruption.
//   * MULTI-LINE PARENTHESISED BLOCKS -- `if ... (` / `for ... (` spanning
//     lines. The block is buffered and re-parsed, and LF-only input has been
//     observed to mis-terminate it.
//
// Note what this still catches: the Desktop launcher removed above hits BOTH
// (it wraps its failure path in `if not exist "%LAUNCHER%" ( ... )`). The rule
// is not weaker where it matters; it just no longer reaches outside the repo.
function isBatchComment(line) {
  return /^\s*(?:rem\b|::)/i.test(line);
}

function lineEndingSensitiveConstructs(source) {
  const code = source.split(/\r?\n/).filter(line => !isBatchComment(line));
  const reasons = [];
  if (code.some(line => /^\s*:[^:\s]/.test(line))) reasons.push('a :label');
  if (code.some(line => /\bgoto\b/i.test(line))) reasons.push('a goto');
  if (code.some(line => /\(\s*$/.test(line))) reasons.push('a multi-line ( ... ) block');
  return reasons;
}

function testBatchLineEndings() {
  console.log('🧪 Testing batch file line endings (CRLF validation)...');

  const targetFiles = repoBatchFiles();

  // A check that validates zero files passes for the wrong reason -- it
  // would look identical to a check that is actually protecting something.
  // Fail loudly instead of silently succeeding on nothing. (This guard is the
  // reason the empty root-only scope had to be fixed rather than just emptied:
  // it was already firing, and the out-of-repo file was masking it.)
  assert.ok(targetFiles.length > 0, 'No .cmd/.bat launcher files were found to validate line endings on.');

  for (const filePath of targetFiles) {
    const relative = path.relative(ROOT, filePath).replace(/\\/g, '/');
    const contentStr = fs.readFileSync(filePath).toString('binary');

    // LF characters not preceded by CR.
    const hasBareLf = /(?<!\r)\n/.test(contentStr);
    const reasons = lineEndingSensitiveConstructs(contentStr);

    if (!hasBareLf) {
      console.log(`  ✅ ${relative} — CRLF.`);
      continue;
    }
    assert.strictEqual(reasons.length, 0,
      `File ${relative} uses bare LF line endings AND contains ${reasons.join(' and ')}. ` +
      'cmd.exe seeks by byte offset and re-parses buffered blocks, so LF-only endings can ' +
      'corrupt exactly these constructs. Convert this file to CRLF.');
    console.log(`  ✅ ${relative} — LF, but linear (no label/goto/multi-line block), which cmd.exe reads identically.`);
  }
  console.log(`  Checked ${targetFiles.length} batch file(s) shipped by this repo.`);
}

testBatchLineEndings();
console.log('🎉 Line ending tests passed successfully!');
