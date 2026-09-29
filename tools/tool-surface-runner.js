#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const registry = require('../src/lib/tool-registry');
const dispatchPermissionSession = require('../src/lib/dispatch-permission-session');
const runner = require('./lib/tool-surface-runner');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(__dirname, 'tool-surface-runner-worker.js');
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseList(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw failure('RUNNER_ARGUMENT_INVALID', `${label} cannot be empty.`);
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    surfaces: [...runner.SURFACES], only: null, output: null, markdown: null,
    adapterConfig: process.env.TOOLSENABLED_TOOL_SURFACE_ADAPTER_CONFIG || null,
    timeoutMs: Number(process.env.TOOLSENABLED_TOOL_SURFACE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    readConcurrency: Number(process.env.TOOLSENABLED_TOOL_SURFACE_READ_CONCURRENCY || 1)
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === '--surfaces') { options.surfaces = parseList(value, '--surfaces'); index += 1; }
    else if (token === '--only') { options.only = new Set(parseList(value, '--only')); index += 1; }
    else if (token === '--output') { options.output = value; index += 1; }
    else if (token === '--markdown') { options.markdown = value; index += 1; }
    else if (token === '--adapter-config') { options.adapterConfig = value; index += 1; }
    else if (token === '--timeout-ms') { options.timeoutMs = Number(value); index += 1; }
    else if (token === '--read-concurrency') { options.readConcurrency = Number(value); index += 1; }
    else if (token === '--help') options.help = true;
    else throw failure('RUNNER_ARGUMENT_INVALID', `Unknown argument '${token}'.`);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30 * 60 * 1000) {
    throw failure('RUNNER_ARGUMENT_INVALID', '--timeout-ms must be an integer from 100 through 1800000.');
  }
  if (!Number.isSafeInteger(options.readConcurrency) || options.readConcurrency < 1 || options.readConcurrency > 32) {
    throw failure('RUNNER_ARGUMENT_INVALID', '--read-concurrency must be an integer from 1 through 32.');
  }
  for (const surface of options.surfaces) {
    if (!runner.SURFACES.includes(surface)) throw failure('RUNNER_ARGUMENT_INVALID', `Unknown surface '${surface}'.`);
  }
  if (options.only) {
    const live = new Set(registry.registeredTools({}).map(tool => tool.name));
    const unknown = [...options.only].filter(name => !live.has(name));
    if (unknown.length) throw failure('RUNNER_ARGUMENT_INVALID', `--only names unregistered tools: ${unknown.join(', ')}`);
  }
  return options;
}

function help() {
  return [
    'Usage: node tools/tool-surface-runner.js [options]',
    '',
    '  --surfaces desktop-here,docker,web,mobile',
    '  --only namespace.tool,namespace.tool  Explicit subset; all omitted tools remain reported.',
    '  --adapter-config path.json             JSON command adapters for non-local surfaces.',
    '  --timeout-ms number                    Per adapter operation timeout.',
    '  --read-concurrency number              Isolated harmless reads only; writes stay serial.',
    '  --output results.json',
    '  --markdown report.md',
    '',
    'Adapter config shape:',
    '  {"surfaces":{"docker":{"command":["program","arg"],"cwd":"optional"}}}',
    'The command receives one JSON request on stdin and returns one JSON object on stdout.',
    'Discovery response: {"ok":true,"tools":[...]}. Invocation response:',
    '{"ok":true,"result":{"origin":"product","kind":"answer","value":...}} or an origin=product named refusal envelope.',
    'Reversible lifecycle request: {"operation":"exercise-reversible","tool":...,"descriptor":...}.',
    'Its result must prove writeAsserted, restoreAsserted, writeEvidence, and restoreEvidence.'
  ].join('\n');
}

function boundedAppend(current, chunk) {
  const next = current + chunk;
  if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) throw failure('RUNNER_ADAPTER_OUTPUT_TOO_LARGE', 'Adapter output exceeded the bounded capture size.');
  return next;
}

async function spawnJson(command, request, { cwd, env, timeoutMs }) {
  if (!Array.isArray(command) || command.length < 1 || command.some(value => typeof value !== 'string' || !value)) {
    throw failure('RUNNER_ADAPTER_CONFIG_INVALID', 'Adapter command must be a non-empty string array.');
  }
  /* AMBIENT IS SCRUBBED FIRST, THEN THE CALLER'S OWN VALUES GO ON TOP.
   *
   * This was `{ ...process.env, ...(env || {}) }`, which forwards every
   * credential in this shell to a child that is about to invoke arbitrary
   * registered tools -- and the repository's spawn-environment gate caught it:
   * "SPREADS_AMBIENT: process.env is forwarded to the child".
   *
   * The ordering is the same one src/lib/proc/hidden-spawn.js settled on for the
   * same reason: scrub what was merely lying around, then overlay only what a
   * caller deliberately stated. Presence in the ambient environment is not
   * evidence that this child was meant to have it.
   *
   * Scrubbed with the shared helper rather than a delete list, because Windows
   * environment names are case-insensitive while a JS object is not -- deleting
   * ANTHROPIC_API_KEY leaves anthropic_api_key behind for the child to find. */
  const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
  const child = spawn(command[0], command.slice(1), {
    cwd: cwd || ROOT,
    env: { ...safeLaunchEnvironment(process.env, { context: 'tool surface runner adapter' }), ...(env || {}) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  });
  let stdout = '';
  let stderr = '';
  let overflow = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    try { stdout = boundedAppend(stdout, chunk); } catch (error) { overflow = error; child.kill(); }
  });
  child.stderr.on('data', chunk => {
    try { stderr = boundedAppend(stderr, chunk); } catch (error) { overflow = error; child.kill(); }
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Do not wait for an adapter to cooperate with SIGTERM: an adapter can
      // ignore it and keep both this promise and the runner's stdio handles
      // alive forever.  Close our side of the pipes and enforce the deadline
      // with SIGKILL before rejecting independently of the exit event.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill('SIGKILL');
      reject(failure('RUNNER_ADAPTER_TIMEOUT', `Adapter exceeded the ${timeoutMs}ms ceiling.`));
    }, timeoutMs);
  });
  let code;
  let signal;
  try {
    [code, signal] = await Promise.race([once(child, 'exit'), timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (overflow) throw overflow;
  if (signal) throw failure('RUNNER_ADAPTER_TIMEOUT', `Adapter was terminated by ${signal} after a ${timeoutMs}ms ceiling.`);
  if (code !== 0) throw failure('RUNNER_ADAPTER_FAILED', `Adapter exited ${code}: ${stderr.trim().slice(0, 500) || 'no stderr'}`);
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { throw failure('RUNNER_ADAPTER_PROTOCOL_INVALID', 'Adapter stdout was not one JSON object.'); }
  if (!parsed || parsed.ok !== true) {
    throw failure('RUNNER_ADAPTER_PROTOCOL_INVALID', `Adapter did not return ok=true: ${parsed && parsed.error ? parsed.error : 'unnamed error'}`);
  }
  return parsed;
}

function commandAdapter(config, timeoutMs) {
  return Object.freeze({
    ...(config.permissionCeiling ? { permissionCeiling: config.permissionCeiling } : {}),
    discover: async () => (await spawnJson(config.command, { operation: 'discover' }, {
      cwd: config.cwd, env: config.env, timeoutMs
    })).tools,
    invoke: async (tool, args) => (await spawnJson(config.command, {
      operation: 'invoke', tool, arguments: args
    }, { cwd: config.cwd, env: config.env, timeoutMs })).result,
    exerciseReversible: async tool => (await spawnJson(config.command, {
      operation: 'exercise-reversible',
      tool: tool.name,
      descriptor: {
        name: tool.name,
        effect: tool.effect,
        approvalEligible: tool.approvalEligible,
        annotations: tool.annotations,
        inputSchema: tool.inputSchema
      }
    }, { cwd: config.cwd, env: config.env, timeoutMs })).result
  });
}

function unattendedPermissionCeiling(dispatchSession = dispatchPermissionSession) {
  return Object.freeze({
    state: 'STATED',
    source: 'src/lib/dispatch-permission-session.js#unattendedSession()',
    maximum: dispatchSession.UNATTENDED_CEILING,
    resolved: dispatchSession.unattendedSession()
  });
}

function desktopAdapter(timeoutMs, {
  spawnRequest = spawnJson,
  dispatchSession = dispatchPermissionSession
} = {}) {
  const permissionCeiling = unattendedPermissionCeiling(dispatchSession);
  async function request(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return spawnRequest([process.execPath, WORKER, encoded], {}, { cwd: ROOT, timeoutMs });
  }
  return Object.freeze({
    permissionCeiling,
    discover: async () => (await request({ operation: 'discover' })).tools,
    invoke: async (tool, args) => (await request({
      operation: 'invoke', tool, arguments: args,
      permissionSession: permissionCeiling.resolved
    })).result
  });
}

function readAdapterConfig(file) {
  if (!file) return {};
  const resolved = path.resolve(file);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch (error) { throw failure('RUNNER_ADAPTER_CONFIG_INVALID', `Cannot read adapter config '${resolved}': ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.surfaces
      || typeof parsed.surfaces !== 'object' || Array.isArray(parsed.surfaces)) {
    throw failure('RUNNER_ADAPTER_CONFIG_INVALID', 'Adapter config must contain a surfaces object.');
  }
  const configs = {};
  for (const [surface, config] of Object.entries(parsed.surfaces)) {
    if (!runner.SURFACES.includes(surface)) throw failure('RUNNER_ADAPTER_CONFIG_INVALID', `Unknown configured surface '${surface}'.`);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw failure('RUNNER_ADAPTER_CONFIG_INVALID', `Surface '${surface}' adapter is invalid.`);
    }
    configs[surface] = config;
  }
  return configs;
}

function adaptersFor(options) {
  const configs = readAdapterConfig(options.adapterConfig);
  const adapters = { 'desktop-here': desktopAdapter(options.timeoutMs) };
  for (const [surface, config] of Object.entries(configs)) {
    adapters[surface] = commandAdapter(config, options.timeoutMs);
  }
  return adapters;
}

function md(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function namesWithStatus(result, status) {
  return Object.entries(result.cells).filter(([, value]) => value.status === status).map(([name]) => name);
}

function codeCounts(result, status, evidenceKey) {
  const counts = {};
  for (const value of Object.values(result.cells)) {
    if (value.status !== status) continue;
    const code = value.evidence && value.evidence[evidenceKey];
    if (evidenceKey === 'refusalCode' && !(typeof code === 'string' && code.trim())) continue;
    const name = typeof code === 'string' && code.trim() ? code.trim() : '(uncoded)';
    counts[name] = (counts[name] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function ceilingSummary(ceiling) {
  if (!ceiling || ceiling.state !== 'STATED') {
    return `${ceiling && ceiling.state ? ceiling.state : 'UNKNOWN'}: ${ceiling && ceiling.reason ? ceiling.reason : 'no ceiling metadata was recorded'}`;
  }
  return `${ceiling.source}; maximum=${JSON.stringify(ceiling.maximum)}; resolved=${JSON.stringify(ceiling.resolved)}`;
}

function renderReport(result) {
  const lines = [
    '# Tool surface runner report', '',
    `Generated: ${result.generatedAt}`, '',
    '## Derivation', '',
    `${result.derivation} The resulting live census is **${result.census.toolCount} tools in ${result.census.namespaceCount} namespaces**. No registered tool names are embedded in the runner.`, '',
    '### Explicit execution limits', '',
    `Per-operation timeout: **${result.execution.timeoutMs} ms**. Harmless-read concurrency: **${result.execution.readConcurrency}**. Selected surfaces: **${result.execution.selectedSurfaces.map(md).join(', ')}**. Selected tools: **${result.execution.selectedToolCount === null ? 'all registry-derived tools' : result.execution.selectedToolCount}**.`, '',
    '### Namespace breakdown', '',
    '| Namespace | Tools |', '|---|---:|'
  ];
  for (const [namespace, count] of Object.entries(result.census.namespaces)) lines.push(`| ${md(namespace)} | ${count} |`);
  lines.push('', '## Classification', '',
    'Classification uses only each live descriptor’s `effect`, `annotations.destructiveHint`, `approvalEligible`, and provider metadata. Every tool has exactly one class.', '',
    '| Class | Count |', '|---|---:|');
  for (const [classification, count] of Object.entries(result.census.classes)) lines.push(`| ${classification} | ${count} |`);
  lines.push('', '### Per-tool classification', '',
    '| Tool | Effect | Destructive | Approval eligible | Class | Reason / prerequisite |',
    '|---|---|---:|---:|---|---|');
  for (const tool of result.tools) {
    const detail = tool.classification.prerequisite || tool.classification.standIn || tool.classification.reason;
    lines.push(`| ${md(tool.name)} | ${tool.effect} | ${tool.destructiveHint} | ${tool.approvalEligible} | ${tool.classification.class} | ${md(detail)} |`);
  }
  lines.push('', '## Coverage achieved this run', '',
    'A cell never inherits another surface’s result. `NOT APPLICABLE` means a real invocation was intentionally forbidden and names the required stand-in; it is not a green result.', '',
    '| Surface | Discovery | Permission ceiling used | VERIFIED | FAILS | NOT MEASURED | NOT APPLICABLE | NOT YET TESTED | OWNER-PREREQUISITE |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|');
  for (const surface of runner.SURFACES) {
    const item = result.surfaces[surface];
    lines.push(`| ${surface} | ${md(item.discovery.state)} | ${md(ceilingSummary(item.permissionCeiling))} | ${item.counts.VERIFIED} | ${item.counts.FAILS} | ${item.counts['NOT MEASURED']} | ${item.counts['NOT APPLICABLE']} | ${item.counts['NOT YET TESTED']} | ${item.counts['OWNER-PREREQUISITE']} |`);
  }
  lines.push('', '### Complete per-tool, per-surface matrix', '',
    '| Tool | desktop-here | docker | web | mobile |', '|---|---|---|---|---|');
  for (const tool of result.tools) {
    const values = runner.SURFACES.map(surface => {
      const value = result.surfaces[surface].cells[tool.name];
      return `${value.status}: ${md(value.reason)}`;
    });
    lines.push(`| ${md(tool.name)} | ${values.join(' | ')} |`);
  }
  lines.push('', '## Explicit not-run lists', '');
  for (const surface of runner.SURFACES) {
    const item = result.surfaces[surface];
    const notRun = [
      ...namesWithStatus(item, 'NOT MEASURED'),
      ...namesWithStatus(item, 'NOT APPLICABLE'),
      ...namesWithStatus(item, 'NOT YET TESTED')
    ];
    lines.push(`### ${surface} (${notRun.length})`, '');
    if (!notRun.length) lines.push('None.', '');
    else for (const name of notRun) lines.push(`- ${name}: ${item.cells[name].reason}`);
    lines.push('');
  }
  lines.push('## OWNER-PREREQUISITE list', '');
  for (const surface of runner.SURFACES) {
    const item = result.surfaces[surface];
    const prerequisites = namesWithStatus(item, 'OWNER-PREREQUISITE');
    lines.push(`### ${surface} (${prerequisites.length})`, '');
    if (!prerequisites.length) lines.push('None.', '');
    else for (const name of prerequisites) lines.push(`- ${name}: ${item.cells[name].reason}`);
    lines.push('');
  }
  lines.push('## Origin and code breakdown', '',
    'Only an envelope explicitly marked `origin=product` can produce `VERIFIED` or `FAILS`. Any exception raised at the adapter boundary is `origin=runner` and `NOT MEASURED`, regardless of whether it carries a code.', '');
  for (const surface of runner.SURFACES) {
    const item = result.surfaces[surface];
    lines.push(`### ${surface}`, '',
      `Product refusal codes among VERIFIED: ${md(JSON.stringify(codeCounts(item, 'VERIFIED', 'refusalCode')))}.`, '',
      `Runner codes among NOT MEASURED: ${md(JSON.stringify(codeCounts(item, 'NOT MEASURED', 'runnerCode')))}.`, '');
  }
  lines.push('## Genuinely uncoded product remainder', '',
    'A product failure is counted only when the adapter successfully returns an `origin=product, kind=failure` envelope. Runner timeouts, adapter exceptions, and protocol errors are listed above as `NOT MEASURED`.', '');
  let failures = 0;
  for (const surface of runner.SURFACES) {
    const item = result.surfaces[surface];
    for (const name of namesWithStatus(item, 'FAILS')) {
      failures += 1;
      lines.push(`- ${surface} / ${name}: ${item.cells[name].reason}; evidence=${md(JSON.stringify(item.cells[name].evidence))}`);
    }
  }
  if (!failures) lines.push('None.');
  lines.push('', '## Runner failure proof', '',
    `The runner selected the registry-derived harmless-read descriptor \`${result.failureProof.tool}\`. Its temporary product handler threw an uncoded error through the worker's product-outcome serializer, then was restored.`, '',
    '```json', JSON.stringify(result.failureProof, null, 2), '```', '',
    `Broken output: **${result.failureProof.broken.status}**. Restored output: **${result.failureProof.restored.status}**.`, '');
  return `${lines.join('\n')}\n`;
}

function writeFile(file, contents) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, contents, 'utf8');
  return resolved;
}

function resultExitCode(result) {
  const surfaces = Object.values(result.surfaces);
  if (surfaces.some(surface => surface.counts.FAILS > 0)) return 1;
  const inconclusive = ['NOT MEASURED', 'NOT APPLICABLE', 'NOT YET TESTED', 'OWNER-PREREQUISITE'];
  if (surfaces.some(surface => inconclusive.some(status => surface.counts[status] > 0))) return 3;
  return 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${help()}\n`); return; }
  const result = await runner.run({
    registeredTools: () => registry.registeredTools({}),
    adapters: adaptersFor(options),
    surfaces: options.surfaces,
    selectedTools: options.only,
    readConcurrency: options.readConcurrency
  });
  result.execution = Object.freeze({
    timeoutMs: options.timeoutMs,
    readConcurrency: options.readConcurrency,
    selectedSurfaces: [...options.surfaces],
    selectedToolCount: options.only ? options.only.size : null
  });
  result.failureProof = await runner.failureProof(() => registry.registeredTools({}));
  if (options.output) writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`);
  if (options.markdown) writeFile(options.markdown, renderReport(result));
  process.stdout.write(`${JSON.stringify({
    tools: result.census.toolCount,
    namespaces: result.census.namespaceCount,
    classes: result.census.classes,
    surfaces: Object.fromEntries(runner.SURFACES.map(surface => [surface, result.surfaces[surface].counts])),
    permissionCeilings: Object.fromEntries(runner.SURFACES.map(surface => [surface, result.surfaces[surface].permissionCeiling])),
    output: options.output ? path.resolve(options.output) : null,
    markdown: options.markdown ? path.resolve(options.markdown) : null,
    failureProof: result.failureProof
  }, null, 2)}\n`);
  process.exitCode = resultExitCode(result);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.stack || error}\n`);
    process.exitCode = 2;
  });
}

module.exports = Object.freeze({ desktopAdapter, parseArgs, renderReport, resultExitCode, unattendedPermissionCeiling });
