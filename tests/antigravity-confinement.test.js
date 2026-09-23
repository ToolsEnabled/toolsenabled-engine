'use strict';

/* THE DURABLE OWNERSHIP RECEIPT, DRIVEN THROUGH prepareAntigravitySurface.
 *
 * THE DEFECT THIS GUARDS: an account's Antigravity Research MCP registration
 * is written with an absolute path to the CURRENT generation's wrapper
 * script. A promotion (a new engine generation) moves that path, so a strict
 * content comparison refused the product's own prior registration as
 * foreign the moment resume ran under the new generation --
 * AGY_CLI_BOUNDARY_UNAVAILABLE on a tool call that had worked moments
 * earlier, before promotion.
 *
 * WHAT THIS SUITE DRIVES. The real prepareAntigravitySurface from
 * src/lib/agent-engine/antigravity-confinement.js, against real files under
 * a scratch directory tree with two distinct "generations" -- each its own
 * directory carrying its own src/mcp-server.js and tools/antigravity-mcp-
 * owner-proxy.js, so the wrapper path genuinely differs between them exactly
 * as an install promotion changes it. writeAtomic is the same temp-then-
 * rename implementation agent-session-confinement.js uses, so a write here
 * behaves exactly as it does live.
 *
 * Run alone with:
 *   node --test tests/antigravity-confinement.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { prepareAntigravitySurface } = require('../src/lib/agent-engine/antigravity-confinement');

const SERVER = 'toolsenabled-research';

function scratchRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-agy-confinement-'));
}

/* Real temp-then-rename, exactly as agent-session-confinement.js's own
   writeAtomic -- optionally counting calls per target file, so the
   interruption-recovery cases can assert nothing was rewritten that did not
   need to be. */
function makeWriteAtomic(counts = null) {
  return (file, contents) => {
    if (counts) counts.set(file, (counts.get(file) || 0) + 1);
    const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(temporary, contents, 'utf8');
    fs.renameSync(temporary, file);
  };
}
/* A plain real writer, for helpers below that need to call it directly
   rather than obtain a fresh counting instance each time. */
const writeAtomic = makeWriteAtomic();

/* One "generation": its own directory carrying the two real files the
   module requires to exist -- src/mcp-server.js (the script prepare looks
   for in entry.args) and tools/antigravity-mcp-owner-proxy.js (the wrapper
   it substitutes and then statSync()s). Content is irrelevant; only
   existence, regular-file-ness and the DIRECTORY LAYOUT (wrapper is a
   sibling "tools" of script's "src") matter to the code under test. */
function stageGeneration(root, name) {
  const generationRoot = path.join(root, name);
  fs.mkdirSync(path.join(generationRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(generationRoot, 'tools'), { recursive: true });
  const script = path.join(generationRoot, 'src', 'mcp-server.js');
  const wrapper = path.join(generationRoot, 'tools', 'antigravity-mcp-owner-proxy.js');
  fs.writeFileSync(script, '// fixture mcp-server.js\n');
  fs.writeFileSync(wrapper, '// fixture antigravity-mcp-owner-proxy.js\n');
  return { generationRoot, script, wrapper };
}

function entriesFor(script, { extraEnv = {} } = {}) {
  return [['toolsenabled', {
    command: 'node',
    args: ['--no-warnings', script, '--stdio'],
    cwd: '/tmp/does-not-matter',
    env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--max-old-space-size=512', ...extraEnv },
  }]];
}

function baseArgs(root, script, writeAtomic, extra = {}) {
  return {
    directory: '/tmp/does-not-matter',
    configDir: path.join(root, 'account'),
    entries: entriesFor(script, extra.entryOptions),
    env: extra.env || {},
    account: 'test-account',
    agentApiMode: 'Only',
    writeAtomic,
  };
}

function mcpFileFor(root) { return path.join(root, 'account', '.gemini', 'config', 'mcp_config.json'); }
function receiptFileFor(root) { return path.join(root, 'account', '.gemini', 'config', 'toolsenabled-registration-receipt.json'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

test('a first prepare on a fresh account records a single confirmed receipt entry matching the registration hash', () => {
  const root = scratchRoot();
  const gen = stageGeneration(root, 'gen-a');
  const surface = prepareAntigravitySurface(baseArgs(root, gen.script, makeWriteAtomic()));

  const mcp = readJson(mcpFileFor(root));
  assert.deepEqual(Object.keys(mcp.mcpServers), [SERVER]);
  assert.equal(mcp.mcpServers[SERVER].args.includes(gen.wrapper), true, 'the written registration names THIS generation wrapper, not the script')

  const receipt = readJson(receiptFileFor(root));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.server, SERVER);
  assert.equal(receipt.owned.length, 1);
  assert.equal(receipt.owned[0].state, 'confirmed');
  const crypto = require('node:crypto');
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify(mcp.mcpServers[SERVER])).digest('hex');
  assert.equal(receipt.owned[0].sha256, expectedHash);
  assert.equal(surface.antigravity.registration.args.includes(gen.wrapper), true);
});

test('GENERATION CHANGE: a promotion new wrapper path refreshes the recorded registration instead of refusing it as foreign (the reported defect)', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  const genB = stageGeneration(root, 'gen-b');

  prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic()));
  const beforeMcp = readJson(mcpFileFor(root));
  assert.equal(beforeMcp.mcpServers[SERVER].args.includes(genA.wrapper), true);

  // Resume after promotion: same account, the new generation's script/wrapper.
  // This is exactly the call that threw AGY_CLI_BOUNDARY_UNAVAILABLE before
  // the receipt existed -- it must not throw now.
  let surface;
  assert.doesNotThrow(() => {
    surface = prepareAntigravitySurface(baseArgs(root, genB.script, makeWriteAtomic()));
  }, 'a promotion refused the product own prior registration as foreign');

  const afterMcp = readJson(mcpFileFor(root));
  assert.equal(afterMcp.mcpServers[SERVER].args.includes(genB.wrapper), true, 'the registration did not move to the new generation wrapper');
  assert.equal(afterMcp.mcpServers[SERVER].args.includes(genA.wrapper), false, 'the old generation absolute path is still on record');
  assert.equal(surface.antigravity.registration.args.includes(genB.wrapper), true);

  const receipt = readJson(receiptFileFor(root));
  assert.equal(receipt.owned.length, 1, 'the receipt did not settle back to a single confirmed entry after the refresh');
  assert.equal(receipt.owned[0].state, 'confirmed');
});

test('a foreign registration with no receipt at all is refused, never auto-adopted by its name or its path pattern', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  const genOld = stageGeneration(root, 'looks-like-an-old-toolsenabled-generation');

  // A registration that LOOKS exactly like a prior generation's write --
  // same shape, a wrapper path that matches the same naming convention --
  // but was never recorded by this code (no receipt). Written directly,
  // standing in for the live legacy registration named in the assignment.
  const root2 = path.join(root, 'account', '.gemini', 'config');
  fs.mkdirSync(root2, { recursive: true, mode: 0o700 });
  const foreignRegistration = {
    command: 'node',
    args: ['--no-warnings', genOld.wrapper, '--stdio'],
    cwd: '/tmp/does-not-matter',
    env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--max-old-space-size=512' },
  };
  fs.writeFileSync(path.join(root2, 'mcp_config.json'), JSON.stringify({ mcpServers: { [SERVER]: foreignRegistration } }, null, 2) + '\n');
  assert.equal(fs.existsSync(path.join(root2, 'toolsenabled-registration-receipt.json')), false, 'this case must start with no receipt, matching the live legacy registration');

  assert.throws(
    () => prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic())),
    error => error.code === 'AGY_CLI_BOUNDARY_UNAVAILABLE',
    'a same-shaped registration with no receipt was adopted instead of refused',
  );
});

test('a tampered or malformed receipt proves nothing: the profile is still refused on generation change', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  const genB = stageGeneration(root, 'gen-b');
  prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic()));

  const receiptPath = receiptFileFor(root);
  const valid = readJson(receiptPath);

  const tamperedVariants = [
    { ...valid, schemaVersion: 2 },
    { ...valid, server: 'some-other-server' },
    { ...valid, owned: [...valid.owned, { sha256: 'a'.repeat(64), state: 'confirmed', recordedAtMs: 1 }, { sha256: 'b'.repeat(64), state: 'confirmed', recordedAtMs: 2 }] },
    { ...valid, extraField: 'not part of the schema' },
    { ...valid, owned: valid.owned.map(entry => ({ ...entry, sha256: 'not-a-hex-hash' })) },
  ];
  for (const variant of tamperedVariants) {
    fs.writeFileSync(receiptPath, JSON.stringify(variant, null, 2) + '\n');
    assert.throws(
      () => prepareAntigravitySurface(baseArgs(root, genB.script, makeWriteAtomic())),
      error => error.code === 'AGY_CLI_BOUNDARY_UNAVAILABLE',
      `a malformed receipt (${JSON.stringify(Object.keys(variant))}) was trusted as proof of ownership`,
    );
  }
});

test('INTERRUPTION before the shared write: a staged receipt whose staged hash was never written to mcp_config.json still recovers on the next prepare', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  const genB = stageGeneration(root, 'gen-b');
  const crypto = require('node:crypto');

  const surfaceA = prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic()));
  const genAText = JSON.stringify(surfaceA.antigravity.registration);
  const genAHash = crypto.createHash('sha256').update(genAText).digest('hex');

  // Hand-construct the exact intermediate state a crash between the staged
  // receipt write and the mcp_config.json write would leave: the receipt
  // already names genB's not-yet-written hash, but the shared file still
  // holds genA's registration untouched.
  const genBArgs = baseArgs(root, genB.script, makeWriteAtomic());
  // Compute genB's registration the same way prepare would, without calling
  // it yet, purely to stage the interrupted receipt state by hand.
  const wrapperB = genB.wrapper;
  const registrationB = { command: 'node', args: ['--no-warnings', wrapperB, '--stdio'],
    cwd: '/tmp/does-not-matter', env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--max-old-space-size=512' } };
  const genBHash = crypto.createHash('sha256').update(JSON.stringify(registrationB)).digest('hex');

  fs.writeFileSync(receiptFileFor(root), JSON.stringify({
    schemaVersion: 1, server: SERVER,
    owned: [{ sha256: genAHash, state: 'confirmed', recordedAtMs: 1 }, { sha256: genBHash, state: 'staged', recordedAtMs: 2 }],
  }, null, 2) + '\n');
  // The shared file is untouched -- still genA's registration.
  assert.equal(readJson(mcpFileFor(root)).mcpServers[SERVER].args.includes(genA.wrapper), true);

  let surface;
  assert.doesNotThrow(() => { surface = prepareAntigravitySurface(genBArgs); },
    'an interrupted-before-the-write staged receipt was read as tampering instead of an unfinished write of our own');

  const afterMcp = readJson(mcpFileFor(root));
  assert.equal(afterMcp.mcpServers[SERVER].args.includes(genB.wrapper), true, 'the shared file was never actually updated to the new generation');
  const receipt = readJson(receiptFileFor(root));
  assert.equal(receipt.owned.length, 1);
  assert.equal(receipt.owned[0].sha256, genBHash);
  assert.equal(receipt.owned[0].state, 'confirmed');
  assert.equal(surface.antigravity.registration.args.includes(genB.wrapper), true);
});

test('INTERRUPTION after the shared write, before commit: a staged receipt whose hash already matches mcp_config.json finalizes without rewriting the shared file', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  const genB = stageGeneration(root, 'gen-b');
  const crypto = require('node:crypto');

  const surfaceA = prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic()));
  const genAHash = crypto.createHash('sha256').update(JSON.stringify(surfaceA.antigravity.registration)).digest('hex');

  const wrapperB = genB.wrapper;
  const registrationB = { command: 'node', args: ['--no-warnings', wrapperB, '--stdio'],
    cwd: '/tmp/does-not-matter', env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--max-old-space-size=512' } };
  const genBHash = crypto.createHash('sha256').update(JSON.stringify(registrationB)).digest('hex');

  // The shared write ALREADY completed (mcp_config.json holds genB's
  // registration); only the receipt's own commit-to-confirmed step was
  // interrupted, so it is still sitting on the staged pair.
  fs.writeFileSync(mcpFileFor(root), JSON.stringify({ mcpServers: { [SERVER]: registrationB } }, null, 2) + '\n');
  fs.writeFileSync(receiptFileFor(root), JSON.stringify({
    schemaVersion: 1, server: SERVER,
    owned: [{ sha256: genAHash, state: 'confirmed', recordedAtMs: 1 }, { sha256: genBHash, state: 'staged', recordedAtMs: 2 }],
  }, null, 2) + '\n');

  const mcpMtimeBefore = fs.statSync(mcpFileFor(root)).mtimeMs;
  const counts = new Map();
  let surface;
  assert.doesNotThrow(() => { surface = prepareAntigravitySurface(baseArgs(root, genB.script, makeWriteAtomic(counts))); });

  assert.equal(counts.get(mcpFileFor(root)) || 0, 0, 'the shared mcp_config.json was rewritten even though it already held the correct content');
  assert.ok((counts.get(receiptFileFor(root)) || 0) >= 1, 'the receipt was never committed to its steady confirmed state');

  const receipt = readJson(receiptFileFor(root));
  assert.equal(receipt.owned.length, 1);
  assert.equal(receipt.owned[0].sha256, genBHash);
  assert.equal(receipt.owned[0].state, 'confirmed');
  assert.equal(fs.statSync(mcpFileFor(root)).mtimeMs, mcpMtimeBefore, 'the shared file mtime moved even though its bytes did not need to change');
  assert.equal(surface.antigravity.registration.args.includes(genB.wrapper), true);
});

test('SEQUENTIAL SESSIONS on one account (same process, one after another -- not a real concurrency test): two sessions with their own, different env never leak into the shared registration or receipt', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  const countsA = new Map();
  const countsB = new Map();

  const sessionASecret = 'session-A-only-credential-marker';
  const sessionBSecret = 'session-B-only-credential-marker';

  const surfaceA = prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic(countsA), {
    entryOptions: { extraEnv: { SESSION_TAG: sessionASecret } },
  }));
  const mcpAfterA = fs.readFileSync(mcpFileFor(root), 'utf8');
  const receiptAfterA = fs.readFileSync(receiptFileFor(root), 'utf8');

  const surfaceB = prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic(countsB), {
    entryOptions: { extraEnv: { SESSION_TAG: sessionBSecret } },
  }));
  const mcpAfterB = fs.readFileSync(mcpFileFor(root), 'utf8');
  const receiptAfterB = fs.readFileSync(receiptFileFor(root), 'utf8');

  // Same generation, same registration content either session would compute
  // -- so the second session's prepare must be a no-op on the shared files.
  assert.equal(mcpAfterB, mcpAfterA, 'the shared MCP registration changed between two sessions on the same generation');
  assert.equal(receiptAfterB, receiptAfterA, 'the shared receipt changed between two sessions on the same generation');
  assert.equal(countsB.get(mcpFileFor(root)) || 0, 0, 'the second session rewrote the shared registration it did not need to change');

  // Neither session's own tag reaches either shared file.
  for (const text of [mcpAfterA, receiptAfterA, mcpAfterB, receiptAfterB]) {
    assert.equal(text.includes(sessionASecret), false, 'a session tag leaked into shared account config');
    assert.equal(text.includes(sessionBSecret), false, 'a session tag leaked into shared account config');
  }
  // The receipt's own schema carries nothing beyond the three documented keys.
  const receiptObject = JSON.parse(receiptAfterB);
  assert.deepEqual(Object.keys(receiptObject).sort(), ['owned', 'schemaVersion', 'server']);
  for (const entry of receiptObject.owned) assert.deepEqual(Object.keys(entry).sort(), ['recordedAtMs', 'sha256', 'state']);

  // But each session's OWN returned surface still carries its own scope --
  // the isolation is about the SHARED file, not about the session losing its
  // own identity.
  assert.notEqual(surfaceA.env.TOOLSENABLED_ANTIGRAVITY_MCP_SCOPE, surfaceB.env.TOOLSENABLED_ANTIGRAVITY_MCP_SCOPE);
  assert.ok(surfaceA.env.TOOLSENABLED_ANTIGRAVITY_MCP_SCOPE.includes(sessionASecret));
  assert.ok(surfaceB.env.TOOLSENABLED_ANTIGRAVITY_MCP_SCOPE.includes(sessionBSecret));
  assert.equal(surfaceA.env.TOOLSENABLED_ANTIGRAVITY_MCP_SCOPE.includes(sessionBSecret), false);
  assert.equal(surfaceB.env.TOOLSENABLED_ANTIGRAVITY_MCP_SCOPE.includes(sessionASecret), false);
});

/* A writeAtomic that performs every write for real up to call N, then throws
   on call N instead of writing -- so a failure lands exactly where a real
   disk error, permission refusal or process kill would, never simulated by
   hand-editing files after the fact. */
function writeAtomicFailingAtCall(n) {
  let count = 0;
  return (file, contents) => {
    count += 1;
    if (count === n) throw new Error(`injected failure at write call ${n} (${path.basename(file)})`);
    writeAtomic(file, contents);
  };
}

test('WRITE FAILURE AT THE STAGED RECEIPT (call 1): nothing is written at all, and a clean retry still succeeds', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  const genB = stageGeneration(root, 'gen-b');
  prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic()));
  const mcpBefore = fs.readFileSync(mcpFileFor(root), 'utf8');
  const receiptBefore = fs.readFileSync(receiptFileFor(root), 'utf8');

  assert.throws(() => prepareAntigravitySurface(baseArgs(root, genB.script, writeAtomicFailingAtCall(1))),
    /injected failure at write call 1/);
  assert.equal(fs.readFileSync(mcpFileFor(root), 'utf8'), mcpBefore, 'the shared registration changed even though its own write never ran');
  assert.equal(fs.readFileSync(receiptFileFor(root), 'utf8'), receiptBefore, 'the receipt changed even though the staged write that would change it failed before writing');

  const surface = prepareAntigravitySurface(baseArgs(root, genB.script, makeWriteAtomic()));
  assert.equal(surface.antigravity.registration.args.includes(genB.wrapper), true);
  const receiptAfter = JSON.parse(fs.readFileSync(receiptFileFor(root), 'utf8'));
  assert.equal(receiptAfter.owned.length, 1);
  assert.equal(receiptAfter.owned[0].state, 'confirmed');
});

test('WRITE FAILURE AT THE SHARED MCP CONFIG (call 2): the receipt is left correctly staged, and a clean retry still succeeds', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  const genB = stageGeneration(root, 'gen-b');
  prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic()));
  const mcpBefore = fs.readFileSync(mcpFileFor(root), 'utf8');

  assert.throws(() => prepareAntigravitySurface(baseArgs(root, genB.script, writeAtomicFailingAtCall(2))),
    /injected failure at write call 2/);
  assert.equal(fs.readFileSync(mcpFileFor(root), 'utf8'), mcpBefore, 'the shared registration changed even though its own write failed');
  const staged = readJson(receiptFileFor(root));
  assert.equal(staged.owned.length, 2, 'the receipt was not staged before the (failed) shared write');
  assert.equal(staged.owned[1].state, 'staged');

  const surface = prepareAntigravitySurface(baseArgs(root, genB.script, makeWriteAtomic()));
  assert.equal(surface.antigravity.registration.args.includes(genB.wrapper), true);
  const receiptAfter = readJson(receiptFileFor(root));
  assert.equal(receiptAfter.owned.length, 1);
  assert.equal(receiptAfter.owned[0].state, 'confirmed');
});

test('WRITE FAILURE AT THE FINAL RECEIPT COMMIT (call 3): the shared config already holds the new registration, and a clean retry finalizes without rewriting it', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  const genB = stageGeneration(root, 'gen-b');
  prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic()));

  assert.throws(() => prepareAntigravitySurface(baseArgs(root, genB.script, writeAtomicFailingAtCall(3))),
    /injected failure at write call 3/);
  assert.equal(readJson(mcpFileFor(root)).mcpServers[SERVER].args.includes(genB.wrapper), true, 'the shared write (call 2) should have completed for real before the injected call 3 failure');
  const staged = readJson(receiptFileFor(root));
  assert.equal(staged.owned.length, 2, 'the receipt was already committed despite the injected failure on that exact call');

  const counts = new Map();
  const surface = prepareAntigravitySurface(baseArgs(root, genB.script, makeWriteAtomic(counts)));
  assert.equal(counts.get(mcpFileFor(root)) || 0, 0, 'the retry rewrote the shared config even though it already held the correct content');
  assert.equal(surface.antigravity.registration.args.includes(genB.wrapper), true);
  const receiptAfter = readJson(receiptFileFor(root));
  assert.equal(receiptAfter.owned.length, 1);
  assert.equal(receiptAfter.owned[0].state, 'confirmed');
});

test('REPEATED INTERRUPTION across three generations, via real throwing writeAtomic checkpoints (not manually constructed receipts): a second interrupted transition must not evict the still-genuine prior entry', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  const genB = stageGeneration(root, 'gen-b');
  const genC = stageGeneration(root, 'gen-c');
  const mcpFile = mcpFileFor(root);
  const failOnMcpWrite = (file, contents) => {
    if (file === mcpFile) throw new Error('injected failure on the shared mcp write');
    writeAtomic(file, contents);
  };

  prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic()));
  assert.throws(() => prepareAntigravitySurface(baseArgs(root, genB.script, failOnMcpWrite)), /injected failure/);
  assert.throws(() => prepareAntigravitySurface(baseArgs(root, genC.script, failOnMcpWrite)), /injected failure/);

  assert.equal(readJson(mcpFileFor(root)).mcpServers[SERVER].args.includes(genA.wrapper), true, 'the shared config still correctly holds genA after two interrupted attempts');
  const midway = readJson(receiptFileFor(root));
  assert.equal(midway.owned.length, 2);
  const crypto = require('node:crypto');
  const genAHash = crypto.createHash('sha256').update(JSON.stringify(readJson(mcpFileFor(root)).mcpServers[SERVER])).digest('hex');
  assert.ok(midway.owned.some(entry => entry.sha256 === genAHash), 'the still-genuine genA entry did not survive the second interrupted transition own staging');

  // The real defect this reproduces: without carrying ONLY the entry that
  // matches what is actually on disk, this retry refused genA as foreign.
  let surface;
  assert.doesNotThrow(() => { surface = prepareAntigravitySurface(baseArgs(root, genC.script, makeWriteAtomic())); },
    'a genuinely still-owned prior generation was refused after a second interrupted transition');
  assert.equal(surface.antigravity.registration.args.includes(genC.wrapper), true);
  const finalReceipt = readJson(receiptFileFor(root));
  assert.equal(finalReceipt.owned.length, 1);
  assert.equal(finalReceipt.owned[0].state, 'confirmed');
});

test('a PRESENT but malformed, oversized or symlinked receipt is refused and left byte-for-byte untouched, never silently overwritten', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  const receiptPath = receiptFileFor(root);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });

  fs.writeFileSync(receiptPath, 'not valid json {{{');
  const malformedBefore = fs.readFileSync(receiptPath, 'utf8');
  assert.throws(() => prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic())),
    error => error.code === 'AGY_CLI_BOUNDARY_UNAVAILABLE');
  assert.equal(fs.readFileSync(receiptPath, 'utf8'), malformedBefore, 'a malformed receipt was overwritten instead of refused');
  fs.unlinkSync(receiptPath);

  const oversized = JSON.stringify({ schemaVersion: 1, server: SERVER, owned: [], pad: 'x'.repeat(8192) });
  fs.writeFileSync(receiptPath, oversized);
  assert.throws(() => prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic())),
    error => error.code === 'AGY_CLI_BOUNDARY_UNAVAILABLE');
  assert.equal(fs.readFileSync(receiptPath, 'utf8'), oversized, 'an oversized receipt was overwritten instead of refused');
  fs.unlinkSync(receiptPath);

  const decoy = path.join(root, 'decoy-target.json');
  const decoyContent = JSON.stringify({ schemaVersion: 1, server: SERVER, owned: [] });
  fs.writeFileSync(decoy, decoyContent);
  fs.symlinkSync(decoy, receiptPath);
  assert.throws(() => prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic())),
    error => error.code === 'AGY_CLI_BOUNDARY_UNAVAILABLE');
  assert.equal(fs.lstatSync(receiptPath).isSymbolicLink(), true, 'a symlinked receipt was replaced instead of refused');
  assert.equal(fs.readlinkSync(receiptPath), decoy, 'the symlink target changed');
  assert.equal(fs.readFileSync(decoy, 'utf8'), decoyContent, 'the symlink target file content changed');
});

test('ENOENT (no receipt file at all) is distinguished from a present-but-invalid one: absence alone never refuses', () => {
  const root = scratchRoot();
  const genA = stageGeneration(root, 'gen-a');
  assert.equal(fs.existsSync(receiptFileFor(root)), false);
  assert.doesNotThrow(() => prepareAntigravitySurface(baseArgs(root, genA.script, makeWriteAtomic())),
    'a genuinely absent receipt (ENOENT) was refused as though it were an invalid present one');
  assert.equal(fs.existsSync(receiptFileFor(root)), true, 'a valid receipt was not created for the first prepare');
});
