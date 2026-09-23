#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD_BEGIN = 'BEGIN DEFECT-CLASS GUARDS v1';
const GUARD_END = 'END DEFECT-CLASS GUARDS v1';

function usage() {
  return [
    'Usage: node check-corpus.mjs [--consumer <cloud-batch-plan.js>] [--guards <GUARDS.md>] <corpus-dir> [corpus-dir ...]',
    '',
    'Exit 0: every brief passes. Exit 1: one or more named brief/collision violations.',
    'Exit 2: setup/usage failure, including a directory with no top-level brief files.',
    '',
    'Human prefix shape (an explicit form is shown; MAY TOUCH/Write only fence sections are also recognized):',
    '  ROLE: <agent-contract role> ...',
    '  FENCE:',
    '  - repo/relative/file.ext',
    '  - REPORT-name.md',
    '  END FENCE',
    '  <a checkable DONE definition; the required raw done field may carry it>',
    '  <a root .md report filename; it must also be in the write fence>',
    '  <the exact GUARDS.md block>',
    '  CONTRACT/1',
    '  role ... / target ... / do ... / because ... / done ... / report ...',
  ].join('\n');
}

function parseArgs(argv) {
  const result = { consumer: null, guards: path.join(HERE, 'GUARDS.md'), dirs: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--consumer' || arg === '--guards') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new Error(`${arg} needs a path`);
      }
      result[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      result.dirs.push(arg);
    }
  }
  return result;
}

function ancestors(start) {
  const found = [];
  let current = path.resolve(start);
  for (;;) {
    found.push(current);
    const parent = path.dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}

function resolveConsumer(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(path.resolve(explicitPath));
  if (!explicitPath && process.env.CLOUD_BATCH_PLAN_JS) {
    candidates.push(path.resolve(process.env.CLOUD_BATCH_PLAN_JS));
  }
  if (!explicitPath) {
    for (const root of new Set([...ancestors(HERE), ...ancestors(process.cwd())])) {
      candidates.push(path.join(root, 'engine', 'tools', 'cloud-batch-plan.js'));
      candidates.push(path.join(root, 'tools', 'cloud-batch-plan.js'));
    }
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, 'Desktop', 'toolsenabled', 'engine', 'tools', 'cloud-batch-plan.js'));
      candidates.push(path.join(process.env.USERPROFILE, 'Desktop', 'toolsenabled-current', 'engine', 'tools', 'cloud-batch-plan.js'));
    }
  }
  const selected = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (selected) return selected;
  if (explicitPath) throw new Error(`consumer is not a readable file: ${path.resolve(explicitPath)}`);
  throw new Error('cloud-batch-plan.js was not found; pass --consumer <path> or set CLOUD_BATCH_PLAN_JS');
}

function loadConsumer(sourcePath) {
  const require = createRequire(import.meta.url);
  const toolsDir = path.dirname(sourcePath);
  const planner = require(sourcePath);
  const agentContract = require(path.join(toolsDir, 'agent-contract.js'));
  const dispatcher = require(path.resolve(toolsDir, '..', 'src', 'lib', 'cloud-agent', 'codex-dispatcher.js'));
  const required = [
    ['planner.CORPUS_NAME', planner.CORPUS_NAME instanceof RegExp],
    ['planner.CORPUS_SUFFIX', typeof planner.CORPUS_SUFFIX === 'string'],
    ['planner.normalizeContract', typeof planner.normalizeContract === 'function'],
    ['planner.collisionKey', typeof planner.collisionKey === 'function'],
    ['agentContract.parse', typeof agentContract.parse === 'function'],
    ['agentContract.validate', typeof agentContract.validate === 'function'],
    ['agentContract.ROLES', Array.isArray(agentContract.ROLES)],
    ['dispatcher.MAX_PROMPT_CHARS', Number.isInteger(dispatcher.MAX_PROMPT_CHARS)],
  ];
  const missing = required.filter(([, present]) => !present).map(([name]) => name);
  if (missing.length) throw new Error(`consumer exports are incomplete: ${missing.join(', ')}`);
  return { planner, agentContract, dispatcher };
}

function guardBlockFrom(file, normalize) {
  let raw;
  try { raw = fs.readFileSync(path.resolve(file), 'utf8'); }
  catch (error) { throw new Error(`cannot read guards file ${path.resolve(file)}: ${error.message}`); }
  const normalized = normalize(raw);
  const lines = normalized.split('\n');
  const begins = lines.flatMap((line, index) => line === GUARD_BEGIN ? [index] : []);
  const ends = lines.flatMap((line, index) => line === GUARD_END ? [index] : []);
  if (begins.length !== 1 || ends.length !== 1 || ends[0] <= begins[0]) {
    throw new Error(`guards file must contain one ordered ${GUARD_BEGIN} / ${GUARD_END} pair`);
  }
  return lines.slice(begins[0], ends[0] + 1).join('\n');
}

function occurrenceCount(text, needle) {
  let count = 0;
  let from = 0;
  while ((from = text.indexOf(needle, from)) !== -1) {
    count += 1;
    from += needle.length;
  }
  return count;
}

function codepointOrder(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function pathFinding(raw) {
  let value = String(raw).trim();
  if (value.startsWith('`') && value.endsWith('`') && value.length > 2) value = value.slice(1, -1);
  if (!value) return { ok: false, reason: 'path is empty' };
  if (/[*?\[\]{}]/.test(value)) return { ok: false, reason: 'globs are not concrete target files' };
  if (/^[A-Za-z]:/.test(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    return { ok: false, reason: 'path must be repository-relative, not absolute' };
  }
  if (/[<>:"|\0]/.test(value)) return { ok: false, reason: 'path contains a character invalid in a Windows-run suite' };
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    return { ok: false, reason: 'path has an empty, dot, or parent-traversal segment' };
  }
  return { ok: true, value: normalized, key: normalized.toLowerCase() };
}

function scopePathProblem(raw) {
  const value = String(raw || '').trim();
  if (!value) return 'target is empty';
  if (/^[A-Za-z]:/.test(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    return 'target must be repository-relative';
  }
  if (/[<>:"|\0]/.test(value)) return 'target contains a character invalid in a Windows-run suite';
  const normalized = value.replace(/\\/g, '/');
  const withoutTrailingSeparator = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const parts = withoutTrailingSeparator.split('/');
  if (parts.some((part) => !part || part === '.')) return 'target has an empty or dot path segment';
  if (parts.includes('..')) return 'target may not traverse above the repository root';
  return null;
}

function parseFence(prefixLines) {
  const starts = prefixLines.flatMap((line, index) => line.trim() === 'FENCE:' ? [index] : []);
  const ends = prefixLines.flatMap((line, index) => line.trim() === 'END FENCE' ? [index] : []);
  const issues = [];
  const paths = [];
  const addPath = (raw) => {
    const finding = pathFinding(raw);
    if (!finding.ok) issues.push(['FENCE_PATH', `${raw}: ${finding.reason}`]);
    else paths.push(finding);
  };
  if (starts.length === 1 && ends.length === 1 && ends[0] > starts[0]) {
    const body = prefixLines.slice(starts[0] + 1, ends[0]);
    if (body.length === 0) issues.push(['FENCE_EMPTY', 'fence names no target file']);
    for (const line of body) {
      const match = /^\s*-\s+(.+?)\s*$/.exec(line);
      if (!match) {
        issues.push(['FENCE_ENTRY', `fence line must be "- repo/relative/file": ${line.trim() || '<blank>'}`]);
        continue;
      }
      addPath(match[1]);
    }
  } else {
    const header = prefixLines.findIndex((line) => {
      const trimmed = line.trim();
      return /\bfence\b/i.test(trimmed)
        && !/^STANDING FENCES?:/i.test(trimmed)
        && (/^#{1,6}\s+/.test(trimmed) || /FENCE:\s*$/i.test(trimmed));
    });
    if (header === -1) {
      issues.push(['FENCE_SECTION', 'no write/task fence section appears before CONTRACT/1']);
      return { issues, paths };
    }
    const allow = prefixLines.findIndex((line, index) => index > header
      && /^(?:MAY TOUCH(?: exactly)?:|Write only:|Normally edit only\b|You may (?:edit|create|edit or create) only\b)/i.test(line.trim()));
    if (allow === -1) {
      issues.push(['FENCE_SECTION', 'fence has no MAY TOUCH / Write only / You may edit only declaration']);
      return { issues, paths };
    }
    const backticked = (line) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1])
      .filter((token) => /[\\/]/.test(token) || /\.[A-Za-z0-9]/.test(token));
    const allowText = prefixLines[allow].split(/\b(?:Do not|Everything else|MUST NOT|Read[- ]only)\b/i, 1)[0];
    for (const token of backticked(allowText)) addPath(token);
    for (let index = allow + 1; index < prefixLines.length; index += 1) {
      const line = prefixLines[index];
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^(?:#{1,6}\s+|MUST NOT|Do not|Everything else|Read[- ]only|STANDING FENCES?:|CONTRACT\/1)/i.test(trimmed)) break;
      const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
      if (!bullet) {
        if (paths.length) break;
        continue;
      }
      const tokens = backticked(bullet[1]);
      if (tokens.length) addPath(tokens[0]);
      else addPath(bullet[1].split(/\s+(?:—|-|\()/, 1)[0]);
    }
  }
  const seen = new Set();
  for (const item of paths) {
    if (seen.has(item.key)) issues.push(['FENCE_DUPLICATE', `fence repeats ${item.value}`]);
    seen.add(item.key);
  }
  if (paths.length === 0 && !issues.some(([code]) => code === 'FENCE_EMPTY')) {
    issues.push(['FENCE_EMPTY', 'fence names no valid concrete target file']);
  }
  return { issues, paths };
}

function addIssue(brief, code, message) {
  if (!brief.issues.some((issue) => issue.code === code && issue.message === message)) {
    brief.issues.push({ code, message });
  }
}

function checkBrief({ dir, entry, guardBlock, consumer }) {
  const { planner, agentContract, dispatcher } = consumer;
  const label = `${path.basename(dir)}/${entry.name}`;
  const brief = {
    label, name: entry.name, dir, issues: [], repo: null, fields: {},
    fencePaths: [], coreAdmissible: false,
  };

  const nameMatch = planner.CORPUS_NAME.exec(entry.name);
  if (!entry.name.toLowerCase().endsWith(planner.CORPUS_SUFFIX)) {
    addIssue(brief, 'CORPUS_SUFFIX', `consumer ignores this file because its name does not end ${planner.CORPUS_SUFFIX}`);
  }
  if (!nameMatch) addIssue(brief, 'NAME_SHAPE', 'filename must be <repo>__<nonempty-name>.contract');
  else brief.repo = nameMatch[1].toLowerCase();

  if (!entry.isFile()) {
    addIssue(brief, 'BRIEF_UNREADABLE', 'selected .contract entry is not a regular file');
    return brief;
  }

  let text;
  try { text = planner.normalizeContract(fs.readFileSync(path.join(dir, entry.name), 'utf8')); }
  catch (error) {
    addIssue(brief, 'BRIEF_UNREADABLE', error.message);
    return brief;
  }
  brief.text = text;
  const lines = text.split('\n');
  if (!brief.repo && entry.name.toLowerCase().endsWith('.contract.md')) {
    const stagedMatch = planner.CORPUS_NAME.exec(entry.name.slice(0, -3));
    if (stagedMatch) brief.repo = stagedMatch[1].toLowerCase();
  }
  if (!brief.repo) {
    const repositoryHint = /repository\s+["'](?:[^"'/]+[\\/])*([^"'/]+)["']/i.exec(lines[0] || '');
    if (repositoryHint) brief.repo = repositoryHint[1].toLowerCase();
  }
  const contractIndex = lines.findIndex((line) => line.trim() === 'CONTRACT/1');
  const prefixLines = contractIndex === -1 ? lines : lines.slice(0, contractIndex);

  const roleMatch = /^ROLE:\s+(\S+)/.exec(lines[0] || '');
  if (!roleMatch) addIssue(brief, 'ROLE_LINE', 'line 1 must begin ROLE: and name a role');

  if (contractIndex === -1) addIssue(brief, 'CONTRACT_HEADER', 'missing CONTRACT/1 section');
  else if (contractIndex === 0) addIssue(brief, 'CONTRACT_ORDER', 'human prefix must precede the trailing CONTRACT/1 section');

  const parsed = agentContract.parse(text);
  brief.fields = parsed.fields;
  for (const problem of [...parsed.errors, ...agentContract.validate(parsed.fields)]) {
    addIssue(brief, 'BRIEF_INVALID', problem);
  }
  if (text.length > dispatcher.MAX_PROMPT_CHARS) {
    addIssue(brief, 'PROMPT_TOO_LONG', `${text.length} characters exceeds the consumer ceiling of ${dispatcher.MAX_PROMPT_CHARS}`);
  }

  const rawReport = parsed.fields.report;
  if (rawReport && !/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(rawReport)) {
    addIssue(brief, 'REPORT_FILENAME', 'raw report must be a repository-root .md basename');
  }

  const guardCount = occurrenceCount(text, guardBlock);
  if (guardCount !== 1) addIssue(brief, 'GUARD_PREAMBLE', `expected one exact canonical guard block, found ${guardCount}`);
  else if (contractIndex !== -1 && !prefixLines.join('\n').includes(guardBlock)) {
    addIssue(brief, 'GUARD_ORDER', 'canonical guard block must precede CONTRACT/1');
  }

  const fence = parseFence(prefixLines);
  for (const [code, message] of fence.issues) addIssue(brief, code, message);
  brief.fencePaths = fence.paths;
  if (rawReport && !fence.paths.some((item) => item.key === rawReport.toLowerCase())) {
    addIssue(brief, 'REPORT_OUTSIDE_FENCE', `fence must include required report ${rawReport}`);
  }
  if (parsed.fields.target) {
    const scopeProblem = scopePathProblem(parsed.fields.target);
    if (scopeProblem) addIssue(brief, 'TARGET_PATH', scopeProblem);
    const concreteTarget = pathFinding(parsed.fields.target);
    if (concreteTarget.ok && !fence.paths.some((item) => item.key === concreteTarget.key)) {
      addIssue(brief, 'TARGET_OUTSIDE_FENCE', `concrete raw target ${parsed.fields.target} is absent from the fence`);
    }
  }

  brief.coreAdmissible = Boolean(nameMatch)
    && parsed.errors.length === 0
    && agentContract.validate(parsed.fields).length === 0
    && text.length <= dispatcher.MAX_PROMPT_CHARS;
  return brief;
}

function addCollisions(briefs, consumer) {
  const targetClaims = new Map();
  const fenceClaims = new Map();
  for (const brief of briefs) {
    const scope = brief.repo || `@dir:${brief.dir.toLowerCase()}`;
    if (brief.coreAdmissible) {
      const key = `${scope}\0${consumer.planner.collisionKey(brief.fields.target)}`;
      if (!targetClaims.has(key)) targetClaims.set(key, []);
      targetClaims.get(key).push(brief);
    }
    const withinBrief = new Set();
    for (const item of brief.fencePaths) {
      const key = `${scope}\0${item.key}`;
      if (withinBrief.has(key)) continue;
      withinBrief.add(key);
      if (!fenceClaims.has(key)) fenceClaims.set(key, []);
      fenceClaims.get(key).push(brief);
    }
  }
  const mark = (claims, code, noun) => {
    for (const [key, group] of claims) {
      const unique = [...new Map(group.map((brief) => [brief.label, brief])).values()];
      if (unique.length < 2) continue;
      const claimedPath = key.slice(key.indexOf('\0') + 1);
      for (const brief of unique) {
        const others = unique.filter((other) => other !== brief).map((other) => other.label).join(', ');
        addIssue(brief, code, `${noun} ${claimedPath} collides with ${others}`);
      }
    }
  };
  mark(targetClaims, 'TARGET_COLLISION', 'raw target');
  mark(fenceClaims, 'FENCE_COLLISION', 'fenced file');
}

function readCorpus(dirArg, suffix) {
  const dir = path.resolve(dirArg);
  let stat;
  try { stat = fs.statSync(dir); }
  catch (error) { return { dir, setup: `cannot inspect corpus: ${error.message}`, entries: [] }; }
  if (!stat.isDirectory()) return { dir, setup: 'corpus path is not a directory', entries: [] };
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { return { dir, setup: `cannot read corpus directory: ${error.message}`, entries: [] }; }
  /* INDEX.md is a workflow readiness marker, not a consumer brief. It also
   * gives the checker a safe way to name intended drafts whose suffix is wrong:
   * treating every README/support file as a brief would invent false failures,
   * while considering only `.contract` would silently lose `.contract.md`.
   * A first-line ROLE file is independently self-identifying. */
  const indexEntry = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'index.md');
  const indexedNames = new Set();
  if (indexEntry) {
    let indexText;
    try { indexText = fs.readFileSync(path.join(dir, indexEntry.name), 'utf8'); }
    catch (error) { return { dir, setup: `cannot read INDEX.md: ${error.message}`, entries: [] }; }
    const capture = (regex) => {
      for (const match of indexText.matchAll(regex)) {
        const token = match[1].replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
        indexedNames.add(path.basename(token.replace(/\\/g, '/')));
      }
    };
    capture(/`([^`\r\n]+)`/g);
    capture(/\]\(([^)\r\n]+)\)/g);
    capture(/\b([A-Za-z0-9][A-Za-z0-9._-]*\.(?:contract(?:\.md)?|md))\b/gi);
  }
  const beginsWithRole = (entry) => {
    if (!entry.isFile()) return false;
    try {
      const raw = fs.readFileSync(path.join(dir, entry.name), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      return /^ROLE:\s/.test(raw.split('\n', 1)[0]);
    } catch { return false; }
  };
  const contracts = entries
    .filter((entry) => entry.name.toLowerCase() !== 'index.md')
    .filter((entry) => entry.name.toLowerCase().endsWith(suffix)
      || indexedNames.has(entry.name)
      || beginsWithRole(entry))
    .sort((a, b) => codepointOrder(a.name, b.name));
  if (contracts.length === 0) {
    return { dir, setup: `no top-level brief files (INDEX.md and nested files do not count)`, entries: [] };
  }
  return { dir, setup: null, entries: contracts };
}

async function main(argv) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) {
    console.error(`SETUP FAILURE: ${error.message}`);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.dirs.length === 0) {
    console.error('SETUP FAILURE: name at least one corpus directory');
    console.error(usage());
    return 2;
  }

  let sourcePath;
  let consumer;
  let guardBlock;
  try {
    sourcePath = resolveConsumer(options.consumer);
    consumer = loadConsumer(sourcePath);
    guardBlock = guardBlockFrom(options.guards, consumer.planner.normalizeContract);
  } catch (error) {
    console.error(`SETUP FAILURE: ${error.message}`);
    return 2;
  }

  const corpora = options.dirs.map((dir) => readCorpus(dir, consumer.planner.CORPUS_SUFFIX));
  const setupFailures = corpora.filter((corpus) => corpus.setup);
  const briefsByDir = new Map();
  const briefs = [];
  for (const corpus of corpora.filter((item) => !item.setup)) {
    const checked = corpus.entries.map((entry) => checkBrief({
      dir: corpus.dir, entry, guardBlock, consumer,
    }));
    briefsByDir.set(corpus.dir, checked);
    briefs.push(...checked);
  }
  addCollisions(briefs, consumer);

  console.log(`CONSUMER ${sourcePath}`);
  for (const corpus of corpora) {
    console.log(`CORPUS ${corpus.dir}`);
    if (corpus.setup) {
      console.error(`SETUP ${path.basename(corpus.dir)}: ${corpus.setup}`);
      continue;
    }
    for (const brief of briefsByDir.get(corpus.dir)) {
      if (brief.issues.length === 0) {
        console.log(`PASS ${brief.label}`);
      } else {
        console.error(`FAIL ${brief.label}`);
        for (const issue of brief.issues) console.error(`  [${issue.code}] ${issue.message}`);
      }
    }
    const checked = briefsByDir.get(corpus.dir);
    console.log(`SUMMARY ${path.basename(corpus.dir)}: ${checked.length} brief(s), ${checked.filter((brief) => brief.issues.length === 0).length} pass, ${checked.filter((brief) => brief.issues.length > 0).length} fail`);
  }
  const failed = briefs.filter((brief) => brief.issues.length > 0).length;
  console.log(`OVERALL: ${briefs.length} brief(s), ${briefs.length - failed} pass, ${failed} fail, ${setupFailures.length} setup failure(s)`);
  if (setupFailures.length) return 2;
  return failed ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(`SETUP FAILURE: checker crashed: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 2;
  },
);
