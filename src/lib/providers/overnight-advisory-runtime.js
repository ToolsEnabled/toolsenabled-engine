'use strict';

// Exact-PID lifecycle ownership for the separate local advisory worker.  A
// record is valid only when both PID and Windows creation ticks still match.
// Lifecycle mutation is additionally protected by an atomically-created,
// process-identity-bound lock.  A lock whose identity cannot be proven is
// deliberately not reclaimed automatically: a second lifecycle request must
// fail closed rather than race a possibly-live owner.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { rootPath } = require('../runtime');

const TICKS = /^\d{12,20}$/;
const LOCK_KIND = 'overnight-advisory-lifecycle-lock';
const PLATFORM_UNSUPPORTED = 'OVERNIGHT_ADVISORY_WORKER_PLATFORM_UNSUPPORTED';
const PLATFORM_UNSUPPORTED_MESSAGE = 'Overnight advisory worker lifecycle control is available only on Windows.';

function defaultRuntimeDirectory() {
  const configured = String(process.env.OVERNIGHT_ADVISORY_RUNTIME_DIR || '').trim();
  const stateDirectory = String(process.env.OVERNIGHT_ADVISORY_STATE_DIR || '').trim();
  return path.resolve(configured || path.join(stateDirectory || rootPath('state'), 'overnight-advisory-runtime'));
}

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanupFailure(code, message, primaryError, cleanupError) {
  const error = new AggregateError([primaryError, cleanupError], message, { cause: primaryError });
  error.code = code;
  return error;
}

function validatePid(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) throw new Error('Overnight advisory worker PID is invalid.');
  return value;
}

function validStartTicks(value) { return typeof value === 'string' && TICKS.test(value); }

function windowsStartTicks(pid) {
  validatePid(pid);
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive', '-Command',
      `[Console]::Write((Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks)`
      // A cold powershell.exe costs 5.3 s on a real Windows box (measured
      // 2026-09-02), so five seconds timed out on the first ask a process
      // makes. The budget bounds a wedged shell; it is not a latency target.
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30_000 }).trim();
    if (!validStartTicks(output)) {
      throw runtimeError('OVERNIGHT_ADVISORY_PROCESS_IDENTITY_UNAVAILABLE', 'The process start time could not be established.');
    }
    return output;
  } catch (error) {
    if (error && error.code === 'OVERNIGHT_ADVISORY_PROCESS_IDENTITY_UNAVAILABLE') throw error;
    throw runtimeError('OVERNIGHT_ADVISORY_PROCESS_IDENTITY_UNAVAILABLE', 'The process start time could not be established.');
  }
}

function isAlive(pid) {
  // process.kill(pid, 0) throws ESRCH when the process genuinely does not
  // exist, but EPERM when it exists and the caller merely lacks permission
  // to signal it -- a real condition here, since this session runs
  // unelevated. Collapsing both into "dead" reads a live worker running
  // under a different privilege context as dead, which risks a duplicate
  // spawn believing it is "restarting" something that was never down.
  try { process.kill(validatePid(pid), 0); return true; }
  catch (error) {
    if (error && error.code === 'ESRCH') return false;
    if (error && error.code === 'EPERM') return true;
    throw runtimeError('OVERNIGHT_ADVISORY_PROCESS_LIVENESS_UNAVAILABLE', 'The process liveness could not be established.');
  }
}

function defaultLaunch(workerFile, environment) {
  const child = spawn(process.execPath, [workerFile], { cwd: rootPath(), env: environment, detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  return child;
}

// This helper deliberately uses kernel process handles, never taskkill /pid.
// The latter takes a fresh PID lookup after the JavaScript identity check and
// can therefore kill an unrelated recycled PID.  The native helper opens and
// verifies the root once, opens every current descendant before stopping it,
// freezes that exact tree, rechecks it, then terminates those handles only.
// It is compiled in the short-lived local PowerShell process so no unmanaged
// executable or long-lived privileged service is added to the host.
const WINDOWS_EXACT_TREE_STOP_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class ToolsEnabledOvernightExactTreeStop {
  private const uint TH32CS_SNAPPROCESS = 0x00000002;
  private const uint PROCESS_TERMINATE = 0x0001;
  private const uint PROCESS_SUSPEND_RESUME = 0x0800;
  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  private const uint SYNCHRONIZE = 0x00100000;
  private const uint WAIT_OBJECT_0 = 0;
  private const uint WAIT_TIMEOUT = 258;
  private const uint WAIT_FAILED = 0xFFFFFFFF;
  private const int ERROR_INVALID_PARAMETER = 87;
  private const int ERROR_NOT_FOUND = 1168;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  private struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FILETIME {
    public uint dwLowDateTime;
    public uint dwHighDateTime;
  }

  private sealed class Target {
    public int Pid;
    public int Depth;
    public IntPtr Handle;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  private static extern int NtSuspendProcess(IntPtr process);
  [DllImport("ntdll.dll")]
  private static extern int NtResumeProcess(IntPtr process);

  private static bool IsInvalid(IntPtr handle) {
    return handle == IntPtr.Zero || handle == new IntPtr(-1);
  }

  private static void Close(IntPtr handle) {
    if (!IsInvalid(handle)) CloseHandle(handle);
  }

  private static long ToDateTimeTicks(FILETIME time) {
    long fileTime = ((long)time.dwHighDateTime << 32) | time.dwLowDateTime;
    return DateTime.FromFileTimeUtc(fileTime).Ticks;
  }

  private static long CreationTicks(IntPtr handle) {
    FILETIME creation, exit, kernel, user;
    if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read the owned process creation time.");
    }
    return ToDateTimeTicks(creation);
  }

  private static bool IsActive(IntPtr handle) {
    uint state = WaitForSingleObject(handle, 0);
    if (state == WAIT_TIMEOUT) return true;
    if (state == WAIT_OBJECT_0) return false;
    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not verify the owned process handle.");
  }

  private static IntPtr OpenExactCapableProcess(int processId, out bool vanished) {
    vanished = false;
    IntPtr handle = OpenProcess(PROCESS_TERMINATE | PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, processId);
    if (!IsInvalid(handle)) return handle;
    int error = Marshal.GetLastWin32Error();
    if (error == ERROR_INVALID_PARAMETER || error == ERROR_NOT_FOUND) {
      vanished = true;
      return IntPtr.Zero;
    }
    throw new Win32Exception(error, "Could not obtain an exact stop handle for a process in the owned worker tree.");
  }

  private static Dictionary<int, int> SnapshotParents() {
    IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (IsInvalid(snapshot)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not snapshot the process tree.");
    try {
      var parents = new Dictionary<int, int>();
      PROCESSENTRY32 entry = new PROCESSENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (!Process32First(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read the process snapshot.");
      do {
        if (entry.th32ProcessID > 0 && entry.th32ProcessID <= Int32.MaxValue && entry.th32ParentProcessID <= Int32.MaxValue) {
          parents[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID;
        }
        entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      } while (Process32Next(snapshot, ref entry));
      int terminal = Marshal.GetLastWin32Error();
      if (terminal != 18) throw new Win32Exception(terminal, "The process snapshot ended unexpectedly.");
      return parents;
    } finally { Close(snapshot); }
  }

  private static List<int> Tree(int rootPid, Dictionary<int, int> parents) {
    var result = new List<int>();
    var seen = new HashSet<int>();
    var frontier = new Queue<int>();
    seen.Add(rootPid);
    frontier.Enqueue(rootPid);
    while (frontier.Count > 0) {
      int parent = frontier.Dequeue();
      result.Add(parent);
      foreach (KeyValuePair<int, int> entry in parents) {
        if (entry.Value == parent && !seen.Contains(entry.Key)) {
          seen.Add(entry.Key);
          frontier.Enqueue(entry.Key);
        }
      }
    }
    return result;
  }

  private static bool SameTree(List<int> left, List<int> right) {
    if (left.Count != right.Count) return false;
    var values = new HashSet<int>(left);
    if (values.Count != right.Count) return false;
    foreach (int value in right) if (!values.Contains(value)) return false;
    return true;
  }

  private static int Depth(int pid, int rootPid, Dictionary<int, int> parents) {
    int depth = 0;
    int current = pid;
    var seen = new HashSet<int>();
    while (current != rootPid) {
      if (!seen.Add(current) || !parents.ContainsKey(current)) return -1;
      current = parents[current];
      depth += 1;
      if (depth > 1024) return -1;
    }
    return depth;
  }

  private static void CloseAllExcept(List<Target> targets, IntPtr except) {
    foreach (Target target in targets) if (target.Handle != except) Close(target.Handle);
  }

  private static void ResumeAll(List<Target> targets) {
    foreach (Target target in targets) {
      try { if (IsActive(target.Handle)) NtResumeProcess(target.Handle); }
      catch { }
    }
  }

  public static void Stop(int rootPid, long expectedStartTicks) {
    if (rootPid < 1 || expectedStartTicks < 1) throw new InvalidOperationException("The exact owned worker identity is invalid.");
    bool vanished = false;
    IntPtr rootHandle = OpenExactCapableProcess(rootPid, out vanished);
    if (vanished || IsInvalid(rootHandle)) throw new InvalidOperationException("The owned worker no longer exists.");
    try {
      if (CreationTicks(rootHandle) != expectedStartTicks || !IsActive(rootHandle)) {
        throw new InvalidOperationException("The recorded worker PID no longer names the owned process.");
      }

      // A process tree can be changing while an advisory task is ending.  Do
      // not guess which descendants belong to us: retry a bounded number of
      // stable snapshots, then fail closed without terminating anything.
      for (int attempt = 0; attempt < 3; attempt += 1) {
        List<Target> targets = new List<Target>();
        bool suspended = false;
        bool complete = false;
        try {
          Dictionary<int, int> before = SnapshotParents();
          List<int> ids = Tree(rootPid, before);
          if (!before.ContainsKey(rootPid)) continue;
          foreach (int id in ids) {
            bool disappeared = false;
            IntPtr handle = id == rootPid ? rootHandle : OpenExactCapableProcess(id, out disappeared);
            if (disappeared || IsInvalid(handle)) {
              CloseAllExcept(targets, rootHandle);
              targets = new List<Target>();
              break;
            }
            targets.Add(new Target { Pid = id, Depth = Depth(id, rootPid, before), Handle = handle });
          }
          if (targets.Count != ids.Count || !IsActive(rootHandle) || CreationTicks(rootHandle) != expectedStartTicks) continue;
          Dictionary<int, int> stable = SnapshotParents();
          if (!SameTree(ids, Tree(rootPid, stable))) continue;
          bool allActive = true;
          foreach (Target target in targets) if (!IsActive(target.Handle)) { allActive = false; break; }
          if (!allActive) continue;

          targets.Sort(delegate(Target left, Target right) { return right.Depth.CompareTo(left.Depth); });
          // Mark before the first suspension so an error part-way through
          // always resumes every exact handle already frozen by this attempt.
          suspended = true;
          foreach (Target target in targets) {
            if (NtSuspendProcess(target.Handle) != 0) throw new InvalidOperationException("Could not freeze the exact owned worker tree before termination.");
          }
          Dictionary<int, int> frozen = SnapshotParents();
          if (!SameTree(ids, Tree(rootPid, frozen)) || !IsActive(rootHandle) || CreationTicks(rootHandle) != expectedStartTicks) continue;
          allActive = true;
          foreach (Target target in targets) if (!IsActive(target.Handle)) { allActive = false; break; }
          if (!allActive) continue;

          // Root last: every opened handle denotes the process observed in the
          // frozen tree, so a PID recycled after this point cannot be killed.
          targets.Sort(delegate(Target left, Target right) {
            if (left.Pid == rootPid) return 1;
            if (right.Pid == rootPid) return -1;
            return right.Depth.CompareTo(left.Depth);
          });
          foreach (Target target in targets) {
            if (!IsActive(target.Handle)) continue;
            if (!TerminateProcess(target.Handle, 1) && IsActive(target.Handle)) {
              throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not terminate an exact process in the owned worker tree.");
            }
          }
          complete = true;
          return;
        } finally {
          if (suspended && !complete) ResumeAll(targets);
          // rootHandle belongs to this method, but it is also present in the
          // target set.  Close it exactly once below.
          foreach (Target target in targets) if (target.Handle != rootHandle) Close(target.Handle);
        }
      }
      throw new InvalidOperationException("The owned worker process tree changed during exact stop preparation.");
    } finally { Close(rootHandle); }
  }
}
`;

function defaultTerminate(record) {
  if (!record || typeof record !== 'object') throw runtimeError('OVERNIGHT_ADVISORY_PROCESS_IDENTITY_INVALID', 'The exact owned overnight advisory worker identity is invalid.');
  const pid = validatePid(record.pid);
  if (!validStartTicks(record.startTicks)) throw runtimeError('OVERNIGHT_ADVISORY_PROCESS_IDENTITY_INVALID', 'The exact owned overnight advisory worker start time is invalid.');
  if (process.platform !== 'win32') {
    throw runtimeError(PLATFORM_UNSUPPORTED, PLATFORM_UNSUPPORTED_MESSAGE);
  }
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    '$source = @\'',
    WINDOWS_EXACT_TREE_STOP_SOURCE,
    '\'@',
    'Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop',
    `[ToolsEnabledOvernightExactTreeStop]::Stop(${pid}, [Int64]${record.startTicks})`
  ].join('\n');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000
    });
  } catch {
    throw runtimeError('OVERNIGHT_ADVISORY_PROCESS_TREE_STOP_FAILED', 'The exact owned overnight advisory process tree could not be stopped.');
  }
}

function validLockRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.version === 1 && value.kind === LOCK_KIND &&
    Number.isSafeInteger(value.pid) && value.pid > 0 && validStartTicks(value.startTicks) &&
    typeof value.lockId === 'string' && /^[0-9a-f-]{36}$/i.test(value.lockId) && Number.isSafeInteger(value.acquiredAtMs));
}

class OvernightAdvisoryWorkerRuntime {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.runtimeDir = path.resolve(options.runtimeDir || defaultRuntimeDirectory());
    this.recordFile = path.join(this.runtimeDir, 'worker.json');
    this.lifecycleLockFile = path.join(this.runtimeDir, 'lifecycle.lock');
    this.workerFile = path.resolve(options.workerFile || rootPath('sidecars', 'local-coder', 'bin', 'overnight-advisory-worker.js'));
    this.launch = options.launch || defaultLaunch;
    this.terminate = options.terminate || defaultTerminate;
    this.processAlive = options.processAlive || isAlive;
    this.processStartTicks = options.processStartTicks || windowsStartTicks;
    this.now = options.now || Date.now;
    this.lifecycleOwner = options.lifecycleOwner || (() => ({ pid: process.pid, startTicks: this.processStartTicks(process.pid) }));
  }

  _assertPlatform() {
    if (this.platform !== 'win32') throw runtimeError(PLATFORM_UNSUPPORTED, PLATFORM_UNSUPPORTED_MESSAGE);
  }

  // Fails on anything that is not a readable regular file, including a dangling
  // symlink and a directory of the right name, because each of those launches
  // exactly as badly as an absent file does.
  _assertWorkerPresent() {
    let entry;
    try { entry = fs.statSync(this.workerFile); }
    catch (error) {
      if (error && error.code === 'ENOENT') {
        throw runtimeError('OVERNIGHT_ADVISORY_WORKER_UNAVAILABLE',
          `The overnight advisory worker is not installed at ${this.workerFile}, so no advisory run was started. `
          + 'Install the worker, or point workerFile at an installed copy.');
      }
      throw runtimeError('OVERNIGHT_ADVISORY_WORKER_PRESENCE_UNAVAILABLE',
        `The overnight advisory worker path ${this.workerFile} could not be checked, so no advisory run was started. `
        + 'This does not mean the worker is absent or not installed.');
    }
    if (!entry.isFile()) {
      throw runtimeError('OVERNIGHT_ADVISORY_WORKER_UNAVAILABLE',
        `The overnight advisory worker path ${this.workerFile} is not a regular file, so no advisory run was started.`);
    }
  }

  _read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.recordFile, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
          !Number.isSafeInteger(value.pid) || typeof value.instanceId !== 'string' ||
          !validStartTicks(value.startTicks) || !Number.isSafeInteger(value.startedAtMs)) {
        throw runtimeError('OVERNIGHT_ADVISORY_WORKER_RECORD_INVALID', 'The overnight advisory worker record is malformed.');
      }
      return value;
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      if (error && error.code === 'OVERNIGHT_ADVISORY_WORKER_RECORD_INVALID') throw error;
      throw runtimeError('OVERNIGHT_ADVISORY_WORKER_RECORD_UNAVAILABLE', 'The overnight advisory worker record could not be read safely.');
    }
  }

  _remove() { try { fs.unlinkSync(this.recordFile); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; } }

  _matchesProcess(record) {
    return Boolean(record && this.processAlive(record.pid) && this.processStartTicks(record.pid) === record.startTicks);
  }

  _ownedRecord() {
    const record = this._read();
    return this._matchesProcess(record) ? record : null;
  }

  _readLifecycleLock() {
    try {
      const stat = fs.lstatSync(this.lifecycleLockFile);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const raw = fs.readFileSync(this.lifecycleLockFile, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > 1024) return null;
      const value = JSON.parse(raw);
      return validLockRecord(value) ? value : null;
    } catch { return null; }
  }

  _currentLifecycleOwner() {
    let owner;
    try { owner = this.lifecycleOwner(); } catch { owner = null; }
    if (!owner || typeof owner !== 'object') throw runtimeError('OVERNIGHT_ADVISORY_LIFECYCLE_LOCK_UNAVAILABLE', 'The lifecycle owner identity could not be established.');
    const pid = validatePid(owner.pid);
    if (!validStartTicks(owner.startTicks)) throw runtimeError('OVERNIGHT_ADVISORY_LIFECYCLE_LOCK_UNAVAILABLE', 'The lifecycle owner start time could not be established.');
    return { pid, startTicks: owner.startTicks };
  }

  _createLifecycleLock() {
    const owner = this._currentLifecycleOwner();
    const lock = { version: 1, kind: LOCK_KIND, pid: owner.pid, startTicks: owner.startTicks, lockId: crypto.randomUUID(), acquiredAtMs: this.now() };
    const temporary = path.join(this.runtimeDir, `.lifecycle.${owner.pid}.${lock.lockId}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(lock)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      // Hard-link publication provides an all-or-nothing lock record: peers
      // never observe the empty file window created by open(..., 'wx').
      fs.linkSync(temporary, this.lifecycleLockFile);
      return lock;
    } finally {
      if (descriptor !== undefined && descriptor !== null) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    }
  }

  _acquireLifecycleLock() {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    try { return this._createLifecycleLock(); }
    catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw runtimeError('OVERNIGHT_ADVISORY_LIFECYCLE_LOCK_UNAVAILABLE', 'The lifecycle mutation lock could not be created safely.');
      }
      const held = this._readLifecycleLock();
      if (!held) {
        throw runtimeError('OVERNIGHT_ADVISORY_LIFECYCLE_LOCK_INVALID', 'The lifecycle mutation lock is malformed or cannot be verified.');
      }
      if (this._matchesProcess(held)) {
        throw runtimeError('OVERNIGHT_ADVISORY_LIFECYCLE_BUSY', 'Another exact overnight advisory lifecycle operation is still in progress.');
      }
      // Reclaiming a stale pathname has an unavoidable rename/unlink race with
      // a new process that may have acquired it.  Keep that stale lock as an
      // explicit fail-closed operator-recovery condition instead of risking a
      // start/stop race or deleting a fresh lock from another process.
      throw runtimeError('OVERNIGHT_ADVISORY_LIFECYCLE_LOCK_STALE', 'A previous lifecycle mutation ended without releasing its verified lock; manual local recovery is required.');
    }
  }

  _releaseLifecycleLock(lock) {
    const current = this._readLifecycleLock();
    if (!current || current.lockId !== lock.lockId || current.pid !== lock.pid || current.startTicks !== lock.startTicks) {
      throw runtimeError('OVERNIGHT_ADVISORY_LIFECYCLE_LOCK_LOST', 'The lifecycle mutation lock changed before it could be released.');
    }
    fs.unlinkSync(this.lifecycleLockFile);
  }

  _withLifecycleLock(work) {
    const lock = this._acquireLifecycleLock();
    let result;
    let failure;
    try { result = work(); } catch (error) { failure = error; }
    try { this._releaseLifecycleLock(lock); }
    catch (releaseError) { if (!failure) failure = releaseError; }
    if (failure) throw failure;
    return result;
  }

  status() {
    this._assertPlatform();
    const record = this._read();
    const owned = this._ownedRecord();
    if (owned) return { status: 'running', running: true, pid: owned.pid, startedAtMs: owned.startedAtMs };
    return record ? { status: 'stale', running: false, detail: 'The recorded overnight advisory worker no longer matches its owned process.' } : { status: 'stopped', running: false };
  }

  start({ actor, idempotencyKey }) {
    this._assertPlatform();
    return this._withLifecycleLock(() => this._start({ actor, idempotencyKey }));
  }

  _start({ actor, idempotencyKey }) {
    const existing = this._ownedRecord();
    if (existing) return { accepted: true, status: 'already_running', running: true, pid: existing.pid };
    // A MISSING WORKER IS A NAMED REFUSAL, NOT A START.
    //
    // The launch below is `node <workerFile>` detached with stdio ignored. If
    // the file is not there, Node still starts, still gets a pid, and still
    // exits immediately -- so the record gets written, "started" is returned,
    // and the caller believes an advisory run is under way that never existed.
    // Nobody finds out until the results fail to arrive.
    //
    // An installation may legitimately not carry the worker, so its absence is a
    // supported state that has to be SAID rather than silently produce a corpse.
    this._assertWorkerPresent();
    if (this._read()) this._remove();
    let descriptor;
    let child;
    let launchedRecord;
    let ownsRecord = false;
    let startFailure;
    try {
      try { descriptor = fs.openSync(this.recordFile, 'wx', 0o600); ownsRecord = true; }
      catch (error) {
        if (error && error.code === 'EEXIST') {
          const raced = this._ownedRecord();
          if (raced) return { accepted: true, status: 'already_running', running: true, pid: raced.pid };
        }
        throw error;
      }
      const instanceId = crypto.randomUUID();
      child = this.launch(this.workerFile, {
        ...process.env,
        OVERNIGHT_ADVISORY_WORKER_LABEL: `local-advisory.${process.pid}.${instanceId.slice(0, 8)}`,
        OVERNIGHT_ADVISORY_WORKER_INSTANCE: instanceId
      });
      const pid = validatePid(child && child.pid);
      const startTicks = this.processStartTicks(pid);
      if (!validStartTicks(startTicks)) throw new Error('The overnight advisory worker process could not be verified.');
      launchedRecord = { version: 1, pid, instanceId, startTicks, startedAtMs: this.now() };
      const record = { ...launchedRecord, actor,
        idempotencyKeyHash: crypto.createHash('sha256').update(idempotencyKey).digest('hex') };
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      if (child && typeof child.once === 'function') child.once('error', () => {
        const current = this._read();
        if (current && current.instanceId === instanceId) { try { this._remove(); } catch {} }
      });
      return { accepted: true, status: 'started', running: true, pid };
    } catch (error) {
      startFailure = error;
      // The terminate adapter receives the creation-time fence, never just a
      // PID, even on the rare start-cleanup path.
      if (launchedRecord) {
        try { this.terminate(launchedRecord); }
        catch (terminationError) {
          startFailure = cleanupFailure('OVERNIGHT_ADVISORY_START_TERMINATION_FAILED',
            'The overnight advisory worker start failed and the launched process could not be safely terminated.',
            startFailure, terminationError);
        }
      }
      throw startFailure;
    } finally {
      if (descriptor !== undefined && descriptor !== null) fs.closeSync(descriptor);
      if (ownsRecord && !this._ownedRecord()) {
        try { this._remove(); }
        catch (removalError) {
          throw cleanupFailure('OVERNIGHT_ADVISORY_START_RECORD_CLEANUP_FAILED',
            'The overnight advisory worker start did not complete and its ownership record could not be removed.',
            startFailure, removalError);
        }
      }
    }
  }

  stop() {
    this._assertPlatform();
    return this._withLifecycleLock(() => this._stop());
  }

  _stop() {
    const record = this._ownedRecord();
    if (!record) {
      if (this._read()) this._remove();
      return { accepted: true, status: 'already_stopped', running: false };
    }
    // defaultTerminate verifies the same creation-tick fence while holding the
    // kernel process handle.  Do not reduce this to taskkill /pid.
    this.terminate(record);
    this._remove();
    return { accepted: true, status: 'stopped', running: false };
  }
}

module.exports = {
  OvernightAdvisoryWorkerRuntime,
  PLATFORM_UNSUPPORTED,
  PLATFORM_UNSUPPORTED_MESSAGE,
  defaultRuntimeDirectory,
  windowsStartTicks,
  isAlive
};
