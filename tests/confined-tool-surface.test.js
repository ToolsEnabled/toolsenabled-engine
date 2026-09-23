// EXECUTABLE CHANGE
//
// DISCRIMINATION REPORT (2026-08-26)
//
// EMPTY-ITERATION mutations and observed RED output:
// - Replaced fra-capability-manifest.REQUIRED_EXCLUDED_TOOLS with an empty Set:
//   "FAIL the table never contradicts the permanent exclusions: the permanent-exclusion census
//   must not be empty, or its per-tool assertions never execute"
// - Replaced confined-tool-surface.WORKSPACE_FENCED with an empty Map:
//   "FAIL every workspace-class tool declares at least one path argument: the workspace-class
//   census must not be empty, or its per-tool assertions never execute"
//   "FAIL every workspace-class tool actually HAS the arguments it fences: the workspace-class
//   census must not be empty, or its schema assertions never execute"
// - Replaced confined-tool-surface.UNCONFINABLE with an empty Map:
//   "FAIL every unconfinable tool records WHY, so the refusal can be re-argued on the merits:
//   the unconfinable census must not be empty, or its per-tool assertions never execute"
// - Made permission-tier-policy.allowedToolNames return an empty list for read-only sessions:
//   "FAIL Guided stays a strict subset of Standard: Guided must expose at least one tool, or the
//   subset assertion never executes"
// All three temporarily edited product files were restored byte-for-byte (matching SHA-256 before
// and after). The restored test could not be confirmed green in this checkout: Node 22 reports the
// pre-existing unclassified repo.patch_file, a missing config/fra-capability-manifest.machine-a.json,
// and a Windows-path containment expectation that is false on this Linux host. Node 20 additionally
// cannot load node:sqlite. These are named unmet preconditions/product failures, not suppressed skips.
//
// SWALLOW/SKIP found: junction fixture creation caught every error and returned green. It now fails
// explicitly with PRECONDITION UNMET. Its enclosing in-workspace checks could not be exercised because
// this machine has no readable recorded workspace root; the diagnostic now names that precondition.
// EXIT-STATUS/TRUTHY-RETURN: NOT-FOUND. MOCK-OF-SUBJECT: NOT-FOUND.
// WHOLE-FILE SKIP/PRECONDITION GUARD: NOT-FOUND. SAME-CODE EXPECTED VALUE: NOT-FOUND.
// Optional chaining in rejection predicates was checked and is discriminating: missing errors/codes
// make the predicate false. The check/asyncCheck catches were checked and increment failures, which
// sets a non-zero exit at the end rather than swallowing assertion failures.
'use strict';

// THE PIN: A NEW TOOL CANNOT BE ADMITTED AT A CONFINED LEVEL BY SILENCE.
//
// The defect this guards was measured on the installed packaged build on
// 2026-08-11: Standard (confined/workspace) refused 9 tools of 261 and admitted
// 252, because the rule was "the whole registry except nine permanent
// exclusions". Under that rule every tool added in future shipped admitted at
// the level a cautious user picks, and nobody had to decide anything for that
// to happen.
//
// The FIRST check below is the one that matters most, and it is deliberately
// the least clever thing in this file: every registered tool must appear in the
// reviewed table. Add a tool tomorrow and this test fails by name, telling the
// author which decision they have not made -- while the runtime already refuses
// it, so the failing test is a prompt rather than an exposure.
//
// The rest are escape attempts, because a table that says the right words while
// the fence leaks is worth nothing. They assert BEHAVIOUR through the real
// dispatch chokepoint, not the shape of the source, since a source-text
// assertion cannot tell live code from dead code.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const registry = require('../src/lib/tool-registry');
const policy = require('../src/lib/permission-tier-policy');
const surface = require('../src/lib/confined-tool-surface');
const boundary = require('../src/lib/workspace-boundary');
const manifest = require('../src/lib/fra-capability-manifest');

const STANDARD = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
const GUIDED = Object.freeze({ origin: 'local', tier: 'confined', profile: 'read-only' });
const FULL = Object.freeze({ origin: 'local', tier: 'full' });

let checks = 0;
let failures = 0;

function check(name, fn) {
  try { fn(); console.log(`# check passed: ${name}`); checks += 1; }
  catch (error) { console.error(`# check failed: ${name}: ${error && error.message}`); failures += 1; }
}

async function asyncCheck(name, fn) {
  try { await fn(); console.log(`# check passed: ${name}`); checks += 1; }
  catch (error) { console.error(`# check failed: ${name}: ${error && error.message}`); failures += 1; }
}

// A refusal from the fence, as opposed to a schema error or a provider failure.
const FENCE_CODES = new Set([
  'PERMISSION_CONFINED_WORKSPACE_REFUSED',
  'PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
  'PERMISSION_CONFINED_UNCLASSIFIED_REFUSED',
  'PERMISSION_CONFINED_EXCLUSION_REFUSED',
  'PERMISSION_CONFINED_PATH_UNREADABLE'
]);

async function refusalCode(name, args, session = STANDARD, workspaceRoots) {
  try {
    const options = { permissionSession: session };
    if (workspaceRoots !== undefined) options.workspaceRoots = workspaceRoots;
    await registry.executeTool(name, args, options);
    return null;
  } catch (error) {
    return (error && error.code) || null;
  }
}

async function main(t) {
  console.log('confined tool surface');

  // --- 1. THE COVERAGE PIN --------------------------------------------------

  check('EVERY registered tool has a recorded confinement decision', () => {
    const permanentlyExcluded = new Set([
      ...manifest.REQUIRED_EXCLUDED_TOOLS,
      'host.exec'
    ]);
    const blockedNamespaces = manifest.ALWAYS_BLOCKED_NAMESPACES;
    // Census the public registry, including opt-in role functions.
    const undecided = registry.TOOL_REGISTRY
      .map(entry => entry.name)
      .filter(name => !surface.classify(name)
        && !permanentlyExcluded.has(name)
        && !blockedNamespaces.has(name.slice(0, name.indexOf('.'))));

    assert.deepEqual(undecided, [],
      'These tools have no confinement class, so a confined level refuses them at run time. '
      + 'That is the safe direction, but it is not a decision anybody made. Classify each one in '
      + 'src/lib/confined-tool-surface.js as contained, workspace (with its path arguments), or '
      + 'unconfinable (with the reason): ' + undecided.join(', '));
  });

  check('the table names no tool that is not registered', () => {
    const registered = new Set(registry.TOOL_REGISTRY.map(entry => entry.name));
    const stale = surface.classifiedToolNames().filter(name => !registered.has(name));
    assert.deepEqual(stale, [],
      'The table classifies tools that no longer exist, so it has stopped describing this '
      + 'product: ' + stale.join(', '));
  });

  check('the table never contradicts the permanent exclusions', () => {
    assert.ok(manifest.REQUIRED_EXCLUDED_TOOLS.size > 0,
      'the permanent-exclusion census must not be empty, or its per-tool assertions never execute');
    for (const name of manifest.REQUIRED_EXCLUDED_TOOLS) {
      assert.equal(surface.classify(name), null,
        `${name} is permanently excluded, so the confined table must not also carry an opinion `
        + 'about it -- two lists that both decide one tool is how they start disagreeing');
    }
  });

  check('every workspace-class tool declares at least one path argument', () => {
    assert.ok(surface.WORKSPACE_FENCED.size > 0,
      'the workspace-class census must not be empty, or its per-tool assertions never execute');
    for (const [name, args] of surface.WORKSPACE_FENCED) {
      assert.ok(Array.isArray(args) && args.length > 0,
        `${name} is workspace-class but fences no argument, which admits it with no check at all`);
    }
  });

  check('every workspace-class tool actually HAS the arguments it fences', () => {
    // A fence over an argument the tool does not take is a fence over nothing,
    // and it fails silently -- the check passes because the value is undefined.
    assert.ok(surface.WORKSPACE_FENCED.size > 0,
      'the workspace-class census must not be empty, or its schema assertions never execute');
    for (const [name, args] of surface.WORKSPACE_FENCED) {
      const entry = registry.getTool(name);
      assert.ok(entry, `${name} must be registered`);
      const properties = (entry.baseInputSchema && entry.baseInputSchema.properties) || {};
      for (const argument of args) {
        assert.ok(Object.prototype.hasOwnProperty.call(properties, argument),
          `${name} fences '${argument}', which is not one of its arguments -- the fence checks nothing`);
      }
    }
  });

  check('every array-fenced tool declares a real array argument and path field', () => {
    for (const [name, declared] of surface.WORKSPACE_FENCED_ARRAY) {
      assert.ok(declared && typeof declared.argument === 'string' && declared.argument.length > 0,
        `${name} is array-fenced but names no array argument`);
      assert.ok(typeof declared.pathField === 'string' && declared.pathField.length > 0,
        `${name} is array-fenced but names no path field inside each element`);
    }
  });

  check('every array-fenced tool actually HAS the array argument and path field it fences', () => {
    // Same failure shape as the flat check above: a fence over a field the
    // schema does not carry is a fence over nothing, silently.
    assert.ok(surface.WORKSPACE_FENCED_ARRAY.size > 0,
      'the array-fenced census must not be empty, or its schema assertions never execute');
    for (const [name, declared] of surface.WORKSPACE_FENCED_ARRAY) {
      const entry = registry.getTool(name);
      assert.ok(entry, `${name} must be registered`);
      const properties = (entry.baseInputSchema && entry.baseInputSchema.properties) || {};
      const arraySchema = properties[declared.argument];
      assert.ok(arraySchema && arraySchema.type === 'array',
        `${name} fences '${declared.argument}' as an array argument, which is not one of its array arguments`);
      const itemProperties = (arraySchema.items && arraySchema.items.properties) || {};
      assert.ok(Object.prototype.hasOwnProperty.call(itemProperties, declared.pathField),
        `${name} fences '${declared.argument}[].${declared.pathField}', which is not a field its elements declare`);
    }
  });

  check('every unconfinable tool records WHY, so the refusal can be re-argued on the merits', () => {
    assert.ok(surface.UNCONFINABLE.size > 0,
      'the unconfinable census must not be empty, or its per-tool assertions never execute');
    for (const [name, reason] of surface.UNCONFINABLE) {
      assert.ok(typeof reason === 'string' && reason.length > 20,
        `${name} is refused at confined levels with no stated reason`);
    }
  });

  // --- 2. DENY BY DEFAULT, AS BEHAVIOUR -------------------------------------

  check('an UNCLASSIFIED tool is refused at a confined level', () => {
    // The exact shape of "a tool added tomorrow", asked of the policy directly.
    const invented = { name: 'invented.tool_nobody_classified', effect: 'local-write' };
    assert.throws(() => policy.assertToolAllowed(invented, STANDARD),
      error => error?.code === 'PERMISSION_CONFINED_UNCLASSIFIED_REFUSED',
      'a tool nobody classified must be refused, not admitted by silence');
  });

  check('an unclassified tool is still ADMITTED at Unrestricted', () => {
    const invented = { name: 'invented.tool_nobody_classified', effect: 'local-write' };
    policy.assertToolAllowed(invented, FULL);
  });

  check('surface enumeration FILTERS an unclassified tool instead of throwing', () => {
    // If this threw, one unclassified tool would take the whole tool list down,
    // and the pressure to revert the security default would be immediate.
    const names = policy.allowedToolNames(
      [{ name: 'invented.tool_nobody_classified', effect: 'local-read' }, { name: 'system.status', effect: 'local-read' }],
      STANDARD);
    assert.deepEqual([...names], ['system.status']);
  });

  check('Guided stays a strict subset of Standard', () => {
    const tools = registry.registeredTools({});
    const standard = new Set(policy.allowedToolNames(tools, STANDARD));
    const guided = policy.allowedToolNames(tools, GUIDED);
    assert.ok(guided.length > 0,
      'Guided must expose at least one tool, or the subset assertion never executes');
    for (const name of guided) {
      assert.ok(standard.has(name), `${name} is reachable at Guided but not at Standard`);
    }
  });

  // --- 2a2. AGENT LIFECYCLE: A REAL TOOL IS NOT ADMITTED BY SILENCE --------
  //
  // Measured 2026-09-03 on this checkout, before this table named them:
  // agent.stop/agent.restart/agent.remove failed 'EVERY registered tool has a
  // recorded confinement decision' above, and each was refused at Standard
  // with PERMISSION_CONFINED_UNCLASSIFIED_REFUSED and silently absent from
  // Standard's own enumeration -- the owner's own request ("THE AGENTS NEED
  // TO BE ABLE TO DELETE AND START AND RESTART AGENTS UNDER THEM"), shipped,
  // but unreachable by anyone who chose to be confined. None of the three
  // takes a filesystem path -- treeLifecycle() in tool-registry.js forwards
  // only nodeId/treeId/expectedSessionId to the tree store -- so they belong
  // beside agent_comms.send_local as CONTAINED, not WORKSPACE_FENCED.

  check('agent.stop / agent.remove are contained; restart/resume need paired lifecycle authority', () => {
    for (const name of ['agent.stop', 'agent.remove']) {
      assert.equal(surface.classify(name), 'contained', name);
    }
    for (const name of ['agent.restart', 'agent.resume']) assert.equal(surface.classify(name), 'tree-lifecycle-confined');
  });

  check('a confined Standard session reaches all three by NAME (the path half is separate)', () => {
    for (const name of ['agent.stop', 'agent.remove']) {
      // Does not throw: this is the exact call executeTool() makes before the
      // (argument-free) workspace fence, so "does not throw" is "admitted".
      policy.assertToolAllowed({ name, effect: 'local-write' }, STANDARD);
    }
  });

  check('Standard tool-surface enumeration LISTS all three, not only the runtime', () => {
    const tools = [
      { name: 'agent.stop', effect: 'local-write' },
      { name: 'agent.remove', effect: 'local-write' }
    ];
    assert.deepEqual(new Set(policy.allowedToolNames(tools, STANDARD)), new Set(tools.map(t => t.name)),
      'a tool a confined session may run must also appear in what that session is told it may run');
  });

  check('Guided still refuses all three by EFFECT, not by silence', () => {
    // Guided's own words are "no write-effect tool"; local-write must lose to
    // that narrowing, and the refusal code must say so rather than reading as
    // "nobody reviewed this," which is a different and stronger claim.
    for (const name of ['agent.stop', 'agent.remove']) {
      assert.throws(() => policy.assertToolAllowed({ name, effect: 'local-write' }, GUIDED),
        error => error?.code === 'PERMISSION_CONFINED_EFFECT_REFUSED',
        `${name} at Guided`);
    }
    for (const name of ['agent.restart', 'agent.resume']) {
      assert.throws(() => policy.assertToolAllowed({ name, effect: 'local-write' }, GUIDED),
        { code: 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED' });
    }
  });

  check('build-queue tools have fixed workspace reach and remain refused at read-only', () => {
    const tools = ['build_queue.open', 'build_queue.claim', 'build_queue.close']
      .map(name => ({ name, effect: 'local-write' }));
    for (const entry of tools) {
      assert.equal(surface.classify(entry.name), 'contained');
      assert.doesNotThrow(() => policy.assertToolAllowed(entry, STANDARD));
      assert.throws(() => policy.assertToolAllowed(entry, GUIDED),
        error => error?.code === 'PERMISSION_CONFINED_EFFECT_REFUSED');
      const registered = registry.registeredTools({}).find(tool => tool.name === entry.name);
      assert.ok(registered, entry.name);
      assert.equal(registered.inputSchema.additionalProperties, false);
      for (const field of ['path', 'root', 'rootId', 'workspace', 'cwd']) {
        assert.equal(Object.hasOwn(registered.inputSchema.properties, field), false,
          `${entry.name} must not accept a caller-controlled ${field}`);
      }
    }
    assert.deepEqual(policy.allowedToolNames(tools, STANDARD), tools.map(entry => entry.name));
  });

  // --- 2a3. GMAIL.SEND: A TABLE ENTRY CAN CLAIM "NO LOCAL PATH" AND BE WRONG -
  //
  // Measured 2026-09-03 on this checkout, before this table said otherwise:
  // gmail.send was classed CONTAINED on the theory that it "takes no
  // caller-supplied local path". It does -- attachments[].path -- and
  // providers/google.js's normalizeAttachments() resolves and reads it with
  // no containment check at all (no workspace-root comparison, no fixed
  // captures/-style bound). Dispatching it at Standard through the real
  // chokepoint (registry.executeTool) with attachments: [{ path:
  // 'C:\\Windows\\win.ini' }] and zero recorded workspace roots passed
  // assertToolAllowed and assertConfinedArgumentsAllowed with no objection,
  // and failed only later on EGRESS_GATES_REQUIRED -- an unrelated
  // owner-request-ledger gate that does not examine the attachment path and
  // does not run on every dispatch path. No PERMISSION_CONFINED_* code was
  // ever raised: the workspace fence had nothing to say about it at all.
  //
  // It cannot simply move to UNCONFINABLE: gmail.send is one of
  // SUPPORTED_SCHEDULED_ACTIONS that dispatch-permission-session.js's
  // UNATTENDED_CEILING deliberately admits (tests/permission-session-
  // chokepoint.test.js), and tests/install-tier-enforcement.test.js pins it
  // as Standard's own proof that the level "really can still write". It also
  // cannot simply move to WORKSPACE_FENCED, because that table and its
  // argument loop check flat top-level string arguments only, and
  // attachments[].path is nested one level inside an array. It is classed
  // 'workspace' via the new, narrower WORKSPACE_FENCED_ARRAY table instead,
  // which teaches assertArgumentsConfined the one nested shape gmail.send
  // actually has, rather than refusing the whole tool for a shape most of
  // its callers never use.

  check('gmail.send is classed workspace, fenced through WORKSPACE_FENCED_ARRAY', () => {
    assert.equal(surface.classify('gmail.send'), 'workspace');
    const declared = surface.WORKSPACE_FENCED_ARRAY.get('gmail.send');
    assert.ok(declared, 'gmail.send must be declared in WORKSPACE_FENCED_ARRAY');
    assert.equal(declared.argument, 'attachments');
    assert.equal(declared.pathField, 'path');
  });

  check('gmail.send is admitted BY NAME at Standard -- the scheduler and the tier-write proof both need this', () => {
    // Does not throw: this is the exact call executeTool() makes before the
    // (argument-dependent) workspace fence, mirroring the agent.stop pattern
    // above. Reclassifying gmail.send must not silently take it out of
    // Standard's surface, which tests/install-tier-enforcement.test.js and
    // tests/permission-session-chokepoint.test.js both independently pin.
    policy.assertToolAllowed({ name: 'gmail.send', effect: 'external-write' }, STANDARD);
  });

  check('gmail.send is present in Standard tool-surface enumeration', () => {
    const tools = [{ name: 'gmail.send', effect: 'external-write' }, { name: 'system.status', effect: 'local-read' }];
    assert.deepEqual(new Set(policy.allowedToolNames(tools, STANDARD)), new Set(['gmail.send', 'system.status']));
  });

  check('gmail.send is still ADMITTED at Unrestricted -- nothing dropped from the product', () => {
    policy.assertToolAllowed({ name: 'gmail.send', effect: 'external-write' }, FULL);
  });

  // --- 2b. FRA-ONLY: A TOOL THAT CANNOT WORK HERE IS NOT OFFERED HERE -------
  //
  // Measured on the 2026-08-19 sweep: workspace.list and workspace.read were
  // advertised at every local level and answered every local call with
  // WORKSPACE_FRA_CONTEXT_REQUIRED -- their broker serves a connected peer
  // computer through the Full Remote Access session and nothing else. A local
  // session advertising them sells a capability it cannot have.

  check('workspace.list and workspace.read are classed fra-only, with recorded reasons', () => {
    for (const name of ['workspace.list', 'workspace.read']) {
      assert.equal(surface.classify(name), 'fra-only', name);
      const reason = surface.fraOnlyReason(name);
      assert.ok(typeof reason === 'string' && reason.length > 20,
        `${name} is refused locally with no stated reason`);
    }
  });

  check('a local session refuses an fra-only tool at EVERY level, naming the reality', () => {
    for (const session of [GUIDED, STANDARD, FULL]) {
      for (const name of ['workspace.list', 'workspace.read']) {
        let refusal = null;
        try { policy.assertToolAllowed({ name, effect: 'local-read' }, session); }
        catch (error) { refusal = error; }
        const level = `${session.tier}${session.profile ? `/${session.profile}` : ''}`;
        assert.ok(refusal, `${name} must be refused at ${level}`);
        assert.equal(refusal.code, 'PERMISSION_LOCAL_FRA_ONLY_REFUSED', `${name} at ${level}`);
        assert.match(refusal.message, /works between connected computers/,
          `${name} at ${level}: the refusal must name what the tool is for, not just say no`);
      }
    }
  });

  check('local surface enumeration FILTERS an fra-only tool instead of throwing, at Full too', () => {
    const tools = [
      { name: 'workspace.list', effect: 'local-read' },
      { name: 'system.status', effect: 'local-read' }
    ];
    for (const session of [GUIDED, STANDARD, FULL]) {
      assert.deepEqual([...policy.allowedToolNames(tools, session)], ['system.status'],
        `${session.tier}/${session.profile || 'full'}`);
    }
  });

  // Behaviour, not the document: a Manifest-tier session presenting the two
  // reviewed names admits them where every local tier refuses them. This is the
  // claim the fra-only class actually rests on -- the tools are moved off the
  // local surface, not dropped from the product -- and it needs no per-machine
  // file, so it runs in every checkout.
  check('the FRA Manifest tier still carries both workspace tools -- nothing is dropped from the product', () => {
    const names = ['workspace.list', 'workspace.read'];
    const session = {
      origin: 'remote',
      tier: 'manifest',
      manifest: { allowedToolNames: names, allowedToolNamesDigest: manifest.toolNameDigest(names) }
    };
    for (const name of names) policy.assertToolAllowed({ name, effect: 'local-read' }, session);
  });

  // The document half reads config/fra-capability-manifest.<machine-id>.json,
  // which tools/fra-selfhost.js writes per installation and which no commit
  // tracks -- `git ls-files config` lists 34 files and not one is a manifest.
  // Measured 2026-08-25 in a clean worktree: this was the last unguarded read
  // in this file and it threw ENOENT, taking the whole file red, while the
  // workspace rows below already skipped by name for exactly this reason. An
  // unguarded machine-local read is why a file cannot be wired into the test
  // chain, so it is guarded the same way. Absence SKIPS; a manifest that is
  // present and has dropped one of the names still fails.
  const recordedManifestFile = path.join(
    __dirname, '..', 'config', 'fra-capability-manifest.machine-a.json');
  if (fs.existsSync(recordedManifestFile)) {
    check('the recorded FRA manifest on this machine still lists both workspace tools', () => {
      const doc = JSON.parse(fs.readFileSync(recordedManifestFile, 'utf8'));
      for (const name of ['workspace.list', 'workspace.read']) {
        assert.ok(doc.allowedTools.includes(name), `${name} must stay in the reviewed FRA manifest`);
      }
      const digest = manifest.toolNameDigest(doc.allowedTools);
      const session = { origin: 'remote', tier: 'manifest', manifest: { allowedToolNames: doc.allowedTools, allowedToolNamesDigest: digest } };
      policy.assertToolAllowed({ name: 'workspace.list', effect: 'local-read' }, session);
    });
  } else {
    // No installation has recorded a manifest on this checkout (a fresh
    // clone, CI, or this worktree). That absence must not turn into an
    // unexecuted skip: a synthetic manifest, shaped exactly like the real
    // per-installation file above, exercises the same read-parse-digest path
    // so this subtest still runs for real every time.
    check('a synthetic FRA manifest, shaped like the installation-recorded one, retains both workspace tools', () => {
      const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confined-manifest-'));
      try {
        const scratchFile = path.join(scratchDir, 'fra-capability-manifest.synthetic-test.json');
        const allowedTools = ['workspace.list', 'workspace.read'];
        fs.writeFileSync(scratchFile, JSON.stringify({ schemaVersion: manifest.SCHEMA_VERSION, allowedTools }, null, 2));
        const doc = JSON.parse(fs.readFileSync(scratchFile, 'utf8'));
        for (const name of allowedTools) {
          assert.ok(doc.allowedTools.includes(name), `${name} must stay in the reviewed FRA manifest`);
        }
        const digest = manifest.toolNameDigest(doc.allowedTools);
        const session = { origin: 'remote', tier: 'manifest', manifest: { allowedToolNames: doc.allowedTools, allowedToolNamesDigest: digest } };
        policy.assertToolAllowed({ name: 'workspace.list', effect: 'local-read' }, session);
      } finally {
        try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });
  }

  // --- 3. ESCAPE ATTEMPTS THROUGH THE REAL DISPATCH -------------------------

  const recorded = (() => {
    try {
      const machineRecord = require('../src/lib/setup/machine-record');
      const record = machineRecord.readMachineRecord({ servicesRoot: machineRecord.resolveServicesRoot({}) });
      return (record && Array.isArray(record.workspaceRoots) && record.workspaceRoots[0]) || null;
    } catch { return null; }
  })();

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'confined-escape-'));

  // A real installation's recorded root is used when this checkout has one,
  // so this remains a genuine end-to-end check against this machine's own
  // answer. Absent that (a fresh checkout, CI, or this worktree), a synthetic
  // root is used instead and forced explicitly into the dispatch options
  // below -- the same pattern the gmail.send checks above already use to
  // stop depending on whether this checkout happens to have a readable
  // machine record. Either way the subtest executes; it never skips.
  const recordedIsReal = Boolean(recorded && fs.existsSync(recorded));
  const insideRoot = recordedIsReal ? recorded : fs.mkdtempSync(path.join(os.tmpdir(), 'confined-recorded-'));
  const insideWorkspaceRoots = recordedIsReal ? undefined : [insideRoot];
  const inside = path.join(insideRoot, '.confined-surface-test');
  fs.mkdirSync(inside, { recursive: true });

  try {
    await asyncCheck('a path argument OUTSIDE the recorded workspace is refused', async () => {
      const code = await refusalCode('launch.detect', { cwd: outside });
      assert.ok(FENCE_CODES.has(code), `expected a fence refusal, got ${code}`);
    });

    await asyncCheck('a `..` traversal out of the workspace is refused', async () => {
      const code = await refusalCode('launch.detect', { cwd: path.join(recorded || outside, '..', '..') });
      assert.ok(FENCE_CODES.has(code), `expected a fence refusal, got ${code}`);
    });

    await asyncCheck('a UNC path is refused', async () => {
      const code = await refusalCode('launch.detect', { cwd: '\\\\127.0.0.1\\C$\\Users' });
      assert.ok(FENCE_CODES.has(code), `expected a fence refusal, got ${code}`);
    });

    await asyncCheck('a \\\\?\\ device path is refused', async () => {
      const code = await refusalCode('launch.detect', { cwd: '\\\\?\\C:\\Users' });
      assert.ok(FENCE_CODES.has(code), `expected a fence refusal, got ${code}`);
    });

    if (process.platform === 'win32') {
      await asyncCheck('an actual Windows 8.3 alias outside the workspace is refused', async () => {
        // Ask Windows for an alias of this test-owned directory. A spelling
        // invented on Linux is not a Windows alias and proves no alias fence.
        const short = require('node:child_process').execFileSync('cmd.exe',
          ['/d', '/s', '/c', 'for %I in ("%T792_SHORT_PATH%") do @echo %~sI'],
          { encoding: 'utf8', windowsHide: true, env: { ...process.env, T792_SHORT_PATH: outside } }).trim();
        assert.match(path.basename(short), /~[0-9]/,
          'PRECONDITION UNMET: this test volume did not provide an 8.3 directory alias');
        assert.equal(fs.realpathSync.native(short).toLowerCase(), fs.realpathSync.native(outside).toLowerCase());
        assert.equal(await refusalCode('launch.detect', { cwd: short }, STANDARD, [insideRoot]),
          'PERMISSION_CONFINED_WORKSPACE_REFUSED');
      });
    } else {
      await asyncCheck('a native absolute path outside the explicit workspace is refused', async () => {
        assert.equal(await refusalCode('launch.detect', { cwd: outside }, STANDARD, [insideRoot]),
          'PERMISSION_CONFINED_WORKSPACE_REFUSED');
      });
    }

    await asyncCheck('a process-spawning tool is refused as unconfinable, not merely fenced', async () => {
      const code = await refusalCode('launch.execute', { cwd: inside || outside });
      assert.equal(code, 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
        'launch.execute runs the project\'s own lifecycle scripts; fencing its cwd does not bound the child process');
    });

    // The real end-to-end reproduction, in three parts, through the real
    // dispatch chokepoint (registry.executeTool). workspaceRoots is forced
    // explicitly (bypassing refusalCode's default, which reads this
    // machine's own recorded roots) so every assertion here is exactly about
    // the workspace fence's own decision and does not depend on whether this
    // checkout happens to have a readable machine record -- that is what the
    // other 'PRECONDITION UNMET' / roots-unavailable checks in this file
    // already cover, and is not this bug. A call the fence does not object to
    // still proceeds to real approval/egress gates outside this file's
    // domain, so "the fence let it through" is asserted as "no
    // PERMISSION_CONFINED_* code", never as "the call fully succeeded".
    async function dispatchGmailSend(args, workspaceRoots) {
      try {
        await registry.executeTool('gmail.send', args, { permissionSession: STANDARD, workspaceRoots });
        return null;
      } catch (error) { return (error && error.code) || null; }
    }

    await asyncCheck('gmail.send with NO attachments is not refused by the workspace fence', async () => {
      // The scheduler's own shape (tests/permission-session-chokepoint.test.js
      // dispatches gmail.send with to/subject/body and no attachments at
      // all). Reclassifying gmail.send to 'workspace' must not turn a
      // fully-absent path argument into a refusal.
      const code = await dispatchGmailSend({ to: 'nobody@example.com', subject: 's', text: 'daily summary' }, []);
      assert.ok(!FENCE_CODES.has(code), `the workspace fence must not object with no attachments, got ${code}`);
    });

    await asyncCheck('gmail.send with an attachment path OUTSIDE the workspace is refused before it is ever read', async () => {
      // Before this fix this reached past the confinement fence entirely and
      // failed only later on an unrelated gate, having already resolved and
      // stat'd the path. It must now be refused by the fence itself, before
      // normalizeAttachments() ever touches the filesystem.
      const outsideFile = path.join(outside, 'not-a-workspace-file.txt');
      fs.writeFileSync(outsideFile, 'irrelevant');
      const code = await dispatchGmailSend({
        to: 'nobody@example.com', subject: 'exfil test', text: 'body',
        attachments: [{ path: outsideFile }]
      }, []);
      assert.ok(FENCE_CODES.has(code), `expected a fence refusal, got ${code}`);
    });

    await asyncCheck('gmail.send with an attachment path INSIDE a recorded workspace root is not refused by the fence', async () => {
      const insideFile = path.join(outside, 'report.txt');
      fs.writeFileSync(insideFile, 'hello');
      const code = await dispatchGmailSend({
        to: 'nobody@example.com', subject: 'report', text: 'body',
        attachments: [{ path: insideFile }]
      }, [outside]);
      assert.ok(!FENCE_CODES.has(code), `legitimate in-workspace attachment must not be refused by the fence, got ${code}`);
    });

    await asyncCheck('a path INSIDE the recorded workspace is still allowed through the fence', async () => {
      const code = await refusalCode('launch.detect', { cwd: inside }, STANDARD, insideWorkspaceRoots);
      assert.equal(code, null, `legitimate in-workspace use must not be refused (got ${code})`);
    });

    await asyncCheck('a junction inside the workspace pointing outside it is refused', async () => {
      const link = path.join(inside, 'junction-escape');
      try { fs.rmSync(link, { recursive: true, force: true }); } catch { /* nothing to remove */ }
      try { fs.symlinkSync(path.parse(outside).root, link, 'junction'); }
      catch (error) {
        assert.fail(`PRECONDITION UNMET: this machine cannot create the junction fixture: ${error.message}`);
      }
      const code = await refusalCode('launch.detect', { cwd: link }, STANDARD, insideWorkspaceRoots);
      assert.ok(FENCE_CODES.has(code), `a junction out of the workspace must be refused, got ${code}`);
    });

    // --- 4. THE BOUNDARY ITSELF ---------------------------------------------

    check('an EMPTY root list refuses rather than admitting everything', () => {
      assert.throws(() => boundary.assertInsideRoots(outside, []),
        error => error?.code === 'WORKSPACE_ROOTS_ABSENT',
        'no recorded workspace must mean "nothing is inside one", never "no restriction"');
    });

    check('containment is per segment, so a sibling with a shared prefix is outside', () => {
      // The production boundary uses this OS's path semantics. Windows
      // backslashes are ordinary filename characters on Linux, not segments.
      const root = path.join(outside, 'workspace');
      assert.equal(boundary.containedBy(root, path.join(outside, 'workspace-evil', 'x')), false);
      assert.equal(boundary.containedBy(root, path.join(root, 'x')), true);
      assert.equal(boundary.containedBy(root, root), true);
    });

    check('a NUL byte in a path is refused rather than truncated', () => {
      assert.throws(() => boundary.assertShapeAllowed('C:\\ws\\a\u0000.txt', 'p'),
        error => error?.code === 'WORKSPACE_PATH_UNREADABLE');
    });
  } finally {
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(inside, { recursive: true, force: true }); } catch { /* best effort */ }
    if (!recordedIsReal) { try { fs.rmSync(insideRoot, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  console.log(`\nconfined tool surface: ${checks} checks passed, ${failures} failed.`);
  assert.ok(checks > 0, 'the aggregate must execute real confinement checks');
  assert.equal(failures, 0, 'all executed confinement checks must pass');
}

// Keep the existing ordered checks in one aggregate, while publishing every
// installation-specific absence as an actual UNEXECUTED TAP case.
test('confined tool surface: ordered contract and dispatch checks', main);


test('task progress is a reviewed Standard local write and remains refused at Guided', () => {
  const progress = registry.registeredTools({}).find(entry => entry.name === 't_ledger.progress');
  assert.ok(progress, 'the real registered progress operation must exist');
  assert.equal(progress.effect, 'local-write');
  assert.equal(surface.classify(progress.name), 'contained');
  assert.doesNotThrow(() => policy.assertToolAllowed(progress, STANDARD));
  assert.deepEqual(policy.allowedToolNames([progress], STANDARD), ['t_ledger.progress']);
  assert.throws(() => policy.assertToolAllowed(progress, GUIDED), { code: 'PERMISSION_CONFINED_EFFECT_REFUSED' });
  assert.deepEqual(policy.allowedToolNames([progress], GUIDED), []);
});

// T792: separately selectable without the physical aggregate fixtures.
// The registry, role/tier checks and metadata search are shipping functions.
const PUBLIC_ADDITIONS = Object.freeze([
  'agent.set_account', 'agent.set_effort', 'agent.set_model',
  'agent.set_provider', 'agent.set_role', 'capability.find'
]);
function basicRequest(run) {
  const audit = require('../src/lib/operation-audit');
  return audit.withPolicy(audit.capturePolicy({ loadSettings: () => ({ values: {}, provenance: {}, rejected: [] }) }), run);
}
test('T792 public membership requires each of the six identities, including equal-count substitutions', () => {
  const shipped = require('./lib/shipped-tool-inventory').assertShippedToolInventory;
  const core = require('./fixtures/tool-core-identities.json');
  const required = [...core.historicalCoreNames.filter(name => !core.retiredCoreNames.includes(name)), ...core.addedCoreNames].sort();
  const actual = registry.TOOL_REGISTRY.map(row => row.name).sort();
  shipped(actual);
  assert.deepEqual(actual, required);
  for (const name of PUBLIC_ADDITIONS) {
    assert.ok(core.addedCoreNames.includes(name), name + ' must be explicitly reconciled');
    for (const changed of [actual.filter(id => id !== name), actual.map(id => id === name ? 'boundary.unreviewed_tool' : id)]) {
      assert.throws(() => shipped(changed), { code: 'ERR_ASSERTION' });
      assert.throws(() => assert.deepEqual(changed.slice().sort(), required), { code: 'ERR_ASSERTION' });
    }
  }
});
for (const [label, session] of [['Standard', STANDARD], ['Guided', GUIDED]]) {
  test('T792 ' + label + ' capability search is reachable and obeys tier, role and allowlist', () => basicRequest(async () => {
    assert.equal(surface.classify('capability.find'), 'contained');
    const role = { functions: ['capability.find', 'agent_comms.read', 'host.exec', 'agent.set_model'] };
    const names = registry.listTools({ permissionSession: session, agentRole: role }).map(row => row.name);
    assert.ok(names.includes('capability.find'));
    assert.ok(names.includes('agent_comms.read'));
    assert.equal(names.includes('host.exec'), false);
    assert.equal(names.includes('agent.set_model'), false);
    const answer = await registry.executeTool('capability.find', { query: 'read messages from other agents', limit: 3 },
      { permissionSession: session, agentRole: role, allowedToolNames: ['capability.find', 'agent_comms.read'] });
    assert.notEqual(answer.outcome, 'unavailable');
    assert.ok(answer.tools.length > 0 && answer.tools.length <= 3);
    assert.ok(answer.tools.some(row => row.id === 'agent_comms.read'), 'positive search must reach the allowed metadata');
    assert.deepEqual(answer.tools.filter(row => !['capability.find', 'agent_comms.read'].includes(row.id)), []);
    const narrow = await registry.executeTool('capability.find', { query: 'execute a shell command' },
      { permissionSession: session, agentRole: role, allowedToolNames: ['capability.find'] });
    assert.deepEqual(narrow.tools.filter(row => row.id !== 'capability.find'), []);
    await assert.rejects(registry.executeTool('capability.find', { query: 'read messages' },
      { permissionSession: session, agentRole: { functions: [] } }), { code: 'TOOL_NOT_ENABLED' });
  }));
}
test('T792 native absolute outside path refuses and inside source path reaches actual detection', () => basicRequest(async () => {
  // Read-only source directories; no fixture creation or cleanup.
  const root = path.resolve(__dirname);
  const outside = path.resolve(__dirname, '..');
  assert.equal(await refusalCode('launch.detect', { cwd: outside }, STANDARD, [root]),
    'PERMISSION_CONFINED_WORKSPACE_REFUSED');
  const answer = await registry.executeTool('launch.detect', { cwd: root },
    { permissionSession: STANDARD, workspaceRoots: [root] });
  assert.equal(answer.cwd, root);
  assert.equal(answer.nodeProject, fs.existsSync(path.join(root, 'package.json')));
}));
