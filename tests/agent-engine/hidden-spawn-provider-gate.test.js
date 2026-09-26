'use strict';

/* THE NO-PROVIDER SWITCH, AND THE CLAIM THAT IT IS THE ONLY DOOR.
 *
 * WHY THIS TEST EXISTS. tools/agent-dispatch-packaged-qa.mjs fenced provider
 * spend with an environment: no PATH, no APPDATA, no credentials. Measured
 * 2026-09-02, a real Codex worker started anyway from the owner's roaming npm
 * install. The fence could not work, because shell/agent-host.cjs recomposes
 * the search path from the REGISTRY on purpose, and agent-engine/
 * codex-process.js falls back to the ambient environment when a caller does not
 * thread one through. Both bypasses act on the CHILD environment; neither can
 * touch the spawning process's own process.env. So the gate is read there.
 *
 * WHAT IS ASSERTED, in the order that matters:
 *   1. With the switch set, spawnHidden refuses by NAME and starts nothing.
 *   2. Without it, an ordinary spawn still works -- a gate that refused
 *      everything would pass check 1 while breaking the product.
 *   3. A caller cannot buy its way out by passing options.env. This is the
 *      check that distinguishes this gate from the fence that already failed.
 *   4. The known paid provider modules still route through spawnHidden. The
 *      local HTTP model runtime stays outside that process gate, while its MCP
 *      tool-server transport legitimately shares the hidden child helper.
 *
 * CAN-FAIL AUDIT (2026-09-02)
 * SUSPECT: check 1 could pass because spawnHidden throws for some unrelated
 * reason. Mutation: changed the thrown code in src/lib/proc/hidden-spawn.js
 * from HIDDEN_SPAWN_PROVIDER_REFUSED to HIDDEN_SPAWN_PROVIDER_REFUSEDX. RED:
 *   AssertionError: the refusal must name itself HIDDEN_SPAWN_PROVIDER_REFUSED
 * Restored, GREEN again. Second mutation: made providerSpawnRefused() read
 * `environment` instead of process.env, i.e. reintroduced exactly the
 * caller-supplied-environment bypass this gate exists to close. Check 3 went
 * RED (`a caller must not be able to bypass the gate with options.env`) while
 * checks 1 and 2 stayed green -- which is the point of having check 3.
 * NOT-FOUND: no try/catch in this file swallows a failure; no mock replaces
 * spawnHidden; check 2 asserts on a real child process's exit, not on a
 * truthy return.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  HiddenSpawnError,
  PROVIDER_SPAWN_REFUSAL_VARIABLE,
  providerSpawnRefused,
  spawnHidden,
} = require('../../src/lib/proc/hidden-spawn');

const SRC = path.join(__dirname, '..', '..', 'src');

/* The paid providers, repository-relative, and the free tier that must stay
   outside the gate. Written as paths rather than basenames so the existence
   assertions below cannot be satisfied by a same-named file elsewhere. */
const PAID_PROVIDER_MODULES = Object.freeze([
  path.join('lib', 'agent-engine', 'codex-process.js'),
  path.join('lib', 'agent-engine', 'claude-process.js'),
  path.join('lib', 'agent-engine', 'claude-cli-process.js'),
]);
const FREE_LOCAL_MODULE = path.join('lib', 'providers', 'local-node-runtime.js');
const LOCAL_TOOL_TRANSPORT = path.join('lib', 'agent-engine', 'local-node-tools.js');

/* Every .js under src/, so the sweep below is a statement about the whole tree
   rather than about a directory somebody remembered to look in. */
function sourceFiles(directory = SRC, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.isFile() && entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

function withSwitch(value, body) {
  const had = Object.hasOwn(process.env, PROVIDER_SPAWN_REFUSAL_VARIABLE);
  const previous = process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE];
  if (value === undefined) delete process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE];
  else process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE] = value;
  try {
    return body();
  } finally {
    if (had) process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE] = previous;
    else delete process.env[PROVIDER_SPAWN_REFUSAL_VARIABLE];
  }
}

async function run() {
  // ---- 1. Set: refused by name, and nothing started. --------------------
  withSwitch('1', () => {
    let raised = null;
    try {
      spawnHidden(process.execPath, ['-e', 'process.exit(0)']);
    } catch (error) {
      raised = error;
    }
    assert.ok(raised, 'a spawn must be refused while the switch is set');
    assert.ok(raised instanceof HiddenSpawnError, 'the refusal must be a HiddenSpawnError');
    assert.strictEqual(
      raised.code,
      'HIDDEN_SPAWN_PROVIDER_REFUSED',
      'the refusal must name itself HIDDEN_SPAWN_PROVIDER_REFUSED',
    );
    assert.match(
      raised.message,
      /no paid provider process was started/i,
      'the refusal must say plainly that nothing was started',
    );
  });

  // The value semantics, pinned: only an explicit 1/true refuses, so an
  // inherited empty variable cannot silently stop a paying customer.
  assert.strictEqual(providerSpawnRefused({ [PROVIDER_SPAWN_REFUSAL_VARIABLE]: '1' }), true);
  assert.strictEqual(providerSpawnRefused({ [PROVIDER_SPAWN_REFUSAL_VARIABLE]: 'true' }), true);
  assert.strictEqual(providerSpawnRefused({ [PROVIDER_SPAWN_REFUSAL_VARIABLE]: ' TRUE ' }), true);
  assert.strictEqual(providerSpawnRefused({ [PROVIDER_SPAWN_REFUSAL_VARIABLE]: '' }), false);
  assert.strictEqual(providerSpawnRefused({ [PROVIDER_SPAWN_REFUSAL_VARIABLE]: '0' }), false);
  assert.strictEqual(providerSpawnRefused({}), false);

  // ---- 2. Unset: an ordinary spawn still runs. ---------------------------
  // A gate that refused unconditionally would satisfy check 1 and break the
  // product, so this asserts on a real child's exit code.
  const exitCode = await withSwitch(undefined, () => new Promise((resolve, reject) => {
    const child = spawnHidden(process.execPath, ['-e', 'process.exit(7)']);
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  }));
  assert.strictEqual(exitCode, 7, 'without the switch a spawn must still start and run to completion');

  // ---- 3. A caller cannot buy its way out with options.env. --------------
  // This is the check that separates this gate from the environment fence that
  // already failed in the field.
  withSwitch('1', () => {
    let raised = null;
    try {
      spawnHidden(process.execPath, ['-e', 'process.exit(0)'], {
        env: { PATH: process.env.PATH || '' },
      });
    } catch (error) {
      raised = error;
    }
    assert.ok(raised, 'a caller must not be able to bypass the gate with options.env');
    assert.strictEqual(raised.code, 'HIDDEN_SPAWN_PROVIDER_REFUSED');
  });

  // ---- 4. The single-gate claim, swept rather than sampled. --------------
  const files = sourceFiles();
  assert.ok(files.length > 100, `the sweep found only ${files.length} source files; it is not reaching the tree`);

  const REQUIRE_RE = /require\(\s*['"][^'"]*proc\/hidden-spawn['"]\s*\)/;
  const requirers = files
    .filter(file => REQUIRE_RE.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(SRC, file))
    .sort();

  /* A shared child-process helper may gain other consumers. That cannot remove
     these providers' gate, and an exact consumer count never detected a NEW
     provider that bypassed it anyway. This coverage names the known providers;
     it does not pretend this require sweep classifies every future provider. */
  for (const module of PAID_PROVIDER_MODULES) {
    assert.ok(requirers.includes(module), `${module} must retain the shared provider-spawn gate`);
    assert.match(fs.readFileSync(path.join(SRC, module), 'utf8'), /\bspawnHidden\(/,
      `${module} must call the helper, not merely import it`);
  }

  /* Each named file must actually exist, so a rename cannot turn the
     assertions above into a vacuous pass over an empty set. */
  for (const module of [...PAID_PROVIDER_MODULES, FREE_LOCAL_MODULE]) {
    assert.ok(fs.existsSync(path.join(SRC, module)), `${module} is missing; this test would otherwise pass vacuously`);
  }

  assert.ok(
    !REQUIRE_RE.test(fs.readFileSync(path.join(SRC, FREE_LOCAL_MODULE), 'utf8')),
    `${FREE_LOCAL_MODULE} must NOT route through the paid gate; the free local tier is deliberately unaffected`,
  );

  // A local model is HTTP, but its MCP server is a real child. Prove that this
  // additional consumer obeys the same switch; never launch a server here.
  assert.ok(requirers.includes(LOCAL_TOOL_TRANSPORT));
  const { createMcpStdioTransport } = require(path.join(SRC, LOCAL_TOOL_TRANSPORT));
  withSwitch('1', () => {
    assert.throws(() => createMcpStdioTransport({ command: process.execPath,
      args: ['-e', 'process.exit(0)'], env: { PATH: process.env.PATH || '' } }),
    error => error instanceof HiddenSpawnError && error.code === 'HIDDEN_SPAWN_PROVIDER_REFUSED',
    'the local MCP child cannot bypass the process gate with a caller environment');
  });

  console.log(
    `hidden-spawn provider gate: refused by name with the switch, spawned without it, `
    + `options.env cannot bypass, ${PAID_PROVIDER_MODULES.length} known paid modules among ${requirers.length} helper consumers, `
    + `local HTTP model ungated and local MCP child gated`,
  );
}

run().catch(error => {
  process.exitCode = 1;
  console.error(error);
});
