// Executable action-guard policy checks.

'use strict';

// Point-of-action refusals for mechanically decidable scope/status boundaries.
//
//   BROWSER ISOLATION     -- the owned browser profile, its cookies, and its CDP endpoint
//                            may never cross into Docker.
//   COMPLETION INTEGRITY -- a timeout or truncation is continuation, never success.
//   LANE SCOPE   -- a local lane cannot invoke outward/cross-machine tools.
//
// Every guard is pinned both on what it must refuse and on the neighboring
// legitimate action it must allow.

const assert = require('node:assert/strict');
const laneScope = require('../../src/lib/lane-scope');
const {
  assertActionGuards, findStringArguments, findBrowserBoundaryViolation, findLaneScopeViolation,
  findTruncatedSuccessClaim, LANE_SCOPE_CROSS_MACHINE_TOOLS
} = require('../../src/lib/action-guards');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

const refuses = (tool, args, code) => {
  assert.throws(() => assertActionGuards(tool, args), (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
};
const allows = (tool, args, why) => {
  assert.doesNotThrow(() => assertActionGuards(tool, args), `false positive -- ${why}`);
};
const withLaneScope = (scope, fn) => {
  const prior = process.env[laneScope.ENV_VAR];
  if (scope === null) delete process.env[laneScope.ENV_VAR];
  else if (typeof scope === 'string') process.env[laneScope.ENV_VAR] = scope;
  else process.env[laneScope.ENV_VAR] = laneScope.serialize(scope);
  try { return fn(); }
  finally {
    if (prior === undefined) delete process.env[laneScope.ENV_VAR];
    else process.env[laneScope.ENV_VAR] = prior;
  }
};

// --- argument traversal -------------------------------------------------------

check('findStringArguments walks nested objects and arrays, and tolerates junk', () => {
  const found = findStringArguments({ a: 'x', b: [{ c: 'y' }], d: 1, e: null, f: '' });
  assert.deepEqual(found.map((entry) => entry.key).sort(), ['a', 'b[0].c']);
  assert.deepEqual(findStringArguments(null), []);
  assert.deepEqual(findStringArguments(undefined), []);
});

// =============================================================================
// BROWSER ISOLATION
// =============================================================================

check('a sandbox write into the owned profile directory is REFUSED', () => {
  refuses('sandbox.workspace_write',
    { handle: 'h', path: 'C:/Users/example/Desktop/ToolsEnabled/profiles/chrome/Default/Preferences', content: 'x' },
    'BROWSER_ISOLATION_REFUSED');
});

check('the refusal names the order, the Duo stake, and the offending value', () => {
  assert.throws(
    () => assertActionGuards('sandbox.exec', { handle: 'h', scriptPath: '/w/x.sh', args: ['cp -r profiles/chrome /w'] }),
    (error) => {
      assert.match(error.message, /Built-in browser isolation policy/);
      assert.match(error.message, /never copy its profile, cookies, or CDP into Docker/);
      assert.match(error.message, /long-lived remembered-device state/);
      assert.match(error.message, /MFA factor/);
      assert.equal(error.field, 'args[0]');
      return true;
    }
  );
});

check('a windows-separator profile path is caught too', () => {
  refuses('sandbox.workspace_read', { handle: 'h', path: 'profiles\\chrome\\Default' }, 'BROWSER_ISOLATION_REFUSED');
});

check('a bare Chrome credential store is caught even without the profile directory name', () => {
  for (const file of ['/work/Cookies', 'C:/tmp/Login Data', '/w/Local State', '/w/Web Data']) {
    refuses('sandbox.workspace_write', { handle: 'h', path: file, content: 'x' }, 'BROWSER_ISOLATION_REFUSED');
  }
});

check('every CDP control-surface shape is caught', () => {
  const cdp = [
    '--remote-debugging-port=9222',
    '--remote-debugging-address=127.0.0.1',
    'ws://127.0.0.1:9222/devtools/browser/6f2c1ab4-0000',
    'http://127.0.0.1:9222/json/version',
    'devtools/browser/6f2c1ab4dead',
    'CDP_ENDPOINT'
  ];
  for (const value of cdp) {
    refuses('sandbox.exec', { handle: 'h', scriptPath: '/w/x.sh', args: [value] }, 'BROWSER_ISOLATION_REFUSED');
  }
});

// The negative half. These are the cases that decide whether this guard is
// trustworthy or just noisy.

check('using the owned profile from the HOST browser is ALLOWED -- the order permits it', () => {
  allows('browser.start', { profilePath: 'profiles/chrome' },
    'the order forbids copying the profile into Docker, not using it on the host');
  allows('browser.navigate', { url: 'http://127.0.0.1:9222/json/version' },
    'a host browser tool is not the Docker boundary this order names');
});

check('an ordinary sandbox call is ALLOWED', () => {
  allows('sandbox.exec', { handle: 'h', scriptPath: '/workspace/run-tests.sh', args: ['--headless', '--ci'] },
    'headless is not remote-debugging');
  allows('sandbox.workspace_write', { handle: 'h', path: '/workspace/src/index.js', content: 'module.exports={};' },
    'an ordinary source path');
  allows('sandbox.create', { agent: 'luna', taskKey: 'q31', networkMode: 'none' }, 'no path at all');
});

check('a profile path embedded in a shell string is caught, not just a bare path', () => {
  // Regression pin: an anchor of "start-of-string or separator" missed
  // `cp -r profiles/chrome /w` entirely -- the most realistic form of this
  // violation. Caught by this file's own negative tests before shipping.
  refuses('sandbox.exec', { handle: 'h', scriptPath: '/w/x.sh', args: ['cp -r profiles/chrome /w'] },
    'BROWSER_ISOLATION_REFUSED');
  refuses('sandbox.exec', { handle: 'h', scriptPath: '/w/x.sh', args: ['tar czf p.tgz "profiles/chrome"'] },
    'BROWSER_ISOLATION_REFUSED');
});

check('prose that happens to contain a credential-store word is ALLOWED', () => {
  // The credential-file match is case-SENSITIVE for exactly this reason.
  allows('sandbox.workspace_write', { handle: 'h', path: '/w/docs.md', content: 'refactor the web data pipeline' },
    'ordinary prose must not read as Chrome\'s "Web Data" store');
  allows('sandbox.workspace_write', { handle: 'h', path: '/w/notes.md', content: 'the local state of the reducer' },
    'ordinary prose must not read as Chrome\'s "Local State" file');
});

check('a path that merely CONTAINS the word chrome or cookie is ALLOWED', () => {
  allows('sandbox.workspace_write', { handle: 'h', path: '/workspace/chrome-extension/manifest.json', content: '{}' },
    'chrome-extension is not profiles/chrome');
  allows('sandbox.workspace_write', { handle: 'h', path: '/workspace/src/cookies.js', content: 'x' },
    'a source file named cookies.js is not Chrome\'s Cookies store');
  allows('sandbox.workspace_write', { handle: 'h', path: '/workspace/profiles/chromium/x', content: 'x' },
    'chromium is not chrome');
});

check('findBrowserBoundaryViolation is scoped to sandbox.* and returns null elsewhere', () => {
  assert.equal(findBrowserBoundaryViolation('browser.start', { path: 'profiles/chrome' }), null);
  assert.ok(findBrowserBoundaryViolation('sandbox.exec', { path: 'profiles/chrome' }));
});

// =============================================================================
// LANE SCOPE
// =============================================================================

const localLane = {
  directiveId: 'R1',
  territory: ['src/lib/action-guards.js'],
  machineScope: 'local'
};

check('a local lane refuses every enumerated outward/cross-machine tool name', () => {
  // Keep the oracle independent of the production-owned Set. Iterating that
  // Set directly used to pass vacuously when it was empty and could not detect
  // an accidentally removed tool.
  const expectedCrossMachineTools = [
    'gmail.send',
    'instagram.verify',
    'instagram.publish_image',
    'workstation.status',
    'workstation.install_cursor',
    'workstation.sync_cursor_extensions',
    'workstation.configure_agent_clients',
    'workstation.initialize_cursor_state',
    'workstation.launch_cursor',
    'iphone.handoff_status',
    'host.read_file',
    'host.write_file',
    'host.patch_file',
    'host.list_dir',
    'host.list_processes',
    'host.exec',
    'repo.read_file',
    'repo.write_file',
    'repo.patch_file',
    'repo.list_dir',
    'agent_comms.send',
    'agent_comms.read'
  ];
  assert.deepEqual(
    [...LANE_SCOPE_CROSS_MACHINE_TOOLS].sort(),
    [...expectedCrossMachineTools].sort(),
    'the production cross-machine tool census must match the independently expected policy surface'
  );
  withLaneScope(localLane, () => {
    for (const tool of expectedCrossMachineTools) {
      refuses(tool, {}, 'LANE_SCOPE_REFUSED');
    }
  });
});

check('family wildcards remain fenced if a new named-family tool is registered later', () => {
  withLaneScope(localLane, () => {
    // Keep this list aligned with the surviving fail-closed
    // families rather than restoring a refusal for a deleted provider.
    for (const tool of ['instagram.future_publish', 'workstation.future_sync', 'iphone.future_copy']) {
      refuses(tool, {}, 'LANE_SCOPE_REFUSED');
    }
  });
});

check('the typed refusal names the directive and missing cross-machine scope', () => {
  withLaneScope(localLane, () => {
    assert.throws(() => assertActionGuards('instagram.publish_image', { imageUrl: 'https://example.invalid/image.jpg' }), error => {
      assert.equal(error.code, 'LANE_SCOPE_REFUSED');
      assert.equal(error.directiveId, 'R1');
      assert.equal(error.requiredMachineScope, 'cross-machine');
      assert.match(error.message, /Directive R1/);
      assert.match(error.message, /machineScope 'cross-machine'/);
      return true;
    });
  });
});

check('a local lane attempting a remote-peer file/send action is refused', () => {
  withLaneScope(localLane, () => {
    refuses('host.write_file', { path: 'C:\\peer\\onboarding.md', content: 'copy' }, 'LANE_SCOPE_REFUSED');
    refuses('repo.write_file', { path: 'docs/onboarding.md', content: 'sync' }, 'LANE_SCOPE_REFUSED');
    refuses('gmail.send', { to: 'peer@example.invalid', subject: 'onboarding', body: 'sync' }, 'LANE_SCOPE_REFUSED');
  });
});

check('cross-machine scope allows the same families through this guard', () => {
  withLaneScope({ ...localLane, machineScope: 'cross-machine' }, () => {
    allows('instagram.future_publish', {}, 'the Instagram family carries explicit cross-machine scope');
    allows('workstation.future_sync', {}, 'the workstation family carries explicit cross-machine scope');
    allows('iphone.future_copy', {}, 'the iPhone family carries explicit cross-machine scope');
    allows('host.write_file', { path: 'C:\\peer\\file', content: 'authorized' }, 'the lane carries explicit cross-machine scope');
  });
});

check('local-only tools and processes without a lane contract remain backward compatible', () => {
  withLaneScope(localLane, () => {
    allows('memory.set', { namespace: 'n', key: 'k', value: 'v' }, 'ordinary local tool');
    assert.equal(findLaneScopeViolation('memory.set', {}), null);
  });
  withLaneScope(null, () => {
    allows('instagram.publish_image', { imageUrl: 'https://example.invalid/image.jpg' }, 'no lane contract is present');
  });
});

check('a malformed contract fails closed only at a cross-machine tool boundary', () => {
  withLaneScope('{not json', () => {
    refuses('instagram.publish_image', {}, 'LANE_SCOPE_REFUSED');
    allows('memory.get', { namespace: 'n', key: 'k' }, 'malformed scope does not disable unrelated local tools');
  });
});

// =============================================================================
// COMPLETION INTEGRITY
// =============================================================================

check('a terminal success carrying a bracketed truncation sentinel is REFUSED', () => {
  refuses('task.complete', { handle: 'h', result: { summary: 'all done [truncated]' } }, 'TRUNCATED_SUCCESS_REFUSED');
  refuses('task.complete', { handle: 'h', result: { summary: 'ok <truncated>' } }, 'TRUNCATED_SUCCESS_REFUSED');
  refuses('task.complete', { handle: 'h', result: { summary: 'done ... (truncated for length)' } }, 'TRUNCATED_SUCCESS_REFUSED');
  refuses('task.complete', { handle: 'h', result: { summary: 'output [output truncated at 8k]' } }, 'TRUNCATED_SUCCESS_REFUSED');
});

check('a provider stop_reason of max_tokens/length is REFUSED', () => {
  refuses('task.complete', { actor: 'a', runId: 'r', handle: 'h', result: { summary: 'stop_reason: max_tokens' } }, 'TRUNCATED_SUCCESS_REFUSED');
  refuses('task.complete', { actor: 'a', runId: 'r', handle: 'h', result: { summary: '"finish_reason":"length"' } }, 'TRUNCATED_SUCCESS_REFUSED');
});

check('process-level kill and timeout sentinels are REFUSED', () => {
  refuses('task.complete', { handle: 'h', result: { summary: 'finished; ETIMEDOUT' } }, 'TRUNCATED_SUCCESS_REFUSED');
  refuses('task.complete', { handle: 'h', result: { summary: 'child exited on SIGKILL' } }, 'TRUNCATED_SUCCESS_REFUSED');
  refuses('task.complete', { handle: 'h', result: { summary: 'command timed out after 600s' } }, 'TRUNCATED_SUCCESS_REFUSED');
});

check('the refusal quotes the order AND names the honest alternatives', () => {
  assert.throws(
    () => assertActionGuards('task.complete', { handle: 'h', result: { summary: 'done [truncated]' } }),
    (error) => {
      assert.match(error.message, /Built-in completion integrity policy/);
      assert.match(error.message, /a timeout or truncation is continuation, never success/);
      assert.match(error.message, /task\.checkpoint/);
      assert.match(error.message, /task\.fail/);
      return true;
    }
  );
  assert.throws(
    () => assertActionGuards('task.complete', { actor: 'a', runId: 'r', handle: 'h', result: { summary: 'x [truncated]' } }),
    (error) => {
      assert.match(error.message, /task\.checkpoint/);
      assert.match(error.message, /task\.fail/);
      return true;
    }
  );
});

// The negative half -- the cry-wolf cases this guard must NOT fire on.

check('honest prose using the words "timed out" or "truncated" is ALLOWED', () => {
  allows('task.complete', { handle: 'h', result: { summary: 'the flaky test that timed out now passes' } },
    'a bare English phrase is not a machine truncation sentinel');
  allows('task.complete', { handle: 'h', result: { summary: 'fixed the bug where long output was truncated' } },
    'describing a truncation bug is not being truncated');
  allows('task.complete', { handle: 'h', result: { summary: 'added a timeout of 30s to the fetch call' } },
    'adding a timeout is a feature, not a failed run');
});

check('recording a FAILURE or a CHECKPOINT with a truncation marker is ALLOWED', () => {
  allows('task.fail', { handle: 'h', disposition: 'retry', code: 'TIMEOUT', message: 'command timed out after 600s' },
    'task.fail is the honest path this order points at -- refusing it would leave no way to be honest');
  allows('task.checkpoint', { handle: 'h', checkpointKey: 'k', checkpoint: { summary: 'partial [truncated]' } },
    'a checkpoint is a continuation, which is exactly what the order asks for');
  allows('task.fail', { actor: 'a', runId: 'r', handle: 'h', failure: { summary: 'ETIMEDOUT' } },
    'task.fail is the honest path');
});

check('an unrelated tool carrying a sentinel is ALLOWED -- scope is terminal-success tools', () => {
  allows('memory.set', { namespace: 'n', key: 'k', value: 'log line: [truncated]' },
    'storing a log that contains a sentinel is not claiming success over it');
  assert.equal(findTruncatedSuccessClaim('memory.set', { value: '[truncated]' }), null);
});

console.log(`Action-guard tests passed (${checks} checks; browser isolation refuses profile/cookie/CDP crossings into `
  + 'Docker, completion integrity refuses a truncated success claim, and lane scope refuses local-lane cross-machine '
  + 'tools -- each pinned alongside the legitimate neighbouring action it must NOT refuse).');
