// EXECUTABLE CHANGE — testcanfail-tests-zed-context-terminal-commands-test-js
//
// Discrimination report (2026-08-26):
// - Strengthened the preview timing contract, whose expected values were imported
//   from the module under test. Mutation: DEFAULT_PREVIEW_MS 500 -> 501,
//   MIN_PREVIEW_MS 50 -> 51, and MAX_PREVIEW_MS 5_000 -> 5_001. Before these
//   assertions the mutation stayed green: "Zed context-terminal command-surface
//   contract tests passed." With these assertions it was red:
//   "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n501 !== 500"
// - NOT-FOUND: assertions in loops/forEach over possibly empty collections.
// - NOT-FOUND: exit-status or truthy-return assertions used as process evidence.
// - NOT-FOUND: try/catch or optional chaining that swallows an expected failure.
// - NOT-FOUND: assertions against mocks of the subject under test.
// - NOT-FOUND: skips or platform/precondition guards that can no-op the file.
// - Same-code expected values other than preview timing were mutation-checked and
//   already made the suite red through independent literal command assertions.
// - Preconditions: all met. The source mutation was restored byte-for-byte
//   (SHA-256 a24db5f5b5227fa744e1516a47d645034031fbf272ffecdff3f908d938e6166a),
//   and the restored run was green: "Zed context-terminal command-surface contract
//   tests passed."

'use strict';

const assert = require('node:assert/strict');
const {
  CONTROL_NAMESPACE,
  DEFAULT_PREVIEW_MS,
  MAX_PREVIEW_MS,
  MIN_PREVIEW_MS,
  createCommandSurface,
  createInputRouter,
  decideNewSession,
  discoverableCommands,
  formatDiscoverability,
  inventoryNativeCommands,
  parseCommand,
  tokenize
} = require('../tools/zed-context-terminal-commands');

// These are public command-surface limits, not an oracle to compute from the
// implementation while testing the implementation's behavior.
assert.equal(DEFAULT_PREVIEW_MS, 500);
assert.equal(MIN_PREVIEW_MS, 50);
assert.equal(MAX_PREVIEW_MS, 5_000);

const stable = createCommandSurface({
  agent: 'codex',
  version: 'inventory-2026-08',
  nativeCommands: ['/help', '/preview', '/status'],
  preferSingleSlash: false
});
assert.equal(stable.namespace, CONTROL_NAMESPACE);
assert.equal(stable.fallbackReason, 'stable-wrapper-namespace');
assert.deepEqual(stable.nativeCollisions, ['help', 'preview']);

const collisionFallback = createCommandSurface({
  agent: 'claude',
  version: 'inventory-2026-08',
  nativeCommands: ['preview', 'context'],
  preferSingleSlash: true
});
assert.equal(collisionFallback.namespace, CONTROL_NAMESPACE);
assert.equal(collisionFallback.fallbackReason, 'native-command-collision');

const cleanSingleSlash = createCommandSurface({
  agent: 'claude',
  version: 'inventory-2026-08',
  nativeCommands: ['status'],
  preferSingleSlash: true
});
assert.equal(cleanSingleSlash.namespace, '/');
assert.deepEqual(inventoryNativeCommands({
  agent: 'codex', version: 'v1', commands: ['/status', 'help']
}).commands, ['help', 'status']);
assert.throws(
  () => inventoryNativeCommands({ agent: 'codex', version: 'v1', commands: ['help', '/help'] }),
  error => error.code === 'NATIVE_COMMAND_DUPLICATE'
);

function bytes(value) {
  return Buffer.from(value, 'utf8');
}

const nativeRaw = bytes('/preview --native "keep this byte stream"\r\n');
const native = parseCommand(nativeRaw, stable);
assert.equal(native.kind, 'native');
assert.deepEqual(native.forward, nativeRaw, 'native input must remain byte-for-byte');
assert.equal(native.recordInNative, true);
assert.equal(native.localOnly, false);

const ordinary = parseCommand('ordinary interactive text\n', stable);
assert.equal(ordinary.kind, 'input');
assert.deepEqual(ordinary.forward, bytes('ordinary interactive text\n'));

const previewInspect = parseCommand('//preview\n', stable);
assert.equal(previewInspect.kind, 'wrapper');
assert.equal(previewInspect.operation, 'preview');
assert.equal(previewInspect.previewMode, 'inspect');
assert.equal(previewInspect.milliseconds, DEFAULT_PREVIEW_MS);
assert.equal(previewInspect.forward, null);
assert.equal(previewInspect.localOnly, true);
assert.equal(previewInspect.recordInNative, false);
assert.equal(previewInspect.durable, false);

const previewOn = parseCommand('//preview on', stable);
assert.equal(previewOn.enabled, true);
assert.equal(previewOn.milliseconds, DEFAULT_PREVIEW_MS);
const previewOff = parseCommand('//preview off', stable);
assert.equal(previewOff.enabled, false);
const previewTune = parseCommand(`//preview ${MAX_PREVIEW_MS}`, stable);
assert.equal(previewTune.milliseconds, MAX_PREVIEW_MS);
assert.equal(parseCommand(`//preview ${MIN_PREVIEW_MS - 1}`, stable).errorCode, 'PREVIEW_BOUNDS');
assert.equal(parseCommand(`//preview ${MAX_PREVIEW_MS + 1}`, stable).errorCode, 'PREVIEW_BOUNDS');
assert.equal(parseCommand('//preview maybe', stable).errorCode, 'PREVIEW_VALUE');
assert.equal(parseCommand('//preview on extra', stable).errorCode, 'PREVIEW_ARGUMENTS');

const context = parseCommand('//context', stable);
assert.equal(context.operation, 'restore-context');
assert.equal(parseCommand('//context now', stable).errorCode, 'CONTEXT_ARGUMENTS');

const session = parseCommand('//session', stable);
assert.deepEqual(session.safeFields, ['agent', 'sessionId', 'resumeSource', 'persistenceHealth']);
assert.equal(parseCommand('//session show-me-the-prompt', stable).errorCode, 'SESSION_ARGUMENTS');

const logs = parseCommand('//logs', stable);
assert.equal(logs.pathsOnly, true);
assert.equal(logs.includeRawContent, false);
assert.equal(parseCommand('//logs raw', stable).errorCode, 'LOGS_ARGUMENTS');

const pendingNew = parseCommand('//new', stable);
assert.equal(pendingNew.operation, 'new-session');
assert.deepEqual(pendingNew.confirmation, { required: true, status: 'pending' });
assert.equal(decideNewSession(pendingNew, 'confirm').accepted, true);
const cancelledNew = decideNewSession(pendingNew, 'cancel');
assert.equal(cancelledNew.cancelled, true);
assert.equal(cancelledNew.accepted, false);
assert.equal(parseCommand('//new confirm', stable).errorCode, 'NEW_ARGUMENTS');
assert.throws(
  () => decideNewSession(pendingNew, 'later'),
  error => error.code === 'NEW_CONFIRMATION_DECISION'
);

const exportWithSpaces = parseCommand(
  '//export-context "C:\\Work Space\\context-only.txt"',
  stable
);
assert.equal(exportWithSpaces.operation, 'export-context');
assert.equal(exportWithSpaces.targetPath, 'C:\\Work Space\\context-only.txt');
assert.equal(exportWithSpaces.includeRaw, false);
assert.equal(parseCommand('//export-context C:\\Work\\context-only.txt extra', stable).errorCode, 'EXPORT_PATH_ARGUMENTS');
assert.equal(parseCommand('//export-context "C:\\Work\\logs\\context.txt"', stable).errorCode, 'EXPORT_TARGET_RAW_LOG');
assert.equal(parseCommand('//export-context "unterminated', stable).errorCode, 'COMMAND_QUOTE_UNTERMINATED');

const unknownWrapper = parseCommand('//not-a-control secret-looking-value', stable);
assert.equal(unknownWrapper.kind, 'invalid-wrapper');
assert.equal(unknownWrapper.errorCode, 'WRAPPER_COMMAND_UNKNOWN');
assert.equal(unknownWrapper.forward, null);
assert.equal(parseCommand('//help', stable).operation, 'help');
assert.equal(parseCommand('//help now', stable).errorCode, 'HELP_ARGUMENTS');

const singleSlashNative = parseCommand('/status', cleanSingleSlash);
assert.equal(singleSlashNative.kind, 'native', 'known native-looking input remains native under the clean inventory');
assert.deepEqual(singleSlashNative.forward, bytes('/status'));
const singleSlashWrapper = parseCommand('/export-context "C:\\Work Space\\out.txt"', cleanSingleSlash);
assert.equal(singleSlashWrapper.kind, 'wrapper');
assert.equal(singleSlashWrapper.targetPath, 'C:\\Work Space\\out.txt');
const malformedSingleSlashWrapper = parseCommand('/export-context "unterminated', cleanSingleSlash);
assert.equal(malformedSingleSlashWrapper.kind, 'invalid-wrapper');
assert.equal(malformedSingleSlashWrapper.errorCode, 'COMMAND_QUOTE_UNTERMINATED');
assert.equal(malformedSingleSlashWrapper.forward, null);
const malformedSingleSlashNative = parseCommand('/status "unterminated', cleanSingleSlash);
assert.equal(malformedSingleSlashNative.kind, 'native');
assert.deepEqual(malformedSingleSlashNative.forward, bytes('/status "unterminated'));
const collisionIsNative = parseCommand('/preview', collisionFallback);
assert.equal(collisionIsNative.kind, 'native');
assert.deepEqual(collisionIsNative.forward, bytes('/preview'));

function forwarded(events) {
  return Buffer.concat(events.filter(event => event.kind === 'forward').map(event => event.bytes));
}

const inputRouter = createInputRouter(stable);
assert.deepEqual(inputRouter.feed('ordinary\n'), [{
  kind: 'forward', bytes: bytes('ordinary\n'), localOnly: false, recordInNative: true, durable: true
}]);
assert.deepEqual(inputRouter.feed('/'), [], 'the router holds only the first slash for namespace detection');
assert.deepEqual(forwarded(inputRouter.feed('status\n')), bytes('/status\n'), 'native single-slash typing is not swallowed');
assert.equal(inputRouter.pendingBytes(), 0);
assert.deepEqual(inputRouter.feed('//preview'), [], 'wrapper input waits for submission');
assert.equal(inputRouter.pendingBytes(), '//preview'.length);
const routedPreview = inputRouter.feed('\r\n');
assert.equal(routedPreview.length, 1);
assert.equal(routedPreview[0].kind, 'wrapper');
assert.equal(routedPreview[0].wrapperCommand, 'preview');
assert.equal(routedPreview[0].forward, null);
assert.deepEqual(forwarded(inputRouter.feed('after\n')), bytes('after\n'));

const routedNew = inputRouter.feed('//new\n')[0];
assert.equal(routedNew.wrapperCommand, 'new');
assert.equal(decideNewSession(routedNew, 'cancel').cancelled, true);
assert.deepEqual(inputRouter.feed('//unknown\n')[0].errorCode, 'WRAPPER_COMMAND_UNKNOWN');
assert.equal(inputRouter.feed('//new')[0], undefined);
const cancelledInput = inputRouter.cancel();
assert.equal(cancelledInput.kind, 'cancelled-wrapper');
assert.equal(cancelledInput.errorCode, 'COMMAND_CANCELLED');
assert.equal(inputRouter.pendingBytes(), 0);
assert.deepEqual(inputRouter.feed('//preview'), []);
const incomplete = inputRouter.flush();
assert.equal(incomplete[0].kind, 'incomplete-wrapper');
assert.equal(incomplete[0].errorCode, 'COMMAND_INCOMPLETE');
assert.equal(inputRouter.pendingBytes(), 0);
assert.deepEqual(inputRouter.feed('/'), []);
assert.deepEqual(inputRouter.flush()[0].bytes, bytes('/'));
assert.throws(
  () => createInputRouter(cleanSingleSlash),
  error => error.code === 'INPUT_ROUTER_NAMESPACE_UNSAFE'
);

assert.deepEqual(tokenize(`//export-context "C:\\Work Space\\a\\\"b.txt"`), [
  '//export-context',
  'C:\\Work Space\\a"b.txt'
]);
assert.deepEqual(discoverableCommands(stable).map(item => item.command), [
  '//help', '//preview [on|off|milliseconds]', '//context', '//session', '//logs', '//new', '//export-context [path]'
]);
const helpText = formatDiscoverability(stable);
assert.match(helpText, /Native single-slash commands pass through byte-for-byte/);
assert.ok(helpText.includes('wrapper namespace: //'));
assert.doesNotMatch(helpText, /prompt|credential|raw terminal bytes/i);

console.log('Zed context-terminal command-surface contract tests passed.');
