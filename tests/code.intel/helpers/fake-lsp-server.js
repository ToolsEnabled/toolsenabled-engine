#!/usr/bin/env node
'use strict';

// A real stdio Language Server, small enough to be a test fixture.
//
// It speaks genuine LSP framing and JSON-RPC over stdin/stdout, so the tests
// exercise the actual transport, handshake, document sync, cancellation and
// teardown paths in src/lib/lsp-client.js -- not a mock of them. Its answers
// come from a fixed table keyed by position, which is what makes the
// assertions deterministic.
//
// Behaviour is selected by argv flags so each pathological case gets a real
// misbehaving server rather than a stubbed rejection:
//
//   --hang-initialize   never answers `initialize`
//   --hang-requests     answers `initialize`, then never answers anything else
//   --no-capabilities   advertises no providers at all
//   --flood             answers with a payload far past the message cap
//   --oversize-header   answers with a bogus Content-Length far past the cap
//   --crash-on-request  exits the process on the first non-initialize request
//   --error-on-request  replies with a JSON-RPC error
//   --no-diagnostics    never publishes diagnostics
//   --clean-diagnostics publishes an empty diagnostics array (a clean file)
//   --pull-diagnostics  advertises diagnosticProvider and answers pull requests
//   --rewrite-uri       publishes under a Windows-style re-encoded file URI
//   --many-symbols      answers documentSymbol with 200 fat symbols

const flags = new Set(process.argv.slice(2));

const HEADER_TERMINATOR = '\r\n\r\n';
let buffer = Buffer.alloc(0);

function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}${HEADER_TERMINATOR}`);
  process.stdout.write(body);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

// A fixed two-file "workspace". Positions are LSP 0-based.
const DEFINITION = {
  uri: null, // filled from the didOpen we receive
  range: { start: { line: 3, character: 9 }, end: { line: 3, character: 21 } }
};

let openedUri = null;

const DOCUMENT_SYMBOLS = [
  {
    name: 'computeTotal',
    kind: 12,
    detail: '(items: Item[]) => number',
    range: { start: { line: 3, character: 0 }, end: { line: 9, character: 1 } },
    selectionRange: { start: { line: 3, character: 9 }, end: { line: 3, character: 21 } },
    children: [
      {
        name: 'running',
        kind: 13,
        range: { start: { line: 4, character: 2 }, end: { line: 4, character: 20 } },
        selectionRange: { start: { line: 4, character: 6 }, end: { line: 4, character: 13 } }
      }
    ]
  },
  {
    name: 'Item',
    kind: 11,
    range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
    selectionRange: { start: { line: 0, character: 10 }, end: { line: 0, character: 14 } }
  }
];

// 200 fat symbols: enough JSON to push a maxResults-legal response past the
// provider's response byte cap, so the byte bound is exercised for real rather
// than assumed.
function manySymbols() {
  return Array.from({ length: 200 }, (unused, index) => ({
    name: `symbol${index}${'N'.repeat(300)}`,
    kind: 12,
    detail: `(argument: ${'D'.repeat(300)}) => void`,
    range: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } },
    selectionRange: { start: { line: 3, character: 9 }, end: { line: 3, character: 21 } }
  }));
}

function workspaceSymbols(query) {
  const all = [
    { name: 'computeTotal', kind: 12, location: { uri: openedUri, range: DEFINITION.range } },
    { name: 'computeAverage', kind: 12, location: { uri: openedUri, range: DEFINITION.range } },
    { name: 'Item', kind: 11, location: { uri: openedUri, range: { start: { line: 0, character: 10 }, end: { line: 0, character: 14 } } } }
  ];
  const needle = String(query || '').toLowerCase();
  return all.filter(entry => entry.name.toLowerCase().includes(needle));
}

const DIAGNOSTICS = [
  {
    range: { start: { line: 4, character: 6 }, end: { line: 4, character: 13 } },
    severity: 1,
    code: 'TS2322',
    source: 'fake-ts',
    message: "Type 'string' is not assignable to type 'number'."
  },
  {
    range: { start: { line: 7, character: 2 }, end: { line: 7, character: 8 } },
    severity: 2,
    source: 'fake-ts',
    message: "'unused' is declared but its value is never read."
  }
];

// Reproduces what a real typescript-language-server does on Windows: it
// publishes diagnostics for `file:///c%3A/...` after being sent
// `file:///C:/...`. Keying off the raw URI string makes those two never match,
// and the file then looks clean. Measured, not invented.
function rewriteUriLikeWindowsServer(uri) {
  return uri.replace(/^file:\/\/\/([A-Za-z]):/, (unused, drive) => `file:///${drive.toLowerCase()}%3A`);
}

function publishDiagnostics(uri) {
  if (flags.has('--no-diagnostics')) return;
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri: flags.has('--rewrite-uri') ? rewriteUriLikeWindowsServer(uri) : uri,
      diagnostics: flags.has('--clean-diagnostics') ? [] : DIAGNOSTICS
    }
  });
}

function capabilities() {
  if (flags.has('--no-capabilities')) return {};
  const base = {
    textDocumentSync: 1,
    definitionProvider: true,
    referencesProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    hoverProvider: true
  };
  if (flags.has('--pull-diagnostics')) base.diagnosticProvider = { interFileDependencies: false, workspaceDiagnostics: false };
  return base;
}

function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    if (flags.has('--hang-initialize')) return;
    reply(id, { capabilities: capabilities(), serverInfo: { name: 'fake-lsp-server', version: '0.0.1' } });
    return;
  }
  if (method === 'initialized') return;
  if (method === 'exit') { process.exit(0); return; }
  if (method === 'shutdown') { reply(id, null); return; }

  if (method === 'textDocument/didOpen') {
    openedUri = params.textDocument.uri;
    DEFINITION.uri = openedUri;
    publishDiagnostics(openedUri);
    return;
  }
  if (method === 'textDocument/didChange') {
    publishDiagnostics(params.textDocument.uri);
    return;
  }
  if (method === 'textDocument/didClose' || method === '$/cancelRequest') return;

  if (flags.has('--hang-requests')) return;
  if (flags.has('--crash-on-request')) { process.exit(7); return; }
  if (flags.has('--error-on-request')) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'fake server refuses this request' } });
    return;
  }
  if (flags.has('--oversize-header')) {
    process.stdout.write(`Content-Length: 99999999999${HEADER_TERMINATOR}`);
    return;
  }
  if (flags.has('--flood')) {
    reply(id, { contents: 'x'.repeat(10 * 1024 * 1024) });
    return;
  }

  switch (method) {
    case 'textDocument/definition': {
      // Only positions on `computeTotal` resolve; anywhere else honestly has
      // no definition, which is what lets the tests distinguish an
      // empty-but-real answer from a failure. Line 12 answers with an array
      // and line 3 with a bare object, because both shapes are legal replies
      // and the client has to normalize either one.
      const position = params.position;
      if (position.line === 12) reply(id, [{ uri: DEFINITION.uri, range: DEFINITION.range }]);
      else if (position.line === 3) reply(id, { uri: DEFINITION.uri, range: DEFINITION.range });
      else reply(id, []);
      return;
    }
    case 'textDocument/references': {
      const includeDeclaration = params.context && params.context.includeDeclaration;
      const locations = [
        { uri: DEFINITION.uri, range: { start: { line: 12, character: 16 }, end: { line: 12, character: 28 } } },
        { uri: DEFINITION.uri, range: { start: { line: 16, character: 4 }, end: { line: 16, character: 16 } } }
      ];
      if (includeDeclaration) locations.unshift({ uri: DEFINITION.uri, range: DEFINITION.range });
      reply(id, locations);
      return;
    }
    case 'textDocument/documentSymbol':
      reply(id, flags.has('--many-symbols') ? manySymbols() : DOCUMENT_SYMBOLS);
      return;
    case 'workspace/symbol':
      reply(id, workspaceSymbols(params.query));
      return;
    case 'textDocument/hover':
      if (params.position.line === 3) {
        reply(id, {
          contents: { kind: 'markdown', value: '```ts\nfunction computeTotal(items: Item[]): number\n```\n\nSums the item totals.' },
          range: DEFINITION.range
        });
      } else {
        reply(id, null);
      }
      return;
    case 'textDocument/diagnostic':
      reply(id, { kind: 'full', items: flags.has('--clean-diagnostics') ? [] : DIAGNOSTICS });
      return;
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unhandled method ${method}` } });
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf(HEADER_TERMINATOR);
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) { buffer = buffer.subarray(headerEnd + HEADER_TERMINATOR.length); continue; }
    const length = Number(match[1]);
    const bodyStart = headerEnd + HEADER_TERMINATOR.length;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.subarray(bodyStart + length);
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { continue; }
    try { handle(parsed); } catch (error) { process.stderr.write(`fake-lsp-server: ${error.message}\n`); }
  }
});

process.stdin.on('end', () => process.exit(0));
