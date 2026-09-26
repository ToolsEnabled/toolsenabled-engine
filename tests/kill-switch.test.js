'use strict';

// Direct contract tests for src/lib/kill-switch.js. Each case uses a fresh
// path below os.tmpdir(), never the repository's real KILLSWITCH file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-kill-switch-'));
const originalPath = process.env.TOOLSENABLED_KILLSWITCH_PATH;
const killSwitch = require('../src/lib/kill-switch.js');

try {
  const killFile = path.join(root, 'KILLSWITCH');
  process.env.TOOLSENABLED_KILLSWITCH_PATH = killFile;

  const idle = killSwitch.status();
  assert.deepEqual({ active: idle.active, path: idle.path }, { active: false, path: killFile },
    'an absent marker must be reported as inactive at the configured path');
  assert.equal(idle.attribution.recorded, false, 'an absent marker attributes nothing');

  fs.writeFileSync(killFile, 'stale marker that must not survive\n', 'utf8');
  const activated = killSwitch.activate();
  assert.deepEqual({ active: activated.active, path: activated.path }, { active: true, path: killFile },
    'activation must report that the marker it wrote is active');
  const marker = fs.readFileSync(killFile, 'utf8');
  assert.match(marker, /^ToolsEnabled kill switch activated \d{4}-\d{2}-\d{2}T.*Z\n/,
    'activation must replace stale contents with a timestamped marker');
  assert.doesNotMatch(marker, /stale marker/,
    'activation must overwrite rather than append to an existing marker');

  const deactivated = killSwitch.deactivate();
  assert.deepEqual({ active: deactivated.active, path: deactivated.path }, { active: false, path: killFile },
    'deactivation must report that the marker it removed is inactive');
  assert.equal(fs.existsSync(killFile), false, 'deactivation must remove the marker');
  const idempotent = killSwitch.deactivate();
  assert.deepEqual({ active: idempotent.active, path: idempotent.path }, { active: false, path: killFile },
    'deactivation must remain safely idempotent when the marker is absent');

  const missingParentFile = path.join(root, 'missing-parent', 'KILLSWITCH');
  process.env.TOOLSENABLED_KILLSWITCH_PATH = missingParentFile;
  assert.throws(() => killSwitch.activate(), error => error && error.code === 'ENOENT',
    'a marker write failure must throw rather than return a successful status');

  const directoryMarker = path.join(root, 'directory-marker');
  fs.mkdirSync(directoryMarker);
  process.env.TOOLSENABLED_KILLSWITCH_PATH = directoryMarker;
  assert.throws(() => killSwitch.deactivate(),
    'a marker removal failure must throw rather than report successful deactivation');

  /* WHO PULLED THE BRAKE.
   *
   * system.kill_switch_activate is reachable from the LOWEST confined tier,
   * needs no approval, and writes no required durable intent; the optional
   * per-call audit summary is off by default. The marker is therefore the one
   * record that is always written, and it held a timestamp and nothing else --
   * so a prompt-injected agent could refuse every outward operation on the
   * owner's machine and leave no trace of which agent did it.
   */
  process.env.TOOLSENABLED_KILLSWITCH_PATH = killFile;
  killSwitch.activate({
    agentId: 'agent-7', agentActor: 'codex', agentSessionId: 'sess-abc',
    agentRole: 'builder', agentPrincipal: 'DESKTOP\\CodexSandboxUsers', requestId: 'req-42'
  });
  const attributed = fs.readFileSync(killFile, 'utf8');
  for (const [label, value] of [['agent', 'agent-7'], ['actor', 'codex'], ['session', 'sess-abc'],
    ['role', 'builder'], ['principal', 'DESKTOP\\CodexSandboxUsers'], ['request', 'req-42']]) {
    assert.match(attributed, new RegExp(`^${label}: ${value.replace(/[\\]/g, '\\\\')}$`, 'm'),
      `the marker must record the ${label} that activated the kill switch`);
  }
  killSwitch.deactivate();

  /* A CALLER-SUPPLIED FIELD MUST NOT BE ABLE TO FORGE ANOTHER ONE. Every value
     here arrives from the agent, so a newline in an agent id would otherwise
     write additional lines into the record that names it. */
  killSwitch.activate({ agentId: 'evil\nprincipal: SYSTEM\nrole: owner', agentActor: 'x' });
  const injected = fs.readFileSync(killFile, 'utf8');
  assert.match(injected, /^agent: evil principal: SYSTEM role: owner$/m,
    'a newline in an agent id must be flattened into its own field, not split across lines');
  assert.match(injected, /^principal: \(not stated\)$/m,
    'a forged principal line must not survive: the real field must still report nothing stated');
  assert.match(injected, /^role: \(not stated\)$/m,
    'a forged role line must not survive either');
  killSwitch.deactivate();

  /* THE SHAPE THE CALLERS ACTUALLY SEND.
   *
   * agentPrincipal is an object in every real caller -- owner-host.js:1728 builds
   * Object.freeze({ kind, sessionId, agentId, provider, roleId, ... }), and
   * job-runner and both bridges do the same. The first version of this file
   * passed a STRING here, so it proved the flattening worked and said nothing
   * about the shape the product sends; every real activation recorded
   * "principal: [object Object]". A test that exercises only the shape its
   * author had in mind cannot see the shape the callers use. */
  killSwitch.activate({
    agentId: 'agent-7',
    agentPrincipal: Object.freeze({
      kind: 'agent-session',
      sessionId: 'sess-abc',
      agentId: 'agent-7',
      provider: 'codex',
      roleId: 'builder',
      expectedOrgRevision: 12,
      expectedRoleRevision: 3
    })
  });
  const objectPrincipal = fs.readFileSync(killFile, 'utf8');
  assert.doesNotMatch(objectPrincipal, /\[object Object\]/,
    'an object principal must be rendered by its fields, never stringified whole');
  assert.match(objectPrincipal, /^principal: .*agentId=agent-7.*$/m,
    'the principal line must name the agent that holds the session');
  assert.match(objectPrincipal, /^principal: .*sessionId=sess-abc.*$/m,
    'and the session it was dispatched under');
  assert.match(objectPrincipal, /^principal: .*roleId=builder.*$/m, 'and its role');
  killSwitch.deactivate();

  /* A nested value must not be able to break the line either. */
  killSwitch.activate({ agentPrincipal: { agentId: 'a\nprincipal: SYSTEM', roleId: 'r' } });
  const nested = fs.readFileSync(killFile, 'utf8');
  assert.match(nested, /^principal: agentId=a principal: SYSTEM roleId=r$/m,
    'a newline inside a principal field must be flattened into the same line');
  assert.equal(nested.split('\n').filter(line => line.startsWith('principal:')).length, 1,
    'exactly one principal line may exist');
  killSwitch.deactivate();

  /* An unattributed activation says so rather than looking like a clean record. */
  killSwitch.activate();
  const anonymous = fs.readFileSync(killFile, 'utf8');
  assert.match(anonymous, /^agent: \(not stated\)$/m,
    'an activation with no attribution must say so explicitly');
  assert.equal(anonymous.split('\n').filter(Boolean).length, 7,
    'the marker keeps its timestamp line and one line per attribution field');
  killSwitch.deactivate();

  /* T-A7: A CLEAR HAD AN ACTOR TOO, AND A HAND CLEAR IS NOT THE SAME EVENT.
   *
   * activate() records who set the switch, but deactivate() removed the marker,
   * told nobody, and returned -- so an agent clearing the brake and a person
   * clearing it by hand left exactly the same evidence: none. The activation
   * attribution cannot answer this, because clearing DELETES the marker that
   * holds it, so the clear is reported through listeners carrying the
   * attribution the switch had while it was on. */
  const clearances = [];
  const stopListening = killSwitch.onDeactivate(record => clearances.push(record));

  killSwitch.activate({ agentId: 'agent-7', agentActor: 'codex', agentSessionId: 'sess-abc' });
  const live = killSwitch.status();
  assert.equal(live.attribution.recorded, true, 'a switch set through the tool must name its agent in status()');
  assert.equal(live.attribution.agent, 'agent-7');
  assert.equal(live.attribution.actor, 'codex');

  killSwitch.deactivate({ actor: 'agent-7', reason: 'work finished' });
  assert.equal(clearances.length, 1, 'clearing an active switch must tell the listeners');
  assert.equal(clearances[0].outOfBand, false, 'a clear made through deactivate() is not out of band');
  assert.equal(clearances[0].clearedBy, 'agent-7', 'the clear must name who asked for it');
  assert.equal(clearances[0].reason, 'work finished');
  assert.equal(clearances[0].previous.agent, 'agent-7',
    'the notice must carry the attribution the switch held while it was on, which the marker no longer can');

  /* A HAND AT THE FILESYSTEM. The marker goes away without deactivate() being
     asked, so nobody can be named -- and saying so is the point. */
  clearances.length = 0;
  killSwitch.activate({ agentId: 'agent-9' });
  killSwitch.status();                       // observe it on
  fs.unlinkSync(killFile);                   // removed out of band
  killSwitch.status();                       // the next look notices
  assert.equal(clearances.length, 1, 'a marker removed by hand must still be reported as cleared');
  assert.equal(clearances[0].outOfBand, true, 'a hand clear must read as out of band');
  assert.equal(clearances[0].clearedBy, null, 'nobody may be named for a clear nobody asked for');
  assert.equal(clearances[0].previous.agent, 'agent-9',
    'and it must still say who had set the switch that vanished');

  /* A BARE MARKER, as tools/kill.ps1 or a person writes it, is unattributed --
     never guessed at. */
  clearances.length = 0;
  fs.writeFileSync(killFile, 'ToolsEnabled kill switch activated 2026-09-25T00:00:00.000Z\n', 'utf8');
  const bare = killSwitch.status();
  assert.equal(bare.active, true, 'a bare marker still stops outward work');
  assert.equal(bare.attribution.recorded, false, 'a bare marker must read as unattributed');
  assert.equal(bare.attribution.agent, null, 'no actor may be invented for a marker that names none');
  killSwitch.deactivate();
  stopListening();

  /* A listener that throws must not keep the clearance from reaching the others,
     and must not break the caller's deactivate(). */
  const heard = [];
  const stopBad = killSwitch.onDeactivate(() => { throw new Error('listener exploded'); });
  const stopGood = killSwitch.onDeactivate(record => heard.push(record));
  killSwitch.activate({ agentId: 'agent-11' });
  killSwitch.deactivate({ actor: 'agent-11' });
  assert.equal(heard.length, 1, 'a throwing listener must not swallow the clearance for the rest');
  stopBad(); stopGood();

  console.log('kill-switch direct contract tests passed');
} finally {
  if (originalPath === undefined) delete process.env.TOOLSENABLED_KILLSWITCH_PATH;
  else process.env.TOOLSENABLED_KILLSWITCH_PATH = originalPath;
  fs.rmSync(root, { recursive: true, force: true });
}
