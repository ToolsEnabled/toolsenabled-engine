#!/usr/bin/env node
'use strict';

// Bounded, explicitly-invoked cleanup for orphaned Playwright temp profile and
// artifact directories left behind in %TEMP% by crashed, killed, or otherwise
// ungracefully terminated Chromium launches. This never runs automatically as
// a background sweeper -- an owner or agent must invoke it directly.
//
// Safety model:
//   - Scope is fixed to direct children of the resolved %TEMP% root whose
//     name is Playwright-prefixed (`playwright_` or `playwright-`). The
//     ToolsEnabled-owned browser profile (profiles/chrome) and the owner's
//     default Chrome profile are never inside %TEMP% and never match that
//     prefix; both are also explicitly guarded against below in case that
//     ever changes.
//   - Age-gated: a directory whose mtime is more recent than --min-age-hours
//     (default 4) is left alone, since a just-created directory could belong
//     to a launch that is still starting up.
//   - Liveness-checked: before deleting, every live process's command line is
//     enumerated and checked for a reference to the exact candidate path. Any
//     match (e.g. a `--user-data-dir=<path>` argument) skips that directory.
//     If the live process list cannot be obtained at all, nothing is deleted
//     -- this tool fails closed rather than guessing.
//
// Usage: node tools/reap-playwright-temp.js [--dry-run] [--min-age-hours N]

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../src/lib/runtime');

const NAME_PATTERN = /^playwright[_-]/i;
const DEFAULT_MIN_AGE_HOURS = 4;
const PROCESS_LIST_TIMEOUT_MS = 15000;

function parseArgs(argv) {
  const options = { dryRun: false, minAgeHours: DEFAULT_MIN_AGE_HOURS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') { options.dryRun = true; continue; }
    if (flag === '--min-age-hours') {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('--min-age-hours must be a non-negative number.');
      }
      options.minAgeHours = value;
      index += 1;
      continue;
    }
    throw new Error(`Unrecognized argument '${flag}'.`);
  }
  return options;
}

function tempRoot(dependencies = {}) {
  const fsApi = dependencies.fs || fs;
  const configured = (dependencies.env || process.env).TEMP || (dependencies.env || process.env).TMP;
  if (typeof configured !== 'string' || !configured || !path.isAbsolute(configured)) {
    throw new Error('%TEMP% is not configured as an absolute path; refusing to guess a cleanup root.');
  }
  let real;
  try { real = fsApi.realpathSync(path.resolve(configured)); }
  catch (error) { throw new Error(`%TEMP% (${configured}) could not be resolved: ${error.message}`); }
  const stat = fsApi.lstatSync(real);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('%TEMP% does not resolve to a direct directory.');
  }
  return real;
}

function directorySizeBytes(directory, dependencies = {}) {
  const fsApi = dependencies.fs || fs;
  let total = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try { entries = fsApi.readdirSync(current, { withFileTypes: true }); }
    catch (error) { throw new Error(`Unable to size ${current}: ${error.message}`); }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue; // Never follow links while sizing or reaping.
      if (entry.isDirectory()) { stack.push(full); continue; }
      try { total += fsApi.statSync(full).size; }
      catch (error) { throw new Error(`Unable to size ${full}: ${error.message}`); }
    }
  }
  return total;
}

// Enumerates every live process's command line via a single read-only CIM
// query. Used only to confirm a candidate directory is not referenced by
// (e.g. opened as --user-data-dir by) a still-running process.
function liveProcessCommandLines(dependencies = {}) {
  const runner = dependencies.run || run;
  const result = runner('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine | ConvertTo-Json -Compress'
  ], { timeout: PROCESS_LIST_TIMEOUT_MS });
  if (result.status !== 0) {
    throw new Error('Unable to enumerate live processes; refusing to reap without a liveness check.');
  }
  const raw = String(result.stdout || '').trim();
  if (!raw) throw new Error('Live process enumeration returned no result; refusing to reap.');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Live process enumeration returned an unparseable result; refusing to reap.'); }
  if (parsed === null) throw new Error('Live process enumeration returned no process data; refusing to reap.');
  if (typeof parsed === 'string') {
    if (!parsed.trim()) throw new Error('Live process enumeration returned an empty command line; refusing to reap.');
    return [parsed];
  }
  if (!Array.isArray(parsed)) throw new Error('Live process enumeration returned an unexpected shape; refusing to reap.');
  if (parsed.length === 0) throw new Error('Live process enumeration returned no processes; refusing to reap.');
  if (parsed.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('Live process enumeration omitted one or more command lines; refusing to reap.');
  }
  return parsed;
}

function isReferencedByLiveProcess(directory, commandLines) {
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactPath = new RegExp(`(?:^|[\\s"'=])${escaped}(?=$|[\\s"'])`, 'i');
  return commandLines.some(line => typeof line === 'string' && exactPath.test(line));
}

function guardedPaths(dependencies = {}) {
  const environment = dependencies.env || process.env;
  const fsApi = dependencies.fs || fs;
  const candidates = [
    dependencies.ownedProfile || require('../src/lib/browser-owner').configuredProfile(environment),
    environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : null
  ].filter(value => typeof value === 'string' && value);
  return candidates.map(value => {
    const resolved = path.resolve(value);
    try { return fsApi.realpathSync(resolved).toLowerCase(); }
    catch (error) {
      if (error && error.code === 'ENOENT') return resolved.toLowerCase();
      throw new Error(`Guarded path (${resolved}) could not be resolved: ${error.message}`);
    }
  });
}

function reap(options = {}, dependencies = {}) {
  const fsApi = dependencies.fs || fs;
  const root = dependencies.tempRoot ? dependencies.tempRoot(dependencies) : tempRoot(dependencies);
  const guarded = guardedPaths(dependencies);
  const minAgeMs = options.minAgeHours * 60 * 60 * 1000;

  let entries;
  try { entries = fsApi.readdirSync(root, { withFileTypes: true }); }
  catch (error) { throw new Error(`Unable to list %TEMP% (${root}): ${error.message}`); }

  const candidates = entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && NAME_PATTERN.test(entry.name))
    .map(entry => path.join(root, entry.name));

  const results = { removed: [], skippedLive: [], skippedRecent: [], skippedError: [], reclaimedBytes: 0 };
  if (candidates.length === 0) return results;

  const now = dependencies.now ? dependencies.now() : Date.now();
  const commandLines = (dependencies.liveProcessCommandLines || liveProcessCommandLines)(dependencies);

  for (const candidate of candidates) {
    try {
      const stat = fsApi.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        results.skippedError.push({ path: candidate, reason: 'not a plain directory' });
        continue;
      }
      const real = fsApi.realpathSync(candidate);
      if (path.dirname(real) !== root) {
        results.skippedError.push({ path: candidate, reason: 'resolves outside %TEMP%' });
        continue;
      }
      if (guarded.includes(real.toLowerCase())) {
        results.skippedError.push({ path: candidate, reason: 'guarded path' });
        continue;
      }

      const ageMs = now - stat.mtimeMs;
      if (!(ageMs >= minAgeMs)) {
        results.skippedRecent.push({ path: candidate, ageMs });
        continue;
      }

      if (isReferencedByLiveProcess(real, commandLines)) {
        results.skippedLive.push({ path: candidate });
        continue;
      }

      const bytes = directorySizeBytes(real, dependencies);
      if (!options.dryRun) fsApi.rmSync(real, { recursive: true, force: false });
      results.removed.push({ path: candidate, bytes });
      results.reclaimedBytes += bytes;
    } catch (error) {
      results.skippedError.push({ path: candidate, reason: (error && error.message) || String(error) });
    }
  }
  return results;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; return; }

  let results;
  try { results = reap(options); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; return; }

  const verb = options.dryRun ? 'Would remove' : 'Removed';
  for (const item of results.removed) {
    process.stdout.write(`${verb}: ${item.path} (${formatBytes(item.bytes)})\n`);
  }
  for (const item of results.skippedLive) process.stdout.write(`Skipped (referenced by a live process): ${item.path}\n`);
  for (const item of results.skippedRecent) {
    process.stdout.write(`Skipped (too recent, ${Math.round(item.ageMs / 60000)}m old): ${item.path}\n`);
  }
  for (const item of results.skippedError) process.stdout.write(`Skipped (${item.reason}): ${item.path}\n`);
  const reclaimWord = options.dryRun ? 'reclaimable' : 'reclaimed';
  process.stdout.write(
    `${verb} ${results.removed.length} director${results.removed.length === 1 ? 'y' : 'ies'}, `
    + `${reclaimWord} ${formatBytes(results.reclaimedBytes)}.\n`
  );
}

if (require.main === module) main();

module.exports = {
  DEFAULT_MIN_AGE_HOURS,
  NAME_PATTERN,
  directorySizeBytes,
  guardedPaths,
  isReferencedByLiveProcess,
  liveProcessCommandLines,
  parseArgs,
  reap,
  tempRoot
};
