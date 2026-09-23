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

module.exports = { LEGACY_SCHEDULED_ACTION_ALIASES, SUPPORTED_SCHEDULED_ACTIONS, normalizeScheduledAction };
