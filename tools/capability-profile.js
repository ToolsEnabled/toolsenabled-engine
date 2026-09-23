'use strict';

// Read-only, redacted local capability-profile inspection.  It intentionally
// has no MCP registration and never resolves a vault handle or starts a
// provider.  Use TOOLSENABLED_STATE_PATH to inspect a test/alternate state DB.

const { getStateStore } = require('../src/lib/state-store');
const capability = require('../src/lib/capability-manifests');

const PROFILE_LIST_LIMIT = 500;

function fail(message) {
  process.stderr.write(`${message}\nUsage:\n  node tools/capability-profile.js inspect --profile-id <id> --version <n>\n  node tools/capability-profile.js list --task-id <durable-task-id>\n`);
  process.exitCode = 2;
}

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--') || token.length < 3 || index + 1 >= argv.length || argv[index + 1].startsWith('--')) return null;
    const key = token.slice(2);
    if (Object.hasOwn(parsed, key)) return null;
    parsed[key] = argv[++index];
  }
  return parsed;
}

const [command, ...raw] = process.argv.slice(2);
const input = options(raw);
if (!input || !command) {
  fail('A supported read-only inspection command is required.');
} else if (command === 'inspect' && Object.keys(input).every(key => ['profile-id', 'version'].includes(key)) && input['profile-id'] && input.version && /^\d+$/.test(input.version)) {
  const profile = getStateStore().getCapabilityProfile({ profileId: input['profile-id'], version: Number(input.version) });
  if (!profile) {
    process.stderr.write('Capability profile not found.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(capability.inspect(profile.manifest, profile.status), null, 2)}\n`);
  }
} else if (command === 'list' && Object.keys(input).length === 1 && input['task-id']) {
  const profiles = getStateStore().listCapabilityProfiles({ taskId: input['task-id'], limit: PROFILE_LIST_LIMIT });
  if (profiles.length === PROFILE_LIST_LIMIT) {
    fail(`Capability profile list reached the ${PROFILE_LIST_LIMIT}-profile inspection limit; completeness could not be established.`);
  } else {
    process.stdout.write(`${JSON.stringify(profiles.map(profile => capability.inspect(profile.manifest, profile.status)), null, 2)}\n`);
  }
} else {
  fail('The requested command arguments are invalid.');
}
