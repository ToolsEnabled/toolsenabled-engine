#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { invokedDirectly } from './invoked-directly.mjs';

const TOOLCHAIN = 'node|npm|npx|yarn|pnpm|git|python|py|pwsh|powershell|code|cmd';

function context(buffer, start, length) {
  return buffer.subarray(Math.max(0, start - 40), Math.min(buffer.length, start + length + 40))
    .toString('utf8').replace(/[\r\n\t]+/g, ' ');
}

function finding(buffer, file, byteOffset, matchedText, category, severity, confidence) {
  return { category, severity, confidence, file, byteOffset, matchedText, context: context(buffer, byteOffset, Buffer.byteLength(matchedText)) };
}

function textMatches(buffer, file) {
  const text = buffer.toString('utf8');
  const out = [];
  const code = codePositions(text);
  const addRegex = (regex, category, severity, confidence, group = 0, codeOnly = false) => {
    for (const match of text.matchAll(regex)) {
      if (codeOnly && !code[match.index]) continue;
      const value = match[group];
      const characterIndex = match.index + match[0].indexOf(value);
      const offset = Buffer.byteLength(text.slice(0, characterIndex));
      out.push(finding(buffer, file, offset, value, category, severity, confidence));
    }
  };

  // A literal first argument at a child_process-style call is strong static evidence.
  addRegex(/\b(?:spawn|exec|execFile|spawnSync|execSync|fork)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/g, 'A', 'FAIL', 'definitely a command', 2, true);
  // Also catch command-shaped literals used as argv/command properties, without
  // pretending arbitrary prose containing (for example) "node" is executable.
  addRegex(new RegExp(`(?:\\bcommand\\s*:\\s*|\\b(?:spawn|exec|execFile|spawnSync|execSync|fork)\\s*\\(\\s*)['"](${TOOLCHAIN})(?:\\.exe)?['"]`, 'gi'), 'A', 'FAIL', 'definitely a command', 1, true);
  addRegex(/(?:[A-Za-z]:\\(?:[^\0\r\n"']+)|\/(?:Users|home)\/[^\0\r\n"']+|\\\\[^\\\s"']+\\[^\0\r\n"']+)/g, 'B', 'FAIL', 'high');
  addRegex(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+(?:\/[^\s"']*)?/gi, 'C', 'FAIL', 'high');
  addRegex(/\b(?:localhost|127\.0\.0\.1):\d+\b|\bvite\b|webpack-dev-server|(?:hot|hmr)[-_/]reload/gi, 'C', 'WARN', 'mention');
  addRegex(/(?:process\.env\.|\b(?:getenv|env)\s*\(\s*['"])(NODE_ENV|ELECTRON_[A-Z0-9_]*|VITE_[A-Z0-9_]*)/g, 'D', 'INFO', 'informational', 1);
  return out;
}

// Marks positions outside JavaScript-style comments. This is intentionally a
// small lexer rather than a substring heuristic: quoted comment markers remain
// code, while command-shaped examples in comments cannot create FAIL findings.
function codePositions(text) {
  const result = new Uint8Array(text.length); result.fill(1);
  let state = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (state === 'line') { result[i] = 0; if (c === '\n') state = 'code'; continue; }
    if (state === 'block') { result[i] = 0; if (c === '*' && next === '/') { result[++i] = 0; state = 'code'; } continue; }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (c === '\\') { i++; continue; }
      if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) state = 'code';
      continue;
    }
    if (c === '/' && next === '/') { result[i] = result[i + 1] = 0; i++; state = 'line'; }
    else if (c === '/' && next === '*') { result[i] = result[i + 1] = 0; i++; state = 'block'; }
    else if (c === "'") state = 'single'; else if (c === '"') state = 'double'; else if (c === '`') state = 'template';
  }
  return result;
}

function sniff(buffer) {
  if (buffer.length === 0) return { text: true };
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return { text: false, reason: 'NUL byte detected' };
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  if (suspicious / sample.length > 0.02) return { text: false, reason: 'control-byte ratio exceeds 2%' };
  return { text: true };
}

export function parseAsar(buffer, label) {
  // asar's header is FOUR uint32 words, not three:
  //   [0]=4 (size of the size-pickle) [4]=headerPickleSize [8]=headerPayloadSize [12]=jsonLength
  // JSON begins at byte 16 and the data section at 8 + headerPickleSize. Verified against a
  // real electron-builder app.asar (jsonLen=11799, payload=11804, pickle=11808, data=11816).
  if (buffer.length < 16) throw new Error(`${label}: corrupt asar: shorter than 16-byte header`);
  const sizePickle = buffer.readUInt32LE(0);
  const headerPickleSize = buffer.readUInt32LE(4);
  const headerPayloadSize = buffer.readUInt32LE(8);
  const stringLength = buffer.readUInt32LE(12);
  if (sizePickle !== 4)
    throw new Error(`${label}: corrupt asar: leading pickle size is ${sizePickle}, expected 4`);
  if (!headerPickleSize || !headerPayloadSize || !stringLength || 16 + stringLength > buffer.length)
    throw new Error(`${label}: corrupt asar: invalid pickle lengths`);
  if (headerPayloadSize < stringLength + 4 || headerPickleSize < headerPayloadSize + 4)
    throw new Error(`${label}: corrupt asar: inconsistent pickle lengths`);
  let raw = buffer.subarray(16, 16 + stringLength).toString('utf8').replace(/\0+$/, '');
  let tree;
  try { tree = JSON.parse(raw); } catch (error) { throw new Error(`${label}: corrupt asar JSON: ${error.message}`); }
  if (!tree?.files || typeof tree.files !== 'object') throw new Error(`${label}: corrupt asar: missing files tree`);
  const dataStart = 8 + headerPickleSize;
  if (dataStart > buffer.length) throw new Error(`${label}: corrupt asar: data section is outside file`);
  const entries = [];
  const walk = (files, prefix = '') => {
    for (const [name, entry] of Object.entries(files)) {
      const namePath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry.files, namePath);
      else if (entry.unpacked) entries.push({ path: namePath, skipped: 'unpacked entry (stored outside app.asar)' });
      else {
        const size = Number(entry.size);
        const offset = Number(entry.offset);
        if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset) || offset < 0 || dataStart + offset + size > buffer.length)
          throw new Error(`${label}: corrupt asar entry ${namePath}: invalid offset/size`);
        entries.push({ path: namePath, buffer: buffer.subarray(dataStart + offset, dataStart + offset + size) });
      }
    }
  };
  walk(tree.files);
  return entries;
}

async function filesBelow(root) {
  const result = [];
  const walk = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) result.push(full);
      else result.push({ path: full, skip: `non-regular filesystem entry (${entry.isSymbolicLink() ? 'symbolic link' : 'other'})` });
    }
  };
  await walk(root);
  return result;
}

export async function audit(root) {
  const absolute = path.resolve(root);
  const stat = await fs.stat(absolute);
  if (!stat.isDirectory()) throw new Error(`--dir is not a directory: ${absolute}`);
  const findings = [], skips = [], scanned = [];
  for (const item of await filesBelow(absolute)) {
    if (typeof item !== 'string') { skips.push({ file: path.relative(absolute, item.path), reason: item.skip }); continue; }
    const relative = path.relative(absolute, item).split(path.sep).join('/');
    let buffer;
    try { buffer = await fs.readFile(item); } catch (error) { skips.push({ file: relative, reason: `read error: ${error.message}` }); continue; }
    if (relative.toLowerCase() === 'resources/app.asar') {
      const entries = parseAsar(buffer, relative); // Parse errors deliberately fail the whole audit.
      for (const entry of entries) {
        const label = `${relative}::${entry.path}`;
        if (entry.skipped) { skips.push({ file: label, reason: entry.skipped }); continue; }
        const kind = sniff(entry.buffer);
        if (!kind.text) { skips.push({ file: label, reason: kind.reason }); continue; }
        scanned.push(label); findings.push(...textMatches(entry.buffer, label));
      }
      continue;
    }
    const kind = sniff(buffer);
    if (!kind.text) { skips.push({ file: relative, reason: kind.reason }); continue; }
    scanned.push(relative); findings.push(...textMatches(buffer, relative));
  }
  // An audit that measured no files has no evidence for a passing verdict. Keep
  // skips visible (rather than silently counting them as scans), and fail closed
  // when the enumerated input is empty or contains nothing readable as text.
  const hasFailFinding = findings.some(x => x.severity === 'FAIL');
  return { ok: scanned.length > 0 && !hasFailFinding, root: absolute, counts: { scanned: scanned.length, skipped: skips.length, findings: findings.length, fail: findings.filter(x => x.severity === 'FAIL').length, warn: findings.filter(x => x.severity === 'WARN').length, info: findings.filter(x => x.severity === 'INFO').length }, scanned, skips, findings };
}

function args(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' || argv[i] === '--json') {
      if (!argv[i + 1]) throw new Error(`${argv[i]} requires a value`);
      parsed[argv[i].slice(2)] = argv[++i];
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!parsed.dir) throw new Error('usage: toolchain-independence-audit.mjs --dir <win-unpacked path> [--json <outfile>]');
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = args(argv);
    const report = await audit(options.dir);
    const json = JSON.stringify(report, null, 2);
    if (options.json) await fs.writeFile(options.json, `${json}\n`, 'utf8');
    console.log('---BEGIN TOOLCHAIN INDEPENDENCE JSON---'); console.log(json); console.log('---END TOOLCHAIN INDEPENDENCE JSON---');
    console.log(`${report.ok ? 'PASS' : 'FAIL'}: ${report.counts.scanned} text files scanned; ${report.counts.skipped} skipped; ${report.counts.fail} failures, ${report.counts.warn} warnings, ${report.counts.info} informational findings.`);
    return report.ok ? 0 : 1;
  } catch (error) {
    const report = { ok: false, error: error.message };
    console.log('---BEGIN TOOLCHAIN INDEPENDENCE JSON---'); console.log(JSON.stringify(report, null, 2)); console.log('---END TOOLCHAIN INDEPENDENCE JSON---');
    console.error(`FAIL: ${error.message}`); return 2;
  }
}

if (invokedDirectly(import.meta.url)) process.exitCode = await main();
