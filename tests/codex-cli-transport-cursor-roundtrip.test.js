'use strict';

// THE ROUND TRIP, AS A PROPERTY: whatever listTasks() hands back as `cursor`,
// listTasks() must accept back.
//
// EVIDENCE. The live action log carries fourteen `mcp.tool.failed` records for
// target `cloud.task_status` whose error is the transport's own INPUT refusal,
// "listTasks cursor must be a bounded opaque token when provided."
// cloudTaskStatus() never invents a cursor -- it pages with `cursor =
// listed.cursor` and nothing else -- so every one of those refusals was about a
// value listTasks() had returned on the page before. Two contracts for one
// value, and the second page of any cloud status read died between them.
//
// WHY THIS SUITE EXISTS SEPARATELY FROM THE INSTANCE CHECKS IN
// tests/codex-cli-transport.test.js, which pin the real 2026-09-03 cursor
// captured from codex-cli 0.146.1. Those prove the rule admits the cursor the
// CLI emits TODAY. This proves the INVARIANT that made the gap possible in the
// first place, over a spread of shapes, so that a future narrowing or widening
// of the accept rule cannot reopen it on a shape nobody had a sample of. It
// deliberately never spells the character class: every check reads the accept
// rule only through the transport's own behaviour, so the suite stays true
// whatever the class becomes.
//
// AND IT PINS THE ONE THING THAT MAY NEVER BE TRADED AWAY TO CLOSE THE GAP: a
// cursor is pushed into argv as the value of `--cursor`, so a leading "-", a
// whitespace character, a control byte, an empty string and an oversized string
// stay refused before any child process is spawned.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createCodexCliTransport } = require('../src/lib/cloud-agent/codex-cli-transport');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');

let checks = 0;
const asyncCheck = async (label, fn) => { await fn(); checks += 1; void label; };

async function rejectsWithCode(promise, expectedCode) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof CloudAgentError, `expected a CloudAgentError, got ${error && error.constructor && error.constructor.name}`);
    assert.equal(error.code, expectedCode, `expected code ${expectedCode}, got ${error.code}: ${error.message}`);
    return true;
  });
}

function fakeChild(spec) {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.kill = () => true;
  setImmediate(() => {
    if (spec.stdout) child.stdout.emit('data', spec.stdout);
    setImmediate(() => child.emit('close', 0));
  });
  return child;
}

function fakeSpawn(route) {
  const calls = [];
  const impl = (command, args, options) => {
    const spec = route(command, args, options) || {};
    calls.push({ command, args: [...args], options });
    return fakeChild(spec);
  };
  impl.calls = calls;
  return impl;
}

const TASK_ID = 'task_e_abc123DEF456';

function listPage(cursor) {
  return JSON.stringify({
    tasks: [{
      id: TASK_ID,
      url: `https://chatgpt.com/codex/tasks/${TASK_ID}`,
      title: 'a listed task',
      status: 'ready',
      updated_at: '2026-08-08T00:00:00Z',
      environment_id: null,
      environment_label: 'Owner/repo',
      summary: { files_changed: 1 },
      is_review: false,
      attempt_total: 1
    }],
    cursor
  });
}

/* Shapes a real pagination token takes. The first is the ground-truth 2026-09-03
   cursor's shape -- a leading "+", base64 bodies, and ":" "~" "#" punctuation --
   and the rest spread across the punctuation an opaque token can carry. Every
   one of these was rejected by the accept rule that shipped before this was
   measured, while being handed out as a usable next page. */
const REALISTIC = [
  '+RID:~G4U-AJOIzhldOQcEAAjRAQ==#RT:1#TRC:1#RTD:FFMNeBmc06hP#ISV:2#IEO:65567#QCF:8#CID:2',
  'cursor-abc123',
  'AAAA+/==',
  'z',
  '9.a_b-c',
  '=eyJhIjoxfQ==',
  '/page/2',
  '_next',
  '.hidden',
  '~tilde:colon#hash',
  `+${'a'.repeat(511)}`
];

/* Emissions the transport genuinely cannot page with, whatever the class is.
   Each is a fact about argv, not a taste: a leading "-" is read as a flag, and
   whitespace, control bytes, emptiness and 513 characters are not a token. */
const UNUSABLE = ['-abc123', '--not-a-cursor', 'ab c123', 'ab\tc', 'ab\nc', `x${String.fromCharCode(0)}y`, 'a'.repeat(513)];

(async () => {
  await asyncCheck('every cursor listTasks reports can be handed straight back to listTasks', async () => {
    for (const cursor of REALISTIC) {
      const spawnImpl = fakeSpawn((command, args) => ({
        stdout: listPage(args.includes('--cursor') ? null : cursor)
      }));
      const transport = createCodexCliTransport({ spawnImpl });
      const first = await transport.listTasks({ limit: 5 });
      assert.equal(first.cursor, cursor, `page one refused to report the cursor ${JSON.stringify(cursor)}`);
      /* Exactly what cloudTaskStatus does, and the call that used to die. */
      const second = await transport.listTasks({ limit: 5, cursor: first.cursor });
      assert.equal(second.cursor, null);
      assert.deepEqual(spawnImpl.calls[1].args, ['cloud', 'list', '--json', '--limit', '5', '--cursor', cursor],
        'the cursor must reach the CLI verbatim');
    }
  });

  await asyncCheck('a cursor the transport could never send back is refused on the page that emitted it', async () => {
    for (const cursor of UNUSABLE) {
      const spawnImpl = fakeSpawn(() => ({ stdout: listPage(cursor) }));
      const transport = createCodexCliTransport({ spawnImpl });
      await rejectsWithCode(transport.listTasks({ limit: 5 }), 'CODEX_CLI_OUTPUT_UNPARSEABLE');
      assert.equal(spawnImpl.calls.length, 1,
        `${JSON.stringify(cursor)} was not caught on the page that emitted it`);
    }
  });

  await asyncCheck('the refusal states the shape required and does not blame the caller', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: listPage('-abc123') }));
    const transport = createCodexCliTransport({ spawnImpl });
    let message = '';
    await assert.rejects(transport.listTasks({ limit: 5 }), error => { message = String(error.message); return true; });
    assert.ok(/cursor/.test(message), `the refusal did not say what was wrong: ${message}`);
    assert.ok(/"-"|begin|start/i.test(message), `the refusal did not state the shape required: ${message}`);
    /* This call passed no cursor at all, so the caller's own input may not be
       named as the fault -- that sentence is what cost fourteen status reads. */
    assert.ok(!/listTasks cursor must be/.test(message),
      `the caller was told its own cursor was malformed on a call that supplied none: ${message}`);
  });

  await asyncCheck('a null cursor is still an ordinary last page', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: listPage(null) }));
    const transport = createCodexCliTransport({ spawnImpl });
    const listed = await transport.listTasks({ limit: 5 });
    assert.equal(listed.cursor, null);
    assert.equal(listed.tasks.length, 1);
  });

  await asyncCheck('the argument-injection guard on the way in is still in force', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: listPage(null) }));
    const transport = createCodexCliTransport({ spawnImpl });
    for (const cursor of UNUSABLE) {
      await rejectsWithCode(transport.listTasks({ cursor }), 'CODEX_CLI_INPUT_INVALID');
    }
    await rejectsWithCode(transport.listTasks({ cursor: '' }), 'CODEX_CLI_INPUT_INVALID');
    assert.equal(spawnImpl.calls.length, 0, 'a refused cursor must never reach a child process');
  });

  console.log(`codex-cli cursor round-trip tests passed (${checks} checks: every reported cursor is re-sendable, an unusable one is refused where it is produced, the refusal states the shape and does not blame the caller, a null cursor still ends pagination, and the inbound argv guard still holds).`);
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
