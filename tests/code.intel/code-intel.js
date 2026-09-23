// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-code-intel-code-intel-js):
// - STRENGTHENED: the failed-invocation audit check no longer swallows the
//   invocation failure. It now requires this invocation's own
//   CODE_FILE_NOT_FOUND result before inspecting the ledger.
// - MUTATION: temporarily made src/lib/tool-registry.js resolve the specific
//   missing-file code.hover probe with an empty object. The strengthened
//   assertion went RED with:
//     AssertionError [ERR_ASSERTION]: failed code.hover audit probe: expected a
//     CODE_FILE_NOT_FOUND failure, but the call resolved
//   The product file was then restored byte-for-byte.
// - NOT-FOUND (1): every assertion-bearing loop has a statically non-empty
//   seed or is preceded/followed by an assertion that proves its collection.
// - NOT-FOUND (2): no assertion treats a process exit status or a generic
//   truthy process return as the subject's evidence.
// - NOT-FOUND (3): apart from the fixed audit probe, no catch or optional
//   chain swallows the failure an assertion exists to observe; cleanup catches
//   are non-assertive best effort.
// - NOT-FOUND (4): the fake LSP server is a fixture across a real transport,
//   not a mock of the provider/client behavior asserted here.
// - NOT-FOUND (5): this file contains no skip or platform precondition guard.
// - NOT-FOUND (6): expected semantic values are fixture constants; byte-size
//   expectations independently serialize the final public response.
// - PRECONDITION-NOT-MET: the complete runner also names absent checkout files
//   (tests/mcp-contract.js, tests/allowlist.js, and the Gemini profile), and the
//   isolated target reaches the audit section but cannot read an audit signing
//   key in this environment. Consequently a final whole-file GREEN could not
//   be obtained here; the exact final-run failure is recorded in the commit
//   report rather than misrepresented as a pass.
'use strict';

// Semantic code intelligence (LSP) tests -- R47.
//
// These run against `tests/helpers/fake-lsp-server.js`, a real stdio language
// server small enough to be a fixture. That is deliberate: the point of this
// layer is the transport, the bounds, the process lifecycle and the failure
// taxonomy, and a mock of the client would test none of them. Every assertion
// below therefore crosses a real pipe, real `Content-Length` framing, and a
// real child process.
//
// Audit isolation: this file drives tools through the registry's real
// `executeTool` chokepoint, which writes to the canonical signed ledger. The
// store is pinned to the runner's disposable file before anything loads audit,
// so the main thread and admission worker share one canonical ledger without
// touching the production ledger. Separate ':memory:' stores cannot share the
// worker's projection files. Run with
// `npm run test:code-intel`.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// ---- isolation, before any module that touches audit/state is required -----
const isolated = require('../lib/isolated-environment').activate('code-intel');
assert.equal(process.env.TOOLSENABLED_AUDIT_DB, path.join(isolated.root, 'audit.sqlite3'));
const admission = require('../../src/lib/audit-admission');
require('../../src/lib/throughput-mode').setThroughputModeForTests('fast');
process.env.TOOLSENABLED_AUDIT_ADMISSION_WORKER = '1';
admission.resetAdmissionQueueForTests();

const audit = require('../../src/lib/audit');
audit.resetForTests();

const { getTool, executeTool, TOOL_REGISTRY } = require('../helpers/dispatch');
const codeIntel = require('../../src/lib/providers/code-intel');
const { MessageReader, LspError, LspSession, encodeMessage } = require('../../src/lib/lsp-client');

const FAKE_SERVER = path.join(__dirname, 'helpers', 'fake-lsp-server.js');
const TOOL_NAMES = [
  'code.status', 'code.goto_definition', 'code.find_references',
  'code.document_symbols', 'code.workspace_symbols', 'code.diagnostics', 'code.hover'
];

// 0-based line numbers matter here: they are what the fake server keys on, and
// they are what the provider must convert to the 1-based shape it advertises.
//   line 0  -> `Item` at characters 10..14
//   line 3  -> `computeTotal` declaration at characters 9..21
//   line 4  -> `running` at characters 6..13
//   line 12 -> `computeTotal` call at characters 16..28
//   line 16 -> `computeTotal` call at characters 4..16
const FIXTURE = [
  'interface Item {',
  '  total: number;',
  '}',
  'function computeTotal(items: Item[]): number {',
  '  let running = 0;',
  '  for (const item of items) running += item.total;',
  '  // padding line',
  '  const unused = 1;',
  '  return running;',
  '}',
  '',
  'export function report(items: Item[]): string {',
  '  return String(computeTotal(items));',
  '}',
  '',
  'export function twice(items: Item[]): number {',
  '    computeTotal(items);',
  '  return 0;',
  '}',
  ''
].join('\n');

// Fixtures live under the checkout root, not the system temp directory.
// resolveFilePath() now refuses any `file` outside the ToolsEnabled root and
// every recorded workspace root (see src/lib/code-file-containment.js); a
// fixture directly under os.tmpdir() is a SIBLING of this worktree (which
// itself lives under Temp), so it would be refused CODE_FILE_OUTSIDE_ROOT
// before any of this suite's own LSP-transport assertions ever ran.
const SCRATCH_BASE = path.join(__dirname, '..', '..', 'tmp-code-intel-test');
fs.mkdirSync(SCRATCH_BASE, { recursive: true });
const workspaces = [];
function makeWorkspace(label) {
  const root = fs.mkdtempSync(path.join(SCRATCH_BASE, `te-code-${label}-`));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  fs.writeFileSync(path.join(root, 'total.ts'), FIXTURE);
  workspaces.push(root);
  return { root, file: path.join(root, 'total.ts') };
}

function makeCommonJsWorkspace() {
  const root = fs.mkdtempSync(path.join(SCRATCH_BASE, 'te-code-commonjs-'));
  const target = path.join(root, 'lib', 'tool-registry.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.join(root, 'providers'), { recursive: true });
  fs.writeFileSync(path.join(root, 'jsconfig.json'), '{"compilerOptions":{"checkJs":false}}');
  fs.writeFileSync(target, [
    'function getTool(name) { return name; }',
    'function privateTool() { return null; }',
    'module.exports = { getTool };'
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'job-runner.js'), [
    "const getTool = require('./lib/tool-registry').getTool;",
    "getTool('job');",
    "// require('./lib/tool-registry').getTool is only a comment.",
    "const prose = \"require('./lib/tool-registry').getTool\";"
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'providers', 'scheduler.js'), [
    "const getTool = require('../lib/tool-registry').getTool;",
    "getTool('schedule');"
  ].join('\n'));
  workspaces.push(root);
  return { root, target };
}

function fakeResolver(...serverFlags) {
  return () => ({
    resolved: true,
    serverId: 'fake-lsp-server',
    command: process.execPath,
    args: [FAKE_SERVER, ...serverFlags],
    launcher: 'node-script',
    packageVersion: '0.0.1',
    source: 'test-fixture',
    attempts: []
  });
}

async function useServer(...serverFlags) {
  await codeIntel.stopAllSessionsForTests();
  codeIntel.setServerResolverForTests(fakeResolver(...serverFlags));
}

async function rejectsWithCode(run, code, label) {
  try {
    await run();
  } catch (error) {
    assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code} (${error.message})`);
    return error;
  }
  assert.fail(`${label}: expected a ${code} failure, but the call resolved`);
}

function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function waitForExit(pid, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

// A suite that spawns child processes can exit silently with status 0 if the
// event loop empties mid-await -- which is precisely a green result that
// proves nothing. This guard turns that into a loud failure. It caught a real
// unref bug in lsp-client.js during development.
let completed = false;
process.on('exit', code => {
  if (!completed && code === 0) {
    process.exitCode = 1;
    process.stderr.write('FAIL: the code-intel suite exited before completing. No assertion result below is trustworthy.\n');
  }
});

let checks = 0;
function ok(condition, label) {
  assert.ok(condition, label);
  checks += 1;
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}

function assertExactResponseBytes(payload, label) {
  const serialized = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  eq(payload.responseBytes, serialized, `${label}: responseBytes equals the final serialized structured-content size`);
  ok(serialized <= 96 * 1024, `${label}: final serialized structured content stays within 96 KiB`);
}

(async () => {
  const startedAt = Date.now();

  // -- 1. registry contract -------------------------------------------------
  for (const name of TOOL_NAMES) {
    const tool = getTool(name);
    ok(tool, `${name} is registered`);
    eq(tool.effect, 'local-read', `${name} is classified local-read`);
    eq(tool.annotations.readOnlyHint, true, `${name} is read-only`);
    eq(tool.annotations.destructiveHint, false, `${name} is not destructive`);
    eq(tool.annotations.openWorldHint, false, `${name} does not reach outside this machine`);
    eq(tool.approvalEligible, false, `${name} is not approval-gated`);
    eq(tool.provider, null, `${name} has no external provider`);
    eq(tool.inputSchema.additionalProperties, false, `${name} has a closed schema`);
    ok(!Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'approvalToken'),
      `${name} does not accept an approval token`);
  }
  eq(TOOL_REGISTRY.filter(tool => tool.name.startsWith('code.')).length, TOOL_NAMES.length,
    'the code namespace holds exactly the tools this slice ships');

  // -- 2. framing bounds, at the transport layer ---------------------------
  {
    const reader = new MessageReader({ maxMessageBytes: 1024, maxBufferBytes: 4096 });
    const messages = reader.push(encodeMessage({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    eq(messages.length, 1, 'a whole framed message parses');
    eq(messages[0].result.ok, true, 'the parsed body survives framing');

    const split = encodeMessage({ jsonrpc: '2.0', id: 2, result: 'split' });
    const partial = new MessageReader();
    eq(partial.push(split.subarray(0, 12)).length, 0, 'a partial header yields nothing yet');
    eq(partial.push(split.subarray(12)).length, 1, 'the rest of the message completes it');

    assert.throws(() => new MessageReader({ maxMessageBytes: 32 })
      .push(Buffer.from('Content-Length: 999999\r\n\r\n', 'ascii')),
    error => error instanceof LspError && error.code === 'LSP_RESPONSE_TOO_LARGE',
    'an oversized declared length is refused');
    checks += 1;

    assert.throws(() => new MessageReader().push(Buffer.from('Content-Type: nonsense\r\n\r\n{}', 'ascii')),
      error => error instanceof LspError && error.code === 'LSP_PROTOCOL_ERROR',
      'a header without Content-Length is a protocol failure');
    checks += 1;
  }

  // -- 2a. notification absence is not notification processing failure -----
  {
    const session = new LspSession({
      id: 'notification-distinction',
      command: process.execPath,
      args: [FAKE_SERVER, '--hang-requests'],
      rootUri: 'file:///notification-distinction',
      requestTimeoutMs: 5000
    });
    await session.start();
    session.onNotification('textDocument/publishDiagnostics', () => {
      throw new Error('diagnostic index is unavailable');
    });
    const pending = session.request('workspace/symbol', { query: 'never-answered' });
    session.notify('textDocument/didOpen', {
      textDocument: { uri: 'file:///notification-distinction/file.ts', languageId: 'typescript', version: 1, text: '' }
    });
    const error = await rejectsWithCode(() => pending, 'LSP_NOTIFICATION_HANDLER_FAILED',
      'notification could not be established rather than did not happen');
    eq(error.details.method, 'textDocument/publishDiagnostics',
      'the processing failure identifies the notification that was received');
    await session.stop({ timeoutMs: 100 });
  }

  // -- 3. honest unavailability, never a quiet downgrade -------------------
  {
    await codeIntel.stopAllSessionsForTests();
    codeIntel.setServerResolverForTests(() => ({
      resolved: false,
      attempts: [{ serverId: 'typescript-language-server', reason: 'PACKAGE_NOT_FOUND', install: 'npm install -g typescript-language-server typescript' }]
    }));
    const { file } = makeWorkspace('unavailable');
    const error = await rejectsWithCode(() => executeTool('code.goto_definition', { file, symbol: 'computeTotal' }),
      'CODE_SERVER_UNAVAILABLE', 'missing language server');
    ok(Array.isArray(error.details.attempts) && error.details.attempts.length === 1,
      'the unavailable error names what it looked for and how to install it');
    ok(/will not substitute a text search/i.test(error.message),
      'the unavailable error is explicit that it did not fall back to grep');

    const status = await executeTool('code.status', {});
    eq(status.languages.every(entry => entry.available === false), true,
      'code.status reports unavailable for every language when nothing resolves');
    eq(status.contentTrust, 'untrusted', 'code.status carries the untrusted envelope');
    eq(status.unimplementedMethods.length, 5, 'code.status names the five methods this slice does not ship');
    eq(status.sessions.length, 0, 'code.status never starts a language server');
    assertExactResponseBytes(status, 'unavailable code.status');
  }

  // -- 4. goto_definition, by symbol and by position ------------------------
  {
    await useServer();
    const { root, file } = makeWorkspace('definition');

    const bySymbol = await executeTool('code.goto_definition', { file, symbol: 'computeTotal', occurrence: 2 });
    eq(bySymbol.state, 'found', 'the second occurrence resolves to a definition');
    eq(bySymbol.locations.length, 1, 'exactly one definition location');
    eq(bySymbol.locations[0].line, 4, 'the definition line is reported 1-based');
    eq(bySymbol.locations[0].column, 10, 'the definition column is reported 1-based');
    eq(bySymbol.locations[0].file, file, 'the location resolves back to a filesystem path');
    eq(bySymbol.locations[0].preview, 'function computeTotal(items: Item[]): number {', 'the preview is the real source line');
    eq(bySymbol.queriedAt.line, 13, 'the position actually used is reported, 1-based');
    eq(bySymbol.queriedAt.column, 17, 'the column actually used is reported, 1-based');
    eq(bySymbol.queriedAt.resolvedFrom, 'symbol', 'the result says the position came from a symbol lookup');
    eq(bySymbol.symbolAtPosition, 'computeTotal', 'the identifier under the resolved position is echoed back');
    eq(bySymbol.contentTrust, 'untrusted', 'definition results are untrusted data');
    eq(bySymbol.grantsAuthority, false, 'definition results grant no authority');
    eq(bySymbol.workspace.root, root, 'the workspace root was inferred from tsconfig.json');
    eq(bySymbol.workspace.marker, 'tsconfig.json', 'the inference marker is reported');

    const byPosition = await executeTool('code.goto_definition', { file, line: 13, column: 17 });
    eq(byPosition.locations[0].line, 4, 'the same answer arrives via an explicit 1-based position');
    eq(byPosition.queriedAt.resolvedFrom, 'position', 'an explicit position is labelled as such');

    // A bare Location (not an array) is an equally legal reply shape.
    const declaration = await executeTool('code.goto_definition', { file, symbol: 'computeTotal' });
    eq(declaration.locations.length, 1, 'a non-array Location reply normalizes to one location');

    // The load-bearing distinction: a real "nothing here" is not a failure and
    // does not look like one.
    const nothing = await executeTool('code.goto_definition', { file, line: 7, column: 3 });
    eq(nothing.state, 'no-definition-found', 'an honest empty answer is labelled, not silent');
    eq(nothing.locations.length, 0, 'and it really is empty');
  }

  // Metadata is derived from the source, not the fixture server's semantic
  // answer. Public columns are 1-based UTF-16 offsets, including both halves
  // of an astral identifier and a combining mark within an identifier.
  {
    await useServer();
    const { file } = makeWorkspace('unicode-metadata');
    fs.writeFileSync(file, 'const marker = "🧪"; caféSum();\n');
    for (const tool of ['code.goto_definition', 'code.find_references', 'code.hover']) {
      const result = await executeTool(tool, { file, line: 1, column: 22 });
      eq(result.symbolAtPosition, 'caféSum', `${tool} preserves the complete Unicode identifier`);
      eq(result.queriedAt.column, 22, `${tool} keeps the original UTF-16 query column`);
      assertExactResponseBytes(result, `${tool} Unicode metadata`);
    }
    fs.writeFileSync(file, '𐐀value(); cafe\u0301(); 東京(); $value_2();\n');
    for (const [column, expected] of [
      [1, '𐐀value'], [2, '𐐀value'], [8, '𐐀value'],
      [16, 'cafe\u0301'], [21, '東京'], [30, '$value_2'], [11, null]
    ]) {
      const result = await executeTool('code.hover', { file, line: 1, column });
      eq(result.symbolAtPosition, expected, `Unicode cursor at UTF-16 column ${column}`);
    }
  }

  // -- 5. find_references ---------------------------------------------------
  {
    await useServer();
    const { file } = makeWorkspace('references');

    const withDeclaration = await executeTool('code.find_references', { file, symbol: 'computeTotal' });
    eq(withDeclaration.references.length, 3, 'the declaration is included by default');
    eq(withDeclaration.state, 'found', 'references were found');
    eq(withDeclaration.references[1].line, 13, 'reference lines are 1-based');
    eq(withDeclaration.references[1].column, 17, 'reference columns are 1-based');
    eq(withDeclaration.references[2].preview, 'computeTotal(items);', 'reference previews are the real source lines');
    eq(withDeclaration.truncated, false, 'a complete list is not marked truncated');
    eq(withDeclaration.omittedCount, 0, 'nothing was omitted');

    const withoutDeclaration = await executeTool('code.find_references', { file, symbol: 'computeTotal', includeDeclaration: false });
    eq(withoutDeclaration.references.length, 2, 'includeDeclaration:false drops the declaration');

    const capped = await executeTool('code.find_references', { file, symbol: 'computeTotal', maxResults: 1 });
    eq(capped.references.length, 1, 'maxResults caps the list');
    eq(capped.truncated, true, 'a capped list says so');
    eq(capped.omittedCount, 2, 'and says exactly how many it dropped');
    eq(capped.truncationReason, 'max-results', 'and why');
    eq(capped.totalReported, 3, 'the untruncated total stays visible');
  }

  // -- 5b. LSP CommonJS direct-require blind spot gets an honest supplement --
  {
    await useServer();
    const { target } = makeCommonJsWorkspace();
    const result = await executeTool('code.find_references', { file: target, symbol: 'getTool' });
    const staticMatches = result.references.filter(reference => reference.source === 'static-commonjs-supplement');
    eq(result.lspReportedCount, 3, 'the LSP result remains separately attributable');
    eq(staticMatches.length, 2, 'direct relative require(...).getTool callers are recovered exactly once each');
    eq(staticMatches.map(match => path.basename(match.file)).sort(), ['job-runner.js', 'scheduler.js'],
      'only executable direct-require callers are returned, never comments or strings');
    eq(result.staticCommonJsSupplement.attempted, true, 'CommonJS export target enables the narrow supplement');
    eq(result.staticCommonJsSupplement.state, 'complete', 'bounded scan reports whether it completed');
    eq(result.staticCommonJsSupplement.capped, false, 'small fixture stays below static scan limits');
    eq(result.staticCommonJsSupplement.matches, 2, 'supplement count is explicit');
    ok(/not language-server semantic coverage/i.test(result.staticCommonJsSupplement.note),
      'the supplement never misrepresents static evidence as semantic coverage');
  }

  // -- 6. document_symbols --------------------------------------------------
  {
    await useServer();
    const { file } = makeWorkspace('symbols');
    const outline = await executeTool('code.document_symbols', { file });
    const names = outline.symbols.map(symbol => symbol.name);
    eq(names, ['computeTotal', 'running', 'Item'], 'hierarchical symbols are flattened depth-first');
    eq(outline.symbols[0].kind, 'function', 'LSP symbol kinds are named, not numeric');
    eq(outline.symbols[1].container, 'computeTotal', 'nested symbols carry their container');
    eq(outline.symbols[2].kind, 'interface', 'interface kind maps correctly');
    eq(outline.symbols[0].detail, '(items: Item[]) => number', 'the server-provided detail survives');
    eq(outline.state, 'found', 'symbols were found');
    eq(outline.measurement.unit, 'bytes', 'the measurement block is in bytes');
    eq(outline.measurement.fileBytes, Buffer.byteLength(FIXTURE, 'utf8'), 'fileBytes is the real file size');
    ok(/not a token or cost saving/i.test(outline.measurement.note),
      'the measurement note refuses to claim a token or cost saving');

    const onlyFunctions = await executeTool('code.document_symbols', { file, kind: 'function' });
    eq(onlyFunctions.symbols.length, 1, 'the kind filter applies');
    eq(onlyFunctions.symbols[0].name, 'computeTotal', 'and keeps the right symbol');
  }

  // -- 7. document-symbol defaults are bounded before the byte cap ----------
  {
    await useServer('--many-symbols');
    const { file } = makeWorkspace('symbol-default-cap');
    const defaultOutline = await executeTool('code.document_symbols', { file });
    eq(defaultOutline.symbols.length, 50, 'an omitted maxResults returns exactly the 50-symbol default');
    eq(defaultOutline.totalReported, 200, 'the untruncated document-symbol total remains visible');
    eq(defaultOutline.truncated, true, 'the default cap is never silent');
    eq(defaultOutline.omittedCount, 150, 'the default cap reports the exact omitted count');
    eq(defaultOutline.truncationReason, 'max-results', 'the default cap identifies its deterministic reason');
  }

  // -- 7a. document-symbol input is an exact own data record ---------------
  {
    await useServer();
    const { file } = makeWorkspace('symbol-own-input');
    const inheritedFile = Object.create({ file });
    await rejectsWithCode(() => codeIntel.documentSymbols(inheritedFile), 'CODE_INPUT_INVALID',
      'an inherited file is never accepted as a document-symbol input');

    const inheritedMaxResults = Object.create({ maxResults: 200 });
    inheritedMaxResults.file = file;
    await rejectsWithCode(() => codeIntel.documentSymbols(inheritedMaxResults), 'CODE_INPUT_INVALID',
      'an inherited maxResults is never accepted beside an own file');

    const nullPrototype = Object.create(null);
    nullPrototype.file = file;
    await rejectsWithCode(() => codeIntel.documentSymbols(nullPrototype), 'CODE_INPUT_INVALID',
      'a null-prototype input is rejected rather than ambiguously normalized');

    class CustomInput {}
    const customPrototype = new CustomInput();
    customPrototype.file = file;
    await rejectsWithCode(() => codeIntel.documentSymbols(customPrototype), 'CODE_INPUT_INVALID',
      'a custom-prototype input is rejected');

    const withSymbol = { file };
    withSymbol[Symbol('hidden-option')] = 1;
    await rejectsWithCode(() => codeIntel.documentSymbols(withSymbol), 'CODE_INPUT_INVALID',
      'symbol-keyed options are rejected instead of hidden from validation');

    const accessorFile = {};
    Object.defineProperty(accessorFile, 'file', { enumerable: true, get() { throw new Error('must not run'); } });
    await rejectsWithCode(() => codeIntel.documentSymbols(accessorFile), 'CODE_INPUT_INVALID',
      'accessor options are rejected without invoking the getter');

    const reflectionFailure = new Proxy({ file }, { getPrototypeOf() { throw new Error('must not escape'); } });
    await rejectsWithCode(() => codeIntel.documentSymbols(reflectionFailure), 'CODE_INPUT_INVALID',
      'reflection failures become typed invalid-input errors');
  }

  // -- 7b. explicit deep outlines retain the shared hard cap ----------------
  {
    await useServer('--many-symbols');
    const { file } = makeWorkspace('bytecap');
    const flooded = await executeTool('code.document_symbols', { file, maxResults: 200 });
    ok(flooded.symbols.length <= 200, 'an explicit deep request never exceeds the shared 200-symbol cap');
    eq(flooded.truncated, true, 'an oversized payload is truncated');
    eq(flooded.truncationReason, 'response-byte-cap', 'and attributes the truncation to the byte cap');
    ok(flooded.omittedCount > 0, 'and reports how many symbols it dropped');
    ok(flooded.responseBytes <= 96 * 1024, `the reported size respects the 96 KiB cap (got ${flooded.responseBytes})`);
    // The bound the caller actually feels is the whole serialized payload,
    // including the fields written after it was sized.
    const serialized = Buffer.byteLength(JSON.stringify(flooded), 'utf8');
    ok(serialized <= 96 * 1024, `the serialized payload respects the 96 KiB cap (got ${serialized})`);
    eq(flooded.responseBytes, serialized, 'responseBytes is the exact serialized structured-content size');
    eq(flooded.measurement.responseBytes, serialized, 'document measurement reports that same exact emitted size');
    eq(flooded.totalReported, 200, 'the untruncated total stays visible');
  }

  // -- 8. workspace_symbols -------------------------------------------------
  {
    await useServer();
    const { root, file } = makeWorkspace('workspace');
    // One document must be open for the fake server to know the workspace URI.
    await executeTool('code.document_symbols', { file, root });
    const found = await executeTool('code.workspace_symbols', { query: 'compute', root });
    eq(found.symbols.map(symbol => symbol.name), ['computeTotal', 'computeAverage'], 'the query filters by name');
    eq(found.state, 'found', 'workspace symbols were found');
    eq(found.language, 'typescript', 'the default language family is typescript');
    eq(found.contentTrust, 'untrusted', 'workspace symbols are untrusted data');

    const none = await executeTool('code.workspace_symbols', { query: 'zzzznotasymbol', root });
    eq(none.state, 'no-symbols-found', 'an honest empty workspace search is labelled');
    eq(none.symbols.length, 0, 'and really is empty');
  }

  // -- 9. diagnostics: push, clean, pull, and the never-reported failure ----
  {
    await useServer();
    const { file } = makeWorkspace('diagnostics');
    const pushed = await executeTool('code.diagnostics', { file });
    eq(pushed.mode, 'push', 'push diagnostics come from a publishDiagnostics notification');
    eq(pushed.state, 'reported', 'diagnostics were reported');
    eq(pushed.diagnostics.length, 2, 'both diagnostics arrive');
    eq(pushed.diagnostics[0].severity, 'error', 'severities are named, not numeric');
    eq(pushed.diagnostics[0].code, 'TS2322', 'the diagnostic code survives');
    eq(pushed.diagnostics[0].line, 5, 'diagnostic lines are 1-based');
    eq(pushed.diagnostics[0].preview, 'let running = 0;', 'the offending source line is previewed');
    eq(pushed.counts.error, 1, 'error count');
    eq(pushed.counts.warning, 1, 'warning count');

    const errorsOnly = await executeTool('code.diagnostics', { file, severity: 'error' });
    eq(errorsOnly.diagnostics.length, 1, 'the severity filter applies');
  }
  {
    await useServer('--clean-diagnostics');
    const { file } = makeWorkspace('clean');
    const clean = await executeTool('code.diagnostics', { file });
    eq(clean.state, 'reported-empty', 'a server-attested clean file has its own explicit state');
    eq(clean.diagnostics.length, 0, 'and no diagnostics');
    eq(clean.counts.error, 0, 'and a zero error count');
  }
  {
    await useServer('--pull-diagnostics');
    const { file } = makeWorkspace('pull');
    const pulled = await executeTool('code.diagnostics', { file });
    eq(pulled.mode, 'pull', 'a server advertising diagnosticProvider is asked directly');
    eq(pulled.diagnostics.length, 2, 'and answers with the same diagnostics');
  }
  {
    // Regression: a real typescript-language-server on Windows publishes
    // diagnostics for `file:///c%3A/...` after being sent `file:///C:/...`.
    // Matching on the raw URI string makes a file with errors look clean.
    // Caught by the live check in tests/code-intel-live.js; pinned here.
    await useServer('--rewrite-uri');
    const { file } = makeWorkspace('uriskew');
    const skewed = await executeTool('code.diagnostics', { file, waitMs: 5000 });
    eq(skewed.state, 'reported', 'diagnostics match despite a re-encoded file URI');
    eq(skewed.diagnostics.length, 2, 'and all of them arrive');
    eq(skewed.diagnostics[0].file, file, 'and are attributed to the file we asked about');
  }
  {
    // THE failure this layer exists to prevent: a server that reports nothing
    // must not be indistinguishable from a clean file.
    await useServer('--no-diagnostics');
    const { file } = makeWorkspace('silent');
    const error = await rejectsWithCode(() => executeTool('code.diagnostics', { file, waitMs: 1200 }),
      'CODE_DIAGNOSTICS_NOT_REPORTED', 'a server that never publishes diagnostics');
    ok(/not the same as a clean file/i.test(error.message),
      'the message says explicitly that this is not a clean file');
  }

  // -- 10. hover ------------------------------------------------------------
  {
    await useServer();
    const { file } = makeWorkspace('hover');
    const found = await executeTool('code.hover', { file, symbol: 'computeTotal' });
    eq(found.state, 'found', 'hover found something');
    ok(/function computeTotal\(items: Item\[\]\): number/.test(found.hover), 'the signature comes back');
    eq(found.symbolAtPosition, 'computeTotal', 'the identifier under the cursor is echoed');
    eq(found.range.line, 4, 'the hover range is 1-based');
    assertExactResponseBytes(found, 'found hover');

    const nothing = await executeTool('code.hover', { file, line: 7, column: 3 });
    eq(nothing.state, 'no-hover-at-position', 'an empty hover is an explicit state, not a failure');
    eq(nothing.hover, null, 'and the payload is null rather than an empty string');
    assertExactResponseBytes(nothing, 'empty hover');
  }

  // -- 11. failure taxonomy, one real misbehaving server per case ----------
  {
    await useServer('--hang-requests');
    const { file } = makeWorkspace('hang');
    // The session enters the pool once `initialize` is answered, which this
    // server does; only the follow-up request hangs. That is what makes the
    // pid observable while the request is still in flight.
    let settled = false;
    const pending = executeTool('code.hover', { file, symbol: 'computeTotal', timeoutMs: 1500 })
      .then(() => { settled = true; return null; }, failure => { settled = true; return failure; });
    // Poll for the session as soon as it appears instead of sleeping a fixed
    // 800ms: under CPU contention a single fixed sleep can land close enough
    // to the 1500ms client timeout that the request has already failed by the
    // time this check runs, failing this assertion for a reason that has
    // nothing to do with the behavior under test. Polling from small
    // intervals asserts on the FIRST observed session, which lands as early
    // as the real handshake allows and keeps maximal margin against the
    // 1500ms bound regardless of scheduler load. Admission can also wait for
    // native audit custody BEFORE the LSP request starts. Give that phase its
    // own bounded observation window without increasing the request timeout.
    let pid = null;
    const admissionDeadline = Date.now() + 10000;
    while (!settled && Date.now() < admissionDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const live = codeIntel.sessionPoolForTests().list();
      if (live.length) { pid = live[0].pid; break; }
    }
    ok(pid && processAlive(pid), 'the language server is running while the request is in flight');
    const error = await pending;
    ok(error && error.code === 'CODE_SERVER_TIMEOUT', `a server that never answers times out (got ${error && error.code})`);
    eq(error.details.timeoutMs, 1500, 'the timeout error carries the bound it enforced');
    ok(await waitForExit(pid), `the hung language server process ${pid} was killed, not leaked`);
  }
  {
    await codeIntel.stopAllSessionsForTests();
    // A short handshake budget keeps this case fast; the bound itself is what
    // is under test, not its default value.
    codeIntel.setServerResolverForTests(() => ({ ...fakeResolver('--hang-initialize')(), startTimeoutMs: 1500 }));
    const { file } = makeWorkspace('hanginit');
    const error = await rejectsWithCode(() => executeTool('code.document_symbols', { file }),
      'CODE_SERVER_TIMEOUT', 'a server that never completes the handshake');
    ok(/initialize/.test(error.message), 'the handshake failure names the initialize request');
  }
  {
    await useServer('--crash-on-request');
    const { file } = makeWorkspace('crash');
    await rejectsWithCode(() => executeTool('code.document_symbols', { file }),
      'CODE_SERVER_CRASHED', 'a server that exits mid-request');
  }
  {
    await useServer('--error-on-request');
    const { file } = makeWorkspace('lsperror');
    const error = await rejectsWithCode(() => executeTool('code.document_symbols', { file }),
      'CODE_SERVER_ERROR', 'a server that returns a JSON-RPC error');
    ok(/refuses this request/.test(error.message), 'the server error message is surfaced verbatim');
  }
  {
    await useServer('--flood');
    const { file } = makeWorkspace('flood');
    await rejectsWithCode(() => executeTool('code.document_symbols', { file, timeoutMs: 20_000 }),
      'CODE_RESPONSE_TOO_LARGE', 'a server that floods stdout');
  }
  {
    await useServer('--oversize-header');
    const { file } = makeWorkspace('badheader');
    await rejectsWithCode(() => executeTool('code.hover', { file, symbol: 'computeTotal', timeoutMs: 5000 }),
      'CODE_RESPONSE_TOO_LARGE', 'a server that declares an absurd Content-Length');
  }
  {
    await useServer('--no-capabilities');
    const { file, root } = makeWorkspace('nocaps');
    await rejectsWithCode(() => executeTool('code.hover', { file, symbol: 'computeTotal' }),
      'CODE_METHOD_UNSUPPORTED', 'a server that advertises no hover provider');
    await rejectsWithCode(() => executeTool('code.workspace_symbols', { query: 'x', root }),
      'CODE_METHOD_UNSUPPORTED', 'a server that advertises no workspace symbol provider');
  }

  // -- 12. input validation -------------------------------------------------
  {
    await useServer();
    const { root, file } = makeWorkspace('inputs');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'plain text');
    const outside = makeWorkspace('outside');

    await rejectsWithCode(() => executeTool('code.goto_definition', { file: path.join(root, 'notes.txt'), symbol: 'x' }),
      'CODE_LANGUAGE_UNSUPPORTED', 'an unsupported file extension');
    await rejectsWithCode(() => executeTool('code.goto_definition', { file: path.join(root, 'missing.ts'), symbol: 'x' }),
      'CODE_FILE_NOT_FOUND', 'a file that does not exist');
    await rejectsWithCode(() => executeTool('code.goto_definition', { file, symbol: 'computeTotal', line: 3 }),
      'CODE_INPUT_INVALID', 'symbol and line together');
    await rejectsWithCode(() => executeTool('code.goto_definition', { file, symbol: 'noSuchIdentifier' }),
      'CODE_SYMBOL_NOT_FOUND_IN_FILE', 'a symbol that is not in the file');
    await rejectsWithCode(() => executeTool('code.goto_definition', { file, symbol: 'computeTotal', occurrence: 99 }),
      'CODE_SYMBOL_NOT_FOUND_IN_FILE', 'an occurrence past the last match');
    await rejectsWithCode(() => executeTool('code.goto_definition', { file, line: 9999 }),
      'CODE_POSITION_OUT_OF_RANGE', 'a line past the end of the file');
    await rejectsWithCode(() => executeTool('code.goto_definition', { file: outside.file, root }),
      'CODE_PATH_OUTSIDE_ROOT', 'a file outside the declared workspace root');
    await rejectsWithCode(() => executeTool('code.workspace_symbols', { query: 'x', root: path.join(root, 'nope') }),
      'CODE_ROOT_NOT_FOUND', 'a workspace root that does not exist');
    // Schema-level rejection happens before the handler runs.
    await rejectsWithCode(() => executeTool('code.goto_definition', { file, symbol: 'computeTotal', bogusField: 1 }),
      'INVALID_PARAMS', 'an unknown argument');
    await rejectsWithCode(() => executeTool('code.find_references', { file, symbol: 'computeTotal', maxResults: 9999 }),
      'INVALID_PARAMS', 'a maxResults past the schema cap');
  }

  // -- 12b. the MCP schema and the handler's own field allowlist agree ------
  // Each handler independently rejects unknown fields. If the two lists drift,
  // a call that passes MCP validation gets refused by the handler with a
  // confusing CODE_INPUT_INVALID. This pins them together.
  {
    await useServer();
    const { root, file } = makeWorkspace('fields');
    for (const tool of TOOL_REGISTRY.filter(entry => entry.name.startsWith('code.'))) {
      const probe = {};
      for (const [name, spec] of Object.entries(tool.baseInputSchema.properties)) {
        if (name === 'file') probe[name] = file;
        else if (name === 'root') probe[name] = root;
        else if (name === 'symbol') probe[name] = 'computeTotal';
        else if (name === 'query') probe[name] = 'compute';
        else if (name === 'kind') probe[name] = 'function';
        else if (spec.enum) probe[name] = spec.enum[0];
        else if (spec.type === 'integer') probe[name] = spec.minimum === undefined ? 1 : spec.minimum;
        else if (spec.type === 'boolean') probe[name] = true;
        else probe[name] = 'x';
      }
      // symbol and line/column are mutually exclusive by design; drop the
      // position pair so the probe exercises field acceptance, not that rule.
      if (probe.symbol !== undefined) { delete probe.line; delete probe.column; }
      // The public registry is deliberately handler-free. Dispatch the valid
      // probe through the real permission/schema/audit boundary; swallowing a
      // missing .handler TypeError would make this whole agreement test pass
      // without reaching any provider.
      const answer = await executeTool(tool.name, probe);
      ok(answer && typeof answer === 'object', `${tool.name} executes with every field its MCP schema declares`);
    }
  }

  // -- 13. session lifecycle: reuse, bounded pool, clean shutdown ----------
  {
    await codeIntel.stopAllSessionsForTests();
    let resolverCalls = 0;
    codeIntel.setServerResolverForTests(() => {
      resolverCalls += 1;
      return fakeResolver()();
    });
    const first = makeWorkspace('pool1');
    await executeTool('code.document_symbols', { file: first.file });
    const afterFirst = codeIntel.sessionPoolForTests().list();
    eq(afterFirst.length, 1, 'one workspace means one language server');
    const pid = afterFirst[0].pid;
    ok(processAlive(pid), 'the language server is running');

    await executeTool('code.hover', { file: first.file, symbol: 'computeTotal' });
    const afterSecond = codeIntel.sessionPoolForTests().list();
    eq(afterSecond.length, 1, 'a second call reuses the session rather than spawning again');
    eq(afterSecond[0].pid, pid, 'and it is literally the same process');
    eq(resolverCalls, 2, 'session reuse remains cached while discovery itself is rerun per call');

    const pids = [pid];
    for (const label of ['pool2', 'pool3', 'pool4', 'pool5']) {
      const workspace = makeWorkspace(label);
      await executeTool('code.document_symbols', { file: workspace.file });
      const live = codeIntel.sessionPoolForTests().list();
      ok(live.length <= 4, `the pool never exceeds four sessions (saw ${live.length})`);
      for (const entry of live) if (entry.pid && !pids.includes(entry.pid)) pids.push(entry.pid);
    }
    ok(await waitForExit(pid), 'the evicted oldest session was stopped, not leaked');

    await codeIntel.stopAllSessionsForTests();
    eq(codeIntel.sessionPoolForTests().list().length, 0, 'stopAll empties the pool');
    for (const candidate of pids) ok(await waitForExit(candidate), `session ${candidate} exited on shutdown`);
  }

  // -- 13b. an inconclusive manifest read is not package absence -----------
  {
    await codeIntel.stopAllSessionsForTests();
    codeIntel.setServerResolverForTests(null);
    const originalReadFileSync = fs.readFileSync;
    let injected = 0;
    fs.readFileSync = function failOneManifestRead(file, ...args) {
      if (injected === 0 && path.basename(String(file)) === 'package.json') {
        injected += 1;
        const error = new Error('simulated busy filesystem');
        error.code = 'EIO';
        throw error;
      }
      return originalReadFileSync.call(this, file, ...args);
    };
    try {
      const error = await rejectsWithCode(() => executeTool('code.status', {}),
        'CODE_SERVER_DISCOVERY_INDETERMINATE', 'an EIO while reading a server manifest');
      eq(error.details.fsCode, 'EIO', 'the could-not-tell result preserves the filesystem code');
      ok(/does not claim.*absent/i.test(error.message), 'the could-not-tell result expressly disclaims absence');
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    const retry = await executeTool('code.status', {});
    ok(Array.isArray(retry.languages), 'the transient discovery failure is not latched and a retry performs discovery');
  }

  // -- 14. every invocation is audited through the registry chokepoint -----
  {
    await useServer();
    const { file } = makeWorkspace('audit');
    await executeTool('code.document_symbols', { file }, { requestId: 'code-intel-audit-success' });
    const succeeded = audit.findEvents({ action: 'mcp.tool.succeeded', target: 'code.document_symbols', limit: 200 });
    ok(succeeded.length >= 1, 'a successful code.* call lands in the signed ledger');
    eq(succeeded[0].event.details.effect, 'local-read', 'the audited effect matches the registry classification');
    ok(succeeded.some(entry => entry.event.details.requestId === 'code-intel-audit-success'),
      'the reader sees this exact completed worker-admitted invocation, not an earlier same-tool success');

    await rejectsWithCode(
      () => executeTool('code.hover', { file: path.join(path.dirname(file), 'missing.ts'), symbol: 'x' }, { requestId: 'code-intel-audit-failure' }),
      'CODE_FILE_NOT_FOUND', 'failed code.hover audit probe');
    const failed = audit.findEvents({ action: 'mcp.tool.failed', target: 'code.hover', limit: 200 });
    ok(failed.length >= 1, 'a failed code.* call is audited too');
    ok(failed.some(entry => entry.event.details.requestId === 'code-intel-audit-failure'),
      'the reader sees this exact failed worker-admitted invocation, not an earlier same-tool failure');
    ok(admission.defaultAdmissionQueue().stats().workerBatches > 0, 'the default fast path really admitted records on its worker');
    eq(admission.defaultAdmissionQueue().stats().workerFallbacks, 0, 'an in-thread fallback cannot stand in for the shared-ledger proof');
    eq(audit.verify().valid, true, 'the worker and reader agree on the canonical ledger, anchor, and projections');
  }

  // -- 15. status reports live sessions and the unimplemented surface ------
  {
    await useServer();
    const { file } = makeWorkspace('status');
    await executeTool('code.document_symbols', { file });
    const status = await executeTool('code.status', {});
    const typescript = status.languages.find(entry => entry.language === 'typescript');
    eq(typescript.available, true, 'code.status reports an available server when one resolves');
    eq(typescript.serverId, 'fake-lsp-server', 'and names it');
    eq(status.sessions.length, 1, 'and reports the live session');
    eq(status.lookupPriority[0], 'lsp', 'the documented lookup priority leads with LSP');
    assertExactResponseBytes(status, 'live-session code.status');
    eq(status.unimplementedMethods.map(entry => entry.method),
      ['implementations', 'call_hierarchy', 'type_hierarchy', 'signature_help', 'rename_preview'],
      'the not-yet-built methods are named rather than implied');
  }

  await codeIntel.stopAllSessionsForTests();
  codeIntel.setServerResolverForTests(null);
  for (const root of workspaces) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
  try { fs.rmSync(SCRATCH_BASE, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

  completed = true;
  admission.resetAdmissionQueueForTests();
  console.log(`Semantic code intelligence (LSP) tests passed: ${checks} assertions in ${Date.now() - startedAt} ms.`);
})().catch(error => {
  completed = true;
  process.exitCode = 1;
  console.error(error);
  admission.resetAdmissionQueueForTests();
  codeIntel.stopAllSessionsForTests().catch(() => {});
});
