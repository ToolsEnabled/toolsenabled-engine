'use strict';

// Zed terminal relay for agent CLIs.
//
// The child process runs inside a Windows ConPTY so interactive Claude/Codex
// sessions receive a real terminal. Its raw terminal bytes are written to a
// log file and briefly previewed in Zed, then erased from the visible screen
// and scrollback. The permanent projection is reconstructed from the agent's
// own structured session JSONL and contains only user/assistant text; tool
// calls, command output, edits, reasoning blocks, and terminal control bytes
// are deliberately excluded from that durable projection.

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');

const MAX_SUPPRESSED_PREVIEW_BYTES = 64 * 1024;

const CONPTY_SOURCE = path.join(__dirname, 'zed-conpty-relay', 'Program.cs');
const CONPTY_BIN = path.join(__dirname, 'zed-conpty-relay', 'bin');
const CONPTY_SOURCE_ID = crypto.createHash('sha256').update(fs.readFileSync(CONPTY_SOURCE)).digest('hex').slice(0, 16);
const CONPTY_EXE = path.join(CONPTY_BIN, `ZedConPtyRelay-${CONPTY_SOURCE_ID}.exe`);
const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
];

const USAGE = `Zed context-only terminal relay

Usage:
  node tools/zed-context-terminal.js --agent <claude|codex> --command <path> -- [agent args...]

The child keeps its interactive terminal. Native slash menus, commands, and
edits are previewed briefly, while raw stdout and stderr are retained under
logs/zed-terminal. Only structured user/assistant context remains visible, and
that context plus the exact native session identity is restored when this task
is launched again after Zed or Windows restarts.
`;

function parseArgs(argv) {
  const options = {
    agent: null,
    command: null,
    cwd: process.cwd(),
    logDir: path.join(process.cwd(), 'logs', 'zed-terminal'),
    stateDir: null,
    sessionRoot: null,
    pollMs: 250,
    resume: true
  };
  const targetArgs = [];
  let targetMode = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (targetMode) {
      targetArgs.push(token);
      continue;
    }
    if (token === '--') {
      targetMode = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--new-session') {
      options.resume = false;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`unexpected argument "${token}"`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    index += 1;
    if (key === 'agent') options.agent = value;
    else if (key === 'command') options.command = value;
    else if (key === 'cwd') options.cwd = value;
    else if (key === 'log-dir') options.logDir = value;
    else if (key === 'state-dir') options.stateDir = value;
    else if (key === 'session-root') options.sessionRoot = value;
    else if (key === 'poll-ms') options.pollMs = Number(value);
    else throw new Error(`unknown option "--${key}"`);
  }

  if (options.help) return { options, targetArgs };
  if (!options.agent || !['claude', 'codex'].includes(options.agent)) {
    throw new Error('--agent must be claude or codex');
  }
  if (!options.command) throw new Error('--command is required');
  if (!Number.isInteger(options.pollMs) || options.pollMs < 50 || options.pollMs > 5000) {
    throw new Error('--poll-ms must be an integer between 50 and 5000');
  }
  return { options, targetArgs };
}

function defaultSessionRoot(agent) {
  return agent === 'claude'
    ? path.join(os.homedir(), '.claude', 'projects')
    : path.join(os.homedir(), '.codex', 'sessions');
}

function normalizePath(value) {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function looksLikeWorkspace(value, cwd) {
  if (typeof value !== 'string' || !value) return false;
  const candidate = normalizePath(value);
  const target = normalizePath(cwd);
  return candidate === target || candidate.startsWith(`${target}${path.sep}`);
}

function isPathInside(value, root) {
  const candidate = normalizePath(value);
  const parent = normalizePath(root);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function isEligibleSessionFile(agent, filePath, identity = null) {
  if (agent === 'claude') return !normalizePath(filePath).split(path.sep).includes('subagents');
  if (agent !== 'codex') return true;
  const candidate = identity || readSessionIdentity(agent, filePath);
  // This wrapper owns an interactive Codex CLI, never an IDE/app/exec thread
  // and never one of those threads' read-only subagents. Without this source
  // check, another Codex process in the same workspace can be mistaken for
  // the terminal's session and later resume into "direct input is disabled".
  return candidate.source === 'cli' && !candidate.isSubagent;
}

function walkJsonl(root, output = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) walkJsonl(fullPath, output);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(fullPath);
  }
  return output;
}

function firstJsonLines(filePath, limit = 8) {
  let fd;
  let text;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, count).toString('utf8');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* file may be rotating */ }
    }
  }
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, limit);
  const events = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { /* an in-flight line is harmless */ }
  }
  return events;
}

function findWorkspaceValue(value, keys = new Set(['cwd', 'workdir', 'workingDirectory'])) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findWorkspaceValue(item, keys);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === 'string') return child;
    const found = findWorkspaceValue(child, keys);
    if (found) return found;
  }
  return null;
}

function extractSessionId(agent, event) {
  if (!event || typeof event !== 'object') return null;
  if (agent === 'codex' && event.type === 'session_meta' && typeof event.payload?.id === 'string') {
    return event.payload.id;
  }
  if (agent === 'claude' && typeof event.sessionId === 'string') return event.sessionId;
  return null;
}

function validSessionId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function readSessionIdentity(agent, filePath) {
  const events = firstJsonLines(filePath, 16);
  const sessionEvent = events.find(event => validSessionId(extractSessionId(agent, event))) || null;
  const source = agent === 'codex' ? sessionEvent?.payload?.source ?? null : null;
  return {
    sessionId: sessionEvent ? extractSessionId(agent, sessionEvent) : null,
    cwd: events.map(event => findWorkspaceValue(event)).find(Boolean) || null,
    source,
    originator: agent === 'codex' && typeof sessionEvent?.payload?.originator === 'string'
      ? sessionEvent.payload.originator
      : null,
    isSubagent: agent === 'codex' && Boolean(source && typeof source === 'object' && source.subagent),
    parentSessionId: agent === 'codex' && validSessionId(source?.subagent?.thread_spawn?.parent_thread_id)
      ? source.subagent.thread_spawn.parent_thread_id
      : null
  };
}

function chooseSessionFile({ agent, root, cwd, startedAt, currentFile, ignoredFiles, sessionId }) {
  const currentIdentity = currentFile && fs.existsSync(currentFile) ? readSessionIdentity(agent, currentFile) : null;
  const currentUsable = Boolean(
    currentFile
    && currentIdentity
    && isPathInside(currentFile, root)
    && isEligibleSessionFile(agent, currentFile, currentIdentity)
  );
  // Most resume operations append to the saved file. If a CLI rotates to a
  // new file for the same UUID, keep looking only among files created after
  // this projector's snapshot and switch to that exact-session continuation.
  if (currentUsable && (!sessionId || !ignoredFiles)) return currentFile;
  const candidates = [];
  for (const filePath of walkJsonl(root)) {
    if (currentUsable && normalizePath(filePath) === normalizePath(currentFile)) continue;
    if (ignoredFiles?.has(filePath)) continue;
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const identity = readSessionIdentity(agent, filePath);
    if (!isEligibleSessionFile(agent, filePath, identity)) continue;
    if (sessionId && identity.sessionId !== sessionId) continue;
    const workspaceMatch = looksLikeWorkspace(identity.cwd, cwd);
    // A new task may run while other agents are also creating sessions. Never
    // claim a merely recent file unless its own metadata names this workspace.
    if (!sessionId && !workspaceMatch) continue;
    if (identity.cwd && !workspaceMatch) continue;
    const recent = stat.mtimeMs >= startedAt - 3000;
    if (sessionId || recent) candidates.push({ filePath, mtimeMs: stat.mtimeMs, workspaceMatch });
  }
  candidates.sort((left, right) => Number(right.workspaceMatch) - Number(left.workspaceMatch) || right.mtimeMs - left.mtimeMs);
  return candidates[0]?.filePath || (currentUsable ? currentFile : null);
}

function recoverSingleInteractiveRoot({ root, agent, cwd }) {
  if (agent !== 'codex') return null;
  const bySession = new Map();
  for (const filePath of walkJsonl(root)) {
    const identity = readSessionIdentity(agent, filePath);
    if (!validSessionId(identity.sessionId) || !isEligibleSessionFile(agent, filePath, identity)) continue;
    if (identity.cwd && !looksLikeWorkspace(identity.cwd, cwd)) continue;
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const previous = bySession.get(identity.sessionId);
    if (!previous || stat.mtimeMs > previous.mtimeMs) {
      bySession.set(identity.sessionId, { sessionId: identity.sessionId, sessionFile: filePath, mtimeMs: stat.mtimeMs });
    }
  }
  if (bySession.size !== 1) return null;
  const [candidate] = bySession.values();
  return { sessionId: candidate.sessionId, sessionFile: candidate.sessionFile, offset: 0 };
}

function textBlocks(value) {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    if (typeof block.text === 'string' && ['text', 'output_text', 'input_text'].includes(block.type)) {
      return [block.text];
    }
    return [];
  });
}

function extractContextText(agent, event) {
  if (!event || typeof event !== 'object') return [];
  if (agent === 'claude') {
    if (!['assistant', 'user'].includes(event.type)) return [];
    const message = event.message;
    if (!message || !['assistant', 'user'].includes(message.role)) return [];
    // Claude tool_result and tool_use blocks have no text projection here.
    return textBlocks(message.content);
  }

  const payload = event.payload;
  if (!payload || typeof payload !== 'object') return [];
  if (event.type === 'event_msg' && payload.type === 'agent_message') {
    return typeof payload.message === 'string' ? [payload.message] : [];
  }
  // Codex response_item messages include the complete developer/user
  // bootstrap (system instructions, environment context, and hidden
  // orchestration text).  The event_msg stream is the user-facing context
  // stream, so use it as the sole visible source to avoid leaking that
  // bootstrap and to avoid duplicating each assistant message.
  if (event.type === 'event_msg' && payload.type === 'user_message') {
    return typeof payload.message === 'string' ? [payload.message] : [];
  }
  return [];
}

function extractTransientActivity(agent, event) {
  if (!event || typeof event !== 'object') return [];
  if (agent === 'claude' && event.type === 'assistant' && event.message?.role === 'assistant') {
    return (Array.isArray(event.message.content) ? event.message.content : [])
      .filter(block => block && block.type === 'tool_use')
      .map(block => typeof block.name === 'string' && block.name ? block.name : 'tool');
  }
  const payload = event.payload;
  if (agent === 'codex' && event.type === 'response_item' && payload && typeof payload === 'object') {
    if (['function_call', 'custom_tool_call'].includes(payload.type)) {
      return [typeof payload.name === 'string' && payload.name ? payload.name : payload.type];
    }
  }
  return [];
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'agent';
}

function sanitizeContextText(value) {
  return String(value)
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function sanitizeDynamicText(value) {
  return sanitizeContextText(value).replace(/[\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function lanePaths(stateDir, agent, cwd) {
  const workspaceHash = crypto.createHash('sha256').update(normalizePath(cwd)).digest('hex').slice(0, 16);
  const prefix = path.join(path.resolve(stateDir), `${safeName(agent)}-${workspaceHash}`);
  return {
    key: path.basename(prefix),
    historyPath: `${prefix}.context.jsonl`,
    statePath: `${prefix}.state.json`
  };
}

function defaultLaneState(agent, cwd) {
  return {
    version: 1,
    agent,
    cwd: path.resolve(cwd),
    sessionId: null,
    sessionFile: null,
    offset: 0,
    excludedSessionIds: [],
    excludedContextIds: [],
    updatedAt: null
  };
}

function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function writeJsonFile(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temporary, filePath);
  } catch {
    // Some Windows filesystems reject replacement rename while an indexer has
    // the destination open. The fallback still leaves a complete JSON file.
    fs.copyFileSync(temporary, filePath);
    fs.unlinkSync(temporary);
  }
}

class PersistentContextHistory {
  constructor({ stateDir, agent, cwd }) {
    this.agent = agent;
    this.cwd = path.resolve(cwd);
    this.paths = lanePaths(stateDir, agent, cwd);
    fs.mkdirSync(path.dirname(this.paths.statePath), { recursive: true });
    this.state = this.loadState();
    this.entries = [];
    this.seenIds = new Set();
    this.historyNeedsNewline = false;
    this.loadHistory();
  }

  loadState() {
    const saved = readJsonFile(this.paths.statePath);
    if (!saved || saved.version !== 1 || saved.agent !== this.agent || typeof saved.cwd !== 'string' || normalizePath(saved.cwd) !== normalizePath(this.cwd)) {
      return defaultLaneState(this.agent, this.cwd);
    }
    const state = defaultLaneState(this.agent, this.cwd);
    if (validSessionId(saved.sessionId)) state.sessionId = saved.sessionId;
    if (typeof saved.sessionFile === 'string' && saved.sessionFile) state.sessionFile = path.resolve(saved.sessionFile);
    if (Number.isSafeInteger(saved.offset) && saved.offset >= 0) state.offset = saved.offset;
    if (Array.isArray(saved.excludedSessionIds)) {
      state.excludedSessionIds = [...new Set(saved.excludedSessionIds.filter(validSessionId))];
    }
    if (Array.isArray(saved.excludedContextIds)) {
      state.excludedContextIds = [...new Set(saved.excludedContextIds.filter(value => typeof value === 'string' && value))];
    }
    if (typeof saved.updatedAt === 'string') state.updatedAt = saved.updatedAt;
    return state;
  }

  loadHistory() {
    let content;
    try { content = fs.readFileSync(this.paths.historyPath, 'utf8'); }
    catch { return; }
    this.historyNeedsNewline = Boolean(content && !content.endsWith('\n'));
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry.id !== 'string' || typeof entry.text !== 'string' || this.seenIds.has(entry.id)) continue;
      const text = sanitizeContextText(entry.text);
      if (!text) continue;
      const sessionId = validSessionId(entry.sessionId) ? entry.sessionId : this.state.sessionId;
      this.entries.push({ id: entry.id, text, sessionId });
      this.seenIds.add(entry.id);
    }
  }

  replay(display) {
    const excluded = new Set(this.state.excludedSessionIds);
    const excludedContexts = new Set(this.state.excludedContextIds);
    for (const entry of this.entries) {
      if (excludedContexts.has(entry.id)) continue;
      if (validSessionId(entry.sessionId) && excluded.has(entry.sessionId)) continue;
      display.writeContext(entry.text, { redraw: false });
    }
  }

  append(id, text, sessionId = null) {
    const cleaned = sanitizeContextText(text);
    if (!cleaned || this.seenIds.has(id)) return false;
    const resolvedSessionId = validSessionId(sessionId) ? sessionId : this.state.sessionId;
    const entry = { version: 2, id, sessionId: validSessionId(resolvedSessionId) ? resolvedSessionId : null, text: cleaned };
    fs.appendFileSync(this.paths.historyPath, `${this.historyNeedsNewline ? '\n' : ''}${JSON.stringify(entry)}\n`, 'utf8');
    this.historyNeedsNewline = false;
    this.entries.push({ id, text: cleaned, sessionId: entry.sessionId });
    this.seenIds.add(id);
    return true;
  }

  excludeSession(sessionId) {
    if (!validSessionId(sessionId)) return;
    const contextIds = this.entries
      .filter(entry => entry.sessionId === sessionId)
      .map(entry => entry.id);
    const excludedSessionIds = [...new Set([...this.state.excludedSessionIds, sessionId])];
    const excludedContextIds = [...new Set([...this.state.excludedContextIds, ...contextIds])];
    if (
      excludedSessionIds.length === this.state.excludedSessionIds.length
      && excludedContextIds.length === this.state.excludedContextIds.length
    ) return;
    this.state = {
      ...this.state,
      excludedSessionIds,
      excludedContextIds,
      updatedAt: new Date().toISOString()
    };
    writeJsonFile(this.paths.statePath, this.state);
  }

  updateSource({ sessionId, sessionFile, offset }) {
    const nextSessionId = validSessionId(sessionId) ? sessionId : this.state.sessionId;
    const nextSessionFile = typeof sessionFile === 'string' && sessionFile ? path.resolve(sessionFile) : this.state.sessionFile;
    const nextOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : this.state.offset;
    if (nextSessionId === this.state.sessionId && nextSessionFile === this.state.sessionFile && nextOffset === this.state.offset) return;
    this.state = {
      ...this.state,
      sessionId: nextSessionId,
      sessionFile: nextSessionFile,
      offset: nextOffset,
      updatedAt: new Date().toISOString()
    };
    writeJsonFile(this.paths.statePath, this.state);
  }

  clearSession() {
    this.state = {
      ...defaultLaneState(this.agent, this.cwd),
      excludedSessionIds: [...this.state.excludedSessionIds],
      excludedContextIds: [...this.state.excludedContextIds],
      updatedAt: new Date().toISOString()
    };
    writeJsonFile(this.paths.statePath, this.state);
  }
}

function resolveResumeSource({ history, root, agent, cwd }) {
  const sessionId = history.state.sessionId;
  if (!validSessionId(sessionId)) return null;
  let sessionFile = history.state.sessionFile;
  let rejectedIdentity = null;
  if (sessionFile && (!isPathInside(sessionFile, root) || !fs.existsSync(sessionFile))) sessionFile = null;
  if (sessionFile) {
    const identity = readSessionIdentity(agent, sessionFile);
    if (
      identity.sessionId !== sessionId
      || (identity.cwd && !looksLikeWorkspace(identity.cwd, cwd))
      || !isEligibleSessionFile(agent, sessionFile, identity)
    ) {
      rejectedIdentity = identity;
      sessionFile = null;
    }
  }
  if (!sessionFile) {
    sessionFile = chooseSessionFile({ agent, root, cwd, startedAt: 0, currentFile: null, ignoredFiles: null, sessionId });
  }
  if (!sessionFile && rejectedIdentity?.sessionId === sessionId) {
    // Keep the misattributed context record on disk for audit/recovery, but
    // never render it as this terminal lane's permanent conversation.
    history.excludeSession(sessionId);
    const recovered = recoverSingleInteractiveRoot({ root, agent, cwd });
    if (recovered) return { ...recovered, recoveredFromSessionId: sessionId };
  }
  if (!sessionFile) return null;
  const sameFile = history.state.sessionFile && normalizePath(history.state.sessionFile) === normalizePath(sessionFile);
  return { sessionId, sessionFile, offset: sameFile ? history.state.offset : 0 };
}

function buildResumeArgs(agent, targetArgs, sessionId) {
  const args = [...targetArgs];
  if (!validSessionId(sessionId)) return args;
  if (agent === 'codex') {
    if (args[0] === 'resume' || args.includes('--last')) return args;
    return ['resume', ...args, sessionId];
  }
  if (args.some(argument => ['--resume', '-r', '--continue', '-c', '--session-id'].includes(argument))) return args;
  return ['--resume', sessionId, ...args];
}

function createRawLogs(logDir, agent) {
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const prefix = path.join(logDir, `${stamp}-${process.pid}-${safeName(agent)}`);
  return {
    stdoutPath: `${prefix}.stdout.log`,
    stderrPath: `${prefix}.stderr.log`,
    stderr: fs.createWriteStream(`${prefix}.stderr.log`, { flags: 'a' })
  };
}

function resolveConptyRelay() {
  if (fs.existsSync(CONPTY_EXE)) return CONPTY_EXE;
  const compiler = CSC_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!compiler) throw new Error('the Windows C# compiler needed for the ConPTY relay was not found');
  fs.mkdirSync(CONPTY_BIN, { recursive: true });
  const temporaryExe = path.join(CONPTY_BIN, `.${path.basename(CONPTY_EXE, '.exe')}-${process.pid}-${Date.now()}.tmp.exe`);
  const build = spawnSync(compiler, ['/nologo', '/target:winexe', `/out:${temporaryExe}`, CONPTY_SOURCE], {
    cwd: path.dirname(CONPTY_SOURCE),
    env: safeLaunchEnvironment(process.env, { context: 'Zed ConPTY relay compiler' }),
    windowsHide: true,
    encoding: 'utf8'
  });
  if (build.error) throw new Error(`could not build ConPTY relay: ${build.error.message}`);
  if (build.status !== 0 || !fs.existsSync(temporaryExe)) {
    try { fs.unlinkSync(temporaryExe); } catch { /* compiler may not have emitted it */ }
    const detail = `${build.stdout || ''}${build.stderr || ''}`.trim().replace(/\s+/g, ' ').slice(-1200);
    throw new Error(`could not build ConPTY relay${detail ? `: ${detail}` : ''}`);
  }
  try {
    fs.renameSync(temporaryExe, CONPTY_EXE);
  } catch (error) {
    // Concurrent task launches may compile the same source ID. If another
    // launch won the race, its immutable content-addressed binary is valid.
    if (!fs.existsSync(CONPTY_EXE)) throw error;
    try { fs.unlinkSync(temporaryExe); } catch { /* harmless abandoned race */ }
  }
  return CONPTY_EXE;
}

function terminalDimension(value, fallback) {
  return Number.isInteger(value) && value >= 20 && value <= 400 ? value : fallback;
}

function normalizeTerminalDimensions(columns, rows) {
  const nextColumns = terminalDimension(columns, null);
  const nextRows = terminalDimension(rows, null);
  if (nextColumns === null || nextRows === null) return null;
  return { columns: nextColumns, rows: nextRows };
}

function sameTerminalDimensions(left, right) {
  return Boolean(left && right && left.columns === right.columns && left.rows === right.rows);
}

function createResizePipeName() {
  return `\\\\.\\pipe\\zed-context-terminal-resize-${process.pid}-${crypto.randomUUID()}`;
}

class TerminalResizePipe {
  constructor({ netModule = net, pipeName = createResizePipeName(), initialDimensions = null } = {}) {
    this.net = netModule;
    this.pipeName = pipeName;
    this.pending = null;
    this.lastObserved = initialDimensions
      ? normalizeTerminalDimensions(initialDimensions.columns, initialDimensions.rows)
      : null;
    this.lastSent = null;
    this.server = null;
    this.socket = null;
    this.socketHandlers = new Map();
    this.listening = false;
    this.closed = false;
    this.startPromise = null;
    this.startResolve = null;
    this.startReject = null;
    this.onListening = null;
    this.onConnection = socket => this.accept(socket);
    this.onServerError = error => this.handleServerError(error);
  }

  update(columns, rows) {
    if (this.closed) return false;
    const dimensions = normalizeTerminalDimensions(columns, rows);
    if (!dimensions) return false;
    if (sameTerminalDimensions(this.pending, dimensions)) return false;
    if (this.socket && sameTerminalDimensions(this.lastSent, dimensions)) return false;
    if (!this.pending && !this.socket && sameTerminalDimensions(this.lastObserved, dimensions)) return false;
    this.lastObserved = dimensions;
    this.pending = dimensions;
    this.flush();
    return true;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.closed) return Promise.reject(new Error('resize pipe is closed'));

    this.server = this.net.createServer();
    this.server.on('connection', this.onConnection);
    this.server.on('error', this.onServerError);
    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      this.onListening = () => {
        if (this.closed || this.listening) return;
        this.listening = true;
        this.server?.unref?.();
        const resolveStart = this.startResolve;
        this.startResolve = null;
        this.startReject = null;
        if (resolveStart) resolveStart(this);
        this.flush();
      };
      this.server.once('listening', this.onListening);
      try {
        this.server.listen(this.pipeName, this.onListening);
      } catch (error) {
        this.handleServerError(error);
      }
    });
    return this.startPromise;
  }

  handleServerError(error) {
    if (this.closed) return;
    this.lastError = error;
    if (!this.listening && this.startReject) {
      const rejectStart = this.startReject;
      this.startResolve = null;
      this.startReject = null;
      rejectStart(error);
    }
  }

  accept(socket) {
    if (this.closed) {
      socket.destroy?.();
      return;
    }
    if (this.socket) this.detachSocket(this.socket);
    this.socket = socket;
    this.lastSent = null;
    const onError = () => this.detachSocket(socket);
    const onClose = () => this.detachSocket(socket, { destroy: false });
    this.socketHandlers.set(socket, { onError, onClose });
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.unref?.();
    this.flush();
  }

  detachSocket(socket, { destroy = true } = {}) {
    const handlers = this.socketHandlers.get(socket);
    if (handlers) {
      socket.off('error', handlers.onError);
      socket.off('close', handlers.onClose);
      this.socketHandlers.delete(socket);
    }
    if (this.socket !== socket) {
      if (destroy && socket && !socket.destroyed) socket.destroy?.();
      return;
    }
    if (!this.pending && this.lastSent) this.pending = this.lastSent;
    this.lastSent = null;
    this.socket = null;
    if (destroy && socket && !socket.destroyed) socket.destroy?.();
  }

  flush() {
    const socket = this.socket;
    if (!this.pending || !socket || socket.destroyed || socket.writable === false) return false;
    const dimensions = this.pending;
    const record = Buffer.from(`${dimensions.columns} ${dimensions.rows}\n`, 'utf8');
    try {
      socket.write(record);
    } catch {
      this.detachSocket(socket);
      return false;
    }
    this.pending = null;
    this.lastSent = dimensions;
    return true;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      const server = this.server;
      if (server) {
        server.off('connection', this.onConnection);
        server.off('error', this.onServerError);
        if (this.onListening) server.off('listening', this.onListening);
      }
      if (this.startReject) {
        const rejectStart = this.startReject;
        this.startResolve = null;
        this.startReject = null;
        rejectStart(new Error('resize pipe closed before listening'));
      }
      if (this.socket) this.detachSocket(this.socket);
      this.pending = null;
      this.lastSent = null;
      if (!server) return;
      server.unref?.();
      await new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          server.close(finish);
        } catch {
          finish();
        }
      });
    })();
    return this.closePromise;
  }
}

class TerminalDisplay {
  constructor(output, {
    columns = 120,
    transientMs = 500,
    maxPreviewMs = 500,
    suppressedPreviewMs = null,
    maxSuppressedPreviewBytes = MAX_SUPPRESSED_PREVIEW_BYTES,
    now = Date.now
  } = {}) {
    this.output = output;
    this.columns = terminalDimension(columns, 120);
    this.transientMs = transientMs;
    this.maxPreviewMs = Math.max(1, maxPreviewMs);
    const requestedSuppressedPreviewMs = Number(suppressedPreviewMs);
    this.suppressedPreviewMs = Number.isFinite(requestedSuppressedPreviewMs)
      ? Math.max(1, Math.min(this.maxPreviewMs, requestedSuppressedPreviewMs))
      : this.maxPreviewMs;
    const requestedSuppressedPreviewBytes = Number(maxSuppressedPreviewBytes);
    this.maxSuppressedPreviewBytes = Number.isSafeInteger(requestedSuppressedPreviewBytes)
      ? Math.max(0, Math.min(MAX_SUPPRESSED_PREVIEW_BYTES, requestedSuppressedPreviewBytes))
      : MAX_SUPPRESSED_PREVIEW_BYTES;
    this.now = typeof now === 'function' ? now : Date.now;
    this.inputChars = [];
    this.cursor = 0;
    this.submitted = null;
    this.activity = null;
    this.dynamicVisible = false;
    this.activityTimer = null;
    this.submittedTimer = null;
    this.rawPreviewActive = false;
    this.rawPreviewTimer = null;
    this.rawPreviewHardTimer = null;
    this.rawPreviewSuppressed = false;
    this.suppressedPreview = Buffer.alloc(0);
    this.suppressedPreviewExpiresAt = 0;
    this.suppressedPreviewTimer = null;
    this.permanentReplay = null;
  }

  setPermanentReplay(replay) {
    this.permanentReplay = typeof replay === 'function' ? replay : null;
  }

  resize(columns) {
    const nextColumns = terminalDimension(columns, null);
    if (nextColumns === null || nextColumns === this.columns) return false;
    this.columns = nextColumns;
    if (!this.rawPreviewActive) this.renderDynamic();
    return true;
  }

  slashPreviewHeld() {
    return this.inputChars[0] === '/';
  }

  allowRawPreview() {
    this.rawPreviewSuppressed = false;
    const buffered = this.takeSuppressedPreview();
    if (buffered.length) {
      // A structured activity event or real user input is the explicit re-arm
      // point. Passive redraws can fill this buffer, but never open the native
      // UI by themselves.
      this.showRawPreview(buffered);
      return true;
    }
    if (this.rawPreviewActive) this.scheduleRawDeadline();
    return false;
  }

  scheduleRawRestore(delay = this.transientMs) {
    if (!this.rawPreviewActive) return;
    if (this.rawPreviewTimer) clearTimeout(this.rawPreviewTimer);
    this.rawPreviewTimer = setTimeout(() => {
      this.rawPreviewTimer = null;
      this.restoreRawPreview();
    }, Math.max(1, delay));
    this.rawPreviewTimer.unref?.();
  }

  scheduleRawDeadline(delay = this.maxPreviewMs) {
    if (!this.rawPreviewActive) return;
    if (this.rawPreviewHardTimer) clearTimeout(this.rawPreviewHardTimer);
    this.rawPreviewHardTimer = setTimeout(() => {
      this.rawPreviewHardTimer = null;
      this.expireRawPreview();
    }, Math.max(1, delay));
    this.rawPreviewHardTimer.unref?.();
  }

  clearSuppressedPreview() {
    if (this.suppressedPreviewTimer) clearTimeout(this.suppressedPreviewTimer);
    this.suppressedPreviewTimer = null;
    this.suppressedPreviewExpiresAt = 0;
    this.suppressedPreview = Buffer.alloc(0);
  }

  pruneSuppressedPreview() {
    if (!this.suppressedPreview.length) return;
    if (this.now() >= this.suppressedPreviewExpiresAt) this.clearSuppressedPreview();
  }

  scheduleSuppressedPreviewExpiry() {
    if (!this.suppressedPreview.length) return;
    if (this.suppressedPreviewTimer) clearTimeout(this.suppressedPreviewTimer);
    const delay = Math.max(1, this.suppressedPreviewExpiresAt - this.now());
    this.suppressedPreviewTimer = setTimeout(() => {
      this.suppressedPreviewTimer = null;
      this.pruneSuppressedPreview();
      if (this.suppressedPreview.length) this.scheduleSuppressedPreviewExpiry();
    }, delay);
    this.suppressedPreviewTimer.unref?.();
  }

  bufferSuppressedPreview(chunk) {
    if (this.maxSuppressedPreviewBytes <= 0) return;
    this.pruneSuppressedPreview();
    let bytes = Buffer.from(chunk);
    if (!bytes.length) return;
    if (!this.suppressedPreview.length) {
      this.suppressedPreviewExpiresAt = this.now() + this.suppressedPreviewMs;
    }
    if (bytes.length > this.maxSuppressedPreviewBytes) {
      bytes = bytes.subarray(0, this.maxSuppressedPreviewBytes);
    }
    const combined = this.suppressedPreview.length
      ? Buffer.concat([this.suppressedPreview, bytes])
      : bytes;
    this.suppressedPreview = Buffer.from(combined.subarray(-this.maxSuppressedPreviewBytes));
    this.scheduleSuppressedPreviewExpiry();
  }

  takeSuppressedPreview() {
    this.pruneSuppressedPreview();
    const buffered = this.suppressedPreview;
    this.clearSuppressedPreview();
    return buffered;
  }

  expireRawPreview() {
    if (!this.rawPreviewActive) return true;
    if (this.slashPreviewHeld()) {
      this.scheduleRawDeadline(Math.min(250, this.maxPreviewMs));
      return false;
    }
    return this.restoreRawPreview({ force: true, suppress: true });
  }

  showRawPreview(chunk) {
    if (chunk === undefined || chunk === null || chunk.length === 0) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.rawPreviewSuppressed) {
      this.bufferSuppressedPreview(bytes);
      return false;
    }
    if (!this.rawPreviewActive) {
      this.clearDynamic();
      // A native CLI may already be using an alternate screen. Return to the
      // main screen before clearing so neither that screen nor scrollback can
      // become permanent in Zed.
      this.output.write('\x1b[?1049l\x1b[?1047l\x1b[?47l');
      clearVisibleTerminal(this.output);
      this.rawPreviewActive = true;
      this.dynamicVisible = false;
      this.scheduleRawDeadline();
    }
    this.output.write(bytes);
    this.scheduleRawRestore();
    return true;
  }

  restoreRawPreview({ force = false, suppress = true } = {}) {
    if (!this.rawPreviewActive) return true;
    if (!force && this.slashPreviewHeld()) {
      // Keep the native slash-command picker visible while the user is still
      // choosing from it, even if the CLI pauses its redraws.
      this.scheduleRawRestore(Math.min(250, this.transientMs));
      return false;
    }
    if (this.rawPreviewTimer) clearTimeout(this.rawPreviewTimer);
    if (this.rawPreviewHardTimer) clearTimeout(this.rawPreviewHardTimer);
    this.rawPreviewTimer = null;
    this.rawPreviewHardTimer = null;
    this.output.write('\x1b[?1049l\x1b[?1047l\x1b[?47l');
    clearVisibleTerminal(this.output);
    this.rawPreviewActive = false;
    this.clearSuppressedPreview();
    this.rawPreviewSuppressed = suppress;
    this.dynamicVisible = false;
    if (this.permanentReplay) this.permanentReplay();
    this.renderDynamic();
    return true;
  }

  clearDynamic() {
    if (!this.dynamicVisible) return;
    this.output.write('\r\x1b[2K\r');
    this.dynamicVisible = false;
  }

  inputLine() {
    const suffix = this.submitted ? '  [sent]' : '';
    const characters = this.submitted ? Array.from(this.submitted) : this.inputChars;
    const cursor = this.submitted ? characters.length : this.cursor;
    const prefix = '› ';
    const available = Math.max(4, this.columns - prefix.length - suffix.length - 1);
    let start = Math.max(0, characters.length - available);
    if (!this.submitted && cursor < start) start = cursor;
    let visible = characters.slice(start, start + available);
    let leading = '';
    if (start > 0) {
      leading = '…';
      visible = visible.slice(1);
    }
    const body = visible.map(character => character === '\n' ? '↵' : character === '\t' ? '⇥' : character).join('');
    const line = `${prefix}${leading}${body}${suffix}`;
    const cursorColumn = prefix.length + leading.length + Math.max(0, Math.min(cursor - start, visible.length));
    return { line, cursorColumn: this.submitted ? line.length : cursorColumn };
  }

  renderDynamic() {
    if (this.rawPreviewActive) return;
    this.clearDynamic();
    let line;
    let cursorColumn;
    if (this.inputChars.length || this.submitted) {
      ({ line, cursorColumn } = this.inputLine());
    } else if (this.activity) {
      line = `[working: ${sanitizeDynamicText(this.activity) || 'agent'}]`.slice(0, this.columns - 1);
      cursorColumn = line.length;
    } else {
      line = '› ';
      cursorColumn = line.length;
    }
    this.output.write(line);
    this.dynamicVisible = true;
    const moveLeft = Math.max(0, line.length - cursorColumn);
    if (moveLeft) this.output.write(`\x1b[${moveLeft}D`);
  }

  writeContext(text, { redraw = true } = {}) {
    const cleaned = sanitizeContextText(text);
    if (!cleaned) return;
    this.submitted = null;
    if (this.submittedTimer) clearTimeout(this.submittedTimer);
    this.submittedTimer = null;
    // The projector has already appended this message to the durable context
    // ledger. Defer drawing it until the native preview is replaced by a full
    // ledger replay, avoiding mixed TUI/context output.
    if (this.rawPreviewActive) return;
    this.clearDynamic();
    this.output.write(cleaned);
    if (!cleaned.endsWith('\n')) this.output.write('\n');
    if (redraw) this.renderDynamic();
  }

  showActivity(label) {
    if (typeof label !== 'string' || !label) return;
    // Structured tool activity is a meaningful reason to reopen the native
    // preview after background status redraws have been suppressed.
    this.allowRawPreview();
    this.activity = label;
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      this.activity = null;
      this.renderDynamic();
    }, this.transientMs);
    this.activityTimer.unref?.();
    this.renderDynamic();
  }

  submitInput() {
    const text = this.inputChars.join('');
    this.inputChars = [];
    this.cursor = 0;
    this.submitted = text || null;
    if (this.submittedTimer) clearTimeout(this.submittedTimer);
    if (this.submitted) {
      this.submittedTimer = setTimeout(() => {
        this.submittedTimer = null;
        this.submitted = null;
        this.renderDynamic();
      }, this.transientMs);
      this.submittedTimer.unref?.();
    }
    this.renderDynamic();
    this.scheduleRawRestore();
  }

  insertInput(value) {
    const printable = Array.from(value).filter(character => {
      const code = character.codePointAt(0);
      return character === '\n' || character === '\t' || (code >= 0x20 && code !== 0x7f);
    });
    if (!printable.length) return;
    this.submitted = null;
    this.inputChars.splice(this.cursor, 0, ...printable);
    this.cursor += printable.length;
    this.renderDynamic();
    this.scheduleRawRestore();
  }

  handleKeypress(value, key = {}) {
    // User interaction re-arms the preview. This keeps native typing and slash
    // menus responsive while passive MCP/spinner redraws stay hidden.
    this.allowRawPreview();
    const name = key.name || '';
    if (name === 'return' || name === 'enter') {
      this.submitInput();
      return;
    }
    if (key.ctrl) {
      if (name === 'c' || name === 'u') {
        this.inputChars = [];
        this.cursor = 0;
        this.submitted = null;
        this.renderDynamic();
        this.scheduleRawRestore();
      } else if (name === 'w' && this.cursor > 0) {
        while (this.cursor > 0 && /\s/.test(this.inputChars[this.cursor - 1])) this.inputChars.splice(--this.cursor, 1);
        while (this.cursor > 0 && !/\s/.test(this.inputChars[this.cursor - 1])) this.inputChars.splice(--this.cursor, 1);
        this.renderDynamic();
        this.scheduleRawRestore();
      }
      return;
    }
    if (name === 'escape') {
      this.inputChars = [];
      this.cursor = 0;
      this.submitted = null;
      this.renderDynamic();
      this.scheduleRawRestore();
      return;
    }
    if (name === 'backspace') {
      if (this.cursor > 0) this.inputChars.splice(--this.cursor, 1);
      this.renderDynamic();
      this.scheduleRawRestore();
      return;
    }
    if (name === 'delete') {
      if (this.cursor < this.inputChars.length) this.inputChars.splice(this.cursor, 1);
      this.renderDynamic();
      this.scheduleRawRestore();
      return;
    }
    if (name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (name === 'right') this.cursor = Math.min(this.inputChars.length, this.cursor + 1);
    else if (name === 'home') this.cursor = 0;
    else if (name === 'end') this.cursor = this.inputChars.length;
    else if (!key.meta && typeof value === 'string' && value) {
      if (value.includes('\r') || value.includes('\n')) {
        const pieces = value.split(/\r\n|\r|\n/);
        pieces.forEach((piece, index) => {
          if (piece) this.insertInput(piece);
          if (index < pieces.length - 1) this.submitInput();
        });
        return;
      }
      this.insertInput(value);
      return;
    } else return;
    this.renderDynamic();
  }

  finish() {
    if (this.rawPreviewTimer) clearTimeout(this.rawPreviewTimer);
    if (this.rawPreviewHardTimer) clearTimeout(this.rawPreviewHardTimer);
    this.rawPreviewTimer = null;
    this.rawPreviewHardTimer = null;
    this.clearSuppressedPreview();
    this.restoreRawPreview({ force: true });
    if (this.activityTimer) clearTimeout(this.activityTimer);
    if (this.submittedTimer) clearTimeout(this.submittedTimer);
    this.activityTimer = null;
    this.submittedTimer = null;
    this.clearDynamic();
  }
}

class SessionProjector {
  constructor({ agent, root, cwd, startedAt, output, display, history, pollMs, initialFile = null, initialOffset = 0, sessionId = null }) {
    this.agent = agent;
    this.root = root;
    this.cwd = cwd;
    this.startedAt = startedAt;
    this.display = display || new TerminalDisplay(output);
    this.history = history || null;
    this.pollMs = pollMs;
    this.initialFile = initialFile;
    this.initialOffset = Number.isSafeInteger(initialOffset) && initialOffset >= 0 ? initialOffset : 0;
    this.filePath = initialFile;
    this.readOffset = this.initialOffset;
    this.committedOffset = this.initialOffset;
    this.pending = Buffer.alloc(0);
    this.sessionId = validSessionId(sessionId) ? sessionId : null;
    this.timer = null;
    this.lastError = null;
    this.ignoredFiles = null;
  }

  start() {
    // A fresh interactive CLI invocation should create a fresh JSONL file. A
    // resumed invocation is allowed to keep tailing only its saved exact file.
    this.ignoredFiles = new Set(walkJsonl(this.root).filter(filePath => isEligibleSessionFile(this.agent, filePath)));
    if (this.filePath) this.ignoredFiles.delete(this.filePath);
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const selected = chooseSessionFile({
      agent: this.agent,
      root: this.root,
      cwd: this.cwd,
      startedAt: this.startedAt,
      currentFile: this.filePath,
      ignoredFiles: this.ignoredFiles,
      sessionId: this.sessionId
    });
    if (selected && selected !== this.filePath) {
      this.filePath = selected;
      const restored = this.initialFile && normalizePath(selected) === normalizePath(this.initialFile);
      this.readOffset = restored ? this.initialOffset : 0;
      this.committedOffset = this.readOffset;
      this.pending = Buffer.alloc(0);
      const identity = readSessionIdentity(this.agent, selected);
      if (validSessionId(identity.sessionId)) this.sessionId = identity.sessionId;
    }
    if (!this.filePath) return;
    let stat;
    try { stat = fs.statSync(this.filePath); } catch { return; }
    if (stat.size < this.readOffset) {
      this.readOffset = 0;
      this.committedOffset = 0;
      this.pending = Buffer.alloc(0);
    }
    let fd;
    let totalRead = 0;
    try {
      fd = fs.openSync(this.filePath, 'r');
      while (this.readOffset < stat.size && totalRead < 4 * 1024 * 1024) {
        const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, stat.size - this.readOffset));
        const count = fs.readSync(fd, buffer, 0, buffer.length, this.readOffset);
        if (!count) break;
        this.readOffset += count;
        totalRead += count;
        this.pending = this.pending.length
          ? Buffer.concat([this.pending, buffer.subarray(0, count)])
          : Buffer.from(buffer.subarray(0, count));
        this.consumePending();
      }
    } catch (error) {
      this.lastError = error;
      // Retry from the last fully projected JSONL line. This keeps a disk
      // error while appending durable context from advancing past that text.
      this.readOffset = this.committedOffset;
      this.pending = Buffer.alloc(0);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* file may be rotating */ }
      }
    }
    if (this.history && this.filePath) {
      this.history.updateSource({
        sessionId: this.sessionId,
        sessionFile: this.filePath,
        offset: this.committedOffset
      });
    }
  }

  consumePending() {
    let newline;
    while ((newline = this.pending.indexOf(0x0a)) !== -1) {
      let lineBuffer = this.pending.subarray(0, newline);
      const consumed = newline + 1;
      this.pending = Buffer.from(this.pending.subarray(consumed));
      if (lineBuffer.length && lineBuffer[lineBuffer.length - 1] === 0x0d) lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
      if (!lineBuffer.length) {
        this.committedOffset += consumed;
        continue;
      }
      const line = lineBuffer.toString('utf8');
      let event;
      try { event = JSON.parse(line); }
      catch {
        this.committedOffset += consumed;
        continue;
      }
      const foundSessionId = extractSessionId(this.agent, event);
      if (validSessionId(foundSessionId)) this.sessionId = foundSessionId;
      const eventId = crypto.createHash('sha256').update(this.agent).update('\0').update(lineBuffer).digest('hex');
      extractContextText(this.agent, event).forEach((context, index) => {
        const contextId = `${eventId}:${index}`;
        if (!this.history || this.history.append(contextId, context, this.sessionId)) this.display.writeContext(context);
      });
      for (const activity of extractTransientActivity(this.agent, event)) this.display.showActivity(activity);
      this.committedOffset += consumed;
    }
  }

  writeContext(text) {
    this.display.writeContext(text);
  }

  writeTransient(label) {
    this.display.showActivity(label);
  }
}

function bindTerminalResize(output, display, resizePipe) {
  const onResize = () => {
    const columns = terminalDimension(output.columns, null);
    const rows = terminalDimension(output.rows, null);
    if (columns !== null) display.resize(columns);
    if (columns !== null && rows !== null) resizePipe.update(columns, rows);
  };
  output.on('resize', onResize);
  return () => output.off('resize', onResize);
}

function closeStream(stream) {
  return new Promise(resolve => {
    if (!stream || stream.destroyed) return resolve();
    stream.once('close', resolve);
    stream.end();
  });
}

function clearVisibleTerminal(output) {
  // Clear the old projection and terminal scrollback when a persistent Zed
  // task tab is reused.  This does not touch the child session or raw logs.
  output.write('\x1b[2J\x1b[3J\x1b[H');
}

async function run(options, targetArgs) {
  const cwd = path.resolve(options.cwd);
  const logs = createRawLogs(path.resolve(options.logDir), options.agent);
  const sessionRoot = path.resolve(options.sessionRoot || defaultSessionRoot(options.agent));
  const stateDir = options.stateDir ? path.resolve(cwd, options.stateDir) : path.join(cwd, 'state', 'zed-terminal');
  const history = new PersistentContextHistory({ stateDir, agent: options.agent, cwd });
  let resumeSource = options.resume
    ? resolveResumeSource({ history, root: sessionRoot, agent: options.agent, cwd })
    : null;
  if (!options.resume || (history.state.sessionId && !resumeSource)) history.clearSession();
  if (resumeSource) history.updateSource(resumeSource);

  let relay;
  try {
    relay = resolveConptyRelay();
  } catch (error) {
    logs.stderr.write(`${error.stack || error}\n`);
    await closeStream(logs.stderr);
    process.stderr.write(`zed-context-terminal: ${error.message}\n`);
    return 1;
  }
  const startedAt = Date.now();
  const columns = terminalDimension(process.stdout.columns, 120);
  const rows = terminalDimension(process.stdout.rows, 30);
  const display = new TerminalDisplay(process.stdout, { columns });
  display.setPermanentReplay(() => history.replay(display));
  const projector = new SessionProjector({
    agent: options.agent,
    root: sessionRoot,
    cwd,
    startedAt,
    display,
    history,
    pollMs: options.pollMs,
    initialFile: resumeSource?.sessionFile || null,
    initialOffset: resumeSource?.offset || 0,
    sessionId: resumeSource?.sessionId || null
  });

  const resizePipe = new TerminalResizePipe({ initialDimensions: { columns, rows } });
  const detachResize = bindTerminalResize(process.stdout, display, resizePipe);
  let child = null;
  let exit = null;
  let runError = null;
  const stdinWasRaw = Boolean(process.stdin.isTTY && process.stdin.isRaw);
  const forwardInput = chunk => {
    if (child?.stdin.writable && !child.stdin.destroyed) child.stdin.write(chunk);
  };
  const mirrorInput = (value, key) => display.handleKeypress(value, key || {});

  try {
    clearVisibleTerminal(process.stdout);
    history.replay(display);
    display.showActivity(`${resumeSource ? 'resuming' : 'starting'} ${options.agent}`);
    projector.start();

    // The named-pipe server must already be listening when the ConPTY relay
    // is spawned, otherwise the first resize can be lost during startup.
    await resizePipe.start();
    const launchArgs = buildResumeArgs(options.agent, targetArgs, resumeSource?.sessionId || null);
    child = spawn(relay, [
      '--log', logs.stdoutPath,
      '--cwd', cwd,
      '--cols', String(columns),
      '--rows', String(rows),
      '--resize-pipe', resizePipe.pipeName,
      '--', options.command, ...launchArgs
    ], {
      cwd,
      env: safeLaunchEnvironment(process.env, { context: 'Zed ConPTY terminal relay' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.stdout.on('data', chunk => display.showRawPreview(chunk));
    child.stdout.on('error', () => { /* preview pipe is closing */ });
    child.stderr.on('data', chunk => logs.stderr.write(chunk));
    child.stdin.on('error', () => { /* child is closing */ });
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try { process.stdin.setRawMode(true); } catch { /* Zed may not expose raw mode */ }
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', mirrorInput);
    process.stdin.on('data', forwardInput);
    process.stdin.resume();

    exit = await new Promise(resolve => {
      child.once('error', error => resolve({ error }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    runError = error;
  } finally {
    detachResize();
    process.stdin.off('keypress', mirrorInput);
    process.stdin.off('data', forwardInput);
    // Zed keeps the task terminal's input handle open after the native CLI
    // exits. Always pause it here so readline's keypress decoder cannot keep an
    // otherwise-complete relay process alive forever.
    if (child) process.stdin.pause();
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function' && !stdinWasRaw) {
      try { process.stdin.setRawMode(false); } catch { /* terminal already closed */ }
    }
    projector.stop();
    // Give the session writer one final bounded chance to flush its last
    // assistant message before the terminal process exits.
    if (exit) projector.tick();
    display.finish();
    await resizePipe.close();
    await closeStream(logs.stderr);
  }

  if (runError) {
    process.stderr.write(`zed-context-terminal: ${runError.message}\n`);
    return 1;
  }

  if (exit.error) {
    process.stderr.write(`zed-context-terminal: ${exit.error.message}\n`);
    return 1;
  }
  if (exit.signal) return 1;
  return typeof exit.code === 'number' ? exit.code : 1;
}

async function main(argv) {
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  return run(parsed.options, parsed.targetArgs);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONPTY_EXE,
  PersistentContextHistory,
  SessionProjector,
  TerminalResizePipe,
  TerminalDisplay,
  bindTerminalResize,
  buildResumeArgs,
  chooseSessionFile,
  clearVisibleTerminal,
  extractContextText,
  extractSessionId,
  extractTransientActivity,
  findWorkspaceValue,
  lanePaths,
  parseArgs,
  resolveResumeSource,
  resolveConptyRelay,
  normalizeTerminalDimensions,
  sanitizeContextText,
  terminalDimension,
  textBlocks
};
