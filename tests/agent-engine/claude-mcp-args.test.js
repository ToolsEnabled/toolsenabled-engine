'use strict';

/* THE PRODUCT'S TOOLS REACH THE PRODUCT'S OWN CLAUDE SESSIONS.
 *
 * WHAT WAS MEASURED, from inside a real in-app Claude session on 2026-08-19:
 * "no ToolsEnabled MCP server is connected" -- the session's own words. The
 * generator was right (the tool matrix measured 111/244/272 tools per tier
 * through the generated document at the stdio level) and the swarm lane in
 * src/lib/mission-bridge/actions.js already passes `--mcp-config`; the ONE
 * place that never did was the argv every in-app session is spawned from.
 *
 * FLAGS ESTABLISHED FROM `claude --help` ON 2.1.186, not assumed:
 *   --mcp-config <configs...>   Load MCP servers from JSON files or strings
 *   --strict-mcp-config         Only use MCP servers from --mcp-config,
 *                               ignoring all other MCP configurations
 * `--strict-mcp-config` is passed WITH the file, deliberately: without it the
 * session would also load whatever MCP servers the cwd's own project files
 * declare, and the product's tool surface would depend on which folder the
 * person happened to point the session at. The recorded level decides the
 * surface; a directory must not widen it.
 *
 * THE FORWARDING PROOF HERE IS THE CHILD'S OWN ARGV. An earlier revision
 * asserted a substring count over the module source, which passes on exactly
 * the refactor it exists to catch. What is asserted now is the argv of the
 * process the engine actually spawned. A harmless executable reports its own
 * received argv; this works through the retained Windows Job wrapper too,
 * whose ChildProcess-like facade intentionally is not Node's direct child.
 * No provider is launched, money moved, or sign-in touched.
 *
 *   node tests/run-isolated.js tests/agent-engine/claude-mcp-args.test.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const isolated = require('../lib/isolated-environment').activate('claude-argv-proof');

// Its own throwaway TOOLSENABLED_STATE_ROOT: two checks below reach the session
// spool, and the services-root resolver refuses without one rather than falling
// back to a literal that would be the REAL product's state. See the helper.
require('../helpers/scratch-state-root');

const { claudeArgs, claudeResumeArgs, claudeServerPermissionRule } = require('../../src/lib/agent-engine/claude-cli-adapter');
const { startClaudeSession, resumeClaudeSession } = require('../../src/lib/agent-engine/claude-cli-process');

const THREAD_ID = '4fcaeb8b-93ec-4a5b-97c7-4cac9e59f2d1';
const MCP_CONFIG = path.join(__dirname, 'fixture-home', '.mcp.json');
const SETTINGS = path.join(__dirname, 'fixture-home', 'settings.json');

const peer = path.join(__dirname, '../fixtures/claude-argv-peer.cjs');
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const throwawayRuntime = path.join(isolated.root, process.platform === 'win32' ? 'claude-argv-peer.cmd' : 'claude-argv-peer');
fs.writeFileSync(throwawayRuntime, process.platform === 'win32'
  ? `@echo off\r\n"${process.execPath}" "${peer}" %*\r\n`
  : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(peer)} "$@"\n`, { mode: 0o700 });
let nextObservation = 0;
async function bounded(promise, label, milliseconds = 15_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not complete within ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function observedSession(start, options, inspect) {
  const output = path.join(isolated.root, `received-argv-${++nextObservation}.json`);
  let child = null;
  let checks = 0;
  let session;
  let observed;
  try {
    session = await start({ ...options, command: throwawayRuntime, cwd: isolated.root,
      env: { ...process.env, TOOLSENABLED_TEST_CLAUDE_ARGV_OUTPUT: output },
      rootLaunch: { beforeRootSpawn() { checks++; }, spawned(value) { assert.equal(child, null); child = value; } },
    });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(fs.existsSync(output), true, 'the actual child must execute and report its received argv');
    observed = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.ok(Number.isInteger(observed.pid) && observed.pid > 0);
    assert.equal(checks, 1, 'the session root crosses its final admission boundary exactly once');
    assert.deepEqual(observed.configDirectories, options.plan?.configDir ? [path.resolve(options.plan.configDir)] : [],
      'the actual child must receive exactly the plan-selected configuration directory, or none');
    await inspect(session, observed.argv);
  } finally {
    const closed = child && !child.jobClosed && child.exitCode === null && child.signalCode === null ? once(child, 'close') : null;
    session?.close();
    if (child?.jobClosed) {
      await bounded(child.jobClosed, 'retained Job closure');
      const outcome = await bounded(child.jobOutcome, 'retained Job outcome');
      assert.equal(outcome.activeProcesses, 0, 'no argv-fixture descendant may survive cleanup');
      process.stdout.write(`ARGV CHILD: ${JSON.stringify({ pid: observed?.pid, checks, activeProcesses: outcome.activeProcesses })}\n`);
    } else if (closed) await bounded(closed, 'argv child closure');
  }
}

let failures = 0;
/* Inline, no timer: a deferred summary would print PASS and set the exit code
   before a late asynchronous assertion could land -- a false green baked into
   the harness itself. Async checks are awaited by run() before the summary. */
function check(name, run) {
  try {
    run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`not ok - ${name}\n  ${error && error.message}\n`);
  }
}
async function checkAsync(name, run) {
  try {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`not ok - ${name}\n  ${error && error.message}\n`);
  }
}

async function main() {
  check('a named MCP config rides the argv, with the strictness that makes it the whole surface', () => {
    const args = claudeArgs({ threadId: THREAD_ID, threadOptions: {}, mcpConfig: MCP_CONFIG });
    const at = args.indexOf('--mcp-config');
    assert.ok(at >= 0, 'the argv never names the MCP config, so the session starts with no product tools');
    assert.equal(args[at + 1], MCP_CONFIG, 'the flag is present but does not carry the generated file');
    assert.ok(args.includes('--strict-mcp-config'),
      'without --strict-mcp-config the cwd\'s own project MCP files widen the surface the level decided');
  });

  check('no MCP config means the argv this engine has always produced, byte for byte', () => {
    for (const absent of [undefined, null]) {
      const args = claudeArgs({ threadId: THREAD_ID, threadOptions: {}, mcpConfig: absent });
      assert.ok(!args.includes('--mcp-config'), 'an absent config still put --mcp-config on the argv');
      assert.ok(!args.includes('--strict-mcp-config'), 'an absent config still put --strict-mcp-config on the argv');
    }
    assert.deepEqual(
      claudeArgs({ threadId: THREAD_ID, threadOptions: {} }),
      claudeArgs({ threadId: THREAD_ID, threadOptions: {}, mcpConfig: null }),
      'omitting the option and passing null produce different argv'
    );
  });

  check('a resume keeps the tools it had, and never names a new session -- structurally', () => {
    /* The resume argv is BUILT without the start flag rather than filtered
       after the fact: the old filter dropped the element AFTER any
       '--session-id' token, so a model string literally equal to the flag
       would have deleted --mcp-config from the argv and left a dangling
       --strict-mcp-config. The hostile model below is exactly that string. */
    const args = claudeResumeArgs({
      threadId: THREAD_ID,
      threadOptions: { model: '--session-id' },
      mcpConfig: MCP_CONFIG
    });
    const at = args.indexOf('--mcp-config');
    assert.ok(at >= 0, 'the resume argv dropped the MCP config');
    assert.equal(args[at + 1], MCP_CONFIG);
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--resume') + 1], THREAD_ID);
    /* The literal appears exactly once: as the model VALUE, behind --model,
       never as a flag of its own. */
    assert.equal(args.filter(value => value === '--session-id').length, 1);
    assert.equal(args[args.indexOf('--model') + 1], '--session-id');
  });

  check('a relative MCP config path is refused rather than resolved', () => {
    let thrown = null;
    try { claudeArgs({ threadId: THREAD_ID, threadOptions: {}, mcpConfig: 'relative/.mcp.json' }); } catch (error) { thrown = error; }
    assert.ok(thrown, 'a relative MCP config path was accepted');
    assert.equal(thrown.code, 'CLAUDE_CLI_MCP_CONFIG_RELATIVE');
  });

  if (process.platform === 'win32') {
    check('a rooted-but-driveless path is refused, because it resolves against the child\'s drive', () => {
      /* path.isAbsolute('/x') is true on win32, but WHICH file it names
         depends on the drive the child happens to be on -- exactly the
         folder-dependent surface the refusal above claims to prevent. */
      for (const driveless of ['/agent-home/.mcp.json', '\\agent-home\\.mcp.json']) {
        let thrown = null;
        try { claudeArgs({ threadId: THREAD_ID, threadOptions: {}, mcpConfig: driveless }); } catch (error) { thrown = error; }
        assert.ok(thrown, `${JSON.stringify(driveless)} was accepted`);
        assert.equal(thrown.code, 'CLAUDE_CLI_MCP_CONFIG_RELATIVE');
      }
    });
  }

  check('the shipped path is normalized the same way the sign-in folder is', () => {
    /* One engine, one normalization style for one kind of fact: the config
       dir goes through path.resolve() in configDirEnvironment(), so the tool
       file does too -- mixed separators and `..` segments never reach argv. */
    const mixed = `${path.dirname(MCP_CONFIG).replace(/\\/g, '/')}/extra/../.mcp.json`;
    const args = claudeArgs({ threadId: THREAD_ID, threadOptions: {}, mcpConfig: mixed });
    assert.equal(args[args.indexOf('--mcp-config') + 1], path.resolve(mixed));
  });

  check('an MCP config that is not a path at all is refused by name', () => {
    for (const bad of [42, {}, [], true, '', '   ']) {
      let thrown = null;
      try { claudeArgs({ threadId: THREAD_ID, threadOptions: {}, mcpConfig: bad }); } catch (error) { thrown = error; }
      assert.ok(thrown, `mcpConfig ${JSON.stringify(bad)} was accepted`);
      assert.equal(thrown.code, 'CLAUDE_CLI_MCP_CONFIG_INVALID', `mcpConfig ${JSON.stringify(bad)} got the wrong refusal`);
    }
  });

  check('the plan\'s own permission mode outranks the sandbox-derived one', () => {
    /* One recorded level, ONE reader: when the confinement plan names the CLI
       mode, that word is the argv's word; the sandbox mapping remains only as
       the fail-closed fallback for callers with no plan. */
    const planned = claudeArgs({
      threadId: THREAD_ID, threadOptions: { sandbox: 'read-only' }, permissionMode: 'acceptEdits'
    });
    assert.equal(planned[planned.indexOf('--permission-mode') + 1], 'acceptEdits');
    const fallback = claudeArgs({ threadId: THREAD_ID, threadOptions: { sandbox: 'read-only' } });
    assert.equal(fallback[fallback.indexOf('--permission-mode') + 1], 'plan');
  });

  check('the server permission rule is the adapter\'s own CLI fact', () => {
    /* MEASURED grammar from 2.1.186; the confinement module imports THIS
       function for its settings grant, so a CLI bump has one place to update.
       (The repo's developer-facing settings templates use tool-level styles
       on purpose; the generated grant stays the bare server-level form.) */
    assert.equal(claudeServerPermissionRule('toolsenabled'), 'mcp__toolsenabled');
  });

  /* ---- the spawn itself: the join travels, or the refusal is by name ---- */

  check('the grant rides the argv, because tools without it are advertised and uncallable', () => {
    /* MEASURED on claude 2.1.186: a --print session has nobody to ask for
       permission, so without --settings the configured servers connect and
       every call comes back permission-not-granted. That failure LOOKS like
       success, which is why the grant is asserted on the argv and not inferred
       from the tool file being present. */
    const args = claudeArgs({ threadId: THREAD_ID, threadOptions: {}, mcpConfig: MCP_CONFIG, settings: SETTINGS });
    const at = args.indexOf('--settings');
    assert.ok(at >= 0, 'the argv never names the grant, so every configured tool answers permission-not-granted');
    assert.equal(args[at + 1], SETTINGS, 'the flag is present but does not carry the generated grant');
  });

  check('no grant means the argv this engine has always produced, byte for byte', () => {
    for (const absent of [undefined, null]) {
      const args = claudeArgs({ threadId: THREAD_ID, threadOptions: {}, settings: absent });
      assert.ok(!args.includes('--settings'), 'an absent grant still put --settings on the argv');
    }
    assert.deepEqual(
      claudeArgs({ threadId: THREAD_ID, threadOptions: {} }),
      claudeArgs({ threadId: THREAD_ID, threadOptions: {}, settings: null }),
      'omitting the option and passing null produce different argv'
    );
  });

  check('a grant that could resolve anywhere but the plan\'s file is refused, not repaired', () => {
    /* Same grounds as the tool file: a relative path resolves against the
       child's working directory -- the person's project folder -- and on
       Windows a rooted-but-driveless path resolves against whatever drive the
       child is on. A grant is the worst file to read somebody else's copy of. */
    for (const bad of ['settings.json', './settings.json']) {
      assert.throws(() => claudeArgs({ threadId: THREAD_ID, threadOptions: {}, settings: bad }),
        error => error.code === 'CLAUDE_CLI_SETTINGS_RELATIVE', `a relative grant (${bad}) was accepted`);
    }
    if (process.platform === 'win32') {
      assert.throws(() => claudeArgs({ threadId: THREAD_ID, threadOptions: {}, settings: '\\x\\settings.json' }),
        error => error.code === 'CLAUDE_CLI_SETTINGS_RELATIVE', 'a driveless grant path was accepted');
    }
    for (const empty of ['', '   ', 42]) {
      assert.throws(() => claudeArgs({ threadId: THREAD_ID, threadOptions: {}, settings: empty }),
        error => error.code === 'CLAUDE_CLI_SETTINGS_INVALID', 'a grant that is not a path at all was accepted');
    }
  });

  await checkAsync('the SHIPPED plan spawns tools and grant with no home and no config directory', async () => {
    /* THE WHOLE POINT OF THE SHIPPED LEG. The plan the app calls carries a null
       configDir, so the child must be spawned with the tool file AND the grant
       and with no CLAUDE_CONFIG_DIR anywhere in its environment -- nothing that
       could reach the person's own sign-in. */
    const plan = {
      configDir: null,
      mcpConfig: MCP_CONFIG,
      settings: SETTINGS,
      claudePermissionMode: 'acceptEdits'
    };
    await observedSession(startClaudeSession, { plan, threadOptions: { sandbox: 'read-only' } }, (session, spawned) => {
      assert.equal(spawned[spawned.indexOf('--mcp-config') + 1], MCP_CONFIG, 'the spawned argv does not carry the plan\'s tool file');
      assert.ok(spawned.includes('--strict-mcp-config'));
      assert.equal(spawned[spawned.indexOf('--settings') + 1], SETTINGS, 'the spawned argv does not carry the plan\'s grant');
      assert.equal(spawned[spawned.indexOf('--permission-mode') + 1], 'acceptEdits');
      assert.equal(session.configDir, null, 'the shipped plan reported a home; nothing may relocate the session');
      assert.equal(session.settings, SETTINGS);
    });
  });

  await checkAsync('a session started from a PLAN carries the plan\'s home, tools and mode in one spawn', async () => {
    /* The three facts travel on ONE object, so a home without its tool file --
       or a tool file into the owner's own home -- cannot be assembled from two
       different plans. The harmless child's own receipt reports its actual
       argv and configuration directory, not wrapper metadata or a conversation. */
    const plan = {
      configDir: path.dirname(MCP_CONFIG),
      mcpConfig: MCP_CONFIG,
      claudePermissionMode: 'acceptEdits'
    };
    await observedSession(startClaudeSession, { plan, threadOptions: { sandbox: 'read-only' } }, (session, spawned) => {
      assert.equal(spawned[spawned.indexOf('--mcp-config') + 1], MCP_CONFIG, 'the spawned argv does not carry the plan\'s tool file');
      assert.ok(spawned.includes('--strict-mcp-config'));
      assert.equal(spawned[spawned.indexOf('--permission-mode') + 1], 'acceptEdits', 'the plan\'s mode did not reach the argv');
      assert.equal(session.configDir, plan.configDir, 'the session does not report the plan\'s home');
      assert.equal(session.mcpConfig, plan.mcpConfig);
    });
  });

  await checkAsync('a RESUMED session keeps the same plan in its spawn', async () => {
    const plan = { configDir: path.dirname(MCP_CONFIG), mcpConfig: MCP_CONFIG, claudePermissionMode: 'plan' };
    await observedSession(resumeClaudeSession, { plan, threadId: THREAD_ID }, (session, spawned) => {
      assert.equal(spawned[spawned.indexOf('--mcp-config') + 1], MCP_CONFIG, 'the resume spawn dropped the tool file');
      assert.equal(spawned[spawned.indexOf('--resume') + 1], THREAD_ID);
      assert.ok(!spawned.includes('--session-id'), 'a resume also declared a new session id');
    });
  });

  await checkAsync('a caller-built argv beside a tool file is refused, never silently merged or dropped', async () => {
    /* `args` replaces the whole generated argv, so the tool file would be
       silently discarded -- a confined home with no --mcp-config, loading
       whatever .mcp.json sits in the child's folder. The silence is the
       defect; the refusal is the fix, and it fires before any spawn. */
    await assert.rejects(
      startClaudeSession({ args: ['--print'], mcpConfig: MCP_CONFIG }),
      error => error.code === 'CLAUDE_CLI_MCP_CONFIG_CONFLICT'
    );
    await assert.rejects(
      resumeClaudeSession({ args: ['--print'], mcpConfig: MCP_CONFIG, threadId: THREAD_ID }),
      error => error.code === 'CLAUDE_CLI_MCP_CONFIG_CONFLICT'
    );
  });

  await checkAsync('a plan beside separate settings is refused, so nothing silently loses', async () => {
    await assert.rejects(
      startClaudeSession({ plan: { mcpConfig: MCP_CONFIG }, configDir: 'C:\\somewhere' }),
      error => error.code === 'CLAUDE_CLI_PLAN_CONFLICT'
    );
    await assert.rejects(
      startClaudeSession({ plan: { mcpConfig: MCP_CONFIG }, args: ['--print'] }),
      error => error.code === 'CLAUDE_CLI_PLAN_CONFLICT'
    );
    await assert.rejects(
      startClaudeSession({ plan: 'not-a-plan' }),
      error => error.code === 'CLAUDE_CLI_PLAN_INVALID'
    );
  });

  await checkAsync('an empty or malformed argv is refused, because [] spawns the CLI bare', async () => {
    /* `[]` is truthy: the old `args || claudeArgs(...)` spawned claude with NO
       argv at all -- an interactive session with no stream-json framing that
       the adapter would wait on forever. */
    for (const bad of [[], ['ok', 42], 'not-a-list']) {
      await assert.rejects(
        startClaudeSession({ args: bad }),
        error => error.code === 'CLAUDE_CLI_ARGS_INVALID',
        `args ${JSON.stringify(bad)} was accepted`
      );
    }
  });

  process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'} - claude-mcp-args (${failures} failing)\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(error => {
  process.stdout.write(`not ok - harness: ${error && error.stack}\n`);
  process.exitCode = 1;
});
