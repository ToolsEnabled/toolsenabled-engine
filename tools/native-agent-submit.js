#!/usr/bin/env node
'use strict';

// Submit one native.agent.run task onto the native-agent queue.
//
// This is the LOCAL convenience path, used for testing and for a local
// operator. A configured peer uses the ordinary task.submit tool over its
// authenticated 8788 bridge with
//   queue: "native-agent", type: "native.agent.run"
// and this worker claims it here. Nothing new is exposed on that bridge --
// task.* is already in its profile, host.exec is still excluded from it, and
// the credential boundary is unchanged. Capability comes from the agent being
// a local principal on this machine, not from anything granted over the wire.
//
// Usage:
//   node tools/native-agent-submit.js --acceptance [--key <idempotencyKey>]
//   node tools/native-agent-submit.js --objective "..." [--timeout-ms N] [--max-turns N]

const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const tasks = require(path.join(ROOT, 'src', 'lib', 'providers', 'tasks.js'));
const { QUEUE, TASK_TYPE } = require(path.join(ROOT, 'sidecars', 'native-agent', 'src', 'native-agent-worker.js'));

function flag(name) {
  const option = `--${name}`;
  const indexes = process.argv.reduce((found, value, index) => {
    if (value === option) found.push(index);
    return found;
  }, []);
  if (indexes.length === 0) return undefined;
  if (indexes.length > 1) throw new Error(`${option} may only be supplied once.`);
  const value = process.argv[indexes[0] + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

function integerFlag(name) {
  const value = flag(name);
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be a safe integer.`);
  return parsed;
}

async function main() {
  const acceptance = process.argv.includes('--acceptance');
  const objective = flag('objective');
  if (acceptance && objective !== undefined) throw new Error('Pass only one of --acceptance or --objective.');
  if (!acceptance && !objective) throw new Error('Pass --acceptance or --objective "<text>".');

  // The queue's existing { title, objective, context } payload contract,
  // unchanged. Run controls ride in `context` as a small JSON object.
  const control = { mode: acceptance ? 'acceptance' : 'objective' };
  const timeoutMs = integerFlag('timeout-ms');
  const maxTurns = integerFlag('max-turns');
  if (timeoutMs !== undefined) control.timeoutMs = timeoutMs;
  if (maxTurns !== undefined) control.maxTurns = maxTurns;
  const payload = {
    title: acceptance ? 'native agent acceptance probe' : 'native agent objective run',
    objective: acceptance
      ? 'Acceptance mode: the worker uses its fixed in-code probe prompt and ignores this text.'
      : objective,
    context: JSON.stringify(control)
  };

  const suppliedKey = flag('key');
  const idempotencyKey = suppliedKey === undefined
    ? `native-agent-${acceptance ? 'acceptance' : 'objective'}-${crypto.randomBytes(8).toString('hex')}`
    : suppliedKey;
  const submitted = await tasks.submit({
    queue: QUEUE,
    type: TASK_TYPE,
    idempotencyKey,
    payload,
    // The native agent holds real local capability, so a lost lease is never
    // silently replayed: an expired running lease becomes explicitly uncertain.
    expiryPolicy: 'uncertain',
    maxAttempts: 1
  });
  process.stdout.write(`${JSON.stringify({
    ok: true, taskId: submitted.taskId, queue: QUEUE, type: TASK_TYPE,
    status: submitted.status, replayed: submitted.replayed === true,
    idempotencyKey, secretValuesEmitted: false
  })}\n`);
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    code: String((error && error.code) || 'NATIVE_AGENT_SUBMIT_FAILED').slice(0, 100),
    message: String((error && error.message) || '').replace(/\s+/g, ' ').slice(0, 300),
    secretValuesEmitted: false
  })}\n`);
  process.exitCode = 1;
});
