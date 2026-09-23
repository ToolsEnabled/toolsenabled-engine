#!/usr/bin/env node
'use strict';

// FIRST-RUN SETUP -- task T12 of docs/design/INSTALLER-EXPERIENCE.md section 7.
//
// THE PROBLEM THIS EXISTS TO REMOVE, in the owner's words about the machine that
// will test this product: "If they have any issues connecting to your system or
// logging in or creating a secure user account or setting up anything then you
// are failing until they do."
//
// Before this file, setting this product up on a computer that was not the
// owner's meant hand-editing `.mcp.json` to correct five hardcoded absolute paths
// to a Node runtime at `C:\agent-apps\node-v22.19.0\node.exe` and three more to a
// checkout at `C:\Users\owner\...`. There was no command to run. There was no
// question to answer. There was a JSON file and the expectation that a stranger
// would guess what to put in it.
//
//   node tools/mcsetup.js            what state is this computer in, and what next
//   node tools/mcsetup.js run        answer three questions, end up working
//   node tools/mcsetup.js plan --json  everything it would do, before it does it
//   node tools/mcsetup.js verify     is the configuration on this computer real
//   node tools/mcsetup.js pair       add a second computer
//
// WHAT THIS DOES NOT DO, said here so nobody reads more into it. It does not
// enforce the permission tier it records: confining a Guided agent is task T5 in
// `src/lib/mission-bridge/actions.js` and is not built. A tier chosen here is
// honestly recorded and honestly reported, and `verify` says so out loud rather
// than letting a recorded tier be mistaken for an enforced one. It also does not
// download the agent command line (T-acquire) or supervise the bridge (T11).
//
// EVERY REFUSAL SAYS WHY, AND WHAT TO DO. Section 5 of the design is a list of
// failures with exact wording, and the reason it is a section rather than an
// afterthought is that setup failures land on the least experienced user of the
// product. A stack trace here is a defect.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const REPO_ROOT = path.resolve(__dirname, '..');

const machineRecord = require('../src/lib/setup/machine-record');
const setupPlan = require('../src/lib/setup/plan');
const setupProbe = require('../src/lib/setup/probe');
const workspaceModule = require('../src/lib/setup/workspace');
const providerAuth = require('../src/lib/setup/provider-auth');
const pairing = require('../src/lib/setup/pairing');
const peerEnroll = require('./peer-enroll');

const { SetupRefusal, TIERS } = machineRecord;

function out(line = '') { process.stdout.write(`${line}\n`); }
function errorOut(line) { process.stderr.write(`${line}\n`); }

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; index += 1; }
    } else args._.push(token);
  }
  return args;
}

// The tier question of section 2.1, in the order it is presented, with the first
// preselected so the least confident reader can proceed by not deciding.
const TIER_CHOICES = Object.freeze([
  { tier: 'guided', label: "I'm new to this", note: 'Recommended', detail: 'The assistant starts in one folder you pick. Setup requests read-only work; files elsewhere on this computer may still be readable.' },
  { tier: 'standard', label: "I've used AI coding tools before", note: '', detail: 'The assistant starts in the projects you add. Setup requests a restricted write policy; files elsewhere on this computer may still be readable.' },
  { tier: 'unrestricted', label: 'I run agents with permissions bypassed', note: '', detail: 'The assistant can read, change, and delete any file on this computer and run any program, without asking.' }
]);

// The same requested-policy/read-access distinction shown in desktop setup.
// A successful write restriction does not prove that outside reads are blocked.
const TIER_LIMIT_NOTICE = Object.freeze([
  "  This level selects the available ToolsEnabled tools and the requested",
  "  write policy. Setup writes that configuration for you. For Codex, Guided",
  "  requests read-only work; Standard can request writes within your projects",
  "  and the program's temporary folders. Your choice of tools and roles can",
  "  narrow this further. These modes can still read files elsewhere. Check",
  "  the running session's reported permissions before relying on a write",
  "  restriction.",
  "",
  "  An assistant started or resumed here receives this level's requested",
  "  permissions from that point. It does not undo what the session already",
  "  did somewhere else. If you only watch a session that keeps running in",
  "  another program, that program is still deciding what it may do. Choosing",
  "  a level here does not reach that process."
]);

const TIER_LIMIT_LEAD_BEFORE = '  Before you choose, one thing this program will not pretend about.';
const TIER_LIMIT_LEAD_AFTER = '  One thing this program will not pretend about, now that this is written.';

function outTierLimitNotice(lead) {
  out('');
  out(lead);
  out('');
  for (const line of TIER_LIMIT_NOTICE) out(line);
}

function servicesRootFor(args) {
  if (typeof args['services-root'] === 'string') return path.resolve(args['services-root']);
  return machineRecord.resolveServicesRoot({});
}

function installRootFor(args) {
  if (typeof args['install-root'] === 'string') return path.resolve(args['install-root']);
  return REPO_ROOT;
}

// --- questions --------------------------------------------------------------

function interactive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function ask(question, { fallback = '' } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = String(answer).trim();
      resolve(trimmed === '' ? fallback : trimmed);
    });
  });
}

async function askTier() {
  out('');
  out('  How much should the assistant be allowed to do?');
  out('');
  out('  This is the only thing you need to decide right now. You can change it later.');
  out('');
  for (const [index, choice] of TIER_CHOICES.entries()) {
    const marker = index === 0 ? '(*)' : '( )';
    out(`  ${index + 1}. ${marker} ${choice.label}${choice.note ? `  -- ${choice.note}` : ''}`);
    out(`         ${choice.detail}`);
  }
  outTierLimitNotice(TIER_LIMIT_LEAD_BEFORE);
  out('');
  const answer = await ask('  Choose 1, 2 or 3 [1]: ', { fallback: '1' });
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= TIER_CHOICES.length) {
    out('  That was not one of the choices, so the recommended one is used.');
    return TIER_CHOICES[0].tier;
  }
  return TIER_CHOICES[index].tier;
}

async function askWorkspace(tier, installRoot) {
  const suggested = workspaceModule.defaultWorkspacePath({});
  out('');
  out('  Where should your assistant work?');
  out('');
  out(`  Suggested: ${suggested}`);
  out('  It will be created for you. Nothing outside it is touched.');
  out('');
  const answer = await ask('  Press Enter to use that folder, or type another path: ', { fallback: suggested });
  const verdict = workspaceModule.checkWorkspaceCandidate(answer, { installRoot, tier });
  if (!verdict.ok) {
    out(`  ${verdict.message}`);
    return askWorkspace(tier, installRoot);
  }
  return verdict.resolved;
}

async function askSignIn(tier) {
  const options = providerAuth.providerOptionsForTier(tier, {});
  out('');
  out('  Signing in');
  out('');
  if (options.anySignedIn) {
    out('  You are already signed in on this computer. Nothing to do here.');
    return { signedIn: true, skipped: false };
  }
  for (const provider of options.providers) {
    out(`  ${provider.provider}: ${provider.installed ? provider.detail : provider.detail}`);
  }
  out('');
  out('  This program cannot create an account for you -- that part is between you and');
  out('  the company whose assistant you use. It can start the sign-in for you.');
  out('');
  const answer = await ask('  Start signing in now? [Y/n]: ', { fallback: 'y' });
  if (/^n/i.test(answer)) {
    out('  Skipped. Setup will finish, and you can sign in later; nothing else has to be redone.');
    return { signedIn: false, skipped: true };
  }
  const started = providerAuth.startCodexDeviceLogin({});
  if (!started.started) {
    out(`  ${started.message}`);
    if (started.signupUrl) out(`  When you are ready: ${started.signupUrl}`);
    return { signedIn: false, skipped: true, reason: started.code };
  }
  out('');
  out(`  Go to: ${started.verificationUrl || 'the page shown by the assistant program'}`);
  out(`  Enter this code: ${started.userCode}`);
  out('');
  await ask('  Press Enter once that page says you are signed in. ', { fallback: '' });
  const verified = providerAuth.verifyCodexSignIn({});
  if (verified.signedIn) {
    out('  Signed in.');
    return { signedIn: true, skipped: false };
  }
  out('  That has not gone through yet. Setup will finish anyway, and you can sign in later.');
  return { signedIn: false, skipped: true, reason: verified.reason };
}

// --- the work ---------------------------------------------------------------

async function buildPlanFor(args, { tier, workspace }) {
  const installRoot = installRootFor(args);
  const servicesRoot = servicesRootFor(args);
  const facts = await setupProbe.probeMachine({ servicesRoot });
  const nodePath = machineRecord.resolveNodePath({ override: typeof args.node === 'string' ? args.node : null });
  return setupPlan.plan({
    tier,
    facts,
    installRoot,
    servicesRoot,
    nodePath,
    workspaceRoots: [workspace],
    pairComputer: args.pair === true,
    tierSource: typeof args.tier === 'string' ? 'you gave it on the command line' : 'you chose it when setup asked'
  });
}

function resolveTier(args) {
  if (typeof args.tier === 'string') {
    if (!TIERS.includes(args.tier)) {
      throw new SetupRefusal('SETUP_TIER_UNKNOWN', `"${args.tier}" is not one of: ${TIERS.join(', ')}.`, { tier: args.tier });
    }
    return args.tier;
  }
  return null;
}

function resolveWorkspaceArgument(args, tier, installRoot) {
  const candidate = typeof args.workspace === 'string'
    ? args.workspace
    : workspaceModule.defaultWorkspacePath({});
  return workspaceModule.assertWorkspaceAllowed(candidate, { installRoot, tier });
}

function applyPlan(plan, { tier, workspace, installRoot, nodePath, dryRun = false }) {
  const applied = [];
  if (dryRun) {
    return { applied, dryRun: true };
  }
  const provisioned = workspaceModule.provisionWorkspace(workspace, { installRoot, tier });
  applied.push({ id: 'workspace', workspace: provisioned.workspace, created: provisioned.created, undoAvailable: provisioned.undoAvailable });

  const record = machineRecord.buildMachineRecord({
    tier,
    installRoot,
    servicesRoot: plan.servicesRoot,
    nodePath,
    workspaceRoots: [workspace]
  });
  const recordFile = machineRecord.writeMachineRecord(record, { servicesRoot: plan.servicesRoot });
  applied.push({ id: 'machine-record', file: recordFile });

  const generated = machineRecord.writeMcpConfig(record, { targetDirectory: workspace });
  applied.push({
    id: 'mcp-config',
    file: generated.file,
    servers: Object.keys(generated.document.mcpServers),
    skipped: generated.skipped
  });
  return { applied, record, dryRun: false };
}

// --- commands ---------------------------------------------------------------

function commandStatus(args) {
  const servicesRoot = servicesRootFor(args);
  const installRoot = installRootFor(args);
  let record = null;
  try {
    record = machineRecord.readMachineRecord({ servicesRoot });
  } catch (error) {
    errorOut(error.message);
    errorOut('Run "node tools/mcsetup.js run" to set this computer up again from the beginning.');
    return 1;
  }
  if (record === null) {
    out('This computer has not been set up yet.');
    out('');
    out('  Run:  node tools/mcsetup.js run');
    out('');
    out('It asks three questions and takes about a minute. Nothing needs administrator rights.');
    return 0;
  }
  out('This computer is set up.');
  out(`  What the assistant may do   ${record.tier}`);
  out(`  Working folder              ${record.workspaceRoots.join(', ')}`);
  out(`  Settings kept in            ${record.servicesRoot}`);
  const paired = pairing.pairingStatus(installRoot);
  out(`  Other computers             ${paired.summary}`);
  out('');
  out('  Check it still works:  node tools/mcsetup.js verify');
  if (!paired.paired) out('  Add another computer:  node tools/mcsetup.js pair invite');
  return 0;
}

async function commandPlan(args, { json = false } = {}) {
  const installRoot = installRootFor(args);
  const tier = resolveTier(args) || 'guided';
  const workspace = resolveWorkspaceArgument(args, tier, installRoot);
  const built = await buildPlanFor(args, { tier, workspace });
  if (json) {
    out(JSON.stringify(built, null, 2));
    return 0;
  }
  out('This is everything setup would do. Nothing has been changed yet.');
  out('');
  for (const entry of built.steps) {
    out(`  ${entry.id}`);
    out(`    ${entry.name}`);
    out(`    value       ${Array.isArray(entry.value) ? entry.value.join(', ') : entry.value}`);
    out(`    because     ${entry.provenance}`);
    if (entry.writes.length > 0) out(`    writes      ${entry.writes.join(', ')}`);
    if (entry.hosts.length > 0) out(`    contacts    ${entry.hosts.join(', ')}`);
    out(`    admin needed ${entry.elevation ? 'YES' : 'no'}`);
    out('');
  }
  out(`Total written: about ${Math.round(built.totalBytes / 1024)} KB. Administrator rights needed: ${built.requiresElevation ? 'YES' : 'no'}.`);
  return 0;
}

async function commandExplain(args) {
  const id = args._[1];
  if (typeof id !== 'string') {
    errorOut('Name the step to explain, for example: node tools/mcsetup.js explain runtime');
    return 2;
  }
  const installRoot = installRootFor(args);
  const tier = resolveTier(args) || 'guided';
  const workspace = resolveWorkspaceArgument(args, tier, installRoot);
  const built = await buildPlanFor(args, { tier, workspace });
  const found = setupPlan.explainStep(built, id);
  out(found.name);
  out('');
  out(`  value      ${Array.isArray(found.value) ? found.value.join(', ') : found.value}`);
  out(`  because    ${found.provenance}`);
  if (found.writes.length > 0) out(`  writes     ${found.writes.join(', ')}`);
  if (found.hosts.length > 0) out(`  contacts   ${found.hosts.join(', ')}`);
  out(`  admin      ${found.elevation ? 'required' : 'not required'}`);
  return 0;
}

async function commandApply(args, { dryRun = false, askQuestions = false } = {}) {
  const installRoot = installRootFor(args);
  let tier = resolveTier(args);
  let workspace = null;
  // Whoever answered the question has already read the notice; whoever passed
  // --tier has not, and still ends up with the configuration this level
  // generates. Exactly one of these two paths prints it.
  let tierChosenByQuestion = false;

  if (askQuestions && tier === null) {
    if (!interactive()) {
      errorOut('Setup needs to ask you three questions and this is not an interactive screen.');
      errorOut('Either run it in a terminal, or give the answers directly:');
      errorOut('  node tools/mcsetup.js apply --tier guided --workspace "<a folder>"');
      return 2;
    }
    tier = await askTier();
    tierChosenByQuestion = true;
  }
  if (tier === null) tier = 'guided';

  if (askQuestions && typeof args.workspace !== 'string' && interactive()) {
    workspace = await askWorkspace(tier, installRoot);
  } else {
    workspace = resolveWorkspaceArgument(args, tier, installRoot);
  }

  const built = await buildPlanFor(args, { tier, workspace });
  const nodePath = machineRecord.resolveNodePath({ override: typeof args.node === 'string' ? args.node : null });

  if (dryRun) {
    out('Nothing was changed. This is what would happen:');
    for (const entry of built.steps) {
      if (entry.writes.length > 0) out(`  write   ${entry.writes.join(', ')}`);
    }
    out(`  admin rights needed: ${built.requiresElevation ? 'YES' : 'no'}`);
    return 0;
  }

  let signIn = { signedIn: false, skipped: true };
  if (askQuestions && interactive()) signIn = await askSignIn(tier);

  const result = applyPlan(built, { tier, workspace, installRoot, nodePath });
  out('');
  out('Set up.');
  for (const entry of result.applied) {
    if (entry.id === 'workspace') out(`  Your folder      ${entry.workspace}`);
    if (entry.id === 'machine-record') out(`  Settings written ${entry.file}`);
    if (entry.id === 'mcp-config') {
      out(`  Assistant config ${entry.file}`);
      out(`  Available to it  ${entry.servers.join(', ') || 'nothing on this computer yet'}`);
    }
  }
  if (!tierChosenByQuestion) outTierLimitNotice(TIER_LIMIT_LEAD_AFTER);
  if (!signIn.signedIn && askQuestions) {
    out('');
    out('  Still to do: sign in. Run  node tools/mcsetup.js run  again whenever you are ready.');
  }
  out('');
  out('  Check it:  node tools/mcsetup.js verify');
  return 0;
}

function commandVerify(args, { json = false } = {}) {
  const servicesRoot = servicesRootFor(args);
  const installRoot = installRootFor(args);
  const checks = [];
  let record = null;
  try {
    record = machineRecord.readMachineRecord({ servicesRoot });
  } catch (error) {
    checks.push({ id: 'machine-record', ok: false, detail: error.message });
  }
  if (record === null && checks.length === 0) {
    checks.push({ id: 'machine-record', ok: false, detail: 'this computer has not been set up yet' });
  }
  if (record !== null) {
    checks.push({ id: 'machine-record', ok: true, detail: machineRecord.machineRecordPath(servicesRoot) });
    checks.push({
      id: 'runtime',
      ok: fs.existsSync(record.nodePath),
      detail: record.nodePath
    });
    for (const root of record.workspaceRoots) {
      checks.push({ id: 'workspace', ok: fs.existsSync(root), detail: root });
    }
    const mcpFile = path.join(record.workspaceRoots[0], '.mcp.json');
    let mcpOk = false;
    let mcpDetail = `${mcpFile} is missing`;
    if (fs.existsSync(mcpFile)) {
      try {
        const document = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
        const named = machineRecord.pathsNamedByMcpConfig(document);
        const missing = named.filter(entry => !fs.existsSync(entry));
        mcpOk = named.length > 0 && missing.length === 0;
        if (named.length === 0) {
          mcpDetail = `${mcpFile} names no paths, so there was nothing to verify`;
        } else {
          mcpDetail = mcpOk ? `${mcpFile}: every path in it exists` : `${mcpFile} names ${missing.length} path(s) that are not on this computer`;
        }
      } catch (error) {
        mcpDetail = `${mcpFile} could not be read: ${error.message}`;
      }
    }
    checks.push({ id: 'assistant-config', ok: mcpOk, detail: mcpDetail });
    checks.push({
      id: 'tier-enforcement',
      ok: true,
      // Deliberately reported rather than quietly true. The tier is recorded and
      // honoured when generating configuration; confining a running agent is
      // task T5 and is not built, and a verify that implied otherwise would be
      // the false-green this repository keeps finding.
      detail: `recorded as "${record.tier}" and used to generate this configuration; limits on a running assistant are not enforced yet`
    });
  }
  const paired = pairing.pairingStatus(installRoot);
  checks.push({ id: 'other-computers', ok: true, detail: paired.summary });

  const ok = checks.every(entry => entry.ok);
  if (json) {
    out(JSON.stringify({ ok, checks }, null, 2));
    return ok ? 0 : 1;
  }
  for (const entry of checks) out(`  ${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.id}: ${entry.detail}`);
  out('');
  out(ok ? 'This computer is set up and everything it points at exists.' : 'Something is not right yet. Run: node tools/mcsetup.js run');
  return ok ? 0 : 1;
}

async function commandPair(args) {
  const sub = args._[1] || 'status';
  const installRoot = installRootFor(args);
  if (sub === 'status') {
    const status = pairing.pairingStatus(installRoot);
    out(status.summary);
    for (const computer of status.computers) out(`  ${computer.label}  ${computer.fingerprint}`);
    if (!status.paired) {
      out('');
      out('  To add one:  node tools/mcsetup.js pair invite');
    }
    return 0;
  }
  if (sub === 'invite') {
    out('Adding a second computer.');
    return peerEnroll.commandInvite(installRoot, args, {
      emit: out,
      instruction: (details) => pairing.inviteInstruction({
        ...details,
        joinCommand: 'node tools/mcsetup.js pair join'
      })
    });
  }
  if (sub === 'join') {
    return peerEnroll.commandJoin(installRoot, args, { emit: out });
  }
  errorOut('Use: node tools/mcsetup.js pair [status|invite|join --address <shown> --code <code>]');
  return 2;
}

function commandUndo(args) {
  const servicesRoot = servicesRootFor(args);
  let record;
  try {
    record = machineRecord.readMachineRecord({ servicesRoot });
  } catch (error) {
    errorOut(error.message);
    return 1;
  }
  if (record === null) {
    errorOut('This computer has not been set up, so there is nothing to undo.');
    return 1;
  }
  const checkpoint = typeof args.to === 'string' ? args.to : null;
  const result = workspaceModule.undoToCheckpoint(record.workspaceRoots[0], checkpoint, {});
  if (!result.ok) {
    errorOut(`Nothing was changed: ${result.reason}.`);
    return 1;
  }
  out('That folder was put back the way it was.');
  return 0;
}

function usage() {
  out('ToolsEnabled setup');
  out('');
  out('  node tools/mcsetup.js                    what state this computer is in');
  out('  node tools/mcsetup.js run                set this computer up (asks three questions)');
  out('  node tools/mcsetup.js apply --tier <t> --workspace <folder>');
  out('                                           set it up without being asked anything');
  out('  node tools/mcsetup.js plan [--json]      everything it would do, before it does it');
  out('  node tools/mcsetup.js explain <step>     where one value came from');
  out('  node tools/mcsetup.js dry-run            what would be written, writing nothing');
  out('  node tools/mcsetup.js verify [--json]    is the configuration on this computer real');
  out('  node tools/mcsetup.js pair [status|invite|join]');
  out('                                           add or list other computers of yours');
  out('  node tools/mcsetup.js undo --to <point>  put the working folder back');
  out('');
  out(`  Levels: ${TIERS.join(', ')}`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'status';
  try {
    switch (command) {
      case 'status': return commandStatus(args);
      case 'run': return await commandApply(args, { askQuestions: true });
      case 'apply': return await commandApply(args, { askQuestions: false });
      case 'dry-run': return await commandApply(args, { dryRun: true });
      case 'plan': return await commandPlan(args, { json: args.json === true });
      case 'explain': return await commandExplain(args);
      case 'verify': return commandVerify(args, { json: args.json === true });
      case 'pair': return await commandPair(args);
      case 'undo': return commandUndo(args);
      case 'help': usage(); return 0;
      default:
        usage();
        return 2;
    }
  } catch (error) {
    if (error instanceof SetupRefusal) {
      errorOut(error.message);
      return 1;
    }
    errorOut(`Setup could not continue: ${(error && error.message) || 'unknown reason'}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    errorOut(`Setup could not continue: ${(error && error.message) || 'unknown reason'}`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  main,
  parseArgs,
  applyPlan,
  buildPlanFor,
  resolveTier,
  resolveWorkspaceArgument,
  commandVerify,
  commandStatus,
  TIER_CHOICES,
  TIER_LIMIT_NOTICE
});
