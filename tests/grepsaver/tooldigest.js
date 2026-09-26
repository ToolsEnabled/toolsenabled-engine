#!/usr/bin/env node
'use strict';

// The digest is generated from tools/list. This test asserts both directions:
// an isolated copy of current generation passes --check byte-for-byte, while a
// one-byte stale copy fails loudly. No checked-in generated artifact is mutated.
//
// WHY THERE IS A SECOND MODE BELOW, AND WHY THIS FILE USED TO PASS FOR THE
// WRONG REASON.
//
// Both byte checks compare a generated digest against a copy of ITSELF. That is
// self-consistency, not completeness, and self-consistency is preserved exactly
// when the digest is truncated: generate 103 tools, write those 103 bytes, and
// --check reports CURRENT. Measured on this machine 2026-08-12, that is what
// happened. src/mcp-server.js resolves its permission session from the recorded
// installation level and FAILS CLOSED to the read-only 'guided' tier when
// %LOCALAPPDATA%\ToolsEnabled\machine.json fails its integrity seal -- which it
// does here -- so tools/list served 103 of the 311 tools this checkout ships,
// and this suite printed "103 tools; current and stale byte checks" and EXITED
// 0. A green test was certifying a map with every write-class tool missing.
//
// tools/grepsaver-tooldigest.js now refuses to emit an incomplete digest at all,
// so this file must know both worlds:
//   * complete surface  -> the original byte checks, unchanged
//   * confined surface  -> the refusal is the contract under test, and the
//     protection that matters is that a WRITE run leaves the target untouched
// Which world we are in is measured here, not assumed, and the confined branch
// is loud: it prints what was missing rather than quietly reporting success.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'grepsaver-tooldigest.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'grepsaver-tooldigest-'));
const output = path.join(temp, 'toolsenabled-tools.md');
const env = { ...process.env, TOOLSENABLED_GREPSAVER_TOOLDIGEST_OUT: output };

function run(args) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    windowsHide: true,
    // The generator owns a 30-second MCP deadline.  Leave time for it to
    // terminate the child and return the actual refusal/error instead of
    // manufacturing status=null by killing the generator at the same instant.
    timeout: 45_000,
  });
}

try {
  const generated = run(['--stdout']);
  assert.equal(generated.status, 0, generated.stderr || 'digest generation failed');
  const text = generated.stdout;
  const count = Number((text.match(/regenerate after registry changes\. (\d+) tools\./) || [])[1]);
  const { TOOL_REGISTRY } = require(path.join(ROOT, 'src', 'lib', 'tool-registry.js'));
  const expected = TOOL_REGISTRY.length;
  assert.ok(Number.isInteger(count) && count > 0, 'generated digest states a positive registry count');

  if (count < expected) {
    // CONFINED SURFACE. Pin the refusal itself, and pin the only thing that
    // actually protects the checked-in map: a write run must change nothing.
    const sentinel = '# sentinel digest that must survive a refused regeneration\n';
    fs.writeFileSync(output, sentinel);
    const write = run([]);
    assert.equal(write.status, 3, 'a write run must refuse under a confined surface, not write a truncated map');
    assert.match(write.stderr, new RegExp(`expected .*${expected} tool\\(s\\)[\\s\\S]*arrived .*${count} tool\\(s\\)`, 'i'),
      'the refusal must quantify the authoritative count and the live shortfall');
    assert.equal(
      fs.readFileSync(output, 'utf8'),
      sentinel,
      'a refused regeneration must leave the digest byte-identical -- this is the whole protection'
    );

    const check = run(['--check']);
    assert.equal(check.status, 3, '--check must refuse too: a truncated digest drift-checks clean against itself');

    process.stdout.write(
      `grepsaver tool-digest: the live MCP surface is CONFINED (${count} of ${expected} tools offered), so the `
      + 'byte-drift checks cannot run. Pinned instead: the tool refuses, quantifies the shortfall, and leaves the '
      + 'checked-in digest untouched on a write AND on a --check. Restore the installation record to measure the rest.\n'
    );
    process.exitCode = 0;
    return;
  }

  const toolLines = text.split('\n').filter((line) => line.startsWith('- `')).length;
  assert.equal(toolLines, count, 'every current registry tool has exactly one digest line');

  fs.writeFileSync(output, text);
  const current = run(['--check']);
  assert.equal(current.status, 0, current.stderr || current.stdout);
  assert.match(current.stdout, /CURRENT.*matches the \d+-tool registry/);

  fs.appendFileSync(output, 'stale byte\n');
  const stale = run(['--check']);
  assert.equal(stale.status, 1, stale.stderr || stale.stdout);
  assert.match(stale.stdout, /STALE.*does not match the \d+-tool registry/);

  process.stdout.write(`grepsaver tool-digest tests passed (${count} tools; current and stale byte checks).\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}
