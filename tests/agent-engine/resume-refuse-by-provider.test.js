'use strict';

/* A CONVERSATION BELONGS TO THE PROGRAM THAT MINTED IT, AND RESUMING IT ON THE
 * OTHER ONE MUST SAY SO INSTEAD OF FAILING QUIETLY.
 *
 * Measured before this suite existed (report REPORT-cne-host-exec-and-cross-provider):
 * thread ids from both providers are UUID-shaped, `validateThreadId` is a bare
 * string-length check, and nothing anywhere compares the thread's origin against
 * the adapter about to run it. So a Claude id handed to Codex spawned the wrong
 * CLI, which took about three seconds to exit with "No conversation found with
 * session ID" -- and the failure return had the SAME SHAPE as a success. The
 * caller could not tell them apart. Verdict in that report: SILENT-EXIT.
 *
 * WHERE THE GATE HAS TO SIT, and why it is not `resumeThread`. By the time
 * `resumeThread` runs, the child already exists: resumeClaudeSession has built
 * its transport, and resumeCodexSession has spawned TWICE (detectCodexVersion,
 * then the transport). A refusal there has already paid for the spawn it exists
 * to avoid. So the gate is at the top of the process-layer functions, and these
 * checks assert that by proving NO PROCESS STARTED.
 *
 *   Claude side: the stand-in child writes a marker file, so a spawn leaves
 *   physical evidence. Refused means the marker is not there.
 *   Codex side: the command names a binary that does not exist, so reaching the
 *   spawn produces a spawn failure with a different code. Refused means our code
 *   came back instead.
 *
 * ABSENT IS NOT MISMATCHED. Every thread minted before 1.0.42 has no recorded
 * provider, and every existing resume test resumes exactly such a thread. An
 * absent provider is therefore legacy-PERMITTED and proceeds; what protects it
 * is that the failure is now failure-shaped. A thread whose provider is recorded
 * and different, or recorded and not a name this build knows, is refused.
 *
 * No real CLI is spawned and no provider account is touched.
 *
 *   node tests/run-isolated.js tests/agent-engine/resume-refuse-by-provider.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resumeClaudeSession } = require('../../src/lib/agent-engine/claude-cli-process');
const { resumeCodexSession } = require('../../src/lib/agent-engine/codex-process');
require('../helpers/scratch-state-root');

const CLAUDE_THREAD_ID = '4fcaeb8b-93ec-4a5b-97c7-4cac9e59f2d1';
const CODEX_THREAD_ID = '0b9f7a41-2c3d-4e5f-8a7b-6c5d4e3f2a1b';

let failures = 0;
async function checkAsync(name, run) {
  try {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`not ok - ${name}\n  ${error && error.message}\n`);
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-resume-provider-'));
/* A binary that is not there. Reaching the spawn fails on THIS, with a code
   that is not the refusal's -- which is how "it never got that far" is told
   apart from "it got there and something else went wrong". */
const MISSING_COMMAND = path.join(scratch, 'no-such-program-should-never-run.exe');

/* A stand-in child in the shape the existing suite already uses
   (`command: process.execPath`), with one addition: it records that it ran.
   A spawn is then a fact on disk rather than an inference. */
function spawnMarker(name) {
  const marker = path.join(scratch, `${name}.spawned`);
  return {
    marker,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1'); require('node:readline').createInterface({input:process.stdin}).on('line', line => { const p=JSON.parse(line); if(p.type === 'control_request' && p.request.subtype === 'initialize') process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:p.request_id}})+'\\n'); });`],
    ran: () => fs.existsSync(marker),
  };
}

async function rejection(run) {
  try {
    const session = await run();
    if (session && typeof session.close === 'function') session.close();
    return null;
  } catch (error) {
    return error;
  }
}

/* The child writes its marker on its own schedule, so a permitted start is
   confirmed by waiting for it rather than by reading the instant the promise
   settles. Bounded: a start that never spawns fails the check by timing out
   here, which is the answer we want, not a hang. */
async function spawnedWithin(spawned, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (spawned.ran()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return spawned.ran();
}

/* A start that the gate must LET THROUGH. Returns what happened so the check can
   say both things that matter: the provider did not refuse it, and a program
   really was started -- which is what proves the gate was passed rather than
   silently skipped. */
async function permittedStart(name, options) {
  const spawned = spawnMarker(name);
  let session = null;
  let error = null;
  try {
    session = await resumeClaudeSession({ command: process.execPath, args: spawned.args, ...options });
  } catch (caught) {
    error = caught;
  }
  const ran = await spawnedWithin(spawned);
  if (session && typeof session.close === 'function') session.close();
  return { error, ran };
}

(async () => {
  await checkAsync('a Claude-minted thread resumed as Codex is refused by name, and no process is started', async () => {
    const error = await rejection(() => resumeCodexSession({
      threadId: CLAUDE_THREAD_ID,
      threadProvider: 'claude',
      command: MISSING_COMMAND,
      env: process.env,
    }));
    assert.ok(error, 'a cross-provider resume must reject, not resolve');
    assert.equal(error.code, 'RESUME_PROVIDER_MISMATCH',
      `expected the refusal, got ${error.code}: ${error.message}`);
    assert.match(error.message, /Claude/, 'the sentence must name the provider that owns the conversation');
    assert.match(error.message, /Codex/, 'the sentence must name the provider it was asked to resume on');
  });

  await checkAsync('a Codex-minted thread resumed as Claude is refused by name, and no process is started', async () => {
    const spawned = spawnMarker('claude-mismatch');
    const error = await rejection(() => resumeClaudeSession({
      threadId: CODEX_THREAD_ID,
      threadProvider: 'codex',
      command: process.execPath,
      args: spawned.args,
    }));
    assert.ok(error, 'a cross-provider resume must reject, not resolve');
    assert.equal(error.code, 'RESUME_PROVIDER_MISMATCH',
      `expected the refusal, got ${error.code}: ${error.message}`);
    assert.match(error.message, /Codex/, 'the sentence must name the provider that owns the conversation');
    assert.match(error.message, /Claude/, 'the sentence must name the provider it was asked to resume on');
    assert.equal(spawned.ran(), false,
      'the refusal must come BEFORE the spawn -- a child process was started');
  });

  await checkAsync('a thread whose recorded provider is not a name this build knows is refused, never assumed to match', async () => {
    const spawned = spawnMarker('claude-unknown');
    const error = await rejection(() => resumeClaudeSession({
      threadId: CLAUDE_THREAD_ID,
      threadProvider: 'some-engine-from-the-future',
      command: process.execPath,
      args: spawned.args,
    }));
    assert.ok(error, 'an unrecognised recorded provider must reject');
    assert.equal(error.code, 'RESUME_PROVIDER_UNKNOWN',
      `expected the unknown-provider refusal, got ${error.code}: ${error.message}`);
    assert.equal(spawned.ran(), false, 'nothing may be spawned for a provider we cannot identify');
  });

  await checkAsync('a thread minted before providers were recorded still resumes -- absent is legacy-permitted, not refused', async () => {
    /* THE COMPATIBILITY CASE, and the reason "unknown is refused" could not be
       written the obvious way: every resume test in this repository, and four in
       the app, resume a thread with no recorded provider. Refusing those would
       have broken them all. Proof it passed the gate is positive, not inferred:
       a program really was started. */
    const { error, ran } = await permittedStart('claude-legacy', { threadId: CLAUDE_THREAD_ID });
    assert.equal(error, null, `an absent provider must not be refused, got ${error && error.code}`);
    assert.equal(ran, true, 'a legacy thread must still reach the program that resumes it');
  });

  await checkAsync('a thread resumed on the provider that minted it is not refused', async () => {
    const { error, ran } = await permittedStart('claude-match', {
      threadId: CLAUDE_THREAD_ID,
      threadProvider: 'claude',
    });
    assert.equal(error, null, `a matching provider must never be refused, got ${error && error.code}`);
    assert.equal(ran, true, 'a matching provider must reach the program that resumes it');
  });

  await checkAsync('the provider is compared by identity, not by the casing or spacing it was stored with', async () => {
    /* A record written by a different surface must not become a false refusal
       over whitespace. Asserted by calling with values rather than by pinning
       how the comparison is spelled. */
    const { error, ran } = await permittedStart('claude-casing', {
      threadId: CLAUDE_THREAD_ID,
      threadProvider: '  Claude  ',
    });
    assert.equal(error, null,
      `the same provider recorded with different casing was refused, got ${error && error.code}`);
    assert.equal(ran, true, 'a matching provider must reach the program that resumes it');
  });

  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a scratch dir that will not delete is not a failure */ }
  process.stdout.write(`# failures ${failures}\n`);
  process.exitCode = failures ? 1 : 0;
})();
