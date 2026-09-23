'use strict';
// WHERE AN ASSISTANT'S OWN ASSISTANTS APPEAR: on the person's tree, or off it.
//
// The owner's design, in his own words (2026-09-02):
//
//   "when agent spawn subagents they can either spawn their own subagents like
//    normal if they have full permissions, they can spawn them via toolsenabled
//    api as non tree agents or they can launch through api as full user toggled
//    agents. this should be all dictated via user settings"
//
//   "There are seperate settings. API setting should already have been built
//    in. THAT is one toggle and effects a whole class of the software. THEN we
//    have SUBAGENT settings which relate to the more specifics"
//
// So there are three ROUTES and two SEPARATE settings, and the separation is
// the whole point of this file existing next to agent-api-policy.js rather than
// inside it.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE DOES NOT DECIDE, AND THE MISTAKE THAT IS EASY TO MAKE HERE.
//
// `agent.agent_api` decides WHICH DOORS EXIST: with it on, the CLI's own `Task`
// built-in is removed from the assistant (agent-api-policy.js BUILT_IN_CENSUS,
// `{ name: 'Task', keep: false }`), so the only way to start another assistant
// is this product's tool. With it off, `Task` is present AS WELL.
//
// It does NOT gate `agent.spawn`. That tool is registered either way, and an
// assistant may call it either way. So this file must never read the API
// setting to decide whether a spawn may happen -- the classic route is simply
// "the assistant called its own tool instead of ours", which is a fact about
// which tool ran, not a branch anyone takes inside this one. An earlier draft of
// this module returned a `classic` route from here; that was wrong, and it would
// have made `agent.spawn` refuse itself whenever the person allowed built-ins.
//
// WHAT THIS FILE DECIDES is the one question that is genuinely ours: when a
// spawn does come through this product's tool, does the new assistant become a
// CIRCLE ON THE PERSON'S TREE -- its own name, its own conversation, the same
// stop button as one they started by hand -- or a LANE off it, bounded and
// recorded but never drawn.
//
// ---------------------------------------------------------------------------
// WHY "LET THE ASSISTANT DECIDE" IS THE SHIPPED ANSWER, AND WHAT IT DECIDES BY.
//
// The person is already choosing per request, in the request itself ("make sure
// the agents are all launched under your visible tree"). Someone who has never
// opened this row should get what they asked for in the words they used.
//
// And when the request says nothing, the answer is NOT a coin toss: it is
// whether the ASKING assistant is itself a circle on the tree. A tree circle
// handing work down is building a team the person is already watching, and its
// children belong beside it; an assistant that is not on the tree has no place
// to put a child, and inventing one would draw on a tree nobody pointed at.
// That rule needs no argument from the caller and cannot be got wrong by an
// assistant that never read this file.
//
// The two forcing values exist because a person who wants one answer every time
// should not have to say it every time, and because "Never on your tree" is the
// only way to be certain an assistant cannot add circles to a tree they are
// reading.
//
// This module decides and explains. It starts nothing.

const SUBAGENT_ROUTE_SETTING_ID = 'agent.subagent_route';

/* The two routes this product's own tool can take. */
const ROUTE = Object.freeze({
  TREE: 'tree',
  LANE: 'lane'
});

/* What the person may choose, in the words the settings page shows them. The
   VALUE IS THE SENTENCE, which is this registry's convention for a multi-choice
   row -- agent.blocked_question stores "Stop and wait for me" -- and it is why
   these constants read as English rather than as ids: what is written in the
   person's settings file is the thing they picked off the screen. */
const CHOICE = Object.freeze({
  TREE: 'Always on your tree',
  LANE: 'Never on your tree',
  ASSISTANT: 'Let the assistant decide'
});
const CHOICES = Object.freeze([CHOICE.TREE, CHOICE.LANE, CHOICE.ASSISTANT]);
const DEFAULT_CHOICE = CHOICE.ASSISTANT;

/* The same two sources agent-api-policy and the research gate count as a
   person's own choice. A value nobody chose is a default, and a default is
   already the shipped answer, so it never needs to force anything. */
const CHOOSING_PROVENANCE = Object.freeze(['user', 'installer']);

function settingsModule() { return require('./settings'); }

/**
 * The person's answer, and whether they actually gave one.
 *
 * Never throws: an unreadable settings layer leaves the shipped answer
 * standing, which is the direction every other gate in this product errs.
 */
function subagentRouteSetting({ loadSettings: loadSettingsImpl, valuesPath, env } = {}) {
  let settings;
  try {
    const loader = loadSettingsImpl || settingsModule().loadSettings;
    settings = loader({ valuesPath, env });
  } catch (error) {
    return Object.freeze({
      choice: DEFAULT_CHOICE,
      chosen: false,
      source: null,
      reason: 'settings-unreadable',
      detail: error && error.message ? error.message : String(error)
    });
  }
  const values = settings && settings.values;
  const raw = values ? values[SUBAGENT_ROUTE_SETTING_ID] : undefined;
  if (!CHOICES.includes(raw)) {
    return Object.freeze({
      choice: DEFAULT_CHOICE,
      chosen: false,
      source: null,
      reason: raw === undefined ? 'not-declared' : 'not-recognised'
    });
  }
  const recorded = settings.provenance ? settings.provenance[SUBAGENT_ROUTE_SETTING_ID] : null;
  const source = recorded && typeof recorded.source === 'string' ? recorded.source : 'default';
  const chosen = CHOOSING_PROVENANCE.includes(source);
  return Object.freeze({
    choice: chosen ? raw : DEFAULT_CHOICE,
    chosen,
    source,
    reason: chosen ? 'chosen' : 'not-chosen'
  });
}

function refuse(code, reason) {
  return Object.freeze({ ok: false, code, reason, route: null });
}

/**
 * Decide the one route this spawn takes.
 *
 *   requested          what this spawn asked for: 'tree', 'lane', or null for
 *                      "did not say".
 *   callerIsTreeCircle whether the assistant doing the spawning is itself a
 *                      circle on the person's tree. This is a fact the host
 *                      establishes, never a claim the calling assistant makes.
 *   choice             the person's setting, when the caller already read it.
 *
 * Returns { ok: true, route, choice, why } or a named refusal.
 */
function subagentRoute({
  requested = null,
  callerIsTreeCircle = false,
  choice = null,
  loadSettings: loadSettingsImpl,
  valuesPath,
  env
} = {}) {
  if (requested !== null && requested !== undefined && requested !== ROUTE.TREE && requested !== ROUTE.LANE) {
    return refuse(
      'AGENT_SPAWN_ROUTE_UNKNOWN',
      `A spawn may ask for "${ROUTE.TREE}" or "${ROUTE.LANE}" and nothing else.`
    );
  }
  const setting = choice === null || choice === undefined
    ? subagentRouteSetting({ loadSettings: loadSettingsImpl, valuesPath, env })
    : Object.freeze({
      choice: CHOICES.includes(choice) ? choice : DEFAULT_CHOICE,
      chosen: CHOICES.includes(choice),
      source: 'caller',
      reason: CHOICES.includes(choice) ? 'chosen' : 'not-recognised'
    });

  /* A FORCING CHOICE WINS OVER THE REQUEST, because that is what the person set
     it to do. It refuses the opposite request by name rather than quietly
     redirecting it: an assistant told "on the tree" that silently got a lane
     would report a team the person cannot find. */
  if (setting.choice === CHOICE.TREE) {
    if (requested === ROUTE.LANE) {
      return refuse(
        'AGENT_SPAWN_LANE_ROUTE_CLOSED',
        'This computer is set to put every assistant an assistant starts on your tree, so this spawn cannot be kept off it.'
      );
    }
    if (callerIsTreeCircle !== true) {
      return refuse(
        'AGENT_SPAWN_TREE_NOT_A_TREE_AGENT',
        'This computer is set to put every assistant an assistant starts on your tree, and the assistant asking is not itself on a tree, so there is nowhere to put this one.'
      );
    }
    return Object.freeze({
      ok: true,
      route: ROUTE.TREE,
      choice: setting.choice,
      why: 'Every assistant started here joins the tree, because that is what this computer is set to.'
    });
  }

  if (setting.choice === CHOICE.LANE) {
    if (requested === ROUTE.TREE) {
      return refuse(
        'AGENT_SPAWN_TREE_ROUTE_CLOSED',
        'This computer is set to keep the assistants your assistants start off your tree, so this spawn cannot join it.'
      );
    }
    return Object.freeze({
      ok: true,
      route: ROUTE.LANE,
      choice: setting.choice,
      why: 'No assistant started here joins the tree, because that is what this computer is set to.'
    });
  }

  /* THE CHOICE IS LEFT TO THE ASSISTANT. What it asked for wins; and when it
     asked for nothing, a circle's children belong beside it and everything
     else runs on its own. */
  if (requested === ROUTE.TREE) {
    if (callerIsTreeCircle !== true) {
      return refuse(
        'AGENT_SPAWN_TREE_NOT_A_TREE_AGENT',
        'This spawn asked for a place on your tree, but the assistant asking is not itself on a tree, so there is nowhere to put it.'
      );
    }
    return Object.freeze({
      ok: true,
      route: ROUTE.TREE,
      choice: setting.choice,
      why: 'This computer leaves the choice to the assistant, and this one asked for a place on your tree.'
    });
  }
  if (requested === ROUTE.LANE) {
    return Object.freeze({
      ok: true,
      route: ROUTE.LANE,
      choice: setting.choice,
      why: 'This computer leaves the choice to the assistant, and this one asked to stay off your tree.'
    });
  }
  return Object.freeze({
    ok: true,
    route: callerIsTreeCircle === true ? ROUTE.TREE : ROUTE.LANE,
    choice: setting.choice,
    why: callerIsTreeCircle === true
      ? 'This computer leaves the choice to the assistant; this one said nothing, and an assistant already on your tree hands its work to circles beside it.'
      : 'This computer leaves the choice to the assistant; this one said nothing, and an assistant that is not on a tree has no place to put a circle.'
  });
}

module.exports = Object.freeze({
  SUBAGENT_ROUTE_SETTING_ID,
  ROUTE,
  CHOICE,
  CHOICES,
  DEFAULT_CHOICE,
  CHOOSING_PROVENANCE,
  subagentRouteSetting,
  subagentRoute
});
