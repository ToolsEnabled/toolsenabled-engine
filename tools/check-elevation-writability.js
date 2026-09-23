'use strict';

// Report every program this machine will run WITH ADMINISTRATOR RIGHTS that a
// non-administrator is able to rewrite.
//
// Read-only. Needs no elevation. Changes nothing. Exit 0 = clean, 1 = at least
// one elevation door can be repointed by someone who is not an administrator,
// 2 = the check could not run (which is not a pass).
//
// WHY THE PARENT DIRECTORY IS CHECKED TOO, AND WHY IT IS THE DECIDING ONE.
// On NTFS, Modify on a FOLDER includes DeleteSubdirectoriesAndFiles. A
// principal holding Modify on the folder can therefore delete the program and
// write their own in its place even when the program's own ACL denies them
// everything. Tightening the file alone looks like a fix, reads like a fix in
// review, and closes nothing. So the directory is reported as its own target
// with its own verdict, and the summary refuses to call a host clean while any
// container of an elevated program is writable.
//
// PORTABILITY. No task name, path, account, or SID is written down here.
// Elevated tasks are discovered from the live Task Scheduler, the account each
// one runs as is read from its own registration, and ACLs are read from the
// files those registrations name.

const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { evaluateElevationWritability, formatReport } = require('../src/lib/elevation-writability');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

// Collected per action: the executable, plus anything in the argument string
// that is an absolute path to something executable-as-source. A -File or a
// bare script path is the usual shape; both are covered.
const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ps1', '.psm1', '.bat', '.cmd', '.vbs', '.exe', '.dll']);

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$tasks = @()
foreach ($t in (Get-ScheduledTask -ErrorAction Stop)) {
  if ($t.Principal.RunLevel -ne 'Highest') { continue }
  if ($t.State -eq 'Disabled') { continue }
  $acts = @()
  foreach ($a in $t.Actions) {
    $acts += [pscustomobject]@{ execute = [string]$a.Execute; arguments = [string]$a.Arguments }
  }
  # The account a task runs as may be recorded as either a name or an SID.
  # Comparisons downstream are by SID, so resolve it here rather than letting
  # the owner's own account be reported as a stranger.
  # Get-ScheduledTask reports UserId as a bare account NAME for local accounts
  # and as an SID for others. A bare name does not always translate on its own,
  # so the machine name is tried as the domain before giving up.
  $sid = ''
  $uid = [string]$t.Principal.UserId
  if ($uid -match '^S-1-') {
    $sid = $uid
  } else {
    foreach ($candidate in @($uid, ("$env:COMPUTERNAME\$uid"))) {
      if ($sid) { break }
      try { $sid = (New-Object System.Security.Principal.NTAccount($candidate)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { }
    }
    if (-not $sid) { throw "Could not resolve scheduled-task account '$uid' to an SID" }
  }
  $tasks += [pscustomobject]@{
    name    = [string]$t.TaskName
    userId  = [string]$t.Principal.UserId
    userSid = [string]$sid
    state   = [string]$t.State
    actions = $acts
  }
}
[pscustomobject]@{ tasks = $tasks } | ConvertTo-Json -Depth 8 -Compress
`;

const PS_ACL = String.raw`
$ErrorActionPreference = 'Stop'
# -split takes a REGEX, so the delimiter is escaped. Unescaped, "|SEP|" reads as
# an alternation of two empty branches and splits between every character.
$paths = $env:TE_ACL_TARGETS -split '\|SEP\|'
$out = @()
foreach ($p in $paths) {
  if ([string]::IsNullOrWhiteSpace($p)) { continue }
  $entry = [pscustomobject]@{ path = $p; exists = $false; error = ''; aces = @() }
  try {
    if (Test-Path -LiteralPath $p) {
      $entry.exists = $true
      $acl = Get-Acl -LiteralPath $p
      $aces = @()
      foreach ($a in $acl.Access) {
        $sid = ''
        $sid = $a.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        $aces += [pscustomobject]@{
          sid       = [string]$sid
          name      = [string]$a.IdentityReference.Value
          rights    = [string]$a.FileSystemRights
          type      = [string]$a.AccessControlType
          inherited = [bool]$a.IsInherited
        }
      }
      $entry.aces = $aces
    }
  } catch { $entry.error = [string]$_.Exception.Message }
  $out += $entry
}
[pscustomobject]@{ targets = $out } | ConvertTo-Json -Depth 8 -Compress
`;

function runPowerShell(script, env) {
  const res = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: safeLaunchEnvironment({ ...process.env, ...(env || {}) }, { context: 'elevation writability check' }),
    });
  if (res.error) throw new Error(`powershell could not be started: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`powershell exited ${res.status}: ${String(res.stderr || '').trim()}`);
  const text = String(res.stdout || '').trim();
  if (!text) throw new Error('powershell returned no output');
  return JSON.parse(text);
}

/** Expand %VAR% the way Task Scheduler does before a path is usable. */
function expandWindowsEnv(value) {
  return String(value).replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return key ? process.env[key] : whole;
  });
}

function isAbsoluteWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/**
 * Absolute paths named by a task action: the executable and any script
 * argument. A token that is not an absolute path is skipped rather than
 * guessed at -- resolving it against a working directory would invent a target
 * and report an ACL for a file the task may never run.
 */
function pathsFromAction(action = {}) {
  const found = [];
  const execute = expandWindowsEnv(String(action.execute || '').trim().replace(/^"|"$/g, ''));
  if (execute && isAbsoluteWindowsPath(execute)) found.push(execute);

  const args = String(action.arguments || '');
  // Quoted runs first, then whatever is left once the quoted runs are removed.
  const tokens = [];
  const quoted = /"([^"]+)"/g;
  let m;
  while ((m = quoted.exec(args)) !== null) tokens.push(m[1]);
  for (const bare of args.replace(/"[^"]+"/g, ' ').split(/\s+/)) if (bare) tokens.push(bare);

  for (const raw of tokens) {
    const token = expandWindowsEnv(raw.trim());
    if (!isAbsoluteWindowsPath(token)) continue;
    if (!SCRIPT_EXTENSIONS.has(path.extname(token).toLowerCase())) continue;
    found.push(token);
  }
  return found;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');

  if (os.platform() !== 'win32') {
    console.error('This check reads Windows scheduled tasks and NTFS ACLs; it does not apply on this platform.');
    return 2;
  }

  let discovered;
  try {
    discovered = runPowerShell(PS_SCRIPT);
  } catch (error) {
    console.error(`Could not enumerate scheduled tasks: ${error.message}`);
    console.error('Treat this as UNKNOWN, not as a pass.');
    return 2;
  }

  const rawTasks = Array.isArray(discovered.tasks)
    ? discovered.tasks
    : (discovered.tasks ? [discovered.tasks] : []);

  // path -> { reason, taskAccountSid }
  const targets = new Map();
  for (const task of rawTasks) {
    const actions = Array.isArray(task.actions) ? task.actions : (task.actions ? [task.actions] : []);
    for (const action of actions) {
      for (const p of pathsFromAction(action)) {
        const accountSid = task.userSid || task.userId;
        const reason = `scheduled task "${task.name}" runs it at RunLevel=Highest`;
        if (!targets.has(p)) targets.set(p, { reason, taskAccountSid: accountSid });
        // The containing directory: Modify there permits delete-and-replace.
        const dir = path.dirname(p);
        if (dir && dir !== p && !targets.has(dir)) {
          targets.set(dir, {
            reason: `contains a program run elevated by "${task.name}"; Modify here permits delete-and-replace`,
            taskAccountSid: accountSid,
          });
        }
      }
    }
  }

  if (targets.size === 0) {
    const empty = evaluateElevationWritability({ targets: [] });
    console.log(formatReport(empty));
    return 2;
  }

  let acls;
  try {
    acls = runPowerShell(PS_ACL, { TE_ACL_TARGETS: [...targets.keys()].join('|SEP|') });
  } catch (error) {
    console.error(`Could not read access-control lists: ${error.message}`);
    console.error('Treat this as UNKNOWN, not as a pass.');
    return 2;
  }

  const rawTargets = Array.isArray(acls.targets) ? acls.targets : (acls.targets ? [acls.targets] : []);
  const evaluated = [];
  const unreadable = [];
  const expectedPaths = new Map([...targets.keys()].map((p) => [p.toLowerCase(), p]));
  const returnedPaths = new Set();
  for (const t of rawTargets) {
    const returnedPath = String(t.path || '');
    const pathKey = returnedPath.toLowerCase();
    const expectedPath = expectedPaths.get(pathKey);
    if (!expectedPath) {
      unreadable.push({ path: returnedPath || '<missing path>', why: 'unexpected ACL result' });
      continue;
    }
    if (returnedPaths.has(pathKey)) {
      unreadable.push({ path: returnedPath, why: 'duplicate ACL result' });
      continue;
    }
    returnedPaths.add(pathKey);
    const meta = targets.get(expectedPath);
    if (!t.exists || t.error) {
      unreadable.push({ path: expectedPath, why: t.error || 'not found' });
      continue;
    }
    const aces = (Array.isArray(t.aces) ? t.aces : (t.aces ? [t.aces] : [])).map((a) => ({
      principal: { sid: a.sid, name: a.name },
      rights: a.rights,
      type: a.type,
      inherited: a.inherited,
    }));
    evaluated.push({ path: expectedPath, reason: meta.reason, aces, taskAccountSid: meta.taskAccountSid });
  }
  for (const [pathKey, expectedPath] of expectedPaths) {
    if (!returnedPaths.has(pathKey)) unreadable.push({ path: expectedPath, why: 'no ACL result returned' });
  }

  const result = evaluateElevationWritability({ targets: evaluated });

  if (asJson) {
    console.log(JSON.stringify({ ...result, unreadable }, null, 2));
  } else {
    console.log('Programs this machine runs with administrator rights, and who can rewrite them');
    console.log('='.repeat(78));
    console.log(formatReport(result, { onlyFailures: !argv.includes('--verbose') }));
    if (unreadable.length > 0) {
      console.log('');
      console.log('NOT CHECKED (treat as unknown, not clean):');
      for (const u of unreadable) console.log(`  ${u.path} -- ${u.why}`);
    }
  }

  if (unreadable.length > 0) return 2;
  return result.ok ? 0 : 1;
}

process.exit(main());
