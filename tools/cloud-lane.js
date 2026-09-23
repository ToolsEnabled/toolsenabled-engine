#!/usr/bin/env node
'use strict';

// R1177: FileKeeper <-> Codex Cloud custody loop CLI. This file is a THIN arg
// parser over src/lib/cloud-agent/cloud-lane.js -- all custody logic lives
// there, dependency-injected and tested with fakes. Every subcommand emits
// exactly one line of JSON on stdout and exits nonzero on any failure.
//
// Exit codes: 0 success (verify: verdict PASS), 3 verify completed with
// verdict FAIL or a NAMED refusal from REFUSAL_CODES below, 1 any other
// failure. State lands under state/cloud-custody (gitignored program state)
// unless --state-root overrides it; nothing here ever stages, commits, or
// writes a git working tree.
//
//   node tools/cloud-lane.js outbound --commit <sha> --branch <name> [--remote origin] [--repo-root <dir>] [--state-root <dir>]
//   node tools/cloud-lane.js submit --env <id> --branch <name> --query-file <path> --expect-path <repo-relative> --expect-sha256 <hex64> [--outbound-proof <proofId>] [--state-root <dir>]
//   node tools/cloud-lane.js status --task <taskId> [--state-root <dir>]
//   node tools/cloud-lane.js verify --task <taskId> [--state-root <dir>]
//   node tools/cloud-lane.js batch --declaration <path.json> [--state-root <dir>] [--registry <path>] [--dry-run]

const fs = require('node:fs');
const path = require('node:path');

const lane = require('../src/lib/cloud-agent/cloud-lane');
const batchJournal = require('../src/lib/cloud-agent/batch-journal');
const batchTarget = require('../src/lib/cloud-agent/batch-target');
const { createCodexCliTransport } = require('../src/lib/cloud-agent/codex-cli-transport');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');
const { assertActive } = require('../src/lib/policy');

const REPO_ROOT = path.resolve(__dirname, '..');

// Where the batch RUNNER lives. Resolved late (see resolveRunBatch) and named
// once here, because `batch` is the only subcommand that needs it and an
// absent runner must produce a sentence naming this path rather than a stack
// trace from the top of the file.
const BATCH_RUNNER_MODULE = '../src/lib/cloud-agent/batch-runner';

// Refusals that mean "the lane refused", as opposed to "the lane broke" -- the
// same split tools/cloud-mirror.js keeps, and for the same reason: a caller
// gating on this command must be able to tell a batch that was turned away at
// admission from a batch whose runner crashed. Kept as an explicit list rather
// than a CLOUD_BATCH_ prefix test, so adding a code stays a decision about how
// callers should treat it. Every one of these is raised by
// src/lib/cloud-agent/batch-target.js or batch-journal.js and every one names
// something the coordinator can still fix before committing to the batch.
const REFUSAL_CODES = new Set([
  'CLOUD_BATCH_REFUSED',            // a gate finding: shape, brief, collision, bounds or mirror
  'CLOUD_BATCH_MALFORMED',          // the declaration does not say enough to dispatch anything
  'CLOUD_BATCH_SEAL_BROKEN',        // the declaration changed after admission
  'CLOUD_BATCH_UNRECONCILED',       // a resume blocked on dispatches with an intent and no outcome
  'CLOUD_BATCH_JOURNAL_ABSENT',     // asked to read a journal that is not there
  'CLOUD_BATCH_JOURNAL_CORRUPT',    // damaged other than by a kill mid-write
  'CLOUD_BATCH_JOURNAL_UNWRITABLE', // refused BEFORE dispatching, because an unrecorded dispatch cannot be cancelled
  // Reachable since the provider block let this file supply `dispatch`; their
  // former hold-back comment said to add them in that same commit, and they
  // arrive one commit late with the harvest verb that exercises the journal.
  'CLOUD_BATCH_RATE_UNSERVEABLE',   // fewer distinct accounts than the admitted rate was cleared for
  'CLOUD_BATCH_JOURNAL_MISMATCH',   // the journal on disk belongs to a different admission
  'CLOUD_BATCH_JOURNAL_UNIDENTIFIED', // the journal names no admission at all
  'CLOUD_HARVEST_NO_JOURNAL',       // asked to harvest a wave whose one complete record is unreadable
  'CLOUD_HARVEST_NOTHING_LAUNCHED'  // a journal of intents with no launches is a wave that never went out
]);

// NOT IN THAT SET, ON PURPOSE: CLOUD_BATCH_RUNNER_MISCONFIGURED and
// CLOUD_HARVEST_MISCONFIGURED mean this lane was assembled wrong, which is
// the lane breaking (exit 1), not the lane refusing work (exit 3).

const COMMANDS = Object.freeze({
  outbound: Object.freeze({ required: Object.freeze(['commit', 'branch', 'allowlist']), optional: Object.freeze(['remote', 'repo-root', 'state-root']) }),
  submit: Object.freeze({ required: Object.freeze(['env', 'branch', 'query-file', 'expect-path', 'expect-sha256']), optional: Object.freeze(['outbound-proof', 'state-root', 'codex-binary']) }),
  status: Object.freeze({ required: Object.freeze(['task']), optional: Object.freeze(['state-root', 'codex-binary']) }),
  verify: Object.freeze({ required: Object.freeze(['task']), optional: Object.freeze(['state-root', 'codex-binary']) }),
  // --registry surfaces admitBatch's own registryPath argument. Without it the
  // mirror gate can only ever be run against the machine's default registry,
  // which makes the one gate this lane exists for untestable and unpointable.
  // It serves BOTH source modes: in mirror mode it names the registry the
  // freshness check runs against, and in published-commit mode it names the
  // registry that binds the declaration's project to the checkout the drift
  // gate measures against. One flag, because they are one binding.
  batch: Object.freeze({
    required: Object.freeze(['declaration']),
    optional: Object.freeze(['state-root', 'registry', 'codex-binary']),
    flags: Object.freeze(['dry-run'])
  }),
  harvest: Object.freeze({
    required: Object.freeze(['journal', 'out']),
    optional: Object.freeze(['state-root', 'codex-binary']),
    flags: Object.freeze([])
  })
});

// shell:false spawn cannot resolve npm's `codex` .cmd shim on Windows, so the
// transport needs the real executable. --codex-binary overrides; otherwise use
// `codex` and let PATH resolution work where it does (POSIX).
function codexBinaryOption(options) {
  return options['codex-binary'] === undefined ? {} : { codexBinary: options['codex-binary'] };
}

function usageError(message) {
  return new CloudAgentError('CLOUD_LANE_USAGE', `${message} Subcommands: ${Object.keys(COMMANDS).join(', ')}.`);
}

// The outbound territory is DECLARED, never inferred. There is deliberately no
// default and no derivation from the repository contents: an allowlist computed
// from the files being sent permits whatever it is handed, which is the defect
// this flag exists to close. Whoever runs the command states what may leave.
function parseAllowlist(raw) {
  const rules = String(raw).split(',').map((rule) => rule.trim()).filter((rule) => rule.length > 0);
  if (rules.length === 0) {
    throw usageError('--allowlist must list at least one non-empty rule, e.g. --allowlist "src/*,tools/*,README.md".');
  }
  return rules;
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (!spec) throw usageError(`unknown or missing subcommand '${command || ''}'.`);
  // Value flags consume two tokens, boolean flags one. A command that declares
  // no `flags` list has none, which keeps every pre-existing subcommand parsing
  // exactly as it did when this loop stepped two at a time.
  const booleans = spec.flags || [];
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (typeof flag !== 'string' || !flag.startsWith('--')) throw usageError(`expected a --flag, got '${flag}'.`);
    const name = flag.slice(2);
    if (booleans.includes(name)) {
      if (name in options) throw usageError(`duplicate flag --${name}.`);
      options[name] = true;
      continue;
    }
    if (!spec.required.includes(name) && !spec.optional.includes(name)) {
      throw usageError(`unknown flag --${name} for '${command}'.`);
    }
    if (name in options) throw usageError(`duplicate flag --${name}.`);
    const value = rest[i + 1];
    if (value === undefined) throw usageError(`flag --${name} requires a value.`);
    options[name] = value;
    i += 1;
  }
  for (const name of spec.required) {
    if (!(name in options)) throw usageError(`'${command}' requires --${name}.`);
  }
  return { command, options };
}

function readQueryFile(queryFile) {
  let text = fs.readFileSync(path.resolve(queryFile), 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip a UTF-8 BOM (PowerShell-written files)
  return text;
}

// THREE DIFFERENT ANSWERS, KEPT APART. "there is no file there", "I could not
// look at the file", and "the file is there and does not parse" are distinct
// facts about a batch nobody will be watching, and merging any two of them
// sends the coordinator to debug the wrong thing. The first two are invocation
// problems (exit 1, the caller mistyped something); the third is a refusal of
// the declaration itself and exits 3 with the malformed code the library uses.
function readDeclarationFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') throw usageError(`no batch declaration file at ${file}.`);
    throw usageError(`the batch declaration at ${file} could not be read (${error && error.code}): ${error && error.message}.`);
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip a UTF-8 BOM (PowerShell-written files)
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CloudAgentError('CLOUD_BATCH_MALFORMED',
      `the batch declaration at ${file} is not valid JSON: ${error && error.message}`);
  }
}

// The runner is resolved BEFORE the journal is opened, so a lane that cannot
// dispatch does not first leave behind a journal for a batch that never ran.
//
// AN ABSENT RUNNER IS NOT A CRASH AND NOT A REFUSAL. It is this lane being
// incomplete, which is why it exits 1 (the lane broke) rather than 3 (the lane
// said no) and why the three ways it can be missing -- no module, a module that
// throws while loading, a module exporting something else -- are reported
// separately instead of as one "could not start" sentence.
function resolveRunBatch(deps) {
  if (typeof deps.runBatchImpl === 'function') return deps.runBatchImpl;
  try {
    require.resolve(BATCH_RUNNER_MODULE);
  } catch {
    throw new CloudAgentError('CLOUD_BATCH_RUNNER_UNAVAILABLE',
      `no batch runner module at ${BATCH_RUNNER_MODULE} (resolved from ${__filename}), so an admitted batch has nothing to dispatch it. Nothing was journalled and nothing was sent.`);
  }
  let runner;
  try {
    runner = require(BATCH_RUNNER_MODULE);
  } catch (error) {
    throw new CloudAgentError('CLOUD_BATCH_RUNNER_UNAVAILABLE',
      `${BATCH_RUNNER_MODULE} is present but failed to load: ${error && error.message}. Nothing was journalled and nothing was sent.`);
  }
  if (!runner || typeof runner.runBatch !== 'function') {
    throw new CloudAgentError('CLOUD_BATCH_RUNNER_UNAVAILABLE',
      `${BATCH_RUNNER_MODULE} loaded but exports no runBatch function. Nothing was journalled and nothing was sent.`);
  }
  return runner.runBatch;
}

// THE DRIFT GATE'S ONE QUESTION, ANSWERED BY GIT.
//
// batch-target's gateDrift ("this batch declares against.publishedCommit, but
// no way to ask which files changed since it was supplied") asks a single
// thing: which paths moved since the commit the cloud agents will actually
// see. Until this function existed the `batch` subcommand passed nothing, so
// EVERY declaration carrying `against` was refused for a reason that was this
// file's fault rather than the declaration's -- the gate was right and the
// wiring was absent.
//
// WHICH CHECKOUT IT ASKS. The declaration names a `project`, and the mirror
// registry is the one place a project key is already bound to a local checkout
// (`sourceRoot`). That binding is used rather than a per-invocation
// --source-root flag ON PURPOSE: a path supplied beside the declaration could
// point at a tree where those files happen not to have moved, which passes the
// drift gate without meaning anything. A project the registry does not name
// refuses here, by name, rather than answering from a tree nobody declared.
//
// THREE QUESTIONS, UNIONED, because "this target moved" has three ways to be
// true and admitting on two of them is the silent staleness this lane exists
// to end:
//   1. it moved in history between the published commit and HEAD;
//   2. it differs in the WORKING TREE from the published commit -- an
//      uncommitted local edit is not something the cloud agent can see either,
//      and the coordinator planned against the tree, not against HEAD;
//   3. it is present here and tracked at no commit at all, so at the published
//      commit the agent finds no such file.
// A union can only ever refuse MORE tasks than one question alone. A target
// this set does not contain is one that none of the three found.
//
// ARGUMENT ARRAYS, NEVER A SHELL STRING. runGitSync spawns `['-C', repoRoot,
// ...args]` with shell:false. A path-bearing shell string keeps its quotes on
// Windows and comes back ENOENT, which this project has been burned by twice;
// `${commit}^{commit}` would additionally be eaten by cmd.exe's escape
// character.
//
// -z ON EVERY LISTING. Printed a line at a time, git quotes any path outside
// ASCII (core.quotePath), and a quoted path never string-equals the task
// target it should have refused -- the drift gate compares with
// `movedSet.has(file)`. NUL-separated output is the raw byte path.
//
// EVERY REFUSAL IN HERE NAMES ITSELF IN ITS OWN SENTENCE. gateDrift catches
// whatever this throws and reports `error.message` only, so a code carried on
// the error object alone would be dropped on the floor between here and the
// operator reading the finding.
function createGitChangedSince({ mirror, projectKey, registryPath }) {
  return async (publishedCommit) => {
    const registry = mirror.loadRegistry(registryPath ? { registryPath } : {});
    const project = mirror.projectFor({ registry, projectKey });
    const sourceRoot = project.sourceRoot;
    const short = String(publishedCommit).slice(0, 12);
    const git = (args) => String(mirror.runGitSync(sourceRoot, args) || '');

    // "THIS CHECKOUT DOES NOT HAVE THAT COMMIT" IS ITS OWN ANSWER, and it is
    // the one most likely to be true: a coordinator can name a commit that
    // exists on the published branch and has never been fetched here. Left to
    // the diff below it would arrive as a bare `fatal: bad object`, which reads
    // like the lane broke rather than like a question nobody can answer yet.
    try {
      git(['rev-parse', '--verify', `${publishedCommit}^{commit}`]);
    } catch (error) {
      throw new CloudAgentError('CLOUD_BATCH_DRIFT_COMMIT_ABSENT',
        `CLOUD_BATCH_DRIFT_COMMIT_ABSENT: ${sourceRoot}, the sourceRoot registered for project ${projectKey}, holds no commit ${publishedCommit} (${error && error.message}). `
        + 'Fetch it there or declare a commit this checkout has -- which files moved since a commit nobody here can resolve is unanswerable, and unanswerable is not "nothing moved".');
    }

    const moved = new Set();
    const collect = (args, question) => {
      let out;
      try {
        out = git(args);
      } catch (error) {
        throw new CloudAgentError('CLOUD_BATCH_DRIFT_UNANSWERED',
          `CLOUD_BATCH_DRIFT_UNANSWERED: ${question} could not be established in ${sourceRoot} (${error && error.message}). `
          + 'Refusing rather than returning the part of the answer that did work: a partial set of moved files admits every task the missing part would have refused.');
      }
      for (const entry of out.split('\0')) if (entry.length > 0) moved.add(entry);
    };

    collect(['diff', '--name-only', '--no-renames', '-z', publishedCommit, 'HEAD'],
      `which files moved between ${short} and HEAD`);
    collect(['diff', '--name-only', '--no-renames', '-z', publishedCommit],
      `which files differ in the working tree from ${short}`);
    collect(['ls-files', '--others', '--exclude-standard', '-z'],
      'which files are present here and tracked at no commit');
    return moved;
  };
}

// EACH ACCOUNT'S OWN HOME, FROM THE ONE REGISTRY THAT KNOWS IT. Shared by
// `batch` (roster from the sealed provider block) and `harvest` (roster from
// the journal's launched lines). requireAccount refuses an unknown name with
// the known roster in its sentence, and everything refuses BEFORE any
// provider call, so a roster typo costs nothing.
// codexExecutable() returns { command, prefixArgs } -- the launch module's
// bundle shape, not a bare path. Both dispatch and harvest hand a string
// `codexBinary` to a spawn that self-detects a .js entry, so the string is
// the .command. prefixArgs is empty for codex on every platform this resolves
// (a bundled .exe or a global shim), but a future non-empty prefix would be
// silently dropped here, so it is refused by name rather than lost. The
// scratchpad harness passed a hardcoded path and never hit this; the product
// verb did, with `[object Object]` as a module path.
function resolveCodexBinary(codexBinary) {
  if (typeof codexBinary === 'string') return codexBinary;
  const { codexExecutable } = require('../src/lib/multi-account/launch');
  const resolved = codexBinary || codexExecutable();
  if (resolved && Array.isArray(resolved.prefixArgs) && resolved.prefixArgs.length > 0) {
    throw new CloudAgentError('CLOUD_DISPATCH_PREFIXED_BINARY',
      `the resolved codex executable needs prefix arguments (${resolved.prefixArgs.join(' ')}), which the batch dispatcher's string-binary contract cannot carry. Pass --codex-binary with a directly-spawnable entry.`);
  }
  return resolved && resolved.command ? resolved.command : resolved;
}

function resolveAccountHomes(accountNames) {
  const accountRegistry = require('../src/lib/multi-account/registry');
  // The registry has ONE location and refuses to guess it -- loadRegistry
  // takes an explicit configPath, and registry-location.js is the single
  // resolver every other caller uses (codex-cloud-launch.js among them). A
  // bare loadRegistry({}) throws ACCOUNTS_REGISTRY_PATH_INVALID, which is the
  // fault the harvest verb first hit; resolving the installed-product path is
  // what a dispatch or harvest run needs to see the accounts at all.
  const { accountRegistryPath } = require('../src/lib/multi-account/registry-location');
  const registry = accountRegistry.loadRegistry({ configPath: accountRegistryPath() });
  const homes = {};
  for (const name of accountNames) {
    const account = accountRegistry.requireAccount(registry, name, { provider: 'codex' });
    homes[name] = accountRegistry.resolveProfileDir(account, {});
  }
  return homes;
}

// The harvest transport: the codex CLI asked under the task's own account
// home, with the same billing scrub every launch gets. Status first --
// a pending task is an answer, not an error -- then the diff, where the
// provider's "No diff available" is the honest nothing-to-fix shape.
function createCodexHarvestFetch({ codexBinary, accountHomes }) {
  const { execFile } = require('node:child_process');
  const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
  const { codexSpawn } = require('../src/lib/cloud-agent/codex-dispatcher');
  const call = (args, home) => new Promise((resolve, reject) => {
    const environment = safeLaunchEnvironment(process.env);
    environment.CODEX_HOME = home;
    // The SAME spawn rule dispatch uses: a native codex.exe is spawned
    // directly, a .js entry under node. Running the exe under node was the
    // third fault on this path and errored all 144 fetches of the first
    // real harvest.
    const { command, argv } = codexSpawn(codexBinary, args);
    execFile(command, argv,
      { env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && !String(stderr || '').trim() && !String(stdout || '').trim()) return reject(error);
        resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
  return async ({ taskId, account }) => {
    const home = accountHomes[account];
    if (!home) throw new CloudAgentError('CLOUD_HARVEST_MISCONFIGURED', `no CODEX_HOME resolved for account ${account}.`);
    const status = await call(['cloud', 'status', taskId], home);
    if (/^\[PENDING\]/im.test(status.stdout)) return { state: 'pending', diff: '' };
    /* A LANE THAT BROKE IS NOT A LANE THAT LOOKED AND FOUND NOTHING.
     *
     * A task the provider reports as ERROR also has no diff, so it used to
     * fall through to the "No diff available" branch below and be graded
     * NO_DIFF -- the most reassuring verdict there is. Measured by another
     * coordinator: two waves errored 66/66 and 8/8, and both harvested as a
     * clean manifest of NO_DIFF. A wave that failed wholesale looked complete
     * and empty, which is indistinguishable from a wave that found nothing to
     * fix, and a stack reading that manifest would ship the difference.
     *
     * This is the same collapse as the throttle bug one state over: a
     * could-not-succeed reported as a definite answer. The state is carried
     * out separately so the manifest can refuse to call it clean. */
    if (/^\[(ERROR|FAILED|CANCELLED|CANCELED|TIMED[_ ]?OUT)\]/im.test(status.stdout)) {
      const line = (status.stdout.match(/^\[[A-Z_ ]+\].*$/im) || [''])[0].trim();
      return { state: 'errored', diff: '', detail: line.slice(0, 200) };
    }
    const diff = await call(['cloud', 'diff', taskId], home);
    if (/No diff available/i.test(diff.stdout + diff.stderr)) return { state: 'ready', diff: '' };
    if (diff.error) throw new CloudAgentError('CLOUD_HARVEST_FETCH', (diff.stderr || diff.stdout).slice(0, 200));
    return { state: 'ready', diff: diff.stdout };
  };
}

// `deps` is injection for tests ONLY, and every entry defaults to the real
// thing. It exists because the mirror gate and the runner are the two edges
// this file cannot exercise offline; nothing here reads it as permission to
// skip a gate, and tests/cloud-lane-batch-cli.test.js separately proves the
// UNINJECTED call still consults the real mirror.
async function main(argv, deps = {}) {
  const { command, options } = parseCliArgs(argv);
  // Every subcommand here either dispatches real work to Codex Cloud
  // (submit), queries it (status, verify), or declares what is permitted to
  // leave in a later submit (outbound) -- this is exactly the class of
  // first-party "bypass CLI" R1162 Stage 1b closed for tools/research-once.js
  // and tools/ucr-login.js (docs/coordinator/R1162-SWARM-STAGE1B-BYPASS-CLI-
  // MEDIATION-REPORT.md): a script that calls into an outward-effect provider
  // without ever importing assertActive, so an active KILLSWITCH file does
  // not stop it. This file was not part of that sweep and had the same gap.
  // No `provider` option is passed: cloud-lane has no entry in policy.js's
  // providerByAction map or config/toolsenabled.policy.json's providers
  // block (same shape as the 'ucr.login' fix), so only the kill-switch and
  // autonomous-mode gate apply -- there is no third-party API credential
  // this action is gated on.
  assertActive(`cloud_lane.${command}`);
  const stateRoot = options['state-root']
    ? path.resolve(options['state-root'])
    : path.join(REPO_ROOT, 'state', 'cloud-custody');
  const nowIso = new Date().toISOString(); // the one clock read; the lib modules never read a clock

  if (command === 'outbound') {
    const { record, recordPath } = await lane.runOutbound({
      commit: options.commit,
      branch: options.branch,
      remote: options.remote === undefined ? 'origin' : options.remote,
      repoRoot: options['repo-root'] ? path.resolve(options['repo-root']) : REPO_ROOT,
      stateRoot,
      createdAt: nowIso,
      allowlist: parseAllowlist(options.allowlist)
    });
    return {
      exitCode: 0,
      out: {
        ok: true,
        command,
        proofId: record.proof.proofId,
        manifestId: record.manifestId,
        entryCount: record.entryCount,
        totalBytes: record.totalBytes,
        excluded: record.excluded,
        allowlistSize: record.allowlistSize,
        recordPath
      }
    };
  }

  if (command === 'submit') {
    const queryText = readQueryFile(options['query-file']);
    const transport = createCodexCliTransport({ branch: options.branch, buildQuery: () => queryText, ...codexBinaryOption(options) });
    const { record, recordPath } = await lane.runSubmit({
      transport,
      env: options.env,
      branch: options.branch,
      expectPath: options['expect-path'],
      expectSha256: options['expect-sha256'],
      outboundProofId: options['outbound-proof'] === undefined ? null : options['outbound-proof'],
      stateRoot,
      submittedAt: nowIso
    });
    return {
      exitCode: 0,
      out: { ok: true, command, taskId: record.taskId, lastStatus: record.lastStatus, expectation: record.expectation, recordPath }
    };
  }

  if (command === 'status') {
    const result = await lane.runStatus({
      transport: createCodexCliTransport(codexBinaryOption(options)),
      taskId: options.task,
      stateRoot,
      checkedAt: nowIso
    });
    return { exitCode: 0, out: { ok: true, command, ...result } };
  }

  if (command === 'batch') {
    const declarationPath = path.resolve(options.declaration);
    const declaration = readDeclarationFile(declarationPath);
    // THE MIRROR API IS THE REAL ONE BY DEFAULT, and the injected one exists
    // only so the offline tests can reach an ADMITTED batch. batch-target picks
    // its source gate from what it is handed: a declaration with `against`
    // takes the drift gate, otherwise a mirrorApi takes the mirror gate, and
    // neither one available is itself a refusal. So passing nothing here would
    // not skip a gate, but it would turn every ordinary batch into a refusal
    // for a reason that is this file's fault rather than the declaration's.
    //
    // THE OTHER SOURCE MODE IS WIRED THE SAME WAY. `changedSince` is the
    // function the drift gate asks which files moved since
    // `against.publishedCommit`; createGitChangedSince above answers it from
    // the checkout the registry binds this project to. Nothing is computed
    // until the gate calls it, so a mirror-mode declaration pays for none of
    // it, and a declaration carrying `against` is now checked rather than
    // refused for the absence of a wire.
    //
    // deps.changedSince is injection for tests ONLY, on the same terms as
    // deps.mirrorApi: the real function needs a git checkout, and the tests
    // that need an ADMITTED batch in mirror mode must not be made to build
    // one. The drift checks in tests/cloud-lane-batch-cli.test.js inject
    // nothing here -- they drive a real git repository through the real
    // function, because an injected drift answer proves only the injection.
    const cloudMirror = require('../src/lib/cloud-agent/cloud-mirror');
    const mirrorApi = deps.mirrorApi || cloudMirror;
    const registryPath = options.registry ? path.resolve(options.registry) : null;
    const admission = await batchTarget.admitBatch(declaration, {
      mirrorApi,
      registryPath,
      changedSince: deps.changedSince || createGitChangedSince({
        mirror: cloudMirror,
        // The RAW declaration's project. parseBatchTarget runs first inside
        // admitBatch and refuses a malformed one before any gate calls this,
        // so nothing here can be reached with a project key that was not
        // checked against PROJECT_KEY.
        projectKey: declaration && typeof declaration === 'object' ? declaration.project : undefined,
        registryPath
      }),
      now: nowIso
    });

    // --dry-run IS ADMISSION AND NOTHING ELSE. No journal, no dispatch, no
    // runner: a coordinator about to stop steering can ask whether the
    // declaration would be admitted without committing to it. A refusal never
    // reaches here -- admitBatch throws CLOUD_BATCH_REFUSED carrying every
    // finding, which the handler below prints in full and exits 3 on.
    if (options['dry-run']) {
      return {
        exitCode: 0,
        out: {
          ok: true,
          command,
          dryRun: true,
          admitted: true,
          findings: [],
          batchId: admission.batchId,
          project: admission.project,
          taskCount: admission.taskCount,
          bounds: admission.bounds,
          admissionSha256: admission.admissionSha256,
          declarationPath
        }
      };
    }

    const runBatch = resolveRunBatch(deps);
    // The journal is opened BEFORE the handoff, so the runner writes its first
    // intent into a file that already carries the admission it is running under.
    const journalFile = batchJournal.openBatch({ stateRoot, admission, at: nowIso });
    // THE HANDOFF IS COMPLETE EXACTLY WHEN THE DECLARATION SEALED ITS
    // DESTINATION. The old gap here was principled, not lazy: dispatch needs
    // provider coordinates, and coordinates taken from FLAGS would sit outside
    // the seal admission computed, so a sealed batch could be pointed somewhere
    // nobody admitted. The fix is the `provider` block parseBatchTarget now
    // validates -- branch, per-account environment ids, concurrency -- INSIDE
    // the sealed declaration. What this CLI still supplies is only what is
    // machine-local by nature: each account's CODEX_HOME from the multi-account
    // registry, and the resolved codex executable (bare `codex` is an npm .cmd
    // shim a shell-less spawn cannot run). A declaration with no provider block
    // keeps the old contract: runBatch refuses the incomplete lane by name.
    const parsedTarget = batchTarget.parseBatchTarget(declaration);
    let dispatchSupply = {};
    if (parsedTarget.provider) {
      const { createCodexDispatcher } = require('../src/lib/cloud-agent/codex-dispatcher');
      const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
      const accountNames = Object.keys(parsedTarget.provider.environments);
      const accountHomes = resolveAccountHomes(accountNames);
      const { codexExecutable } = require('../src/lib/multi-account/launch');
      dispatchSupply = {
        dispatch: createCodexDispatcher({
          codexBinary: options['codex-binary'] === undefined ? resolveCodexBinary(codexExecutable()) : options['codex-binary'],
          accountHomes,
          accountEnvironments: parsedTarget.provider.environments,
          branch: parsedTarget.provider.branch,
          scrubEnvironment: safeLaunchEnvironment
        }),
        accounts: accountNames,
        concurrency: parsedTarget.provider.concurrency
      };
    }
    const result = await runBatch({ admission, declaration: parsedTarget, journalFile, stateRoot, ...dispatchSupply });
    return {
      exitCode: 0,
      out: {
        ok: true,
        command,
        dryRun: false,
        batchId: admission.batchId,
        taskCount: admission.taskCount,
        admissionSha256: admission.admissionSha256,
        journalFile,
        ...(result && typeof result === 'object' ? result : { result })
      }
    };
  }

  if (command === 'harvest') {
    const batchHarvest = require('../src/lib/cloud-agent/batch-harvest');
    const journalFile = path.resolve(options.journal);
    const outDir = path.resolve(options.out);
    // The wave's accounts come from the journal itself -- the launched lines
    // name which account carried each task -- so the roster needs no separate
    // declaration and cannot disagree with what actually went out.
    const wave = batchHarvest.readWave(journalFile, fs);
    const accountNames = [...new Set(wave.map((task) => task.account).filter(Boolean))];
    const { codexExecutable } = require('../src/lib/multi-account/launch');
    const fetchTask = createCodexHarvestFetch({
      codexBinary: options['codex-binary'] === undefined ? resolveCodexBinary(codexExecutable()) : options['codex-binary'],
      accountHomes: resolveAccountHomes(accountNames)
    });
    const result = await batchHarvest.harvestBatch({ journalFile, outDir, fetchTask });
    return { exitCode: 0, out: { ok: true, command, ...result } };
  }

  // verify: verdict FAIL completes the check but still exits nonzero so a
  // gating caller can never mistake a failed custody check for success.
  const result = await lane.runVerify({
    transport: createCodexCliTransport(codexBinaryOption(options)),
    taskId: options.task,
    stateRoot,
    verifiedAt: nowIso
  });
  return { exitCode: result.verdict === 'PASS' ? 0 : 3, out: { ok: result.verdict === 'PASS', command, ...result } };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    ({ exitCode, out }) => {
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exitCode = exitCode;
    },
    (error) => {
      const code = error && error.code ? String(error.code) : 'CLOUD_LANE_UNEXPECTED';
      const message = error && error.message ? String(error.message) : String(error);
      // `details` carries the STRUCTURE the message can only describe -- for a
      // batch refusal, the full list of gate findings. Printing it is what lets
      // a coordinator act on all of them at once instead of parsing the
      // sentence, which is the exact thing CloudAgentError.details exists for.
      const details = error && error.details ? error.details : undefined;
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } })}\n`);
      // 3 = the lane said no, 1 = the lane broke. No pre-existing subcommand can
      // raise a code in REFUSAL_CODES, so their exit codes are unchanged.
      process.exitCode = REFUSAL_CODES.has(code) ? 3 : 1;
    }
  );
}

module.exports = Object.freeze({ parseCliArgs, COMMANDS, REFUSAL_CODES, main, resolveCodexBinary });
