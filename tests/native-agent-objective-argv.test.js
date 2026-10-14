'use strict';

/* THE OBJECTIVE IS DATA, NEVER AN OPTION.
 *
 * runNativeAgent() hands the official claude CLI an UNTRUSTED objective as its
 * final argument. Measured on claude 2.1.281: without an end-of-options marker
 * an objective such as `--model=haiku` or `--permission-mode=acceptEdits` is
 * parsed as that flag (the run then refuses with "Input must be provided
 * either through stdin or as a prompt argument when using --print"), so any
 * single-word option could be supplied by whoever wrote the objective. After
 * `--` the same text is the prompt and the launcher's own flags stand.
 *
 * The spawn seam is injected and refuses, so no process starts; this asserts
 * the argv the launcher would have run.
 */

const assert = require('node:assert/strict');
const { runNativeAgent } = require('../sidecars/native-agent/src/native-agent-launcher.js');

const HOSTILE_OBJECTIVES = Object.freeze([
  '--model=haiku',
  '--permission-mode=acceptEdits',
  '--mcp-config=/tmp/not-the-launcher-config.json',
  '-p'
]);

async function main() {
  const savedExecutable = process.env.NATIVE_AGENT_CLAUDE_EXE;
  // Any existing regular file satisfies the executable check; nothing is run.
  process.env.NATIVE_AGENT_CLAUDE_EXE = process.execPath;
  let checks = 0;
  try {
    for (const objective of HOSTILE_OBJECTIVES) {
      let seen = null;
      const result = await runNativeAgent({ objective, timeoutMs: 60000 }, {
        spawnImpl(file, args) {
          seen = args.slice();
          throw new Error('fixture: the argv is inspected, never run');
        }
      });
      assert.equal(result.code, 'NATIVE_AGENT_SPAWN_FAILED', 'the fixture spawn must be the one that ran');
      assert.ok(Array.isArray(seen), 'the launcher never reached its spawn seam');
      assert.equal(seen[seen.length - 1], objective, 'the objective must be the final argument');
      assert.equal(seen[seen.length - 2], '--',
        `the objective ${JSON.stringify(objective)} is not behind an end-of-options marker, so the CLI parses it as a flag`);
      assert.equal(seen.indexOf('--'), seen.length - 2, 'no launcher flag may follow the end-of-options marker');
      checks += 1;
    }
  } finally {
    if (savedExecutable === undefined) delete process.env.NATIVE_AGENT_CLAUDE_EXE;
    else process.env.NATIVE_AGENT_CLAUDE_EXE = savedExecutable;
  }
  console.log(`native agent objective argv: ${checks} hostile objectives kept as data`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
