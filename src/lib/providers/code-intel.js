'use strict';

// Semantic code intelligence -- Language Server Protocol capability exposed as
// ToolsEnabled MCP tools (owner request R47).
//
// The thesis, which belongs to the owner and is correct: an agent should
// almost never navigate code by raw text when a semantic answer exists. The
// lookup priority is LSP, then AST, then git history, then ripgrep, then full
// file reads. `tools/grepsaver-orient.js` already implements that idea for
// docs and system cards; this implements it for code symbols. Exposing it
// *through* ToolsEnabled rather than through one client's built-in support is
// the whole point: Codex, Gemini, Hermes and the local workers get it too.
//
// Honesty rules inherited from grepsaver-orient, and they are not negotiable:
//
//   * A failure never looks like an empty result. Every abnormal path throws a
//     typed `CodeIntelError`. "The server found nothing" and "we could not ask
//     the server" are different states with different shapes, and the caller
//     can always tell which one it got.
//   * Missing language server means a typed `unavailable`, never a quiet
//     downgrade to text search dressed up as a semantic answer.
//   * Bytes are bytes. Nothing here converts bytes to tokens or claims a
//     saving.
//   * Everything a language server returns is untrusted data. It is derived
//     from files on disk, which are untrusted, and it grants no authority.
//
// Implemented in this slice: goto_definition, find_references,
// document_symbols, workspace_symbols, diagnostics, hover.
//
// Deliberately NOT implemented yet (see UNIMPLEMENTED_METHODS below, which
// `code.status` reports so no caller has to guess): implementations,
// call hierarchy, type hierarchy, signature help, rename preview. Each is an
// additive `withDocument(...)` handler plus a normalizer, following
// `gotoDefinition` below; none needs a change to the transport, the session
// pool, or the bounds. `rename_preview` is the one exception worth flagging:
// a rename that actually edits files is `local-write`, not `local-read`, and
// needs its own effect classification and approval review rather than being
// folded in beside these.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { rootPath } = require('../runtime');
const { LspError, LspSession, LspSessionPool } = require('../lsp-client');
const audit = require('../audit');
const { isInsideAllowedRoots, auditSuccessfulRead } = require('../code-file-containment');

const UNTRUSTED_CONTENT = Object.freeze({ contentTrust: 'untrusted', grantsAuthority: false });

const MAX_PATH_CHARS = 4096;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_CHARS = 200;
const MAX_RESULTS_CAP = 200;
const DEFAULT_MAX_RESULTS = 50;
// A file outline is normally a navigation hint, not a substitute for reading
// an entire large declaration surface. Keep the default tight; callers that
// genuinely need a deep outline can request any explicit value up to the
// shared 200-result cap.
const DEFAULT_DOCUMENT_SYMBOL_MAX_RESULTS = 50;
const DEFAULT_SYMBOL_MAX_RESULTS = 200;
// The response bound the MCP caller actually feels. Results are trimmed from
// the tail and the payload says so; nothing is dropped silently.
const MAX_RESPONSE_BYTES = 96 * 1024;
const MAX_PREVIEW_CHARS = 200;
const MAX_PREVIEW_FILES = 40;
// TypeScript's reference provider does not resolve a CommonJS property reached
// directly through `require('./module').name(...)` in this codebase. This is a
// narrow, explicitly-labelled supplement for that one static form; it never
// substitutes for an unavailable language server or claims semantic coverage.
const MAX_STATIC_COMMONJS_SCAN_FILES = 400;
const MAX_STATIC_COMMONJS_SCAN_BYTES = 8 * 1024 * 1024;
const STATIC_COMMONJS_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const STATIC_COMMONJS_IGNORED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'coverage', 'dist', 'build', 'out', 'logs', 'state',
  'vault', 'profiles', 'captures', 'artifacts', 'reports', 'scratch'
]);
const MAX_HOVER_CHARS = 4000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_START_TIMEOUT_MS = 45_000;
const DEFAULT_DIAGNOSTICS_WAIT_MS = 10_000;
const MAX_ROOT_WALK_DEPTH = 12;
const MAX_OCCURRENCE = 500;

const UNIMPLEMENTED_METHODS = Object.freeze([
  Object.freeze({ method: 'implementations', lspMethod: 'textDocument/implementation', status: 'not-implemented' }),
  Object.freeze({ method: 'call_hierarchy', lspMethod: 'textDocument/prepareCallHierarchy', status: 'not-implemented' }),
  Object.freeze({ method: 'type_hierarchy', lspMethod: 'textDocument/prepareTypeHierarchy', status: 'not-implemented' }),
  Object.freeze({ method: 'signature_help', lspMethod: 'textDocument/signatureHelp', status: 'not-implemented' }),
  Object.freeze({ method: 'rename_preview', lspMethod: 'textDocument/rename', status: 'not-implemented' })
]);

class CodeIntelError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'CodeIntelError';
    this.code = code;
    this.details = details;
  }
}

function codeError(code, message, details, cause) {
  return new CodeIntelError(code, message, details || {}, cause ? { cause } : {});
}

// ---------------------------------------------------------------------------
// Language and server catalog
// ---------------------------------------------------------------------------

const LANGUAGE_BY_EXTENSION = Object.freeze({
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python'
});

const LANGUAGE_FAMILY = Object.freeze({
  typescript: 'typescript',
  typescriptreact: 'typescript',
  javascript: 'typescript',
  javascriptreact: 'typescript',
  python: 'python'
});

// Every entry is a server we know how to launch without a shell. `.cmd`/`.bat`
// shims are refused on purpose: Node will not spawn them without `shell: true`,
// and a shell is both an argument-parsing hazard and, on Windows, a console
// flash. Node-packaged servers are launched through their real JS entry point
// with `process.execPath`, which sidesteps the shim entirely.
const SERVER_CATALOG = Object.freeze([
  Object.freeze({
    id: 'typescript-language-server',
    families: Object.freeze(['typescript']),
    kind: 'node-package',
    packageName: 'typescript-language-server',
    args: Object.freeze(['--stdio']),
    // Resolved and handed over explicitly rather than left to the server's own
    // lookup, which silently fails the whole handshake when it guesses wrong.
    // Verified: typescript 7.x (the native rewrite) ships no lib/tsserver.js
    // and typescript-language-server 5.x cannot drive it, so the version
    // constraint below is a measured fact, not a guess.
    companion: Object.freeze({
      packageName: 'typescript',
      relativeFile: path.join('lib', 'tsserver.js'),
      initializationOptions: file => ({ tsserver: { path: file } })
    }),
    install: 'npm install -g typescript-language-server typescript@5',
    note: 'Needs typescript 5.x resolvable from the workspace or globally; typescript 7.x (native) ships no lib/tsserver.js and is not supported by typescript-language-server 5.x.'
  }),
  Object.freeze({
    id: 'pyright',
    families: Object.freeze(['python']),
    kind: 'node-package',
    packageName: 'pyright',
    binName: 'pyright-langserver',
    args: Object.freeze(['--stdio']),
    install: 'npm install -g pyright'
  }),
  Object.freeze({
    id: 'pylsp',
    families: Object.freeze(['python']),
    kind: 'executable',
    binName: 'pylsp',
    args: Object.freeze([]),
    install: 'pip install python-lsp-server'
  }),
  Object.freeze({
    id: 'jedi-language-server',
    families: Object.freeze(['python']),
    kind: 'executable',
    binName: 'jedi-language-server',
    args: Object.freeze([]),
    install: 'pip install jedi-language-server'
  })
]);

const ROOT_MARKERS = Object.freeze([
  'tsconfig.json', 'jsconfig.json', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'Pipfile', 'package.json', '.git'
]);

const SYMBOL_KINDS = Object.freeze([
  null, 'file', 'module', 'namespace', 'package', 'class', 'method', 'property',
  'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant',
  'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum-member',
  'struct', 'event', 'operator', 'type-parameter'
]);

const DIAGNOSTIC_SEVERITY = Object.freeze([null, 'error', 'warning', 'information', 'hint']);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function nodeModulesRoots(workspaceRoot) {
  const roots = [];
  if (workspaceRoot) {
    let current = path.resolve(workspaceRoot);
    for (let depth = 0; depth < MAX_ROOT_WALK_DEPTH; depth += 1) {
      roots.push(path.join(current, 'node_modules'));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  roots.push(rootPath('node_modules'));
  if (process.env.npm_config_prefix) {
    roots.push(path.join(process.env.npm_config_prefix, 'node_modules'));
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  } else {
    roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  }
  return [...new Set(roots)];
}

function readPackageJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    // ENOENT is the only read failure that proves this particular manifest is
    // absent. Resource exhaustion and I/O failures say nothing about whether
    // the package is installed, so do not turn them into PACKAGE_NOT_FOUND.
    if (error && error.code === 'ENOENT') return null;
    throw codeError('CODE_SERVER_DISCOVERY_INDETERMINATE',
      `Could not inspect language-server manifest ${file}: ${error.message}. This does not claim that the language server is absent.`,
      { file, fsCode: error && error.code ? error.code : null }, error);
  }
}

function resolveNodePackageServer(entry, workspaceRoot) {
  const searched = [];
  for (const modulesRoot of nodeModulesRoots(workspaceRoot)) {
    const packageDir = path.join(modulesRoot, entry.packageName);
    const manifestFile = path.join(packageDir, 'package.json');
    searched.push(manifestFile);
    const manifest = readPackageJson(manifestFile);
    if (!manifest) continue;
    const binField = manifest.bin;
    const wanted = entry.binName || entry.packageName;
    let relative = null;
    if (typeof binField === 'string') relative = binField;
    else if (binField && typeof binField === 'object') relative = binField[wanted] || binField[entry.packageName] || Object.values(binField)[0];
    if (typeof relative !== 'string' || !relative) continue;
    const script = path.resolve(packageDir, relative);
    if (!fs.existsSync(script)) continue;
    const companion = resolveCompanion(entry, workspaceRoot);
    if (entry.companion && !companion) {
      // The server is installed but cannot work. Saying which half is missing
      // beats letting the handshake fail with the server's own error later.
      return {
        resolved: false, serverId: entry.id, reason: 'COMPANION_PACKAGE_NOT_FOUND',
        detail: `${entry.companion.packageName}/${entry.companion.relativeFile.replace(/\\/g, '/')}`,
        searchedCount: searched.length
      };
    }
    return {
      resolved: true,
      serverId: entry.id,
      command: process.execPath,
      args: [script, ...entry.args],
      launcher: 'node-script',
      scriptPath: script,
      initializationOptions: companion ? entry.companion.initializationOptions(companion.file) : undefined,
      companionVersion: companion ? companion.version : null,
      packageVersion: typeof manifest.version === 'string' ? manifest.version : null,
      source: modulesRoot,
      searchedCount: searched.length
    };
  }
  return { resolved: false, serverId: entry.id, reason: 'PACKAGE_NOT_FOUND', searchedCount: searched.length };
}

function resolveCompanion(entry, workspaceRoot) {
  if (!entry.companion) return null;
  for (const modulesRoot of nodeModulesRoots(workspaceRoot)) {
    const packageDir = path.join(modulesRoot, entry.companion.packageName);
    const file = path.join(packageDir, entry.companion.relativeFile);
    if (!fs.existsSync(file)) continue;
    const manifest = readPackageJson(path.join(packageDir, 'package.json'));
    return { file, version: manifest && typeof manifest.version === 'string' ? manifest.version : null };
  }
  return null;
}

function resolveExecutableServer(entry) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const directExtensions = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  const shellOnlyExtensions = process.platform === 'win32' ? ['.cmd', '.bat', '.ps1'] : [];
  let shellOnlyHit = null;
  let searchedCount = 0;
  for (const dir of dirs.slice(0, 400)) {
    for (const extension of directExtensions) {
      const candidate = path.join(dir, `${entry.binName}${extension}`);
      searchedCount += 1;
      if (fs.existsSync(candidate)) {
        return {
          resolved: true,
          serverId: entry.id,
          command: candidate,
          args: [...entry.args],
          launcher: 'executable',
          packageVersion: null,
          source: dir,
          searchedCount
        };
      }
    }
    for (const extension of shellOnlyExtensions) {
      const candidate = path.join(dir, `${entry.binName}${extension}`);
      if (!shellOnlyHit && fs.existsSync(candidate)) shellOnlyHit = candidate;
    }
  }
  if (shellOnlyHit) {
    // Reported, not used. Launching this would need `shell: true`, which this
    // layer refuses; saying so is more useful than "not found".
    return {
      resolved: false, serverId: entry.id, reason: 'LAUNCHER_REQUIRES_SHELL',
      searchedCount, detail: path.basename(shellOnlyHit)
    };
  }
  return { resolved: false, serverId: entry.id, reason: 'EXECUTABLE_NOT_FOUND', searchedCount };
}

function defaultServerResolver(family, workspaceRoot) {
  const attempts = [];
  for (const entry of SERVER_CATALOG) {
    if (!entry.families.includes(family)) continue;
    const outcome = entry.kind === 'node-package'
      ? resolveNodePackageServer(entry, workspaceRoot)
      : resolveExecutableServer(entry);
    if (outcome.resolved) return { ...outcome, attempts };
    attempts.push({ serverId: entry.id, reason: outcome.reason, detail: outcome.detail, install: entry.install, note: entry.note });
  }
  return { resolved: false, attempts };
}

// Test-only seam, mirroring the `flushToolMeterForTests` convention in
// tool-registry.js. Production discovery is filesystem-only: there is
// deliberately no environment variable that can make this layer spawn an
// arbitrary binary.
let serverResolver = defaultServerResolver;
function setServerResolverForTests(resolver) {
  serverResolver = typeof resolver === 'function' ? resolver : defaultServerResolver;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// `code.document_symbols` is frequently called as a compact navigation
// primitive. Its option object must therefore be an ordinary JSON-shaped
// record, not a prototype-bearing or reflective object whose inherited values
// can quietly change a caller's requested bound. Snapshot own data properties
// into a null-prototype internal record so even a polluted Object.prototype
// cannot supply `file` or `maxResults` after validation.
function exactOwnPlainObject(value, label) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('not an own plain object');
    }
    const snapshot = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error('symbol keys are not supported');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('accessor or hidden properties are not supported');
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
    return snapshot;
  } catch {
    throw codeError('CODE_INPUT_INVALID', `${label} input must be an exact plain object with own enumerable data properties.`);
  }
}

function assertNoUnknownFields(args, allowed, label) {
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw codeError('CODE_INPUT_INVALID', `${label} received an unsupported field '${key}'.`);
  }
}

function boundedInteger(value, label, { min, max, fallback }) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw codeError('CODE_INPUT_INVALID', `${label} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

async function resolveFilePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PATH_CHARS) {
    throw codeError('CODE_INPUT_INVALID', 'file must be a non-empty path string.');
  }
  if (value.includes('\u0000')) throw codeError('CODE_INPUT_INVALID', 'file must not contain a null byte.');
  // A relative path resolves against the ToolsEnabled root, matching search.*.
  const resolved = path.resolve(rootPath(), value);
  // Containment BEFORE any stat/read, mirroring host.read_file's own ordering
  // (src/lib/providers/host-control.js#resolveHostPath calls
  // checkContainmentAndExclusions before its mustExist check) -- an absolute
  // `file` argument must not be able to make this function touch the
  // filesystem outside the ToolsEnabled root or a recorded workspace root at
  // all, not even to learn whether something exists there. See
  // src/lib/code-file-containment.js for what "allowed root" means here and
  // why it is checked against both the resolved path and its realpath.
  if (!isInsideAllowedRoots(resolved, { label: 'file' })) {
    // host.read_file's own fail() calls (src/lib/providers/host-control.js)
    // do not audit a refusal -- only a successful, admitted read. This
    // refusal is audited anyway (a broader requirement than host.read_file's
    // own scope), via the same non-gating audit.record() that
    // requireRecordAsync below itself ultimately calls: there is nothing to
    // gate admission of when nothing is going to be read.
    audit.record('code.file_outside_root_refused', resolved, { arg: 'file' });
    // Phrasing mirrors src/lib/providers/host-control.js#checkContainmentAndExclusions:
    // fail('HOST_PATH_OUTSIDE_PROFILE', 'path must be inside the owner profile
    // tree.') -- the containment rule host.read_file enforces, restated for
    // this file's narrower zone. `details.file` is still carried, unlike
    // HostControlError (which has no details at all): every other refusal in
    // this file (CODE_FILE_NOT_FOUND, CODE_ROOT_NOT_FOUND, CODE_PATH_OUTSIDE_ROOT)
    // already does, and changing that convention for one error alone would be
    // its own inconsistency.
    throw codeError('CODE_FILE_OUTSIDE_ROOT',
      'file must be inside the ToolsEnabled root or a recorded workspace root.',
      { file: resolved });
  }
  let stat;
  try { stat = fs.statSync(resolved); }
  catch { throw codeError('CODE_FILE_NOT_FOUND', `No file at ${resolved}.`, { file: resolved }); }
  if (!stat.isFile()) throw codeError('CODE_FILE_NOT_FOUND', `${resolved} is not a regular file.`, { file: resolved });
  if (stat.size > MAX_FILE_BYTES) {
    throw codeError('CODE_FILE_TOO_LARGE', `${resolved} is ${stat.size} bytes; the cap is ${MAX_FILE_BYTES}.`,
      { file: resolved, bytes: stat.size, maxBytes: MAX_FILE_BYTES });
  }
  // A successful, in-bounds resolution is audited the same way
  // host.read_file audits its own successful reads by default
  // (src/lib/providers/host-control.js#readFile: "The file contents are the
  // outward result. Admission must be durable before the read so an
  // unavailable/corrupt audit ledger fails closed."). The content read
  // itself happens moments later in this file's own readFileText(), but this
  // is the single choke point every code.* file access already passes
  // through, so the read audit happens here rather than being duplicated at
  // every call site. Which of three modes this call actually performs
  // (durable admission by default, a non-gating record, or none) is
  // src/lib/code-file-containment.js#auditSuccessfulRead's own decision, not
  // this file's -- see that module for the one line that switches it.
  await auditSuccessfulRead('code.intel.read_file.intent', resolved, { bytes: stat.size });
  return resolved;
}

function resolveWorkspaceRoot(explicitRoot, file) {
  if (explicitRoot !== undefined) {
    if (typeof explicitRoot !== 'string' || !explicitRoot.trim() || explicitRoot.length > MAX_PATH_CHARS) {
      throw codeError('CODE_INPUT_INVALID', 'root must be a non-empty path string.');
    }
    const resolved = path.resolve(rootPath(), explicitRoot);
    let stat;
    try { stat = fs.statSync(resolved); }
    catch { throw codeError('CODE_ROOT_NOT_FOUND', `No directory at ${resolved}.`, { root: resolved }); }
    if (!stat.isDirectory()) throw codeError('CODE_ROOT_NOT_FOUND', `${resolved} is not a directory.`, { root: resolved });
    if (file && !withinRoot(resolved, file)) {
      throw codeError('CODE_PATH_OUTSIDE_ROOT', `${file} is outside the workspace root ${resolved}.`,
        { file, root: resolved });
    }
    return { root: resolved, inferred: false };
  }
  if (!file) throw codeError('CODE_INPUT_INVALID', 'root is required when no file is supplied.');
  let current = path.dirname(file);
  for (let depth = 0; depth < MAX_ROOT_WALK_DEPTH; depth += 1) {
    for (const marker of ROOT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) return { root: current, inferred: true, marker };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { root: path.dirname(file), inferred: true, marker: null };
}

function withinRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function languageOf(file) {
  const extension = path.extname(file).toLowerCase();
  const languageId = LANGUAGE_BY_EXTENSION[extension];
  if (!languageId) {
    throw codeError('CODE_LANGUAGE_UNSUPPORTED',
      `No language server mapping for '${extension || path.basename(file)}'. Supported extensions: ${Object.keys(LANGUAGE_BY_EXTENSION).join(', ')}.`,
      { extension, supported: Object.keys(LANGUAGE_BY_EXTENSION) });
  }
  return { languageId, family: LANGUAGE_FAMILY[languageId] };
}

// ---------------------------------------------------------------------------
// Text helpers -- 1-based line/column everywhere in this layer's public shape,
// converted to LSP's 0-based positions at the boundary and back on the way out.
// Mixing the two conventions is the single most reliable way to ship an
// off-by-one that looks like a working tool.
// ---------------------------------------------------------------------------

function readFileText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { throw codeError('CODE_FILE_NOT_FOUND', `Could not read ${file}: ${error.message}`, { file }, error); }
}

function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;

function identifierAt(lines, zeroLine, zeroCharacter) {
  const line = lines[zeroLine];
  if (typeof line !== 'string') return null;
  const cursor = Math.min(zeroCharacter, line.length);
  // Match code points so accents, combining marks and astral letters do not
  // truncate the label. RegExp indices and string lengths remain UTF-16 code
  // units, matching the query's LSP position even inside a surrogate pair.
  // Keep the existing behavior at an identifier's immediately trailing edge.
  // This lexical label does not replace the language server's semantic answer.
  for (const match of line.matchAll(/[$_\p{ID_Continue}\u200c\u200d]+/gu)) {
    if (match.index > cursor) break;
    const end = match.index + match[0].length;
    if (cursor <= end) {
      return { text: match[0], startCharacter: match.index, endCharacter: end };
    }
  }
  return null;
}

/**
 * Resolve the LSP position to query.
 *
 * Callers may give an explicit 1-based line/column, or a symbol name. The
 * symbol form is what makes this usable by an agent that has a name but no
 * cursor; it reports exactly which occurrence it used so a wrong guess is
 * visible rather than silently producing a confident wrong answer.
 */
function resolvePosition({ lines, line, column, symbol, occurrence }) {
  if (symbol !== undefined) {
    if (line !== undefined || column !== undefined) {
      throw codeError('CODE_INPUT_INVALID', 'Supply either symbol or line/column, never both.');
    }
    if (typeof symbol !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol) || symbol.length > 200) {
      throw codeError('CODE_INPUT_INVALID', 'symbol must be a single identifier.');
    }
    const wanted = boundedInteger(occurrence, 'occurrence', { min: 1, max: MAX_OCCURRENCE, fallback: 1 });
    let seen = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index];
      let from = 0;
      for (;;) {
        const at = text.indexOf(symbol, from);
        if (at === -1) break;
        const beforeOk = at === 0 || !IDENTIFIER_CHARACTER.test(text[at - 1]);
        const afterOk = at + symbol.length >= text.length || !IDENTIFIER_CHARACTER.test(text[at + symbol.length]);
        if (beforeOk && afterOk) {
          seen += 1;
          if (seen === wanted) {
            return { zeroLine: index, zeroCharacter: at, resolvedFrom: 'symbol', occurrence: wanted, occurrencesScanned: seen };
          }
        }
        from = at + Math.max(1, symbol.length);
      }
    }
    throw codeError('CODE_SYMBOL_NOT_FOUND_IN_FILE',
      `Identifier '${symbol}' occurrence ${wanted} is not present in the file (found ${seen}).`,
      { symbol, requestedOccurrence: wanted, foundOccurrences: seen });
  }
  if (occurrence !== undefined) throw codeError('CODE_INPUT_INVALID', 'occurrence applies only with symbol.');
  const oneLine = boundedInteger(line, 'line', { min: 1, max: 5_000_000, fallback: undefined });
  if (oneLine === undefined) throw codeError('CODE_INPUT_INVALID', 'Supply either symbol, or line (and optionally column).');
  if (oneLine > lines.length) {
    throw codeError('CODE_POSITION_OUT_OF_RANGE', `line ${oneLine} exceeds the file's ${lines.length} lines.`,
      { line: oneLine, lineCount: lines.length });
  }
  const oneColumn = boundedInteger(column, 'column', { min: 1, max: 100_000, fallback: 1 });
  return { zeroLine: oneLine - 1, zeroCharacter: oneColumn - 1, resolvedFrom: 'position' };
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const pool = new LspSessionPool({ maxSessions: 4, idleTimeoutMs: 5 * 60_000 });

function sessionKey(family, root) {
  return `${family}\u0000${path.resolve(root).toLowerCase()}`;
}

function unavailableError(family, resolution, root) {
  const attempts = (resolution.attempts || []).map(attempt => ({
    serverId: attempt.serverId,
    reason: attempt.reason,
    detail: attempt.detail,
    install: attempt.install,
    note: attempt.note
  }));
  return codeError('CODE_SERVER_UNAVAILABLE',
    `No usable ${family} language server is installed. Semantic answers are unavailable; this layer will not substitute a text search and call it semantic.`,
    { language: family, workspaceRoot: root, attempts });
}

async function acquireSession(family, root) {
  const resolution = serverResolver(family, root);
  if (!resolution || !resolution.resolved) throw unavailableError(family, resolution || {}, root);
  // A catalog entry may declare a slower handshake budget (pyright starts far
  // more slowly than tsserver). It is bounded either way.
  const startTimeoutMs = Number.isSafeInteger(resolution.startTimeoutMs)
    && resolution.startTimeoutMs >= 1000 && resolution.startTimeoutMs <= 120_000
    ? resolution.startTimeoutMs : DEFAULT_START_TIMEOUT_MS;
  const key = sessionKey(family, root);
  const rootUri = pathToFileURL(path.resolve(root)).href;
  try {
    return await pool.acquire(key, () => {
      const session = new LspSession({
        id: resolution.serverId,
        command: resolution.command,
        args: resolution.args,
        cwd: root,
        env: process.env,
        rootUri,
        initializationOptions: resolution.initializationOptions,
        startTimeoutMs,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS
      });
      session.diagnosticsByUri = new Map();
      session.diagnosticsWaiters = new Map();
      session.onNotification('textDocument/publishDiagnostics', params => {
        if (!params || typeof params.uri !== 'string') return;
        const key = uriKey(params.uri);
        const record = {
          diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics : [],
          receivedAtMs: Date.now(),
          publishedUri: params.uri
        };
        session.diagnosticsByUri.set(key, record);
        const waiters = session.diagnosticsWaiters.get(key);
        if (waiters) {
          session.diagnosticsWaiters.delete(key);
          for (const waiter of waiters) waiter(record);
        }
      });
      return session;
    });
  } catch (error) {
    if (error instanceof LspError) throw translateLspError(error, resolution.serverId);
    throw error;
  }
}

function translateLspError(error, serverId) {
  const mapping = {
    LSP_SERVER_START_FAILED: 'CODE_SERVER_START_FAILED',
    LSP_REQUEST_TIMEOUT: 'CODE_SERVER_TIMEOUT',
    LSP_SERVER_CRASHED: 'CODE_SERVER_CRASHED',
    LSP_SERVER_ERROR: 'CODE_SERVER_ERROR',
    LSP_PROTOCOL_ERROR: 'CODE_SERVER_PROTOCOL_ERROR',
    LSP_RESPONSE_TOO_LARGE: 'CODE_RESPONSE_TOO_LARGE',
    LSP_SESSION_INVALID_STATE: 'CODE_SERVER_UNAVAILABLE',
    LSP_SESSION_STOPPED: 'CODE_SERVER_UNAVAILABLE',
    LSP_INPUT_INVALID: 'CODE_INPUT_INVALID'
  };
  return codeError(mapping[error.code] || 'CODE_SERVER_ERROR', error.message,
    { serverId, lspCode: error.code, ...error.details }, error);
}

function documentVersionState(session, uri) {
  return session.openDocuments.get(uri) || null;
}

/**
 * Open or refresh a document on the session.
 *
 * `forceChange` exists for diagnostics: conforming servers republish on every
 * `didChange`, which is how we get a fresh, attributable diagnostics push
 * rather than a cached one we cannot date.
 */
function syncDocument(session, { uri, languageId, text }, { forceChange = false } = {}) {
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const state = documentVersionState(session, uri);
  if (!state) {
    session.openDocuments.set(uri, { version: 1, hash });
    session.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    return { action: 'opened', version: 1 };
  }
  if (state.hash === hash && !forceChange) return { action: 'reused', version: state.version };
  const version = state.version + 1;
  session.openDocuments.set(uri, { version, hash });
  session.notify('textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text }]
  });
  return { action: 'changed', version };
}

function serverSupports(session, capabilityKey) {
  const capabilities = session.serverCapabilities || {};
  const value = capabilities[capabilityKey];
  return value === true || (value && typeof value === 'object');
}

// ---------------------------------------------------------------------------
// Result normalization and bounding
// ---------------------------------------------------------------------------

function uriToPath(uri) {
  if (typeof uri !== 'string') return null;
  try { return fileURLToPath(uri); }
  catch { return uri; }
}

/**
 * Canonical key for a document URI.
 *
 * Servers do not round-trip our URIs. Measured against a real
 * typescript-language-server on Windows: we send
 * `file:///C:/project/total.ts` and it publishes diagnostics for
 * `file:///c%3A/project/total.ts` -- lowercased drive letter, percent-encoded
 * colon. Keying anything off the raw URI string means those never match, and
 * the symptom is a file that appears to have no diagnostics. Comparing
 * resolved filesystem paths is the only thing that survives.
 */
function uriKey(uri) {
  const file = uriToPath(uri);
  if (typeof file !== 'string') return String(uri);
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createPreviewReader() {
  const cache = new Map();
  let filesRead = 0;
  return {
    line(file, zeroLine) {
      if (!file) return null;
      if (!cache.has(file)) {
        if (filesRead >= MAX_PREVIEW_FILES) return null;
        filesRead += 1;
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { cache.set(file, null); return null; }
          cache.set(file, splitLines(fs.readFileSync(file, 'utf8')));
        } catch { cache.set(file, null); }
      }
      const lines = cache.get(file);
      if (!Array.isArray(lines)) return null;
      const raw = lines[zeroLine];
      if (typeof raw !== 'string') return null;
      const trimmed = raw.trim();
      return trimmed.length > MAX_PREVIEW_CHARS ? `${trimmed.slice(0, MAX_PREVIEW_CHARS)}...` : trimmed;
    },
    get filesRead() { return filesRead; }
  };
}

function normalizeRange(range) {
  const start = (range && range.start) || { line: 0, character: 0 };
  const end = (range && range.end) || start;
  return {
    line: Number(start.line || 0) + 1,
    column: Number(start.character || 0) + 1,
    endLine: Number(end.line || 0) + 1,
    endColumn: Number(end.character || 0) + 1
  };
}

function normalizeLocations(result, previews) {
  const raw = Array.isArray(result) ? result : result ? [result] : [];
  const locations = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    // `Location`, `LocationLink`, both are legal replies to a definition request.
    const uri = item.uri || item.targetUri;
    const range = item.range || item.targetSelectionRange || item.targetRange;
    const file = uriToPath(uri);
    const position = normalizeRange(range);
    locations.push({
      file,
      ...position,
      preview: previews.line(file, position.line - 1)
    });
  }
  return locations;
}

function referenceLocationKey(location) {
  const file = typeof location.file === 'string' ? path.resolve(location.file) : '';
  const normalizedFile = process.platform === 'win32' ? file.toLowerCase() : file;
  return `${normalizedFile}\u0000${location.line}\u0000${location.column}`;
}

function commonJsExportMayContain(text, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = new RegExp(`\\b(?:module\\s*\\.\\s*exports|exports)\\s*\\.\\s*${escaped}\\s*=`);
  if (direct.test(text)) return true;
  // This deliberately recognizes only a bounded conventional object export.
  // It is a dispatch predicate, not proof that every property is exported; any
  // later finding remains explicitly labelled as static, untrusted advice.
  const objectExport = new RegExp(`\\bmodule\\s*\\.\\s*exports\\s*=\\s*\\{[\\s\\S]{0,32768}?\\b${escaped}\\b`);
  return objectExport.test(text);
}

function skipCommonJsTrivia(text, index) {
  let cursor = index;
  for (;;) {
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (text[cursor] === '/' && text[cursor + 1] === '/') {
      cursor += 2;
      while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') cursor += 1;
      continue;
    }
    if (text[cursor] === '/' && text[cursor + 1] === '*') {
      const end = text.indexOf('*/', cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }
    return cursor;
  }
}

function readCommonJsString(text, index) {
  const quote = text[index];
  if (quote !== "'" && quote !== '"') return null;
  let value = '';
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (character === '\\') {
      if (cursor + 1 >= text.length) return null;
      value += text[cursor + 1];
      cursor += 1;
      continue;
    }
    if (character === quote) return { value, end: cursor + 1 };
    if (character === '\n' || character === '\r') return null;
    value += character;
  }
  return null;
}

function commonJsModuleResolvesTo(importerFile, specifier, targetFile) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  const base = path.resolve(path.dirname(importerFile), specifier);
  const candidates = [base];
  for (const extension of STATIC_COMMONJS_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of STATIC_COMMONJS_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));
  const target = path.resolve(targetFile);
  return candidates.some(candidate => path.resolve(candidate) === target);
}

function lineAndColumnAt(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < offset; cursor += 1) {
    if (text[cursor] === '\n') { line += 1; lineStart = cursor + 1; }
  }
  return { line, column: offset - lineStart + 1 };
}

function findInlineCommonJsReferences(text, file, targetFile, identifier) {
  const references = [];
  for (let cursor = 0; cursor < text.length;) {
    const character = text[cursor];
    if (character === '/' && (text[cursor + 1] === '/' || text[cursor + 1] === '*')) {
      cursor = skipCommonJsTrivia(text, cursor);
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      cursor += 1;
      while (cursor < text.length) {
        if (text[cursor] === '\\') { cursor += 2; continue; }
        if (text[cursor] === quote || (quote !== '`' && (text[cursor] === '\n' || text[cursor] === '\r'))) { cursor += 1; break; }
        cursor += 1;
      }
      continue;
    }
    if (!IDENTIFIER_CHARACTER.test(character)) { cursor += 1; continue; }
    const start = cursor;
    while (cursor < text.length && IDENTIFIER_CHARACTER.test(text[cursor])) cursor += 1;
    if (text.slice(start, cursor) !== 'require') continue;
    let next = skipCommonJsTrivia(text, cursor);
    if (text[next] !== '(') continue;
    next = skipCommonJsTrivia(text, next + 1);
    const string = readCommonJsString(text, next);
    if (!string) continue;
    next = skipCommonJsTrivia(text, string.end);
    if (text[next] !== ')') continue;
    next = skipCommonJsTrivia(text, next + 1);
    if (text[next] !== '.') continue;
    next = skipCommonJsTrivia(text, next + 1);
    if (!IDENTIFIER_CHARACTER.test(text[next] || '')) continue;
    const propertyStart = next;
    while (next < text.length && IDENTIFIER_CHARACTER.test(text[next])) next += 1;
    if (text.slice(propertyStart, next) !== identifier) continue;
    if (!commonJsModuleResolvesTo(file, string.value, targetFile)) continue;
    const position = lineAndColumnAt(text, propertyStart);
    const lines = splitLines(text);
    references.push({
      file,
      line: position.line,
      column: position.column,
      endLine: position.line,
      endColumn: position.column + identifier.length,
      preview: (lines[position.line - 1] || '').trim().slice(0, MAX_PREVIEW_CHARS),
      source: 'static-commonjs-supplement'
    });
  }
  return references;
}

function collectStaticCommonJsReferences({ root, targetFile, targetText, identifier }) {
  const base = {
    attempted: false,
    state: 'not-applicable',
    source: 'bounded-static-commonjs-supplement',
    filesScanned: 0,
    bytesScanned: 0,
    capped: false,
    matches: []
  };
  if (!identifier || !commonJsExportMayContain(targetText, identifier)) return base;
  base.attempted = true;
  base.state = 'complete';
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length) {
    const { directory, depth } = pending.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { base.state = 'partial'; continue; }
    for (const entry of entries) {
      if (base.filesScanned >= MAX_STATIC_COMMONJS_SCAN_FILES || base.bytesScanned >= MAX_STATIC_COMMONJS_SCAN_BYTES) {
        base.capped = true;
        base.state = 'partial';
        return base;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth < MAX_ROOT_WALK_DEPTH && !STATIC_COMMONJS_IGNORED_DIRECTORIES.has(entry.name)) {
          pending.push({ directory: candidate, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || !STATIC_COMMONJS_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let stat;
      try { stat = fs.statSync(candidate); }
      catch {
        // The directory entry existed but could not be inspected. Do not let
        // that unknown file silently contribute to a "complete" scan.
        base.state = 'partial';
        continue;
      }
      if (stat.size > MAX_FILE_BYTES || base.bytesScanned + stat.size > MAX_STATIC_COMMONJS_SCAN_BYTES) {
        base.capped = true;
        base.state = 'partial';
        continue;
      }
      let text;
      try { text = fs.readFileSync(candidate, 'utf8'); }
      catch {
        // An unreadable candidate may contain a reference. Preserve that
        // uncertainty instead of reporting the files we did read as the
        // complete search space.
        base.state = 'partial';
        continue;
      }
      base.filesScanned += 1;
      base.bytesScanned += stat.size;
      base.matches.push(...findInlineCommonJsReferences(text, candidate, targetFile, identifier));
    }
  }
  return base;
}

function flattenDocumentSymbols(nodes, previews, file, depth = 0, container = null, out = []) {
  if (!Array.isArray(nodes) || depth > 24) return out;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    // `DocumentSymbol` (hierarchical) and `SymbolInformation` (flat) are both legal.
    const range = node.selectionRange || node.range || (node.location && node.location.range);
    const targetFile = node.location ? uriToPath(node.location.uri) : file;
    const position = normalizeRange(range);
    out.push({
      name: typeof node.name === 'string' ? node.name.slice(0, 300) : '(unnamed)',
      kind: SYMBOL_KINDS[node.kind] || 'unknown',
      container: node.containerName || container,
      detail: typeof node.detail === 'string' ? node.detail.slice(0, 300) : undefined,
      deprecated: node.deprecated === true ? true : undefined,
      file: targetFile,
      ...position,
      preview: previews.line(targetFile, position.line - 1)
    });
    if (Array.isArray(node.children) && node.children.length) {
      flattenDocumentSymbols(node.children, previews, file, depth + 1, typeof node.name === 'string' ? node.name : container, out);
    }
  }
  return out;
}

function normalizeDiagnostics(items, previews, file) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const position = normalizeRange(item.range);
    out.push({
      severity: DIAGNOSTIC_SEVERITY[item.severity] || 'unknown',
      message: typeof item.message === 'string' ? item.message.slice(0, 1000) : '',
      source: typeof item.source === 'string' ? item.source.slice(0, 100) : undefined,
      code: (typeof item.code === 'string' || typeof item.code === 'number') ? String(item.code).slice(0, 100) : undefined,
      file,
      ...position,
      preview: previews.line(file, position.line - 1)
    });
  }
  return out;
}

function hoverText(contents) {
  const parts = [];
  const push = value => {
    if (typeof value === 'string') parts.push(value);
    else if (value && typeof value === 'object' && typeof value.value === 'string') parts.push(value.value);
  };
  if (Array.isArray(contents)) for (const item of contents) push(item);
  else push(contents);
  const joined = parts.join('\n').trim();
  return joined.length > MAX_HOVER_CHARS ? `${joined.slice(0, MAX_HOVER_CHARS)}...` : joined;
}

/**
 * Enforce the response byte cap by dropping from the tail and saying so.
 *
 * Truncation is always visible in the payload. A silently shortened list is
 * indistinguishable from a complete short list, and that ambiguity is exactly
 * the failure mode this module exists to avoid.
 */
function serializedBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

// `responseBytes` is deliberately the actual serialized structured-content
// size, including itself and the duplicate document/diagnostic measurement
// field. The integer reaches a fixed point once its decimal width stabilizes.
function finalizeResponseBytes(payload) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = serializedBytes(payload);
    payload.responseBytes = bytes;
    if (payload.measurement && Object.hasOwn(payload.measurement, 'responseBytes')) {
      payload.measurement.responseBytes = bytes;
    }
    if (serializedBytes(payload) === bytes) return bytes;
  }
  throw codeError('CODE_RESPONSE_TOO_LARGE', 'Could not stabilize exact response byte accounting.');
}

function finalizeBoundedResponse(payload) {
  const bytes = finalizeResponseBytes(payload);
  if (bytes > MAX_RESPONSE_BYTES) {
    throw codeError('CODE_RESPONSE_TOO_LARGE', 'Response exceeds the 96 KiB structured-content cap.');
  }
  return payload;
}

function boundItems(items, listKey, envelope, { maxItems = items.length } = {}) {
  const boundedMaximum = Math.min(items.length, maxItems);
  const initialItems = items.slice(0, boundedMaximum);
  const maxResultsOmitted = items.length - initialItems.length;
  const makePayload = count => {
    const finalItems = initialItems.slice(0, count);
    const responseByteOmitted = initialItems.length - finalItems.length;
    const omittedCount = maxResultsOmitted + responseByteOmitted;
    const payload = {
      ...envelope,
      [listKey]: finalItems,
      truncated: omittedCount > 0,
      omittedCount
    };
    if (responseByteOmitted > 0) payload.truncationReason = 'response-byte-cap';
    else if (maxResultsOmitted > 0) payload.truncationReason = 'max-results';
    finalizeResponseBytes(payload);
    return payload;
  };

  const complete = makePayload(initialItems.length);
  if (complete.responseBytes <= MAX_RESPONSE_BYTES) return complete;
  let low = 0;
  let high = initialItems.length;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    const candidate = makePayload(middle);
    if (candidate.responseBytes <= MAX_RESPONSE_BYTES) low = middle;
    else high = middle - 1;
  }
  const payload = makePayload(low);
  return finalizeBoundedResponse(payload);
}

function baseEnvelope(extra) {
  return { ...UNTRUSTED_CONTENT, ...extra };
}

// ---------------------------------------------------------------------------
// Shared request pipeline
// ---------------------------------------------------------------------------

async function withDocument(args, allowedFields, label, run) {
  if (!plainObject(args)) throw codeError('CODE_INPUT_INVALID', `${label} input must be an object.`);
  assertNoUnknownFields(args, allowedFields, label);
  const file = await resolveFilePath(args.file);
  const { root, inferred, marker } = resolveWorkspaceRoot(args.root, file);
  const { languageId, family } = languageOf(file);
  const timeoutMs = boundedInteger(args.timeoutMs, 'timeoutMs',
    { min: 1000, max: MAX_REQUEST_TIMEOUT_MS, fallback: DEFAULT_REQUEST_TIMEOUT_MS });
  const text = readFileText(file);
  const lines = splitLines(text);
  const uri = pathToFileURL(file).href;
  const session = await acquireSession(family, root);
  try {
    return await run({
      session, file, root, inferred, marker, languageId, family, text, lines, uri, timeoutMs,
      workspace: { root, inferredFromFile: inferred, marker: marker || null }
    });
  } catch (error) {
    if (error instanceof LspError) throw translateLspError(error, session.id);
    throw error;
  }
}

function serverDescriptor(session) {
  return {
    id: session.id,
    info: session.serverInfo ? {
      name: String(session.serverInfo.name || '').slice(0, 120),
      version: session.serverInfo.version === undefined ? null : String(session.serverInfo.version).slice(0, 60)
    } : null
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const POSITION_FIELDS = ['file', 'root', 'line', 'column', 'symbol', 'occurrence', 'maxResults', 'timeoutMs'];

async function gotoDefinition(args = {}) {
  return withDocument(args, new Set(POSITION_FIELDS), 'code.goto_definition', async context => {
    const { session, file, lines, uri, timeoutMs } = context;
    const maxResults = boundedInteger(args.maxResults, 'maxResults', { min: 1, max: MAX_RESULTS_CAP, fallback: DEFAULT_MAX_RESULTS });
    const position = resolvePosition({ lines, line: args.line, column: args.column, symbol: args.symbol, occurrence: args.occurrence });
    if (!serverSupports(session, 'definitionProvider')) {
      throw codeError('CODE_METHOD_UNSUPPORTED', `Language server '${session.id}' does not provide definitions.`,
        { serverId: session.id, method: 'textDocument/definition' });
    }
    syncDocument(session, { uri, languageId: context.languageId, text: context.text });
    const result = await session.request('textDocument/definition', {
      textDocument: { uri },
      position: { line: position.zeroLine, character: position.zeroCharacter }
    }, { timeoutMs });
    const previews = createPreviewReader();
    const locations = normalizeLocations(result, previews);
    const identifier = identifierAt(lines, position.zeroLine, position.zeroCharacter);
    return boundItems(locations, 'locations', baseEnvelope({
      tool: 'code.goto_definition',
      server: serverDescriptor(session),
      workspace: context.workspace,
      file,
      queriedAt: { line: position.zeroLine + 1, column: position.zeroCharacter + 1, resolvedFrom: position.resolvedFrom, occurrence: position.occurrence },
      symbolAtPosition: identifier ? identifier.text : null,
      // A real, server-reported "no definition here" is a legitimate answer and
      // says so explicitly; a failure would have thrown before reaching this.
      state: locations.length ? 'found' : 'no-definition-found',
      filesReadForPreview: previews.filesRead
    }), { maxItems: maxResults });
  });
}

async function findReferences(args = {}) {
  return withDocument(args, new Set([...POSITION_FIELDS, 'includeDeclaration']), 'code.find_references', async context => {
    const { session, file, lines, uri, timeoutMs } = context;
    if (args.includeDeclaration !== undefined && typeof args.includeDeclaration !== 'boolean') {
      throw codeError('CODE_INPUT_INVALID', 'includeDeclaration must be a boolean.');
    }
    const maxResults = boundedInteger(args.maxResults, 'maxResults', { min: 1, max: MAX_RESULTS_CAP, fallback: DEFAULT_MAX_RESULTS });
    const position = resolvePosition({ lines, line: args.line, column: args.column, symbol: args.symbol, occurrence: args.occurrence });
    if (!serverSupports(session, 'referencesProvider')) {
      throw codeError('CODE_METHOD_UNSUPPORTED', `Language server '${session.id}' does not provide references.`,
        { serverId: session.id, method: 'textDocument/references' });
    }
    syncDocument(session, { uri, languageId: context.languageId, text: context.text });
    const result = await session.request('textDocument/references', {
      textDocument: { uri },
      position: { line: position.zeroLine, character: position.zeroCharacter },
      context: { includeDeclaration: args.includeDeclaration !== false }
    }, { timeoutMs });
    const previews = createPreviewReader();
    const lspLocations = normalizeLocations(result, previews).map(location => ({ ...location, source: 'lsp' }));
    const identifier = identifierAt(lines, position.zeroLine, position.zeroCharacter);
    const staticSupplement = collectStaticCommonJsReferences({
      root: context.root,
      targetFile: file,
      targetText: context.text,
      identifier: identifier && identifier.text
    });
    const seen = new Set(lspLocations.map(referenceLocationKey));
    const staticLocations = staticSupplement.matches.filter(location => {
      const key = referenceLocationKey(location);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const all = [...lspLocations, ...staticLocations];
    const payload = boundItems(all, 'references', baseEnvelope({
      tool: 'code.find_references',
      server: serverDescriptor(session),
      workspace: context.workspace,
      file,
      queriedAt: { line: position.zeroLine + 1, column: position.zeroCharacter + 1, resolvedFrom: position.resolvedFrom, occurrence: position.occurrence },
      symbolAtPosition: identifier ? identifier.text : null,
      totalReported: all.length,
      lspReportedCount: lspLocations.length,
      staticCommonJsSupplement: {
        attempted: staticSupplement.attempted,
        state: staticSupplement.state,
        source: staticSupplement.source,
        filesScanned: staticSupplement.filesScanned,
        bytesScanned: staticSupplement.bytesScanned,
        capped: staticSupplement.capped,
        matches: staticLocations.length,
        note: 'Static CommonJS property matches are supplementary untrusted evidence, not language-server semantic coverage.'
      },
      // A failed supplementary filesystem read means an empty result is not a
      // measured negative answer. Keep positive findings useful, but refuse to
      // call a partial, empty scan "no references found".
      state: all.length ? 'found'
        : staticSupplement.state === 'partial' ? 'partial'
          : 'no-references-found',
      filesReadForPreview: previews.filesRead
    }), { maxItems: maxResults });
    return payload;
  });
}

async function documentSymbols(args = {}) {
  const input = exactOwnPlainObject(args, 'code.document_symbols');
  return withDocument(input, new Set(['file', 'root', 'maxResults', 'timeoutMs', 'kind']), 'code.document_symbols', async context => {
    const { session, file, uri, timeoutMs } = context;
    const maxResults = boundedInteger(input.maxResults, 'maxResults', {
      min: 1,
      max: MAX_RESULTS_CAP,
      fallback: DEFAULT_DOCUMENT_SYMBOL_MAX_RESULTS
    });
    if (input.kind !== undefined && (typeof input.kind !== 'string' || !SYMBOL_KINDS.includes(input.kind))) {
      throw codeError('CODE_INPUT_INVALID', 'kind must be one of the supported LSP symbol kinds.');
    }
    if (!serverSupports(session, 'documentSymbolProvider')) {
      throw codeError('CODE_METHOD_UNSUPPORTED', `Language server '${session.id}' does not provide document symbols.`,
        { serverId: session.id, method: 'textDocument/documentSymbol' });
    }
    syncDocument(session, { uri, languageId: context.languageId, text: context.text });
    const result = await session.request('textDocument/documentSymbol', { textDocument: { uri } }, { timeoutMs });
    const previews = createPreviewReader();
    let symbols = flattenDocumentSymbols(result, previews, file);
    if (input.kind) symbols = symbols.filter(symbol => symbol.kind === input.kind);
    const total = symbols.length;
    const payload = boundItems(symbols, 'symbols', baseEnvelope({
      tool: 'code.document_symbols',
      server: serverDescriptor(session),
      workspace: context.workspace,
      file,
      totalReported: total,
      state: total ? 'found' : 'no-symbols-found',
      filesReadForPreview: previews.filesRead,
      // Honest bytes only: this compares the outline against reading the same
      // file in full, which is the actual alternative. It is not a token count
      // and not a cost saving.
      measurement: {
        unit: 'bytes',
        fileBytes: Buffer.byteLength(context.text, 'utf8'),
        responseBytes: null,
        note: 'Bytes only. fileBytes is what reading this file in full would cost; it is not a token or cost saving.'
      }
    }), { maxItems: maxResults });
    return payload;
  });
}

async function workspaceSymbols(args = {}) {
  if (!plainObject(args)) throw codeError('CODE_INPUT_INVALID', 'code.workspace_symbols input must be an object.');
  assertNoUnknownFields(args, new Set(['query', 'root', 'language', 'maxResults', 'timeoutMs']), 'code.workspace_symbols');
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > MAX_QUERY_CHARS) {
    throw codeError('CODE_INPUT_INVALID', `query must be a non-empty string of at most ${MAX_QUERY_CHARS} characters.`);
  }
  const language = args.language === undefined ? 'typescript' : args.language;
  if (typeof language !== 'string' || !Object.values(LANGUAGE_FAMILY).includes(language)) {
    throw codeError('CODE_INPUT_INVALID', `language must be one of: ${[...new Set(Object.values(LANGUAGE_FAMILY))].join(', ')}.`);
  }
  const { root } = resolveWorkspaceRoot(args.root, null);
  const maxResults = boundedInteger(args.maxResults, 'maxResults', { min: 1, max: MAX_RESULTS_CAP, fallback: DEFAULT_SYMBOL_MAX_RESULTS });
  const timeoutMs = boundedInteger(args.timeoutMs, 'timeoutMs',
    { min: 1000, max: MAX_REQUEST_TIMEOUT_MS, fallback: DEFAULT_REQUEST_TIMEOUT_MS });
  const session = await acquireSession(language, root);
  try {
    if (!serverSupports(session, 'workspaceSymbolProvider')) {
      throw codeError('CODE_METHOD_UNSUPPORTED', `Language server '${session.id}' does not provide workspace symbols.`,
        { serverId: session.id, method: 'workspace/symbol' });
    }
    const result = await session.request('workspace/symbol', { query: args.query }, { timeoutMs });
    const previews = createPreviewReader();
    const symbols = flattenDocumentSymbols(result, previews, null);
    const payload = boundItems(symbols, 'symbols', baseEnvelope({
      tool: 'code.workspace_symbols',
      server: serverDescriptor(session),
      workspace: { root, inferredFromFile: false, marker: null },
      query: args.query,
      language,
      totalReported: symbols.length,
      state: symbols.length ? 'found' : 'no-symbols-found',
      filesReadForPreview: previews.filesRead
    }), { maxItems: maxResults });
    return payload;
  } catch (error) {
    if (error instanceof LspError) throw translateLspError(error, session.id);
    throw error;
  }
}

async function diagnostics(args = {}) {
  return withDocument(args, new Set(['file', 'root', 'maxResults', 'timeoutMs', 'severity', 'waitMs']), 'code.diagnostics', async context => {
    const { session, file, uri } = context;
    const maxResults = boundedInteger(args.maxResults, 'maxResults', { min: 1, max: MAX_RESULTS_CAP, fallback: DEFAULT_MAX_RESULTS });
    const waitMs = boundedInteger(args.waitMs, 'waitMs', { min: 500, max: MAX_REQUEST_TIMEOUT_MS, fallback: DEFAULT_DIAGNOSTICS_WAIT_MS });
    if (args.severity !== undefined && (typeof args.severity !== 'string' || !DIAGNOSTIC_SEVERITY.includes(args.severity))) {
      throw codeError('CODE_INPUT_INVALID', 'severity must be one of: error, warning, information, hint.');
    }
    const previews = createPreviewReader();

    // Pull model (LSP 3.17) when the server advertises it: a direct request has
    // an unambiguous answer, including an unambiguous empty one.
    if (serverSupports(session, 'diagnosticProvider')) {
      syncDocument(session, { uri, languageId: context.languageId, text: context.text });
      const report = await session.request('textDocument/diagnostic', { textDocument: { uri } }, { timeoutMs: waitMs });
      const items = report && Array.isArray(report.items) ? report.items : [];
      return finishDiagnostics({ context, items, previews, maxResults, severity: args.severity, mode: 'pull' });
    }

    // Push model: register the waiter *before* the sync so a fast server
    // cannot publish between the two and leave us waiting for a notification
    // that already happened.
    const key = uriKey(uri);
    let resolveWaiter;
    const waiter = new Promise(resolve => {
      resolveWaiter = resolve;
      const waiters = session.diagnosticsWaiters.get(key) || [];
      waiters.push(resolve);
      session.diagnosticsWaiters.set(key, waiters);
    });
    syncDocument(session, { uri, languageId: context.languageId, text: context.text }, { forceChange: true });
    const timeoutMarker = Symbol('diagnostics-timeout');
    // This wait is on a notification, not a request, so it holds its own
    // retain on the session's handles and uses a referenced timer. Without
    // both, the event loop can empty here and the process exits silently
    // mid-await -- observed during development, and it is invisible when it
    // happens. The timer is referenced only while the race is pending: once
    // settled it is cleared, so a fast publish does not leave the process
    // pinned for the rest of waitMs.
    const releaseHandles = session.retain();
    let timer = null;
    let settled;
    try {
      settled = await Promise.race([
        waiter,
        new Promise(resolve => { timer = setTimeout(() => resolve(timeoutMarker), waitMs); })
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      releaseHandles();
    }
    if (settled === timeoutMarker) {
      // Withdraw this call's waiter: publishDiagnostics is the only other
      // drain, so a server that never publishes for this uri would otherwise
      // accumulate one dead closure per timed-out call for the session's
      // lifetime.
      const waiters = session.diagnosticsWaiters.get(key);
      if (waiters) {
        const index = waiters.indexOf(resolveWaiter);
        if (index >= 0) waiters.splice(index, 1);
        if (waiters.length === 0) session.diagnosticsWaiters.delete(key);
      }
      // The critical honesty case. Returning `[]` here would be indistinguishable
      // from a clean file, and that exact shape of lie is what this layer must
      // never produce.
      throw codeError('CODE_DIAGNOSTICS_NOT_REPORTED',
        `Language server '${session.id}' published no diagnostics for ${path.basename(file)} within ${waitMs} ms. This is not the same as a clean file.`,
        { serverId: session.id, file, waitMs });
    }
    return finishDiagnostics({ context, items: settled.diagnostics, previews, maxResults, severity: args.severity, mode: 'push' });
  });
}

function finishDiagnostics({ context, items, previews, maxResults, severity, mode }) {
  const { session, file } = context;
  let normalized = normalizeDiagnostics(items, previews, file);
  if (severity) normalized = normalized.filter(item => item.severity === severity);
  const counts = { error: 0, warning: 0, information: 0, hint: 0, unknown: 0 };
  for (const item of normalized) counts[item.severity] = (counts[item.severity] || 0) + 1;
  const payload = boundItems(normalized, 'diagnostics', baseEnvelope({
    tool: 'code.diagnostics',
    server: serverDescriptor(session),
    workspace: context.workspace,
    file,
    mode,
    counts,
    totalReported: normalized.length,
    // Reported-empty is a real, server-attested clean file. A timeout threw
    // long before this point.
    state: normalized.length ? 'reported' : 'reported-empty',
    filesReadForPreview: previews.filesRead,
    measurement: {
      unit: 'bytes',
      fileBytes: Buffer.byteLength(context.text, 'utf8'),
      responseBytes: null,
      note: 'Bytes only. fileBytes is what reading this file in full would cost; it is not a token or cost saving.'
    }
  }), { maxItems: maxResults });
  return payload;
}

async function hover(args = {}) {
  return withDocument(args, new Set(['file', 'root', 'line', 'column', 'symbol', 'occurrence', 'timeoutMs']), 'code.hover', async context => {
    const { session, file, lines, uri, timeoutMs } = context;
    const position = resolvePosition({ lines, line: args.line, column: args.column, symbol: args.symbol, occurrence: args.occurrence });
    if (!serverSupports(session, 'hoverProvider')) {
      throw codeError('CODE_METHOD_UNSUPPORTED', `Language server '${session.id}' does not provide hover.`,
        { serverId: session.id, method: 'textDocument/hover' });
    }
    syncDocument(session, { uri, languageId: context.languageId, text: context.text });
    const result = await session.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: position.zeroLine, character: position.zeroCharacter }
    }, { timeoutMs });
    const identifier = identifierAt(lines, position.zeroLine, position.zeroCharacter);
    const text = result ? hoverText(result.contents) : '';
    const payload = baseEnvelope({
      tool: 'code.hover',
      server: serverDescriptor(session),
      workspace: context.workspace,
      file,
      queriedAt: { line: position.zeroLine + 1, column: position.zeroCharacter + 1, resolvedFrom: position.resolvedFrom, occurrence: position.occurrence },
      symbolAtPosition: identifier ? identifier.text : null,
      hover: text ? text : null,
      range: result && result.range ? normalizeRange(result.range) : null,
      // Explicit, so "the server has nothing to say here" never reads as a
      // failed call.
      state: text ? 'found' : 'no-hover-at-position'
    });
    return finalizeBoundedResponse(payload);
  });
}

/**
 * Availability report. Never spawns a language server: this is the call an
 * agent makes to find out whether a semantic answer is even possible before it
 * decides between LSP and the next option down the priority list.
 */
function status(args = {}) {
  if (!plainObject(args)) throw codeError('CODE_INPUT_INVALID', 'code.status input must be an object.');
  assertNoUnknownFields(args, new Set(['root']), 'code.status');
  let root = null;
  let rootError = null;
  if (args.root !== undefined) {
    try { root = resolveWorkspaceRoot(args.root, null).root; }
    catch (error) { rootError = error.message; }
  }
  const families = [...new Set(Object.values(LANGUAGE_FAMILY))];
  const languages = families.map(family => {
    const resolution = serverResolver(family, root);
    if (resolution && resolution.resolved) {
      return {
        language: family,
        available: true,
        serverId: resolution.serverId,
        launcher: resolution.launcher,
        packageVersion: resolution.packageVersion === undefined ? null : resolution.packageVersion,
        companionVersion: resolution.companionVersion === undefined ? null : resolution.companionVersion,
        source: resolution.source || null
      };
    }
    return {
      language: family,
      available: false,
      reason: 'NO_LANGUAGE_SERVER_FOUND',
      attempts: (resolution && resolution.attempts) || [],
      advice: 'Install one of the servers listed in attempts[].install. Until then this layer returns a typed CODE_SERVER_UNAVAILABLE rather than a text search presented as semantic.'
    };
  });
  return finalizeBoundedResponse({
    ...UNTRUSTED_CONTENT,
    tool: 'code.status',
    workspaceRoot: root,
    rootError,
    languages,
    extensions: Object.keys(LANGUAGE_BY_EXTENSION),
    implementedMethods: ['goto_definition', 'find_references', 'document_symbols', 'workspace_symbols', 'diagnostics', 'hover'],
    unimplementedMethods: UNIMPLEMENTED_METHODS,
    sessions: pool.list(),
    limits: {
      maxResults: MAX_RESULTS_CAP,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxFileBytes: MAX_FILE_BYTES,
      defaultRequestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      maxRequestTimeoutMs: MAX_REQUEST_TIMEOUT_MS,
      maxConcurrentSessions: pool.maxSessions,
      sessionIdleTimeoutMs: pool.idleTimeoutMs
    },
    lookupPriority: ['lsp', 'ast', 'git-history', 'ripgrep', 'full-file-read']
  });
}

module.exports = {
  CodeIntelError,
  LANGUAGE_BY_EXTENSION,
  SERVER_CATALOG,
  UNIMPLEMENTED_METHODS,
  diagnostics,
  documentSymbols,
  findReferences,
  gotoDefinition,
  hover,
  status,
  workspaceSymbols,
  // Test-only seams; see setServerResolverForTests above.
  setServerResolverForTests,
  stopAllSessionsForTests: () => pool.stopAll(),
  sessionPoolForTests: () => pool,
  // Exposes resolveFilePath alone (no resolveWorkspaceRoot, languageOf, or
  // session acquisition) so its own cost -- specifically
  // auditSuccessfulRead's read-audit call on a successful resolution -- can
  // be measured in isolation rather than folded into a full withDocument
  // call's LSP-session overhead.
  resolveFilePathForTests: resolveFilePath
};
