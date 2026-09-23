'use strict';

// The Linux source LIVE build invokes this exact entry before activation.
// These are actual native prerequisites, not Windows skips or an npm script
// nobody runs. Missing Linux helpers remain failures in the isolated suites.
// FRA adapter/relay regressions use disposable fixtures. They protect the
// shipped request path but do not claim hosted enrollment or cross-host proof.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

assert.equal(process.platform, 'linux', 'Linux native acceptance requires the Linux kernel');
const root = path.resolve(__dirname, '..');
const NORMAL_REFUSED_SELECTORS = new Set([
  'A28_REGISTRATION_ORIGIN_ONLY', 'A28_FIXTURE_ROOT',
  'T999_RUNTIME_SOURCE', 'T1010_SOURCE', 'T1012_SOURCE', 'T1018_SOURCE',
  'T850_ENGINE_ROOT', 'T850_COMPOSITION_LIB', 'T850_HELPER_PATH',
]);
const MUTATION_SELECTOR = 'CONTINUATION_PRUNE_TEST_MUTATION';
const MUTATION_ARGUMENT = '--mutation-proof=continuation-prune-copy';
function refuseNativeInput(code, selectors = []) {
  throw Object.assign(new Error(code + (selectors.length ? ': ' + selectors.join(', ') : '')),
    { code, selectors });
}
const argumentsForNative = process.argv.slice(2);
if (argumentsForNative.length && (argumentsForNative.length !== 1 || argumentsForNative[0] !== MUTATION_ARGUMENT)) {
  refuseNativeInput('LINUX_NATIVE_INVOCATION_INVALID');
}
const mutationProof = argumentsForNative.length === 1;
const refusedSelectors = [...new Set(Object.keys(process.env)
  .map(key => key.toUpperCase()).filter(key => NORMAL_REFUSED_SELECTORS.has(key)))].sort();
if (refusedSelectors.length) refuseNativeInput('LINUX_NATIVE_SUITE_CONTROL_REFUSED', refusedSelectors);
const mutationKeys = Object.keys(process.env).filter(key => key.toUpperCase() === MUTATION_SELECTOR);
if (mutationKeys.length && (!mutationProof || mutationKeys.length !== 1
    || mutationKeys[0] !== MUTATION_SELECTOR || process.env[MUTATION_SELECTOR] !== 'copy')) {
  refuseNativeInput('LINUX_NATIVE_MUTATION_CONTROL_REFUSED', [MUTATION_SELECTOR]);
}
// Only the explicit proof invocation injects a mutation. Ordinary qualification
// never silently ignores one, and a proof invocation can never return GREEN.
const environment = { ...process.env };
if (mutationProof) environment[MUTATION_SELECTOR] = 'copy';

const started = process.hrtime.bigint();
// Keep the normal test paths at the invocation site so release census follows
// the exact commands executed by this native runner.
const result = spawnSync(process.execPath, [path.join(root, 'tests/run-isolated.js'),
  ...(mutationProof ? ['tests/continuation-prune.test.js'] : [
  'tests/runtime-state-root.test.js',
  'tests/audit-identity-maintenance.test.js',
  'tests/state-store-close.test.js',
  'tests/agent-continuation-person-stop.test.js',
  'tests/agent-continuation-acp-success-status.test.js',
  'tests/task-waiting.test.js',
  'tests/task-waiting-api-map.test.cjs',
  'tests/task-waiting-schema.test.cjs',
  'tests/task-waiting-composition.test.js',
  'tests/task-waiting-legacy-core.test.js',
  'tests/task-waiting-ledger-lockout.test.js',
  'tests/agent-engine/codex-adapter.js',
  'tests/agent-engine/acp-process.test.js',
  'tests/agent-engine/acp-terminal-lifecycle.test.js',
  'tests/agent-engine/acp-exit-diagnostics.test.js',
  'tests/agent-engine/acp-turn-identity.test.js',
  'tests/agent-engine/acp-approval-lifecycle.test.js',
  'tests/agent-engine/local-node-adapter.test.js',
  'tests/agent-engine/claude-cli-adapter-refusals.test.js',
  'tests/antigravity-confinement.test.js',
  'tests/device-credential-clear-outcome.test.js',
  'tests/owner-host-linux.test.js',
  'tests/owner-host-agent-actors.test.js',
  'tests/owner-host-session-cancel.test.js',
  'tests/grok-mcp-wire-names.test.js',
  'tests/ledger-category-reset.test.js',
  'tests/reset-delayed-consumers.test.js',
  'tests/owner-public-prompts.test.js',
  'tests/purchase-recording.test.js',
  'tests/purchase-request-tool.test.js',
  'tests/owner-request-store.test.js',
  'tests/minor-ledger-agent-gate.test.js',
  'tests/runtime-basic-policy.test.js',
  'tests/audit-admission-queue.test.js',
  'tests/diagnostic-retention.test.js',
  'tests/audit-activity.test.js',
  'tests/agent-resource-admission.test.js',
  'tests/agent-resource-host.test.js',
  'tests/owner-host-workspace-ceiling.test.js',
  'tests/browser-owner-refusals.test.js',
  'tests/remote-playwright-provider.js',
  'tests/playwright-gateway.js',
  'tests/browser-owner.js',
  'tests/desktop.browser/browser-owner.js',
  'tests/error-taxonomy-refusal-rescue.test.js',
  'tests/session-workspace-ceiling.test.js',
  'tests/mcp-session-scope-dispatch.test.js',
  'tests/refusals-reach-the-agent.test.js',
  'tests/confined-tree-delegation.test.js',
  'tests/agent-comms/tree-address-historical-sender.test.js',
  'tests/agent-comms/tree-directory-recovery-successor.test.js',
  'tests/mission-bridge-task-list-filter.test.js',
  'tests/mission-bridge.test.js',
  'tests/mission-bridge-owner-tier-refresh.test.js',
  'tests/linux-sandbox-workspace.test.js',
  'tests/linux-bridge-first-run.test.js',
  'tests/agent-resource-direct-root.test.js',
  'tests/linux-agent-launch.test.js',
  'tests/linux-claude-discovery.test.js',
  'tests/linux-process-control.test.js',
  'tests/linux-desktop.test.js',
  'tests/linux-desktop-ask.test.js',
  'tests/linux-desktop-temp.test.js',
  'tests/linux-research-worker.test.js',
  'tests/linux-vault.test.js',
  'tests/online-fra-admin-enrollment.test.js',
  'tests/online-fra-admin-linux-vault.test.js',
  'tests/online-fra-claim-cli-consent.test.js',
  'tests/fra-paired-machine-probe.test.js',
  'tests/online-fra-local-bridge.test.js',
  'tests/online-fra-composite-bridge.test.js',
  'tests/online-fra-bridge-native-http.test.js',
  'tests/online-fra-account-native-http.test.js',
  'tests/online-fra-relay-shell.js',
  'tests/online-fra-relay-shell-refusals.test.js',
  'tests/online-fra-web-client.js',
  'tests/multi-account-registry-write.test.js',
  'tests/action-permission-profiles.test.js',
  'tests/continuation-prune.test.js',
  'tests/t545-permission-provider-separation.test.js',
  'tests/vault-setter-error-boundary.test.js',
  'tests/failover-setting-error-boundary.test.js',
  'tests/audit-admission-error-boundary.test.js',
  'tests/mcp-public-message-boundary.test.js',
  'tests/linux-native-environment.test.js'
])],
  { cwd: root, env: environment, windowsHide: true, shell: false,
    ...(mutationProof
      ? { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
      : { stdio: 'inherit' }) });
const elapsedMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
if (result.error || !Number.isInteger(result.status) || result.status !== 0) {
  console.error(JSON.stringify({ linuxNative: true, status: result.status, signal: result.signal || null,
    errorCode: result.error && result.error.code || null, elapsedMs }));
}

function mutationOutcome(receipt) {
  if (receipt.error || receipt.signal || !Number.isInteger(receipt.status)
      || typeof receipt.stdout !== 'string' || typeof receipt.stderr !== 'string') return 'harness-invalid';
  // The suite can emit its complete TAP before the isolated runner discovers
  // failed custody, configuration drift, or a finalization/refusal error.
  // Such a combined result is not a usable mutation receipt.
  const runnerDiagnostics = /^(?:Isolated scratch preserved because descendant cleanup is unproven:|Config changed while |[0-9]+ requested test file\(s\) were never run;|Isolated runner could not complete:|STRICT INCOMPLETE:|UNEXECUTED \(strict scope refusal\):|SKIP \(|Refusing to run:|[A-Za-z]*Error(?: \[[^\]]+\])?:)/m;
  if (runnerDiagnostics.test(receipt.stderr) || runnerDiagnostics.test(receipt.stdout)) return 'harness-invalid';
  if (receipt.status !== 0 && receipt.status !== 1) return 'harness-invalid';
  const output = receipt.stdout;
  const metric = name => {
    const matches = [...output.matchAll(new RegExp('^# ' + name + ' ([0-9]+)\\r?$', 'gm'))];
    if (matches.length !== 1) return null;
    const value = Number(matches[0][1]);
    return Number.isSafeInteger(value) ? value : null;
  };
  const tests = metric('tests'), passed = metric('pass'), failed = metric('fail');
  const plans = [...output.matchAll(/^1\.\.([0-9]+)\r?$/gm)];
  if (tests === null || tests < 15 || passed === null || failed === null
      || passed + failed !== tests || metric('cancelled') !== 0
      || metric('skipped') !== 0 || metric('todo') !== 0
      || plans.length !== 1 || Number(plans[0][1]) !== tests
      || [...output.matchAll(/^TAP version 13\r?$/gm)].length !== 1
      || /^Bail out!/m.test(output)) return 'harness-invalid';
  const results = [...output.matchAll(/^(not )?ok ([1-9][0-9]*) - (.+)\r?$/gm)];
  if (results.length !== tests || results.some((row, index) => Number(row[2]) !== index + 1)
      || results.filter(row => row[1]).length !== failed
      || results.some(row => /\s+#\s*(?:skip|todo)\b/i.test(row[3]))) return 'harness-invalid';
  if (receipt.status === 0) return failed === 0 ? 'survived' : 'harness-invalid';
  if (failed < 1) return 'harness-invalid';
  const lines = output.split(/\r?\n/);
  const index = lines.findIndex(line => /^not ok [1-9][0-9]* - backup failure prevents removal$/.test(line));
  if (index < 0) return 'harness-invalid';
  let end = index + 1;
  while (end < lines.length && !/^(?:# Subtest:|(?:not )?ok [0-9]+ - |1\.\.|# tests )/.test(lines[end])) end += 1;
  const failure = lines.slice(index + 1, end).join('\n');
  return /^\s+code:\s*['"]ERR_ASSERTION['"]\s*$/m.test(failure)
    ? 'expected-behavior-red' : 'harness-invalid';
}
if (mutationProof) {
  if (typeof result.stdout === 'string') process.stdout.write(result.stdout);
  if (typeof result.stderr === 'string') process.stderr.write(result.stderr);
  const outcome = mutationOutcome(result);
  console.error(JSON.stringify({ linuxNativeMutationProof: 'continuation-prune-copy',
    outcome, suite: 'tests/continuation-prune.test.js', status: result.status,
    signal: result.signal || null, errorCode: result.error && result.error.code || null, elapsedMs }));
  process.exitCode = outcome === 'expected-behavior-red' ? 1 : outcome === 'survived' ? 3 : 2;
} else {
  if (result.error) throw result.error;
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}
