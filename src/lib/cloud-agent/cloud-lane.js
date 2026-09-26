'use strict';

// R1177 integration: the FileKeeper <-> Codex Cloud custody loop behind
// tools/cloud-lane.js. The CLI file stays a thin arg parser; every decision
// lives here as exported, dependency-injected functions so tests never run
// real git, the real codex binary, or the network.
//
// Custody ground rules, in severity order:
//   - outbound builds the manifest from `git ls-tree -r -l -z <commit>` and
//     EXCLUDES non-regular entries (gitlinks 160000, symlinks 120000, trees)
//     from the manifest -- but records them honestly in the persisted record's
//     `excluded` list. Nothing is ever silently dropped.
//   - submit fails closed when the CLI acknowledges nothing recognizable: an
//     unconfirmed submission is an error, never a recorded task.
//   - status reuses the provider's STATUS_MAP semantics via mapStatus():
//     unknown strings are UNKNOWN, never success.
//   - verify (the A4 step) reads the task diff into MEMORY ONLY. It never
//     writes diff content anywhere -- not into a working tree, and not even
//     into the state record: persisted verify fields are metadata only
//     (verdict, reasons, diffSha256, changedPaths, verifiedAt), and parse
//     failure reasons carry line NUMBERS, never raw diff bytes. PASS requires
//     exactly one changed path, equal to the expectation path, a pure
//     addition (new file), and a reconstructed-content sha256 match; anything
//     else is FAIL with a precise reason.
//   - state records live under a caller-supplied stateRoot (default
//     state/cloud-custody under the repo root, which is gitignored program
//     state). This module never runs any git mutation; its only git use is
//     the read-only ls-tree above.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const { CloudAgentError } = require('./errors');
const { mapStatus } = require('../providers/codex-cloud');
const { safeLaunchEnvironment } = require('../providers/subscription-launch-env');
const { buildFileManifest, validateSafePath } = require('../../../packages/internal-vcs/src/cloud/file-manifest');
const { createOutboundProof } = require('../../../packages/internal-vcs/src/cloud/outbound-proof');
const { parseQualifiedId } = require('../../../packages/internal-vcs/src/m1/canonical');

const OUTBOUND_RECORD_SCHEMA = 'toolsenabled.cloud-lane.outbound/v1';
const TASK_RECORD_SCHEMA = 'toolsenabled.cloud-lane.task/v1';

const REGULAR_FILE_MODES = Object.freeze(['100644', '100755']);
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
// Kept in exact sync with codex-cli-transport.js ENVIRONMENT_ID: real ids are
// 32 lowercase hex and may start with a digit (observed live 2026-08-08).
const ENVIRONMENT_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const MAX_STDERR_EXCERPT_CHARS = 1024;

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function fail(code, message) { throw new CloudAgentError(code, message); }

function excerpt(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return '(no output)';
  return value.length <= MAX_STDERR_EXCERPT_CHARS ? value : `${value.slice(0, MAX_STDERR_EXCERPT_CHARS)}...[truncated]`;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function requireMatch(value, pattern, code, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(code, `${label} is malformed or missing.`);
  }
  return value;
}

// Same canonical-ISO rule the outbound-proof module enforces: byte-identical
// to Date#toISOString output. The clock read happens in the CLI, never here.
function requireIsoTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime()) || new Date(value).toISOString() !== value) {
    fail('CLOUD_LANE_INPUT_INVALID', `${label} must be a canonical UTC ISO-8601 timestamp (Date#toISOString form).`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// bounded child-process runner (the only real-effect seam besides fs state)
// ---------------------------------------------------------------------------

// Default execImpl: one bounded child process, explicit argv, shell:false,
// windowsHide:true, kill on timeout or output cap. Resolves with the exit
// outcome; the CALLER decides what a nonzero exit means. Tests inject a fake.
function defaultExecImpl(command, args, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_EXEC_TIMEOUT_MS;
  const maxOutputBytes = Number.isSafeInteger(options.maxOutputBytes) ? options.maxOutputBytes : DEFAULT_EXEC_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: safeLaunchEnvironment(process.env, { context: 'cloud-lane child process' })
      });
    } catch (error) {
      reject(new CloudAgentError('CLOUD_LANE_EXEC_SPAWN_FAILED', `${command} could not be started: ${excerpt(error && error.message)}`));
      return;
    }
    let settled = false;
    let totalBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    const killQuietly = () => { try { child.kill(); } catch { /* already gone */ } };
    const finish = (settler) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settler();
    };
    const timer = setTimeout(() => {
      killQuietly();
      finish(() => reject(new CloudAgentError('CLOUD_LANE_EXEC_TIMEOUT', `${command} ${args[0]} did not finish within ${timeoutMs}ms and was killed; its outcome is unknown.`)));
    }, Math.max(1, timeoutMs));
    const collectInto = (chunks) => (chunk) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk);
      totalBytes += Buffer.byteLength(text, 'utf8');
      if (totalBytes > maxOutputBytes) {
        killQuietly();
        finish(() => reject(new CloudAgentError('CLOUD_LANE_EXEC_OUTPUT_LIMIT', `${command} ${args[0]} exceeded the ${maxOutputBytes}-byte output cap and was killed.`)));
        return;
      }
      chunks.push(text);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collectInto(stdoutChunks));
    child.stderr.on('data', collectInto(stderrChunks));
    child.on('error', (error) => {
      finish(() => reject(new CloudAgentError('CLOUD_LANE_EXEC_SPAWN_FAILED', `${command} could not be started: ${excerpt(error && error.message)}`)));
    });
    child.on('close', (exitCode) => {
      finish(() => resolve({ exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') }));
    });
  });
}

// ---------------------------------------------------------------------------
// state records (the only writes this module performs)
// ---------------------------------------------------------------------------

function writeJsonRecord(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function requireStateRoot(stateRoot) {
  if (typeof stateRoot !== 'string' || stateRoot.trim().length === 0) {
    fail('CLOUD_LANE_INPUT_INVALID', 'stateRoot must be a non-empty directory path.');
  }
  return stateRoot;
}

// The record filename uses the first 12 hex chars of the proof DIGEST, never
// the qualified id itself: a ':' is illegal in Windows filenames.
function outboundRecordPath(stateRoot, proofId) {
  const digest = parseQualifiedId(proofId).digest;
  return path.join(requireStateRoot(stateRoot), 'outbound', `${digest.slice(0, 12)}.json`);
}

function taskRecordPath(stateRoot, taskId) {
  requireMatch(taskId, TASK_ID, 'CLOUD_LANE_INPUT_INVALID', 'task id');
  return path.join(requireStateRoot(stateRoot), 'tasks', `${taskId}.json`);
}

function loadTaskRecord(stateRoot, taskId) {
  const filePath = taskRecordPath(stateRoot, taskId);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fail('CLOUD_LANE_TASK_RECORD_NOT_FOUND', `no task record exists at ${filePath}; run the submit subcommand first.`);
    }
    fail('CLOUD_LANE_TASK_RECORD_READ_FAILED', `the task record at ${filePath} could not be read: ${excerpt(error && error.message)}`);
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    fail('CLOUD_LANE_TASK_RECORD_INVALID', `the task record at ${filePath} is not valid JSON.`);
  }
  const expectation = record && typeof record === 'object' && !Array.isArray(record) ? record.expectation : null;
  if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)
      || record.schemaVersion !== TASK_RECORD_SCHEMA
      || record.taskId !== taskId
      || typeof expectation.path !== 'string'
      || typeof expectation.sha256 !== 'string' || !SHA256_HEX.test(expectation.sha256)) {
    fail('CLOUD_LANE_TASK_RECORD_INVALID', `the task record at ${filePath} does not match the expected schema.`);
  }
  validateSafePath(expectation.path);
  return { record, filePath };
}

// ---------------------------------------------------------------------------
// outbound: git ls-tree -> manifest -> proof -> persisted record
// ---------------------------------------------------------------------------

// `git ls-tree -r -l -z` record: `<mode> <type> <oid> <padded size or ->\t<path>`
// separated by NUL (-z also disables path quoting). Anything unrecognized is a
// hard error, never a skipped line.
const LS_TREE_ENTRY = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64}) +(\d+|-)\t([\s\S]+)$/;

function parseLsTreeOutput(stdout) {
  const records = (typeof stdout === 'string' ? stdout : '').split('\0').filter((record) => record.length > 0);
  if (records.length === 0) {
    fail('CLOUD_LANE_LSTREE_EMPTY', 'git ls-tree returned no entries; the commit is empty or the output was not -z formatted.');
  }
  return records.map((record) => {
    const match = LS_TREE_ENTRY.exec(record);
    if (!match) {
      fail('CLOUD_LANE_LSTREE_UNPARSEABLE', `unrecognized git ls-tree record: ${excerpt(record).slice(0, 160)}`);
    }
    const size = match[4] === '-' ? null : Number.parseInt(match[4], 10);
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) {
      fail('CLOUD_LANE_LSTREE_UNPARSEABLE', `git ls-tree reported an unusable size for ${match[5]}`);
    }
    return { mode: match[1], type: match[2], oid: match[3], size, path: match[5] };
  });
}

// Mechanical allowlist from the manifest entry set: 'topdir/*' per top-level
// directory plus exact rules for root-level files. No judgment, no widening.
function deriveAllowlist(paths) {
  const rules = new Set();
  for (const entryPath of paths) {
    const slash = entryPath.indexOf('/');
    rules.add(slash === -1 ? entryPath : `${entryPath.slice(0, slash)}/*`);
  }
  return [...rules].sort();
}

function qualifyGitOid(oid) {
  return `${oid.length === 40 ? 'git-sha1' : 'git-sha256'}:${oid}`;
}

function buildOutboundRecord({ commit, branch, remote, entries, createdAt, allowlist }) {
  const included = [];
  const excluded = [];
  for (const entry of entries) {
    if (entry.type === 'blob' && REGULAR_FILE_MODES.includes(entry.mode)) {
      included.push({
        path: entry.path,
        mode: entry.mode,
        blobHash: qualifyGitOid(entry.oid),
        byteLength: entry.size
      });
    } else {
      // Gitlinks (160000), symlinks (120000), and anything else non-regular:
      // excluded from the manifest but recorded honestly, never dropped.
      excluded.push({ path: entry.path, mode: entry.mode });
    }
  }
  excluded.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (included.length === 0) {
    fail('CLOUD_LANE_LSTREE_EMPTY', 'the commit tree holds no regular files; nothing can be manifested.');
  }
  const manifest = buildFileManifest(included, { allowlist });
  const proof = createOutboundProof({
    manifestId: manifest.manifestId,
    sourceCommit: qualifyGitOid(commit),
    branch,
    remoteLabel: remote,
    createdAt
  });
  return {
    schemaVersion: OUTBOUND_RECORD_SCHEMA,
    proof,
    manifestId: manifest.manifestId,
    entryCount: manifest.entries.length,
    totalBytes: manifest.totalBytes,
    excluded,
    allowlistSize: manifest.allowlist.length
  };
}

async function runOutbound({ commit, branch, remote = 'origin', repoRoot, stateRoot, execImpl = defaultExecImpl, createdAt, allowlist }) {
  if (!Array.isArray(allowlist) || allowlist.length === 0
      || allowlist.some((rule) => typeof rule !== 'string' || rule.length === 0)) {
    fail('CLOUD_LANE_ALLOWLIST_REQUIRED', 'outbound requires a non-empty allowlist of non-empty strings.');
  }
  requireMatch(commit, COMMIT_SHA, 'CLOUD_LANE_INPUT_INVALID', 'commit (full lowercase hex sha)');
  requireMatch(branch, BRANCH, 'CLOUD_LANE_INPUT_INVALID', 'branch');
  requireMatch(remote, BRANCH, 'CLOUD_LANE_INPUT_INVALID', 'remote label');
  requireIsoTimestamp(createdAt, 'createdAt');
  requireStateRoot(stateRoot);
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    fail('CLOUD_LANE_INPUT_INVALID', 'repoRoot must be a non-empty directory path.');
  }
  const outcome = await execImpl('git', ['ls-tree', '-r', '-l', '-z', commit], { cwd: repoRoot });
  if (!outcome || outcome.exitCode !== 0) {
    fail('CLOUD_LANE_GIT_FAILED', `git ls-tree exited with status ${outcome ? outcome.exitCode : '(none)'}: ${excerpt(outcome && (outcome.stderr || outcome.stdout))}`);
  }
  const record = buildOutboundRecord({ commit, branch, remote, entries: parseLsTreeOutput(outcome.stdout), createdAt, allowlist });
  const recordPath = outboundRecordPath(stateRoot, record.proof.proofId);
  writeJsonRecord(recordPath, record);
  return { record, recordPath };
}

// ---------------------------------------------------------------------------
// submit: transport.createTask -> persisted task record (fail closed on null)
// ---------------------------------------------------------------------------

async function runSubmit({ transport, env, branch, expectPath, expectSha256, outboundProofId = null, stateRoot, submittedAt }) {
  requireMatch(env, ENVIRONMENT_ID, 'CLOUD_LANE_INPUT_INVALID', 'environment id (lowercase [a-z0-9._-], 2-64 chars)');
  requireMatch(branch, BRANCH, 'CLOUD_LANE_INPUT_INVALID', 'branch');
  validateSafePath(expectPath);
  requireMatch(expectSha256, SHA256_HEX, 'CLOUD_LANE_INPUT_INVALID', 'expected sha256 (64 lowercase hex chars)');
  requireIsoTimestamp(submittedAt, 'submittedAt');
  requireStateRoot(stateRoot);
  if (outboundProofId !== null) parseQualifiedId(outboundProofId);
  if (!transport || typeof transport.createTask !== 'function') {
    fail('CLOUD_LANE_INPUT_INVALID', 'submit requires a transport exposing createTask.');
  }
  const raw = await transport.createTask({ environment: env });
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !TASK_ID.test(raw.id)) {
    fail('CLOUD_LANE_SUBMIT_UNCONFIRMED', 'the codex CLI acknowledged no recognizable task id; the submission outcome is unknown and is NOT recorded as a task -- fail closed, reconcile via `codex cloud list` before retrying.');
  }
  const record = {
    schemaVersion: TASK_RECORD_SCHEMA,
    taskId: raw.id,
    env,
    branch,
    expectation: { path: expectPath, sha256: expectSha256 },
    outboundProofId,
    submittedAt,
    lastStatus: mapStatus(raw.status),
    lastRawStatus: typeof raw.status === 'string' ? raw.status : null,
    checkedAt: submittedAt
  };
  const recordPath = taskRecordPath(stateRoot, record.taskId);
  writeJsonRecord(recordPath, record);
  return { record, recordPath };
}

// ---------------------------------------------------------------------------
// status: provider STATUS_MAP semantics (unknown -> UNKNOWN, never success)
// ---------------------------------------------------------------------------

async function runStatus({ transport, taskId, stateRoot, checkedAt }) {
  requireIsoTimestamp(checkedAt, 'checkedAt');
  const { record, filePath } = loadTaskRecord(stateRoot, taskId);
  if (!transport || typeof transport.getTask !== 'function') {
    fail('CLOUD_LANE_INPUT_INVALID', 'status requires a transport exposing getTask.');
  }
  const raw = await transport.getTask(taskId);
  const rawStatus = raw && typeof raw.status === 'string' ? raw.status : null;
  const status = mapStatus(rawStatus);
  writeJsonRecord(filePath, { ...record, lastStatus: status, lastRawStatus: rawStatus, checkedAt });
  return { taskId, status, rawStatus, checkedAt };
}

// ---------------------------------------------------------------------------
// verify: the fail-closed A4 step (memory-only diff, metadata-only writes)
// ---------------------------------------------------------------------------

function stripCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

// '--- '/'+++ ' payload -> repo-relative path or null for /dev/null. Content
// after a tab (traditional timestamp suffix) is ignored; quoted paths are
// unquoted; a/ and b/ prefixes are stripped.
function parseDiffPathValue(rawValue) {
  let value = rawValue;
  const tab = value.indexOf('\t');
  if (tab !== -1) value = value.slice(0, tab);
  value = stripCr(value);
  if (value.startsWith('"')) {
    try { value = JSON.parse(value); } catch { return { error: 'unquotable path on a ---/+++ line' }; }
  }
  if (value === '/dev/null') return { path: null };
  if (value.startsWith('a/') || value.startsWith('b/')) return { path: value.slice(2) };
  return { path: value };
}

// Best-effort old==new extraction from `diff --git a/X b/X`; ambiguous or
// quoted headers return null and the ---/+++ lines stay authoritative.
function headerPathOf(headerLine) {
  const rest = headerLine.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  let searchFrom = 0;
  for (;;) {
    const split = rest.indexOf(' b/', searchFrom);
    if (split === -1) return null;
    const oldPath = rest.slice(2, split);
    const newPath = rest.slice(split + 3);
    if (oldPath === newPath) return oldPath;
    searchFrom = split + 1;
  }
}

// Consumes hunk bodies by their declared counts (the only way that survives
// content lines that look like headers). Parse failures carry line NUMBERS
// only -- raw diff bytes never leak into reasons or persisted state.
function consumeHunks(lines, startIndex, end, file) {
  let i = startIndex;
  while (i < end && !file.parseError) {
    const header = HUNK_HEADER.exec(stripCr(lines[i]));
    if (!header) break;
    file.hunks += 1;
    let oldRemaining = header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
    let newRemaining = header[4] === undefined ? 1 : Number.parseInt(header[4], 10);
    i += 1;
    let lastSide = null;
    while (i < end && (oldRemaining > 0 || newRemaining > 0)) {
      const raw = lines[i];
      const first = raw[0];
      if (first === '+') {
        file.addedLines.push(raw.slice(1));
        newRemaining -= 1;
        lastSide = '+';
      } else if (first === '-') {
        file.oldSideLines += 1;
        oldRemaining -= 1;
        lastSide = '-';
      } else if (first === ' ' || raw === '' || raw === '\r') {
        file.oldSideLines += 1;
        oldRemaining -= 1;
        newRemaining -= 1;
        lastSide = ' ';
      } else if (first === '\\') {
        if (lastSide === '+') file.newEndsWithoutNewline = true;
      } else {
        file.parseError = `unexpected hunk-body line at diff line ${i + 1}`;
        return i;
      }
      i += 1;
    }
    if (oldRemaining > 0 || newRemaining > 0) {
      file.parseError = `truncated hunk body at diff line ${i}`;
      return i;
    }
    if (i < end && lines[i].startsWith('\\')) {
      if (lastSide === '+') file.newEndsWithoutNewline = true;
      i += 1;
    }
  }
  return i;
}

function parseSection(lines, start, end) {
  const file = {
    headerPath: null,
    oldPath: undefined,
    newPath: undefined,
    renameFrom: null,
    renameTo: null,
    oldMode: null,
    newMode: null,
    newFileMode: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    isCopy: false,
    hasModeChangeHeaders: false,
    hunks: 0,
    oldSideLines: 0,
    addedLines: [],
    newEndsWithoutNewline: false,
    parseError: null
  };
  let i = start;
  if (stripCr(lines[i] || '').startsWith('diff --git ')) {
    file.headerPath = headerPathOf(stripCr(lines[i]));
    i += 1;
  }
  while (i < end && !file.parseError) {
    const s = stripCr(lines[i]);
    if (s.startsWith('--- ')) {
      const oldParsed = parseDiffPathValue(s.slice(4));
      if (oldParsed.error) { file.parseError = oldParsed.error; break; }
      file.oldPath = oldParsed.path;
      i += 1;
      const next = i < end ? stripCr(lines[i]) : '';
      if (!next.startsWith('+++ ')) { file.parseError = `missing +++ line after --- at diff line ${i + 1}`; break; }
      const newParsed = parseDiffPathValue(next.slice(4));
      if (newParsed.error) { file.parseError = newParsed.error; break; }
      file.newPath = newParsed.path;
      i += 1;
      i = consumeHunks(lines, i, end, file);
      while (i < end && !file.parseError) {
        if (stripCr(lines[i]) === '') { i += 1; continue; }
        file.parseError = `unexpected content after hunks at diff line ${i + 1}`;
      }
      continue;
    }
    if (s.startsWith('old mode ')) { file.oldMode = s.slice(9).trim(); file.hasModeChangeHeaders = true; i += 1; continue; }
    if (s.startsWith('new mode ')) { file.newMode = s.slice(9).trim(); file.hasModeChangeHeaders = true; i += 1; continue; }
    if (s.startsWith('new file mode ')) { file.newFileMode = s.slice(14).trim(); file.isNew = true; i += 1; continue; }
    if (s.startsWith('deleted file mode ')) { file.isDeleted = true; i += 1; continue; }
    if (s.startsWith('rename from ')) { file.renameFrom = s.slice(12); i += 1; continue; }
    if (s.startsWith('rename to ')) { file.renameTo = s.slice(10); i += 1; continue; }
    if (s.startsWith('copy from ') || s.startsWith('copy to ')) { file.isCopy = true; i += 1; continue; }
    if (s.startsWith('similarity index ') || s.startsWith('dissimilarity index ') || s.startsWith('index ')) { i += 1; continue; }
    if (s.startsWith('Binary files ') || s === 'GIT binary patch') { file.isBinary = true; i += 1; continue; }
    if (s === '') { i += 1; continue; }
    file.parseError = `unrecognized diff line at diff line ${i + 1}`;
  }
  const isNew = file.isNew || (file.oldPath === null && typeof file.newPath === 'string');
  const isDeleted = file.isDeleted || (file.newPath === null && typeof file.oldPath === 'string');
  const isRename = Boolean(file.renameFrom || file.renameTo)
    || (typeof file.oldPath === 'string' && typeof file.newPath === 'string' && file.oldPath !== file.newPath);
  const effectivePath = (typeof file.newPath === 'string' ? file.newPath : null)
    || file.renameTo
    || (isDeleted && typeof file.oldPath === 'string' ? file.oldPath : null)
    || file.headerPath
    || (typeof file.oldPath === 'string' ? file.oldPath : null);
  return { ...file, isNew, isDeleted, isRename, effectivePath };
}

// Split on `diff --git` section headers; fall back to a single bare ---/+++
// unified diff. No sections at all means unparseable, never "no changes".
function parseUnifiedDiff(diffText) {
  const lines = diffText.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (stripCr(lines[i]).startsWith('diff --git ')) starts.push(i);
  }
  if (starts.length === 0) {
    const bareStart = lines.findIndex((line) => stripCr(line).startsWith('--- '));
    const hasPlus = bareStart !== -1 && lines.slice(bareStart).some((line) => stripCr(line).startsWith('+++ '));
    if (!hasPlus) {
      return { ok: false, reason: 'no recognizable diff sections (no "diff --git" header and no ---/+++ pair)' };
    }
    return { ok: true, files: [parseSection(lines, bareStart, lines.length)] };
  }
  return {
    ok: true,
    files: starts.map((sectionStart, index) => parseSection(
      lines,
      sectionStart,
      index + 1 < starts.length ? starts[index + 1] : lines.length
    ))
  };
}

// The A4 verdict. PASS requires: exactly one changed path; it equals
// expectation.path; a pure addition (new regular file, no deletions, no
// context, no rename/copy/mode-change/binary); and the reconstructed added
// bytes hash to expectation.sha256 ('+' lines joined with '\n' plus a
// trailing '\n' unless the diff carries `\ No newline at end of file`).
// Everything else is FAIL with precise reasons. Reads memory only.
function verifyDiffAgainstExpectation(diffText, expectation) {
  const text = typeof diffText === 'string' ? diffText : '';
  const diffSha256 = sha256Hex(text);
  if (text.trim() === '') {
    return { verdict: 'FAIL', reasons: ['DIFF_EMPTY: the provider returned no diff content'], diffSha256, changedPaths: [] };
  }
  const parsed = parseUnifiedDiff(text);
  if (!parsed.ok) {
    return { verdict: 'FAIL', reasons: [`DIFF_UNPARSEABLE: ${parsed.reason}`], diffSha256, changedPaths: [] };
  }
  const files = parsed.files;
  const changedPaths = files.map((file) => file.effectivePath || '(unparsed path)');
  const reasons = [];
  for (const file of files) {
    if (file.parseError) reasons.push(`DIFF_UNPARSEABLE: ${file.parseError}`);
  }
  if (files.length !== 1) {
    reasons.push(`EXTRA_PATHS: expected exactly 1 changed path, found ${files.length} (${changedPaths.join(', ')})`);
  }
  if (files.length === 1 && !files[0].parseError) {
    const file = files[0];
    if (file.isBinary) reasons.push('BINARY_CONTENT: a binary patch cannot be byte-verified as a text addition');
    if (file.isRename || file.isCopy) {
      reasons.push(`RENAME_OR_COPY: ${file.renameFrom || file.oldPath || '?'} -> ${file.renameTo || file.newPath || '?'}`);
    }
    if (file.hasModeChangeHeaders) reasons.push(`MODE_CHANGE: ${file.oldMode || '?'} -> ${file.newMode || '?'}`);
    if (file.isDeleted) reasons.push(`DELETION: ${file.effectivePath}`);
    if (!file.isNew && !file.isDeleted) reasons.push(`NOT_A_NEW_FILE: ${file.effectivePath} changes an existing file`);
    if (file.oldSideLines > 0) reasons.push('NOT_PURE_ADDITION: the diff carries deletion or context lines');
    if (file.newFileMode && !REGULAR_FILE_MODES.includes(file.newFileMode)) {
      reasons.push(`UNSAFE_NEW_FILE_MODE: ${file.newFileMode}`);
    }
    if (file.effectivePath !== expectation.path) {
      reasons.push(`PATH_MISMATCH: expected ${expectation.path}, found ${file.effectivePath}`);
    }
    const pureAddition = file.isNew && !file.isDeleted && !file.isRename && !file.isCopy
      && !file.isBinary && !file.hasModeChangeHeaders && file.oldSideLines === 0;
    if (pureAddition) {
      const content = file.addedLines.length === 0
        ? ''
        : file.addedLines.join('\n') + (file.newEndsWithoutNewline ? '' : '\n');
      const actualSha256 = sha256Hex(content);
      if (actualSha256 !== expectation.sha256) {
        reasons.push(`CONTENT_SHA256_MISMATCH: expected ${expectation.sha256}, reconstructed ${actualSha256}`);
      }
    }
  }
  return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons, diffSha256, changedPaths };
}

async function runVerify({ transport, taskId, stateRoot, verifiedAt }) {
  requireIsoTimestamp(verifiedAt, 'verifiedAt');
  const { record, filePath } = loadTaskRecord(stateRoot, taskId);
  if (!transport || typeof transport.fetchTaskDiff !== 'function') {
    fail('CLOUD_LANE_INPUT_INVALID', 'verify requires a transport exposing fetchTaskDiff.');
  }
  // Memory only: the diff string is parsed and hashed here and never written
  // to any file, working tree, or state record.
  const diffText = await transport.fetchTaskDiff(taskId);
  const outcome = verifyDiffAgainstExpectation(diffText, record.expectation);
  writeJsonRecord(filePath, {
    ...record,
    verdict: outcome.verdict,
    verifyReasons: outcome.reasons,
    diffSha256: outcome.diffSha256,
    changedPaths: outcome.changedPaths,
    verifiedAt
  });
  return { taskId, verdict: outcome.verdict, reasons: outcome.reasons, diffSha256: outcome.diffSha256, changedPaths: outcome.changedPaths };
}

module.exports = Object.freeze({
  OUTBOUND_RECORD_SCHEMA,
  TASK_RECORD_SCHEMA,
  defaultExecImpl,
  parseLsTreeOutput,
  deriveAllowlist,
  buildOutboundRecord,
  runOutbound,
  runSubmit,
  runStatus,
  parseUnifiedDiff,
  verifyDiffAgainstExpectation,
  runVerify,
  outboundRecordPath,
  taskRecordPath
});
