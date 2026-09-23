#!/usr/bin/env node
'use strict';

/* THE CHILD PROCESS A LOCAL MODEL NODE ACTUALLY IS.
 *
 * The mission bridge dispatches a lane by spawning a real executable, writing
 * the brief to its stdin and reading newline-delimited JSON events off its
 * stdout (src/lib/agent-lane.js#spawnChild). Codex and Claude satisfy that
 * because they ARE such programs. A model on the user's GPU is an HTTP endpoint
 * and is not, so something has to be the process. This file is that something.
 *
 * WHY A PROCESS AT ALL, RATHER THAN AN IN-BRIDGE HTTP CALL.
 *
 * Because everything that makes a lane a lane -- presence seat, heartbeat,
 * lease, cap timer, console log, checkpoint, terminal exit code -- is keyed off
 * a spawned child. An in-process HTTP call would have needed a second, parallel
 * lifecycle with its own bugs, and a local node would have been a different kind
 * of thing that merely looked like a node. It goes through the same door.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * No tools. No file writes inside the worktree. A local 7B model is not a coding
 * agent and pretending otherwise would ship a node that damages a repository and
 * calls it work. It answers the brief as text, writes its checkpoint, and exits.
 * Tool use is the next honest increment, not something to imply now.
 *
 * NO CREDENTIAL IS READ HERE, and none is needed: see local-node-runtime.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const runtime = require('../src/lib/providers/local-node-runtime');
const localOptions = require('../src/lib/local-model-options');

const MAX_STDIN_BYTES = 128 * 1024;
const EXIT_OK = 0;
const EXIT_FAILED = 1;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/* Argument parsing that REFUSES rather than defaults.
 *
 * A silently defaulted endpoint is how a lane ends up quietly talking to the
 * wrong machine -- the exact failure documented in local-node-runtime.js, where
 * the existing model path reached a peer computer while loopback sat unused. */
function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`--${name} requires a value.`);
    values.set(name, next);
    index += 1;
  }
  const required = ['runtime', 'model', 'host', 'port', 'worktree'];
  for (const key of required) {
    if (!values.has(key)) throw new Error(`--${key} is required.`);
  }
  const port = Number(values.get('port'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a TCP port.');
  const maxOutputTokens = values.has('max-output-tokens') ? Number(values.get('max-output-tokens')) : 1024;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > runtime.MAX_OUTPUT_TOKENS) {
    throw new Error(`--max-output-tokens must be 1..${runtime.MAX_OUTPUT_TOKENS}.`);
  }
  const runtimeOptions = {};
  for (const [flag, key, numeric] of [
    ['gpu-policy', 'gpuPolicy', false], ['context-tokens', 'contextTokens', true],
    ['thinking', 'thinking', false], ['keep-alive-minutes', 'keepAliveMinutes', true]
  ]) {
    if (values.has(flag)) runtimeOptions[key] = numeric ? Number(values.get(flag)) : values.get(flag);
  }
  localOptions.resolveOptions({}, runtimeOptions);
  return {
    runtime: values.get('runtime'),
    model: values.get('model'),
    host: values.get('host'),
    port,
    worktree: values.get('worktree'),
    checkpoint: values.get('checkpoint') || null,
    maxOutputTokens,
    ...(Object.keys(runtimeOptions).length ? { runtimeOptions } : {})
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    process.stdin.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error(`The brief exceeded ${MAX_STDIN_BYTES} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/* The lane's useful-progress observer advances on a CHECKPOINT DIGEST CHANGE as
 * well as on tool events. A local node emits no tool events -- it has no tools
 * -- so writing the checkpoint is the only truthful progress signal it has, and
 * it is written when the model has actually answered, never before. */
function writeCheckpoint(file, worktree, text) {
  if (!file) return;
  const resolved = path.resolve(file);
  if (!path.resolve(worktree) || !resolved.startsWith(path.resolve(worktree))) return;
  try {
    fs.writeFileSync(resolved, `${JSON.stringify({
      at: new Date().toISOString(),
      state: 'answered',
      characters: text.length
    })}\n`, 'utf8');
  } catch { /* A checkpoint that cannot be written must not fail an answered lane. */ }
}

/* The verdict line the lane runtime greps out of the console log
 * (agent-lane.js#extractLaneVerdict falls through to extractVerdict on the raw
 * text for any kind it has no structured parser for). If the model omitted a
 * verdict, the runner could not establish success and must fail closed. */
function verdictFor(text) {
  return /VERDICT:\s*(PASSED|FAILED|NEEDS_INPUT|BLOCKED)/i.test(text)
    ? null
    : 'VERDICT: FAILED local node did not provide a verdict';
}

async function main() {
  let options;
  try { options = parseArguments(process.argv.slice(2)); }
  catch (error) {
    emit({ type: 'local_node.error', code: 'LOCAL_NODE_ARGUMENTS_INVALID', message: String(error.message) });
    process.stdout.write('VERDICT: FAILED local node arguments invalid\n');
    return EXIT_FAILED;
  }

  emit({
    type: 'local_node.start',
    runtime: options.runtime,
    model: options.model,
    endpoint: `${options.host}:${options.port}`,
    costUsd: 0
  });

  let prompt;
  try { prompt = await readStdin(); }
  catch (error) {
    emit({ type: 'local_node.error', code: 'LOCAL_NODE_BRIEF_UNREADABLE', message: String(error.message) });
    process.stdout.write('VERDICT: FAILED local node brief unreadable\n');
    return EXIT_FAILED;
  }
  if (!prompt.trim()) {
    emit({ type: 'local_node.error', code: 'LOCAL_NODE_BRIEF_EMPTY', message: 'The dispatched brief was empty.' });
    process.stdout.write('VERDICT: FAILED local node brief empty\n');
    return EXIT_FAILED;
  }

  // RE-VERIFY AT SPAWN, not only at dispatch. The user can stop Ollama between
  // the two, and a node that reports success against a dead endpoint is the
  // dishonesty this whole path exists to avoid.
  const probe = await runtime.probeRuntime(options.runtime, { host: options.host, port: options.port });
  if (!probe.listening) {
    emit({
      type: 'local_node.error',
      code: 'LOCAL_NODE_RUNTIME_UNAVAILABLE',
      message: `${probe.displayName} is not listening on ${probe.host}:${probe.port}.`,
      installCommand: probe.installCommand
    });
    process.stdout.write(`VERDICT: FAILED ${probe.displayName} is not running; start it or install it with: ${probe.installCommand}\n`);
    return EXIT_FAILED;
  }

  let completion;
  const startedAt = Date.now();
  try {
    completion = await runtime.complete({
      prompt: prompt.slice(0, runtime.MAX_PROMPT_CHARS),
      model: options.model,
      runtime: options.runtime,
      host: options.host,
      port: options.port,
      maxOutputTokens: options.maxOutputTokens,
      runtimeOptions: options.runtimeOptions,
      system: 'You are a local worker node. Answer the bounded brief directly and finish with a single line "VERDICT: PASSED" or "VERDICT: FAILED <reason>". You have no tools and cannot edit files; say so plainly if the brief requires them.'
    });
  } catch (error) {
    emit({
      type: 'local_node.error',
      code: error && error.code ? error.code : 'LOCAL_NODE_FAILED',
      message: String(error && error.message ? error.message : error)
    });
    process.stdout.write(`VERDICT: FAILED ${error && error.code ? error.code : 'LOCAL_NODE_FAILED'}\n`);
    return EXIT_FAILED;
  }

  writeCheckpoint(options.checkpoint, options.worktree, completion.text);
  emit({
    type: 'local_node.completed',
    runtime: completion.runtime,
    model: completion.model,
    promptTokens: completion.promptTokens,
    completionTokens: completion.completionTokens,
    finishReason: completion.finishReason,
    durationMs: Date.now() - startedAt,
    costUsd: 0,
    contentTrust: 'untrusted',
    grantsAuthority: false
  });
  process.stdout.write(`${completion.text}\n`);
  const verdict = verdictFor(completion.text);
  if (verdict) process.stdout.write(`${verdict}\n`);
  return EXIT_OK;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, error => {
    emit({ type: 'local_node.error', code: 'LOCAL_NODE_UNEXPECTED', message: String(error && error.message ? error.message : error) });
    process.stdout.write('VERDICT: FAILED local node crashed\n');
    process.exitCode = EXIT_FAILED;
  });
}

module.exports = { parseArguments, verdictFor };
