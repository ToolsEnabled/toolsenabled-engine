const fs = require('node:fs');
const path = require('node:path');
const { ROOT, commandExists, run } = require('../runtime');
const { assertActive } = require('../policy');
const { record } = require('../audit');
const { classify, describeFailure, interactiveSession } = require('../elevation-refusal');
const deployment = require('./deployment');
const extension = require('./extension');
const cws = require('./chrome-web-store');
const firebase = require('./firebase');

// existsSync deliberately turns every filesystem error into `false`. Detection
// uses absence as a definite answer (for example, no package.json means this is
// not a Node project), so an unreadable path must not be allowed to look absent.
function pathExists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

function detect(cwd) {
  const folder = path.resolve(cwd || ROOT);
  if (!pathExists(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`Project directory does not exist: ${folder}`);
  const packageFile = path.join(folder, 'package.json');
  const firebaseFile = path.join(folder, 'firebase.json');
  const manifestFile = path.join(folder, 'manifest.json');
  let packageJson = null;
  if (pathExists(packageFile)) packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const packageManager = pathExists(path.join(folder, 'pnpm-lock.yaml')) ? 'pnpm' : pathExists(path.join(folder, 'yarn.lock')) ? 'yarn' : 'npm';
  const lockFile = packageManager === 'pnpm' ? 'pnpm-lock.yaml' : packageManager === 'yarn' ? 'yarn.lock' : pathExists(path.join(folder, 'package-lock.json')) ? 'package-lock.json' : null;
  return {
    cwd: folder,
    nodeProject: Boolean(packageJson),
    packageManager,
    lockFile,
    buildScript: packageJson && packageJson.scripts && packageJson.scripts.build ? 'build' : null,
    testScript: packageJson && packageJson.scripts && packageJson.scripts.test ? 'test' : null,
    firebase: pathExists(firebaseFile),
    chromeExtension: pathExists(manifestFile)
  };
}

function plan({ cwd = ROOT, projectId, deploy = false, provider = 'auto', chromeWebStore, firebaseProvision }) {
  const project = detect(cwd);
  const deploymentInfo = deployment.detect(project.cwd);
  const steps = [];
  if (project.nodeProject) steps.push({ action: `${project.packageManager}.${project.lockFile ? 'lockedInstall' : 'install'}`, executable: commandExists(project.packageManager) || project.packageManager === 'npm' });
  if (project.buildScript) steps.push({ action: `${project.packageManager}.run.build` });
  if (project.testScript) steps.push({ action: `${project.packageManager}.run.test` });
  if (firebaseProvision && projectId) {
    if (firebaseProvision.enable !== false) steps.push({ action: 'firebase.project.enable', projectId });
    if (firebaseProvision.firestoreLocation) steps.push({ action: 'firebase.firestore.create', projectId, location: firebaseProvision.firestoreLocation });
  }
  const selectedProvider = provider === 'auto' ? deploymentInfo.defaultProvider : provider;
  if (deploy && selectedProvider === 'firebase' && projectId) steps.push({ action: 'firebase.deploy', projectId });
  else if (deploy && ['vercel', 'cloudflare'].includes(selectedProvider)) steps.push({ action: `${selectedProvider}.deploy` });
  else if (deploy && selectedProvider === 'firebase') steps.push({ action: 'firebase.deploy', required: 'projectId' });
  if (project.chromeExtension) {
    steps.push({ action: 'extension.package' });
    if (chromeWebStore && chromeWebStore.publisherId && chromeWebStore.itemId) {
      steps.push({ action: 'chromeWebStore.upload', itemId: chromeWebStore.itemId });
      if (chromeWebStore.publish) steps.push({ action: 'chromeWebStore.publish', itemId: chromeWebStore.itemId });
    }
  }
  if (deploy && !selectedProvider) steps.push({ action: 'deployment.required', note: 'Add Firebase, Vercel, or Cloudflare project configuration.' });
  return { project, deployment: deploymentInfo, selectedProvider, steps };
}

// --- A PROJECT'S OWN SCRIPTS CAN ASK WINDOWS FOR ADMINISTRATOR RIGHTS -------
//
// R1534. `launch.execute` runs the target project's own npm/yarn/pnpm lifecycle
// -- every dependency's preinstall/install/postinstall, then its build and test
// scripts. That is arbitrary third-party code, and some of it (native module
// builds, driver-adjacent packages, anything shelling out to an installer) asks
// Windows for administrator rights.
//
// What that produced before this: under a scheduled task, with no desktop to
// draw an approval box on, Windows refuses the request with "the operation was
// cancelled by the user" and the child exits non-zero -- and this function
// rethrew that sentence verbatim, telling a person they had cancelled a prompt
// they were never shown. Under an interactive session it was worse: the box
// appears, nobody answers it, and spawnSync blocks the single-threaded server
// for fifteen minutes before throwing a nameless ETIMEDOUT.
//
// THIS PRODUCT STILL DOES NOT ELEVATE ANYTHING. It does not retry with
// administrator rights, does not ask Windows for them, and does not suggest
// turning any Windows setting off. It says what happened and leaves the choice
// where R1529 puts it.
function stepFailure(step, result, cwd) {
  const signals = {
    exitCode: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    timedOut: result.timedOut === true,
    interactive: interactiveSession(),
  };
  const cause = new Error(describeFailure(`${step} in ${cwd}`, signals));
  // A known project-script exit needs a repair before another attempt. Publish
  // only our own stage/exit explanation; arbitrary child output stays private.
  // Preserve the existing uncertain timeout and Windows elevation handling.
  if (Number.isInteger(result.status) && result.status !== 0 && !signals.timedOut
    && (process.platform !== 'win32' || classify(signals) === null)) {
    return Object.assign(new Error(`${step} in ${cwd} exited with code ${result.status}. Inspect and fix this project step before retrying launch.execute.`, { cause }), {
      code: 'LAUNCH_STEP_INPUT_REQUIRED'
    });
  }
  return cause;
}

async function execute({ cwd = ROOT, projectId, deploy = false, skipTests = false, provider = 'auto', only = '', chromeWebStore, firebaseProvision }) {
  assertActive('launch.execute');
  const info = detect(cwd);
  if (!info.nodeProject && !info.chromeExtension && !deploy && !firebaseProvision) {
    throw new Error('No actionable Node project, Chrome extension, provisioning, or deployment step was found.');
  }
  const results = [];
  const manager = info.packageManager;
  if (info.nodeProject) {
    const installArgs = manager === 'npm' ? (info.lockFile ? ['ci'] : ['install'])
      : manager === 'pnpm' ? (info.lockFile ? ['install', '--frozen-lockfile'] : ['install'])
      : (info.lockFile ? ['install', '--immutable'] : ['install']);
    const install = run(manager, installArgs, { cwd: info.cwd, timeout: 15 * 60 * 1000 });
    results.push({ step: 'install', ...install });
    if (install.status !== 0 || install.timedOut) throw Object.assign(stepFailure('Installing dependencies', install, info.cwd), { step: 'install', results });
  }
  if (info.buildScript) {
    const build = run(manager, manager === 'npm' ? ['run', 'build'] : ['run', 'build'], { cwd: info.cwd, timeout: 15 * 60 * 1000 });
    results.push({ step: 'build', ...build });
    if (build.status !== 0 || build.timedOut) throw Object.assign(stepFailure('Building the project', build, info.cwd), { step: 'build', results });
  }
  if (info.testScript && !skipTests) {
    const test = run(manager, manager === 'npm' ? ['test'] : ['run', 'test'], { cwd: info.cwd, timeout: 15 * 60 * 1000 });
    results.push({ step: 'test', ...test });
    if (test.status !== 0 || test.timedOut) throw Object.assign(stepFailure('Running the project tests', test, info.cwd), { step: 'test', results });
  }
  if (firebaseProvision) {
    if (!projectId) throw new Error('projectId is required when firebaseProvision is supplied.');
    if (firebaseProvision.enable !== false) results.push({ step: 'firebase.project.enable', ...firebase.projectEnable({ projectId }) });
    if (firebaseProvision.firestoreLocation) {
      results.push({ step: 'firebase.firestore.create', ...firebase.firestoreCreate({
        projectId, location: firebaseProvision.firestoreLocation, database: firebaseProvision.firestoreDatabase || '(default)',
        edition: firebaseProvision.firestoreEdition || 'standard', deleteProtection: firebaseProvision.deleteProtection || 'ENABLED',
        pointInTimeRecovery: firebaseProvision.pointInTimeRecovery || 'DISABLED'
      }) });
    }
  }
  if (deploy) {
    const deployed = deployment.deploy({ cwd: info.cwd, provider, projectId, only });
    results.push({ step: `${deployed.provider || provider}.deploy`, ...deployed });
  }
  let packaged = null;
  if (info.chromeExtension) {
    packaged = extension.packageExtension({ cwd: info.cwd, outputPath: chromeWebStore && chromeWebStore.outputPath || '' });
    results.push({ step: 'extension.package', ...packaged });
  }
  if (packaged && chromeWebStore && chromeWebStore.publisherId && chromeWebStore.itemId) {
    const uploaded = await cws.upload({ publisherId: chromeWebStore.publisherId, itemId: chromeWebStore.itemId, packagePath: packaged.packagePath });
    results.push({ step: 'chromeWebStore.upload', ...uploaded, packagePath: packaged.packagePath });
    if (chromeWebStore.publish) {
      const published = await cws.publish({ publisherId: chromeWebStore.publisherId, itemId: chromeWebStore.itemId, staged: Boolean(chromeWebStore.staged), deployPercentage: chromeWebStore.deployPercentage, skipReview: Boolean(chromeWebStore.skipReview), blockOnWarnings: chromeWebStore.blockOnWarnings !== false });
      results.push({ step: 'chromeWebStore.publish', ...published });
    }
  }
  record('launch.execute', info.cwd, { projectId, provider, deploy, skipTests, firebaseProvision: Boolean(firebaseProvision), chromeWebStore: Boolean(chromeWebStore), steps: results.map(item => item.step) });
  return { project: info, results };
}

module.exports = { detect, plan, execute };
