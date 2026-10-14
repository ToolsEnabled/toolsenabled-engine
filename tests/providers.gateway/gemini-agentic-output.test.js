'use strict';

/* THE AGENTIC GEMINI LANE READING WHAT GEMINI CLI ACTUALLY WRITES.
 *
 * The envelope below is the `--output-format json` shape of the installed
 * gemini-cli 0.58 (JsonFormatter.format(sessionId, response, stats) with
 * stats = UiTelemetryService.getMetrics()). No provider is started. */

require('../lib/isolated-environment').activate('gemini-agentic-output');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const gemini = require('../../src/lib/providers/gemini-agentic');

const WORKSPACE = path.join(os.tmpdir(), 'fake-agentic-output-workspace');
const HEAD = 'b'.repeat(40);

function modelMetrics({ requests, latency, prompt, candidates, total }) {
  return {
    api: { totalRequests: requests, totalErrors: 0, totalLatencyMs: latency, errorsByType: {} },
    tokens: { input: prompt, prompt, candidates, total, cached: 0, thoughts: total - prompt - candidates, tool: 0 },
    roles: {}
  };
}

function envelope(response, models) {
  return JSON.stringify({
    session_id: 'session-1',
    response,
    stats: {
      models,
      tools: { totalCalls: 3, totalSuccess: 3, totalFail: 0, totalDurationMs: 310, totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 3 }, byName: {} },
      files: { totalLinesAdded: 2, totalLinesRemoved: 0 }
    }
  }, null, 2);
}

function spawnWriting(chunks) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      for (const chunk of chunks) child.stdout.write(chunk);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
}

function gitRun(args, cwd) {
  const joined = args.join(' ');
  const worktreeAt = args.indexOf('worktree');
  if (joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `${WORKSPACE}\n`, stderr: '' };
  if (joined === 'rev-parse HEAD') return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
  if (joined === 'status --porcelain=v1' && cwd === WORKSPACE) return { status: 0, stdout: '', stderr: '' };
  if (args[0] === '-C' && worktreeAt >= 0) return { status: 0, stdout: '', stderr: '' };
  if (joined === 'diff --stat HEAD') return { status: 0, stdout: ' 1 file changed\n', stderr: '' };
  if (joined === 'diff --name-status -z HEAD') return { status: 0, stdout: 'M\0notes.md\0', stderr: '' };
  if (joined === 'ls-files --others --exclude-standard -z') return { status: 0, stdout: '', stderr: '' };
  if (joined === 'status --porcelain=v1') return { status: 0, stdout: ' M notes.md\n', stderr: '' };
  throw new Error(`unexpected git invocation: ${joined}`);
}

function run(chunks) {
  return gemini.runAgenticTask({ taskBrief: 'Edit notes.', workspacePath: WORKSPACE, allowedPaths: ['notes.md'] }, {
    spawnImpl: spawnWriting(chunks),
    gitRun,
    fs: { existsSync: () => false, mkdirSync: () => {}, writeFileSync: () => {} },
    now: () => 1_800_000_000_000,
    randomId: () => 'cccccccc-dddd-eeee-ffff-000000000000',
    assertActive: () => {},
    record: () => ({ ok: true }),
    executableFor: () => ({ command: 'fake-gemini', prefixArgs: [] }),
    tmpdir: () => path.join(os.tmpdir(), 'fake-agentic-output-worktrees'),
    vertexAdcPath: () => null,
    buildOnboardingPacket: () => 'TEST ONBOARDING PACKET',
    onboardingDependencies: {}
  });
}

const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (error) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(error && error.message || error).split('\n')[0].slice(0, 300)}`);
  }
}

(async () => {
  await check('the usage a real Gemini CLI envelope reports is surfaced, not called unreported', async () => {
    const stdout = envelope('Updated notes.md.', {
      'gemini-3.1-pro-preview': modelMetrics({ requests: 4, latency: 4200, prompt: 1500, candidates: 120, total: 1700 })
    });
    const result = await run([stdout]);
    assert.equal(result.summary, 'Updated notes.md.');
    assert.equal(result.statsStatus, 'reported');
    assert.deepEqual(result.stats, {
      inputTokenCount: 1500, outputTokenCount: 120, totalTokenCount: 1700, apiTimeMs: 4200, toolTimeMs: 310
    });
  });

  await check('usage from two models (a routed utility call beside the main model) is summed', async () => {
    const stdout = envelope('Done.', {
      'gemini-3.1-pro-preview': modelMetrics({ requests: 2, latency: 3000, prompt: 1000, candidates: 100, total: 1150 }),
      'gemini-2.5-flash-lite': modelMetrics({ requests: 1, latency: 200, prompt: 40, candidates: 5, total: 45 })
    });
    const result = await run([stdout]);
    assert.deepEqual(result.stats, {
      inputTokenCount: 1040, outputTokenCount: 105, totalTokenCount: 1195, apiTimeMs: 3200, toolTimeMs: 310
    });
  });

  await check('a summary whose multi-byte character straddles two pipe reads arrives intact', async () => {
    const summary = 'Résumé — café 🚀 done';
    const bytes = Buffer.from(envelope(summary, {
      'gemini-3.1-pro-preview': modelMetrics({ requests: 1, latency: 10, prompt: 1, candidates: 1, total: 2 })
    }), 'utf8');
    const rocket = bytes.indexOf(Buffer.from('🚀', 'utf8'));
    assert.ok(rocket > 0);
    const result = await run([bytes.subarray(0, rocket + 2), bytes.subarray(rocket + 2)]);
    assert.equal(result.summary, summary);
  });

  if (failures.length) throw new Error(`${failures.length} gemini agentic output check(s) failed: ${failures.join(' | ')}`);
  console.log('Gemini agentic output tests passed (3 checks; no provider was started).');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
