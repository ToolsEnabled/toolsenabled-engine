'use strict';

const SUPPORTED_SCHEDULED_ACTIONS = Object.freeze([
  'instagram.publish_image', 'gmail.send',
  'calendar.create', 'launch.execute', 'deployment.execute'
]);

const LEGACY_SCHEDULED_ACTION_ALIASES = Object.freeze({
  'instagram.publishImage': 'instagram.publish_image'
});

function normalizeScheduledAction(action) {
  return Object.prototype.hasOwnProperty.call(LEGACY_SCHEDULED_ACTION_ALIASES, action)
    ? LEGACY_SCHEDULED_ACTION_ALIASES[action]
    : action;
}

// SCHEDULING IS WINDOWS-ONLY IN THIS BUILD, AND THE TOOL LIST HAS TO SAY SO.
//
// providers/scheduler.js drives Windows Task Scheduler through
// scheduler-adapter.js and there is no adapter for any other platform, so
// every scheduler.* entry point refuses with SCHEDULER_PLATFORM_UNSUPPORTED
// before it opens a job store. That refusal is correct and already states the
// Windows requirement. What did not state it was the ADVERTISEMENT: measured
// on Linux 2026-09-24, tools/list offered scheduler.list, .create, .remove and
// .reconcile exactly as it does on Windows, and all four refused.
//
// The fact lives here rather than in either caller because it is one fact
// about scheduling and this is the module the registry and the provider
// already share; a second copy in tool-registry.js would be the one that
// drifts the day a Linux adapter lands. providers/scheduler.js states the same
// condition inline in ensureInitialized(); this is the name for it.
const SCHEDULING_PLATFORM = 'win32';

function schedulingSupported(platform = process.platform) {
  return platform === SCHEDULING_PLATFORM;
}

// Appended verbatim to every advertised scheduler.* description, on EVERY
// platform rather than only on the ones that cannot schedule. It is a fact
// about this BUILD, so it is true on Windows too, and a description that
// changes with process.platform would be a description the corpus cannot
// pin down: tools/build-capability-index.js builds config/capability-index.json
// out of these exact strings, `npm run test:capability-index` re-derives it and
// compares, and a platform-decided sentence makes that gate's colour depend on
// which machine ran it. Measured both ways 2026-09-24 on Linux: a conditional
// notice made --check report STALE there while a Windows build would still
// call it CURRENT; this one is the same string on every host. Changing the
// wording below is a description change like any other, so it needs one
// `node tools/build-capability-index.js` run before that gate is green again.
//
// It names the refusal code and says no argument recovers because
// error-taxonomy.js classes SCHEDULER_PLATFORM_UNSUPPORTED as INPUT_REQUIRED,
// and a caller reading only the taxonomy would otherwise try again with
// different arguments.
const SCHEDULER_WINDOWS_ONLY_NOTICE = ' Scheduling is Windows-only in this build:'
  + ' on any other platform every scheduler.* call refuses with'
  + ' SCHEDULER_PLATFORM_UNSUPPORTED, which no argument recovers.';

module.exports = {
  LEGACY_SCHEDULED_ACTION_ALIASES, SCHEDULER_WINDOWS_ONLY_NOTICE,
  SUPPORTED_SCHEDULED_ACTIONS, normalizeScheduledAction, schedulingSupported
};
