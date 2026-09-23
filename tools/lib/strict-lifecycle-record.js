'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseSuiteList } = require('../../tests/lib/suite-list');
const { deleteEnvNames } = require('../../src/lib/env-scrub');
const { STRICT_ENV, OPT_IN_TESTS, strictRequested } = require('./test-completion');

const AUTHORITY = Object.freeze(['TOOLSENABLED_TEST_PROOF_ROOT', 'TOOLSENABLED_TEST_PROOF_ID',
  'TOOLSENABLED_TEST_PROOF_DIGEST', 'TOOLSENABLED_TEST_PROOF_SCOPE']);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value);
const same = (a, b) => json(a) === json(b);
const portable = value => value.replaceAll('\\', '/');
const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const EMPTY_PLACEHOLDER = Object.freeze({ script: 'test:key-custody', command: 'node tests/run-isolated.js',
  status: 'UNIMPLEMENTED', coverage: 'No key-custody coverage; the never-populated standalone alias still refuses usage.' });

function fileIdentity(root, relative) {
  const absolute = path.resolve(root, relative);
  const local = path.relative(root, absolute);
  if (!local || local === '..' || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)) throw new Error(`recipe input escapes its root: ${relative}`);
  let cursor = root;
  for (const part of local.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`recipe input is linked: ${relative}`);
  }
  if (!fs.statSync(absolute).isFile()) throw new Error(`recipe input is not a file: ${relative}`);
  return { file: portable(local), sha256: digest(fs.readFileSync(absolute)) };
}

function sourceIdentity(root) {
  const environment = deleteEnvNames({ ...process.env }, ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']);
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const git = args => {
    const result = spawnSync('git', ['--no-optional-locks', '--no-replace-objects', '-c', `safe.directory=${portable(root)}`, ...args], {
      cwd: root, env: environment, encoding: 'utf8', windowsHide: true, timeout: 15_000
    });
    if (result.error || result.signal || result.status !== 0) throw new Error('strict source identity could not be measured');
    return result.stdout.trim();
  };
  if (!samePath(git(['rev-parse', '--show-toplevel']), root)) throw new Error('strict source root is not this Git checkout (parent walking is refused)');
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('strict source has working/index drift or untracked inputs');
  const [head, tree] = git(['rev-parse', 'HEAD', 'HEAD^{tree}']).split(/\r?\n/);
  if (![head, tree].every(value => /^[0-9a-f]{40}$/.test(value))) throw new Error('strict source revision is not exact');
  return { head, tree };
}

// This grammar is the checked-in test recipe, not a general shell interpreter.
// Unknown operators refuse before execution instead of guessing reachability.
function words(command) {
  if (/[;&|`$<>\r\n]/.test(command)) throw new Error('unsupported shell syntax in strict test recipe');
  const result = [];
  const pattern = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/gy;
  let position = 0;
  while (position < command.length) {
    if (!command.slice(position).trim()) break;
    pattern.lastIndex = position;
    const match = pattern.exec(command);
    if (!match) throw new Error('unparseable strict test command');
    result.push(match[1] ?? match[2] ?? match[3]);
    position = pattern.lastIndex;
  }
  if (!result.length) throw new Error('empty strict test command');
  return result;
}

function buildRecipe(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const nodes = [];
  const inputs = new Map();
  const input = file => {
    const identity = fileIdentity(root, file);
    inputs.set(identity.file, identity);
    return identity;
  };
  input('package.json');
  const add = node => { nodes.push(node); return node; };
  function command(argv, id, parent, ancestry) {
    if (argv[0] !== 'node' || !argv[1]) throw new Error(`unreviewed command in strict recipe: ${id}`);
    const script = input(argv[1]).file;
    if (script === 'tests/key-custody/run.js') {
      // Dispatch is one command occurrence, not two native executions. Both
      // fixed leaves are input identities; the per-host receipt says which ran.
      input('tests/linux-vault.test.js');
      input('tests/vault-native.test.js');
    }
    if (script === 'tools/check-chain-runner.js') {
      const { parseSteps, validateChain } = require('../check-chain-runner');
      const args = argv.slice(2);
      if (args.includes('--list') || args.includes('--update-baseline')) throw new Error('non-executing or baseline-update chain is not a strict recipe');
      const nameIndex = args.indexOf('--name');
      const name = nameIndex < 0 ? 'chain' : args[nameIndex + 1];
      const steps = validateChain(name, parseSteps(args));
      add({ id, parent, kind: 'chain', argv, name, steps: steps.map(step => step.id) });
      for (const step of steps) {
        const child = `${id}/step:${encodeURIComponent(step.id)}`;
        if (step.npm) npm(step.npm, child, id, ancestry);
        else command(step.run, child, id, ancestry);
      }
    } else if (script === 'tests/run-isolated.js') {
      const files = [];
      for (let index = 2; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--from') {
          const list = input(argv[++index]);
          files.push(...parseSuiteList(fs.readFileSync(path.join(root, list.file), 'utf8')));
        } else if (['--summary', '--timeout-ms'].includes(argument)) {
          if (!argv[++index]) throw new Error(`missing isolated-runner option value: ${id}`);
        } else if (['--continue', '--config-integrity', '--fail-fast'].includes(argument)) {
          // These affect the verdict, never the mandatory selected identities.
        } else if (argument.startsWith('--')) throw new Error(`unsupported isolated-runner option: ${argument}`);
        else files.push(argument);
      }
      add({ id, parent, kind: 'isolated', argv, files: files.map(file => portable(path.relative(root, path.resolve(root, file)))) });
      for (const [index, file] of files.entries()) {
        const identity = input(file);
        if (OPT_IN_TESTS.some(entry => entry.file.toLowerCase() === identity.file.toLowerCase())) throw new Error(`opt-in test entered strict recipe: ${identity.file}`);
        add({ id: `${id}/file:${index}`, parent: id, kind: 'file', ...identity });
      }
    } else {
      add({ id, parent, kind: script === 'tools/test-ratchet.mjs' ? 'verifier' : 'command', argv, ...input(script) });
    }
  }
  function npm(name, id, parent, ancestry) {
    if (ancestry.includes(name)) throw new Error(`recursive npm lifecycle: ${name}`);
    if (typeof pkg.scripts?.[name] !== 'string') throw new Error(`missing declared npm script: ${name}`);
    const phases = [`pre${name}`, name, `post${name}`].filter(phase => typeof pkg.scripts[phase] === 'string');
    add({ id, parent, kind: 'npm', name, phases });
    for (const phase of phases) {
      const argv = words(pkg.scripts[phase]);
      if (!['tools/check-chain-runner.js', 'tests/run-isolated.js'].includes(portable(argv[1] || ''))) {
        throw new Error(`npm phase ${phase} needs an instrumented chain/isolated boundary, not inferred child coverage`);
      }
      command(argv, `${id}/phase:${encodeURIComponent(phase)}`, id, [...ancestry, name]);
    }
  }
  npm('test', 'npm:test', null, []);
  const retired = [];
  if (Object.hasOwn(pkg.scripts, EMPTY_PLACEHOLDER.script) && !nodes.some(node => node.kind === 'npm' && node.name === EMPTY_PLACEHOLDER.script)) {
    if (pkg.scripts[EMPTY_PLACEHOLDER.script] !== EMPTY_PLACEHOLDER.command) throw new Error('retired key-custody placeholder is now populated or changed; explicitly wire/reconcile its coverage');
    retired.push(EMPTY_PLACEHOLDER);
  }
  const verifiers = nodes.filter(node => node.kind === 'verifier');
  const leaves = nodes.filter(node => ['file', 'command', 'verifier'].includes(node.kind));
  if (verifiers.length !== 1 || leaves.at(-1)?.id !== verifiers[0].id
      || !verifiers[0].id.startsWith('npm:test/phase:posttest/')) throw new Error('strict metadata verifier must occur exactly once, last in posttest');
  return { nodes, inputs: [...inputs.values()].sort((a, b) => a.file.localeCompare(b.file)), verifier: verifiers[0].id, retired };
}

function createContract(root, directory) {
  const source = sourceIdentity(root);
  const recipe = buildRecipe(root);
  const contract = { schemaVersion: 1, runId: crypto.randomUUID(), root: path.resolve(root), source,
    recipeDigest: digest(json(recipe)), recipe };
  fs.mkdirSync(path.join(directory, 'receipts'), { recursive: true });
  const bytes = json(contract);
  fs.writeFileSync(path.join(directory, 'contract.json'), bytes, { flag: 'wx' });
  return { directory, contract, contractDigest: digest(bytes) };
}

function proofEnvironment(context, scope, base = process.env) {
  const environment = clearAuthority(base);
  environment[STRICT_ENV] = '1';
  [environment.TOOLSENABLED_TEST_PROOF_ROOT, environment.TOOLSENABLED_TEST_PROOF_ID,
    environment.TOOLSENABLED_TEST_PROOF_DIGEST, environment.TOOLSENABLED_TEST_PROOF_SCOPE]
    = [context.directory, context.contract.runId, context.contractDigest, scope];
  return environment;
}
function clearAuthority(base = process.env) { return deleteEnvNames({ ...base }, AUTHORITY); }

function readContext(environment = process.env) {
  if (!environment.TOOLSENABLED_TEST_PROOF_ROOT) return null;
  if (!strictRequested(environment)) throw new Error('strict proof cannot be used with ordinary verdict semantics');
  const directory = path.resolve(environment.TOOLSENABLED_TEST_PROOF_ROOT);
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('linked strict proof root');
  const filename = path.join(directory, 'contract.json');
  if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('linked strict proof contract');
  const bytes = fs.readFileSync(filename, 'utf8');
  const contract = JSON.parse(bytes);
  const contractDigest = digest(bytes);
  if (contract.schemaVersion !== 1 || contract.runId !== environment.TOOLSENABLED_TEST_PROOF_ID
      || contractDigest !== environment.TOOLSENABLED_TEST_PROOF_DIGEST
      || contract.recipeDigest !== digest(json(contract.recipe))) throw new Error('strict proof identity/digest mismatch');
  if (!samePath(process.cwd(), contract.root)) throw new Error('strict proof checkout differs from actual command working directory');
  let node = contract.recipe.nodes.find(entry => entry.id === environment.TOOLSENABLED_TEST_PROOF_SCOPE);
  if (!node) throw new Error('strict proof scope is not declared');
  if (node.kind === 'npm') {
    const phase = environment.npm_lifecycle_event;
    if (!node.phases.includes(phase)) throw new Error('npm lifecycle phase does not match strict recipe');
    node = contract.recipe.nodes.find(entry => entry.id === `${node.id}/phase:${encodeURIComponent(phase)}`);
  }
  return { directory, contract, contractDigest, node };
}

function record(context, node, event, result = null) {
  if (!context) return;
  if (!['start', 'end'].includes(event) || !context.contract.recipe.nodes.some(entry => same(entry, node))) throw new Error('undeclared strict receipt');
  const receipt = { schemaVersion: 1, runId: context.contract.runId, source: context.contract.source,
    recipeDigest: context.contract.recipeDigest, id: node.id, kind: node.kind, event, result };
  const filename = path.join(context.directory, 'receipts', `${digest(node.id)}-${event}.json`);
  fs.writeFileSync(filename, json(receipt), { flag: 'wx' });
}

function assertInvocation(context, kind, argv) {
  if (!context) return;
  if (context.node.kind !== kind || !same(context.node.argv, argv)) throw new Error('actual invocation differs from strict recipe');
}

function verify(context, { terminal = false } = {}) {
  if (!context) throw new Error('strict lifecycle has no matching source/selection-bound summary producer');
  if (!same(sourceIdentity(context.contract.root), context.contract.source)
      || !same(buildRecipe(context.contract.root), context.contract.recipe)) throw new Error('strict source or recipe drifted during measurement');
  const nodes = context.contract.recipe.nodes;
  const allowedOpen = new Set();
  if (!terminal) {
    if (context.node?.id !== context.contract.recipe.verifier) throw new Error('only the declared final metadata verifier may inspect pending terminal evidence');
    let node = context.node;
    while (node) { allowedOpen.add(node.id); node = nodes.find(entry => entry.id === node.parent); }
  }
  const seen = new Map();
  const receiptsRoot = path.join(context.directory, 'receipts');
  if (fs.lstatSync(receiptsRoot).isSymbolicLink()) throw new Error('linked strict receipt directory');
  for (const name of fs.readdirSync(receiptsRoot)) {
    const filename = path.join(receiptsRoot, name);
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('linked strict receipt');
    const receipt = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const node = nodes.find(entry => entry.id === receipt.id);
    const key = `${receipt.id}:${receipt.event}`;
    if (!node || !['start', 'end'].includes(receipt.event) || seen.has(key)
        || name !== `${digest(receipt.id)}-${receipt.event}.json`
        || receipt.schemaVersion !== 1 || receipt.runId !== context.contract.runId
        || receipt.kind !== node.kind || !same(receipt.source, context.contract.source)
        || receipt.recipeDigest !== context.contract.recipeDigest) throw new Error('foreign, duplicate or old-source strict receipt');
    if (receipt.event === 'end' && (receipt.result?.status !== 'pass' || receipt.result?.exitCode !== 0
        || receipt.result.signal || receipt.result.error)) throw new Error(`nonpassing strict receipt: ${node.id}`);
    if (node.kind === 'file' && receipt.event === 'end'
        && (receipt.result.file !== node.file || receipt.result.process?.exitCode !== 0
          || receipt.result.process.signal || receipt.result.process.error
          || !['reconciled-tap', 'process-exit'].includes(receipt.result.evidence?.kind))) {
      throw new Error(`selected file lacks its own actual terminal evidence: ${node.id}`);
    }
    seen.set(key, receipt);
  }
  for (const node of nodes) {
    if (!seen.has(`${node.id}:start`)) throw new Error(`missing strict start receipt: ${node.id}`);
    if (!seen.has(`${node.id}:end`) && !allowedOpen.has(node.id)) throw new Error(`missing strict terminal receipt: ${node.id}`);
    if (node.kind === 'isolated' && !node.files.length) throw new Error(`declared isolated invocation selected ZERO files: ${node.id}`);
  }
  const files = nodes.filter(node => node.kind === 'file').map(node => ({ id: node.id, file: node.file, sha256: node.sha256,
    result: seen.get(`${node.id}:end`).result }));
  return { runId: context.contract.runId, source: context.contract.source, recipeDigest: context.contract.recipeDigest,
    terminal, mandatoryFileOccurrences: files.length, files,
    outsideProof: [...OPT_IN_TESTS.map(entry => ({ ...entry, status: 'UNEXECUTED' })), ...context.contract.recipe.retired] };
}

module.exports = { AUTHORITY, buildRecipe, sourceIdentity, createContract, proofEnvironment, clearAuthority,
  readContext, record, assertInvocation, verify, fileIdentity, digest };
