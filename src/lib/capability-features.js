'use strict';

// WHICH FEATURES THIS SESSION CAN ACTUALLY REACH, RESOLVED RATHER THAN DECLARED.
//
// Owner, 2026-08-13: an onboarding line naming the enabled features, tagged
// `[filekeeper] [grepsaver]`, so an agent knows what it has instead of
// rediscovering it or ignoring it.
//
// THE RULE THIS FILE EXISTS TO OBEY. The line is a PROJECTION OF ENFORCEMENT,
// never its own truth. This codebase's signature defect is the declared setting
// that enforces nothing -- requireCapability() shipped with zero callers,
// seatMinimum is read nowhere, and the owner's purchase reservation sat in the
// settings registry while pay.recordSpend() had never heard of it. A feature
// flag that only decided what a packet PRINTED would be one more of those, and
// worse than none, because it would read as a guarantee.
//
// So presence is computed from the RESOLVED TOOL LIST and the filesystem at the
// moment of asking. config/capability-features.json declares what could exist
// and how to look for it; nothing in it can turn a feature "on".
//
// The property that falls out of doing it this way is the one worth having: a
// confined permission tier shrinks listTools, so this line shrinks with it,
// automatically and without knowing that tiers exist. An agent reading the
// packet is told what IT can reach, not what the product ships.
//
// DEGRADED IS A STATE, NOT A ROUNDING ERROR. GrepSaver measured 2026-08-12 in
// canonical: the tool is present and wired, and context/systems.json declares
// exactly ONE card, still pending-review. Printing `[grepsaver]` beside a
// genuinely stocked feature would tell an agent to route questions somewhere
// that has nothing to answer with -- a small lie that costs a real lookup. So a
// feature that is installed but has nothing to serve reports `degraded` and
// says why.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_FILE = path.join(ROOT, 'config', 'capability-features.json');

const TIERS = Object.freeze(['absent', 'unregistered', 'gated']);
const VERIFICATION = Object.freeze(['tools', 'command', 'probe']);

/* Real measurements, for features whose availability is not a question about
 * files or tool ids. Keyed by feature id; the manifest refuses `verifiedBy:
 * "probe"` for any id absent from here, so a probe can never be claimed and not
 * exist.
 *
 * Each returns { state, reason } using the same vocabulary as resolveFeatures. */
const PROBES = Object.freeze({
  // The vault is `gated`: whether it is usable is a question about the STORE,
  // not about whether a module is on disk. vault-presence exports exactly this
  // answer, and the previous version checked for that file's existence instead
  // of calling it -- which is the difference between "the question exists" and
  // "the question was asked".
  // DELIBERATELY DOES NOT CALL vaultRecordPresence(), AND THE REASON IS THE
  // BUDGET. That function is the accurate answer -- it spawns PowerShell against
  // tools/secrets.ps1 -- and this probe runs inside the onboarding packet, which
  // renders on EVERY SessionStart. Paying a PowerShell spawn on every session
  // boot to decorate one line would be the "audit write that visibly slows the
  // thing it observes" mistake in a new place, and whoever is next in a hurry
  // would delete the line rather than the cost.
  //
  // So this answers the cheap question and SAYS which question it answered. The
  // store's presence is a real fact about the installation; whether every record
  // in it decrypts is not, and this does not claim it. That distinction is the
  // whole reason the previous version was wrong: it checked whether
  // vault-presence.js EXISTED, which proves only that the question is
  // implemented somewhere, not that the answer is yes.
  vault(root, { exists = fs.existsSync } = {}) {
    const store = path.join(root, 'vault', 'secrets.json');
    if (exists(store)) {
      return { state: 'ready', reason: null };
    }
    // Absent store is the ordinary state of a fresh install, not a fault: the
    // vault is created on first write. Reported as absent so the line does not
    // advertise a credential store nobody has put anything in.
    return {
      state: 'absent',
      reason: 'no vault store on this installation yet (created on first secret write)'
    };
  }
});

class CapabilityFeatureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CapabilityFeatureError';
    this.code = code;
  }
}

function readManifest({ manifestFile = MANIFEST_FILE, readFile = fs.readFileSync } = {}) {
  let raw;
  try {
    raw = readFile(manifestFile, 'utf8');
  } catch (error) {
    throw new CapabilityFeatureError('FEATURE_MANIFEST_UNREADABLE',
      `${manifestFile} could not be read: ${String(error?.code || 'READ_FAILED')}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CapabilityFeatureError('FEATURE_MANIFEST_INVALID',
      `${manifestFile} is not valid JSON: ${error.message}`);
  }
  const features = Array.isArray(parsed?.features) ? parsed.features : null;
  if (!features) {
    throw new CapabilityFeatureError('FEATURE_MANIFEST_INVALID', 'the manifest declares no features array');
  }
  const seen = new Set();
  for (const feature of features) {
    if (!feature || typeof feature.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(feature.id)) {
      throw new CapabilityFeatureError('FEATURE_MANIFEST_INVALID', `a feature has an unusable id: ${JSON.stringify(feature?.id)}`);
    }
    if (seen.has(feature.id)) {
      throw new CapabilityFeatureError('FEATURE_MANIFEST_INVALID', `feature ${feature.id} is declared twice`);
    }
    seen.add(feature.id);
    // An undeclared tier would let a settings screen invent its own meaning for
    // "off", which is the whole failure this manifest was written to prevent.
    if (!TIERS.includes(feature.tier)) {
      throw new CapabilityFeatureError('FEATURE_MANIFEST_INVALID',
        `feature ${feature.id} declares tier ${JSON.stringify(feature.tier)}; must be one of ${TIERS.join(', ')}`);
    }

    // HOW THIS FEATURE IS PROVEN REACHABLE, DECLARED RATHER THAN INFERRED.
    //
    // The first version of this module inferred it, and an adversarial review
    // proved the result lies: `tools: []` fell through both checks as
    // "unconditionally satisfied", so a feature with no declared tools rendered
    // `ready` against a ZERO-TOOL surface. `vault` was the worst case -- tier
    // `gated`, and it reported ready because two source files existed on disk,
    // one of which is the module whose exported job is answering that very
    // question.
    //
    // So the manifest must now SAY what would prove it, and an unrecognised or
    // missing answer is refused exactly like an unrecognised tier:
    //   tools    proven by its ids being in THIS session's resolved tool list
    //   command  proven by its entry command existing on disk (a CLI is
    //            reachable whether or not the MCP surface carries tools)
    //   probe    proven by calling something that actually measures it
    if (!VERIFICATION.includes(feature.verifiedBy)) {
      throw new CapabilityFeatureError('FEATURE_MANIFEST_INVALID',
        `feature ${feature.id} declares verifiedBy ${JSON.stringify(feature.verifiedBy)}; must be one of ${VERIFICATION.join(', ')}`);
    }
    // The specific hole, closed at the source: claiming tool-backing while
    // naming no tools is the shape that produced the lie.
    if (feature.verifiedBy === 'tools' && !(Array.isArray(feature.tools) && feature.tools.length)) {
      throw new CapabilityFeatureError('FEATURE_MANIFEST_INVALID',
        `feature ${feature.id} says it is proven by tools but declares none; that is the defect that made this line lie`);
    }
    if (feature.verifiedBy === 'command' && !(Array.isArray(feature.probeFiles) && feature.probeFiles.length)) {
      throw new CapabilityFeatureError('FEATURE_MANIFEST_INVALID',
        `feature ${feature.id} says it is proven by a command but names no probeFiles`);
    }
    if (feature.verifiedBy === 'probe' && typeof PROBES[feature.id] !== 'function') {
      throw new CapabilityFeatureError('FEATURE_MANIFEST_INVALID',
        `feature ${feature.id} says it is proven by a probe, but no probe is implemented for it`);
    }
  }
  return features;
}

/* Cards are only useful if something APPROVED them. A card index full of
 * pending-review entries is a feature that is installed and has nothing to say,
 * which is exactly the distinction `degraded` exists to carry. */
function cardHealth(indexFile, { readFile = fs.readFileSync } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFile(indexFile, 'utf8'));
  } catch {
    return { total: 0, approved: 0 };
  }
  const cards = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.systems) ? parsed.systems : []);
  const approved = cards.filter(card => {
    const state = String(card?.state || card?.status || '').toLowerCase();
    return state === 'fresh' || state === 'approved';
  }).length;
  return { total: cards.length, approved };
}

/**
 * Resolve every declared feature against what this session can actually reach.
 *
 * @param {string[]} toolNames Tool ids resolved FOR THIS SESSION -- pass
 *   listTools() output, not the static registry, or a confined tier will be
 *   reported as if it were the full surface.
 */
function resolveFeatures({
  toolNames = [],
  manifestFile = MANIFEST_FILE,
  root = ROOT,
  exists = fs.existsSync,
  readFile = fs.readFileSync
} = {}) {
  const available = new Set(toolNames.map(name => (typeof name === 'string' ? name : name?.name)).filter(Boolean));
  const features = readManifest({ manifestFile, readFile });

  return features.map(feature => {
    const declaredTools = Array.isArray(feature.tools) ? feature.tools : [];
    const presentTools = declaredTools.filter(name => available.has(name));
    const probeFiles = Array.isArray(feature.probeFiles) ? feature.probeFiles : [];
    const presentFiles = probeFiles.filter(relative => exists(path.join(root, relative)));

    // BRANCH ON WHAT THE MANIFEST SAYS WOULD PROVE IT. The previous version
    // inferred this from which arrays happened to be non-empty, so an EMPTY
    // array read as "satisfied" rather than "unverifiable" -- which is exactly
    // how a feature came to report ready against a surface holding none of its
    // tools.
    let state = 'ready';
    let reason = null;
    const missingTools = declaredTools.filter(name => !available.has(name));
    const missingFiles = probeFiles.filter(relative => !exists(path.join(root, relative)));

    if (feature.verifiedBy === 'tools') {
      if (missingTools.length) {
        state = 'absent';
        reason = `tools not in this session's surface: ${missingTools.join(', ')}`;
      }
    } else if (feature.verifiedBy === 'command') {
      if (missingFiles.length) {
        state = 'absent';
        reason = `not installed: ${missingFiles.join(', ')}`;
      } else if (missingTools.length) {
        // Reachable by CLI but broken through the tool surface. Two different
        // things, and the honest label for the pair is degraded.
        state = 'degraded';
        reason = `reachable by command, but its tools are absent from this session: ${missingTools.join(', ')}`;
      }
    } else {
      const measured = PROBES[feature.id](root);
      state = measured.state;
      reason = measured.reason;
    }

    // Cards are a separate axis: a feature can be reachable and still have
    // nothing to serve.
    {
      if (state === 'ready' && feature.cardIndex) {
        const cards = cardHealth(path.join(root, feature.cardIndex), { readFile });
        if (cards.approved === 0) {
          state = 'degraded';
          // Phrased as the bare condition, not a sentence: the renderer builds
          // "<id> is installed but <reason>" around it, and a reason that
          // repeated "installed, but" printed it twice in the packet.
          reason = cards.total === 0
            ? 'its index declares no cards'
            : `${cards.total} card(s) are declared and none is approved`;
        }
      }
    }

    return Object.freeze({
      id: feature.id,
      title: typeof feature.title === 'string' ? feature.title : '',
      tier: feature.tier,
      entry: typeof feature.entry === 'string' ? feature.entry : null,
      state,
      reason,
      toolCount: presentTools.length
    });
  });
}

/**
 * The onboarding line itself.
 *
 * Ready features are tagged bare. A degraded one is tagged and marked, because
 * an agent that is told a feature exists will route to it, and being sent to an
 * empty index costs the lookup the feature was supposed to save. Absent
 * features are not printed at all -- a list of what you do not have is not
 * orientation, it is noise.
 */
function featureLine(resolved) {
  const usable = resolved.filter(feature => feature.state !== 'absent');
  if (!usable.length) return null;
  return usable
    .map(feature => (feature.state === 'degraded' ? `[${feature.id}: degraded]` : `[${feature.id}]`))
    .join(' ');
}

module.exports = Object.freeze({
  MANIFEST_FILE,
  TIERS,
  CapabilityFeatureError,
  readManifest,
  resolveFeatures,
  featureLine
});
