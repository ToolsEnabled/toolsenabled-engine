#!/usr/bin/env node
'use strict';

// RUN AN END-TO-END DRIVE OF THIS ENGINE INSIDE A LINUX CONTAINER.
//
// WHY THIS EXISTS. tools/lib/tool-surface-runner.js has named four surfaces
// since it was written -- `SURFACES = ['desktop-here', 'docker', 'web',
// 'mobile']` -- and tools/tool-surface-runner.js can only build a real adapter
// for one of them: `adaptersFor` hands back `{'desktop-here': desktopAdapter(...)}`
// and fills the rest only from an `--adapter-config` file that nothing in this
// repository produced. So every `docker` cell in the matrix has been
// NOT MEASURED, not because anyone looked and found nothing, but because
// nothing ever looked. That is precisely the collapse this repository keeps
// paying for: "could not look" printed in the same column as a result.
//
// WHAT IT DOES NOT DO. It does not decide whether Linux is a supported
// surface, and it does not port anything to make a number go up. Where the
// product genuinely does not exist on Linux -- the DPAPI vault, whose
// src/lib/vault-platform.js says `SUPPORTED_VAULT_PLATFORM = 'win32'` -- this
// harness reports the product's own named refusal and moves on. Turning that
// refusal into a pass would be the defect, not the fix.
//
// THE CATALOGUE IS THE DELIVERABLE. `DRIVES` below is the documented list of
// what can and cannot be driven in a container, with a reason on EVERY entry,
// including the ones that can. A reason attached only to the failures is a
// list that stops being maintained the moment something starts working.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');

const ROOT = path.resolve(__dirname, '..');
const IMAGE_CONTEXT = path.join(ROOT, 'docker', 'engine-drive');
const DEFAULT_IMAGE_TAG = 'toolsenabled/engine-drive:v1';
const CONTAINER_LABEL = 'org.toolsenabled.drive=engine-drive-v1';
const WORKER_RELATIVE = 'tools/tool-surface-runner-worker.js';

// Every refusal this tool can make carries a code, because a caller that has to
// regex a sentence to tell "Docker is absent" from "Docker refused" will
// eventually stop telling them apart.
class DriveRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DriveRefusal';
    this.code = code;
    this.retryable = false;
  }
}

function refuse(code, message) {
  return new DriveRefusal(code, message);
}

// ---------------------------------------------------------------------------
// THE CATALOGUE
// ---------------------------------------------------------------------------
//
// `drivable` answers one question only: can this drive produce a result in a
// container that MEANS what the same drive means on the developer's machine?
// A drive that runs to completion but measures the container instead of the
// product is not drivable, and says so.
//
// `reason` is mandatory on every entry and is the sentence a person reads when
// they ask why a cell is empty. Where the reason is a fact in this repository,
// it names the file and quotes the symbol, never a line number -- line numbers
// address different code on a different branch.
const DRIVES = Object.freeze([
  Object.freeze({
    id: 'test-battery',
    summary: 'Every census candidate, through the isolated runner, recorded as one ledger.',
    drivable: true,
    reason: 'tools/test-run.js drives tests/run-isolated.js, and both are plain Node with no host service. '
      + 'The suites that genuinely need Windows are already named skips, not failures: tests/run-isolated.js '
      + 'carries "WINDOWS_ONLY_SUITES" and emits "requires Windows to run for real", so a Linux run reports '
      + 'absent coverage as absent instead of scoring it.',
    command: ['node', 'tools/test-run.js', '--all', '--output', '/evidence'],
    evidence: 'latest.json'
  }),
  Object.freeze({
    id: 'root-suite',
    summary: 'The root suite file list only -- the short drive, for checking the harness itself.',
    drivable: true,
    reason: 'tests/suites/root-suite.txt is a plain repository-relative file list read by "--from", so it needs '
      + 'nothing the container lacks. It exists as a separate drive because a harness change should be provable '
      + 'without spending a full battery.',
    command: ['node', 'tests/run-isolated.js', '--continue', '--from', 'tests/suites/root-suite.txt',
      '--summary', '/evidence/root-suite.json'],
    evidence: 'root-suite.json'
  }),
  Object.freeze({
    id: 'tool-surface',
    summary: 'Every registered tool invoked on the docker surface, filling the matrix column that has never been measured.',
    drivable: true,
    reason: 'src/lib/tool-registry.js resolves and executes in-process, so a container can host the same worker '
      + 'the desktop surface uses -- tools/tool-surface-runner-worker.js. Tools whose backing capability is absent '
      + 'on Linux still answer: they return the product\'s own named refusal, which the matrix scores as VERIFIED '
      + 'because a named refusal is correct behaviour, not missing behaviour.',
    kind: 'surface',
    evidence: 'tool-surface.json'
  }),

  // --- Not drivable here. Each reason is a fact read out of this checkout. ---
  Object.freeze({
    id: 'vault',
    summary: 'The DPAPI secret vault and every audit path that needs its signing material.',
    drivable: false,
    reason: 'The product genuinely does not exist on Linux. src/lib/vault-platform.js sets '
      + '"SUPPORTED_VAULT_PLATFORM = \'win32\'" and "assertVaultPlatform" throws '
      + '"SECRET_VAULT_PLATFORM_UNSUPPORTED" on any other platform. This is an owner decision (port the vault, or '
      + 'declare Linux a partial surface), not a harness gap -- a container cannot fix it and must not paper over it.'
  }),
  Object.freeze({
    id: 'bridge-action-smoke',
    summary: 'Live mission-bridge proof to bootstrap to bearer to one action.',
    drivable: false,
    reason: 'It reads host state a container has no way to hold. tools/bridge-action-smoke.js reads '
      + '"state/mission-bridge-bootstrap-proof.json" and, when it is absent, says '
      + '"no bootstrap proof file; is the bridge running from this checkout?". The proof is published by a bridge '
      + 'running on the host and is owner-ACL\'d; inventing one would fabricate an authorization.'
  }),
  Object.freeze({
    id: 'link-bus-smoke',
    summary: 'Authenticated chat-only link-bus read.',
    drivable: false,
    reason: 'Its bearer comes from the Windows vault. tools/link-bus-smoke-test.js obtains the token through '
      + '"getSecret(\'custom.link_bus_bridge_token\')" and throws "LINK_BUS_TOKEN_UNAVAILABLE" without it, so on '
      + 'Linux it cannot get past authentication for the same reason the vault drive cannot run at all.'
  }),
  Object.freeze({
    id: 'remote-bridge-smoke',
    summary: 'Peer-allowlist refusal at the bridge connection gate.',
    drivable: false,
    reason: 'It needs this machine to have an identity in the registry. tools/remote-bridge-smoke-test.js resolves '
      + 'the local listener address through "resolveService" and the peer through "peerMachineForAddress", both '
      + 'from "config/service-registry.json". A container is not a registered machine, and adding one would invent '
      + 'a machine record a person must own.'
  }),
  Object.freeze({
    id: 'cold-start',
    summary: 'The startup latency a customer actually waits for.',
    drivable: false,
    reason: 'It runs to completion and the number is meaningless here. tools/cold-start-check.js compares the '
      + 'slowest of several attempts against "CEILING_MS", a ceiling its own comment ties to a measured machine. '
      + 'A container on a different kernel, filesystem and CPU allocation produces a different number that is not '
      + 'the customer\'s, so a pass or a fail here would both be false. Measure it on the target surface.'
  }),
  Object.freeze({
    id: 'idle-cpu',
    summary: 'Idle CPU drain of the always-present MCP server process.',
    drivable: false,
    reason: 'Same class as cold-start: tools/idle-cpu-check.js is a resource-ceiling measurement, and a container '
      + 'shares and throttles CPU differently from the host it is measuring for. The drive would report the '
      + 'container\'s envelope while appearing to report the product\'s.'
  }),
  Object.freeze({
    id: 'browser-surface',
    summary: 'Anything that must drive a real browser.',
    drivable: false,
    reason: 'This image deliberately has no browsers. docker/engine-drive/Dockerfile installs with '
      + '"--ignore-scripts", which skips the Playwright browser download, and says so. Browser drives belong to '
      + 'the separate pinned Playwright image under docker/agent-sandbox/, not to this bench.'
  }),
  Object.freeze({
    id: 'windows-host-surfaces',
    summary: 'UAC elevation, Scheduled Tasks, ACLs, desktop and window control, named pipes.',
    drivable: false,
    reason: 'These assert Windows kernel and shell semantics that Linux does not have equivalents for. '
      + 'tests/run-isolated.js already classifies them by name in "WINDOWS_ONLY_SUITES" with the reason '
      + '"exercises Windows PowerShell, ACL, Scheduled Task, desktop, or service-control behavior with no '
      + 'cross-platform fixture", so a container drive records them as named skips rather than pretending.'
  })
]);

function driveById(id) {
  return DRIVES.find(drive => drive.id === id) || null;
}

// ---------------------------------------------------------------------------
// Docker preconditions
// ---------------------------------------------------------------------------

function dockerSync(args, options = {}) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    /* AFTER the spread deliberately. A caller may supply its own env and it
       must still be scrubbed; placed before the spread, a caller could hand
       docker the full ambient environment by simply passing one. */
    env: safeLaunchEnvironment(options.env || process.env, { context: 'docker drive' })
  });
}

// Answers three DIFFERENT questions separately, because collapsing them is how
// a report ends up saying "Docker failed" when Docker was never installed.
//   - is there a `docker` client at all?
//   - did the daemon answer?
//   - is the daemon serving LINUX containers?
// A Windows-container daemon is not a broken daemon; it is a daemon that cannot
// run this image, and the caller needs to be told which one it is.
function doctor() {
  const probe = dockerSync(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}|{{.Server.Version}}']);
  if (probe.error && probe.error.code === 'ENOENT') {
    throw refuse('DRIVE_DOCKER_CLIENT_ABSENT',
      'No `docker` client is on PATH. Whether a daemon is running is unknown from here.');
  }
  if (probe.status !== 0) {
    const detail = (probe.stderr || '').trim().split('\n').pop() || 'no stderr';
    throw refuse('DRIVE_DOCKER_DAEMON_UNREACHABLE',
      `The docker client is present but the daemon did not answer: ${detail}`);
  }
  const [platform, version] = String(probe.stdout).trim().split('|');
  const [serverOs, serverArch] = String(platform).split('/');
  if (serverOs !== 'linux') {
    throw refuse('DRIVE_DOCKER_NOT_LINUX',
      `The daemon is serving ${serverOs} containers. This image is a Linux image; switching engines is a `
      + 'decision for whoever owns this machine, not something a drive should do.');
  }
  return { serverOs, serverArch, version };
}

function imageTag() {
  return process.env.TOOLSENABLED_DRIVE_IMAGE || DEFAULT_IMAGE_TAG;
}

function imageId(tag) {
  const probe = dockerSync(['image', 'inspect', tag, '--format', '{{.Id}}']);
  return probe.status === 0 ? String(probe.stdout).trim() : null;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
//
// The build context is assembled in a temporary directory holding exactly four
// files rather than pointing docker at the repository root. Pointing it at the
// root would ship ~65MB of source and git history to the daemon on every build
// -- and, worse, would make the image's cache key depend on every uncommitted
// edit in a tree nine lanes are writing to, so two builds minutes apart would
// differ for reasons that have nothing to do with the image.
function build({ noCache = false } = {}) {
  const environment = doctor();
  const tag = imageTag();
  const contextDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-drive-context-'));
  try {
    for (const file of ['package.json', 'package-lock.json']) {
      const source = path.join(ROOT, file);
      if (!fs.existsSync(source)) {
        throw refuse('DRIVE_BUILD_INPUT_ABSENT', `The image needs ${file} and this checkout does not have it.`);
      }
      fs.copyFileSync(source, path.join(contextDirectory, file));
    }
    for (const file of ['Dockerfile', 'drive-entrypoint.sh']) {
      const source = path.join(IMAGE_CONTEXT, file);
      if (!fs.existsSync(source)) {
        throw refuse('DRIVE_BUILD_INPUT_ABSENT', `The image definition is incomplete: ${file} is absent from docker/engine-drive/.`);
      }
      // Written with an explicit LF newline. A CRLF shebang line makes Linux
      // report "no such file or directory" for the interpreter, which reads
      // like a missing shell rather than a line ending.
      const contents = fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
      fs.writeFileSync(path.join(contextDirectory, file), contents);
    }
    const args = ['build', '--tag', tag, ...(noCache ? ['--no-cache'] : []), contextDirectory];
    const result = spawnSync('docker', args, {
    stdio: 'inherit',
    windowsHide: true,
    env: safeLaunchEnvironment(process.env, { context: 'docker build' })
  });
    if (result.status !== 0) {
      throw refuse('DRIVE_BUILD_FAILED', `docker build exited ${result.status}.`);
    }
  } finally {
    fs.rmSync(contextDirectory, { recursive: true, force: true });
  }
  return { tag, imageId: imageId(tag), environment };
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

function evidenceRoot() {
  return process.env.TOOLSENABLED_DRIVE_EVIDENCE_DIR
    ? path.resolve(process.env.TOOLSENABLED_DRIVE_EVIDENCE_DIR)
    : path.join(ROOT, 'state', 'drive-evidence');
}

// The mount strategy, in one place so it cannot drift between drives:
//   /src       the checkout, READ-ONLY. The container physically cannot write
//              into the tree other lanes are editing.
//   /evidence  a host directory the drive writes its ledger to, READ-WRITE and
//              deliberately OUTSIDE the source tree, so collecting a result
//              never dirties the checkout either.
function mountArguments(evidenceDirectory) {
  return [
    '--mount', `type=bind,source=${ROOT},target=/src,readonly`,
    '--mount', `type=bind,source=${evidenceDirectory},target=/evidence`
  ];
}

function startContainer({ tag, evidenceDirectory, name }) {
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const result = dockerSync([
    'run', '--detach',
    '--name', name,
    '--label', CONTAINER_LABEL,
    ...mountArguments(evidenceDirectory),
    tag,
    'sleep', 'infinity'
  ]);
  if (result.status !== 0) {
    throw refuse('DRIVE_CONTAINER_START_FAILED',
      `Could not start the drive container: ${(result.stderr || '').trim() || 'no stderr'}`);
  }
  // The entrypoint populates /repo before `sleep` is reached, but `run
  // --detach` returns as soon as the container is created, so the copy may
  // still be in flight. Waiting on the marker the entrypoint writes is a fact;
  // waiting a fixed number of seconds would be a guess that fails on a slow
  // disk and passes on a fast one.
  waitForPopulation(name);
  return String(result.stdout).trim();
}

// A blocking sleep, because the poll loop around it is synchronous: every
// probe is a spawnSync. Atomics.wait on a throwaway buffer blocks this thread
// without burning it, which a spin loop would.
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForPopulation(name, attempts = 600) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = dockerSync(['exec', name, 'test', '-e', '/repo/.drive-populated']);
    if (probe.status === 0) return true;
    const alive = dockerSync(['inspect', name, '--format', '{{.State.Running}}']);
    if (String(alive.stdout).trim() !== 'true') {
      const logs = dockerSync(['logs', '--tail', '20', name]);
      throw refuse('DRIVE_CONTAINER_EXITED_EARLY',
        `The drive container stopped before its source tree was populated: ${(logs.stderr || logs.stdout || '').trim() || 'no output'}`);
    }
    sleepSync(250);
  }
  throw refuse('DRIVE_CONTAINER_POPULATE_TIMEOUT',
    'The drive container never reported a populated source tree. This is a harness timeout, not a product result.');
}

function removeContainer(name) {
  dockerSync(['rm', '--force', name]);
}

function containerName(suffix) {
  return `engine-drive-${suffix}`;
}

// ---------------------------------------------------------------------------
// The docker surface adapter
// ---------------------------------------------------------------------------
//
// PROTOCOL, as tools/tool-surface-runner.js's `commandAdapter` defines it: one
// JSON request arrives on stdin, one JSON object leaves on stdout, and the
// object must carry `ok: true`. `spawnJson` treats a non-zero exit as
// RUNNER_ADAPTER_FAILED and anything unparseable as
// RUNNER_ADAPTER_PROTOCOL_INVALID -- both land in the matrix as NOT MEASURED
// with `origin: 'runner'`, which is the honest place for a harness problem.
//
// WHY IT EXECS INTO A LIVE CONTAINER INSTEAD OF STARTING ONE. The runner
// spawns the adapter once PER OPERATION, and the registry currently holds
// hundreds of tools. Starting a container per tool would spend minutes
// creating containers and copying the tree, per drive. The container is
// started once by `--drive tool-surface`, and each adapter call is a
// `docker exec` into it.
async function runAdapter() {
  const name = process.env.TOOLSENABLED_DRIVE_CONTAINER_NAME;
  if (!name) {
    process.stderr.write('DRIVE_ADAPTER_NO_CONTAINER: TOOLSENABLED_DRIVE_CONTAINER_NAME is not set, so this adapter '
      + 'does not know which drive container to speak to. It is set by `docker-drive.js --drive tool-surface`.\n');
    process.exitCode = 1;
    return;
  }
  const request = JSON.parse(await readAllStdin());

  if (request.operation === 'exercise-reversible') {
    // A NAMED refusal, not a silent absence. This adapter has no
    // write/assert/restore/re-read/assert lifecycle, and the container-side
    // worker does not implement one either -- tools/tool-surface-runner-worker.js
    // accepts only "discover" and "invoke" and otherwise throws "Worker request
    // operation is invalid." Letting that stack trace be the reason would tell
    // a reader the product broke. It did not; this harness has not been built
    // that far.
    process.stderr.write('DRIVE_ADAPTER_NO_REVERSIBLE_LIFECYCLE: the docker drive adapter does not implement the '
      + 'write/assert/restore/re-read/assert lifecycle, so restoration cannot be asserted on this surface. '
      + 'This is missing harness coverage, not a product result.\n');
    process.exitCode = 1;
    return;
  }

  // Parity with the desktop surface. tools/tool-surface-runner.js's
  // `desktopAdapter` resolves an unattended permission ceiling and puts it in
  // every invoke; `commandAdapter` does not, so without this the docker column
  // would be running each tool under a DIFFERENT permission posture than the
  // column it is compared against, and any difference in the matrix would be
  // unattributable.
  const payload = { ...request };
  if (request.operation === 'invoke' && !payload.permissionSession) {
    const dispatchPermissionSession = require('../src/lib/dispatch-permission-session');
    payload.permissionSession = dispatchPermissionSession.unattendedSession();
  }

  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const result = dockerSync(['exec', '--workdir', '/repo', name, 'node', WORKER_RELATIVE, encoded]);
  if (result.status !== 0) {
    process.stderr.write(`DRIVE_ADAPTER_EXEC_FAILED: worker exited ${result.status} in container ${name}: `
      + `${(result.stderr || '').trim().slice(0, 400) || 'no stderr'}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(String(result.stdout).trim());
  process.stdout.write('\n');
}

function readAllStdin() {
  return new Promise((resolve, reject) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buffer += chunk; });
    process.stdin.on('end', () => resolve(buffer));
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------

function runCommandDrive(drive, { tag, evidenceDirectory, name }) {
  // startContainer is INSIDE the try. It creates the container and then waits
  // for the entrypoint to finish populating /repo, and that wait can refuse --
  // DRIVE_CONTAINER_EXITED_EARLY, DRIVE_CONTAINER_POPULATE_TIMEOUT. Started
  // outside, those two paths would leave a container running with a read-only
  // bind on the checkout and nothing left holding its name.
  try {
    startContainer({ tag, evidenceDirectory, name });
    const result = spawnSync('docker', ['exec', '--workdir', '/repo', name, ...drive.command], {
      stdio: 'inherit',
      windowsHide: true,
      env: safeLaunchEnvironment(process.env, { context: 'docker exec' })
    });
    return { exitCode: result.status };
  } finally {
    removeContainer(name);
  }
}

// The tool-surface drive is the one that fills the matrix column. It runs the
// HOST copy of tools/tool-surface-runner.js -- the runner is the measuring
// instrument and stays on one side of the boundary -- and points its `docker`
// adapter at a container. The desktop surface is measured in the same run so
// the two columns come from one instrument at one moment; comparing a fresh
// docker column against a desktop column measured hours ago on a different
// tree is the mistake this arrangement exists to prevent.
function runSurfaceDrive(drive, { tag, evidenceDirectory, name, surfaces }) {
  const adapterConfigPath = path.join(evidenceDirectory, 'docker-adapter.json');
  // Inside the try for the same reason as runCommandDrive: a container that
  // fails to populate must still be removed.
  try {
    startContainer({ tag, evidenceDirectory, name });
    const dispatchPermissionSession = require('../src/lib/dispatch-permission-session');
    fs.writeFileSync(adapterConfigPath, `${JSON.stringify({
      surfaces: {
        docker: {
          command: [process.execPath, path.join(__dirname, 'docker-drive.js'), '--adapter'],
          cwd: ROOT,
          env: { TOOLSENABLED_DRIVE_CONTAINER_NAME: name },
          permissionCeiling: {
            state: 'STATED',
            source: 'tools/docker-drive.js#runAdapter() mirrors desktopAdapter\'s unattended ceiling',
            maximum: dispatchPermissionSession.UNATTENDED_CEILING,
            resolved: dispatchPermissionSession.unattendedSession()
          }
        }
      }
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'tool-surface-runner.js'),
      '--surfaces', surfaces.join(','),
      '--adapter-config', adapterConfigPath,
      '--output', path.join(evidenceDirectory, drive.evidence),
      '--markdown', path.join(evidenceDirectory, 'tool-surface.md')
    ], {
    stdio: 'inherit',
    cwd: ROOT,
    windowsHide: true,
    env: safeLaunchEnvironment(process.env, { context: 'tool surface runner' })
  });
    return { exitCode: result.status };
  } finally {
    removeContainer(name);
  }
}

function runDrive(id, { surfaces }) {
  const drive = driveById(id);
  if (!drive) {
    throw refuse('DRIVE_UNKNOWN', `No drive is catalogued as '${id}'. Known drives: ${DRIVES.map(entry => entry.id).join(', ')}.`);
  }
  if (!drive.drivable) {
    // Refusing by name, with the catalogued reason, is the whole point. A
    // harness that quietly ran this anyway would produce a number, and the
    // number would be wrong in a way nobody could see.
    throw refuse('DRIVE_NOT_DRIVABLE_IN_CONTAINER', `'${id}' is catalogued as not drivable in a container. ${drive.reason}`);
  }
  const environment = doctor();
  const tag = imageTag();
  if (!imageId(tag)) {
    throw refuse('DRIVE_IMAGE_ABSENT', `The image ${tag} is not built. Run: node tools/docker-drive.js --build`);
  }
  const evidenceDirectory = path.join(evidenceRoot(), id);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const name = containerName(`${id}-${process.pid}`);
  const startedAt = Date.now();
  const outcome = drive.kind === 'surface'
    ? runSurfaceDrive(drive, { tag, evidenceDirectory, name, surfaces })
    : runCommandDrive(drive, { tag, evidenceDirectory, name });
  return {
    drive: drive.id,
    image: tag,
    imageId: imageId(tag),
    server: environment,
    evidenceDirectory,
    evidenceFile: path.join(evidenceDirectory, drive.evidence),
    wallClockMs: Date.now() - startedAt,
    exitCode: outcome.exitCode
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printCatalogue() {
  const drivable = DRIVES.filter(drive => drive.drivable);
  const blocked = DRIVES.filter(drive => !drive.drivable);
  process.stdout.write(`CAN be driven in a container (${drivable.length}):\n\n`);
  for (const drive of drivable) {
    process.stdout.write(`  ${drive.id}\n    ${drive.summary}\n    why: ${drive.reason}\n\n`);
  }
  process.stdout.write(`CANNOT be driven in a container (${blocked.length}):\n\n`);
  for (const drive of blocked) {
    process.stdout.write(`  ${drive.id}\n    ${drive.summary}\n    why not: ${drive.reason}\n\n`);
  }
}

function usage() {
  return [
    'Usage: node tools/docker-drive.js <command>',
    '',
    '  --list                     Print the catalogue of what can and cannot be driven, with reasons.',
    '  --doctor                   Report the Docker preconditions, or refuse by name.',
    '  --build [--no-cache]       Build the drive image.',
    '  --drive <id>               Run a catalogued drive in a container.',
    '  --surfaces a,b             Surfaces for the tool-surface drive (default: desktop-here,docker).',
    '  --adapter                  Act as the docker surface adapter (stdin/stdout JSON; used by --drive).',
    ''
  ].join('\n');
}

async function main(argv) {
  const options = { command: null, driveId: null, noCache: false, surfaces: ['desktop-here', 'docker'] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--list' || token === '--doctor' || token === '--build' || token === '--adapter') {
      if (options.command) throw refuse('DRIVE_ARGUMENT_INVALID', 'Only one command may be given.');
      options.command = token.slice(2);
    } else if (token === '--drive') {
      if (options.command) throw refuse('DRIVE_ARGUMENT_INVALID', 'Only one command may be given.');
      options.command = 'drive';
      options.driveId = argv[index + 1];
      index += 1;
      if (!options.driveId) throw refuse('DRIVE_ARGUMENT_INVALID', '--drive requires a drive id.');
    } else if (token === '--surfaces') {
      const value = argv[index + 1];
      index += 1;
      if (!value) throw refuse('DRIVE_ARGUMENT_INVALID', '--surfaces requires a comma-separated list.');
      options.surfaces = value.split(',').map(entry => entry.trim()).filter(Boolean);
    } else if (token === '--no-cache') {
      options.noCache = true;
    } else {
      throw refuse('DRIVE_ARGUMENT_INVALID', `Unknown option: ${token}`);
    }
  }

  if (!options.command) {
    process.stdout.write(usage());
    return;
  }
  if (options.command === 'list') {
    printCatalogue();
    return;
  }
  if (options.command === 'adapter') {
    await runAdapter();
    return;
  }
  if (options.command === 'doctor') {
    const environment = doctor();
    const tag = imageTag();
    const id = imageId(tag);
    process.stdout.write(`${JSON.stringify({
      server: environment,
      image: tag,
      imageId: id,
      imageBuilt: Boolean(id),
      evidenceRoot: evidenceRoot()
    }, null, 2)}\n`);
    return;
  }
  if (options.command === 'build') {
    const built = build({ noCache: options.noCache });
    process.stdout.write(`${JSON.stringify(built, null, 2)}\n`);
    return;
  }
  if (options.command === 'drive') {
    const outcome = runDrive(options.driveId, { surfaces: options.surfaces });
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    process.exitCode = outcome.exitCode === 0 ? 0 : 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    if (error instanceof DriveRefusal) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { DRIVES, driveById, DriveRefusal, doctor, runDrive, mountArguments, evidenceRoot };
