'use strict';

// Compatibility surface for provider and policy callers.
//
// The health observer also needs this policy at every child-process boundary,
// but importing provider code from the observer makes the watcher depend on
// the subsystems it watches. The dependency-light implementation therefore
// lives in supervision/launch-environment.js. Re-exporting the exact function
// objects here keeps every existing provider caller on one scrub, one
// tripwire, and one typed-error contract.

const controlPlaneLaunchEnvironment = require('../supervision/launch-environment.js');

module.exports = Object.freeze({
  BILLING_TRIPWIRE: controlPlaneLaunchEnvironment.BILLING_TRIPWIRE,
  LaunchEnvironmentError: controlPlaneLaunchEnvironment.LaunchEnvironmentError,
  assertNoBillingCredentials: controlPlaneLaunchEnvironment.assertNoBillingCredentials,
  safeLaunchEnvironment: controlPlaneLaunchEnvironment.safeLaunchEnvironment,
  subscriptionLaunchEnvironment: controlPlaneLaunchEnvironment.subscriptionLaunchEnvironment
});
