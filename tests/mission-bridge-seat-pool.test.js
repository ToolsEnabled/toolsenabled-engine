'use strict';

// SEAT ALLOCATION: can this product actually run four Claude agents at once?
//
// Until seats existed the answer was no, and not because of a policy: all three
// Claude tiers resolved to the single declared identity "claude", and the
// presence registry refuses a second live lane per identity
// (AGENT_PRESENCE_ACTIVE -> HTTP 409). So lane 1 started and lanes 2, 3 and 4
// collided, whatever tier they asked for. The product's own team picker
// documented the ceiling and refused the combination up front rather than
// dispatching one member and failing the next.
//
// These cases pin the four things that make the pool real rather than
// decorative: a tier allocates a FREE seat, a busy seat is skipped, exhausting
// the pool is reported as CAPACITY rather than as a broken declaration, and an
// unreadable presence registry refuses instead of inventing free seats.
//
// A note on why the last one matters. Presence is OBSERVED state. If reading it
// failed open, the allocator would hand out a seat it could not prove was free,
// and the collision would surface later as a 409 from a completely different
// subsystem -- which is exactly the class of "green here, broken there" defect
// this repository keeps finding. Fail closed: no reading, no dispatch.

const assert = require('node:assert');
const actions = require('../src/lib/mission-bridge/actions');

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

// A declared org shaped like the one a fresh install now ships: one controller,
// the three Codex seats, and four Claude seats, every seat managed.
//
// THE FIRST SEAT WAS `claude` AND THAT NAME NO LONGER EXISTS. The shipped
// config/agent-org.json declares claude-1..claude-4 and every Claude entry in
// TIERS lists those same four. declaredLane() intersects the tier's seat list
// with the org, so a fixture naming `claude` did not fail as "unknown seat" --
// the seat was simply not in the intersection, allocation moved on to claude-2,
// and the check reported "an idle fleet must allocate the first declared seat".
// The message was true and the diagnosis it suggests is wrong: allocation was
// working correctly on a fixture that had drifted away from the product.
const CLAUDE_SEATS = ['claude-1', 'claude-2', 'claude-3', 'claude-4'];
const ORG = Object.freeze({
  agents: Object.freeze([
    { id: 'controller', role: 'controller', provider: 'none', enabled: true },
    { id: 'luna', role: 'builder', provider: 'codex', enabled: true },
    { id: 'terra', role: 'builder', provider: 'codex', enabled: true },
    { id: 'sol', role: 'builder', provider: 'codex', enabled: true },
    ...CLAUDE_SEATS.map(id => ({ id, role: 'builder', provider: 'claude', enabled: true }))
  ]),
  relationships: Object.freeze([
    { from: 'controller', to: 'luna', type: 'manages' },
    { from: 'controller', to: 'terra', type: 'manages' },
    { from: 'controller', to: 'sol', type: 'manages' },
    ...CLAUDE_SEATS.map(id => ({ from: 'controller', to: id, type: 'manages' }))
  ])
});

/** A presence registry in which exactly `busyIds` are carrying a live lane. */
function registryWith(busyIds) {
  const agents = {};
  for (const id of busyIds) agents[id] = { status: 'running' };
  return { readRegistry: () => ({ agents }) };
}

function refusalCode(run) {
  try { run(); } catch (error) { return error && error.code; }
  return null;
}

// 0. THE FIXTURE MUST STILL DESCRIBE THE PRODUCT. Every assertion below is
//    written against literal seat names, deliberately -- an expected value the
//    subject computed would pass against any renaming, including a wrong one.
//    The cost of literals is that they rot silently, and this file measured
//    that cost: a stale first seat turned into a confusing failure about
//    allocation order. This guard is NOT the expected value; it is a check that
//    the fixture and the shipped tier vocabulary still name the same seats, so
//    the next rename fails here, saying so, instead of three checks down.
{
  const declared = [...actions.TIERS['claude-opus'].seats];
  check(
    declared.length === CLAUDE_SEATS.length && declared.every((id, i) => id === CLAUDE_SEATS[i]),
    `this fixture's Claude seats (${CLAUDE_SEATS.join(', ')}) no longer match the seats `
    + `TIERS declares (${declared.join(', ')}). Update the fixture -- the checks below `
    + `pin names on purpose and cannot detect a rename by themselves.`
  );
}

// 1. An empty registry allocates the FIRST seat -- the behaviour that existed
//    before pools, so a single-agent install sees no change at all.
check(
  actions.declaredLane(ORG, 'claude-opus', registryWith([])).targetAgentId === 'claude-1',
  'an idle fleet must allocate the first declared seat'
);
check(
  actions.declaredLane(ORG, 'luna', registryWith([])).targetAgentId === 'luna',
  'a single-seat Codex tier must still resolve to its one seat'
);

// 2. THE POINT OF THE CHANGE: four Claude lanes coexist. Each dispatch sees the
//    previous ones as busy, and each must land on a different identity.
{
  const allocated = [];
  for (let index = 0; index < CLAUDE_SEATS.length; index += 1) {
    const lane = actions.declaredLane(ORG, 'claude-opus', registryWith(allocated));
    allocated.push(lane.targetAgentId);
  }
  check(new Set(allocated).size === 4, `four consecutive Claude dispatches must occupy four DISTINCT seats, got ${allocated.join(', ')}`);
  check(allocated.every(id => CLAUDE_SEATS.includes(id)), 'every allocated seat must be one the org actually declares');
}

// 3. Tiers share the pool, because a seat is where work runs and a tier is what
//    it runs as. A busy fable lane must not be handed out again to opus.
check(
  actions.declaredLane(ORG, 'claude-opus', registryWith(['claude-1'])).targetAgentId !== 'claude-1',
  'a seat busy under one Claude tier must not be re-allocated to another'
);

// 4. A finished or stale seat is FREE. Presence keeps terminal rows around, and
//    treating them as busy would shrink the fleet to nothing over a day's use.
check(
  actions.declaredLane(ORG, 'claude-opus', { readRegistry: () => ({ agents: { 'claude-1': { status: 'finished' } } }) }).targetAgentId === 'claude-1',
  'a terminal seat must be reusable, or the pool drains permanently'
);
check(
  actions.declaredLane(ORG, 'claude-opus', { readRegistry: () => ({ agents: { 'claude-1': { status: 'stale' } } }) }).targetAgentId === 'claude-1',
  'a stale seat must be reusable -- staleness is how presence reports a lane it lost track of'
);

// 5. A FULL POOL IS A CAPACITY ANSWER, NOT A BROKEN DECLARATION. This is the
//    difference between "wait, or stop one" and "your configuration is wrong",
//    and only one of those is something a person can act on.
check(
  refusalCode(() => actions.declaredLane(ORG, 'claude-opus', registryWith(CLAUDE_SEATS))) === 'BRIDGE_ALL_SEATS_BUSY',
  'exhausting the pool must refuse as capacity (BRIDGE_ALL_SEATS_BUSY), never as a missing declaration'
);

// 6. A tier whose seats are genuinely undeclared is still a declaration fault.
//    The org below has no Claude agents at all -- which is what every packaged
//    install shipped until the default org gained seats.
{
  const codexOnly = { agents: ORG.agents.filter(a => a.provider !== 'claude'), relationships: ORG.relationships };
  check(
    refusalCode(() => actions.declaredLane(codexOnly, 'claude-opus', registryWith([]))) === 'BRIDGE_AGENT_DECLARATION_MISSING',
    'an undeclared tier must still refuse as a missing declaration, not as busy capacity'
  );
}

// 7. FAIL CLOSED ON UNREADABLE PRESENCE. Inventing free capacity here would
//    move the collision into a later subsystem and report it as that
//    subsystem's fault.
check(
  refusalCode(() => actions.declaredLane(ORG, 'claude-opus', {
    readRegistry: () => { throw new Error('registry unreadable'); }
  })) === 'BRIDGE_AGENT_PRESENCE_UNAVAILABLE',
  'an unreadable presence registry must refuse as unknown rather than claim every seat is busy'
);

console.log(`mission-bridge seat pool tests passed (${checks} checks: first-seat allocation, four distinct concurrent Claude seats, cross-tier pool sharing, terminal and stale seats reusable, full pool reported as capacity, undeclared tier still a declaration fault, unreadable presence remains unknown and fails closed).`);
