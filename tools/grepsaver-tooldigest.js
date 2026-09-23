#!/usr/bin/env node
// GREPSAVER tool digest — regenerates context/toolsenabled-tools.md from the
// live MCP server's tools/list, grouped by namespace, one line per tool.
//
// Why: the full tools/list is ~20K tokens and tool-registry.js is bigger; a
// model that just needs "which tool does X / is it read-only" burns thousands
// of tokens finding out. This digest answers that in ~1-2K tokens and is
// regenerated (never hand-edited), so it cannot silently drift:
//
//   node tools/grepsaver-tooldigest.js          # rewrites context/toolsenabled-tools.md
//   node tools/grepsaver-tooldigest.js --stdout # print instead of write
//
// Sanctioned by AGENT-AUGMENTATION-PLAN.md's capabilities.describe verdict:
// "a static doc read is cheaper than a new tool."
//
// THE WIRE IS NOT TRUSTED BLIND. tools/list answers through the same MCP
// server this product ships, which resolves a permission tier from local
// install state (resolvePermissionSession() in src/mcp-server.js) and narrows
// what it advertises accordingly -- a confined tier drops every write-class
// tool from the list before this script ever sees it. MEASURED on this
// checkout: a plain `node tools/grepsaver-tooldigest.js --stdout`, run with no
// special flags, returned 103 tools while src/lib/tool-registry.js defines
// 263. Regenerating from that wire, unexamined, would have overwritten this
// file's own header -- which tells the next agent to "regenerate after
// registry changes" -- with a silently truncated map, permanently, since
// nothing else checks it. So before writing, the wire count is compared
// against the registry's own count (authoritativeToolCount(), read directly
// from src/lib/tool-registry.js in THIS process, never trusted from the
// spawned child that produced the wire response); a materially short wire
// refuses to write at all rather than write something wrong. --stdout is
// deliberately left unguarded because it is diagnostic output. --check is
// guarded: otherwise a previously truncated file could compare equal to the
// same confined wire and confidently report CURRENT even though completeness
// could not be established.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { deleteEnvNames } = require('../src/lib/env-scrub.js');

const REPO = path.join(__dirname, '..');
// The output override is test-only: it lets the drift proof compare a generated
// digest with an isolated copy without mutating the checked-in artifact.
const OUT = process.env.TOOLSENABLED_GREPSAVER_TOOLDIGEST_OUT
  ? path.resolve(process.env.TOOLSENABLED_GREPSAVER_TOOLDIGEST_OUT)
  : path.join(REPO, 'context', 'toolsenabled-tools.md');

// Test-only seam, parallel to the OUT override above: a path to a JSON file
// holding an array of tool objects (the same shape tools/list resolves to).
// When set, that array stands in for a real MCP round trip entirely -- no
// child is spawned. This is what lets a test PROVE the truncation refusal
// deterministically: the real hazard lives in local machine state (a
// confined tier recorded in src/lib/setup/machine-record.js), and a test must
// not fabricate that state to exercise this script's response to it.
const INJECT_TOOLS = process.env.TOOLSENABLED_GREPSAVER_TOOLDIGEST_INJECT_TOOLS
  ? path.resolve(process.env.TOOLSENABLED_GREPSAVER_TOOLDIGEST_INJECT_TOOLS)
  : null;

// The exit code a refusal reports, distinct from --check's stale exit (1) and
// from the generic uncaught-error exit at the bottom of this file (2), so a
// caller -- or a test -- can tell "this script would have written the wrong
// thing and stopped itself" apart from an ordinary crash.
const TRUNCATED_WIRE_EXIT_CODE = 3;

function injectedToolsList() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(INJECT_TOOLS, 'utf8'));
  } catch (e) {
    throw new Error(`TOOLSENABLED_GREPSAVER_TOOLDIGEST_INJECT_TOOLS (${INJECT_TOOLS}) is not readable JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('TOOLSENABLED_GREPSAVER_TOOLDIGEST_INJECT_TOOLS must contain a JSON array of tool objects.');
  }
  return parsed;
}

// THE NUMBER THE WIRE IS CHECKED AGAINST, AND WHY IT IS NEVER THE WIRE ITSELF.
// A confined session's tools/list is exactly the thing this guard exists to
// catch, so asking that same call "was your count right?" would let a
// truncated answer vouch for itself. tool-registry.js is required directly,
// in this process, which no spawned child's resolved permission tier can
// touch -- see the file-header note for the measured gap (103 vs 263) that
// motivated this.
function authoritativeToolCount() {
  const { TOOL_REGISTRY } = require(path.join(REPO, 'src', 'lib', 'tool-registry.js'));
  if (!Array.isArray(TOOL_REGISTRY) || TOOL_REGISTRY.length === 0) {
    throw new Error('src/lib/tool-registry.js did not export a non-empty TOOL_REGISTRY; cannot verify the tools/list wire against it.');
  }
  return TOOL_REGISTRY.length;
}

function truncationRefusalMessage(expected, arrived, operation) {
  return `grepsaver-tooldigest: REFUSING TO ${operation} ${OUT}\n`
    + `  expected (src/lib/tool-registry.js TOOL_REGISTRY.length): ${expected} tool(s)\n`
    + `  arrived over the wire (MCP tools/list):                   ${arrived} tool(s)\n`
    + 'A live MCP tools/list returning materially fewer tools than the registry defines is what a confined\n'
    + 'permission tier -- or an unreadable, fail-closed install record (see resolvePermissionSession() in\n'
    + 'src/mcp-server.js) -- looks like from here. Regenerating from this wire would silently drop every\n'
    + 'missing tool, write-class tools included, from the map agents read instead of grepping. The existing\n'
    + 'file was left untouched. Re-run from a full/unrestricted permission session.\n';
}

function mcpToolsList() {
  return new Promise((resolve, reject) => {
    // The digest must ALWAYS reflect the full registry: strip any lean-profile
    // allowlist from the child env so a filtered session can never generate
    // (or "drift-detect" against) a truncated digest.
    //
    // `delete env.TOOLSENABLED_TOOL_ALLOWLIST` until 2026-08-11: exact-case, so
    // a lowercase spelling survived and a real child read the canonical name --
    // meaning the "full registry" guarantee above could silently be a truncated
    // digest that then drift-detects against itself. MEASURED.
    const env = deleteEnvNames({ ...process.env }, ['TOOLSENABLED_TOOL_ALLOWLIST']);
    // The shipped MCP entrypoint owns the shipped registry. Private owner tool
    // packs are deliberately absent from customer payloads, so requiring a
    // source-only pack loader here made digest generation fail on the exact
    // installed surface it is supposed to describe.
    const child = spawn(process.execPath, [path.join(REPO, 'src', 'mcp-server.js')], {
      cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true, shell: false,
    });
    let settled = false;
    let stderr = '';
    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      reject(error);
    };
    const resolveOnce = tools => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(tools);
    };
    const timer = setTimeout(() => {
      rejectOnce(new Error(`mcp-server timeout${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    }, 30000);
    let buf = '';
    child.stderr.on('data', chunk => {
      // Diagnostics only and bounded: never let a noisy failed child turn the
      // digest into an unbounded memory sink.
      if (stderr.length < 8192) stderr += String(chunk).slice(0, 8192 - stderr.length);
    });
    child.stdout.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2) {
          if (msg.error) rejectOnce(new Error(JSON.stringify(msg.error)));
          else resolveOnce(msg.result.tools);
        }
      }
    });
    child.on('error', rejectOnce);
    child.on('exit', (code, signal) => {
      rejectOnce(new Error(
        `mcp-server exited before tools/list completed (code ${String(code)}, signal ${String(signal)})`
        + `${stderr.trim() ? `: ${stderr.trim()}` : ''}`
      ));
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'grepsaver-digest', version: '1.0' } },
    }) + '\n');
  });
}

function firstSentence(s, max = 110) {
  const one = String(s || '').split('\n')[0];
  const dot = one.indexOf('. ');
  const cut = dot > 20 ? one.slice(0, dot + 1) : one;
  return cut.length > max ? cut.slice(0, max - 1) + '…' : cut;
}

function hints(t) {
  const a = t.annotations || {};
  const h = [];
  if (a.readOnlyHint) h.push('ro');
  if (a.readOnlyHint === false && a.openWorldHint) h.push('ext-write');
  else if (a.openWorldHint) h.push('ext');
  if (a.destructiveHint) h.push('destructive');
  return h.length ? ` [${h.join(',')}]` : '';
}

async function main() {
  const tools = INJECT_TOOLS ? injectedToolsList() : await mcpToolsList();

  // Any mode that gives a definite verdict about the tracked file is guarded.
  // In particular, --check used to compare a confined wire with the file and
  // could report CURRENT when both happened to contain the same truncated
  // surface. --stdout remains an explicitly diagnostic, non-verdict mode.
  const checking = process.argv.includes('--check');
  const requiresCompleteWire = !process.argv.includes('--stdout');
  if (requiresCompleteWire) {
    const expected = authoritativeToolCount();
    if (tools.length < expected) {
      process.stderr.write(truncationRefusalMessage(expected, tools.length, checking ? 'VERIFY' : 'WRITE'));
      process.exitCode = TRUNCATED_WIRE_EXIT_CODE;
      return;
    }
  }

  const byNs = new Map();
  for (const t of tools) {
    const ns = t.name.includes('.') ? t.name.split('.')[0] : '(root)';
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(t);
  }
  const lines = [
    '# ToolsEnabled tool digest',
    '',
    `GENERATED ${new Date().toISOString().slice(0, 10)} by \`node tools/grepsaver-tooldigest.js\` — do NOT hand-edit;`,
    `regenerate after registry changes. ${tools.length} tools. Hints: [ro]=read-only,`,
    '[ext]=reaches outside this machine (kill-switch-gated), [destructive]=hard to undo.',
    'For full input schemas use MCP tools/list or `src/lib/tool-registry.js`.',
    '',
  ];
  for (const ns of [...byNs.keys()].sort()) {
    const list = byNs.get(ns).sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`## ${ns} (${list.length})`);
    for (const t of list) lines.push(`- \`${t.name}\`${hints(t)} — ${firstSentence(t.description)}`);
    lines.push('');
  }
  const text = lines.join('\n');
  if (process.argv.includes('--stdout')) process.stdout.write(text);
  else if (process.argv.includes('--check')) {
    let current = null;
    try { current = fs.readFileSync(OUT, 'utf8'); } catch { /* reported below */ }
    if (current === text) process.stdout.write(`CURRENT — ${OUT} matches the ${tools.length}-tool registry.\n`);
    else {
      process.stdout.write(`STALE — ${OUT} does not match the ${tools.length}-tool registry. Run: node tools/grepsaver-tooldigest.js\n`);
      process.exitCode = 1;
    }
  }
  else { fs.writeFileSync(OUT, text); process.stdout.write(`wrote ${OUT} (${Buffer.byteLength(text)} B, ${tools.length} tools)\n`); }
}

main().catch((e) => { process.stderr.write(`grepsaver-tooldigest: ${e.message}\n`); process.exit(2); });
