#!/usr/bin/env node
'use strict';

// tools/grepsaver-tooldigest.js regenerates context/toolsenabled-tools.md from
// a LIVE MCP tools/list call, and that call answers through a permission tier
// resolved from local install state -- a confined tier silently drops every
// write-class tool from the wire before the generator ever sees it. Since the
// generator's own header tells the next agent to "regenerate after registry
// changes", a truncated wire would get written over the real file and then
// look self-consistent forever. MEASURED live in this checkout: a plain
// `node tools/grepsaver-tooldigest.js --stdout` returned 103 tools while
// src/lib/tool-registry.js defines 263 -- this is not a hypothetical.
//
// This suite proves the guard added to stop that: the wire's tool count must
// be checked against src/lib/tool-registry.js's own TOOL_REGISTRY.length
// (read directly, never trusted from the wire that is being checked), and a
// materially short wire must refuse to write anything at all.
//
// It never spawns the real MCP server -- that would make the test's own
// result depend on whatever permission tier happens to be recorded on
// whichever machine runs it, which is exactly the nondeterminism this guard
// exists to remove. Instead it drives the generator's
// TOOLSENABLED_GREPSAVER_TOOLDIGEST_INJECT_TOOLS test seam, which substitutes
// a JSON tool list for the real tools/list round trip.
//
// Neither context/toolsenabled-tools.md nor its .bak is read or written here:
// every run uses TOOLSENABLED_GREPSAVER_TOOLDIGEST_OUT to redirect the
// generator at an isolated temp path.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'grepsaver-tooldigest.js');
const TRUNCATED_WIRE_EXIT_CODE = 3;

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'grepsaver-tooldigest-guard-'));

try {
  // The same authoritative source the generator's guard reads from -- a bare
  // require of tool-registry.js, in this process, so this test's notion of
  // "expected" is derived exactly the way the generator derives its own,
  // rather than a number this test guesses at and could drift from.
  const { TOOL_REGISTRY } = require(path.join(ROOT, 'src', 'lib', 'tool-registry.js'));
  const expected = TOOL_REGISTRY.length;
  assert.ok(Number.isInteger(expected) && expected > 10, `tool-registry.js should define well over 10 tools; got ${expected}`);

  function syntheticTool(i, { readOnly = true } = {}) {
    return {
      name: `synthetic.tool_${i}`,
      description: `Synthetic diagnostic tool ${i}, used only by tests/grepsaver-tooldigest.test.js.`,
      annotations: readOnly ? { readOnlyHint: true } : { readOnlyHint: false, openWorldHint: true }
    };
  }

  function writeInjectedTools(name, tools) {
    const file = path.join(temp, name);
    fs.writeFileSync(file, JSON.stringify(tools));
    return file;
  }

  function run(outFile, injectFile, args = []) {
    const env = {
      ...process.env,
      TOOLSENABLED_GREPSAVER_TOOLDIGEST_OUT: outFile,
      TOOLSENABLED_GREPSAVER_TOOLDIGEST_INJECT_TOOLS: injectFile
    };
    return spawnSync(process.execPath, [TOOL, ...args], {
      cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 30_000
    });
  }

  // --- Case 1: a truncated wire, the confinement hazard --------------------
  //
  // Deliberately small and deliberately all read-only, mirroring the measured
  // real shape (a confined tier drops write-class tools first): this is well
  // under `expected` for any realistic registry size, so the shortfall is
  // unambiguous rather than an off-by-one.
  const truncatedCount = Math.min(5, Math.max(1, expected - 1));
  const truncatedFile = writeInjectedTools('truncated-tools.json',
    Array.from({ length: truncatedCount }, (_, i) => syntheticTool(i, { readOnly: true })));

  const truncatedOut = path.join(temp, 'truncated-out.md');
  const sentinel = '# pre-existing digest\nTHIS CONTENT MUST SURVIVE A REFUSED WRITE UNTOUCHED.\n';
  fs.writeFileSync(truncatedOut, sentinel);
  const beforeBytes = fs.readFileSync(truncatedOut);

  const truncatedRun = run(truncatedOut, truncatedFile);

  // Without the guard this generator would have exited 0 and overwritten the
  // file -- this is the assertion that fails without the fix.
  assert.equal(truncatedRun.status, TRUNCATED_WIRE_EXIT_CODE,
    `expected the truncated-wire refusal exit code; got status=${truncatedRun.status} stdout=${truncatedRun.stdout} stderr=${truncatedRun.stderr}`);
  assert.match(truncatedRun.stderr, /REFUSING TO WRITE/,
    `refusal must say it refused to write; stderr was: ${truncatedRun.stderr}`);
  assert.match(truncatedRun.stderr, new RegExp(String(expected)),
    `refusal must state the expected registry count (${expected}); stderr was: ${truncatedRun.stderr}`);
  assert.match(truncatedRun.stderr, new RegExp(String(truncatedCount)),
    `refusal must state how many tools actually arrived (${truncatedCount}); stderr was: ${truncatedRun.stderr}`);
  assert.match(truncatedRun.stderr, /confined\s+permission tier/i,
    `refusal must name a confined permission tier as the likely cause; stderr was: ${truncatedRun.stderr}`);

  // THE FILE MUST BE BYTE-IDENTICAL TO BEFORE THE RUN. Not "still contains
  // similar content" -- exactly the bytes it had, proving nothing was opened
  // for writing at all.
  const afterBytes = fs.readFileSync(truncatedOut);
  assert.ok(beforeBytes.equals(afterBytes),
    'the pre-existing digest must be byte-identical after a refused write');
  assert.equal(fs.readFileSync(truncatedOut, 'utf8'), sentinel, 'sanity: sentinel content unchanged');

  // A check is also a definite answer, even though it does not write. Before
  // this guard covered --check, a file generated from the same confined wire
  // could compare byte-for-byte and produce CURRENT despite never measuring
  // the missing tools.
  const truncatedCheck = run(truncatedOut, truncatedFile, ['--check']);
  assert.equal(truncatedCheck.status, TRUNCATED_WIRE_EXIT_CODE,
    `--check must refuse an incomplete wire; got status=${truncatedCheck.status} stdout=${truncatedCheck.stdout} stderr=${truncatedCheck.stderr}`);
  assert.match(truncatedCheck.stderr, /REFUSING TO VERIFY/,
    `--check refusal must say it refused to verify; stderr was: ${truncatedCheck.stderr}`);
  assert.doesNotMatch(truncatedCheck.stdout, /CURRENT/,
    '--check must not report CURRENT when wire completeness could not be established');

  // --- Case 2: a full, correct wire must still write successfully ----------
  //
  // Comfortably at-or-above the registry's own count, so this exercises the
  // ">=" boundary the guard must let through, not just an obviously huge wire.
  const fullCount = expected + 3;
  const fullFile = writeInjectedTools('full-tools.json',
    Array.from({ length: fullCount }, (_, i) => syntheticTool(i, { readOnly: i % 2 === 0 })));
  const fullOut = path.join(temp, 'full-out.md');

  const fullRun = run(fullOut, fullFile);
  assert.equal(fullRun.status, 0,
    `a full/correct wire (${fullCount} >= ${expected}) must still write successfully; stdout=${fullRun.stdout} stderr=${fullRun.stderr}`);
  assert.match(fullRun.stdout, /^wrote /, `expected a "wrote ..." confirmation; stdout was: ${fullRun.stdout}`);

  const written = fs.readFileSync(fullOut, 'utf8');
  assert.match(written, new RegExp(`${fullCount} tools\\.`), 'written digest header must state the full tool count');
  const toolLines = written.split('\n').filter((line) => line.startsWith('- `')).length;
  assert.equal(toolLines, fullCount, 'every injected tool must produce exactly one digest line');

  // --- Boundary: exactly at the registry count must also pass --------------
  const exactFile = writeInjectedTools('exact-tools.json',
    Array.from({ length: expected }, (_, i) => syntheticTool(i)));
  const exactOut = path.join(temp, 'exact-out.md');
  const exactRun = run(exactOut, exactFile);
  assert.equal(exactRun.status, 0,
    `a wire exactly matching the registry count (${expected}) must write successfully; stdout=${exactRun.stdout} stderr=${exactRun.stderr}`);

  process.stdout.write(
    `grepsaver-tooldigest truncation-guard tests passed `
    + `(registry=${expected}; refused at ${truncatedCount}; wrote at ${fullCount} and ${expected}).\n`
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}
