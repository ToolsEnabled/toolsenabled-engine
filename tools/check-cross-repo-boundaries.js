'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { generate, validate } = require('./generate-ownership-types');

const ROOT = path.resolve(__dirname, '..');
const OWNERSHIP_MAP = path.join(ROOT, 'schemas', 'ownership-map.json');
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.py']);

function readMap(mapPath = OWNERSHIP_MAP) {
  return validate(JSON.parse(fs.readFileSync(mapPath, 'utf8')));
}

function within(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// A SPECIFIER IS READ FROM CODE, NEVER FROM PROSE.
//
// This scanner used to match require()/import text ANYWHERE in a file, so a
// COMMENT that quotes a forbidden import was reported as a boundary breach. The
// live case: tools/check-payload-boundary.mjs explains its own test fixture in
// prose, and this check reported it with the specifier
// "../../../Portfolio Dashboard/\n        // frontend/app.js" -- a "path" that
// contains a line break and a `//` comment marker, which is the shape of the
// defect stated in the finding itself. No module specifier looks like that.
//
// The rule being restored is the one check-payload-boundary.mjs already states
// for its own rule 4b: quoted require() text is a FIXTURE, NOT AN EDGE, and "a
// finding list whose alarming label is mostly noise is a finding list nobody
// reads, which costs the one real hit it exists for". Exempting the one file
// that tripped it would have cleared this report and left the next comment that
// names a Portfolio path live, so the comment BODIES are removed from the text
// before it is scanned, for every file, in both languages this check reads.
//
// NAMED LIMITATIONS, none of which trade a false alarm for silence:
//   * String bodies are still scanned. A require() quoted inside a string
//     literal is still reported -- that is why the fixture roots are scanned
//     only on request, and tests/unified-agent-p04-boundaries.js depends on it.
//   * Removal is lexical, not a parse. Text inside a template-literal
//     interpolation is treated as string body, so a comment written there is
//     still scanned.
//   * An unterminated string or block comment blanks to end of file, the same
//     way a compiler would read it.
//
// COST. This runs over every tracked source file, so it walks the text once and
// only ever SLICES it -- an earlier character-at-a-time version of exactly this
// logic took 7.4s over 13MB and would have been deleted by whoever next found
// the check slow. Strings and regular-expression literals are stepped over
// rather than rebuilt, and only the comment spans are replaced.
const PYTHON_EXTENSIONS = new Set(['.py']);
const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$.])(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/;
const REGEX_MAY_START_AFTER = '([{,;:=!&|?+-*%^~<>';

// `/` opens a regular expression here, or divides there, and the difference
// decides whether a `//` further along the line is a comment. Judged from the
// previous significant character, the standard heuristic; a bounded window is
// read backwards so this stays O(1) per slash.
function regexLiteralAllowed(source, slashIndex) {
  let index = slashIndex - 1;
  while (index >= 0 && (source[index] === ' ' || source[index] === '\t' || source[index] === '\n' || source[index] === '\r')) index -= 1;
  if (index < 0) return true;
  if (REGEX_MAY_START_AFTER.includes(source[index])) return true;
  return KEYWORD_BEFORE_REGEX.test(source.slice(Math.max(0, index - 23), index + 1));
}

function skipQuoted(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') { index += 2; continue; }
    index += 1;
    if (char === quote) break;
  }
  return index;
}

// A regular-expression literal is stepped over verbatim so that `/[//]/` cannot
// blank the rest of its line and hide a real import behind it.
function skipRegexLiteral(source, start) {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') { index += 2; continue; }
    index += 1;
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '\n') break;
    else if (char === '/' && !inClass) break;
  }
  return index;
}

// Comment characters become spaces and newlines are kept, so every surviving
// specifier stays on its original line -- the `^\s*(?:from|import)` pattern
// below is line-anchored and would otherwise start matching text that was never
// at the start of a line.
function blankJsComments(source) {
  const parts = [];
  let mark = 0;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') { index = skipQuoted(source, index); continue; }
    if (char !== '/') { index += 1; continue; }
    const next = source[index + 1];
    if (next !== '/' && next !== '*') {
      index = regexLiteralAllowed(source, index) ? skipRegexLiteral(source, index) : index + 1;
      continue;
    }
    const start = index;
    if (next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
    } else {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index = Math.min(source.length, index + 2);
    }
    parts.push(source.slice(mark, start), source.slice(start, index).replace(/[^\n]/g, ' '));
    mark = index;
  }
  parts.push(source.slice(mark));
  return parts.join('');
}

function skipPythonQuoted(source, start) {
  const opening = source.slice(start, start + 3);
  const delimiter = opening === '"""' || opening === "'''" ? opening : source[start];
  let index = start + delimiter.length;
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue; }
    if (source.startsWith(delimiter, index)) return index + delimiter.length;
    if (delimiter.length === 1 && source[index] === '\n') return index;
    index += 1;
  }
  return index;
}

function blankPythonComments(source) {
  const parts = [];
  let mark = 0;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") { index = skipPythonQuoted(source, index); continue; }
    if (char !== '#') { index += 1; continue; }
    const start = index;
    while (index < source.length && source[index] !== '\n') index += 1;
    parts.push(source.slice(mark, start), ' '.repeat(index - start));
    mark = index;
  }
  parts.push(source.slice(mark));
  return parts.join('');
}

function stripComments(content, filename = '') {
  return PYTHON_EXTENSIONS.has(path.extname(filename).toLowerCase())
    ? blankPythonComments(content)
    : blankJsComments(content);
}

function specifiers(content, filename = '') {
  const code = stripComments(content, filename);
  const patterns = [
    /\brequire\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
    /\bimport\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
    /\b(?:import|export)\s+(?:[^'\"]*?\s+from\s+)?['\"]([^'\"]+)['\"]/g,
    /^\s*(?:from|import)\s+([A-Za-z0-9_./-]+)/gm
  ];
  return patterns
    .flatMap(pattern => Array.from(code.matchAll(pattern), match => match[1]))
    // A module specifier never spans a line break. This is a second, independent
    // reading of the same evidence the report above carried: the finding named
    // its own falseness in the specifier it printed.
    .filter(specifier => !/[\r\n]/.test(specifier));
}

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', '__pycache__'].includes(entry.name)) visit(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) output.push(full);
    }
  };
  visit(root);
  return output.sort();
}

function matchesPattern(value, patterns) {
  const normalized = value.replace(/\\/g, '/').toLowerCase();
  return patterns.some(pattern => normalized.includes(String(pattern).replace(/\\/g, '/').toLowerCase()));
}

function isExternalPortfolioPath(specifier, filename, root) {
  if (!specifier.startsWith('.')) return matchesPattern(specifier, ['portfolio dashboard', 'portfolio-dashboard']);
  const resolved = path.resolve(path.dirname(filename), specifier);
  return !within(root, resolved) && matchesPattern(resolved, ['portfolio dashboard', 'portfolio-dashboard']);
}

function checkSourceRoot({ root, relativeRoot, direction, patterns }) {
  const files = filesUnder(path.join(root, relativeRoot));
  const violations = [];
  for (const filename of files) {
    const content = fs.readFileSync(filename, 'utf8');
    for (const specifier of specifiers(content, filename)) {
      const forbidden = direction === 'toolsenabled-global'
        ? isExternalPortfolioPath(specifier, filename, root) || matchesPattern(specifier, patterns)
        : matchesPattern(specifier, patterns);
      if (forbidden) violations.push({
        file: path.relative(root, filename).replace(/\\/g, '/'),
        specifier,
        direction,
        rule: direction === 'toolsenabled-global'
          ? 'ToolsEnabled global code must not import Portfolio UI, persona, or application code.'
          : 'Portfolio code must use the typed ToolsEnabled boundary, not internal runtime paths.'
      });
    }
  }
  // scannedFiles rides along so the caller can refuse a vacuous pass: a
  // declared root that scans zero files proves nothing, and "zero violations"
  // from it would be a reassuring silence rather than a check.
  return { violations, scannedFiles: files.length };
}

function applicationImportViolations(generated) {
  const forbidden = ['portfolio dashboard', 'portfolio-dashboard', 'src/lib/', 'sidecars/'];
  const violations = [];
  for (const [filename, content] of generated) {
    if (specifiers(content, filename).some(specifier => matchesPattern(specifier, forbidden))) {
      violations.push({ file: path.relative(ROOT, filename).replace(/\\/g, '/'), rule: 'Generated ownership contracts must not import an application runtime.' });
    }
  }
  return violations;
}

function verifyBoundary(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const map = options.map || readMap(options.mapPath || OWNERSHIP_MAP);
  const config = map.boundaryCheck;
  const violations = [];
  // Fail closed on a vacuous scan (same rule tools/package-check.js states by
  // name): a declared root that is missing or yields zero source files makes
  // the scan prove nothing, so it is reported as indeterminate and fails the
  // check rather than passing it. A renamed src/ must not read as "no
  // violations found".
  const indeterminate = [];
  const scan = target => {
    const { violations: found, scannedFiles } = checkSourceRoot(target);
    if (scannedFiles === 0) {
      indeterminate.push({
        root: target.relativeRoot,
        direction: target.direction,
        reason: 'The declared root scanned zero source files (missing or empty); nothing was actually checked.'
      });
    }
    violations.push(...found);
  };
  for (const sourceRoot of config.productionRoots) {
    scan({ root, relativeRoot: sourceRoot, direction: 'toolsenabled-global', patterns: config.toolsenabledForbiddenSpecifierPatterns });
  }
  if (options.includeFixtures === true) {
    for (const fixtureRoot of config.fixtureRoots) {
      scan({ root, relativeRoot: fixtureRoot, direction: 'toolsenabled-global', patterns: config.toolsenabledForbiddenSpecifierPatterns });
    }
  }
  if (options.portfolioRoot) {
    scan({ root: path.resolve(options.portfolioRoot), relativeRoot: options.portfolioSourceRoot || 'app', direction: 'portfolio-to-toolsenabled', patterns: config.portfolioForbiddenSpecifierPatterns });
  }
  const generated = generate({ check: true });
  violations.push(...applicationImportViolations(generated));
  return {
    valid: violations.length === 0 && indeterminate.length === 0,
    violations,
    indeterminate,
    contractVersion: map.contractVersion
  };
}

if (require.main === module) {
  const portfolioIndexes = process.argv.flatMap((argument, index) => argument === '--portfolio-root' ? [index] : []);
  const portfolioArgument = portfolioIndexes.length === 1 ? process.argv[portfolioIndexes[0] + 1] : undefined;
  if (portfolioIndexes.length > 1 || (portfolioIndexes.length === 1 && (!portfolioArgument || portfolioArgument.startsWith('--')))) {
    process.stderr.write('--portfolio-root must be specified exactly once with a path.\n');
    process.exitCode = 1;
  } else {
    const result = verifyBoundary({
      includeFixtures: process.argv.includes('--include-fixtures'),
      portfolioRoot: portfolioIndexes.length === 1 ? portfolioArgument : undefined
    });
    if (!result.valid) {
      process.stderr.write(`${JSON.stringify({ violations: result.violations, indeterminate: result.indeterminate }, null, 2)}\n`);
      process.exitCode = 1;
    } else process.stdout.write(`Cross-repository boundary check passed (${result.contractVersion}).\n`);
  }
}

module.exports = { applicationImportViolations, checkSourceRoot, readMap, specifiers, stripComments, verifyBoundary };
