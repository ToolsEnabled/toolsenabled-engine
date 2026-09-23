'use strict';

// THE WORKSPACE -- the folder the assistant is allowed to work in.
//
// Task T10 of docs/design/INSTALLER-EXPERIENCE.md section 7, and step 7 of the
// flow in section 3. Guided is shown one card containing `Documents\AI Workspace`
// with a single button; Standard and Unrestricted may add several roots.
//
// TWO REFUSALS, BOTH MECHANICAL.
//
// The first is the one the design names: a workspace that resolves inside the
// ToolsEnabled tree is refused, so the product cannot be pointed at its own
// source. That is not squeamishness. An assistant asked to "clean up this folder"
// inside the installation would be editing the code that is running it, and the
// Undo below -- which is a git checkout -- would then be undoing the program
// mid-turn. Section 2.2 states the refusal for Guided; it is applied to Standard
// too, and left available to Unrestricted only because that tier's whole contract
// is that it decides nothing on the user's behalf.
//
// The second is not in the design and is added here because the first is not
// sufficient on its own: a workspace at the root of a drive, at the user profile
// root, or on a UNC share is refused as well. `git init` at the user profile
// root itself would place a repository over a person's entire profile and the
// first checkpoint would try to add every file they own.
//
// (That example named a literal Windows profile path until this module began
// shipping inside the installer's capability payload, where the owner-data
// guard reads any such path as builder-identifying and refuses the build. The
// example lost nothing: the sentence says which directory it means.)
//
// UNDO IS GIT, AND THE WORD GIT IS NEVER SHOWN. Section 2.2: "A git repository
// silently initialized in the workspace so that 'Undo the last thing it did' is a
// real operation; the word git never appears." The strings in this module obey
// that: they say "the folder was put back the way it was", not "reset --hard".
// GIT IS ALSO OPTIONAL. A machine without git still gets a working workspace; it
// gets `undoAvailable: false` and an honest reason, rather than a broken setup.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { SetupRefusal } = require('./machine-record');

const DEFAULT_WORKSPACE_LEAF = 'AI Workspace';

/* WHERE "Documents" ACTUALLY IS, WHEN THE CALLER CAN SAY.
 *
 * `%USERPROFILE%\Documents` is a GUESS about the Documents folder, and on the
 * machines where it matters the guess is wrong: OneDrive's "Back up your
 * folders" (the consumer Windows 11 default) moves the real known folder to
 * `%USERPROFILE%\OneDrive\Documents`, and a person can relocate Documents to
 * another drive entirely. On such a machine the guessed path is a NEW folder
 * that Explorer's own "Documents" never shows -- the person is told their
 * assistant works in Documents and cannot find it there.
 *
 * This module runs under plain Node and cannot ask the known-folder API
 * itself, so the caller that CAN -- the application shell, which already asks
 * Electron for `app.getPath('documents')` when it opens the folder picker --
 * passes the answer in as `documentsDir`. Absent that, the historical guess
 * stands, so every plain-Node caller (mcsetup.js, tests) behaves exactly as
 * before. A relative or empty override is ignored rather than joined, because
 * resolving a guessed-relative Documents against an arbitrary cwd is a worse
 * wrong answer than the guess this exists to replace. */
function defaultWorkspacePath({ env = process.env, homedir = os.homedir, documentsDir = null } = {}) {
  if (typeof documentsDir === 'string' && documentsDir.trim() !== '' && path.isAbsolute(documentsDir)) {
    return path.join(documentsDir, DEFAULT_WORKSPACE_LEAF);
  }
  const home = typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '' ? env.USERPROFILE : homedir();
  return path.join(home, 'Documents', DEFAULT_WORKSPACE_LEAF);
}

function isInside(candidate, container) {
  const relative = path.relative(path.resolve(container), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Would this folder be a safe place to let an assistant work?
 *
 * Returns a typed refusal rather than a boolean, because every refusal here has
 * to be explainable to the person who chose the folder. "That folder cannot be
 * used" with no reason is the shape that makes someone pick a worse one.
 */
function checkWorkspaceCandidate(candidate, { installRoot, tier = 'guided', env = process.env, homedir = os.homedir } = {}) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: false, code: 'SETUP_WORKSPACE_MISSING', message: 'Choose a folder for your assistant to work in.' };
  }
  const resolved = path.resolve(candidate);

  if (resolved.startsWith('\\\\')) {
    return {
      ok: false,
      code: 'SETUP_WORKSPACE_NETWORK_REFUSED',
      message: 'That folder is on another computer over the network. Choose a folder on this computer.',
      resolved
    };
  }
  if (path.parse(resolved).root === resolved) {
    return {
      ok: false,
      code: 'SETUP_WORKSPACE_DRIVE_ROOT_REFUSED',
      message: 'That is the top of a whole drive. Choose a folder inside it instead.',
      resolved
    };
  }
  const home = typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '' ? env.USERPROFILE : homedir();
  if (path.resolve(home) === resolved) {
    return {
      ok: false,
      code: 'SETUP_WORKSPACE_PROFILE_ROOT_REFUSED',
      message: 'That is your whole user folder. Choose one folder inside it, such as Documents.',
      resolved
    };
  }
  if (typeof installRoot === 'string' && isInside(resolved, installRoot) && tier !== 'unrestricted') {
    return {
      ok: false,
      code: 'SETUP_WORKSPACE_INSIDE_INSTALL_REFUSED',
      message: 'That folder is part of this program itself. Choose a folder of your own, such as Documents.',
      resolved
    };
  }
  return { ok: true, resolved };
}

function assertWorkspaceAllowed(candidate, options = {}) {
  const verdict = checkWorkspaceCandidate(candidate, options);
  if (!verdict.ok) throw new SetupRefusal(verdict.code, verdict.message, { workspace: verdict.resolved || candidate });
  return verdict.resolved;
}

// --- the history that makes Undo real ---------------------------------------

function runGit(args, cwd, { runner = spawnSync } = {}) {
  const result = runner('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) return { ok: false, status: null, reason: result.error.code || result.error.message };
  return { ok: result.status === 0, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function gitAvailable({ runner = spawnSync } = {}) {
  const result = runner('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (result.error) return result.error.code === 'ENOENT' ? false : null;
  return result.status === 0;
}

function isAlreadyRepository(directory, { runner = spawnSync } = {}) {
  const result = runGit(['rev-parse', '--is-inside-work-tree'], directory, { runner });
  if (result.status === null) return null;
  return result.ok && String(result.stdout).trim() === 'true';
}

/**
 * Create the folder and give it a history, without saying so.
 *
 * `git init` happens if and only if the folder is not already inside a
 * repository -- initialising inside someone's existing project would create a
 * nested repository they did not ask for and would confuse their own tooling.
 */
function provisionWorkspace(candidate, options = {}) {
  const { runner = spawnSync, makeDirectory = fs.mkdirSync, exists = fs.existsSync } = options;
  const resolved = assertWorkspaceAllowed(candidate, options);

  const existedBefore = exists(resolved);
  makeDirectory(resolved, { recursive: true });

  const availability = gitAvailable({ runner });
  if (availability !== true) {
    return Object.freeze({
      workspace: resolved,
      created: !existedBefore,
      undoAvailable: false,
      undoUnavailableReason: availability === false
        ? 'this computer has no version history tool installed, so changes here cannot be undone automatically'
        : 'the version history tool could not be checked, so changes here cannot be undone automatically'
    });
  }
  const repository = isAlreadyRepository(resolved, { runner });
  if (repository === null) {
    return Object.freeze({
      workspace: resolved,
      created: !existedBefore,
      undoAvailable: false,
      undoUnavailableReason: 'the history of this folder could not be checked, so changes here cannot be undone automatically'
    });
  }
  if (repository) {
    return Object.freeze({ workspace: resolved, created: !existedBefore, undoAvailable: true, alreadyTracked: true });
  }
  const initialised = runGit(['init', '--quiet'], resolved, { runner });
  if (!initialised.ok) {
    return Object.freeze({
      workspace: resolved,
      created: !existedBefore,
      undoAvailable: false,
      undoUnavailableReason: 'a history could not be started in this folder, so changes here cannot be undone automatically'
    });
  }
  return Object.freeze({ workspace: resolved, created: !existedBefore, undoAvailable: true, alreadyTracked: false });
}

/**
 * Record the state of the folder before a turn, so the turn can be undone.
 * Committing NOTHING when nothing changed is a success, not a failure: an empty
 * checkpoint is the correct outcome of "the assistant changed nothing".
 */
function checkpointWorkspace(workspace, { runner = spawnSync, label = 'before the assistant ran' } = {}) {
  const availability = gitAvailable({ runner });
  const repository = availability === true ? isAlreadyRepository(workspace, { runner }) : false;
  if (availability !== true || repository !== true) {
    return {
      ok: false,
      reason: availability === null || repository === null
        ? 'the history of this folder could not be checked'
        : 'this folder has no history, so there is nothing to put back'
    };
  }
  const added = runGit(['add', '--all'], workspace, { runner });
  if (!added.ok) return { ok: false, reason: 'the current state of this folder could not be recorded' };
  const committed = runGit(
    ['-c', 'user.name=ToolsEnabled', '-c', 'user.email=setup@localhost', 'commit', '--quiet', '--allow-empty', '-m', label],
    workspace,
    { runner }
  );
  if (!committed.ok) return { ok: false, reason: 'the current state of this folder could not be recorded' };
  const head = runGit(['rev-parse', 'HEAD'], workspace, { runner });
  if (!head.ok || String(head.stdout).trim() === '') {
    return { ok: false, reason: 'the recorded state of this folder could not be identified' };
  }
  return { ok: true, checkpoint: String(head.stdout).trim() };
}

/**
 * Put the folder back the way it was at the checkpoint. Deliberately restores
 * BOTH tracked changes and files the turn created: a user who presses Undo after
 * "it created three files" and still finds three files has been lied to.
 */
function undoToCheckpoint(workspace, checkpoint, { runner = spawnSync } = {}) {
  if (typeof checkpoint !== 'string' || checkpoint.trim() === '') {
    return { ok: false, reason: 'there is no earlier state of this folder to go back to' };
  }
  const availability = gitAvailable({ runner });
  const repository = availability === true ? isAlreadyRepository(workspace, { runner }) : false;
  if (availability !== true || repository !== true) {
    return {
      ok: false,
      reason: availability === null || repository === null
        ? 'the history of this folder could not be checked'
        : 'this folder has no history, so there is nothing to put back'
    };
  }
  const restored = runGit(['reset', '--hard', '--quiet', checkpoint], workspace, { runner });
  if (!restored.ok) return { ok: false, reason: 'this folder could not be put back the way it was' };
  const cleaned = runGit(['clean', '-fdq'], workspace, { runner });
  if (!cleaned.ok) return { ok: false, reason: 'this folder could not be put back the way it was' };
  return { ok: true };
}

module.exports = Object.freeze({
  DEFAULT_WORKSPACE_LEAF,
  defaultWorkspacePath,
  checkWorkspaceCandidate,
  assertWorkspaceAllowed,
  provisionWorkspace,
  checkpointWorkspace,
  undoToCheckpoint,
  gitAvailable,
  isAlreadyRepository,
  isInside
});
