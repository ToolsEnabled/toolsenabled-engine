'use strict';

/* GIT IS STARTED BY ABSOLUTE PATH, AND NEVER FROM INSIDE THE FOLDER IT WORKS ON.
 *
 * On Windows a bare `git` handed to spawn is looked up the way cmd.exe looks
 * it up: in the child's working directory FIRST (git.com, then git.exe), and
 * only then on PATH. So `spawnSync('git', args, { cwd: folder })` ran whatever
 * git.exe sat at the top of `folder`. When that folder is one a person picked
 * (a downloaded or cloned project can carry a git.exe), "is this folder a
 * repository?" started that file with the person's full token, silently
 * (CWE-427, current-directory binary planting; 1.0.50 security review M4, and
 * the lane-onboarding twin U1).
 *
 * Two changes close it, and each is needed:
 *
 *   1. git is resolved here to an absolute path by walking ABSOLUTE PATH
 *      entries only. A relative entry ('.', 'bin', an empty segment) is
 *      resolved by the OS against the current directory, which is the same
 *      planting one step removed, so it is skipped. A command that is already
 *      an absolute path is not searched for at all.
 *   2. The folder reaches git as `-C <folder>`, never as the child's working
 *      directory, so nothing about the spawn depends on what the folder holds.
 *      `-C` is git's own "run as if started in <path>"; hooks, discovery and
 *      safe.directory behave as they did with the working directory.
 *
 * NOT FOUND IS ENOENT. When no absolute PATH entry holds git, the answer is the
 * same `{ error: { code: 'ENOENT' } }` spawnSync gives for a missing program,
 * so every caller's "git is not installed" handling is unchanged. Falling back
 * to a bare `git` would put the current-directory search back.
 *
 * A MISSING FOLDER IS STILL A FAILURE TO START. spawnSync with a `cwd` that does
 * not exist fails before git runs (ENOENT, or ENOTDIR for a file), while
 * `git -C <missing>` starts git and exits 128. Callers read those two
 * differently ("could not be checked" against "not a repository"), so the
 * folder is checked first and the old answer is kept.
 *
 * Windows extensions are libuv's, not PATHEXT: a bare name is tried as `.com`
 * and then `.exe` in each directory, and never as `.cmd`/`.bat`, which spawn
 * cannot run without a shell. That keeps "which git runs" the same program the
 * old bare spawn found on PATH.
 *
 * Every spawn here is `windowsHide: true, shell: false`, whatever a caller
 * passes. It lives beside its callers in src/lib rather than in src/lib/proc,
 * whose only child_process users are the declared seams that
 * tests/agent-engine/hidden-spawn-fence.test.js checks (short git probes are
 * not agent sessions, so they do not belong behind spawnHidden). */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WINDOWS_GIT_NAMES = Object.freeze(['git.com', 'git.exe']);
// libuv's own default when the environment has no PATH at all (glibc _PATH_DEFPATH).
const POSIX_DEFAULT_SEARCH_PATH = '/usr/bin:/bin';

function searchPathOf(env, platform) {
  const source = env && typeof env === 'object' ? env : {};
  if (typeof source.PATH === 'string') return source.PATH;
  if (platform !== 'win32') return source.PATH === undefined ? POSIX_DEFAULT_SEARCH_PATH : '';
  // A plain copy of a Windows environment keeps the key's own spelling (`Path`).
  const key = Object.keys(source).find(name => name.toUpperCase() === 'PATH');
  return key && typeof source[key] === 'string' ? source[key] : '';
}

// `C:\dir` or `\\server\share` only. `\dir` is relative to the current drive
// and `C:dir` to that drive's current directory; neither names one place.
function isFullyQualifiedWindowsDirectory(directory) {
  return /^[A-Za-z]:[\\/]/.test(directory) || /^[\\/]{2}[^\\/]/.test(directory);
}

function windowsSearchDirectories(declared) {
  return String(declared).split(';')
    .map(entry => entry.replace(/^["']/, '').replace(/["']$/, ''))
    .filter(entry => entry !== '' && isFullyQualifiedWindowsDirectory(entry));
}

function posixSearchDirectories(declared) {
  return String(declared).split(':').filter(entry => entry.startsWith('/'));
}

/**
 * The absolute path of the git a bare `git` would have started from PATH, or
 * null when no absolute PATH entry has one. Never consults the current
 * directory.
 */
function resolveGitExecutable({
  env = process.env,
  platform = process.platform,
  statSync = fs.statSync,
  accessSync = fs.accessSync
} = {}) {
  const declared = searchPathOf(env, platform);
  if (platform === 'win32') {
    for (const directory of windowsSearchDirectories(declared)) {
      for (const name of WINDOWS_GIT_NAMES) {
        const candidate = path.win32.join(directory, name);
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          // Absent or unreadable: the OS search skips it too.
        }
      }
    }
    return null;
  }
  for (const directory of posixSearchDirectories(declared)) {
    const candidate = path.posix.join(directory, 'git');
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Absent, unreadable or not executable: execvp moves on as well.
    }
  }
  return null;
}

function notStarted(code, args) {
  const error = new Error(`spawnSync git ${code}`);
  error.code = code;
  error.syscall = 'spawnSync git';
  error.path = 'git';
  error.spawnargs = [...args];
  return { error, status: null, signal: null, output: null, pid: 0, stdout: undefined, stderr: undefined };
}

function folderProblem(directory, statSync) {
  try {
    return statSync(directory).isDirectory() ? null : 'ENOTDIR';
  } catch (error) {
    return (error && error.code) || 'ENOENT';
  }
}

/**
 * spawnSync for git, with the safe shape enforced.
 *
 * `directory` is the folder git should act on (sent as `-C <directory>`), or
 * null for a call that is about git itself (`--version`). `options` are
 * spawnSync options and may not carry `cwd`: a working directory is exactly
 * what this function exists to keep out. `deps.spawn` is spawnSync-shaped and
 * receives the real argv, so a test sees what the OS would.
 */
function spawnGitSync(directory, args, options = {}, {
  spawn = childProcess.spawnSync,
  resolveGit = resolveGitExecutable,
  statSync = fs.statSync,
  platform = process.platform
} = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    throw new TypeError('git arguments must be an array of strings');
  }
  if (options && Object.hasOwn(options, 'cwd')) {
    throw new TypeError('spawnGitSync never sets a working directory; pass the folder as its first argument');
  }
  const spawnOptions = { ...(options || {}), shell: false, windowsHide: true };
  const command = resolveGit({ env: spawnOptions.env || process.env, platform });
  if (typeof command !== 'string' || command === '') return notStarted('ENOENT', args);
  if (directory === null || directory === undefined) return spawn(command, [...args], spawnOptions);
  const problem = folderProblem(String(directory), statSync);
  if (problem) return notStarted(problem, args);
  return spawn(command, ['-C', String(directory), ...args], spawnOptions);
}

/* THE SAME RULE FOR CALLERS THAT KEEP THEIR OWN SPAWN SHAPE (platform review
 * 1.0.50 E3).
 *
 * spawnGitSync above covers the onboarding and workspace probes. The fleet
 * lanes, the Gemini agentic runner, the roster scoreboard and the cloud lane
 * each start git through an injectable execFileSync-, spawnSync- or
 * spawn-shaped function with a project or lane worktree as the working
 * directory, and their tests inject fakes of exactly those shapes. So these are
 * drop-in replacements with the same signature, used as the DEFAULT of each
 * such parameter: a command of exactly `git` is started by the absolute path
 * resolveGitExecutable() finds, and any other command passes through
 * untouched. With an absolute program path, nothing in the working directory
 * (and no relative PATH entry) can stand in for git, so these callers keep
 * their working directory and their output parsing unchanged.
 *
 * The PATH searched is the one the child would have been searched with:
 * `options.env` when the caller gives one, otherwise this process's. When git
 * does not resolve, each shape fails the way it already fails for a missing
 * program (execFileSync and spawn throw ENOENT, spawnSync returns it), so every
 * caller's "git is unavailable" handling is unchanged. Never a fallback to a
 * bare `git`. */
function gitProgramFor(command, options, resolveGit, platform) {
  if (command !== 'git') return command;
  const env = options && options.env ? options.env : process.env;
  const resolved = resolveGit({ env, platform });
  return typeof resolved === 'string' && resolved !== '' ? resolved : null;
}

function withSafeShape(options) {
  return { ...(options || {}), shell: false, windowsHide: true };
}

/** execFileSync(command, args, options), with `git` started by absolute path. */
function execGitFileSync(command, args = [], options = {}, {
  exec = childProcess.execFileSync,
  resolveGit = resolveGitExecutable,
  platform = process.platform
} = {}) {
  const program = gitProgramFor(command, options, resolveGit, platform);
  if (program === null) throw notStarted('ENOENT', args).error;
  return exec(program, args, withSafeShape(options));
}

/** spawnSync(command, args, options), with `git` started by absolute path. */
function spawnGitProcessSync(command, args = [], options = {}, {
  spawn = childProcess.spawnSync,
  resolveGit = resolveGitExecutable,
  platform = process.platform
} = {}) {
  const program = gitProgramFor(command, options, resolveGit, platform);
  if (program === null) return notStarted('ENOENT', args);
  return spawn(program, args, withSafeShape(options));
}

/** spawn(command, args, options), with `git` started by absolute path. */
function spawnGitProcess(command, args = [], options = {}, {
  spawn = childProcess.spawn,
  resolveGit = resolveGitExecutable,
  platform = process.platform
} = {}) {
  const program = gitProgramFor(command, options, resolveGit, platform);
  if (program === null) throw notStarted('ENOENT', args).error;
  return spawn(program, args, withSafeShape(options));
}

module.exports = Object.freeze({
  execGitFileSync,
  resolveGitExecutable,
  spawnGitProcess,
  spawnGitProcessSync,
  spawnGitSync
});
