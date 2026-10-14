'use strict';

// WHICH TREE AM I IN. One implementation, for every caller that needs it.
//
// WHY THIS IS ITS OWN MODULE (2026-08-10). A status report was produced against
// the retired, non-canonical checkout (353 test files, last commit 2026-08-08)
// while the canonical tree had 748 and was being committed to that same day.
// Every conclusion in it was stale on arrival. The author did nothing wrong:
// that checkout told them three different things at once, and nothing
// mechanical ever said "you are standing in the retired tree".
//
// The first fix (d36f815) put this check in tools/agent-preflight.js -- which
// only ever runs when a session REMEMBERS to run it. The owner's rule is the
// opposite: "agents shouldnt have to manage things like this inside
// toolsenabled, it should be mechanical, remembering causes issues and should
// only be implemented where its the only realistic solution." So the automatic
// SessionStart onboarding packet (src/lib/agent-onboarding.js) now carries this
// too, and two consumers means the logic cannot live inside either one of them.
// A second, independently-drifting copy of "which tree is this" would recreate
// the original defect one level down. Same reason src/lib/open-gates-freshness.js
// was extracted from the same tool on the same day.
//
// BUDGET. A SessionStart hook has roughly five seconds for everything it does.
// This module reads exactly one small JSON file, synchronously, with no network,
// no spawn, no git, and no require of anything with load-time side effects.
// It cannot block and it cannot hang.
//
// IT FAILS LOUD, NOT OPEN. A missing or unreadable registry is exactly when a
// session is most likely to be somewhere unexpected, so silence there would be
// the worst possible answer. The honest output is "I cannot tell you which tree
// you are in", stated as a warning, not an omission.

const fs = require('node:fs');
const path = require('node:path');

// The repository containing this file. Resolved from __dirname, never from
// process.cwd() and never from a hardcoded machine path -- a hook may be
// invoked from anywhere, and a hardcoded root is the defect class this exists
// to catch.
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

// The registered authority for what a declared checkout root is. Not a doc,
// not prose, not a memory: config/service-registry.json /machines.
const REGISTRY_RELATIVE = path.join('config', 'service-registry.json');

const STATES = Object.freeze(['CANONICAL', 'NOT-A-DECLARED-ROOT', 'UNKNOWN']);

// What to do when the answer is not CANONICAL. Exported rather than written
// twice: every consumer says the same thing, or the advice drifts the way the
// detection logic would have.
const NON_CANONICAL_GUIDANCE = 'Measure and report in a declared root, and name the tree in anything you write.';

function normalizeRoot(value) {
  return path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
}

const normalize = normalizeRoot;

/**
 * Resolve whether a checkout is a declared machine root.
 *
 * @param {object} [options]
 * @param {string} [options.root] the checkout to identify; defaults to the
 *   repository this module lives in.
 * @param {string} [options.registryRoot] the checkout to read the machine
 *   registry FROM; defaults to `root`. Pass it explicitly only to judge some
 *   other directory against a registry you have already located.
 * @param {object} [options.fsImpl] injectable fs for tests.
 * @returns {{state: 'CANONICAL'|'NOT-A-DECLARED-ROOT'|'UNKNOWN', repo: string,
 *   machineId?: string, declared: Array<{id: string, root: string}>, message: string}}
 */
function treeIdentity(options = {}) {
  const root = options.root ? path.resolve(String(options.root)) : DEFAULT_ROOT;
  const registryRoot = options.registryRoot ? path.resolve(String(options.registryRoot)) : root;
  const fsImpl = options.fsImpl || fs;
  const registryPath = path.join(registryRoot, REGISTRY_RELATIVE);
  let machines;
  try {
    machines = JSON.parse(fsImpl.readFileSync(registryPath, 'utf8')).machines;
  } catch (error) {
    // Fail LOUD, not open. A missing authority is exactly when a session is most
    // likely to be somewhere unexpected, so silence here would be the worst answer.
    return { state: 'UNKNOWN', repo: root, declared: [], message:
      `cannot read ${path.relative(registryRoot, registryPath)} (${error.code || error.message}), so this tool cannot tell you which tree you are in -- verify by hand before trusting anything below` };
  }
  if (!machines || typeof machines !== 'object' || Array.isArray(machines)) {
    return { state: 'UNKNOWN', repo: root, declared: [], message:
      `cannot read machine declarations from ${path.relative(registryRoot, registryPath)}, so canonical-tree membership cannot be established` };
  }
  const declared = Object.entries(machines)
    .filter(([, machine]) => machine && machine.root)
    .map(([id, machine]) => ({ id, root: machine.root }));
  if (declared.length === 0) {
    return {
      state: 'UNKNOWN', repo: root, declared,
      message: 'no machine declares a checkout root, so canonical-tree membership cannot be established'
    };
  }
  const here = normalize(root);
  const match = declared.find(entry => normalize(entry.root) === here);
  if (match) {
    return { state: 'CANONICAL', repo: root, machineId: match.id, declared,
      message: `this checkout is the declared root for ${match.id}` };
  }
  return {
    state: 'NOT-A-DECLARED-ROOT', repo: root, declared,
    message: `this checkout is not the declared root of any machine; work originated here may be invisible to everyone else. Declared roots: ${declared.map(entry => `${entry.id}=${entry.root}`).join('  |  ')}`
  };
}

/**
 * One line a human or an agent can read at a glance, prefixed so a bad answer
 * cannot be mistaken for a good one.
 * @param {ReturnType<typeof treeIdentity>} identity
 * @returns {string}
 */
function treeIdentityHeadline(identity) {
  if (!identity || typeof identity !== 'object') {
    return '⚠ TREE UNKNOWN: tree identity was not resolved for this packet -- verify by hand which checkout you are in.';
  }
  if (identity.state === 'CANONICAL') return `TREE ✓ ${identity.repo} — ${identity.message}`;
  return `⚠ TREE ${identity.state}: ${identity.repo} — ${identity.message}`;
}

module.exports = {
  DEFAULT_ROOT, NON_CANONICAL_GUIDANCE, REGISTRY_RELATIVE, STATES,
  normalizeRoot, treeIdentity, treeIdentityHeadline
};
