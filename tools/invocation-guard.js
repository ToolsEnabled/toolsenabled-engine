#!/usr/bin/env node
'use strict';

// THE INVOCATION GUARD.
//
// It answers one question, mechanically: does every executable mechanism in
// this repository have a path by which it actually RUNS?
//
// WHY IT EXISTS. On 2026-08-08/09 this repository's dominant defect was
// measured, and it was not missing mechanisms and not carelessness. It was
// mechanisms that EXIST, WORK CORRECTLY, AND THAT NOTHING EVER RUNS:
//
//   tools/check-single-copy-work.js   40,707 bytes, correct, cited in CLAUDE.md,
//                                     AGENTS.md, config/standing-orders.json and
//                                     seven other documents. Zero automated
//                                     invocations. Nine near-losses of real work
//                                     happened next to this working detector.
//   providerEnvironment()             exported and correct in
//                                     src/lib/providers/cli-provider-gateway.js;
//                                     the retired legacy role-sweep launcher
//                                     imported the
//                                     OTHER half of that same module and
//                                     hand-rolled around it. Scheduled sweeps
//                                     then billed a drained account for hours.
//   bridge-session-supervisor.ps1     computed a correct verdict, wrote it to
//                                     JSON, and exited 0 unconditionally.
//   mission-control "npm run test:data"  a glob discovering all 26 suites,
//                                     invoked by nothing. A manager hand-listed
//                                     11 files and reported "all green" for a
//                                     whole session while tests were failing.
//   tools/package-check.js            reports 206 unmapped files and 329
//                                     layering violations, then exits 0.
//   tools/lane-territory-check.js     exits 1 correctly. Zero automated invokers.
//   classifyAction()                  zero references anywhere.
//   mayClaim()                        no production caller, while
//                                     config/standing-orders.json records it
//                                     wired:true, enforcement "mechanical".
//
// THE DEEPEST VERSION, and the reason this guard is shaped the way it is: each
// unrun mechanism had a HUMAN-SHAPED SUBSTITUTE DOING THE JOB WORSE. A
// hand-written list of 11 test files substituted for the glob. Nobody omits a
// check deliberately -- they replace it with something they can SEE, and the
// replacement silently degrades. So this guard is not another checker to
// remember. It fails a run, loudly, with a nonzero exit code, from inside a
// chain that already executes.
//
// WHAT COUNTS AS AN INVOCATION PATH, and why the definition is strict.
//
// The single most important rule here: AN NPM SCRIPT THAT NOTHING INVOKES IS
// NOT WIRING. mission-control's "test:data" was a perfectly good script that
// discovered every suite, and it meant nothing, because no target called it and
// that repo had no "test" script at all. If this guard treated "some npm script
// mentions the file" as proof of invocation, it would certify that exact
// non-wiring as wired -- it would be the seventh unrun instrument rather than
// the fix for the first six.
//
// So reachability is computed from declared ROOTS ONLY, and a root must be a
// surface that EXECUTES BY ITSELF -- npm lifecycle hooks that npm runs for you,
// git hooks, the MCP server process, bin entries, and the registrars/entry
// points of processes the scheduler actually starts. Everything else has to be
// reachable FROM one of those, transitively, or be registered.
//
// BOTH SPELLINGS ARE CHECKED. A script can be wired by script NAME
// ("npm run foo") or by file PATH ("node tools/foo.js"). Checking one spelling
// produced a confidently wrong answer on 2026-08-08. Both are resolved here,
// and `npm run` names are followed into the script body they name.

const fs = require('node:fs');
const path = require('node:path');
const { buildCensus } = require('./test-census');
const { executionSpans, findShadowedTests } = require('./invocation-graph');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'config', 'invocation-registry.json');
const PRODUCTION_CLASSIFICATION_PATH = path.join(ROOT, 'config', 'invocation-production-classification.json');

// THIS IS A RELEASE-SCOPE EXCLUSION, NOT AN ORPHAN BASELINE.
//
// These three modules are the paid licence resolver, signing/verification
// provider and revocation store.  They intentionally remain in the private
// engine source (and in its separately governed open-licensed,
// customer-distributable set; that classification grants no public-repository
// authority),
// but the desktop payload classifies the exact three paths `paid` and its
// require-closure does not stage them.  Payments are outside this release's
// customer-runtime scope.  Calling them `manual` would be false -- libraries
// are not hand-run entrypoints -- and baselining them would hide the reason.
//
// Keep this list exact.  A directory prefix or a manifest-derived blanket skip
// would let an unrelated dead customer mechanism disappear merely by being
// labelled "paid".  validateReleaseExcludedLibraries() also turns the release
// red if one of these paths becomes production-reachable, so adding a runtime
// edge cannot silently inherit the exclusion.
const RELEASE_EXCLUDED_PAYMENT_LIBRARIES = Object.freeze([
  'src/lib/entitlement.js',
  'src/lib/license-store.js',
  'src/lib/providers/license.js'
]);

// Owner scope, 2026-09-05: work is desktop LIVE; leave the mobile/iPhone
// prototype alone. Four exact test-only iPhone prototype libraries were excluded
// here on that reasoning.
//
// Emptied 2026-09-06.  Those four paths no longer exist on this line: ebd6447
// "Retire inactive iPhone controller remnants after extraction" deleted them,
// and this constant is the mechanism that then failed -- exactly as designed.
// The comment above promised to "fail if any exact exclusion becomes stale",
// and it did: the guard exited 1 with "release-excluded library no longer
// exists; remove or update the exact exclusion" for all four, which is the same
// blocker W\LIVE-AUTO-SYNC-20260905.md records against the automatic LIVE
// preflight.  Removing a retired library's exclusion is the "update" that
// message asks for; it is not a relaxation, and nothing was added to the list.
//
// The constant stays, empty, rather than being deleted with its entries.  It is
// exported, it feeds RELEASE_EXCLUDED_LIBRARIES, and its test pins it as an
// exact set so that owner-deferred scope can never become a mobile-prefix
// blanket exclusion.  A future owner-deferred exclusion belongs here, one exact
// path at a time.  New mobile-looking paths are still NOT automatically
// excluded: a test-only library that is not listed here stays gated and visible.
const RELEASE_EXCLUDED_OWNER_DEFERRED_LIBRARIES = Object.freeze([]);
const RELEASE_EXCLUDED_LIBRARIES = Object.freeze([
  ...RELEASE_EXCLUDED_PAYMENT_LIBRARIES,
  ...RELEASE_EXCLUDED_OWNER_DEFERRED_LIBRARIES
]);

// File kinds whose contents are read when following the graph. A guard that
// walked everything would be slow, and a guard slow enough to be annoying is a
// guard somebody deletes (see the threshold reasoning in .githooks/post-commit).
// `.yml`/`.yaml` are here for CI workflow definitions. A GitHub Actions workflow
// is a self-executing surface in exactly the sense this file means: something
// OUTSIDE the repository (GitHub) starts it, on its own schedule, with nobody
// remembering to. Measured 2026-08-13: .github/workflows/dco.yml:45 runs
// `node tools/check-dco.js` on every pull request, and the guard -- which could
// not read a .yml at all -- reported that gate as a mechanism with no invocation
// path. A guard that cannot see CI is blind to the one execution surface a
// published repository is most likely to acquire next.
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ps1', '.sh', '.cmd', '.bat', '.vbs', '.json', '.yml', '.yaml']);

// Files under tools/ that must be reachable. Extensions only -- data files
// (.json, .md) are not executable mechanisms and are out of scope.
const EXECUTABLE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ps1', '.cmd', '.bat', '.vbs']);

// A reason has to actually say something. "manual", "n/a", "later" are the
// shapes a registry degrades into once registering feels like paperwork.
const MINIMUM_REASON_LENGTH = 25;

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function relativeToRoot(absolute) {
  const relative = path.relative(ROOT, absolute);
  if (!relative || relative.startsWith('..')) return null;
  return toPosix(relative);
}

function readFileOrEmpty(absolute) {
  try {
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return '';
  }
}

function walkFiles(directory, predicate) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      found.push(...walkFiles(candidate, predicate));
    } else if (entry.isFile() && predicate(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

// Resolve a require-style specifier the way node would, so that reachability
// follows the real module graph rather than a guess about file names.
function resolveRelativeRequire(specifier, fromDirectory) {
  const base = path.resolve(fromDirectory, specifier);
  const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this candidate; try the next spelling.
    }
  }
  return null;
}

// PROSE IS NOT INVOCATION, and getting this wrong makes the guard lie in the
// same direction as the defect it hunts.
//
// Caught by testing this guard against the canonical case rather than reasoning
// about it: the first version reported tools/check-single-copy-work.js as
// REACHABLE. Every one of the four references in .githooks/post-commit is a
// shell comment or a printf that prints the command as advice --
//
//     # WHY THIS HOOK IS NOT JUST `node tools/check-single-copy-work.js`.
//     printf '    node tools/check-single-copy-work.js\n'
//
// -- and that file is the single most documented unrun mechanism in the repo,
// the 40KB detector cited in ten places and invoked by none. A guard that
// counts a printf as wiring would have certified the original defect as fixed.
// Mentioning a command is precisely what everybody already did.
function stripNonExecutableText(source, kind) {
  let text = source;
  if (kind === 'js') {
    text = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  } else if (kind === 'ps1') {
    text = text.replace(/<#[\s\S]*?#>/g, ' ').replace(/^\s*#[^\n]*/gm, '');
  } else if (kind === 'sh') {
    text = text.replace(/^\s*#[^\n]*/gm, '');
  } else if (kind === 'vbs') {
    text = text.replace(/^\s*'[^\n]*/gm, '');
  } else if (kind === 'cmd' || kind === 'bat') {
    text = text.replace(/^\s*(?:rem\b|::)[^\n]*/gim, '');
  }
  // Lines whose job is to EMIT text rather than run something. Dropping the
  // whole line is deliberate: a usage banner that names a command is the most
  // common way an unrun tool looks wired.
  const emitters = /(?:printf|\becho\b|console\.(?:log|error|warn|info)|process\.std(?:out|err)\.write|Write-(?:Host|Output|Verbose|Warning|Information))/;
  return text
    .split('\n')
    .filter((line) => !emitters.test(line))
    .join('\n');
}

// Extensionless hook scripts (.githooks/post-commit) are real execution
// surfaces with no file extension. Classify by shebang so their contents are
// actually read -- the first version silently skipped them, which meant the one
// git hook in the repository contributed nothing to the graph.
function classifyFile(absolutePath, source) {
  const extension = path.extname(absolutePath).toLowerCase();
  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') return 'js';
  if (extension === '.ps1') return 'ps1';
  if (extension === '.sh') return 'sh';
  if (extension === '.vbs') return 'vbs';
  if (extension === '.cmd') return 'cmd';
  if (extension === '.bat') return 'bat';
  // YAML shares the shell comment character, and a workflow's `run:` blocks ARE
  // shell. Treating it as 'sh' strips `# node tools/x.js` advice in comments
  // while keeping the command the runner actually executes.
  if (extension === '.yml' || extension === '.yaml') return 'sh';
  if (extension === '.json') return 'json';
  if (!extension && /^#!.*\b(?:sh|bash|zsh)\b/.test(source)) return 'sh';
  if (!extension && /^#!.*\bnode\b/.test(source)) return 'js';
  return null;
}

// Every reference we can extract from one file, as repository-relative posix
// paths plus npm script names. Deliberately literal: this reads source as text
// and never executes it. Executing a runner to discover what it runs would run
// the tests against production state, which is the same reasoning that keeps
// tools/test-census.js static.
function extractReferences(absolutePath, rawSource, kindOverride) {
  const files = new Set();
  const npmScripts = new Set();
  const directory = path.dirname(absolutePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const kind = kindOverride || classifyFile(absolutePath, rawSource);

  let source;
  if (kind === 'command') {
    // An npm script body is all executable; nothing to strip.
    source = rawSource;
  } else if (kind === 'json') {
    // Config prose lives in "$comment" keys here by convention, and those
    // comments cite tool paths heavily (config/managed-processes.json explains
    // a registrar bug by naming the registrar). Drop them; keep real fields.
    try {
      const stripComments = (value) => {
        if (Array.isArray(value)) return value.map(stripComments);
        if (value && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value)
            .filter(([key]) => !key.startsWith('$comment'))
            .map(([key, nested]) => [key, stripComments(nested)]));
        }
        return value;
      };
      source = JSON.stringify(stripComments(JSON.parse(rawSource)));
    } catch {
      source = rawSource;
    }
  } else {
    source = stripNonExecutableText(rawSource, kind);
  }

  // 1. Explicit repository-relative paths, in either slash spelling. This is
  //    the "wired by file PATH" half of the both-spellings rule.
  //
  //    IN JAVASCRIPT THIS IS NOT ENOUGH, and the third false green measured in
  //    this guard proved it. src/lib/providers/repo-files.js:151 contains
  //    'tools/register-managed-tasks.js' inside WRITE_PROTECTED_FILES -- a Set
  //    of paths the write-protection layer refuses to modify. It is a data
  //    list, the exact opposite of a call: the file is named there because
  //    nothing may touch it. Counting it as invocation made an elevated
  //    registrar that nothing runs look wired.
  //
  //    Verified semantically rather than by eye: code.find_references on the
  //    only other candidate, checkSingleCopyWork, returns a real call at
  //    tools/repo-sync.js:181, so that tool's REACHABLE verdict is a true
  //    positive and this narrowing does not lose it.
  //
  //    So in JS a bare path string proves nothing. It counts only inside the
  //    argument span of a process-starting call. Everywhere else -- shell,
  //    PowerShell, npm command lines, JSON config fields -- a path IS the
  //    instruction, and rule 1 stands.
  //    The optional $VAR/ prefix is not decoration. .githooks/pre-push:132 runs
  //      node "$repo_root/tools/lane-territory-gate.js" --base "$base"
  //    and without it the boundary class rejects the match, because the
  //    character immediately before "tools/" is a slash. The guard then reported
  //    a tool that a git hook demonstrably executes as having NO INVOCATION
  //    PATH. That is a false RED, and a false red costs more than a false green
  //    here: it teaches people the guard is wrong, and a guard people believe is
  //    wrong is one they switch off.
  // Shipped JSON configuration can itself be an executed program's next
  // input. install.ps1 -> config/client-hooks/*.json -> tools/*.js is the
  // concrete example: the installer loads each template and installs its
  // command handlers. Keep JSON limited to the config/ namespace so a random
  // fixture or package-data mention cannot manufacture a production edge.
  const pathPattern = /(?:^|[^\w./\\-])(?:\$\{?\w+\}?[\\/])?((?:(?:tools|tests|src|bin|scripts|sidecars|adapters)[\\/][\w./\\-]+?\.(?:js|cjs|mjs|ps1|sh|cmd|bat|vbs)|config[\\/][\w./\\-]+?\.json))/g;
  if (kind === 'js') {
    const spans = executionSpans(source);
    for (const match of source.matchAll(pathPattern)) {
      if (spans.some(([start, end]) => match.index >= start && match.index <= end)) {
        files.add(toPosix(match[1].replace(/\\/g, '/')));
      }
    }
  } else {
    for (const match of source.matchAll(pathPattern)) {
      files.add(toPosix(match[1].replace(/\\/g, '/')));
    }
  }

  // 2. `npm run <name>` / `npm run-script <name>` -- the "wired by script NAME"
  //    half. Resolved against package.json scripts later, so a name that no
  //    script defines resolves to nothing rather than to a false positive.
  //
  //    THE SAME EXECUTION-CONTEXT RULE APPLIES IN JAVASCRIPT, and this guard
  //    proved why by breaking itself. formatReport() below advises the reader:
  //      lines.push('  unreached cannot be stated here. Produce it with `npm run test:all` ...')
  //    That is help text. This rule read it as an invocation, so "test:all"
  //    became a reachable script, which made tools/test-run.js reachable, which
  //    invalidated a hand-written manual entry declaring that NOTHING invokes
  //    tools/test-run.js -- which was true.
  //
  //    A sentence telling a human to run a command is the single most common
  //    way an unrun mechanism looks wired. That is the defect this guard hunts,
  //    and it produced it, about itself, in its own error message.
  const scriptPattern = /npm\s+(?:run|run-script)\s+(?:--silent\s+|-s\s+)?([\w:.-]+)/g;
  for (const match of source.matchAll(scriptPattern)) {
    if (kind === 'js') {
      const spans = executionSpans(source);
      if (!spans.some(([start, end]) => match.index >= start && match.index <= end)) continue;
    }
    npmScripts.add(match[1]);
  }

  // 3. Relative requires, resolved properly. This is what carries reachability
  //    through src/ -- a tool required by a reachable library is reachable.
  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
    const specifiers = [
      ...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g),
      ...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g),
      ...source.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)
    ];
    for (const match of specifiers) {
      const resolved = resolveRelativeRequire(match[1], directory);
      const relative = resolved && relativeToRoot(resolved);
      if (relative) files.add(relative);
    }
    // path.join(__dirname, 'sibling.js') -- a spawn spelling used by several
    // runners here (tools/test-run.js reaches tests/run-isolated.js this way).
    for (const match of source.matchAll(/__dirname\s*,\s*['"]([\w./-]+\.(?:js|cjs|mjs|ps1))['"]/g)) {
      const relative = relativeToRoot(path.resolve(directory, match[1]));
      if (relative) files.add(relative);
    }
    // MULTI-SEGMENT sibling resolution, CJS and ESM. The single-segment
    // spelling above only matches `join(__dirname, 'x.js')`. Measured
    // 2026-08-09: three tools were spawned by tests that DO run, through
    // longer spellings, and the guard reported all three as having no
    // invocation path --
    //
    //   path.resolve(__dirname, '..', 'tools', 'fork-ledger.js')
    //   join(dirname(fileURLToPath(import.meta.url)), 'branch-disposal-audit.mjs')
    //
    // -- so the guard's own blind spot was reporting live code as dead. That
    // is the same class of error in the opposite direction: a guard that
    // miscounts either way stops being believed.
    //
    // Kept tight deliberately. The base must be __dirname or its exact ESM
    // equivalent, and the FINAL segment must be a real script filename, so a
    // path built to a data file or a directory does not become "invocation".
    const siblingBase = String.raw`(?:__dirname|dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\))`;
    const siblingCall = new RegExp(
      String.raw`(?:path\s*\.\s*)?(?:join|resolve)\(\s*${siblingBase}\s*,\s*((?:['"][^'"\r\n]+['"]\s*,\s*)*['"][\w.-]+\.(?:js|cjs|mjs|ps1)['"])\s*\)`,
      'g'
    );
    for (const match of source.matchAll(siblingCall)) {
      const segments = [...match[1].matchAll(/['"]([^'"\r\n]+)['"]/g)].map((entry) => entry[1]);
      const relative = relativeToRoot(path.resolve(directory, ...segments));
      if (relative) files.add(relative);
    }
    // new URL('./sibling.mjs', import.meta.url) -- the ESM spelling used where
    // a sibling is SPAWNED rather than imported, so no static import names it.
    for (const match of source.matchAll(/new\s+URL\(\s*['"](\.[\w./-]+\.(?:js|cjs|mjs|ps1))['"]\s*,\s*import\.meta\.url\s*\)/g)) {
      const relative = relativeToRoot(path.resolve(directory, match[1]));
      if (relative) files.add(relative);
    }
  }

  // 4. PowerShell sibling invocation. `& "$PSScriptRoot\foo.ps1"` and
  //    `Join-Path $PSScriptRoot 'foo.ps1'` are how the .ps1 tools call each
  //    other; neither spelling contains the string "tools/".
  //
  //    THE SEGMENT MUST BE ALLOWED TO CONTAIN A SEPARATOR, and the first version
  //    of this rule forbade it. Measured 2026-08-13: tools/secrets.ps1:30 and
  //    tools/secrets-manager.ps1:36 both DOT-SOURCE a shared library --
  //
  //        . (Join-Path $PSScriptRoot 'lib/vault-acl.ps1')
  //
  //    -- which is the strongest form of invocation PowerShell has: the file is
  //    executed in the caller's own scope. `[\w.-]+` cannot cross the slash, so
  //    neither spelling matched, and the guard reported tools/lib/vault-acl.ps1
  //    -- the ACL the product puts on a paying customer's credential store, run
  //    by every credential-store creation on this machine -- as a mechanism with
  //    NO INVOCATION PATH. That is a false RED on live code, and this file
  //    already records at the $VAR/ rule why a false red costs more than a false
  //    green: it teaches people the guard is wrong, and a guard people believe
  //    is wrong is one they switch off.
  if (extension === '.ps1') {
    for (const match of source.matchAll(/\$PSScriptRoot[\\/]+['"]?([\w.-]+(?:[\\/][\w.-]+)*\.ps1)/gi)) {
      const relative = relativeToRoot(path.resolve(directory, match[1].replace(/\\/g, '/')));
      if (relative) files.add(relative);
    }
    for (const match of source.matchAll(/Join-Path\s+[^\n]*?\$PSScriptRoot[^\n]*?['"]([\w.-]+(?:[\\/][\w.-]+)*\.ps1)['"]/gi)) {
      const relative = relativeToRoot(path.resolve(directory, match[1].replace(/\\/g, '/')));
      if (relative) files.add(relative);
    }
  }

  // 5. Explorer launchers. VBScript BuildPath and batch %~dp0 are the two
  // shipped, no-console ways a customer starts a sibling entry point. They are
  // executable edges, not prose, and must carry reachability into that target.
  if (extension === '.vbs') {
    for (const match of source.matchAll(/BuildPath\([^\n]*?,\s*"([\w .-]+\.(?:js|ps1|cmd|bat|vbs))"\s*\)/gi)) {
      const relative = relativeToRoot(path.resolve(directory, match[1]));
      if (relative) files.add(relative);
    }
  }
  if (extension === '.cmd' || extension === '.bat') {
    for (const match of source.matchAll(/%~dp0([\w .-]+\.(?:js|ps1|cmd|bat|vbs))/gi)) {
      const relative = relativeToRoot(path.resolve(directory, match[1]));
      if (relative) files.add(relative);
    }
  }

  return { files: [...files], npmScripts: [...npmScripts] };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { missing: true, roots: [], entries: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  return {
    missing: false,
    roots: Array.isArray(parsed.roots) ? parsed.roots : [],
    entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
    productionEdges: Array.isArray(parsed.productionEdges) ? parsed.productionEdges : []
  };
}

function validateDeclaredRoots(registry, packageScripts, rootDirectory = ROOT) {
  const invalidRoots = [];
  for (const root of registry.roots || []) {
    if (typeof root !== 'string' || root.trim() === '') {
      invalidRoots.push({ root, why: 'root must be a non-empty string' });
      continue;
    }
    if (root.startsWith('npm:')) {
      const script = root.slice(4);
      if (!script || !Object.hasOwn(packageScripts, script) || typeof packageScripts[script] !== 'string' || packageScripts[script].trim() === '') {
        invalidRoots.push({ root, why: `package.json script ${JSON.stringify(script)} does not exist or is empty` });
      }
      continue;
    }
    const absolute = path.resolve(rootDirectory, root);
    const relative = path.relative(rootDirectory, absolute);
    if (path.isAbsolute(root) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      invalidRoots.push({ root, why: 'file root must stay inside the repository' });
      continue;
    }
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() && !stat.isDirectory()) {
        invalidRoots.push({ root, why: 'declared path is neither a file nor a directory' });
      }
    } catch {
      invalidRoots.push({ root, why: 'declared path does not exist' });
    }
  }
  return invalidRoots;
}

function validateDeclaredProductionEdges(registry, rootDirectory = ROOT) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const edge of registry.productionEdges || []) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)
        || typeof edge.from !== 'string' || typeof edge.to !== 'string'
        || typeof edge.reason !== 'string' || edge.reason.trim().length < MINIMUM_REASON_LENGTH) {
      invalid.push({ edge, why: 'edge must declare from, to, and a specific reason' });
      continue;
    }
    const paths = [edge.from, edge.to];
    const unsafe = paths.find(value => path.isAbsolute(value) || value.includes('..') || !value.includes('/'));
    if (unsafe) {
      invalid.push({ edge, why: `edge path must be repository-relative: ${JSON.stringify(unsafe)}` });
      continue;
    }
    const from = path.resolve(rootDirectory, edge.from);
    const to = path.resolve(rootDirectory, edge.to);
    const edgeKey = `${edge.from}\0${edge.to}`;
    if (edge.from === edge.to || seen.has(edgeKey)) {
      invalid.push({ edge, why: edge.from === edge.to ? 'edge cannot invoke itself' : 'edge is duplicated' });
      continue;
    }
    seen.add(edgeKey);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile() || !fs.existsSync(to) || !fs.statSync(to).isFile()) {
      invalid.push({ edge, why: 'edge source and target must both exist as files' });
      continue;
    }
    // The manual edge exists only for a dynamic path construction that the
    // static parser cannot follow. Requiring the target basename in executable
    // source prevents an explanation-only declaration from manufacturing an
    // otherwise absent relationship.
    const rawSource = readFileOrEmpty(from);
    const executableSource = stripNonExecutableText(rawSource, classifyFile(from, rawSource));
    if (!executableSource.includes(path.basename(edge.to))) {
      invalid.push({ edge, why: 'edge source does not contain the target program basename' });
      continue;
    }
    valid.push({ from: toPosix(edge.from), to: toPosix(edge.to), reason: edge.reason });
  }
  return { valid, invalid };
}

function loadProductionClassification() {
  if (!fs.existsSync(PRODUCTION_CLASSIFICATION_PATH)) {
    return { missing: true, record: null, byFile: new Map(), issues: [{ file: null, why: 'production classification file is missing' }] };
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(PRODUCTION_CLASSIFICATION_PATH, 'utf8')); }
  catch { return { missing: false, record: null, byFile: new Map(), issues: [{ file: null, why: 'production classification file is invalid JSON' }] }; }
  const allowed = new Set(['customer-runtime-intended', 'build-release', 'developer-only', 'retired-stale']);
  const byFile = new Map();
  const issues = [];
  if (!parsed || parsed.schemaVersion !== 1 || !parsed.categories || typeof parsed.categories !== 'object') {
    return { missing: false, record: parsed, byFile, issues: [{ file: null, why: 'production classification has an unrecognized shape' }] };
  }
  for (const [classification, section] of Object.entries(parsed.categories)) {
    if (!allowed.has(classification)) {
      issues.push({ file: null, why: `unknown production class ${JSON.stringify(classification)}` });
      continue;
    }
    if (!section || !Array.isArray(section.files) || section.count !== section.files.length) {
      issues.push({ file: null, why: `${classification} count does not match its file list` });
      continue;
    }
    for (const file of section.files) {
      if (typeof file !== 'string' || !file.startsWith('tools/')) {
        issues.push({ file, why: `${classification} contains an invalid tool path` });
      } else if (byFile.has(file)) {
        issues.push({ file, why: `tool appears in both ${byFile.get(file)} and ${classification}` });
      } else {
        byFile.set(file, classification);
      }
    }
  }
  return { missing: false, record: parsed, byFile, issues };
}

function exactSortedStringList(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => typeof entry === 'string' && entry === expected[index]);
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

// `expandTests:false` computes PRODUCTION reachability: tests/ files are still
// reached (npm:test names them) but their own requires are not followed, so a
// library whose only caller is its own test does not get laundered into
// "reachable". That distinction is the entire src/lib population below.
function computeReachable(registry, packageScripts, { expandTests = true } = {}) {
  const edgesBySource = new Map();
  for (const edge of validateDeclaredProductionEdges(registry).valid) {
    const targets = edgesBySource.get(edge.from) || [];
    targets.push(edge.to);
    edgesBySource.set(edge.from, targets);
  }
  const reachableFiles = new Set();
  const reachableScripts = new Set();
  const fileQueue = [];
  const scriptQueue = [];
  // How each node was first reached, so the chain can be PRINTED rather than
  // asserted. A commit tonight claimed "registered in a runner" when the script
  // existed and nothing called it; `--why` makes that claim checkable.
  const cameFrom = new Map();

  const pushFile = (relative, via) => {
    if (!relative || reachableFiles.has(relative)) return;
    reachableFiles.add(relative);
    cameFrom.set(relative, via);
    fileQueue.push(relative);
  };
  const pushScript = (name, via) => {
    if (!name || reachableScripts.has(name) || !(name in packageScripts)) return;
    reachableScripts.add(name);
    cameFrom.set(`npm:${name}`, via);
    scriptQueue.push(name);
  };

  // A ROOT MAY BE A DIRECTORY, and .githooks is why.
  //
  // The first version of this registry listed ".githooks/post-commit" -- the one
  // hook that existed when it was written. A peer then added .githooks/pre-push,
  // which really does run `node tools/lane-territory-gate.js` at line 132, and
  // this guard reported that genuinely-wired tool as having NO INVOCATION PATH
  // and offered to freeze it into the baseline as debt.
  //
  // That is the same brittleness the guard exists to attack, pointed inward: git
  // executes EVERY hook in core.hooksPath, so the execution surface is the
  // directory, not a filename somebody remembered to add. Naming files one at a
  // time means the roots list silently goes stale the moment anyone adds a hook,
  // and a stale roots list makes wired work look like debt -- which is worse
  // than useless, because it teaches people the guard is wrong.
  const expandRoot = (root) => {
    const absolute = path.join(ROOT, root);
    try {
      if (fs.statSync(absolute).isDirectory()) {
        return walkFiles(absolute, () => true).map((file) => relativeToRoot(file)).filter(Boolean);
      }
    } catch {
      // Missing root: fall through and let it be pushed as a plain file, where
      // it simply contributes nothing rather than throwing.
    }
    return [toPosix(root)];
  };

  const fileRoots = registry.roots
    .filter((root) => typeof root === 'string' && !root.startsWith('npm:'))
    .flatMap(expandRoot);
  const rootSet = new Set(fileRoots);

  for (const root of registry.roots) {
    if (typeof root === 'string' && root.startsWith('npm:')) pushScript(root.slice(4), null);
  }
  for (const root of fileRoots) pushFile(root, null);

  // npm runs pre<name> and post<name> around <name> automatically. Missing this
  // would report the entire pretest chain as unreachable while npm executes it
  // on every single `npm test`.
  const expandLifecycle = (name) => {
    pushScript(`pre${name}`, `npm:${name}`);
    pushScript(`post${name}`, `npm:${name}`);
  };

  // WHAT A HUMAN RUNS, RUNS -- INCLUDING EVERYTHING IT REQUIRES.
  //
  // A `manual` entry is a typed, reasoned statement that a person genuinely
  // invokes this mechanism by hand. That is an invocation path; it is simply one
  // no static reader can find, which is the entire reason the status exists. So
  // whatever the mechanism requires or spawns REALLY EXECUTES whenever it does.
  //
  // Without this the guard painted a corner with no honest way out. Measured
  // 2026-08-13: tools/purchase-cart.js is a hand-run CLI that exists precisely
  // to answer "what is in my cart" with no app build, no bridge port and no
  // browser; it projects state through src/lib/purchase-cart-view.js, whose
  // header records that it "itself requires nothing". Register the CLI honestly
  // and the library was STILL reported as debt -- and a library can never be
  // "manual", because nobody runs a module by hand. The only remaining move was
  // a `baseline` entry, i.e. recording a mechanism that demonstrably runs as
  // debt that does not. Fourteen of the src/lib modules reported on 2026-08-13
  // sat behind exactly one hand-run CLI each. Reporting an item whose only
  // available resolution is a false statement is how a guard trains people to
  // file false statements.
  //
  // `baseline` deliberately does NOT propagate. Baseline means "nothing runs
  // this, and it is counted"; letting it carry reachability would turn every
  // recorded orphan into an umbrella that silently absorbs whatever is written
  // under it next -- the dumping ground this registry exists to not be.
  //
  // The manual file itself is NOT marked reachable, and that is load-bearing: a
  // registered entry whose subject becomes reachable is reported STALE with
  // "delete this entry", so seeding it as a root would make every manual entry
  // demand its own deletion, and deleting it would make the subtree unreachable
  // again. The entry stays; only what it reaches is credited.
  for (const [file, entry] of Object.entries(registry.entries || {})) {
    if (!entry || entry.status !== 'manual') continue;
    const absolute = path.join(ROOT, file);
    const references = extractReferences(absolute, readFileOrEmpty(absolute));
    for (const child of references.files) pushFile(child, `manual:${file}`);
    for (const script of references.npmScripts) pushScript(script, `manual:${file}`);
  }

  while (fileQueue.length || scriptQueue.length) {
    while (scriptQueue.length) {
      const name = scriptQueue.shift();
      expandLifecycle(name);
      const command = packageScripts[name];
      if (typeof command !== 'string') continue;
      const references = extractReferences(path.join(ROOT, 'package.json'), command, 'command');
      for (const file of references.files) pushFile(file, `npm:${name}`);
      for (const script of references.npmScripts) pushScript(script, `npm:${name}`);
    }
    while (fileQueue.length) {
      const relative = fileQueue.shift();
      if (!expandTests && relative.startsWith('tests/')) continue;
      const absolute = path.join(ROOT, relative);
      const extension = path.extname(absolute).toLowerCase();
      const source = readFileOrEmpty(absolute);
      // Extensionless files are read only when a shebang says they are scripts.
      if (extension && !SOURCE_EXTENSIONS.has(extension)) continue;
      if (!extension && !classifyFile(absolute, source)) continue;
      // JSON is DATA. It becomes an execution surface only when explicitly
      // declared a root, except for the narrowly named client-hook templates
      // that install.ps1 actually loads and installs as executable handlers.
      // Without this rule the graph launders uninvoked work
      // into "reachable": src/mcp-server.js does require('../package.json') for
      // its version string, which made package.json a graph node, which made
      // the body of EVERY npm script -- including the ones nothing ever calls
      // -- count as an invocation path. Measured: that path alone certified
      // `test:gcloud` (zero `npm run` callers anywhere) as wiring for its seven
      // test files. That is the mission-control "test:data" defect exactly.
      const installedHookTemplate = relative.startsWith('config/client-hooks/');
      if (extension === '.json' && !rootSet.has(relative) && !installedHookTemplate) continue;
      const references = extractReferences(absolute, source);
      for (const file of references.files) pushFile(file, relative);
      for (const script of references.npmScripts) pushScript(script, relative);
      for (const target of edgesBySource.get(relative) || []) pushFile(target, relative);
    }
  }

  return { reachableFiles, reachableScripts, cameFrom };
}

// Executable mechanisms under tools/ -- the population that must be reachable.
function collectToolFiles() {
  return walkFiles(path.join(ROOT, 'tools'), (candidate) => EXECUTABLE_EXTENSIONS.has(path.extname(candidate).toLowerCase()))
    .map((absolute) => relativeToRoot(absolute))
    .filter(Boolean)
    .sort();
}

// Library modules under src/lib -- the population the FIRST version of this
// guard could not see, and the reason it is being extended.
//
// tools/ and tests/ are executables: something either runs them or nothing
// does. A LIBRARY is different. src/lib/audit-checkpoint.js is correct, has a
// passing suite, and is reachable from a root -- through
// `npm test` -> tests/audit-checkpoint.test.js -> require('../src/lib/audit-checkpoint').
// By this guard's own reachability rule it was WIRED, and it had never once
// run outside a test. It cost something real: on 2026-08-10 the production
// audit head anchor was advanced onto an event existing only in a scratch
// fork, and "fork or truncation?" was answerable only because that scratch
// copy happened to still be on disk. One emitted checkpoint answers it from a
// signed head hash. That is the defect this population exists to name:
// A MECHANISM WHOSE ONLY CALLER IS THE TEST THAT PROVES IT WORKS.
//
// TWO POPULATIONS, ONLY ONE GATED, and the split is measured rather than
// tasteful:
//
//   testOnlyLibraries (58 at introduction) -- reachable, but only through
//     tests/. Each one is a specific claim: "a suite asserts this is correct
//     and production never calls it." GATED, through the same registry the
//     other populations use.
//
//   unreferencedLibraries (79 at introduction) -- reached by nothing at all,
//     not even a test. REPORTED, NOT GATED, because this set can contain
//     computed-path and directory-convention loads no static reader can follow.
//     Gating a population with known false reds is
//     precisely how a guard earns the reputation that gets it switched off --
//     the failure mode this file already documents at the $VAR/ path rule.
//
// Nothing here is retroactively blamed: every current instance is frozen as
// baseline debt exactly as tools/ was, so the ratchet catches the NEXT
// audit-checkpoint.js on the day it is written rather than failing the build
// over history.
function collectLibraryFiles() {
  return walkFiles(path.join(ROOT, 'src', 'lib'), (candidate) => {
    const extension = path.extname(candidate).toLowerCase();
    return extension === '.js' || extension === '.cjs' || extension === '.mjs';
  })
    .map((absolute) => relativeToRoot(absolute))
    .filter(Boolean)
    .sort();
}

function validateReleaseExcludedLibraries({
  libraries,
  testOnlyLibraries,
  unreferencedLibraries,
  productionReachable
}) {
  const known = new Set(libraries);
  const testOnly = new Set(testOnlyLibraries);
  const unreferenced = new Set(unreferencedLibraries);
  const issues = [];

  for (const file of RELEASE_EXCLUDED_LIBRARIES) {
    if (!known.has(file)) {
      issues.push({ file, why: 'release-excluded library no longer exists; remove or update the exact exclusion' });
      continue;
    }
    if (productionReachable.has(file)) {
      issues.push({ file, why: 'release-excluded library became production-reachable; the exclusion cannot hide a new runtime edge' });
      continue;
    }
    if (!testOnly.has(file) && !unreferenced.has(file)) {
      issues.push({ file, why: 'release-excluded library is no longer measured as test-only or unreferenced' });
    }
  }

  const excluded = RELEASE_EXCLUDED_LIBRARIES
    .filter((file) => known.has(file) && !productionReachable.has(file));
  const gated = testOnlyLibraries.filter((file) => !RELEASE_EXCLUDED_LIBRARIES.includes(file));
  return { excluded, gated, issues };
}

function runGuard() {
  const registry = loadRegistry();
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const packageScripts = packageJson.scripts || {};
  const invalidRoots = validateDeclaredRoots(registry, packageScripts);
  const invalidProductionEdges = validateDeclaredProductionEdges(registry).invalid;
  const productionClassification = loadProductionClassification();
  const { reachableFiles, cameFrom } = computeReachable(registry, packageScripts);
  const productionGraph = computeReachable(registry, packageScripts, { expandTests: false });
  const productionReachable = productionGraph.reachableFiles;

  const libraries = collectLibraryFiles();
  const unreferencedLibraries = libraries.filter((file) => !reachableFiles.has(file));
  const testOnlyLibraries = libraries
    .filter((file) => reachableFiles.has(file) && !productionReachable.has(file));
  const releaseLibraryScope = validateReleaseExcludedLibraries({
    libraries,
    testOnlyLibraries,
    unreferencedLibraries,
    productionReachable
  });

  // tools/ -- computed here.
  const tools = collectToolFiles();
  const unreachableTools = tools.filter((tool) => !productionReachable.has(tool)).sort();
  const classificationIssues = [...productionClassification.issues];
  const classificationRecord = productionClassification.record;
  if (classificationRecord) {
    const evidence = classificationRecord.evidence;
    const original = evidence && Array.isArray(evidence.original242) ? evidence.original242 : [];
    const categoryUnion = [...productionClassification.byFile.keys()].sort();
    const expectedUnion = [...new Set([...original, ...unreachableTools])].sort();
    const testExpandedOnly = unreachableTools.filter(tool => reachableFiles.has(tool));
    const notReachedEvenWithTests = unreachableTools.filter(tool => !reachableFiles.has(tool));
    const dispositions = { manual: [], baseline: [], unregistered: [] };
    for (const tool of unreachableTools) {
      const status = registry.entries[tool] && registry.entries[tool].status;
      if (status === 'manual') dispositions.manual.push(tool);
      else if (status === 'baseline') dispositions.baseline.push(tool);
      else dispositions.unregistered.push(tool);
    }
    if (classificationRecord.originalFindingCount !== 242 || original.length !== 242 || new Set(original).size !== 242
        || !exactSortedStringList(original, [...original].sort())) {
      classificationIssues.push({ file: null, why: 'original242 must remain the immutable sorted 242-file finding' });
    }
    if (classificationRecord.currentFindingCountAtCapture !== unreachableTools.length
        || !evidence || !exactSortedStringList(evidence.currentProductionUnreachable, unreachableTools)) {
      classificationIssues.push({ file: null, why: 'current production-unreachable evidence is stale' });
    }
    if (!evidence || evidence.currentProductionChain !== null) {
      classificationIssues.push({ file: null, why: 'currentProductionChain must be null because every current finding has no production chain' });
    }
    if (!evidence || !exactSortedStringList(evidence.currentTestExpandedOnly, testExpandedOnly)
        || !exactSortedStringList(evidence.currentNotReachedEvenWithTests, notReachedEvenWithTests)) {
      classificationIssues.push({ file: null, why: 'test-expanded reachability evidence is stale' });
    }
    const declaredDispositions = evidence && evidence.currentRegistryDisposition;
    for (const status of Object.keys(dispositions)) {
      const declared = declaredDispositions && declaredDispositions[status];
      if (!declared || declared.count !== dispositions[status].length
          || !exactSortedStringList(declared.files, dispositions[status])) {
        classificationIssues.push({ file: null, why: `current ${status} registry-disposition evidence is stale` });
      }
    }
    if (classificationRecord.unionEntryCount !== expectedUnion.length
        || !exactSortedStringList(categoryUnion, expectedUnion)) {
      classificationIssues.push({ file: null, why: 'category union no longer equals original242 plus current production findings' });
    }
  }
  for (const tool of unreachableTools) {
    if (!productionClassification.byFile.has(tool)) {
      classificationIssues.push({ file: tool, why: 'production-unreachable tool has no declared production class' });
    }
  }
  for (const [file, classification] of productionClassification.byFile) {
    const exists = fs.existsSync(path.join(ROOT, file));
    if (classification === 'retired-stale') {
      if (exists) classificationIssues.push({ file, why: 'retired-stale tool still exists' });
    } else if (!exists) {
      classificationIssues.push({ file, why: `${classification} tool no longer exists` });
    }
  }
  const unresolvedCustomerTools = unreachableTools.filter(tool => {
    const classification = productionClassification.byFile.get(tool);
    return classification === undefined || classification === 'customer-runtime-intended';
  });
  const productionExcludedTools = unreachableTools.filter(tool => {
    const classification = productionClassification.byFile.get(tool);
    return classification === 'build-release' || classification === 'developer-only';
  });

  // tests/ -- NOT recomputed. tools/test-census.js already answers exactly this
  // question for test files, is already consumed by tools/test-run.js, and
  // rebuilding its logic here would be the "we should build X / X is already
  // here" failure this whole effort exists to stop.
  const census = buildCensus();
  const unreachableTests = census.orphaned.slice();

  // TWO DEFINITIONS OF "REACHABLE", AND THE GAP BETWEEN THEM IS A FINDING.
  //
  // The census counts a test as reachable if ANY package.json script names it.
  // This guard counts it reachable only if a surface that runs BY ITSELF gets
  // to it. Those disagree, and the disagreement is the exact defect the mission
  // names: an npm script nothing invokes is not wiring.
  //
  // Measured example: `test:gcloud` occurs exactly once in package.json -- its
  // own definition -- with zero `npm run test:gcloud` callers anywhere in the
  // repository. Its seven test files are "reachable" to the census and
  // unreachable in fact.
  //
  // The guard GATES on the census definition, deliberately: that is the shared
  // definition already consumed by tools/test-run.js, and unilaterally
  // tightening it here would fail the build over a disagreement rather than
  // over a defect. But the stricter number is REPORTED on every run, because
  // the whole lesson of this codebase is that the comfortable measurement
  // silently replaces the true one.
  const strictlyUnreachableTests = census.candidates.filter((testPath) => !reachableFiles.has(testPath));
  const launderedTests = strictlyUnreachableTests.filter((testPath) => !census.orphaned.includes(testPath));

  const unreachable = [...unresolvedCustomerTools, ...unreachableTests, ...releaseLibraryScope.gated].sort();
  const registered = registry.entries;

  const unregistered = unreachable.filter((file) => !(file in registered));

  // THE TWO DEFINITIONS ABOVE MUST NOT BE MIXED, and mixing them turned this
  // ratchet into a laundering machine pointed the wrong way.
  //
  // `unreachable` gates on the CENSUS definition (any npm script names it), for
  // the stated reason that unilaterally tightening the gate would fail the build
  // over a disagreement. That is right for GATING. It is exactly wrong for
  // deciding an entry is stale, because staleness deletes.
  //
  // Measured 2026-08-11: tests/bridge-status.js is named by `test:bridge-status`
  // and by nothing else in the repository -- zero `npm run test:bridge-status`
  // callers, so this guard's own `--why` prints "NO INVOCATION PATH" and its own
  // launderedTests list contains it. The census still calls it reachable, so it
  // fell out of `unreachable`, so the entry registering it as unrun was reported
  // stale with "delete this entry".
  //
  // The registry may only SHRINK. So obeying that instruction removes the only
  // record that the file is unrun, and the census -- which never considered it
  // orphaned -- will not report it again. The orphan does not become wired; it
  // becomes invisible, permanently, on the authority of the instrument built to
  // stop exactly that. It is the mission-control "test:data" defect being used
  // to erase the evidence of itself.
  //
  // So an entry is stale only when the file is reachable by the STRICT walk too.
  // unreferencedLibraries is in this set for the same reason from the other
  // side: a library that fell out of testOnly because nothing reaches it AT ALL
  // is more unreachable than its entry claims, never "now reachable".
  const stillUnreachable = new Set([
    ...unreachable,
    ...strictlyUnreachableTests,
    ...unreferencedLibraries
  ]);

  // "IT IS NOW REACHABLE" HAS TO BE A MEASUREMENT, NOT AN INFERENCE FROM
  // FAILING TO APPEAR IN A LIST.
  //
  // Every population above is a filtered slice of the repository: tools/ by
  // extension, tests/ by the census's `isCandidate`, src/lib/ by directory. A
  // file can be registered and belong to NONE of them, and the test below asked
  // only "is it missing from my lists?" -- so it answered "it is now reachable
  // -- delete this entry" about a file whose reachability it had never once
  // computed. `--prune` obeys that answer, and the registry may only shrink, so
  // the record is destroyed on the strength of an inference.
  //
  // This is not hypothetical: measured 2026-08-13, FIFTY-FOUR files under tests/
  // are unreachable by the strict walk and sit outside every population --
  // tests/<package>/run.js runners, tests/fixtures/*, worker helpers -- because
  // `isCandidate` excludes runners, helpers and fixtures by design. Register any
  // one of them and the guard would immediately demand its deletion while
  // nothing on earth ran it. That is the mission-control "test:data" defect
  // being used to erase the evidence of itself, which is precisely the failure
  // the stale test was tightened to prevent in the first place -- it was
  // tightened for tests the census laundered, and left open for files the census
  // never looked at.
  //
  // So staleness now REQUIRES a positive invocation path, by the same definition
  // the matching population is gated on. The change can only ever delete FEWER
  // entries than before, never more.
  const hasInvocationPath = (file) => (file.startsWith('src/lib/') || file.startsWith('tools/')
    ? productionReachable.has(file)
    : reachableFiles.has(file));

  // Registry hygiene. Without these two checks the registry becomes a place to
  // put things so they stop being counted, which is how a baseline turns into
  // a dumping ground.
  const stale = [];
  const invalidReasons = [];
  // Registered, still unrun, and outside every population this guard measures --
  // so nothing else in the report would ever mention them again. Named rather
  // than silently kept, because an entry no report acknowledges is the same
  // invisibility the registry exists to prevent.
  const registeredOutsideEveryPopulation = [];
  for (const [file, entry] of Object.entries(registered)) {
    if (!fs.existsSync(path.join(ROOT, file))) {
      stale.push({ file, why: 'registered but the file no longer exists' });
      continue;
    }
    if (!stillUnreachable.has(file)) {
      if (hasInvocationPath(file)) {
        stale.push({ file, why: 'registered as unreachable but it is now reachable -- delete this entry' });
        continue;
      }
      registeredOutsideEveryPopulation.push(file);
    }
    const status = entry && entry.status;
    if (status === 'manual') {
      const reason = (entry.reason || '').trim();
      if (reason.length < MINIMUM_REASON_LENGTH) {
        invalidReasons.push({ file, why: `status "manual" needs a reason of at least ${MINIMUM_REASON_LENGTH} characters` });
      }
    } else if (status !== 'baseline') {
      invalidReasons.push({ file, why: `unknown status ${JSON.stringify(status)} -- use "manual" or "baseline"` });
    }
  }

  const baselineCount = Object.values(registered).filter((entry) => entry && entry.status === 'baseline').length;
  const manualCount = Object.values(registered).filter((entry) => entry && entry.status === 'manual').length;

  // KIND 4: statically wired, dynamically shadowed. See findShadowedTests.
  // `shadowed` is evidence-backed (a named earlier sibling is recorded failing
  // in state/test-runs/latest.json) and therefore fails the guard. `conditional`
  // is the weaker structural fact -- position >1 in a fail-fast batch -- and is
  // reported loudly but does not fail, because with no run data every batch
  // member after the first qualifies, and a check that is red on 372 items on
  // day one gets muted. Muting is how the substitutes in this repository got
  // their start.
  const shadowing = findShadowedTests(packageScripts);
  const shadowedTests = Object.keys(shadowing.shadowed);

  return {
    ok: !registry.missing
      && unregistered.length === 0
      && invalidRoots.length === 0
      && invalidProductionEdges.length === 0
      && classificationIssues.length === 0
      && releaseLibraryScope.issues.length === 0
      && stale.length === 0
      && invalidReasons.length === 0
      && shadowedTests.length === 0,
    registryMissing: registry.missing,
    cameFrom,
    productionCameFrom: productionGraph.cameFrom,
    counts: {
      tools: tools.length,
      toolsUnreachable: unreachableTools.length,
      toolsCustomerRuntimeUnreachable: unresolvedCustomerTools.length,
      toolsProductionExcluded: productionExcludedTools.length,
      tests: census.counts.candidates,
      testsUnreachable: unreachableTests.length,
      libraries: libraries.length,
      librariesTestOnly: testOnlyLibraries.length,
      librariesReleaseExcluded: releaseLibraryScope.excluded.length,
      librariesUnreferenced: unreferencedLibraries.length,
      registeredManual: manualCount,
      registeredBaseline: baselineCount,
      invalidRoots: invalidRoots.length,
      invalidProductionEdges: invalidProductionEdges.length,
      unregistered: unregistered.length,
      testsLaunderedByUninvokedScripts: launderedTests.length,
      testsConditionallyReachable: Object.keys(shadowing.conditional).length,
      testsShadowed: shadowedTests.length
    },
    shadowing,
    shadowedTests,
    launderedTests,
    unregistered,
    stale,
    registeredOutsideEveryPopulation,
    invalidReasons,
    invalidRoots,
    invalidProductionEdges,
    classificationIssues,
    releaseExclusionIssues: releaseLibraryScope.issues,
    releaseExcludedLibraries: releaseLibraryScope.excluded,
    gatedTestOnlyLibraries: releaseLibraryScope.gated,
    unreachableTools,
    unresolvedCustomerTools,
    productionExcludedTools,
    unreachableTests,
    testOnlyLibraries,
    unreferencedLibraries
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

// state/test-runs/latest.json is local, gitignored, and only ever refreshed
// by a human or agent running the full suite -- it does not update itself as
// commits land. In a repository this size, taking tens of commits a day, that
// snapshot is routinely hours or days old by the time this guard reads it, so
// a name attributed to "blocked by X" here is a historical claim, not a live
// one. Stating the age plainly is what stops that historical claim from being
// read as a current fact about the repository at HEAD.
function describeEvidenceAge(generatedAt) {
  const thenMs = Date.parse(generatedAt);
  if (!Number.isFinite(thenMs)) return null;
  const ageMs = Date.now() - thenMs;
  if (ageMs < 0) return null;
  const hours = ageMs / (60 * 60 * 1000);
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return `about ${Math.round(hours)} hour(s) ago`;
  return `about ${Math.round(hours / 24)} day(s) ago`;
}

function formatReport(result) {
  const lines = [];
  const { counts } = result;
  lines.push('INVOCATION GUARD');
  lines.push(`  tools/: ${counts.tools} executable, ${counts.toolsUnreachable} with no invocation path`);
  lines.push(`          ${counts.toolsCustomerRuntimeUnreachable} intended customer runtime; ${counts.toolsProductionExcluded} truthfully build/developer-only`);
  lines.push(`  tests/: ${counts.tests} candidates, ${counts.testsUnreachable} with no invocation path`);
  lines.push(`  src/lib/: ${counts.libraries} modules, ${counts.librariesTestOnly} reached only by their own tests`);
  lines.push(`            ${counts.librariesReleaseExcluded} exact payment/licensing module(s) excluded from this release's runtime gate`);
  lines.push(`  registry: ${counts.registeredManual} deliberately-manual, ${counts.registeredBaseline} baseline debt`);
  if (counts.librariesUnreferenced > 0) {
    lines.push(`  WARN: ${counts.librariesUnreferenced} src/lib module(s) are reached by nothing at all, not even a test.`);
    lines.push('        Reported, NOT gated: this set can contain computed-path and directory-convention');
    lines.push('        loads that no static reader can follow, and gating a population with known false');
    lines.push('        reds is how a guard');
    lines.push('        gets switched off. node tools/invocation-guard.js --json');
  }
  if (counts.testsLaunderedByUninvokedScripts > 0) {
    lines.push(`  WARN: ${counts.testsLaunderedByUninvokedScripts} test(s) look reachable only because an npm script names them`);
    lines.push('        while nothing invokes that script. Not gated (see tools/invocation-guard.js),');
    lines.push('        but this is the mission-control "test:data" shape. node tools/invocation-guard.js --json');
  }

  if (result.registryMissing) {
    lines.push('');
    lines.push(`  FAIL: ${toPosix(path.relative(ROOT, REGISTRY_PATH))} does not exist.`);
    lines.push('  Without it nothing is registered and nothing can be, so every unreachable');
    lines.push('  mechanism below would be silently tolerated. Seed it once:');
    lines.push('    node tools/invocation-guard.js --seed-baseline');
  }

  if (result.invalidRoots.length) {
    lines.push('');
    lines.push(`  FAIL: ${result.invalidRoots.length} declared invocation root(s) do not exist.`);
    for (const { root, why } of result.invalidRoots) lines.push(`    ${JSON.stringify(root)} -- ${why}`);
  }

  if (result.invalidProductionEdges.length) {
    lines.push('');
    lines.push(`  FAIL: ${result.invalidProductionEdges.length} declared production edge(s) are invalid.`);
    for (const { edge, why } of result.invalidProductionEdges) {
      lines.push(`    ${edge && edge.from ? edge.from : '<edge>'} -> ${edge && edge.to ? edge.to : '<edge>'} -- ${why}`);
    }
  }

  if (result.classificationIssues.length) {
    lines.push('');
    lines.push(`  FAIL: ${result.classificationIssues.length} production classification issue(s).`);
    for (const { file, why } of result.classificationIssues) lines.push(`    ${file || '<classification>'} -- ${why}`);
  }

  if (result.releaseExclusionIssues.length) {
    lines.push('');
    lines.push(`  FAIL: ${result.releaseExclusionIssues.length} release-scope exclusion issue(s).`);
    for (const { file, why } of result.releaseExclusionIssues) lines.push(`    ${file} -- ${why}`);
  }

  if (result.releaseExcludedLibraries.length) {
    lines.push('');
    lines.push('  SCOPE: exact non-runtime library exclusions (not production-wiring proof):');
    for (const file of result.releaseExcludedLibraries) {
      const reason = RELEASE_EXCLUDED_PAYMENT_LIBRARIES.includes(file)
        ? 'payments remain outside this release'
        : 'owner-deferred mobile prototype; desktop-only work';
      lines.push(`    ${file} -- ${reason}`);
    }
  }

  if (result.unregistered.length) {
    lines.push('');
    lines.push(`  FAIL: ${result.unregistered.length} executable mechanism(s) exist with NO invocation path and NO registry entry.`);
    lines.push('  Each of these is code that can never run. That is the defect this guard exists to stop.');
    lines.push('');
    for (const file of result.unregistered) lines.push(`    ${file}`);
    lines.push('');
    lines.push('  Fix it in ONE of two ways.');
    lines.push('');
    lines.push('  (a) WIRE IT -- the right answer almost every time. Make it reachable from a');
    lines.push('      root declared in config/invocation-registry.json: an npm lifecycle script,');
    lines.push('      a git hook, the MCP server, a bin entry, or a managed-process registrar.');
    lines.push('      Note that adding a NEW npm script does not by itself count -- something');
    lines.push('      that already runs has to reach it. That is the whole point.');
    lines.push('');
    lines.push('  (b) DECLARE IT MANUAL -- only if a human genuinely must invoke it by hand.');
    lines.push('      Add to "entries" in config/invocation-registry.json:');
    lines.push('');
    for (const file of result.unregistered.slice(0, 3)) {
      lines.push(`        ${JSON.stringify(file)}: { "status": "manual", "reason": "<why a human must run this by hand>" },`);
    }
    if (result.unregistered.length > 3) lines.push(`        ... and ${result.unregistered.length - 3} more`);
  }

  if (result.stale.length) {
    lines.push('');
    lines.push(`  FAIL: ${result.stale.length} stale registry entr(ies). The registry may only shrink.`);
    for (const { file, why } of result.stale) lines.push(`    ${file} -- ${why}`);
  }

  if (result.registeredOutsideEveryPopulation && result.registeredOutsideEveryPopulation.length) {
    lines.push('');
    lines.push(`  NOTE: ${result.registeredOutsideEveryPopulation.length} registry entr(ies) name a file that is still unrun but sits`);
    lines.push('  outside every population this guard measures (tests/ runners, fixtures and worker');
    lines.push('  helpers are excluded by the census; only src/lib is scanned under src/). The entries');
    lines.push('  are KEPT -- an earlier version called them "now reachable" and invited their deletion');
    lines.push('  without ever computing reachability. Nothing else in this report counts them.');
    for (const file of result.registeredOutsideEveryPopulation.slice(0, 10)) lines.push(`    ${file}`);
    if (result.registeredOutsideEveryPopulation.length > 10) {
      lines.push(`    ... and ${result.registeredOutsideEveryPopulation.length - 10} more`);
    }
  }

  if (result.invalidReasons.length) {
    lines.push('');
    lines.push(`  FAIL: ${result.invalidReasons.length} registry entr(ies) are not honestly filled in.`);
    for (const { file, why } of result.invalidReasons) lines.push(`    ${file} -- ${why}`);
  }

  if (counts.registeredBaseline > 0) {
    lines.push('');
    lines.push(`  NOTE: ${counts.registeredBaseline} mechanism(s) are recorded as pre-existing baseline debt.`);
    lines.push('  They are NOT accepted -- they are counted, dated, and frozen. The registry can');
    lines.push('  only shrink: wiring or deleting one requires removing its entry, and this guard');
    lines.push('  fails if a baseline entry becomes reachable and is left behind.');
  }

  if (result.shadowedTests && result.shadowedTests.length) {
    lines.push('');
    lines.push(`  FAIL: ${result.shadowedTests.length} test(s) are statically wired but were NOT REACHED in the last recorded run.`);
    lines.push('  They sit after a FAILING sibling in a fail-fast batch, so the runner stopped before them.');
    const evidence = result.shadowing.runEvidence;
    const evidenceAge = evidence && evidence.generatedAt ? describeEvidenceAge(evidence.generatedAt) : null;
    if (evidence && evidence.generatedAt) {
      lines.push(`  This is state/test-runs/latest.json, a historical snapshot recorded ${evidence.generatedAt}`);
      lines.push(`  (${evidenceAge || 'age unknown'}) -- not a live check of the file(s) below. "blocked by" is what`);
      lines.push('  failed THAT run; it may since have been fixed and this report would not yet know.');
      lines.push('  Re-verify the named blocker yourself (standalone, then at its exact batch position)');
      lines.push('  before spending effort on it, then refresh the evidence with `npm run test:all`.');
    } else {
      lines.push('  state/test-runs/latest.json has no generatedAt, so this evidence\'s age is unknown.');
    }
    for (const file of result.shadowedTests.slice(0, 10)) {
      const detail = result.shadowing.shadowed[file];
      lines.push(`    ${file}  (${detail.batch} position ${detail.position}, blocked by ${detail.blockedBy})`);
    }
    if (result.shadowedTests.length > 10) lines.push(`    ... and ${result.shadowedTests.length - 10} more`);
  }

  if (result.counts.testsConditionallyReachable) {
    lines.push('');
    lines.push(`  NOTE: ${result.counts.testsConditionallyReachable} test(s) are CONDITIONALLY reachable -- position >1 in a fail-fast batch.`);
    lines.push('  Each runs only if every earlier sibling passes. That is not the same as wired:');
    lines.push('  a batch that passes --fail-fast to tests/run-isolated.js stops at the first');
    lines.push('  failure, and one such batch hid THREE unknown failures until it was made to');
    lines.push('  keep going, including the orphan-test ratchet itself. Continuation is now the');
    lines.push('  runner default, so any batch counted here opted back into stopping early.');
    if (!result.shadowing.runEvidence.available) {
      lines.push('');
      lines.push('  No run data at state/test-runs/latest.json, so WHICH of these actually went');
      lines.push('  unreached cannot be stated here. Produce it with `npm run test:all`, after');
      lines.push('  which this guard names the specific shadowed files and fails on them.');
    }
  }

  lines.push('');
  lines.push(result.ok ? 'VERDICT: PASS every executable mechanism is reachable or registered.' : 'VERDICT: FAIL unregistered mechanisms with no invocation path.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// One-shot baseline seeding
// ---------------------------------------------------------------------------
//
// Deliberately NOT a general "refresh the baseline" command. If an author could
// re-run a bulk regenerate, every new orphan would be one command away from
// being silenced, and the registry would document nothing. This refuses to run
// against a registry that already has entries; after seeding, the only way to
// add an entry is to type it with a reason.
// SEEDING MERGES. IT NEVER REPLACES.
//
// The first version of this function rebuilt `entries` from scratch. A builder
// wrote a considered "manual" entry with a paragraph of reasoning TWICE, and a
// regeneration erased it both times, resetting the file to {}. He correctly
// stopped editing the file rather than fight the generator.
//
// That is the exact failure this registry exists to prevent, occurring inside
// the registry: a judged decision silently converted back into unjudged debt,
// by an automated process, with nobody watching it happen. The header of this
// file says "baseline" is NOT an acceptance -- so demoting a reasoned manual
// entry to baseline is the most damaging edit anything here can make, and it
// was the one edit the generator made for free.
//
// A generated file that destroys human judgement is worse than no registry at
// all, because it launders decisions into debt while looking maintained.
//
// So: existing entries are preserved verbatim, always. Seeding only ADDS
// entries for mechanisms that are unreachable and not yet listed. Nothing here
// can downgrade a "manual" to a "baseline", and re-running is safe.
function seedBaseline() {
  const existing = fs.existsSync(REGISTRY_PATH) ? loadRegistry() : null;
  const roots = existing ? existing.roots : [];
  const preserved = existing ? existing.entries : {};

  // THE REFUSAL THIS FUNCTION HAS ALWAYS ADVERTISED, FINALLY IMPLEMENTED.
  //
  // The paragraph above has said, since the day it was written, that seeding
  // "refuses to run against a registry that already has entries; after seeding,
  // the only way to add an entry is to type it with a reason". No code ever
  // checked. `--seed-baseline` was a working bulk-silence button for the whole
  // life of this registry, and its own comment is what stopped anyone looking.
  //
  // It was pressed. The registry's seededAt stamps are the evidence: 291 entries
  // dated 2026-08-09, and 57 MORE dated 2026-08-11. The second batch cannot be a
  // first seed. It is 57 mechanisms with no invocation path removed from this
  // guard's report in one command, against a registry already holding 291, with
  // no reason typed for a single one of them.
  //
  // That is this repository's dominant defect wearing the uniform of the guard
  // built to catch it. The comment described a safety property, every reader
  // believed the comment, and the property was not there -- so the number this
  // guard reported stopped measuring debt and started measuring how recently
  // somebody ran the silencer.
  //
  // The refusal is deliberately absolute, with no --force. An escape hatch would
  // be taken for precisely the reason those 57 were, and the next reader would
  // again be trusting prose over behaviour. Both documented ways out of an
  // orphan remain open, and both cost something on purpose: wire it so it really
  // runs, or type a manual entry that says why a human must run it by hand.
  if (existing && Object.keys(preserved).length > 0) {
    process.stderr.write(
      `Refusing to seed: ${toPosix(path.relative(ROOT, REGISTRY_PATH))} already holds `
        + `${Object.keys(preserved).length} entr(ies).\n`
        + '\n'
        + 'The baseline is recorded ONCE. A mechanism that lost its invocation path after\n'
        + 'that is not pre-existing debt -- it is a defect introduced since, and bulk-seeding\n'
        + 'it is exactly how this registry reached 348 entries nobody had looked at.\n'
        + '\n'
        + 'Resolve each one the way the guard reports it:\n'
        + '  WIRE IT     -- make it reachable from a declared root, so it actually runs.\n'
        + '  DECLARE IT  -- add { "status": "manual", "reason": "..." } by hand, saying why.\n'
        + '\n'
        + 'To shrink the registry instead, use --prune. It can only ever remove entries.\n'
    );
    return 2;
  }

  const registry = { roots, entries: { ...preserved } };
  const probe = runGuard();
  const seededAt = new Date().toISOString().slice(0, 10);

  let added = 0;
  for (const file of [...probe.unresolvedCustomerTools, ...probe.unreachableTests, ...probe.gatedTestOnlyLibraries].sort()) {
    if (file in registry.entries) continue;
    registry.entries[file] = { status: 'baseline', seededAt };
    added += 1;
  }

  // Sort keys so an added entry shows up as one line in a diff rather than
  // reordering the file and burying it.
  registry.entries = Object.fromEntries(
    Object.entries(registry.entries).sort(([left], [right]) => left.localeCompare(right))
  );

  const manualKept = Object.values(preserved).filter((entry) => entry && entry.status === 'manual').length;
  writeRegistry(registry);
  process.stdout.write(`Seeded ${added} new baseline entr(ies); preserved ${Object.keys(preserved).length} existing (${manualKept} hand-written manual).\n`);
  return 0;
}

// `--prune` is the ratchet's other half, and it is safe BY CONSTRUCTION.
//
// The guard fails on a stale entry -- one listed as unreachable that is now
// reachable, or whose file is gone -- because a registry that keeps entries for
// solved problems stops describing anything. Removing those by hand is fine for
// one. It is not fine for the case that actually happens: a root gets added
// (.githooks/pre-push arrived mid-session and legitimately wires several tools)
// and dozens of entries become stale at once. Hand-editing dozens of lines is
// the kind of chore people skip by deleting the check instead.
//
// This can never silence anything, and that is the whole design: it removes ONLY
// entries whose subject is already reachable or already deleted. It cannot add,
// cannot downgrade a "manual", and cannot touch an entry that is still genuinely
// unwired. There is deliberately no inverse -- no bulk command that makes an
// unreachable thing stop being reported. That asymmetry is the point: shrinking
// the registry is mechanical, growing it costs you a typed reason.
function pruneRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    process.stderr.write('No config/invocation-registry.json to prune.\n');
    return 2;
  }
  const existing = loadRegistry();
  const probe = runGuard();
  const stalePaths = new Set(probe.stale.map((item) => item.file));
  if (stalePaths.size === 0) {
    process.stdout.write('Nothing to prune: no stale entries.\n');
    return 0;
  }
  const entries = Object.fromEntries(Object.entries(existing.entries).filter(([file]) => !stalePaths.has(file)));
  writeRegistry({ roots: existing.roots, entries });
  process.stdout.write(`Pruned ${stalePaths.size} stale entr(ies); ${Object.keys(entries).length} remain.\n`);
  for (const file of [...stalePaths].sort()) process.stdout.write(`  - ${file}\n`);
  return 0;
}

function writeRegistry(registry) {
  const header = {
    $comment: [
      'INVOCATION REGISTRY -- the declared answer to "how does this run?".',
      '',
      'Read tools/invocation-guard.js for why this exists. The short version:',
      'this repository\'s measured dominant defect is mechanisms that exist, work',
      'correctly, and that nothing ever runs -- a 40KB correct detector cited in',
      'ten documents and invoked by zero automation, a supervisor that computed a',
      'verdict and exited 0 anyway, a test glob no target called while a manager',
      'hand-listed 11 files and reported "all green".',
      '',
      'roots: the ONLY surfaces treated as executing by themselves. Everything',
      'else must be reachable from one of these, transitively, or be listed in',
      'entries. "npm:<name>" is a package.json script; npm lifecycle pre/post',
      'hooks are expanded automatically. A root belongs here only if something',
      'outside this repository actually starts it -- npm, git, the scheduler, or',
      'the MCP client. Adding an npm script and pointing a root at it proves',
      'nothing; that is precisely the non-wiring this guard was built to catch.',
      '',
      'entries: mechanisms with no invocation path, each with a status.',
      '  "manual"   -- a human genuinely must invoke this by hand. Requires a',
      '                reason that says why. This is the honest case and it is',
      '                meant to be one line to write.',
      '  "baseline" -- pre-existing debt, recorded once on the date shown so it',
      '                is counted rather than invisible. NOT an acceptance.',
      '',
      'The registry may only SHRINK. If a listed mechanism becomes reachable, or',
      'is deleted, the guard fails until its entry is removed. That is what stops',
      'this file from becoming the place things go to stop being counted.'
    ],
    schemaVersion: 1,
    ...registry
  };
  fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(header, null, 2)}\n`);
}

// `--why <path>` prints the chain from a root to a file, or says plainly that
// there is none. This is the check against the failure mode where someone
// believes a thing is wired because a script bearing its name exists.
function explainChain(target) {
  const result = runGuard();
  const normalized = toPosix(target.replace(/\\/g, '/'));
  const cameFrom = normalized.startsWith('tests/') ? result.cameFrom : result.productionCameFrom;
  const chain = [];
  let cursor = normalized;
  const seen = new Set();
  while (cursor != null && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    if (!cameFrom.has(cursor)) break;
    cursor = cameFrom.get(cursor);
  }
  if (!cameFrom.has(normalized) && chain.length === 1) {
    const entry = null;
    process.stdout.write(`${normalized}\n  NO INVOCATION PATH. Nothing that runs by itself reaches this file.\n`);
    return entry === null ? 1 : 0;
  }
  process.stdout.write(`${normalized}\n`);
  const ordered = chain.reverse();
  for (const [index, node] of ordered.entries()) {
    process.stdout.write(`  ${'  '.repeat(index)}${index === 0 ? 'ROOT ' : '-> '}${node}\n`);
  }
  return 0;
}

if (require.main === module) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.includes('--seed-baseline')) {
    process.exit(seedBaseline());
  }
  if (argumentsList.includes('--prune')) {
    process.exit(pruneRegistry());
  }
  const whyIndex = argumentsList.indexOf('--why');
  if (whyIndex !== -1) {
    const target = argumentsList[whyIndex + 1];
    if (!target) {
      process.stderr.write('Usage: node tools/invocation-guard.js --why <path>\n');
      process.exit(2);
    }
    process.exit(explainChain(target));
  }
  const result = runGuard();
  if (argumentsList.includes('--json')) process.stdout.write(`${JSON.stringify({ ...result, cameFrom: undefined, productionCameFrom: undefined }, null, 2)}\n`);
  else process.stdout.write(`${formatReport(result)}\n`);
  // The exit code is the entire point. tools/package-check.js reports 206
  // unmapped files and 329 layering violations and then exits 0; the bridge
  // supervisor computed a correct verdict and exited 0 unconditionally. A check
  // whose result cannot fail a run is a log.
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  runGuard, formatReport, extractReferences, computeReachable, collectToolFiles,
  validateDeclaredRoots, validateDeclaredProductionEdges,
  validateReleaseExcludedLibraries, RELEASE_EXCLUDED_PAYMENT_LIBRARIES,
  RELEASE_EXCLUDED_OWNER_DEFERRED_LIBRARIES
};
