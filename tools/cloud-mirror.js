#!/usr/bin/env node
'use strict';

// THE OUTBOUND CLOUD-MIRROR CLI. A thin arg parser over
// src/lib/cloud-agent/cloud-mirror.js, the same split tools/cloud-lane.js keeps
// with src/lib/cloud-agent/cloud-lane.js: every decision lives in the library,
// dependency-injected and testable with fakes, and this file reads flags, reads
// the clock once, and prints one line of JSON.
//
//   node tools/cloud-mirror.js publish --project <key> [--revision <rev>] [--registry <path>] [--state-root <dir>]
//   node tools/cloud-mirror.js check   --project <key> | --repository <owner/name>  [--registry <path>] [--state-root <dir>]
//   node tools/cloud-mirror.js plan    --project <key> [--revision <rev>] [--registry <path>]
//   node tools/cloud-mirror.js list    [--registry <path>]
//   node tools/cloud-mirror.js disable --project <key> [--registry <path>] [--state-root <dir>]
//
// Registration is intentionally absent. It must go through the installed
// cloud-mirror-register mission action, where the selected Cloud environment
// and authenticated github.repo_get are checked against the exact typed
// destination before anything is persisted. A local CLI cannot honestly
// reproduce that account-bound proof, so it must not offer a bypass.
//
// EXIT CODES: 0 the operation succeeded (check: the mirror IS at local HEAD).
// 3 a named mirror refusal -- stale, unclassified, credential in payload,
// unharvested work. 1 anything else. 3 is separated from 1 for the same reason
// tools/cloud-lane.js separates a FAIL verdict from a crash: a caller that gates
// on this must be able to tell "the lane said no" from "the lane broke".
//
// `plan` IS THE ONE READ-ONLY VERB AND IT TALKS TO NOTHING. It classifies and
// scans the tree and prints what WOULD be sent and what would be held back,
// without contacting the mirror and without creating an object. It exists
// because the first question anyone asks of a publication boundary is "what
// does this actually send", and a person should be able to answer it without
// performing the publish.

const path = require('node:path');

const mirror = require('../src/lib/cloud-agent/cloud-mirror');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');
const { assertActive } = require('../src/lib/policy');

// Refusals that mean "the lane refused", as opposed to "the lane broke". Kept
// as an explicit list rather than a prefix test so that adding a new error code
// is a decision about how callers should treat it.
const REFUSAL_CODES = new Set([
  'CLOUD_MIRROR_STALE',
  'CLOUD_MIRROR_BRANCH_ABSENT',
  'CLOUD_MIRROR_PUBLICATION_UNKNOWN',
  'CLOUD_MIRROR_BOUNDARY_DRIFTED',
  'CLOUD_MIRROR_UNCLASSIFIED',
  'CLOUD_MIRROR_CREDENTIAL_IN_PAYLOAD',
  'CLOUD_MIRROR_NONREGULAR_REFUSED',
  'CLOUD_MIRROR_UNHARVESTED_WORK',
  'CLOUD_MIRROR_EMPTY_SELECTION',
  'CLOUD_MIRROR_NOT_REGISTERED',
  'CLOUD_MIRROR_REMOTE_UNREADABLE',
  'CLOUD_MIRROR_PUSH_UNCONFIRMED',
  // Registration refusals. Every one of these means a person supplied
  // something that cannot work and can still fix it, which is exactly the
  // 'the lane said no' case exit 3 exists to separate from a crash.
  'CLOUD_MIRROR_SOURCE_ROOT_ABSENT',
  'CLOUD_MIRROR_SOURCE_ROOT_NOT_A_CHECKOUT',
  'CLOUD_MIRROR_BOUNDARY_ABSENT',
  'CLOUD_MIRROR_REPOSITORY_MALFORMED',
  'CLOUD_MIRROR_BRANCH_MALFORMED',
  'CLOUD_MIRROR_PROJECT_KEY_MALFORMED',
  'CLOUD_MIRROR_REGISTRATION_INCOMPLETE',
  'CLOUD_MIRROR_REMOTE_UNREACHABLE',
  'CLOUD_MIRROR_REMOTE_NOT_WRITABLE',
  'CLOUD_MIRROR_ALREADY_REGISTERED',
  'CLOUD_MIRROR_ACTIVE_REPLACEMENT_REFUSED',
  'CLOUD_MIRROR_REPOSITORY_ALREADY_BOUND',
  'CLOUD_MIRROR_BRANCH_COLLISION',
  'CLOUD_MIRROR_BRANCH_NOT_A_WORKSPACE',
  'CLOUD_MIRROR_ENVIRONMENT_REPOSITORY_MISMATCH',
  'CLOUD_MIRROR_PRIVACY_UNVERIFIED',
  'CLOUD_MIRROR_REMOTE_NOT_GITHUB',
  'CLOUD_MIRROR_REPOSITORY_AMBIGUOUS',
  'CLOUD_MIRROR_REPOSITORY_MISMATCH',
  'CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE',
  'CLOUD_MIRROR_REPOSITORY_ARCHIVED',
  'CLOUD_MIRROR_REPOSITORY_DISABLED',
  'CLOUD_MIRROR_REPOSITORY_STATE_UNVERIFIED',
  'CLOUD_MIRROR_REMOTE_CREDENTIALS_REFUSED',
  'CLOUD_MIRROR_REVERIFY_REQUIRED',
  'CLOUD_MIRROR_CALLER_METADATA_REFUSED',
  'CLOUD_MIRROR_PUBLIC_OVERRIDE_REFUSED',
  'CLOUD_MIRROR_NETWORK_CHECK_REQUIRED',
  'CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
  'CLOUD_MIRROR_ACCOUNT_BOUNDARY_REFUSED',
  'CLOUD_MIRROR_BOUNDARY_PATH_REFUSED',
  'CLOUD_MIRROR_REGISTRY_BUSY',
  'CLOUD_MIRROR_ALREADY_DISABLED',
  'CLOUD_MIRROR_LOCAL_RESET_FAILED',
  'CLOUD_MIRROR_BINDING_CHANGED'
]);

const COMMANDS = Object.freeze({
  publish: Object.freeze({ required: ['project'], optional: ['revision', 'registry', 'state-root'], flags: [] }),
  check: Object.freeze({ required: [], optional: ['project', 'repository', 'registry', 'state-root'], flags: [] }),
  plan: Object.freeze({ required: ['project'], optional: ['revision', 'registry'], flags: [] }),
  list: Object.freeze({ required: [], optional: ['registry'], flags: [] }),
  disable: Object.freeze({ required: ['project'], optional: ['registry', 'state-root'], flags: [] })
});

function usageError(message) {
  return new CloudAgentError('CLOUD_MIRROR_USAGE', `${message} Subcommands: ${Object.keys(COMMANDS).join(', ')}.`);
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (!spec) throw usageError(`unknown or missing subcommand '${command || ''}'.`);
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (typeof flag !== 'string' || !flag.startsWith('--')) throw usageError(`expected a --flag, got '${flag}'.`);
    const name = flag.slice(2);
    if (spec.flags.includes(name)) {
      if (name in options) throw usageError(`duplicate flag --${name}.`);
      options[name] = true;
      continue;
    }
    if (!spec.required.includes(name) && !spec.optional.includes(name)) {
      throw usageError(`unknown flag --${name} for '${command}'.`);
    }
    if (name in options) throw usageError(`duplicate flag --${name}.`);
    const value = rest[index + 1];
    if (value === undefined) throw usageError(`flag --${name} requires a value.`);
    options[name] = value;
    index += 1;
  }
  for (const name of spec.required) {
    if (!(name in options)) throw usageError(`'${command}' requires --${name}.`);
  }
  if (command === 'check' && !('project' in options) && !('repository' in options)) {
    throw usageError("'check' requires --project <key> or --repository <owner/name>.");
  }
  return { command, options };
}

async function main(argv) {
  const { command, options } = parseCliArgs(argv);
  // Same reasoning as tools/cloud-lane.js: publishing a tree to a remote is an
  // outward effect, so an active KILLSWITCH must stop it. There is no provider
  // entry for this action in config/toolsenabled.policy.json and no third-party
  // API credential behind it, so only the kill-switch and autonomous-mode gate
  // apply.
  assertActive(`cloud_mirror.${command}`);

  const registryPath = options.registry ? path.resolve(options.registry) : undefined;
  const stateRoot = options['state-root'] ? path.resolve(options['state-root']) : undefined;

  if (command === 'plan') {
    const registry = mirror.loadRegistry(registryPath ? { registryPath } : {});
    const project = mirror.projectFor({ registry, projectKey: options.project });
    const boundary = mirror.loadBoundary(project.boundaryManifest);
    const revision = options.revision || 'HEAD';
    const commit = String(mirror.runGitSync(project.sourceRoot, ['rev-parse', '--verify', `${revision}^{commit}`])).trim();
    const entries = require('../src/lib/cloud-agent/cloud-lane')
      .parseLsTreeOutput(String(mirror.runGitSync(project.sourceRoot, ['ls-tree', '-r', '-l', '-z', commit])));
    const selection = mirror.selectMirrorEntries(entries, boundary);
    // The scan runs even in plan mode. A dry run that skips the content gate
    // answers a different question than the one it appears to answer.
    //
    // The one case it cannot run is when the selection itself is refused: an
    // unclassified path means the set to scan has not been decided, so scanning
    // whatever happened to be classified would report on a subset. That is
    // stated as `credentialScanSkipped` rather than left to be inferred from a
    // zero -- "we did not look" and "we looked and found nothing" print
    // identically otherwise, which is the whole family of defect this lane is
    // built against.
    // Publishing refuses an empty selection in assertSelectable. Plan must
    // carry the same refusal: otherwise a boundary that withholds every path
    // scans zero blobs and exits 0, turning "there was nothing to inspect"
    // into a confident clean answer.
    const emptySelection = selection.included.length === 0;
    const scannable = selection.unclassified.length === 0 && selection.nonRegular.length === 0 && !emptySelection;
    const scan = scannable
      ? mirror.scanBlobsForCredentials({ repoRoot: project.sourceRoot, included: selection.included, boundary })
      : { violations: [], scanned: 0, binarySkipped: 0, acknowledgedHits: [] };
    return {
      exitCode: selection.unclassified.length > 0 || selection.nonRegular.length > 0 || emptySelection || scan.violations.length > 0 ? 3 : 0,
      out: {
        ok: selection.unclassified.length === 0 && selection.nonRegular.length === 0 && !emptySelection && scan.violations.length === 0,
        command,
        project: project.key,
        sourceRoot: project.sourceRoot,
        sourceCommit: commit,
        boundaryManifest: project.boundaryManifest,
        wouldMirror: selection.included.length,
        wouldWithhold: selection.withheld.length,
        withheldRules: [...new Set(selection.withheld.map((item) => item.rule))].sort(),
        unclassified: selection.unclassified,
        nonRegular: selection.nonRegular,
        credentialScanSkipped: scannable
          ? null
          : emptySelection && selection.unclassified.length === 0 && selection.nonRegular.length === 0
            ? 'the selection is refused because it contains no mirrored entries; a zero-item scan cannot establish that content is clean'
            : 'the selection is refused, so the set to scan has not been decided; a scan here would report on a subset',
        credentialViolations: scan.violations,
        credentialAcknowledgedByRule: scan.acknowledgedHits.reduce((counts, hit) => {
          counts[hit.rule] = (counts[hit.rule] || 0) + 1;
          return counts;
        }, {}),
        scanned: scan.scanned,
        binarySkipped: scan.binarySkipped
      }
    };
  }

  if (command === 'publish') {
    const result = await mirror.publishMirror({
      projectKey: options.project,
      registryPath,
      ...(stateRoot ? { stateRoot } : {}),
      revision: options.revision || 'HEAD',
      publishedAt: new Date().toISOString()
    });
    return {
      exitCode: 0,
      out: {
        ok: true,
        command,
        project: result.project,
        sourceCommit: result.publication.sourceCommit,
        sourceBranch: result.publication.sourceBranch,
        publicationCommit: result.publication.publicationCommit,
        publicationTree: result.publication.publicationTree,
        mirrorRemote: result.publication.mirrorRemote,
        mirrorBranch: result.publication.mirrorBranch,
        mirroredEntries: result.publication.mirroredEntries,
        withheldEntries: result.publication.withheldEntries,
        // Summarised BY RULE rather than listed file by file. A publish that
        // prints 46 acknowledged fixture paths on a green run is a wall nobody
        // reads, and the one line that matters -- a rule acknowledging more
        // files than its reason claims -- disappears into it. Violations are
        // never summarised: those are named individually, in the refusal.
        credentialScan: {
          scanned: result.scan.scanned,
          binarySkipped: result.scan.binarySkipped,
          acknowledgedByRule: result.scan.acknowledgedHits.reduce((counts, hit) => {
            counts[hit.rule] = (counts[hit.rule] || 0) + 1;
            return counts;
          }, {})
        },
        // Named, not hidden: a mirror mirrors HEAD, so anything uncommitted in
        // the checkout is invisible to every cloud agent that clones it.
        uncommittedPathsNotMirrored: result.uncommittedPaths,
        receiptFile: result.receiptFile
      }
    };
  }

  if (command === 'list') {
    // Reads the registry WITHOUT loadRegistry's dispatch-time refusals, so a
    // person can ask what is registered and be told 'nothing yet' instead of
    // being refused for the absence they are asking about.
    const listed = mirror.listRegisteredProjects(registryPath ? { registryPath } : {});
    return { exitCode: 0, out: { ok: true, command, ...listed } };
  }

  if (command === 'disable') {
    const result = mirror.disableMirrorProject({
      projectKey: options.project,
      registryPath,
      ...(stateRoot ? { stateRoot } : {}),
      disabledAt: new Date().toISOString()
    });
    return {
      exitCode: 0,
      out: {
        ok: true,
        command,
        project: result.project,
        registryPath: result.registryPath,
        remoteChanged: false
      }
    };
  }

  const verdict = await mirror.checkMirrorFreshness({
    projectKey: options.project || null,
    cloudRepository: options.repository || null,
    registryPath,
    ...(stateRoot ? { stateRoot } : {})
  });
  return { exitCode: 0, out: { ok: true, command, ...verdict } };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    ({ exitCode, out }) => {
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exitCode = exitCode;
    },
    (error) => {
      const code = error && error.code ? String(error.code) : 'CLOUD_MIRROR_UNEXPECTED';
      const message = error && error.message ? String(error.message) : String(error);
      const details = error && error.details ? error.details : undefined;
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } })}\n`);
      process.exitCode = REFUSAL_CODES.has(code) ? 3 : 1;
    }
  );
}

module.exports = Object.freeze({ parseCliArgs, COMMANDS, REFUSAL_CODES });
