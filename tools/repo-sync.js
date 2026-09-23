#!/usr/bin/env node
'use strict';

// Protected-main receiver (owner directives R1120/R1122/R1162).
//
// This unattended tool has exactly one mutation path: a clean dedicated
// checkout of `main` may fast-forward to the already-fetched `origin/main`.
// It never publishes work, creates a merge commit, rebases, resets, or pushes.
// Ahead/diverged/dirty/unknown states are durable handoffs for an authorized
// branch-and-PR workflow, not invitations for this process to decide a merge.

const fs = require('node:fs');
const path = require('node:path');
const { checkSingleCopyWork } = require('./check-single-copy-work');
const { createFilekeeperProtectedMainReceiverTransport } = require('../packages/internal-vcs/src');

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'state', 'repo-sync.json');
const STOP_FILE = path.join(ROOT, 'state', 'repo-sync.stop');
const BRANCH = 'main';
const REMOTE = 'origin';
const STATE_SCHEMA_VERSION = 1;
const DETAIL_LIMIT = 1024;
const MAX_DIRTY_PATHS = 50;
const MAX_CHECKED_REMOTES = 20;

function bounded(text, limit = DETAIL_LIMIT) {
  const value = String(text == null ? '' : text);
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function failureDetail(error) {
  const stderr = error && error.stderr ? String(error.stderr) : '';
  const message = error && error.message ? error.message : String(error);
  return bounded(`${message}${stderr ? ` | stderr: ${stderr}` : ''}`);
}

function transportDetail(result) {
  if (!result || typeof result !== 'object') return 'Filekeeper transport returned no structured result';
  const parts = [result.detail, result.errorCode, result.exitCode == null ? null : `exit ${result.exitCode}`]
    .filter(value => value !== null && value !== undefined && value !== '');
  return bounded(parts.join(' | ') || `Filekeeper transport returned ${String(result.state || 'UNKNOWN')}`);
}

function receiverObservationFrom(result) {
  if (!result || result.state !== 'SAFE') return null;
  if (!Array.isArray(result.dirtyPaths) || result.dirtyPaths.some(value => typeof value !== 'string')) return null;
  if (!Number.isSafeInteger(result.ahead) || result.ahead < 0) return null;
  if (!Number.isSafeInteger(result.behind) || result.behind < 0) return null;
  return {
    dirtyPaths: result.dirtyPaths.map(value => bounded(value, 512)),
    ahead: result.ahead,
    behind: result.behind,
  };
}

function invalidReceiverObservationDetail() {
  return 'Filekeeper transport returned an invalid SAFE receiver observation';
}

function createDefaultTransport(root) {
  return createFilekeeperProtectedMainReceiverTransport({
    repositoryLocator: root,
    remoteName: REMOTE,
    branchName: BRANCH,
  });
}

function containmentFrom(result) {
  if (!result || typeof result !== 'object') {
    return {
      status: 'unknown', networkVerified: false, checkedRemotes: [],
      code: 'SINGLE_COPY_RESULT_INVALID', summary: 'single-copy detector returned no structured result'
    };
  }

  const networkVerified = result.scope && result.scope.network === true;
  const checkedRemotes = Array.isArray(result.scope && result.scope.remotesFetched)
    ? result.scope.remotesFetched.slice(0, MAX_CHECKED_REMOTES).map(value => bounded(value, 128))
    : [];
  const summary = bounded(result.summary || result.reason || 'single-copy detector supplied no summary');

  if (result.status === 'clean' && networkVerified && checkedRemotes.includes(REMOTE)) {
    return { status: 'verified', networkVerified: true, checkedRemotes, code: null, summary };
  }
  if (result.status === 'stranded') {
    return {
      status: 'stranded', networkVerified, checkedRemotes,
      code: result.code || 'SINGLE_COPY_WORK_PRESENT', summary
    };
  }
  return {
    status: 'unknown', networkVerified, checkedRemotes,
    code: result.code || (result.status === 'clean'
      ? (networkVerified ? 'CONTAINMENT_REMOTE_MISSING' : 'CONTAINMENT_NOT_NETWORK_VERIFIED')
      : 'SINGLE_COPY_INDETERMINATE'),
    summary
  };
}

function runOnce(deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const stateFile = deps.stateFile || STATE_FILE;
  const stopFile = deps.stopFile || STOP_FILE;
  const root = path.resolve(deps.root || ROOT);
  const now = deps.now || (() => new Date().toISOString());
  const singleCopyCheck = deps.singleCopyCheck || checkSingleCopyWork;
  const transport = deps.transport || (deps.transportFactory || createDefaultTransport)(root);

  let branch = null;
  let ahead = null;
  let behind = null;
  let action = 'error';
  let ok = false;
  let detail = '';
  let dirtyPaths = [];
  let containment = {
    status: 'unknown', networkVerified: false, checkedRemotes: [],
    code: 'NOT_CHECKED', summary: 'advertised-ref containment has not been checked'
  };

  const result = () => ({
    schemaVersion: STATE_SCHEMA_VERSION,
    action,
    ok,
    detail,
    branch,
    ahead,
    behind,
    dirtyPathCount: dirtyPaths.length,
    dirtyPaths: dirtyPaths.slice(0, MAX_DIRTY_PATHS),
    dirtyPathsTruncated: dirtyPaths.length > MAX_DIRTY_PATHS,
    containment,
    countsAreContainmentProof: false
  });

  try {
    if (fsImpl.existsSync(stopFile)) {
      action = 'stopped';
      detail = `stop file ${path.basename(stopFile)} is present; protected-main consumption is disabled`;
      return result();
    }

    const branchObservation = transport.observeBranch();
    if (!branchObservation || branchObservation.state !== 'SAFE') {
      action = 'inspection-failed';
      detail = transportDetail(branchObservation);
      return result();
    }
    branch = branchObservation.branch;
    if (branch !== BRANCH) {
      action = 'wrong-branch';
      detail = `on branch "${bounded(branch, 256)}"; the unattended receiver requires a dedicated ${BRANCH} checkout`;
      return result();
    }

    const fetch = transport.fetchPrune();
    if (!fetch || fetch.state !== 'SAFE') {
      action = 'fetch-failed';
      detail = transportDetail(fetch);
      return result();
    }

    const observation = transport.observeReceiver();
    if (!observation || observation.state !== 'SAFE') {
      action = 'inspection-failed';
      detail = transportDetail(observation);
      return result();
    }
    const receiverObservation = receiverObservationFrom(observation);
    if (!receiverObservation) {
      action = 'inspection-failed';
      detail = invalidReceiverObservationDetail();
      return result();
    }
    dirtyPaths = receiverObservation.dirtyPaths;
    ahead = receiverObservation.ahead;
    behind = receiverObservation.behind;

    try {
      containment = containmentFrom(singleCopyCheck({
        root,
        network: true,
        strictUncommitted: true
      }));
    } catch (error) {
      containment = {
        status: 'unknown', networkVerified: false, checkedRemotes: [],
        code: error && error.code ? bounded(error.code, 128) : 'SINGLE_COPY_CHECK_FAILED',
        summary: failureDetail(error)
      };
    }

    if (ahead > 0 && behind > 0) {
      action = 'diverged-main';
      detail = `local main diverged (ahead ${ahead}, behind ${behind}); resolve through an authorized branch/PR workflow`;
      return result();
    }
    if (ahead > 0) {
      action = 'ahead-main';
      detail = `local main is ahead by ${ahead}; the receiver will not push, rebase, merge, or reset it`;
      return result();
    }
    if (dirtyPaths.length > 0) {
      action = 'dirty-worktree';
      detail = `worktree has ${dirtyPaths.length} tracked or untracked path(s); fast-forward refused: ${bounded(dirtyPaths.join(', '))}`;
      return result();
    }
    if (containment.status === 'unknown') {
      action = 'containment-unknown';
      detail = `advertised-ref containment could not be verified: ${containment.summary}`;
      return result();
    }
    if (containment.status === 'stranded') {
      action = 'single-copy-stranded';
      detail = `single-copy work must be preserved before sync: ${containment.summary}`;
      return result();
    }

    if (behind > 0) {
      const previousBehind = behind;
      const fastForward = transport.fastForward();
      if (!fastForward || fastForward.state !== 'SAFE') {
        action = 'fast-forward-failed';
        detail = transportDetail(fastForward);
        return result();
      }
      const postFastForward = transport.observeReceiver();
      if (!postFastForward || postFastForward.state !== 'SAFE') {
        action = 'post-fast-forward-unknown';
        detail = transportDetail(postFastForward);
        return result();
      }
      const postFastForwardObservation = receiverObservationFrom(postFastForward);
      if (!postFastForwardObservation) {
        action = 'post-fast-forward-unknown';
        detail = invalidReceiverObservationDetail();
        return result();
      }
      ahead = postFastForwardObservation.ahead;
      behind = postFastForwardObservation.behind;
      if (ahead !== 0 || behind !== 0) {
        action = 'post-fast-forward-unknown';
        detail = `fast-forward command returned but origin/main counts are ahead ${ahead}, behind ${behind}; no success claimed`;
        return result();
      }
      action = 'fast-forward';
      ok = true;
      detail = `fast-forwarded ${previousBehind} commit(s) from ${REMOTE}/${BRANCH}; no publish action was attempted`;
      return result();
    }

    action = 'in-sync';
    ok = true;
    detail = 'origin/main counts are 0/0 and advertised-ref containment is verified; counts alone are not the proof';
    return result();
  } catch (error) {
    action = 'error';
    detail = failureDetail(error);
    return result();
  } finally {
    const state = { generatedAt: now(), ...result() };
    try {
      fsImpl.mkdirSync(path.dirname(stateFile), { recursive: true });
      fsImpl.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch (error) {
      action = 'state-write-failed';
      ok = false;
      detail = `could not persist repo-sync state: ${failureDetail(error)}`;
      return result();
    }
  }
}

module.exports = Object.freeze({
  BRANCH,
  REMOTE,
  ROOT,
  STATE_FILE,
  STATE_SCHEMA_VERSION,
  STOP_FILE,
  containmentFrom,
  createDefaultTransport,
  receiverObservationFrom,
  runOnce
});

if (require.main === module) {
  const result = runOnce();
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
