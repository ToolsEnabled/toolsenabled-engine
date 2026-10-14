'use strict';

// Upgrade hygiene for 1.0.48's generated session homes. No sign-in file is
// opened: only asynchronous directory metadata, names, and unlink are used.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

// These expressions describe the old writers, not arbitrary backup files.
// credential-refresh-broker.repoint; providers/gemini-quota-storage.
const SIGN_INS = Object.freeze({
  codex: /^auth\.json(?:\.[0-9]+\.[0-9]+\.refresh)?$/,
  claude: /^\.credentials\.json(?:\.[0-9]+\.[0-9]+\.refresh)?$/,
  gemini: /^(?:oauth_creds\.json(?:\.[0-9]+\.[0-9]+\.refresh)?|oauth_creds\.toolsenabled-[a-f0-9]{32}\.tmp)$/,
});
const AGENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SESSION = /^[a-f0-9]{64}$/;
const TIERS = new Set(['guided', 'standard', 'unrestricted']);
const HELPER_TIMEOUT_MS = 30000;
const HELPER_OUTPUT_BYTES = 8 * 1024 * 1024;

function acceptedName(stage, name) {
  return stage === 0 ? AGENT.test(name)
    : stage === 1 ? name === '@sessions'
      : stage === 2 ? SESSION.test(name)
        : stage === 3 ? Object.hasOwn(SIGN_INS, name)
          : stage === 4 ? TIERS.has(name) : true;
}

async function cleanupLegacySignIns({ servicesRoot, fileSystem = fs, observe = () => {},
  platform = process.platform, environment = process.env, spawnImpl = spawn,
  timeoutMs = HELPER_TIMEOUT_MS, maxOutputBytes = HELPER_OUTPUT_BYTES } = {}) {
  const removed = [], refused = [], refusalKeys = new Set();
  function emit(row) {
    try { observe(row); } catch { /* Diagnostics cannot prevent startup. */ }
  }
  function refusal(file, reason) {
    const key = file + '\0' + reason;
    if (refusalKeys.has(key)) return;
    refusalKeys.add(key);
    refused.push({ path: file, reason });
    emit({ event: 'refused', path: file, reason });
  }
  function removedName(file) {
    removed.push(file);
    emit({ event: 'removed', path: file });
  }
  try {
    const root = servicesRoot === undefined
      ? require('./durable-memory-file').resolveServicesRoot() : servicesRoot;
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      refusal('agent-home', 'invalid-services-root');
    } else if (platform === 'win32') {
      // A fresh metadata check also notices a file reintroduced by a later
      // legacy launch. A permanent completion stamp must not hide that file.
      const found = await windowsNeedsCleanup(path.resolve(root), fileSystem.promises, refusal);
      if (found) await cleanWindows(path.resolve(root), removedName, refusal,
        { environment, spawnImpl, timeoutMs, maxOutputBytes });
    } else if (platform === 'linux') {
      await cleanLinux(path.resolve(root), fileSystem.promises, removedName, refusal);
    } else {
      refusal('agent-home', 'unsupported-platform');
    }
  } catch (error) {
    refusal('agent-home', safeCode(error));
  }
  const result = { removed, refused, removedCount: removed.length, complete: refused.length === 0 };
  const sentence = 'Removed ' + removed.length + ' legacy provider sign-in file'
    + (removed.length === 1 ? '' : 's') + ' from ToolsEnabled session homes.'
    + (refused.length ? ' Cleanup could not finish at ' + refused.length + ' path'
      + (refused.length === 1 ? '' : 's') + '; ToolsEnabled will retry next start.' : '');
  emit({ event: 'summary', removedCount: removed.length, refusedCount: refused.length,
    complete: result.complete, sentence });
  return result;
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : 'cleanup-unavailable';
}

async function cleanLinux(root, io, removed, refused) {
  // Child lookups stay anchored to open descriptors, with the original
  // O_NOFOLLOW and directory-identity checks preserved across async yields.
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  async function directory(parent, name, label, visit) {
    const file = parent === null ? name : path.join('/proc/self/fd', String(parent), name);
    let handle;
    try {
      const before = await io.lstat(file);
      if (before.isSymbolicLink()) { refused(label, 'directory-link'); return; }
      if (!before.isDirectory()) { refused(label, 'not-directory'); return; }
      handle = await io.open(file, flags);
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino) {
        refused(label, 'directory-changed'); return;
      }
      await visit(handle.fd);
    } catch (error) {
      if (error.code !== 'ENOENT') refused(label, safeCode(error));
    } finally {
      if (handle) await handle.close();
    }
  }
  async function names(fd, visit) {
    const dir = await io.opendir('/proc/self/fd/' + fd);
    try { for (let entry; (entry = await dir.read()) !== null;) await visit(entry.name); }
    finally { await dir.close(); }
  }
  async function leaves(fd, label, provider) {
    await names(fd, async name => {
      if (!SIGN_INS[provider].test(name)) return;
      const file = path.join('/proc/self/fd', String(fd), name);
      const relative = path.join(label, name);
      try {
        const stat = await io.lstat(file);
        if (!stat.isFile() && !stat.isSymbolicLink()) { refused(relative, 'not-file'); return; }
        // Remove only this name, including dangling symlinks and hard links.
        // Never truncate, overwrite, chmod, or resolve a sign-in target.
        await io.unlink(file);
        removed(relative);
      } catch (error) {
        if (error.code !== 'ENOENT') refused(relative, safeCode(error));
      }
    });
  }
  async function walk(fd, label, stage, provider) {
    if (stage === 6) {
      await leaves(fd, label, provider);
      if (provider === 'gemini') await directory(fd, '.gemini', path.join(label, '.gemini'),
        inner => leaves(inner, path.join(label, '.gemini'), provider));
      return;
    }
    await names(fd, async name => {
      if (!acceptedName(stage, name)) return;
      const relative = path.join(label, name);
      await directory(fd, name, relative, child => walk(child, relative, stage + 1, stage === 3 ? name : provider));
    });
  }
  const pieces = root.split(path.sep).filter(Boolean);
  async function ancestors(fd, index) {
    if (index < pieces.length) {
      await directory(fd, pieces[index], 'agent-home', child => ancestors(child, index + 1));
    } else {
      await directory(fd, 'agent-home', 'agent-home', home =>
        directory(home, '@agents', path.join('agent-home', '@agents'), agents =>
          walk(agents, path.join('agent-home', '@agents'), 0)));
    }
  }
  await directory(null, '/', 'agent-home', fd => ancestors(fd, 0));
}

async function windowsNeedsCleanup(root, io, refused) {
  // Windows scandir Dirents mark EVERY reparse attribute as a link, including
  // tags for which lstat can return an ordinary directory. Inspect the entry
  // in its parent first; never use realpath/readlink to expand an entry.
  const parsed = path.parse(root);
  const chain = [];
  const same = (left, right) => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
  async function entries(file, label) {
    try {
      // Recheck all admitted ancestors after each async yield. The native
      // deletion helper independently pins them against rename/reparse writes.
      for (const item of chain) {
        const siblings = await io.readdir(item.parent, { withFileTypes: true });
        const current = siblings.find(entry => same(entry.name, item.name));
        if (!current) return null;
        if (current.isSymbolicLink()) { refused(item.label, 'directory-link'); return null; }
        const stat = await io.lstat(item.file);
        if (!stat.isDirectory() || stat.dev !== item.stat.dev || stat.ino !== item.stat.ino) {
          refused(item.label, 'directory-changed'); return null;
        }
      }
      return await io.readdir(file, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') refused(label, safeCode(error));
      return null;
    }
  }
  async function directory(parent, entry, label, visit) {
    if (entry.isSymbolicLink()) { refused(label, 'directory-link'); return false; }
    if (!entry.isDirectory()) { refused(label, 'not-directory'); return false; }
    const file = path.join(parent, entry.name);
    let pushed = false;
    try {
      const stat = await io.lstat(file);
      if (stat.isSymbolicLink()) { refused(label, 'directory-link'); return false; }
      if (!stat.isDirectory()) { refused(label, 'not-directory'); return false; }
      chain.push({ parent, name: entry.name, file, label, stat }); pushed = true;
      return await visit(file);
    } catch (error) {
      if (error.code !== 'ENOENT') refused(label, safeCode(error));
      return false;
    } finally { if (pushed) chain.pop(); }
  }
  async function namedDirectory(parent, name, label, visit) {
    const list = await entries(parent, label);
    const entry = list?.find(item => same(item.name, name));
    return entry ? directory(parent, entry, label, visit) : false;
  }
  async function walk(file, label, stage, provider) {
    const list = await entries(file, label);
    if (!list) return false;
    if (stage === 6) {
      if (list.some(entry => SIGN_INS[provider].test(entry.name))) return true;
      if (provider === 'gemini') return namedDirectory(file, '.gemini', path.join(label, '.gemini'),
        async config => (await entries(config, path.join(label, '.gemini')))?.some(entry => SIGN_INS.gemini.test(entry.name)) || false);
      return false;
    }
    for (const entry of list) {
      if (!acceptedName(stage, entry.name)) continue;
      const relative = path.join(label, entry.name);
      if (await directory(file, entry, relative,
        child => walk(child, relative, stage + 1, stage === 3 ? entry.name : provider))) return true;
    }
    return false;
  }
  const pieces = root.slice(parsed.root.length).split(path.sep).filter(Boolean);
  async function ancestors(file, index) {
    if (index < pieces.length) return namedDirectory(file, pieces[index], 'agent-home', child => ancestors(child, index + 1));
    return namedDirectory(file, 'agent-home', 'agent-home', home =>
      namedDirectory(home, '@agents', path.join('agent-home', '@agents'),
        agents => walk(agents, path.join('agent-home', '@agents'), 0)));
  }
  return ancestors(parsed.root, 0);
}

async function cleanWindows(root, removed, refused, { environment, spawnImpl, timeoutMs, maxOutputBytes }) {
  // Only the existing native helper deletes files on Windows. It retains
  // OPEN_REPARSE_POINT and pinned ancestor handles. Compilation now happens
  // in the asynchronous child, never on Electron's main/event-loop thread.
  const windows = environment.SystemRoot || environment.WINDIR;
  if (!windows || !path.win32.isAbsolute(windows)) { refused('agent-home', 'windows-system-root-unavailable'); return; }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    refused('agent-home', 'invalid-helper-bounds'); return;
  }
  const executable = path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await new Promise(resolve => {
    let child, timer, stopReason = null, completed = false, settled = false, bytes = 0, pending = '';
    let exited = false, exitCode = null;
    const decoder = new StringDecoder('utf8');
    function receipt(line) {
      if (!line) return;
      try {
        const row = JSON.parse(line);
        if (row.event === 'removed' && typeof row.path === 'string') removed(row.path);
        else if (row.event === 'refused' && typeof row.path === 'string' && typeof row.reason === 'string') refused(row.path, row.reason);
        else if (row.event === 'complete') completed = true;
        else stopReason ||= 'EPROTO';
      } catch { stopReason ||= 'EPROTO'; }
    }
    function finish(code) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // A compiler descendant may retain inherited pipes after the owned
      // PowerShell has exited. Its pipes cannot extend the cleanup deadline.
      child?.stdout?.destroy(); child?.stderr?.destroy();
      pending += decoder.end();
      if (pending) receipt(pending);
      if (stopReason || code !== 0 || !completed) refused('agent-home', stopReason || 'windows-helper-incomplete');
      resolve();
    }
    function stop(reason) {
      if (settled || stopReason === 'ETIMEDOUT' || stopReason === 'ENOBUFS') return;
      stopReason = reason;
      if (exited) { finish(exitCode); return; }
      try { child.kill('SIGKILL'); } catch { /* The child may already have exited. */ }
    }
    try {
      child = spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'legacy-signin-cleanup.ps1'), '-ServicesRoot', root],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.fromEntries(Object.entries(environment).filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(key))) });
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxOutputBytes) { stop('ENOBUFS'); return; }
        pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          receipt(pending.slice(0, newline).replace(/\r$/, ''));
          pending = pending.slice(newline + 1);
        }
      });
      // Drain compiler/errors without logging raw output or leaving the pipe
      // blocked. Stderr shares the same bounded transport budget.
      child.stderr.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxOutputBytes) stop('ENOBUFS');
      });
      child.once('error', error => { stopReason = safeCode(error); finish(null); });
      child.once('exit', code => {
        exited = true; exitCode = code;
        if (stopReason) finish(code);
      });
      child.once('close', code => finish(code));
      timer = setTimeout(() => stop('ETIMEDOUT'), timeoutMs);
    } catch (error) { stopReason = safeCode(error); finish(null); }
  });
}

module.exports = { cleanupLegacySignIns };
