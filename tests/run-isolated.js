#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { runIsolatedChild } = require('./lib/isolated-child');
const { configure, isolatedTemporaryRoot, retainTestStateRequested } = require('./lib/isolated-environment');
const { readSuiteList } = require('./lib/suite-list');
const { DEFAULT_TIMEOUT_MS, timeoutForSuite } = require('./lib/suite-timeouts');
const { OPT_IN_TESTS, strictRequested, validateCompletion } = require('../tools/lib/test-completion');
const { deleteEnvNames } = require('../src/lib/env-scrub');
const lifecycleRecords = require('../tools/lib/strict-lifecycle-record');

const ROOT = path.resolve(__dirname, '..');
const RETRYABLE_REMOVE_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const RUNNABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const STRICT = strictRequested();
const RETAIN_TEST_STATE = retainTestStateRequested();

// A single integration test launches the already-provisioned Playwright
// Chromium binary.  `configure()` deliberately redirects LOCALAPPDATA before
// the child starts, which is the correct isolation boundary for profiles and
// state, but it also makes Playwright look for a browser below the empty
// scratch directory.  Discover the exact binary once, before that redirect,
// and hand only that path to that one child.  Do not forward LOCALAPPDATA (or
// any wider ambient browser configuration): the child remains profile-less,
// offline, and isolated in every other respect.
function installedChromiumFor(relativeFile) {
  if (relativeFile !== 'tests/owner-delivery.js') return null;
  try {
    const { chromium } = require('playwright');
    const executable = chromium.executablePath();
    if (executable && fs.existsSync(executable)) return executable;
  } catch {
    // Continue to the bounded system-browser candidates below. The test still
    // uses Playwright as its driver; only the Chromium executable is supplied.
  }
  // Windows installations already carry Chromium-based Edge, and some carry
  // system Chrome. These fixed machine-wide paths are not browser profiles and
  // remain outside every user account. Never search sibling profiles or PATH.
  const systemCandidates = process.platform === 'win32' ? [
    path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ] : [];
  return systemCandidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

// Opt-in-gated suites: real Windows Task Scheduler mutation smoke tests that
// require an explicit env var (documented in runbook/phase-5-extras.md) before
// they will touch the live scheduler. Left alone, they self-skip with exit 0,
// which this runner used to record as `status: 'pass'` -- a suite that always
// skips is then indistinguishable from a suite that actually ran and passed.
// This registry lets the runner recognize the self-skip BEFORE spawning the
// child and report it honestly as `status: 'skip'` instead, without editing
// the suites themselves (owned elsewhere) and without weakening what a real
// `pass` means for anything else. Keep this list narrow and exact -- it is a
// deliberate exception list, not a pattern that should grow by convention.
const OPT_IN_GATED_SUITES = new Map([
  ['tests/intent-fidelity-live.js', {
    command: 'node tests/intent-fidelity-live.js --live',
    reason: 'requires explicit real-provider opt-in and the selected historical owner-ledger corpus'
  }],
  ['tests/scheduler-windows-mutation.js', {
    envVar: 'TOOLSENABLED_WINDOWS_SCHEDULER_MUTATION_SMOKE',
    reason: 'creates/deletes a real randomized Windows Scheduled Task via COM; opt-in per runbook/phase-5-extras.md'
  }],
  ['tests/scheduler-windows-legacy-mutation.js', {
    envVar: 'TOOLSENABLED_WINDOWS_SCHEDULER_LEGACY_MUTATION_SMOKE',
    reason: 'creates/deletes real legacy Windows Scheduled Tasks via schtasks.exe; opt-in per runbook/phase-5-extras.md'
  }]
]);

// Test programs whose asserted behavior is deliberately Windows-specific.
//
// These are not product-support gates. Native Linux custody is exercised by
// tests/linux-vault.test.js, and the Windows programs below
// still run normally on Windows. On another platform, attempting to execute
// PowerShell/DPAPI/ACL/Scheduled-Task fixtures produces ENOENT or tests POSIX
// path/process semantics instead of the contract named by the file. Record
// that missing coverage as a named skip rather than a pass or product failure.
const WINDOWS_ONLY_SUITES = new Map();
WINDOWS_ONLY_SUITES.set('tests/host-exec-cancellation-native.test.js',
  'requires actual Windows named pipes and owned Jobs; native Linux cancellation is tested in tests/linux-process-control.test.js');
for (const suite of [
  'tests/kernel.policy/runtime-security.js',
  'tests/runtime-security.js',
  'tests/secret-store.js',
  'tests/vault-batched-read.test.js',
  'tests/vault-hardening.js',
  'tests/vault-native.test.js',
  'tests/secrets/device-credential-clear.js',
  'tests/secrets/windows-device-credential-clear.js',
  'tests/secrets/payment-card-security-code-never-stored.js',
  'tests/secrets/payment-card-vault-safety.js',
  'tests/secrets/secret-exists-unreadable.js',
  'tests/secrets/vault-path-agreement.js',
  'tests/secrets/vault-presence.js',
  'tests/secrets/vault-write-visibility.js',
  'tests/vault-spawn-cost.test.js',
  'tests/audit-lock-scope.test.js',
  'tests/host-exec-vault-process-budget.test.js',
  'tests/vault-presence-cache.test.js',
  'tests/secrets/vault-write-crash-safety.js',
  'tests/secrets/vault-access-log-never-resurrects-store.js',
  'tests/secrets/credential-capture.js',
  'tests/credential-capture.js'
]) {
  WINDOWS_ONLY_SUITES.set(suite,
    'exercises Windows DPAPI, dialog, or PowerShell cache/process behavior; native Linux custody is tested in tests/linux-vault.test.js');
}
for (const suite of [
  'tests/kernel.audit/vault-hardening.js',
  'tests/check-live-task-roots.test.js',
  'tests/dashboard-task-port-guard.js',
  'tests/desktop-advanced.js',
  'tests/desktop-app-capture.js',
  'tests/direct-link.test.js',
  'tests/isolation-contract.js',
  'tests/mission-bridge-bootstrap-auth.test.js',
  'tests/scheduled-task-registrars.test.js',
  'tests/servercontrol-mechanical-connect.test.js',
  'tests/startup-policy.test.js',
  'tests/desktop-window-close-guard.js',
  'tests/fra-root-access-control.js',
  'tests/fra-lifecycle-guards.js',
  'tests/fra-readiness-gates.js',
  'tests/full-remote-access-control-contract.js',
  'tests/full-remote-access-lifecycle.js',
  'tests/luna-worktree-lane.test.js',
  'tests/resource-alerts.test.js',
  'tests/fra-listener-detached-launch.js',
  'tests/delegation/uac-delegation.js',
  'tests/uac-delegation.js'
]) {
  WINDOWS_ONLY_SUITES.set(suite,
    'exercises Windows PowerShell, ACL, Scheduled Task, desktop, or service-control behavior with no cross-platform fixture');
}
for (const suite of [
  'tests/delegation/uac-delegation-client.js',
  'tests/uac-delegation-client.js',
  'tests/source-freeze.js',
  'tests/agent-wake-windows-job.test.js',
  'tests/cloud-mirror-network-containment.test.js',
  'tests/windows-job-control.test.js',
  'tests/windows-job-root-signal-native.test.js',
  'tests/process-visibility-consumer.test.js',
  'tests/surface.registry/mcp-tool-surface.js',
  'tests/playwright-smoke.js',
  'tests/r1152-sandbox-progress.test.js'
]) {
  WINDOWS_ONLY_SUITES.set(suite,
    'asserts Windows named-pipe, process-start, command-line, or read-only-file semantics');
}
WINDOWS_ONLY_SUITES.set('tests/secrets/credential-removal.js',
  'exercises the Windows DPAPI lifecycle manager and legacy File.Replace backup cleanup; Linux lifecycle management is explicitly unsupported');
WINDOWS_ONLY_SUITES.set('tests/entry/mcp-owner-proxy-lifecycle.js',
  'uses Windows named pipes and ACL fixtures; native Linux proxy/session coverage is tests/owner-host-linux.test.js');

// These programs exercise actual Linux kernel/process/file-mode/keyring or
// rootless-container behavior. Windows cannot supply those prerequisites;
// report the missing measurement explicitly, just as for the reverse case.
const LINUX_ONLY_SUITES = new Map([
  'tests/linux-agent-launch.test.js',
  'tests/linux-bridge-first-run.test.js',
  'tests/linux-claude-discovery.test.js',
  'tests/linux-desktop-temp.test.js',
  'tests/linux-desktop.test.js',
  'tests/linux-native.js',
  'tests/linux-process-control.test.js',
  'tests/linux-research-worker.test.js',
  'tests/linux-sandbox-sterile-live-smoke.js',
  'tests/linux-sandbox-workspace-live.test.js',
  'tests/linux-vault.test.js',
  'tests/owner-host-linux.test.js'
].map(file => [file, 'requires native Linux behavior; this suite still runs and must pass on Linux']));

// Suites whose fixture is a file THIS REPOSITORY DOES NOT CONTAIN.
//
// WHY THIS IS A SIBLING OF THE TABLE ABOVE AND NOT THE SAME TABLE. The gate
// above asks "did a person opt in?" and answers from the environment. This one
// asks "is the fixture on disk?" and answers from the filesystem. Both produce
// the same honest outcome -- `status: 'skip'`, never a pass, always named in
// the summary -- and neither edits the suite it is talking about.
//
// WHAT THESE FILES HAVE IN COMMON. Every one of them is untracked ON PURPOSE:
// a machine's own process registry and service topology, an editor or agent
// profile, an owner ledger, a working document of the builder's own tree, or a
// sibling checkout. None of them can be committed and none can be invented --
// see the "do not create fake fixtures" rule below.
//
// WHAT IT FIXES. Measured 2026-08-22 in this checkout: of the 305 files the
// root `test` script runs, 62 died at require or read time on a file that is
// simply absent here. They did not fail an assertion; they threw ENOENT or
// MODULE_NOT_FOUND, which reads to anyone auditing the published source as a
// broken product rather than an absent local file. A clean public checkout of
// this repository is exactly that situation, permanently.
//
// WHAT IT DOES NOT DO. It never fabricates the file, and it never suppresses a
// failure the fixture's PRESENCE would have produced: the gate fires only when
// the path is missing, so on a machine that really has the file the suite runs
// for real and any failure it finds is reported as a failure. A skip here is a
// statement that coverage is ABSENT, which is why it still sets a non-zero exit
// code and is counted separately from a pass everywhere downstream.
//
// Paths are repository-relative. Keep entries exact; this is a measured list,
// not a pattern to grow by convention.
const ABSENT_FIXTURE_GATES = [
  {
    file: 'config/managed-processes.json',
    reason: 'the registry of ONE machine\'s long-lived processes -- task names, argv preconditions and state files. Per-installation and untracked by design',
    suites: [
      'tests/audit-logs-retention.js',
      'tests/build-queue-telegram-consumer.js',
      'tests/coordinator-backup-duty.test.js',
      'tests/coordinator-duty-host.test.js',
      'tests/coordinator-duty-registry.test.js',
      'tests/coordinator-escalation-sink.test.js',
      'tests/fleet-supervisor-startup-refusal.test.js',
      'tests/managed-processes.test.js',
      'tests/owner-alert.js',
      'tests/process-visibility-consumer.test.js',
      'tests/process-visibility-live-wiring.test.js',
      'tests/remote-ask.js'
    ]
  },
  {
    file: 'config/owner-authorization.json',
    reason: 'this installation\'s owner grant and reservation record; another person\'s authorization cannot be invented',
    suites: ['tests/surface.policy/owner-authorization-surfaces.test.js']
  },
  {
    file: 'config/service-registry.json',
    reason: 'one installation\'s machine and service topology -- LAN addresses, checkout roots, ports. The installer stages a loopback-only default in its place; a source checkout has neither',
    suites: [
      'tests/agent-digest.js',
      'tests/argv-drift.test.js',
      'tests/audit-checkpoint-wiring.test.js',
      'tests/health-observer.test.js',
      'tests/link-bus-token-rotation-operator.js',
      'tests/link-bus-token-rotation-protocol.js',
      'tests/owner-delivery.js',
      'tests/service-control.js'
    ]
  },
  {
    file: 'config/agent-org.json',
    reason: 'the live declared agent organization for this installation (config/agent-org.example.json is the shipped template)',
    suites: [
      'tests/agent-org.js',
      'tests/mission-bridge-agent-lane.test.js',
      'tests/mission-bridge.test.js',
      'tests/model-floor.js'
    ]
  },
  {
    file: 'docs/GEMINI-FLEET-REPORT-CONTRACT.md',
    reason: 'the fleet report contract document, which this checkout does not carry',
    suites: [
      'tests/fleet-supervisor-planning.js',
      'tests/fleet-supervisor-review.js',
      'tests/owner-chat.js'
    ]
  },
  {
    file: 'tools/mcp-owner-proxy.js',
    reason: 'the owner-side MCP wrapper, which this checkout does not carry',
    suites: ['tests/mcp-call.js']
  },
];

const ABSENT_FIXTURE_SUITES = new Map();
for (const gate of ABSENT_FIXTURE_GATES) {
  for (const suite of gate.suites) {
    if (!ABSENT_FIXTURE_SUITES.has(suite)) ABSENT_FIXTURE_SUITES.set(suite, []);
    ABSENT_FIXTURE_SUITES.get(suite).push(gate);
  }
}

// Which of a suite's declared fixtures are actually missing RIGHT NOW. Absence
// is re-checked on every run, never cached and never assumed: the same suite
// skips on a bare checkout and runs for real on the machine that has the file.
function missingFixturesFor(relativeFile) {
  const gates = ABSENT_FIXTURE_SUITES.get(relativeFile);
  if (!gates) return [];
  return gates.filter(gate => !fs.existsSync(path.resolve(ROOT, gate.file)));
}

function missingStructuredFixturesFor(relativeFile) {
  if (relativeFile === 'tests/fleet-supervisor-startup-refusal.test.js') {
    const registryFile = 'config/managed-processes.json';
    let registry;
    try {
      registry = JSON.parse(fs.readFileSync(path.resolve(ROOT, registryFile), 'utf8'));
    } catch {
      return [];
    }
    const declaredArgv = registry?.processes?.['fleet-supervisor']?.declaredArgv;
    if (Array.isArray(declaredArgv) && declaredArgv.includes('--project') && declaredArgv.includes('--backend')) return [];
    return [`needs ${registryFile} to contain this installation's fleet-supervisor --project and --backend argv`];
  }
  return [];
}

function missingCodexCliFor(relativeFile) {
  if (relativeFile !== 'tests/agent-engine/codex-live-turn.js') return [];
  const probe = spawnSync(process.execPath, ['-e', [
    "const { detectCodexVersion } = require('./src/lib/agent-engine/codex-process');",
    'detectCodexVersion({ env: process.env }).then(() => process.exit(0)).catch(error => {',
    "  process.exit(error && error.code === 'CODEX_CLI_NOT_FOUND' ? 3 : 4);",
    '});'
  ].join('\n')], {
    cwd: ROOT,
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
    timeout: 5_000
  });
  if (!probe.error && probe.status === 3) {
    return ['needs the Codex CLI used by the real live-turn check (CODEX_CLI_NOT_FOUND)'];
  }
  // Timeout, inability to start the probe, and a non-missing version failure
  // are unknown/correctness outcomes. Only the production resolver's explicit
  // NOT_FOUND answer is absence, so all others proceed into the real suite.
  return [];
}

function parsePositiveInteger(value, label) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

// WHY CONTINUATION IS THE DEFAULT AND `--fail-fast` IS THE OPT-OUT.
//
// This runner used to stop at the first failing suite unless `--continue` was
// passed. Every one of the 48 `tests/<package>/run.js` directory runners spawns
// this file with NO flags, and `npm test` itself listed 141 files with no flags,
// so stopping early was the norm and continuing was the exception. Measured on
// the 2026-08-10 record: 139 statically-wired suites sat after a non-passing
// sibling and were therefore never executed by the battery that claims to run
// them. An unreached suite is indistinguishable from a passing one in every
// artifact except tools/invocation-guard.js -- which is this repository's
// dominant defect: a gate that reports on work it never performed.
//
// Ordinary assertion failures do not stop the batch. State is isolated per
// suite, but repository configuration remains shared: a detected config change
// stops the batch and records the remaining files as not-run.
//
// The fix is here rather than at the call sites because the call sites cannot
// all be reached from package.json: the directory runners pass no arguments at
// all, and the next one somebody writes would be born fail-fast again. Making
// continuation the default fixes every present and future caller at once.
//
// `--continue` is still ACCEPTED. It no longer changes the loop -- that is now
// unconditional -- but four call sites pass it to get the config-integrity
// sweep it implies, and silently dropping that would remove config-mutation
// detection from the full-tree run in tools/test-run.js.
//
// The exit-code contract is UNCHANGED: any non-pass still sets a non-zero
// process.exitCode. Nothing became more permissive; more files simply get to
// speak before the verdict is written.
function parseArguments(argv) {
  const options = { failFast: false, continueOnFailure: false, configIntegrity: false, summaryPath: null, assertionRoot: null, timeoutMs: null, scripts: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--fail-fast') {
      options.failFast = true;
    } else if (argument === '--continue') {
      options.continueOnFailure = true;
    } else if (argument === '--config-integrity') {
      options.configIntegrity = true;
    } else if (argument === '--summary') {
      if (options.summaryPath) throw new Error('--summary may only be supplied once');
      const summaryPath = argv[index + 1];
      if (!summaryPath || summaryPath.startsWith('--')) throw new Error('--summary requires a path');
      options.summaryPath = path.resolve(summaryPath);
      index += 1;
    } else if (argument === '--measure-builtin-assertions') {
      if (options.assertionRoot) throw new Error('--measure-builtin-assertions may only be supplied once');
      const outputRoot = argv[index + 1];
      if (!outputRoot || outputRoot.startsWith('--')) throw new Error('--measure-builtin-assertions requires a fresh retained directory');
      options.assertionRoot = path.resolve(outputRoot);
      index += 1;
    } else if (argument === '--from') {
      // A CHECKED-IN FILE LIST, because argv ran out of room.
      //
      // Windows caps a command line at 8191 characters. package.json's `test`
      // named 305 test files inline -- 12,928 characters -- so `npm test` on
      // Windows died with "The command line is too long." before a single suite
      // started. Nothing was failing; nothing was running.
      //
      // May be supplied more than once, and mixes freely with bare paths: the
      // argv form is what every tests/<package>/run.js and tools/test-run.js
      // already uses, and what a person types to run one file. Entries land in
      // options.scripts in file order and then face exactly the same
      // in-repository check as a path typed by hand -- this flag changes where
      // the list is READ, and nothing about what may be run.
      const listPath = argv[index + 1];
      if (!listPath || listPath.startsWith('--')) throw new Error('--from requires a path');
      options.scripts.push(...readSuiteList(listPath));
      index += 1;
    } else if (argument === '--timeout-ms') {
      if (options.timeoutMs != null) throw new Error('--timeout-ms may only be supplied once');
      const value = argv[index + 1];
      if (value == null) throw new Error('--timeout-ms requires a value');
      options.timeoutMs = parsePositiveInteger(value, '--timeout-ms');
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      options.scripts.push(argument);
    }
  }

  if (options.timeoutMs == null && process.env.TOOLSENABLED_TEST_TIMEOUT_MS) {
    options.timeoutMs = parsePositiveInteger(process.env.TOOLSENABLED_TEST_TIMEOUT_MS, 'TOOLSENABLED_TEST_TIMEOUT_MS');
  }
  // THE TIMEOUT IS UNCONDITIONAL, and that is the second half of the same fix.
  //
  // A hang masks the rest of a batch more completely than a failure ever did:
  // a failing suite at least produces a verdict, whereas a hung one produces
  // nothing at all, forever. It used to apply only to "enhanced" runs, so a
  // bare invocation had no guard -- and bare is exactly what npm:test and all
  // 48 tests/<package>/run.js directory runners use. Measured 2026-08-10:
  // tests/mcp-contract.js and tests/entry/mcp-contract.js both hang, so
  // `npm test` and `npm run test:entry` could not reach a verdict at all.
  // Having just made the runner continue past failures, leaving hangs
  // unguarded would have moved the masking rather than removed it.
  //
  // Three minutes is not a guess: the full 671-file tree has been run at this
  // limit and the slowest healthy suite is the roughly 94-second
  // overnight-advisory test. The only two suites it stops are the two that are
  // genuinely stuck. Override with --timeout-ms or TOOLSENABLED_TEST_TIMEOUT_MS.
  //
  // It is still unconditional, but it is no longer uniform: a suite whose real
  // cost has been measured above this limit carries a floor in
  // tests/lib/suite-timeouts.js, applied per file at the spawn below.
  //
  // `--continue` survives as the config-integrity switch its callers rely on.
  if (options.continueOnFailure) options.configIntegrity = true;
  if (options.timeoutMs == null) options.timeoutMs = DEFAULT_TIMEOUT_MS;
  if (options.assertionRoot && (!STRICT || !options.summaryPath || options.assertionRoot !== `${options.summaryPath}.assertions`)) {
    throw new Error('--measure-builtin-assertions requires strict mode, --summary, and its exact <summary>.assertions directory');
  }
  return options;
}

// Reconcile the record list against what was REQUESTED.
//
// WHY THIS EXISTS. This runner's per-file loop can be abandoned partway
// through -- a script path that fails the in-repository guard, a config
// restoration that does not converge, a spawn error, or a throw from the
// isolated-directory cleanup all propagate past the loop. The summary is
// still written, from a finally block, so it is present, valid JSON, and
// SHORT. Measured on the 2026-08-09 baseline: 709 files requested, 670
// records returned. A whole 25-file batch was abandoned after its first
// entries and the missing 39 left the numerator AND the denominator
// together, so the run reported "564/670" -- the omission was invisible in
// the very number meant to prove completeness.
//
// A file that was requested and never reported is not a pass and not a
// failure. It is an absence, and it has to say so IN THE PRODUCER. Doing it
// only in tools/test-run.js would leave every other caller of --summary
// reading a silently shrunken denominator.
//
// exitCode is null rather than 0 deliberately: no process ran, and a zero
// here would read as success to anything summing exit codes.
function appendNotRun(files, scripts) {
  const outstanding = new Map();
  for (const script of scripts) {
    const file = script.replaceAll('\\', '/');
    outstanding.set(file, (outstanding.get(file) || 0) + 1);
  }
  for (const entry of files) {
    const remaining = outstanding.get(entry.file);
    if (remaining) outstanding.set(entry.file, remaining - 1);
  }
  let added = 0;
  for (const [file, remaining] of outstanding) {
    for (let index = 0; index < remaining; index += 1) {
      files.push({ file, status: 'not-run', exitCode: null, ms: 0 });
      added += 1;
    }
  }
  return added;
}

function writeSummary(summaryPath, startedAt, files) {
  if (!summaryPath) return;
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    wallClockMs: Date.now() - startedAt,
    requested: files.length,
    files
  }, null, 2)}\n`);
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function configSnapshot() {
  const configRoot = path.join(ROOT, 'config');
  const files = new Map();
  const visit = directory => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate);
      } else {
        const relative = path.relative(ROOT, candidate).split(path.sep).join('/');
        const stat = fs.lstatSync(candidate);
        const value = stat.isSymbolicLink()
          ? `link:${fs.readlinkSync(candidate)}`
          : crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
        files.set(relative, value);
      }
    }
  };
  visit(configRoot);
  return files;
}

function changedConfigPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(file => before.get(file) !== after.get(file))
    .sort();
}

// A unix socket path binds into sun_path: 108 bytes on Linux, INCLUDING the
// terminator. libuv does not reject a longer path -- it TRUNCATES it. Measured,
// not assumed: listen() fires its success callback, reports no error, creates
// nothing at the path that was asked for, and leaves a socket at the 108-byte
// truncation. Two roots that share their first 108 bytes then resolve to one
// real socket, and the second bind fails EADDRINUSE against a socket its own
// process created under a name it never requested.
//
// That is exactly how tests/owner-host-start-admission.test.js subtest 8 broke.
// The inherited scratch base here is 49 bytes; the old names
// ('toolsenabled-test-suite-XXXXXX' plus 'NNN-<script basename>') pushed that
// suite's socket path to 158 bytes, so every socket under its per-file root
// truncated to the same name and the subtest's second host collided with its
// first -- taking the forge, transfer and retarget assertions below it with it.
//
// So the runner keeps its own contribution small AND refuses to use a base that
// cannot fit. Windows named pipes are not sun_path bound and keep the inherited
// base unchanged.
const SUITE_ROOT_PREFIX = 'te-';
// mkdtemp appends six characters to the prefix; the per-file root adds '/NNN'.
const RUNNER_PATH_OVERHEAD = 1 + SUITE_ROOT_PREFIX.length + 6 + 1 + 3;
// The leaf shape these suites bind: '/<uuid>.sock'.
const SOCKET_LEAF_RESERVE = 42;
// Below the kernel's 108 so an ordinary leaf rename cannot spend the last byte.
// Asserted by tests/run-isolated-socket-path-budget.test.js.
const SOCKET_PATH_BUDGET = 100;

function scratchBase() {
  const preferred = isolatedTemporaryRoot();
  if (process.platform === 'win32') return preferred;
  const fits = base => typeof base === 'string' && base.length > 0
    && Buffer.byteLength(base, 'utf8') + RUNNER_PATH_OVERHEAD + SOCKET_LEAF_RESERVE < SOCKET_PATH_BUDGET;
  if (fits(preferred)) return preferred;
  for (const candidate of [os.tmpdir(), '/tmp']) {
    if (candidate !== preferred && fits(candidate)) {
      // Announced, never silent: a suite whose scratch moved somewhere else is
      // something the reader of a failure needs to know without reading this.
      process.stderr.write(`run-isolated: ${preferred} is ${Buffer.byteLength(preferred, 'utf8')} bytes, `
        + `too long to keep unix socket paths under ${SOCKET_PATH_BUDGET}; `
        + `using ${candidate} as this run's scratch base instead.\n`);
      return candidate;
    }
  }
  throw new Error('Refusing to run: no temporary base is short enough to keep a socket path under '
    + `${SOCKET_PATH_BUDGET} bytes (tried ${preferred}). A longer path is silently truncated into `
    + 'sun_path, so suites would bind sockets under names they never asked for.');
}

function removeIsolatedDirectory(suiteRoot, target) {
  const root = path.resolve(suiteRoot);
  const resolved = path.resolve(target);
  if (!within(root, resolved)) throw new Error(`Refusing to remove a directory outside this isolated test suite: ${resolved}`);
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      if (!fs.existsSync(resolved)) return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_REMOVE_CODES.has(error?.code)) throw error;
    }
    // Windows antivirus, search indexing, and recently closed child handles
    // can hold sandbox files briefly. The directory is already proven to be
    // a child of this suite root, and this bounded retry never touches source.
    wait(150 * (attempt + 1));
  }
  if (fs.existsSync(resolved)) throw lastError || new Error(`Could not remove isolated test directory: ${resolved}`);
}

async function main(lifecycle) {
let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}

if (!options || !options.scripts.length) {
  if (options) process.stderr.write('Usage: node tests/run-isolated.js [--fail-fast] [--config-integrity] [--summary <path>] [--measure-builtin-assertions <summary>.assertions] [--timeout-ms <n>] [--from <list.txt>] <test.js> [...]\n');
  if (!process.exitCode) process.exitCode = 2;
} else {
  if (lifecycle && JSON.stringify(options.scripts.map(file => path.relative(ROOT, path.resolve(ROOT, file)).split(path.sep).join('/')))
      !== JSON.stringify(lifecycle.node.files)) throw new Error('actual isolated selection differs from strict recipe');
  const startedAt = Date.now();
  const files = [];
  const addFile = entry => {
    if (lifecycle) {
      const node = lifecycle.contract.recipe.nodes.find(item => item.id === `${lifecycle.node.id}/file:${files.length}`);
      lifecycleRecords.record(lifecycle, node, 'end', entry);
    }
    files.push(entry);
  };
  const suiteRoot = fs.mkdtempSync(path.join(scratchBase(), SUITE_ROOT_PREFIX));
  let cleanupUnproven = false;
  try {
    // Load this optional authority only when explicitly requested. Ordinary
    // runs and copied runner fixtures keep their existing dependency closure.
    const assertionRun = options.assertionRoot
      ? require('../tools/lib/builtin-assertion-scope').createBuiltinAssertionRun(ROOT, options.assertionRoot) : null;
    let expectedConfig = options.configIntegrity ? configSnapshot() : null;
    for (let index = 0; index < options.scripts.length; index += 1) {
      const script = options.scripts[index];
      const candidate = path.resolve(ROOT, script);
      // .mjs and .cjs are accepted alongside .js so that ESM self-tests get the
      // same isolated environment as everything else. They were excluded only
      // by omission, and the effect was that the four
      // tools/launch-readiness/*.selftest.mjs suites could not be wired into
      // any chain that goes through this runner -- so they ran nowhere, with
      // no isolation available as the alternative.
      if (!candidate.startsWith(`${ROOT}${path.sep}`) || !RUNNABLE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
        throw new Error(`Refusing to run a test outside the repository: ${script}`);
      }
      const relativeFile = path.relative(ROOT, candidate).split(path.sep).join('/');
      if (lifecycle) {
        const node = lifecycle.contract.recipe.nodes.find(item => item.id === `${lifecycle.node.id}/file:${index}`);
        const identity = lifecycleRecords.fileIdentity(ROOT, script);
        if (node.file !== identity.file || node.sha256 !== identity.sha256) throw new Error('selected test identity drifted before invocation');
        lifecycleRecords.record(lifecycle, node, 'start');
      }
      if (STRICT && OPT_IN_TESTS.some(entry => entry.file === relativeFile)) {
        const reason = 'explicit opt-in test is outside the unattended strict lifecycle';
        process.stderr.write(`UNEXECUTED (strict scope refusal): ${relativeFile} -- ${reason}\n`);
        addFile({ file: relativeFile, status: 'skip', exitCode: null, ms: 0, reason });
        process.exitCode = 1;
        continue;
      }
      const platformGate = WINDOWS_ONLY_SUITES.has(relativeFile)
        ? { platform: 'win32', label: 'Windows', reason: WINDOWS_ONLY_SUITES.get(relativeFile) }
        : LINUX_ONLY_SUITES.has(relativeFile)
          ? { platform: 'linux', label: 'Linux', reason: LINUX_ONLY_SUITES.get(relativeFile) } : null;
      if (platformGate && process.platform !== platformGate.platform) {
        const reason = `requires ${platformGate.label} to run for real (${platformGate.reason})`;
        process.stdout.write(`SKIP (platform gate, NOT counted as a pass): ${relativeFile} -- ${reason}\n`);
        // requiresPlatform carries the gate as a TOKEN, beside the English
        // reason rather than instead of it. A reader of the summary already
        // had the sentence; a program had only the sentence, so the consumer
        // that must tell a declared platform skip apart from a real failure
        // -- tools/check-chain-runner.js -- would otherwise have to match on
        // prose that nothing promises to keep spelled that way.
        addFile({ file: relativeFile, status: 'skip', exitCode: null, ms: 0, reason, requiresPlatform: platformGate.platform });
        if (!process.exitCode) process.exitCode = 1;
        continue;
      }
      const gate = OPT_IN_GATED_SUITES.get(relativeFile);
      if (gate && (gate.command || process.env[gate.envVar] !== '1')) {
        const reason = `requires ${gate.command || `${gate.envVar}=1`} to run for real (${gate.reason})`;
        process.stdout.write(`SKIP (opt-in gate, NOT counted as a pass): ${relativeFile} -- ${reason}\n`);
        addFile({ file: relativeFile, status: 'skip', exitCode: null, ms: 0, reason });
        // An opt-in gate skip is an honest absence of coverage, not a crash --
        // do not abort even an explicit --fail-fast batch over it. Do mark this
        // run's own exit code non-clean so nothing downstream can read a zero
        // exit code here as proof that everything requested actually ran.
        if (!process.exitCode) process.exitCode = 1;
        continue;
      }
      const missingPreconditions = [
        ...missingFixturesFor(relativeFile)
          .map(gate => `needs ${gate.file}, which is not in this checkout -- ${gate.reason}`),
        ...missingStructuredFixturesFor(relativeFile),
        ...missingCodexCliFor(relativeFile)
      ];
      if (missingPreconditions.length) {
        const reason = missingPreconditions.join('; ');
        process.stdout.write(`SKIP (missing precondition, NOT counted as a pass): ${relativeFile} -- ${reason}\n`);
        addFile({ file: relativeFile, status: 'skip', exitCode: null, ms: 0, reason });
        // Same contract as the opt-in gate above: an absent precondition is an
        // honest absence of coverage, so do not abort the batch over it, and
        // do not let this run's exit code read as "everything requested ran".
        if (!process.exitCode) process.exitCode = 1;
        continue;
      }
      const testRoot = path.join(suiteRoot, String(index + 1).padStart(3, '0'));
      // Test bodies retain strict verdict semantics, not receipt-writer scope.
      // A test that exercises this harness must create its own fixture proof.
      const environment = lifecycleRecords.clearAuthority();
      const installedChromium = installedChromiumFor(relativeFile);
      configure(testRoot, environment);
      if (STRICT) deleteEnvNames(environment, ['NODE_TEST_CONTEXT']);
      if (installedChromium) environment.TOOLSENABLED_TEST_PLAYWRIGHT_EXECUTABLE = installedChromium;
      try {
        const fileStartedAt = Date.now();
        // A suite with a measured cost above the shared cap gets its own floor,
        // so the guard stops hangs instead of stopping slow-but-healthy work.
        const suiteTimeoutMs = timeoutForSuite(relativeFile, options.timeoutMs);
        const measured = assertionRun?.prepare(relativeFile, index);
        const result = await runIsolatedChild(process.execPath, measured ? measured.argv.slice(1) : [candidate], {
          cwd: ROOT,
          env: environment,
          ...(STRICT ? { stdio: ['inherit', 'pipe', 'pipe'], ...(measured ? {} : { encoding: 'utf8' }), maxBuffer: 16 * 1024 * 1024 } : { stdio: 'inherit' }),
          windowsHide: true,
          ...(suiteTimeoutMs == null ? {} : { timeout: suiteTimeoutMs })
        });
        cleanupUnproven = result.cleanupConfirmed === false;
        let evidence;
        let evidenceError;
        let measurement;
        if (STRICT) {
          if (result.stdout) process.stdout.write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
          try {
            if (measured) {
              const collected = measured.finish(result);
              measurement = collected.measurement;
              if (collected.evidenceError) throw new Error(collected.evidenceError);
              evidence = collected.evidence;
            } else evidence = validateCompletion(result);
            process.stdout.write(`STRICT EVIDENCE: ${relativeFile} -- ${evidence.kind}`
              + (evidence.counts ? `; ${evidence.counts.pass} passed; ${evidence.unexecuted} UNEXECUTED (within-suite skips)` : '; assertion count not reported') + '\n');
          } catch (error) {
            evidenceError = error.message;
            process.stderr.write(`STRICT INCOMPLETE: ${relativeFile} -- ${evidenceError}\n`);
          }
        }
        const timedOut = result.error?.code === 'ETIMEDOUT';
        const exitCode = timedOut ? 124 : result.error ? 1 : (Number.isInteger(result.status) ? result.status : 1);
        const status = timedOut ? 'timeout' : (exitCode === 0 && !evidenceError ? 'pass' : 'fail');
        const file = script.replaceAll('\\', '/');
        const ms = Date.now() - fileStartedAt;
        const processResult = { ...(measured ? { pid: result.pid } : {}), exitCode: result.status, signal: result.signal || null, error: result.error?.code || null,
          ...(result.custody ? { custody: result.custody } : {}) };
        const configBeforeTest = expectedConfig;
        const observedConfig = options.configIntegrity ? configSnapshot() : null;
        const mutated = options.configIntegrity ? changedConfigPaths(configBeforeTest, observedConfig) : [];
        if (mutated.length) {
          // A shared checkout cannot establish who wrote a changed file, even
          // when that file was clean before this test. Preserve the evidence
          // and stop: subsequent tests would observe a different configuration.
          addFile({ file, status: 'config-mutation', exitCode: 1, ms, process: processResult,
            timeoutMs: suiteTimeoutMs, mutated, configPreserved: true, evidence, evidenceError, measurement });
          process.stderr.write(
            `Config changed while ${file} ran: ${mutated.join(', ')}. `
            + 'Files were preserved; remaining tests cannot use this measurement.\n'
          );
          process.exitCode = 1;
          break;
        }
        expectedConfig = observedConfig;
        // Record the budget this file actually got. A `timeout` status without
        // it cannot be told apart from a hang by anyone reading the summary.
        addFile({ file, status, exitCode, ms, timeoutMs: suiteTimeoutMs, process: processResult, evidence, evidenceError, measurement });
        if (result.error && !timedOut) throw result.error;
        if (status !== 'pass') {
          process.exitCode = exitCode || 1;
          if (options.failFast) break;
        }
      } finally {
        // No following test or scratch deletion may race a surviving scope.
        // The retained supervisor closes before runIsolatedChild resolves.
        if (!cleanupUnproven && !RETAIN_TEST_STATE) removeIsolatedDirectory(suiteRoot, testRoot);
      }
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    try {
      if (cleanupUnproven) process.stderr.write(`Isolated scratch preserved because descendant cleanup is unproven: ${suiteRoot}\n`);
      else if (RETAIN_TEST_STATE) process.stderr.write(`Isolated test state retained by request: ${suiteRoot}\n`);
      else removeIsolatedDirectory(suiteRoot, suiteRoot);
    } finally {
      // Reconciliation lives here, not at each abandonment site, so that an
      // abort path added later cannot reintroduce the silent shrink: every
      // exit from the loop passes through this finally.
      const notRun = appendNotRun(files, options.scripts);
      if (notRun > 0) {
        process.stderr.write(`${notRun} requested test file(s) were never run; recorded as not-run.\n`);
        // A requested file that never ran is an unmet request, whatever else
        // happened. Never let this batch report success.
        if (!process.exitCode) process.exitCode = 1;
      }
      writeSummary(options.summaryPath, startedAt, files);
    }
  }
}
}

async function start() {
let lifecycle;
let lifecycleStarted = false;
try {
  lifecycle = lifecycleRecords.readContext();
  lifecycleRecords.assertInvocation(lifecycle, 'isolated', ['node', 'tests/run-isolated.js', ...process.argv.slice(2)]);
  if (lifecycle) {
    lifecycleRecords.record(lifecycle, lifecycle.node, 'start');
    lifecycleStarted = true;
  }
  await main(lifecycle);
} catch (error) {
  process.stderr.write(`Isolated runner could not complete: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (lifecycleStarted) lifecycleRecords.record(lifecycle, lifecycle.node, 'end', {
    status: !process.exitCode ? 'pass' : 'fail', exitCode: process.exitCode || 0
  });
}
}
void start();
