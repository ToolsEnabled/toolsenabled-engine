'use strict';

const assert = require('node:assert/strict');
const {
  ACTIONS,
  DEFAULT_ACTION,
  normalizeAction,
  resolvePreference,
  optionsFromSettings,
  decideFromSettings,
  decide
} = require('../src/lib/agent-approval-policy');
// The REAL tier module, not a stand-in. The ceiling property is only worth
// asserting against the thing that actually enforces it.
const tierPolicy = require('../src/lib/permission-tier-policy');

function tierCheckFor(tier) {
  return entry => tierPolicy.assertToolAllowed(entry, { origin: 'local', tier });
}

// The level a real beginner installation actually gets. Lane
// `tier-enforcement-build` (commit 2984b03) moved the recorded install levels
// onto installTierSession(), and flagged that `{tier:'guarded'}` is no longer
// that level -- and is wrong in the PERMISSIVE direction, because Guarded is an
// effect filter and host.read_file/repo.read_file/host.list_dir/repo.list_dir/
// clipboard.read are all `local-read`, so Guarded admits all five. Verified
// here: guided REFUSES host.read_file with PERMISSION_CONFINED_EXCLUSION_REFUSED
// while guarded ALLOWS it. Both are tested, because they assert different
// things: Guarded that an effect filter denies, Guided that the shipped
// beginner level denies.
function installTierCheckFor(level) {
  return entry => tierPolicy.assertToolAllowed(entry, tierPolicy.installTierSession(level));
}

const tests = [
  ['the default is stop-and-wait, and it is the safe one', () => {
    assert.equal(DEFAULT_ACTION, 'stop-and-wait');
    assert.equal(decide({ tool: 'x', effect: 'local-read' }, {}).decision, 'ask');
  }],

  ['an unset preference asks, and says it was never chosen', () => {
    const result = decide({ tool: 'x', effect: 'local-read' }, { globalPreference: undefined });
    assert.equal(result.decision, 'ask');
    assert.equal(result.reason, 'no-preference');
    assert.match(result.explanation, /have not chosen/);
  }],

  ['a malformed preference fails closed and says so, rather than guessing', () => {
    for (const bad of ['Decide for itslf', 42, {}, [], 'YOLO', 'allow-everything']) {
      const result = decide({ tool: 'x', effect: 'local-read' }, { globalPreference: bad });
      assert.equal(result.decision, 'ask', `${JSON.stringify(bad)} should fail closed`);
      assert.equal(result.action, 'stop-and-wait');
    }
  }],

  ['a malformed preference fails closed EVEN WITH a judge standing by to approve', () => {
    // Found by mutation testing, and it is the case that matters in production.
    // Asserting only the no-judge path let a mutant that resolved an unreadable
    // preference to `use-judgement` survive: with no judge the result still
    // came back "ask", so the suite went green while a typo in the settings
    // file would have handed an agent auto-approval on every real run, where a
    // judge IS configured.
    // The ceiling is deliberately PERMISSIVE here. Without it the fail-closed
    // "no tier was supplied" guard would return `ask` on its own, and this test
    // would pass no matter how the preference resolved -- which is exactly what
    // happened when that guard was added: two security mutants that had been
    // dying came back to life because their tests had quietly gone vacuous.
    // Supplying a tier that allows everything makes the PREFERENCE the only
    // thing that can produce the result under test.
    const judge = () => ({ approve: true, rationale: 'should never be consulted' });
    for (const bad of ['Decide for itslf', 42, {}, [], 'YOLO', null, undefined]) {
      const result = decide({ tool: 'x', effect: 'local-read' }, {
        globalPreference: bad, judge, tierCheck: tierCheckFor('full')
      });
      assert.equal(result.decision, 'ask', `${JSON.stringify(bad)} must not reach the judge`);
      assert.notEqual(result.decision, 'allow');
      assert.equal(result.action, 'stop-and-wait');
    }
  }],

  ['an unreadable preference never reaches the judge at all', () => {
    // Stronger than checking the verdict: the judge must not even be CONSULTED,
    // because consulting it means the unreadable value was treated as a request
    // for judgement rather than as an absence. Permissive ceiling for the same
    // reason as above -- the preference must be the only variable.
    let consulted = false;
    decide({ tool: 'x', effect: 'local-read' }, {
      globalPreference: 'nonsense-value',
      tierCheck: tierCheckFor('full'),
      judge: () => { consulted = true; return { approve: true }; }
    });
    assert.equal(consulted, false, 'an unreadable preference must not be treated as "decide for itself"');
  }],

  ['both vocabularies resolve: internal tokens and the registry labels', () => {
    assert.equal(normalizeAction('use-judgement').action, 'use-judgement');
    assert.equal(normalizeAction('Decide for itself').action, 'use-judgement');
    assert.equal(normalizeAction('Stop and wait for me').action, 'stop-and-wait');
    assert.equal(normalizeAction('Switch to other work').action, 'work-on-other-work');
    for (const action of ACTIONS) assert.equal(normalizeAction(action).action, action);
  }],

  ['work-on-other-work defers, and deferral is never rendered as approval', () => {
    const result = decide({ tool: 'x', effect: 'local-read' }, { globalPreference: 'Switch to other work' });
    assert.equal(result.decision, 'defer');
    assert.notEqual(result.decision, 'allow');
    // The question must stay visibly open.
    assert.match(result.explanation, /still needs your answer/);
  }],

  ['a per-node preference beats the global one', () => {
    const result = decide({ tool: 'x', effect: 'local-read' }, {
      globalPreference: 'Stop and wait for me',
      nodePreference: 'Switch to other work'
    });
    assert.equal(result.decision, 'defer');
    assert.equal(result.reason, 'node-override');
  }],

  ['a malformed NODE preference fails closed instead of falling back to a permissive global', () => {
    // The dangerous shape: a typo in one node's override silently re-widening
    // it to whatever the global happens to be.
    // Permissive ceiling so the node-override resolution is the only variable.
    const result = decide({ tool: 'x', effect: 'local-read' }, {
      globalPreference: 'Decide for itself',
      nodePreference: 'Decide for itslf',
      tierCheck: tierCheckFor('full'),
      judge: () => ({ approve: true })
    });
    assert.equal(result.decision, 'ask');
    assert.equal(result.action, 'stop-and-wait');
  }],

  ['use-judgement can allow, but only with something able to judge', () => {
    // A ceiling must be present for ANY allow, so this supplies one that
    // permits the request; the point under test is the judge, not the tier.
    const allowed = decide({ tool: 'x', effect: 'local-read' }, {
      globalPreference: 'Decide for itself',
      tierCheck: tierCheckFor('full'),
      judge: () => ({ approve: true, rationale: 'read-only and inside the workspace' })
    });
    assert.equal(allowed.decision, 'allow');
    assert.equal(allowed.judgeRationale, 'read-only and inside the workspace');
  }],

  ['use-judgement with NO judge asks rather than approving', () => {
    const result = decide({ tool: 'x', effect: 'local-read' }, {
      globalPreference: 'Decide for itself',
      tierCheck: tierCheckFor('full')
    });
    assert.equal(result.decision, 'ask');
    assert.equal(result.reason, 'judgement-declined');
  }],

  ['a judge that throws or returns junk results in asking, never allowing', () => {
    for (const judge of [() => { throw new Error('boom'); }, () => null, () => ({}), () => ({ approve: 'yes' }), () => 5]) {
      const result = decide({ tool: 'x', effect: 'local-read' }, {
        globalPreference: 'Decide for itself',
        tierCheck: tierCheckFor('full'),
        judge
      });
      assert.equal(result.decision, 'ask');
    }
  }],

  ['CEILING: the tier refuses and no preference can override it', () => {
    // guarded tier permits only local-read/external-read effects.
    const refused = decide({ tool: 'host.exec', effect: 'local-write' }, {
      globalPreference: 'Decide for itself',
      judge: () => ({ approve: true }),
      tierCheck: tierCheckFor('guarded')
    });
    assert.equal(refused.decision, 'deny');
    assert.equal(refused.reason, 'tier-refused');
    assert.equal(refused.canOverride, false);
    assert.match(refused.explanation, /no preference can approve it/);
  }],

  ['CEILING: an unreadable tier dependency is unavailable, never a definite refusal', () => {
    // A tierCheck that throws for an INFRASTRUCTURE reason -- the permission
    // session store being unreachable -- rather than because the tier said no.
    //
    // This case arrived here asserting `ask`/'tier-unavailable', on the correct
    // observation that a could-not must not be reported as a definite refusal
    // (the source makes exactly that distinction at REASONS, and only the first
    // is the tier's own decision). But its source counterpart was PULLED at the
    // fence, and the pull was right: reporting the label honestly by turning the
    // decision into `ask` also converts an automatic denial into a prompt a
    // person can approve, which LOOSENS a permission ceiling. Of the two facts
    // in tension -- label the could-not honestly, and never weaken the ceiling
    // -- the ceiling wins, because a wrong label misinforms while a weakened
    // ceiling grants.
    //
    // The unavailable result is deliberately not cached: a busy machine may
    // answer normally on the very next call. The CONTROL proves a genuine tier
    // refusal still takes the old, definite path; replacing every failure with
    // "unavailable" cannot pass this test.
    for (const thrown of [
      Object.assign(new Error('too many open files'), { code: 'EMFILE' }),
      'permission session store unreachable'
    ]) {
      let calls = 0;
      const tierCheck = () => {
        calls += 1;
        if (calls === 1) throw thrown;
      };
      const first = decide({ tool: 'host.exec', effect: 'local-write' }, {
        globalPreference: 'Decide for itself', judge: () => ({ approve: true }), tierCheck
      });
      assert.equal(first.decision, 'deny');
      assert.equal(first.reason, 'tier-unavailable');
      assert.equal(first.tierCode, 'APPROVAL_TIER_CHECK_UNAVAILABLE');
      assert.match(first.explanation, /NOT claiming/);
      assert.equal(first.canOverride, false);

      const retry = decide({ tool: 'host.exec', effect: 'local-write' }, {
        globalPreference: 'Decide for itself', judge: () => ({ approve: true }), tierCheck
      });
      assert.equal(retry.decision, 'allow', 'could-not-tell must not be cached or latched');
      assert.equal(calls, 2);
    }

    // CONTROL: the real tier's definite refusal remains definite.
    const refused = decide({ tool: 'host.exec', effect: 'local-write' }, {
      globalPreference: 'Decide for itself',
      judge: () => ({ approve: true }),
      tierCheck: tierCheckFor('guarded')
    });
    assert.equal(refused.reason, 'tier-refused');
    assert.equal(refused.tierCode, 'PERMISSION_EFFECT_REFUSED');
  }],

  ['CEILING: a per-node override cannot exceed the tier either', () => {
    const refused = decide({ tool: 'host.exec', effect: 'local-write' }, {
      globalPreference: 'Stop and wait for me',
      nodePreference: 'Decide for itself',
      judge: () => ({ approve: true }),
      tierCheck: tierCheckFor('guarded')
    });
    assert.equal(refused.decision, 'deny');
    assert.equal(refused.canOverride, false);
  }],

  ['CEILING: the shipped beginner level (guided) denies what guarded would have allowed', () => {
    const entry = { tool: 'host.read_file', effect: 'local-read' };
    const options = { globalPreference: 'Decide for itself', judge: () => ({ approve: true }) };

    // Guarded is an effect filter, so a local-read passes it and judgement runs.
    const underGuarded = decide(entry, { ...options, tierCheck: tierCheckFor('guarded') });
    assert.equal(underGuarded.decision, 'allow');

    // The level a beginner actually gets refuses it outright.
    const underGuided = decide(entry, { ...options, tierCheck: installTierCheckFor('guided') });
    assert.equal(underGuided.decision, 'deny');
    assert.equal(underGuided.canOverride, false);
    // The tier's own code travels with the denial so a surface explains it in
    // the tier's words rather than inventing its own.
    assert.equal(underGuided.tierCode, 'PERMISSION_CONFINED_EXCLUSION_REFUSED');
  }],

  ['CEILING: every install level is enforced, and unrestricted is the only one that lets judgement through', () => {
    const entry = { tool: 'host.exec', effect: 'local-write' };
    const options = { globalPreference: 'Decide for itself', judge: () => ({ approve: true }) };
    assert.equal(decide(entry, { ...options, tierCheck: installTierCheckFor('guided') }).decision, 'deny');
    assert.equal(decide(entry, { ...options, tierCheck: installTierCheckFor('standard') }).decision, 'deny');
    assert.equal(decide(entry, { ...options, tierCheck: installTierCheckFor('unrestricted') }).decision, 'allow');
  }],

  ['CEILING: with NO tier check supplied, judgement cannot approve', () => {
    // The defect this closes: `tierCheck` was optional, so a caller that simply
    // forgot the permission session skipped the ceiling entirely and judgement
    // still approved. Absence read as permission. Reported by
    // tier-enforcement-build, who found the same shape in their own file and a
    // third instance in tool-registry.js:2700, where the tier check runs only
    // `if (context.permissionSession !== undefined)`.
    const result = decide({ tool: 'host.exec', effect: 'local-write' }, {
      globalPreference: 'Decide for itself',
      judge: () => ({ approve: true, rationale: 'should never be reached' })
    });
    assert.equal(result.decision, 'ask');
    assert.notEqual(result.decision, 'allow');
    assert.equal(result.reason, 'tier-unavailable');
    // Not the same as the tier having refused -- "could not be checked" and
    // "your rules say no" are different things to tell a person.
    assert.notEqual(result.reason, 'tier-refused');
  }],

  ['with no tier check, the judge is never even consulted', () => {
    let consulted = false;
    decide({ tool: 'host.exec', effect: 'local-write' }, {
      globalPreference: 'Decide for itself',
      judge: () => { consulted = true; return { approve: true }; }
    });
    assert.equal(consulted, false, 'no ceiling means nothing may be granted, so the judge must not run');
  }],

  ['with no tier check, stopping and deferring still work -- neither grants anything', () => {
    // Fail-closed must not become fail-broken: only `allow` requires a ceiling.
    assert.equal(decide({ tool: 'x', effect: 'local-read' }, { globalPreference: 'Stop and wait for me' }).decision, 'ask');
    assert.equal(decide({ tool: 'x', effect: 'local-read' }, { globalPreference: 'Switch to other work' }).decision, 'defer');
  }],

  ['ORDER: the tier is consulted BEFORE the preference, even when the preference would allow', () => {
    // The security property is the ORDER, so it is observed directly: the tier
    // check must run even on the most permissive preference. A mutant that
    // consults the preference first and short-circuits will never call this.
    let tierConsulted = false;
    decide({ tool: 'x', effect: 'local-read' }, {
      globalPreference: 'Decide for itself',
      judge: () => ({ approve: true }),
      tierCheck: () => { tierConsulted = true; }
    });
    assert.equal(tierConsulted, true, 'the tier must be consulted before any preference is honoured');
  }],

  ['ORDER: the tier is consulted even when the preference is the most restrictive', () => {
    let tierConsulted = false;
    decide({ tool: 'x', effect: 'local-read' }, {
      globalPreference: 'Stop and wait for me',
      tierCheck: () => { tierConsulted = true; }
    });
    assert.equal(tierConsulted, true);
  }],

  ['a permissive tier still returns allow only through the preference', () => {
    // full tier allows everything, but that must not by itself approve; the
    // preference is still what decides, inside the ceiling.
    const asked = decide({ tool: 'host.exec', effect: 'local-write' }, {
      globalPreference: 'Stop and wait for me',
      tierCheck: tierCheckFor('full')
    });
    assert.equal(asked.decision, 'ask');

    const allowed = decide({ tool: 'host.exec', effect: 'local-write' }, {
      globalPreference: 'Decide for itself',
      judge: () => ({ approve: true }),
      tierCheck: tierCheckFor('full')
    });
    assert.equal(allowed.decision, 'allow');
  }],

  ['every decision explains itself in words a person could act on', () => {
    const cases = [
      {},
      { globalPreference: 'Switch to other work' },
      { globalPreference: 'Decide for itself', judge: () => ({ approve: true }) },
      { globalPreference: 'Decide for itself' },
      { globalPreference: 'Decide for itself', judge: () => ({ approve: true }), tierCheck: tierCheckFor('guarded') }
    ];
    for (const options of cases) {
      const result = decide({ tool: 'host.exec', effect: 'local-write' }, options);
      assert.equal(typeof result.explanation, 'string');
      assert.ok(result.explanation.length >= 40, `explanation too thin: ${result.explanation}`);
      assert.ok(['ask', 'defer', 'allow', 'deny'].includes(result.decision));
    }
  }],

  ['resolvePreference reports which source won', () => {
    assert.equal(resolvePreference({ globalPreference: 'Decide for itself' }).source, 'global');
    assert.equal(resolvePreference({ globalPreference: 'Decide for itself', nodePreference: 'Stop and wait for me' }).source, 'node');
  }],

  ['the per-node setting controls whether a stored node override can affect a decision', () => {
    const request = { tool: 'host.exec', effect: 'local-write' };
    const options = {
      nodePreference: 'Decide for itself',
      judge: () => ({ approve: true }),
      tierCheck: tierCheckFor('full')
    };
    const disabled = {
      values: {
        'agent.blocked_question': 'Stop and wait for me',
        'agent.blocked_question_per_node': false
      }
    };
    const enabled = {
      values: {
        'agent.blocked_question': 'Stop and wait for me',
        'agent.blocked_question_per_node': true
      }
    };

    assert.deepEqual(optionsFromSettings(disabled, options), {
      globalPreference: 'Stop and wait for me',
      nodePreference: 'Decide for itself',
      perNodeEnabled: false
    });
    assert.equal(decideFromSettings(request, disabled, options).decision, 'ask',
      'a disabled per-node switch must ignore an old permissive node value');
    assert.equal(decideFromSettings(request, enabled, options).decision, 'allow',
      'an enabled per-node switch must honor the same node value within the tier ceiling');
  }],

  ['a non-object request is refused rather than coerced', () => {
    // Each carries its own message. `assert.throws` without a third argument
    // produces the identical string "Missing expected exception" for every
    // fixture, so two such assertions in one test are indistinguishable in a
    // failure report -- and a harness that captures the message to tell mutants
    // apart (see the guard-noise/assertion-capture work) learns nothing from
    // them. Found by `tier-enforcement-build`, who hit the same property after
    // isolating their own fixtures.
    assert.throws(
      () => decide(null),
      /approval request must be an object/,
      'a null request must be refused outright, not treated as an empty request'
    );
    assert.throws(
      () => decide('x'),
      /approval request must be an object/,
      'a string request must be refused outright, not coerced into an object'
    );
  }]
];

function main() {
  for (const [name, test] of tests) {
    test();
    console.log(`PASS agent-approval-policy: ${name}`);
  }
  console.log('Agent approval policy tests passed (fail-closed defaults, per-node override, tier-is-the-ceiling ordering).');
}

main();
