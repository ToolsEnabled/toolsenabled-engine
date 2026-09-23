#!/usr/bin/env node
'use strict';

/* "Can this computer run a model as a node, and if not, what is the one command
 * that fixes it?"
 *
 * That question had no answer before this file. research.local_tiers_status
 * answers a different and narrower one -- whether two FIXED advisory models
 * (hermes3:8b, gpt-oss:20b) are resident and whether the GPU is cool enough --
 * and it asks it of whatever host model.js resolves, which is a PEER machine,
 * not this one. A user with Ollama running locally and qwen2.5 pulled would
 * still be told nothing useful about their own machine.
 *
 * This prints the truth and nothing above it: which runtimes are listening,
 * which models they actually hold, and -- when the answer is "none" -- the exact
 * command to paste. It never says "ready" for a runtime with no weights in it.
 *
 * Read-only. Starts no inference, downloads nothing, needs no credential.
 */

const runtime = require('../src/lib/providers/local-node-runtime');

function usage() {
  return [
    'Usage: node tools/local-node-status.js [--json] [--host <address>]',
    '',
    'Reports which local model runtimes are serving on this machine and which',
    'models they hold. Exit 0 when at least one node could start, 1 otherwise.'
  ].join('\n');
}

function parse(argv) {
  const options = { json: false, host: runtime.DEFAULT_HOST };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') options.json = true;
    else if (token === '--host') {
      options.host = argv[index + 1];
      index += 1;
      if (!options.host) throw new Error('--host requires a value.');
    } else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`Unexpected argument: ${token}`);
  }
  return options;
}

function humanReport(detected) {
  const lines = [];
  lines.push(detected.ready
    ? `LOCAL NODE READY  ${detected.selected.displayName} on ${detected.selected.host}:${detected.selected.port}`
    : 'LOCAL NODE UNAVAILABLE');
  lines.push('');
  for (const entry of detected.runtimes) {
    const state = entry.probeError
      ? `probe failed: ${entry.probeError}`
      : entry.listening
      ? (entry.models.length ? `serving ${entry.models.length} model(s)` : 'listening, NO MODELS INSTALLED')
      : 'not running';
    lines.push(`  ${entry.displayName.padEnd(26)} ${String(entry.port).padStart(5)}  ${state}`);
    if (entry.listening && entry.models.length) {
      // Only a sample: a full list is noise on a machine with thirty models,
      // and the point of this line is "yes, real weights are here".
      lines.push(`      e.g. ${entry.models.slice(0, 6).join(', ')}${entry.models.length > 6 ? ` (+${entry.models.length - 6} more)` : ''}`);
    }
  }
  lines.push('');
  if (detected.ready) {
    lines.push(`  Dispatch model: ${runtime.preferredModel(detected.selected.models)}`);
    lines.push('  Tier name for dispatch: local');
    lines.push('  Cost: none. This runs on your hardware and bills nobody.');
  } else {
    lines.push(`  ${detected.reason}`);
    lines.push(`  Run this:  ${detected.nextCommand}`);
  }
  return lines.join('\n');
}

async function detectStatus(options = {}) {
  const host = options.host || runtime.DEFAULT_HOST;
  const results = await Promise.allSettled(runtime.RUNTIME_ORDER.map(id =>
    runtime.probeRuntime(id, { host })
  ));
  const runtimes = results.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const definition = runtime.RUNTIMES[runtime.RUNTIME_ORDER[index]];
    return Object.freeze({
      runtime: definition.id,
      displayName: definition.displayName,
      host,
      port: definition.port,
      listening: false,
      models: Object.freeze([]),
      reason: result.reason && result.reason.code ? result.reason.code : 'LOCAL_NODE_PROBE_FAILED',
      probeError: result.reason && result.reason.message ? result.reason.message : String(result.reason)
    });
  });
  const serving = runtimes.filter(entry => entry.listening && entry.models.length > 0);
  const failed = results.find(result => result.status === 'rejected');

  // A bad endpoint must not hide an independently healthy runtime. If none is
  // healthy, preserve the existing failure rather than guessing that a timed
  // out or malformed endpoint is absent.
  if (failed && serving.length === 0) throw failed.reason;
  if (serving.length > 0) {
    return Object.freeze({
      ready: true,
      runtimes: Object.freeze(runtimes),
      selected: serving[0],
      reason: null,
      nextCommand: null
    });
  }

  const listeningOnly = runtimes.filter(entry => entry.listening && entry.models.length === 0);
  if (listeningOnly.length > 0) {
    const first = listeningOnly[0];
    return Object.freeze({
      ready: false,
      runtimes: Object.freeze(runtimes),
      selected: null,
      reason: `${first.displayName} is running on ${first.host}:${first.port} but has no models installed.`,
      nextCommand: first.installCommand
    });
  }
  const preferred = runtime.RUNTIMES[runtime.RUNTIME_ORDER[0]];
  return Object.freeze({
    ready: false,
    runtimes: Object.freeze(runtimes),
    selected: null,
    reason: `No local model runtime is listening on ${host} (checked ${runtime.RUNTIME_ORDER.join(', ')}).`,
    nextCommand: runtime.installHint(preferred)
  });
}

async function main(argv) {
  let options;
  try { options = parse(argv); }
  catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const detected = await detectStatus({ host: options.host });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ready: detected.ready,
      reason: detected.reason,
      nextCommand: detected.nextCommand,
      dispatchModel: detected.ready ? runtime.preferredModel(detected.selected.models) : null,
      runtimes: detected.runtimes
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${humanReport(detected)}\n`);
  }
  return detected.ready ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`local-node-status failed: ${error && error.message ? error.message : error}\n`);
    process.exitCode = 2;
  });
}

module.exports = { detectStatus, humanReport, parse };
