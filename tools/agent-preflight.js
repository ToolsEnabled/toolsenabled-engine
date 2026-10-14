'use strict';

// WHAT CAN I ACTUALLY DO RIGHT NOW, AND WHO ELSE IS ALREADY DOING IT.
//
// One bounded call, no MCP, no network, no provider. Read-only.
//
// WHY THIS EXISTS (measured 2026-07-29, session d4ca9820):
// The owner had a Codex session building a machine-to-machine bridge, switched
// to Claude, and expected Claude to find that work and continue it. Instead the
// session burned 363 assistant turns on 204 tool calls -- 39 greps and 41 reads
// -- and never found it. Three separate things went wrong, and none of them
// were the model being lazy:
//
//   1. STATIC CONFIGURATION IS NOT THE CURRENT CLIENT SURFACE.
//      `.mcp.json` and user-level config describe what a future client may
//      start. They do not prove that this already-running client loaded a
//      server or completed its tools/list handshake. The old output called
//      every declaration LIVE, which sent agents toward a namespace that the
//      current client might not advertise at all. This tool now reports
//      DECLARED/UNVERIFIED; only the current client's tool list is live
//      advertisement evidence.
//
//   2. THE DUAL-PREFIX TRAP. task.list, memory.search and system.status
//      exist on BOTH servers. When both namespaces are advertised, the
//      readonly copies work. A session that calls an unadvertised prefix gets
//      "not connected" and must report that gap instead of guessing.
//
//   3. NOTHING POINTED AT `~/.codex/session_index.jsonl`. That file's last line
//      said `thread_name: "Build agent communication bridge"`, updated minutes
//      earlier. The answer to "what is Codex doing" was one file read away.
//
// The pattern to kill: when a capability appears missing, agents reverse-engineer
// the provider instead of reporting the gap. That session ended up requiring
// google.js and hand-rolling authenticatedRequest() because `gmail.list` was
// unreachable and no gmail thread-read tool exists at all.
//
// Usage:
//   node tools/agent-preflight.js            human-readable
//   node tools/agent-preflight.js --json     machine-readable
//   node tools/agent-preflight.js --quiet    only problems

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const runtimeState = require('../src/lib/runtime-state-root');

const REPO = path.resolve(__dirname, '..');

// Tests may supply a sterile, in-sandbox declaration without teaching this
// read-only diagnostic to consult a person's real home directory.  The
// override is deliberately unavailable outside the isolated test harness and
// must itself remain below that harness's root; this is a fixture seam, not a
// second project-configuration mechanism.
function isolatedFixturePath(name, fallback) {
  const candidate = process.env[name];
  const root = process.env.TOOLSENABLED_TEST_ROOT;
  if (process.env.TOOLSENABLED_TEST_ISOLATED !== '1' || !candidate || !root) return fallback;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) ? resolved : fallback;
}

const HOME = isolatedFixturePath('TOOLSENABLED_PREFLIGHT_HOME', os.homedir());
const PROJECT_MCP_FILE = isolatedFixturePath(
  'TOOLSENABLED_PREFLIGHT_MCP_CONFIG_FILE',
  path.join(REPO, '.mcp.json')
);
const ACTIVE_WINDOW_MS = 90 * 60_000; // "recently active" for another session
const INTENT_SCAN_BYTES = 256 * 1024; // head of a transcript is enough for its opening ask
const SINGLE_COPY_CHECK = path.join(REPO, 'tools', 'check-single-copy-work.js');
const SINGLE_COPY_TIMEOUT_MS = 3_000; // preserve the SessionStart hook's 5s budget

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const quiet = argv.includes('--quiet');
// --hook emits the SessionStart envelope so the harness injects this automatically.
// The whole point: no session should have to remember to ask.
const asHook = argv.includes('--hook');

// --topic <x>: "has anyone already done this?"
//
// CLAUDE.md has instructed every session to run `node tools/agent-preflight.js
// --topic <x>` — and until now this file parsed no such flag. `--topic
// trademark` ran the default preflight, printed not one word about trademarks,
// and exited 0. A documented flag that is silently ignored is worse than a
// missing one: the session believes it asked the question and got an answer.
function readTopic(args) {
  const at = args.indexOf('--topic');
  if (at === -1) return null;
  const words = [];
  for (let i = at + 1; i < args.length; i += 1) {
    if (args[i].startsWith('--')) break;
    words.push(args[i]);
  }
  return words.join(' ').trim() || null;
}
const topic = readTopic(argv);
const topicRequested = argv.includes('--topic');

/**
 * Ask the derived prior-work index whether this topic already has documents.
 *
 * Fails OPEN, like the other orientation checks here — but an error is reported
 * as UNKNOWN and never as "no prior work". Those are different claims, and
 * collapsing them is the exact defect this section was added to close.
 */
function priorWork(forTopic) {
  if (!topicRequested) return null;
  if (!forTopic) {
    return { state: 'UNKNOWN', reason: 'EMPTY_TOPIC', topic: null, results: [],
      message: '--topic was given with no topic text.' };
  }
  try {
    const result = require('./prior-work-index').query(forTopic, { limit: 6 });
    return {
      state: result.outcome.toUpperCase(),
      reason: result.reason,
      topic: forTopic,
      indexedFileCount: result.indexedFileCount,
      totalCandidates: result.totalCandidates || 0,
      results: (result.results || []).map(r => ({ path: r.path, title: r.title, modified: r.modified })),
      message: result.why || null
    };
  } catch (error) {
    return { state: 'UNKNOWN', reason: 'PRIOR_WORK_INDEX_FAILED', topic: forTopic, results: [],
      message: `the prior-work index could not be consulted: ${error.message}. `
        + 'This is NOT a finding that the topic is unexplored.' };
  }
}

function priorWorkLines(pw) {
  const L = [];
  if (pw.state === 'HIT') {
    L.push(`## ⚠ PRIOR WORK EXISTS — "${pw.topic}"`);
    L.push(`  ${pw.totalCandidates} document(s) already address this. READ THESE BEFORE STARTING.`);
    for (const r of pw.results) L.push(`    ${r.modified}  ${r.path}`);
    L.push('  Full list: `node tools/prior-work.js --limit 20 "' + pw.topic + '"`');
  } else if (pw.state === 'MISS') {
    L.push(`## Prior work  ✓ none on "${pw.topic}"`);
    L.push(`  ${pw.indexedFileCount} files read end to end; this is a genuine gap, not a failed lookup.`);
    L.push('  Write your result into docs/ or reports/ and the next session finds it automatically.');
  } else {
    L.push(`## ⚠ PRIOR WORK — UNKNOWN for "${pw.topic ?? '(none given)'}"`);
    L.push(`  ${pw.message}`);
    L.push('  Do NOT read this as "nothing exists". Check by hand before redoing any work.');
  }
  return L;
}

function readJson(file) {
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null }; }
  catch (error) { return { value: null, error: error && error.message ? error.message : String(error) }; }
}

function readJsonl(file, limit = 0) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
    const slice = limit > 0 ? lines.slice(-limit) : lines;
    const rows = [];
    let invalidLines = 0;
    for (const line of slice) {
      try { rows.push(JSON.parse(line)); } catch { invalidLines += 1; }
    }
    return { rows, error: invalidLines ? `${invalidLines} JSONL line(s) could not be parsed` : null };
  } catch (error) {
    return { rows: [], error: error && error.message ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// 0. Single-copy work: the already-built stranded-work detector, now on the
//    production preflight path rather than waiting for an agent to remember it.
//
// Deliberately fail OPEN here -- the opposite of the fail-closed enforcement
// guards elsewhere in this repo. This tool is session orientation, so a broken,
// missing, or slow advisory must be reported as INDETERMINATE without blocking
// the rest of preflight or preventing a session from starting.
// ---------------------------------------------------------------------------
function indeterminateSingleCopy(code, reason, startedAt) {
  return {
    status: 'indeterminate',
    exitCode: 2,
    root: REPO,
    durationMs: Date.now() - startedAt,
    code,
    reason,
    findings: [],
    advisories: [],
    summary: `could not determine: ${reason}`,
    source: 'agent-preflight'
  };
}

function singleCopyWork() {
  const startedAt = Date.now();
  if (!fs.existsSync(SINGLE_COPY_CHECK)) {
    return indeterminateSingleCopy(
      'SINGLE_COPY_CHECK_MISSING',
      `detector is missing at ${SINGLE_COPY_CHECK}`,
      startedAt
    );
  }

  let child;
  try {
    child = spawnSync(process.execPath, [SINGLE_COPY_CHECK, '--json', '--root', REPO], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: SINGLE_COPY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: safeLaunchEnvironment(process.env, { context: 'agent-preflight single-copy check' })
    });
  } catch (error) {
    return indeterminateSingleCopy(
      'SINGLE_COPY_CHECK_ERROR',
      `detector threw: ${error && error.message ? error.message : String(error)}`,
      startedAt
    );
  }

  if (child.error) {
    const timedOut = child.error.code === 'ETIMEDOUT';
    return indeterminateSingleCopy(
      timedOut ? 'SINGLE_COPY_CHECK_TIMEOUT' : 'SINGLE_COPY_CHECK_ERROR',
      timedOut
        ? `detector exceeded the ${SINGLE_COPY_TIMEOUT_MS}ms preflight budget`
        : `detector could not run: ${child.error.message || child.error.code || 'unknown spawn error'}`,
      startedAt
    );
  }

  let parsed = null;
  try { parsed = JSON.parse(child.stdout || ''); } catch { parsed = null; }
  const expectedExit = parsed && { clean: 0, stranded: 1, indeterminate: 2 }[parsed.status];
  if (!parsed || expectedExit === undefined || parsed.exitCode !== expectedExit || child.status !== expectedExit) {
    const detail = (child.stderr || child.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return indeterminateSingleCopy(
      'SINGLE_COPY_CHECK_CONTRACT_INVALID',
      `detector did not return its clean/stranded/indeterminate contract${detail ? `: ${detail}` : ''}`,
      startedAt
    );
  }

  return {
    ...parsed,
    source: 'check-single-copy-work',
    preflightDurationMs: Date.now() - startedAt
  };
}

function singleCopyOutputLines(result) {
  const lines = [];
  if (result.status === 'indeterminate') {
    lines.push(`  INDETERMINATE (${result.code || 'UNKNOWN'}) -- ${result.reason || result.summary}`);
    lines.push('  Preflight continues: this orientation check deliberately fails open.');
    return lines;
  }

  if (result.status === 'stranded') {
    lines.push('  WARNING: STRANDED WORK exists only in this working copy; preflight remains advisory.');
    for (const finding of result.findings || []) {
      lines.push(`    - ${finding.detail}`);
      if (finding.examples && finding.examples.length) lines.push(`      e.g. ${finding.examples.join(' | ')}`);
    }
  } else {
    lines.push(`  clean -- no stranded commits or untracked files (${result.durationMs}ms)`);
  }

  if (result.advisories && result.advisories.length) {
    lines.push('  note -- uncommitted tracked edits are advisory and do not affect status:');
    for (const advisory of result.advisories) {
      lines.push(`    - ${advisory.detail}`);
      if (advisory.examples && advisory.examples.length) lines.push(`      e.g. ${advisory.examples.join(' | ')}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 0.5. Open-gates digest freshness (R1162 P1, R-coherence review C4/C1).
//
// SESSION-BOOT step 2 sends every agent to reports/OPEN-GATES.md, generated
// once from the ledger and then left on disk. A stale digest is invisible by
// default: the file looks exactly like a fresh one. This session's own
// history is the evidence for why that is dangerous -- OPEN-GATES.md sat one
// full R1162 append behind (46 unmet gates missing) for hours before an
// unrelated review caught it by accident. This check makes staleness loud
// instead of silent, matching the digest's own stamp format written by
// tools/ledger-query.js's renderOpenGatesDigest/stampLedgerRevision.
// ---------------------------------------------------------------------------
// R1162 P1 originally kept this check inline here, reachable only by an agent
// remembering to run this tool by hand -- and it measured stale in this same
// session before anyone noticed. 2026-08-10: extracted to
// src/lib/open-gates-freshness.js so a second caller (an advisory
// .githooks/pre-push check; see tools/check-open-gates-freshness.js) shares
// the identical verdict instead of forking the detection logic.
const { checkOpenGatesFreshness } = require('../src/lib/open-gates-freshness');

function openGatesFreshness() {
  return checkOpenGatesFreshness();
}

function singleCopyHookContext(result) {
  if (result.status === 'stranded') {
    const details = (result.findings || []).map(f => f.detail).join('; ');
    return `SINGLE-COPY WARNING: STRANDED WORK. ${details} Preflight is advisory and remains exit 0.`;
  }
  if (result.status === 'indeterminate') {
    return `SINGLE-COPY CHECK INDETERMINATE (${result.code || 'UNKNOWN'}): ${result.reason || result.summary}. `
      + 'Do not treat this as clean; the orientation preflight deliberately failed open.';
  }
  if (result.advisories && result.advisories.length) {
    const details = result.advisories.map(a => a.detail).join('; ');
    return `SINGLE-COPY ADVISORY (non-blocking): ${details}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. MCP reality: what is declared, and what can be proven dead locally.
//
// This process intentionally makes no MCP call.  A declaration in .mcp.json
// is therefore not proof that the current client loaded, started, or
// advertised that server.  Keep that distinction explicit: the client owns
// the live tools/list handshake, and only the client can show its own current
// namespace.
// ---------------------------------------------------------------------------
function mcpReality() {
  const out = {
    declared: {},
    // Kept as a compatibility field for older consumers.  This no-MCP
    // preflight never populates it: configuration is not a live connection.
    live: [],
    unverified: [],
    dead: [],
    notes: [
      'This preflight is configuration-only; it cannot verify the current MCP client loaded or advertised a server.'
    ],
    connectionEvidence: 'configuration-only'
  };

  const addDeclared = (name, value) => {
    out.declared[name] = { ...value, connection: 'unverified' };
    if (!out.unverified.includes(name)) out.unverified.push(name);
  };

  const projectMcpRead = readJson(PROJECT_MCP_FILE);
  const projectMcp = projectMcpRead.value;
  if (projectMcpRead.error) out.notes.push(`Could not read .mcp.json: ${projectMcpRead.error}`);
  for (const [name, cfg] of Object.entries((projectMcp && projectMcp.mcpServers) || {})) {
    const allowlist = cfg && cfg.env && cfg.env.TOOLSENABLED_TOOL_ALLOWLIST
      ? cfg.env.TOOLSENABLED_TOOL_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean)
      : null;
    addDeclared(name, { source: '.mcp.json', allowlist, args: (cfg && cfg.args) || [] });
  }

  // A per-project override in ~/.claude.json can add or disable servers.
  const claudeJsonRead = readJson(path.join(HOME, '.claude.json'));
  const claudeJson = claudeJsonRead.value;
  if (claudeJsonRead.error) out.notes.push(`Could not read ~/.claude.json: ${claudeJsonRead.error}`);
  const projects = (claudeJson && claudeJson.projects) || {};
  const key = Object.keys(projects).find(k => path.resolve(k).toLowerCase() === REPO.toLowerCase());
  if (key) {
    const p = projects[key] || {};
    for (const name of Object.keys(p.mcpServers || {})) {
      if (!out.declared[name]) addDeclared(name, { source: '~/.claude.json', allowlist: null });
    }
    for (const name of p.disabledMcpjsonServers || []) {
      if (out.declared[name]) out.declared[name].connection = 'disabled';
      out.unverified = out.unverified.filter(n => n !== name);
      out.dead.push({ server: name, why: 'listed in disabledMcpjsonServers' });
    }
  }

  // A user-level (root) registration counts too, and on this machine that is
  // exactly where the write server lives. Missing this is what made the first
  // version of this file report "not configured" about a server that is very
  // much configured -- a confidently wrong answer of the same kind it exists to
  // prevent.
  for (const [name, cfg] of Object.entries((claudeJson && claudeJson.mcpServers) || {})) {
    if (!out.declared[name]) {
      addDeclared(name, {
        source: '~/.claude.json (user-level)', allowlist: null, args: (cfg && cfg.args) || []
      });
    }
  }

  // Being DECLARED is not being CONNECTED. The write server is registered here
  // but launches tools/mcp-owner-proxy.js, which brokers through the app-owned
  // per-instance owner-host pipe and fails closed when that host is absent. The
  // public route contains no bind/revoke authority; it names only this app
  // instance's random pipe and generation.
  const proxied = Object.entries(out.declared)
    .filter(([, cfg]) => /mcp-owner-proxy/.test(JSON.stringify(cfg.args || [])));
  if (proxied.length) {
    const capFile = runtimeState.statePath('state', 'owner-host-capability.json');
    const hasCapability = fs.existsSync(capFile);
    let pipeUp = null;
    let pipeError = null;
    try {
      if (hasCapability) {
        const route = JSON.parse(fs.readFileSync(capFile, 'utf8'));
        if (!route || route.version !== 2 || typeof route.pipeName !== 'string'
            || !route.pipeName.startsWith('\\\\.\\pipe\\ToolsEnabled.OwnerHost.V2.')) {
          throw new Error('the app-owned route record is malformed');
        }
        const expectedPipe = route.pipeName.slice('\\\\.\\pipe\\'.length);
        pipeUp = fs.readdirSync('\\\\.\\pipe\\').includes(expectedPipe);
      }
    } catch (error) {
      pipeError = error && error.message ? error.message : String(error);
    }
    out.ownerHost = { capabilityFile: hasCapability, pipeListening: pipeUp, pipeMeasurementError: pipeError };
    if (pipeError) {
      out.notes.push(`Owner-host pipe state could not be measured: ${pipeError}`);
    }
    if (hasCapability && pipeUp === false) {
      for (const [name] of proxied) {
        if (out.declared[name]) out.declared[name].connection = 'dead';
        out.unverified = out.unverified.filter(n => n !== name);
        out.dead.push({
          server: name,
          why: 'DECLARED but NOT CONNECTED. Its proxy (tools/mcp-owner-proxy.js) brokers through the '
            + 'app-owned owner-host named pipe. Its current route exists, so the proxy tries the '
            + 'pipe and fails closed -- but NO owner-host process is running and no pipe is listening, '
            + 'so it exits 1 silently. Every mcp__' + name + '__* call returns "is not connected". '
            + 'Close ToolsEnabled completely and open it again: the signed-in app owns this host, and '
            + 'there is no scheduled-task, alternate-account, or direct-server recovery path.'
        });
      }
    }
  }
  return out;
}

// For a tool that exists on both servers, name the prefix that actually works.
function prefixGuidance(mcp) {
  const ro = mcp.declared['toolsenabled-readonly'];
  if (!ro || !ro.allowlist) return null;
  const writeDead = mcp.dead.some(d => d.server === 'toolsenabled');
  return {
    liveReadonlyTools: ro.allowlist.length,
    coordinationTools: ro.allowlist.filter(t => /^(task|audit|memory|system)\./.test(t)),
    rule: writeDead
      ? 'Use mcp__toolsenabled-readonly__<tool_with_underscores>. The unprefixed mcp__toolsenabled__* '
        + 'namespace is registered but NOT connected -- calling it wastes a turn.'
      : 'Both namespaces are registered, but this no-MCP preflight cannot verify the current client advertised either one; prefer the readonly one for reads when that namespace is present.'
  };
}

// ---------------------------------------------------------------------------
// 2. Who else is already working (the question that was unanswerable)
// ---------------------------------------------------------------------------
function codexSessions(now) {
  const file = path.join(HOME, '.codex', 'session_index.jsonl');
  const measurement = readJsonl(file);
  return {
    error: measurement.error,
    sessions: measurement.rows
    .map(r => ({
      id: r.id,
      name: r.thread_name || '(unnamed)',
      updatedAt: r.updated_at || null,
      ageMs: r.updated_at ? now - Date.parse(r.updated_at) : null
    }))
    .filter(r => Number.isFinite(r.ageMs))
    .sort((a, b) => a.ageMs - b.ageMs)
    .slice(0, 8)
  };
}

function claudeSessions(now) {
  // Transcript directory name: drive letter lowercased, ':' and separators -> '-'.
  const slug = REPO.replace(/[\\/:]/g, '-').replace(/^([A-Za-z])/, m => m.toLowerCase());
  const dir = path.join(HOME, '.claude', 'projects', slug);
  let entries = [];
  const measurementErrors = [];
  try {
    entries = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(dir, f);
        let stat = null;
        try { stat = fs.statSync(full); }
        catch (error) {
          measurementErrors.push(`${f}: ${error && error.message ? error.message : String(error)}`);
          return null;
        }
        return { id: f.replace(/\.jsonl$/, ''), file: full, ageMs: now - stat.mtimeMs, bytes: stat.size };
      })
      .filter(Boolean)
      .sort((a, b) => a.ageMs - b.ageMs)
      .slice(0, 6);
  } catch (error) {
    return { sessions: [], error: error && error.message ? error.message : String(error) };
  }

  // The opening ask is the cheapest honest summary of what a session is for.
  // Only the HEAD of each transcript is read: these files reach 30 MB, this runs
  // inside a 5-second SessionStart hook, and the first user message is always
  // near the top. A truncated tail just means no intent for that session.
  for (const e of entries) {
    e.intent = null;
    try {
      const fd = fs.openSync(e.file, 'r');
      const buf = Buffer.alloc(Math.min(INTENT_SCAN_BYTES, e.bytes));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const lines = buf.slice(0, read).toString('utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let o = null;
        try { o = JSON.parse(line); } catch { continue; }
        if (!o || o.type !== 'user' || !o.message) continue;
        let text = null;
        if (typeof o.message.content === 'string') text = o.message.content;
        else if (Array.isArray(o.message.content)) {
          const t = o.message.content.find(c => c && c.type === 'text');
          if (t) text = t.text;
        }
        if (!text) continue;
        // Skip harness wrappers, slash-command bodies and tool-result echoes.
        if (text.startsWith('<') || text.startsWith('Caveat') || text.startsWith('# /') || text.length < 40) continue;
        e.intent = text.replace(/\s+/g, ' ').slice(0, 160);
        break;
      }
    } catch (error) {
      e.intentError = error && error.message ? error.message : String(error);
      measurementErrors.push(`${e.id}: ${e.intentError}`);
    }
    delete e.file;
  }
  return { sessions: entries, error: measurementErrors.length ? measurementErrors.join('; ') : null };
}

// ---------------------------------------------------------------------------
// 3. In-flight local machinery, read straight off disk
// ---------------------------------------------------------------------------
function inFlight(now) {
  const out = { measurements: {} };

  const fleetRead = readJson(path.join(REPO, 'state', 'fleet-supervisor.json'));
  const fleet = fleetRead.value;
  out.measurements.fleetSupervisor = fleetRead.error
    ? { state: 'INDETERMINATE', reason: fleetRead.error }
    : { state: 'MEASURED' };
  if (fleet && fleet.supervisor) {
    const hbAge = now - Date.parse(fleet.supervisor.heartbeatAt || 0);
    const items = Object.values(fleet.items || {});
    const cond = {};
    for (const i of items) cond[i.condition] = (cond[i.condition] || 0) + 1;
    out.fleetSupervisor = {
      pid: fleet.supervisor.pid,
      alive: Number.isFinite(hbAge) && hbAge < 180_000,
      heartbeatAgeSec: Number.isFinite(hbAge) ? Math.round(hbAge / 1000) : null,
      items: cond,
      running: Object.values(fleet.lanes || {}).filter(l => l.status === 'running').length
    };
  }

  out.ownerInbox = {
    disabled: true,
    unread: 0,
    fromOwner: 0,
    drainCommand: 'DISABLED',
    note: 'The former external owner inbox is retired. There is no bridge, bot, or external inbox to poll or drain.'
  };

  const managedRead = readJson(path.join(REPO, 'config', 'managed-processes.json'));
  if (managedRead.error) {
    out.managedProcesses = {
      state: 'INDETERMINATE',
      note: `Managed-process configuration could not be read: ${managedRead.error}`
    };
  } else {
    const declared = managedRead.value && managedRead.value.processes ? Object.keys(managedRead.value.processes) : [];
    out.managedProcesses = {
      state: 'CONFIGURED',
      note: `${declared.length} managed process(es) declared by the current registry.`
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
const now = Date.now();
const mcp = mcpReality();
const singleCopy = singleCopyWork();
const codexSessionMeasurement = codexSessions(now);
const claudeSessionMeasurement = claudeSessions(now);
// WHICH TREE AM I IN. Computed, never written down, because writing it down is
// what failed.
//
// On 2026-08-10 a status report was produced against the retired legacy
// ToolsEnabled checkout -- 353 test files, last commit 2026-08-08 -- while the canonical
// tree had 748 test files and was being committed to that same day. Its
// conclusions were stale on arrival and its author did nothing wrong: that
// checkout's README said "all new development must target canonical Machine B",
// its CLAUDE.md said the canonical source is `engine-checkout` on THIS
// machine, and this tool printed a third answer from a hardcoded frozen constant.
// Three hand-maintained copies of one fact, disagreeing.
//
// The fact is already registered: config/service-registry.json /machines carries
// each machine's declared checkout root. So the honest test is a comparison, not
// a sentence an agent has to read and believe -- if the tree this process is
// running in is not a declared root, it is not a canonical tree, and no prose
// anywhere can make that false. Describe the fact or read it; never retype it.
// treeIdentity() used to be implemented right here. It now lives in
// src/lib/tree-identity.js because the AUTOMATIC SessionStart onboarding packet
// (src/lib/agent-onboarding.js) needs the identical verdict, and this tool only
// runs when a session remembers to run it -- which is precisely the failure mode
// the check exists to prevent. Two consumers, one implementation: a forked copy
// would drift and recreate the original defect one level down. Do not re-inline
// it here.
const { treeIdentity, NON_CANONICAL_GUIDANCE } = require('../src/lib/tree-identity');

// WHO MAY THIS SESSION ACT AS. Measured 2026-08-11: agents kept reaching an
// identity-bearing action (create the org, register the account, publish under
// his name), finding no machine-readable statement that the owner authorized
// it, and stopping -- one lane stopped 18 times on 18 attempts. The
// authorization was real every time and lived only in conversation prose, which
// does not survive a session boundary. The owner's fix, in his words: "this has
// to be read off from settings or something to agents clearly".
//
// This is the surface that carries it, because this tool is mandatory before
// any work. The reservations ride with the grant from the same renderer, so a
// surface cannot show one without the other -- a record that authorizes without
// reserving is the dangerous half of this feature.
const { readAuthorization, authorizationProjection, authorizationLines, authorizationHeadline } = require('../src/lib/owner-authorization');

// WHICH LEDGER HOLDS HIS REQUIREMENTS. treeIdentity above answers "is this the
// canonical CHECKOUT". This answers the narrower question that actually bit:
// this machine holds two owner-request ledgers, and 16 shared ids mean
// DIFFERENT requests on the two sides (measured 2026-08-11). A session that
// cites "R133" without naming the tree is ambiguous, and a session that
// captures owner words into the retired copy has written them where nothing
// reads them. Two JSON reads; cheap enough to run unconditionally, and the
// point of running it here is that a session learns it BEFORE it cites or
// captures, not after.
const ledgerAuthority = require('./ledger-authority');

function ledgerAuthorityProjection() {
  try {
    const result = ledgerAuthority.compare();
    return {
      state: !result.authoritative ? 'UNREADABLE' : result.fork ? 'FORKED' : 'SINGLE',
      authoritative: result.authoritative
        ? { root: result.authoritative.root, count: result.authoritative.count, revision: result.authoritative.revision }
        : null,
      findings: result.findings.map(f => ({ label: f.label, count: f.count, onlyThere: f.onlyHere.length, divergent: f.divergent.length }))
    };
  } catch (error) {
    // A preflight section that throws would take the whole packet with it, and
    // an unknown answer must not read as a clean one.
    return { state: 'INDETERMINATE', authoritative: null, findings: [], reason: error && error.message };
  }
}

function ledgerAuthorityMessage(projection) {
  if (projection.state === 'SINGLE') return null;
  if (projection.state === 'UNREADABLE') return 'OWNER-REQUEST LEDGER: the authoritative ledger could not be read. Do not cite or capture owner requests until it is; run `node tools/ledger-authority.js`.';
  if (projection.state === 'INDETERMINATE') return `OWNER-REQUEST LEDGER: authority could not be determined (${projection.reason}). Treat an R-id as ambiguous until \`node tools/ledger-authority.js\` says otherwise.`;
  const worst = projection.findings.filter(f => f.onlyThere || f.divergent);
  const detail = worst.map(f => `${f.label}: ${f.divergent} id(s) mean something DIFFERENT there, ${f.onlyThere} never merged`).join(' | ');
  return 'OWNER-REQUEST LEDGER FORKED: more than one ledger exists on this machine, so an R-id alone is ambiguous — always cite tree AND id. '
    + `Authoritative: ${projection.authoritative ? `${projection.authoritative.root} (${projection.authoritative.count} requests, revision ${projection.authoritative.revision})` : 'unknown'}. ${detail}. `
    + 'Capture owner words ONLY into the authoritative ledger. Details: `node tools/ledger-authority.js`.';
}

// BUILD-QUEUE PROVENANCE. The ledger fork above is only half the problem: a
// queue phase can also cite an R-id that has never existed. Measured
// 2026-08-11 -- BUILD-QUEUE.md's Q116 points at
// `docs/design/RELAY-DECISION-R1228.md`, and the ledger goes R1227 -> R1230.
// R1228 is an agent-authored decision wearing the owner's voice, and it is the
// same phantom id the purchase cart cited as its authority. In the other
// direction, 430 of 493 unfinished directives are named by no phase at all.
// Both facts belong here for the same reason the fork does: a session needs
// them BEFORE it cites a queue item as owner authority, not after.
const queueProvenance = require('../src/lib/build-queue-provenance');
const buildQueueCorpus = require('../src/lib/build-queue-corpus');

function queueProvenanceProjection() {
  try {
    const corpus = buildQueueCorpus.readQueueCorpus(path.join(REPO, 'BUILD-QUEUE.md'));
    const sources = [{ file: 'BUILD-QUEUE.md', markdown: corpus.rootText }]
      .concat(corpus.slices.map(slice => ({ file: slice.path, markdown: slice.text })));
    const ledger = JSON.parse(fs.readFileSync(path.join(REPO, 'reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8'));
    const result = queueProvenance.auditQueueProvenance({ sources, ledger });
    return {
      state: result.errorCount ? 'UNSOURCED' : 'SOURCED',
      phantomRids: result.phantomRids,
      errorCount: result.errorCount,
      phaseCount: result.phaseCount,
      orphanDirectiveCount: result.orphanDirectiveCount,
      actionableDirectiveCount: result.actionableDirectiveCount
    };
  } catch (error) {
    // Same rule as the ledger section: an unknown answer must not read as a
    // clean one, and a throwing section must not take the packet with it.
    return { state: 'INDETERMINATE', phantomRids: [], reason: error && error.message };
  }
}

// Terse by obligation, not by preference: this string is injected into every
// session and tests/agent-preflight.js caps the whole packet at 4000 chars, of
// which the other sections already spend ~3850. One line, the two numbers that
// change behaviour, and where to look.
function queueProvenanceMessage(projection) {
  if (projection.state === 'INDETERMINATE') {
    return 'BUILD-QUEUE PROVENANCE UNKNOWN: a queue R-id is unverified, not verified. `node tools/build-queue-provenance.js`';
  }
  // One clause, worst first. Both facts are always in --json and in the CLI;
  // the hook only has room for the one that should change the next action.
  if (projection.phantomRids.length) {
    return `BUILD-QUEUE: phantom authority ${projection.phantomRids.join(',')} cited by a phase; a queue R-number is not proof he asked. tools/build-queue-provenance.js`;
  }
  if (projection.state === 'UNSOURCED') {
    return `BUILD-QUEUE: ${projection.errorCount} phase(s) claim owner authority with no checkable R-id. tools/build-queue-provenance.js`;
  }
  if (projection.orphanDirectiveCount) {
    return `BUILD-QUEUE: ${projection.orphanDirectiveCount}/${projection.actionableDirectiveCount} open directives sit in no phase. tools/build-queue-provenance.js --orphans`;
  }
  return null;
}

const report = {
  generatedAt: new Date(now).toISOString(),
  repo: REPO,
  treeIdentity: treeIdentity({ root: REPO }),
  // The bounded projection, so --json carries no absolute machine path and says
  // exactly what the human and hook renderings say.
  ownerAuthorization: authorizationProjection(readAuthorization({ root: REPO })),
  ledgerAuthority: ledgerAuthorityProjection(),
  queueProvenance: queueProvenanceProjection(),
  singleCopyWork: singleCopy,
  priorWork: priorWork(topic),
  openGatesFreshness: openGatesFreshness(),
  mcp,
  prefixGuidance: prefixGuidance(mcp),
  otherAgents: {
    codex: codexSessionMeasurement.sessions,
    claude: claudeSessionMeasurement.sessions,
    measurements: {
      codex: codexSessionMeasurement.error
        ? { state: 'INDETERMINATE', reason: codexSessionMeasurement.error }
        : { state: 'MEASURED' },
      claude: claudeSessionMeasurement.error
        ? { state: 'INDETERMINATE', reason: claudeSessionMeasurement.error }
        : { state: 'MEASURED' }
    },
    activeWindowMinutes: ACTIVE_WINDOW_MS / 60000
  },
  inFlight: inFlight(now),
  antiPatterns: [
    'A tool that is missing is a REPORTABLE GAP, not an invitation to require() the provider and '
      + 'hand-roll it. Session d4ca9820 spent 8 calls rebuilding gmail on top of authenticatedRequest() '
      + 'because no gmail thread-read tool exists. Say the gap out loud and stop.',
    'Before concluding a capability is unavailable, check the prefix. The readonly server is the configured '
      + 'read-only alternative in this repo; the current client must still advertise its namespace.',
    'Before starting work another agent may already own, read otherAgents above. A codex thread name '
      + 'is a one-line statement of intent and costs one file read.'
  ]
};

if (asHook) {
  // Deliberately short: this is prepended to every session, so it must earn its
  // tokens. Only the facts a session cannot cheaply derive and would otherwise
  // burn turns rediscovering.
  const parts = [];
  const singleCopyContext = singleCopyHookContext(singleCopy);
  if (singleCopyContext) parts.push(singleCopyContext);
  if (report.priorWork && report.priorWork.state === 'HIT') {
    parts.push(`PRIOR WORK EXISTS on "${report.priorWork.topic}": `
      + `${report.priorWork.totalCandidates} document(s) already address this — `
      + `${report.priorWork.results.map(r => r.path).join(', ')}. Read them before starting.`);
  } else if (report.priorWork && report.priorWork.state === 'UNKNOWN') {
    parts.push(`PRIOR WORK UNKNOWN for "${report.priorWork.topic}": ${report.priorWork.message} `
      + 'Do not read this as "nothing exists".');
  }
  const gf = report.openGatesFreshness;
  if (gf.state !== 'FRESH') {
    parts.push(`OPEN-GATES DIGEST ${gf.state}: ${gf.message}`);
  }
  // Unconditional, in both directions. When a record exists this stops the
  // 18-times-stopped failure; when it does not, the session learns it is NOT
  // authorized rather than inferring a grant from silence.
  parts.push(authorizationHeadline(report.ownerAuthorization));
  // Only when it is NOT clean: a session that would have been safe anyway does
  // not need the tokens, and a warning printed every time stops being read.
  const ledgerMessage = ledgerAuthorityMessage(report.ledgerAuthority);
  if (ledgerMessage) parts.push(ledgerMessage);
  const queueMessage = queueProvenanceMessage(report.queueProvenance);
  if (queueMessage) parts.push(queueMessage);
  parts.push('MCP CONFIGURATION: `agent-preflight` inventories declarations and local prerequisites only; it cannot prove this client loaded or advertised a server. Verify the current `mcp__<server>__*` namespace after the client initializes, and restart at the next session boundary when a declaration is missing.');
  const deadWrite = mcp.dead.find(d => d.server === 'toolsenabled');
  if (deadWrite) {
    parts.push('CAPABILITY REALITY: every `mcp__toolsenabled__*` call will fail with "MCP server '
      + '\\"toolsenabled\\" is not connected". The server IS registered and its ~272 tools ARE built and '
      + 'working -- but its proxy brokers through the owner-host named pipe, and no owner host is '
      + 'running, so the proxy exits silently. '
      + `Configured alternative: \`mcp__toolsenabled-readonly__<tool>\` (${(mcp.declared['toolsenabled-readonly'] || {}).allowlist?.length || 0} read tools, incl. task.list/memory.search). `
      + 'For write-capable work, run `node src/mcp-server.js` over stdio or the tools/*.js CLIs -- do NOT '
      + 'reverse-engineer a provider module to hand-roll a capability that already exists.');
  }
  const activeCodex = report.otherAgents.codex.filter(c => c.ageMs <= ACTIVE_WINDOW_MS);
  const activeClaude = report.otherAgents.claude.filter(c => c.ageMs <= ACTIVE_WINDOW_MS);
  const uncertainAgentSources = Object.entries(report.otherAgents.measurements)
    .filter(([, measurement]) => measurement.state === 'INDETERMINATE')
    .map(([name]) => name);
  if (uncertainAgentSources.length) {
    parts.push(`OTHER AGENTS INDETERMINATE: could not completely read ${uncertainAgentSources.join(' and ')} session data. `
      + 'Any agents listed below are only a partial result; do not infer nobody else is working.');
  }
  if (activeCodex.length || activeClaude.length) {
    const who = [];
    for (const c of activeCodex) who.push(`codex "${c.name}" (${Math.round(c.ageMs / 60000)}m ago)`);
    for (const c of activeClaude) who.push(`claude ${c.id.slice(0, 8)}: ${(c.intent || '').slice(0, 90)}`);
    parts.push(`OTHER AGENTS ACTIVE NOW: ${who.join(' | ')}. `
      + 'If your task overlaps one of these, read what it already did before starting -- '
      + '`node tools/agent-preflight.js` for the full picture.');
  }
  const o = report.inFlight.ownerInbox;
  if (o && o.fromOwner > 0) {
    parts.push(`OWNER WAITING: ${o.fromOwner} unread message(s) from the owner. Nothing outranks this. ${o.drainCommand}`);
  }
  parts.push('OWNER CHANNEL: operational alarms use the product-native agent-comms owner journal. There is no external bridge to poll. owner-chat reply() still requires an explicitly configured reply-capable channel and otherwise refuses with OWNER_CHAT_NO_TRANSPORT.');
  // Resolved, never asserted: roles are session-assigned (R1186).
  try {
    const line = require('./agent-preflight-role-line').roleLine();
    if (line) parts.push(`${line} Duties per role: docs/ROLE-OPERATIONS.md sections 1A and 1.`);
  } catch {
    parts.push('ROLES: could not be resolved this run. Roles are session-assigned; do not assume you hold one. '
      + 'Run `node tools/agent-roster.js --presence`.');
  }
  // THE ENVELOPE BOUNDS ITSELF, BECAUSE ONE OF ITS SECTIONS GROWS WITH THE FLEET.
  //
  // The 4000-char cap was met by arithmetic -- the comment above
  // queueProvenanceMessage records "the other sections already spend ~3850" -- and
  // that only held while the variable-length sections stayed small. Measured
  // 2026-08-13 with twelve lanes live: 4264 chars, over budget, because
  // "OTHER AGENTS ACTIVE NOW" carries one clause per active agent and
  // "OWNER AUTHORIZATION ON FILE" had grown to 1846 on its own.
  //
  // So it failed exactly when the fleet was busiest -- which is precisely when a
  // new session most needs to be told who else is in the tree. A budget that
  // holds only while nothing is happening is not a budget.
  //
  // Trimmed by SECTION, worst-growth first, and it SAYS it trimmed: a silently
  // shortened orientation packet is the same defect as a silently shortened
  // anything else in this codebase. Fences and owner-waiting are never dropped.
  // CORRECTION TO MY OWN FIRST VERSION, kept because the reasoning is the point.
  // It dropped whole sections longest-first, and the longest was
  // "OWNER AUTHORIZATION ON FILE" -- which carries the grant and every
  // reservation, i.e. exactly what an agent may NOT do. A concurrent suite
  // caught it: owner-authorization-surfaces asserts those reservations are in
  // this envelope. Dropping a fence to fit a budget inverts the priority the
  // budget exists to serve, and it did it silently enough that only a test
  // noticed.
  //
  // What actually grows is the VARIABLE section -- one clause per live agent --
  // so that is what gets bounded. Fixed obligations are never dropped; the
  // section that grows with the fleet is truncated and says how many it did not
  // name. Bounding the cause beats dropping the innocent.
  const HOOK_BUDGET = 3900;
  const NEVER_TRIM = /^(OWNER WAITING|OWNER AUTHORIZATION|FENCE|OWNER CHANNEL)/;
  const GROWS_WITH_FLEET = /^OTHER AGENTS ACTIVE NOW/;
  let context = parts.join('\n\n');

  if (context.length > HOOK_BUDGET) {
    // 1. Bound the fleet section first: keep the earliest clauses, count the rest.
    for (let index = 0; index < parts.length && context.length > HOOK_BUDGET; index += 1) {
      if (!GROWS_WITH_FLEET.test(parts[index])) continue;
      const clauses = parts[index].replace(/^OTHER AGENTS ACTIVE NOW: /, '').split(' | ');
      const named = clauses.slice(0, 3);
      const hidden = clauses.length - named.length;
      parts[index] = `OTHER AGENTS ACTIVE NOW: ${named.join(' | ')}`
        + (hidden > 0 ? ` | and ${hidden} more not named here.` : '. ')
        + 'If your task overlaps one of these, read what it already did before starting -- '
        + '`node tools/agent-roster.js --presence` for all of them.';
      context = parts.join('\n\n');
    }
  }

  if (context.length > HOOK_BUDGET) {
    // 2. Only then drop, and only what is neither a fence nor an obligation.
    const order = parts
      .map((text, index) => ({ text, index }))
      .filter(entry => !NEVER_TRIM.test(entry.text))
      .sort((a, b) => b.text.length - a.text.length);
    const dropped = [];
    const keep = new Set(parts.map((_, index) => index));
    for (const entry of order) {
      if (context.length <= HOOK_BUDGET) break;
      keep.delete(entry.index);
      dropped.push(entry.text.split(':')[0].slice(0, 40));
      context = parts.filter((_, index) => keep.has(index)).join('\n\n');
    }
    if (dropped.length) {
      context += `\n\nTRIMMED FOR THE SESSION-START BUDGET: ${dropped.join(', ')}. `
        + 'Nothing was lost, only not injected -- `node tools/agent-preflight.js` prints all of it.';
    }
  }
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context }
  })}\n`);
} else if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const L = [];
  L.push('# Agent preflight — what works, and who else is working');
  L.push('');
  // First, because everything below is only meaningful once you know which tree
  // produced it. A report measured in the wrong checkout is not slightly wrong,
  // it is about a different program.
  const tree = report.treeIdentity;
  if (tree.state === 'CANONICAL') {
    L.push(`## Tree  ✓ ${tree.repo}`);
    L.push(`  ${tree.message}`);
  } else {
    L.push(`## ⚠ TREE — ${tree.state}`);
    L.push(`  ${tree.repo}`);
    L.push(`  ${tree.message}`);
    L.push(`  ${NON_CANONICAL_GUIDANCE}`);
  }
  L.push('');
  // Second, before anything else a session might act on: whose name it may act
  // under, and the short list of things that are still his alone. Printed in
  // every mode including --quiet, because "am I allowed to do this as him" is
  // the question that was silently costing whole lanes.
  const auth = report.ownerAuthorization;
  L.push(auth.state === 'AUTHORIZED'
    ? '## Owner authorization  ✓ acting under the owner\'s name is AUTHORIZED'
    : `## ⚠ OWNER AUTHORIZATION — ${auth.state}`);
  L.push(...authorizationLines(auth));
  L.push('');
  // Which ledger his requirements live in. Printed in every mode, next to the
  // authorization block, because both answer "on whose authority" -- and an
  // R-id cited out of the wrong tree is a different requirement, not a typo.
  const la = report.ledgerAuthority;
  if (la.state === 'SINGLE') {
    L.push(`## Owner-request ledger  ✓ single authority — ${la.authoritative.count} requests, revision ${la.authoritative.revision}`);
  } else {
    L.push(`## ⚠ OWNER-REQUEST LEDGER — ${la.state}`);
    L.push(`  ${ledgerAuthorityMessage(la)}`);
  }
  L.push('');
  // Before anything else a session might go and DO: has this already been done?
  // Placed above the rest because by the time a reader reaches a "Do not" list
  // at the bottom they have usually already started.
  if (report.priorWork) {
    L.push(...priorWorkLines(report.priorWork));
    L.push('');
  }
  const gf = report.openGatesFreshness;
  if (gf.state !== 'FRESH') {
    L.push(`## ⚠ OPEN-GATES DIGEST ${gf.state}`);
    L.push(`  ${gf.message}`);
    L.push('');
  }
  L.push('## Single-copy work');
  L.push(...singleCopyOutputLines(singleCopy));
  L.push('');
  L.push('## MCP reality');
  for (const note of mcp.notes) L.push(`  NOTE  ${note}`);
  for (const [name, cfg] of Object.entries(mcp.declared)) {
    if (cfg.connection === 'dead' || cfg.connection === 'disabled') continue;
    L.push(`  DECLARED  ${name}${cfg.allowlist ? ` (${cfg.allowlist.length} allowlisted tools)` : ''}  [${cfg.source}; current client advertisement unverified]`);
  }
  for (const d of mcp.dead) L.push(`  DEAD  ${d.server} — ${d.why}`);
  if (report.prefixGuidance) {
    L.push('');
    L.push(`  RULE: ${report.prefixGuidance.rule}`);
    L.push(`  Coordination tools available read-only: ${report.prefixGuidance.coordinationTools.join(', ')}`);
  }
  L.push('');
  L.push('## Who else is already working');
  for (const [name, measurement] of Object.entries(report.otherAgents.measurements)) {
    if (measurement.state === 'INDETERMINATE') {
      L.push(`  ${name} measurement: INDETERMINATE — ${measurement.reason}`);
    }
  }
  if (report.otherAgents.codex.length) {
    L.push('  codex threads (most recent first):');
    for (const c of report.otherAgents.codex) {
      const mins = Math.round(c.ageMs / 60000);
      L.push(`    ${mins <= 90 ? 'ACTIVE ' : '       '}${String(mins).padStart(5)}m ago  "${c.name}"`);
    }
  } else if (report.otherAgents.measurements.codex.state !== 'INDETERMINATE') {
    L.push('  codex: no session index found at ~/.codex/session_index.jsonl');
  }
  if (report.otherAgents.claude.length) {
    L.push('  claude sessions in this repo:');
    for (const c of report.otherAgents.claude) {
      const mins = Math.round(c.ageMs / 60000);
      L.push(`    ${mins <= 90 ? 'ACTIVE ' : '       '}${String(mins).padStart(5)}m ago  ${c.id.slice(0, 8)}  ${c.intent || '(no plain opening message)'}`);
    }
  }
  L.push('');
  L.push('## In flight locally');
  const f = report.inFlight.fleetSupervisor;
  if (f) L.push(`  fleet supervisor: pid ${f.pid} ${f.alive ? 'ALIVE' : 'STALE'} (hb ${f.heartbeatAgeSec}s), ${f.running} lanes running, items ${JSON.stringify(f.items)}`);
  else if (report.inFlight.measurements.fleetSupervisor.state === 'INDETERMINATE') {
    L.push(`  fleet supervisor: INDETERMINATE — ${report.inFlight.measurements.fleetSupervisor.reason}`);
  }
  const o = report.inFlight.ownerInbox;
  if (o) L.push(o.disabled
    ? `  owner inbox: DISABLED — ${o.note}`
    : `  owner inbox: ${o.unread} unread, ${o.fromOwner} from the owner${o.fromOwner ? ` — DRAIN FIRST: ${o.drainCommand}` : ''}`);
  L.push(`  managed processes: ${report.inFlight.managedProcesses.note}`);
  if (!quiet) {
    L.push('');
    L.push('## Do not');
    for (const a of report.antiPatterns) L.push(`  - ${a}`);
  }
  process.stdout.write(`${L.join('\n')}\n`);
}
