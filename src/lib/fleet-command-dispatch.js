'use strict';
// Pre-model command boundary shared by terminal hook adapters. A non-match is
// decided before a state module is loaded. A match always produces a blocking
// response, even when the read-only child fails or reaches the deadline.
const VIEWS = new Set(['ledger', 'tasks', 'memory', 'audit', 'settings', 'status', 'help']);
const SURFACES = new Set(['codex-hook', 'gemini-hook', 'cursor-hook', 'dsh', 'opencode', 'console', 'plain']);
const SCHEMA = 'ai.toolsenabled/fleet-command/v1';
const DEADLINE_MS = 2800;
const HOOK_INPUT_MAX_BYTES = 65536;
const HOOK_INPUT_DRAIN_MS = 2000;
const FLAGS = new Set(['--offset', '--limit', '--revision', '--namespace', '--query']);
const SWITCHES = new Set(['--all']);

function envelope(fields) {
  return { schema: SCHEMA, matched: Boolean(fields.matched), view: fields.view || null,
    title: fields.title || null, text: fields.text || null, more: fields.more || null,
    error: fields.error || null };
}
function match(raw, { agentId = null, worker = false } = {}) {
  if (agentId !== null || worker || typeof raw !== 'string' || raw.length > 4096 || /[\r\n\x00-\x1f]/.test(raw))
    return { matched: false };
  const input = raw.trim();
  if (input === '/fleet') return { matched: true, view: 'help', options: [] };
  if (input === '/ledger') return { matched: true, view: 'ledger', options: [] };
  const sentinel = /^\[\[toolsenabled-fleet ([a-z]+)\]\]$/.exec(input);
  const form = /^(?:\/fleet\/|\/fleet:|\/fleet\s+|fleet\s+)([a-z][a-z0-9-]*)(?:\s+(.*))?$/.exec(input);
  const found = sentinel || form;
  if (!found) return { matched: false };
  const view = found[1];
  if (!VIEWS.has(view)) return sentinel || input.startsWith('/fleet')
    ? { matched: true, view: null, options: [], error: `Unknown Fleet view "${view.slice(0, 80)}". Try /fleet help.` }
    : { matched: false };
  const rest = form && form[2];
  if (!rest) return { matched: true, view, options: [] };
  if (!/^--?[a-z]/.test(rest)) return { matched: false };
  const tokens = rest.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) || [];
  const args = [];
  for (let at = 0; at < tokens.length;) {
    const flag = tokens[at];
    if (SWITCHES.has(flag)) { args.push(flag); at += 1; continue; }
    const value = tokens[at + 1];
    if (!FLAGS.has(flag) || !value || value.startsWith('--'))
      return { matched: true, view, options: [], error: 'Use --all or --offset, --limit, --revision, --namespace or --query with a value.' };
    if (flag === '--limit' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 20))
      return { matched: true, view, options: [], error: 'Fleet command limit must be from 1 to 20.' };
    let decoded = value;
    if (value.startsWith('"')) {
      try { decoded = JSON.parse(value); }
      catch { return { matched: true, view, options: [], error: 'A Fleet filter value is not a valid quoted string.' }; }
    } else if (value.startsWith("'") && value.endsWith("'")) decoded = value.slice(1, -1);
    args.push(flag, decoded);
    at += 2;
  }
  if (view === 'status' && args.some(value => ['--offset', '--limit', '--namespace', '--query', '--all'].includes(value)))
    return { matched: true, view, options: [], error: 'Status is one snapshot; use only --revision.' };
  return { matched: true, view, options: args };
}
function help(surface) {
  const form = name => surface === 'codex-hook' ? `/fleet/${name}`
    : surface === 'plain' ? `toolsenabled ${name} --text`
      : surface === 'console' ? name : name === 'ledger' ? '/ledger' : `/fleet ${name}`;
  const descriptions = [
    ['ledger', 'Owner requests and answers'],
    ['tasks', 'Durable queue work and results'],
    ['memory', 'Saved notes and namespaces'],
    ['audit', 'Recent events; verify explicitly'],
    ['settings', 'Effective values and sources'],
    ['status', 'Runtime, providers and safety'],
    ['help', 'This command reference']
  ];
  return ['Fleet · Help', ...descriptions.map(([name, description]) => `${form(name)} — ${description}`),
    'Ledger T records are owner requests; queue tasks are durable work jobs.',
    ...(surface === 'codex-hook' ? ['Codex reserves bare /ledger. While Codex is working, press Tab, not Enter.'] : [])].join('\n');
}
function dispatch({ input, surface = 'plain', cli, agentId = null, worker = false }, { spawn } = {}) {
  if (!SURFACES.has(surface)) throw new Error('Unknown Fleet command surface.');
  const found = match(input, { agentId, worker });
  if (!found.matched) return envelope({ matched: false });
  if (found.error) return envelope({ matched: true, view: found.view,
    title: 'Fleet · Command', text: found.error, error: found.error });
  if (found.view === 'help') return envelope({ matched: true, view: 'help', title: 'Fleet · Help', text: help(surface) });
  if (!cli) throw new Error('Fleet command needs a read-only CLI entry.');
  const runChild = spawn || require('node:child_process').spawnSync;
  // In-session views must answer within DEADLINE_MS, so status skips running
  // each agent's own sign-in check; `toolsenabled status` still shows it.
  const args = [cli, found.view, '--json', ...(found.view === 'status' ? ['--no-agents'] : ['--limit', '20']), ...found.options];
  // The view child copies state into a private directory under its TMPDIR.
  // A deadline SIGKILL skips the child's own cleanup, so the dispatcher gives
  // it a private TMPDIR and removes that after the child returns either way.
  const fs = require('node:fs');
  let scratch = null;
  let result;
  try {
    scratch = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), '.fleet-command-'));
    result = runChild(process.execPath, args, { encoding: 'utf8', timeout: DEADLINE_MS,
      killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch } });
  } catch { result = { error: { code: 'FLEET_READ_FAILED' } }; }
  finally {
    if (scratch) try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort after a kill */ }
  }
  if (result.error || result.status !== 0) {
    // A size bound is permanent; "changed, reload" would send the person in a loop.
    const tooLarge = !result.error && /\btoo large to view\b/.test(String(result.stderr || ''));
    const error = result.error?.code === 'ETIMEDOUT' ? 'Fleet view timed out. Retry the command.'
      : tooLarge ? (found.view === 'audit'
        ? 'The Fleet audit log is too large to view here (over the 64 MiB view copy limit). Reloading will not change this.'
        : 'Fleet state is too large to view here (over the 256 MiB view copy limit). Reloading will not change this.')
        : 'Fleet view unavailable or changed. Reload the view and try again.';
    return envelope({ matched: true, view: found.view, title: 'Fleet · View unavailable', text: error, error });
  }
  try {
    const page = JSON.parse(result.stdout);
    const rendered = require('./fleet-text-view').render(found.view, page, { surface });
    return envelope({ matched: true, view: found.view, ...rendered });
  } catch {
    const error = 'Fleet view returned an invalid snapshot. Reload the view and try again.';
    return envelope({ matched: true, view: found.view, title: 'Fleet · View unavailable', text: error, error });
  }
}
function emit(surface, result) {
  if (surface === 'codex-hook') return result.matched ? JSON.stringify({ decision: 'block', reason: result.text }) : '';
  if (surface === 'gemini-hook') return result.matched ? JSON.stringify({ decision: 'deny', reason: result.text }) : '{}';
  if (surface === 'cursor-hook') return JSON.stringify(result.matched
    ? { continue: false, user_message: result.text } : { continue: true });
  return JSON.stringify(result);
}
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function readHookInput({ drainMs = HOOK_INPUT_DRAIN_MS } = {}) {
  const fs = require('node:fs');
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  let bytes = 0;
  let oversized = false;
  const deadline = Date.now() + drainMs;
  for (;;) {
    let count;
    try { count = fs.readSync(0, buffer, 0, buffer.length); }
    catch (error) {
      // A non-blocking stdin has no data yet; wait within the same budget.
      if (error.code !== 'EAGAIN' || Date.now() > deadline) throw error;
      pause(5);
      continue;
    }
    if (!count) break;
    bytes += count;
    if (bytes > HOOK_INPUT_MAX_BYTES) oversized = true;
    // An oversized envelope is never parsed, but it is read and discarded to
    // EOF so the client's write completes instead of failing with EPIPE.
    // Draining is bounded by time; the result is a non-match either way.
    if (oversized) { if (Date.now() > deadline) break; continue; }
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  if (oversized) throw new Error('Fleet hook input exceeds 64 KiB.');
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Fleet hook input must be an object.');
  return { input: value.prompt || value.user_prompt || value.invocation?.rawInput || '',
    agentId: Object.hasOwn(value, 'agent_id') ? String(value.agent_id ?? '') : null };
}
function command(argv, cli) {
  let input;
  let surface = 'plain';
  let stdin = false;
  let clientEmit = false;
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    if (flag === '--emit') clientEmit = true;
    else if (flag === '--stdin-hook-json') stdin = true;
    else if (flag === '--input' || flag === '--surface') {
      const value = argv[++at];
      if (value === undefined) throw new Error(`${flag} needs a value.`);
      if (flag === '--input') input = value; else surface = value;
    } else throw new Error('Unknown fleet-command option.');
  }
  if (!SURFACES.has(surface)) throw new Error('Unknown Fleet command surface.');
  if (stdin === (input !== undefined)) throw new Error('Give exactly one of --input or --stdin-hook-json.');
  let hook = {};
  try { if (stdin) hook = readHookInput(); }
  catch {
    // An invalid envelope cannot prove a Fleet command. Let the client pass
    // the original prompt through; blocking here would swallow ordinary work.
    const printed = clientEmit ? emit(surface, envelope({ matched: false }))
      : JSON.stringify(envelope({ matched: false }));
    if (printed) process.stdout.write(`${printed}\n`);
    return;
  }
  const result = dispatch({ input: stdin ? hook.input : input, surface, cli,
    agentId: hook.agentId, worker: process.env.TOOLSENABLED_FLEET_WORKER === '1' });
  const printed = clientEmit ? emit(surface, result) : JSON.stringify(result);
  if (printed) process.stdout.write(`${printed}\n`);
}
module.exports = Object.freeze({ match, envelope, dispatch, emit, command, DEADLINE_MS });
