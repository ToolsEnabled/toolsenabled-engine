#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { invokedDirectly } from './invoked-directly.mjs';

const VERSION_FIELDS = [
  'CompanyName', 'FileDescription', 'ProductName', 'ProductVersion',
  'FileVersion', 'LegalCopyright', 'OriginalFilename',
];

class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

function requireRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > buffer.length) {
    throw new ParseError(`${label} is outside the file`);
  }
}

function u16(buffer, offset, label) {
  requireRange(buffer, offset, 2, label);
  return buffer.readUInt16LE(offset);
}

function u32(buffer, offset, label) {
  requireRange(buffer, offset, 4, label);
  return buffer.readUInt32LE(offset);
}

function align4(value) {
  return (value + 3) & ~3;
}

function readWideZ(buffer, offset, limit, label) {
  const codes = [];
  for (let cursor = offset; cursor + 2 <= limit; cursor += 2) {
    const code = u16(buffer, cursor, label);
    if (code === 0) return { value: String.fromCharCode(...codes), next: cursor + 2 };
    codes.push(code);
  }
  throw new ParseError(`${label} is not null terminated`);
}

function parseVersionBlock(buffer, start, parentEnd, label) {
  requireRange(buffer, start, 6, label);
  const length = u16(buffer, start, `${label} length`);
  const valueLength = u16(buffer, start + 2, `${label} value length`);
  const type = u16(buffer, start + 4, `${label} type`);
  if (length < 6 || start + length > parentEnd) throw new ParseError(`${label} has an invalid length`);
  const end = start + length;
  const key = readWideZ(buffer, start + 6, end, `${label} key`);
  const valueStart = align4(key.next);
  const valueBytes = type === 1 ? valueLength * 2 : valueLength;
  if (valueStart + valueBytes > end) throw new ParseError(`${label} value exceeds its block`);
  let value;
  if (type === 1 && valueBytes > 0) {
    value = buffer.subarray(valueStart, valueStart + valueBytes).toString('utf16le').replace(/\0+$/u, '');
  } else {
    value = buffer.subarray(valueStart, valueStart + valueBytes);
  }
  return { start, end, length, valueLength, type, key: key.value, value, childrenStart: align4(valueStart + valueBytes) };
}

function rvaToOffset(rva, sections, bufferLength) {
  for (const section of sections) {
    const extent = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + extent) {
      const offset = section.rawOffset + (rva - section.virtualAddress);
      if (offset >= bufferLength) throw new ParseError('resource RVA maps beyond the file');
      return offset;
    }
  }
  throw new ParseError(`resource RVA 0x${rva.toString(16)} does not map to a section`);
}

function findVersionData(buffer, resourceBase, resourceSize, sections) {
  const resourceEnd = Math.min(buffer.length, resourceBase + resourceSize);
  const entries = (directoryOffset, label) => {
    requireRange(buffer, directoryOffset, 16, label);
    const count = u16(buffer, directoryOffset + 12, label) + u16(buffer, directoryOffset + 14, label);
    requireRange(buffer, directoryOffset + 16, count * 8, `${label} entries`);
    return Array.from({ length: count }, (_, index) => {
      const entry = directoryOffset + 16 + index * 8;
      return { name: u32(buffer, entry, label), target: u32(buffer, entry + 4, label) };
    });
  };
  const root = entries(resourceBase, 'resource root');
  const version = root.find((entry) => (entry.name & 0x80000000) === 0 && entry.name === 16);
  if (!version) throw new ParseError('RT_VERSION resource type 16 is absent');
  let target = version.target;
  for (let depth = 0; depth < 3 && (target & 0x80000000) !== 0; depth += 1) {
    const relative = target & 0x7fffffff;
    if (resourceBase + relative >= resourceEnd) throw new ParseError('resource directory target exceeds .rsrc');
    const children = entries(resourceBase + relative, `resource directory level ${depth + 1}`);
    if (children.length === 0) throw new ParseError('RT_VERSION resource directory is empty');
    target = children[0].target;
  }
  if ((target & 0x80000000) !== 0) throw new ParseError('RT_VERSION resource tree is too deep');
  const dataEntry = resourceBase + target;
  requireRange(buffer, dataEntry, 16, 'version resource data entry');
  const dataRva = u32(buffer, dataEntry, 'version resource RVA');
  const dataSize = u32(buffer, dataEntry + 4, 'version resource size');
  const dataOffset = rvaToOffset(dataRva, sections, buffer.length);
  requireRange(buffer, dataOffset, dataSize, 'version resource data');
  return buffer.subarray(dataOffset, dataOffset + dataSize);
}

export function parseVersionResource(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') throw new ParseError('invalid or truncated DOS header');
  const peOffset = u32(buffer, 0x3c, 'DOS e_lfanew');
  requireRange(buffer, peOffset, 24, 'PE header');
  if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new ParseError('invalid PE signature');
  const sectionCount = u16(buffer, peOffset + 6, 'COFF section count');
  const optionalSize = u16(buffer, peOffset + 20, 'COFF optional header size');
  const optional = peOffset + 24;
  requireRange(buffer, optional, optionalSize, 'optional header');
  const magic = u16(buffer, optional, 'optional header magic');
  const dataDirectory = optional + (magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1);
  if (dataDirectory < optional) throw new ParseError(`unsupported optional header magic 0x${magic.toString(16)}`);
  requireRange(buffer, dataDirectory + 16, 8, 'resource data directory');
  const resourceRva = u32(buffer, dataDirectory + 16, 'resource directory RVA');
  const resourceSize = u32(buffer, dataDirectory + 20, 'resource directory size');
  if (!resourceRva || !resourceSize) throw new ParseError('PE has no resource data directory');
  const sectionTable = optional + optionalSize;
  requireRange(buffer, sectionTable, sectionCount * 40, 'section table');
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const offset = sectionTable + index * 40;
    return {
      name: buffer.toString('ascii', offset, offset + 8).replace(/\0.*$/u, ''),
      virtualSize: u32(buffer, offset + 8, 'section virtual size'),
      virtualAddress: u32(buffer, offset + 12, 'section virtual address'),
      rawSize: u32(buffer, offset + 16, 'section raw size'),
      rawOffset: u32(buffer, offset + 20, 'section raw offset'),
    };
  });
  const resourceSection = sections.find((section) => section.name === '.rsrc' && resourceRva >= section.virtualAddress && resourceRva < section.virtualAddress + Math.max(section.virtualSize, section.rawSize));
  if (!resourceSection) throw new ParseError('resource directory is not in a .rsrc section');
  const resourceBase = rvaToOffset(resourceRva, sections, buffer.length);
  const versionBytes = findVersionData(buffer, resourceBase, resourceSize, sections);
  const root = parseVersionBlock(versionBytes, 0, versionBytes.length, 'VS_VERSIONINFO');
  if (root.key !== 'VS_VERSION_INFO') throw new ParseError(`unexpected version root key ${JSON.stringify(root.key)}`);
  if (!Buffer.isBuffer(root.value) || root.value.length < 52) throw new ParseError('VS_FIXEDFILEINFO is missing or truncated');
  if (root.value.readUInt32LE(0) !== 0xfeef04bd) throw new ParseError('VS_FIXEDFILEINFO signature is invalid');
  const fixed = {
    fileVersion: [root.value.readUInt32LE(8) >>> 16, root.value.readUInt32LE(8) & 0xffff, root.value.readUInt32LE(12) >>> 16, root.value.readUInt32LE(12) & 0xffff].join('.'),
    productVersion: [root.value.readUInt32LE(16) >>> 16, root.value.readUInt32LE(16) & 0xffff, root.value.readUInt32LE(20) >>> 16, root.value.readUInt32LE(20) & 0xffff].join('.'),
  };
  const strings = {};
  const visit = (start, end, depth) => {
    let cursor = start;
    while (cursor + 6 <= end) {
      const block = parseVersionBlock(versionBytes, cursor, end, `version block at ${cursor}`);
      if (depth >= 2 && block.type === 1 && VERSION_FIELDS.includes(block.key)) strings[block.key] ??= block.value;
      if (block.childrenStart < block.end) visit(block.childrenStart, block.end, depth + 1);
      cursor = align4(block.end);
      if (block.length === 0) throw new ParseError('zero-length version block');
    }
  };
  visit(root.childrenStart, root.end, 0);
  return { fields: Object.fromEntries(VERSION_FIELDS.map((field) => [field, strings[field] ?? null])), fixed };
}

export async function auditExe(exePath) {
  let bytes;
  try {
    bytes = await readFile(exePath);
  } catch (error) {
    return { status: 'UNKNOWN', source: exePath, parsed: false, fields: null, fixedFileInfo: null, problems: [{ path: null, reason: 'exe-unreadable', message: error.message }], skips: [] };
  }
  try {
    const parsed = parseVersionResource(bytes);
    const problems = VERSION_FIELDS.filter((field) => parsed.fields[field] === null || parsed.fields[field].trim() === '').map((field) => ({ path: field, reason: 'missing-or-empty' }));
    return { status: problems.length ? 'FAIL' : 'PASS', source: exePath, parsed: true, fields: parsed.fields, fixedFileInfo: parsed.fixed, problems, skips: [] };
  } catch (error) {
    return { status: 'FAIL', source: exePath, parsed: false, fields: null, fixedFileInfo: null, problems: [{ path: null, reason: 'unparsed', message: error.message }], skips: [] };
  }
}

async function findSchema(packageDirectory) {
  const skips = [];
  const direct = path.join(packageDirectory, 'node_modules', 'app-builder-lib', 'scheme.json');
  try { await readFile(direct); return { schemaPath: direct, skips }; } catch (error) {
    if (error.code !== 'ENOENT') skips.push({ path: direct, reason: 'read-error', message: error.message });
  }
  const nodeModules = path.join(packageDirectory, 'node_modules');
  const queue = [nodeModules];
  while (queue.length) {
    const directory = queue.shift();
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if (error.code !== 'ENOENT') skips.push({ path: directory, reason: 'read-error', message: error.message });
      continue;
    }
    if (path.basename(directory) === 'app-builder-lib') {
      const candidate = path.join(directory, 'scheme.json');
      try { await readFile(candidate); return { schemaPath: candidate, skips }; } catch (error) {
        if (error.code !== 'ENOENT') skips.push({ path: candidate, reason: 'read-error', message: error.message });
      }
    }
    for (const child of children) {
      if (child.isDirectory() && child.name !== '.bin') queue.push(path.join(directory, child.name));
    }
  }
  return { schemaPath: null, skips };
}

function resolveSchema(schema, root, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref?.startsWith('#/')) {
    if (seen.has(schema.$ref)) return schema;
    const target = schema.$ref.slice(2).split('/').reduce((value, token) => value?.[token.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    return resolveSchema(target, root, new Set([...seen, schema.$ref]));
  }
  const combined = [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].map((part) => resolveSchema(part, root, seen));
  if (combined.length) {
    const properties = Object.assign({}, ...combined.map((part) => part?.properties ?? {}), schema.properties ?? {});
    return { ...schema, properties, additionalProperties: schema.additionalProperties ?? combined.find((part) => part?.additionalProperties !== undefined)?.additionalProperties };
  }
  return schema;
}

function locateBuildSchema(root) {
  const candidates = [root, root.properties?.build, root.definitions?.Configuration, root.$defs?.Configuration, root.definitions?.PlatformSpecificBuildOptions];
  for (const candidate of candidates) {
    const resolved = resolveSchema(candidate, root);
    if (resolved?.properties && (resolved.properties.win || resolved.properties.nsis || resolved.properties.directories)) return resolved;
  }
  return null;
}

function unknownKeys(value, schemaNode, root, jsonPath, output) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const resolved = resolveSchema(schemaNode, root);
  const properties = resolved?.properties;
  if (!properties || typeof properties !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (!Object.hasOwn(properties, key)) {
      output.push(`${jsonPath}.${key}`);
    } else {
      unknownKeys(child, properties[key], root, `${jsonPath}.${key}`, output);
    }
  }
}

export async function auditBuilderConfig(packageJsonPath) {
  let packageJson;
  try { packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')); } catch (error) {
    return { status: 'FAIL', source: packageJsonPath, schema: null, unknownKeys: [], problems: [{ reason: 'package-json-unreadable', message: error.message }], skips: [] };
  }
  const discovery = await findSchema(path.dirname(path.resolve(packageJsonPath)));
  const { schemaPath, skips } = discovery;
  if (!schemaPath) return { status: 'UNKNOWN', source: packageJsonPath, schema: null, unknownKeys: [], problems: [{ reason: 'schema-not-found' }], skips };
  try {
    const root = JSON.parse(await readFile(schemaPath, 'utf8'));
    const buildSchema = locateBuildSchema(root);
    if (!buildSchema) return { status: 'UNKNOWN', source: packageJsonPath, schema: schemaPath, unknownKeys: [], problems: [{ reason: 'build-schema-not-found' }], skips };
    if (!Object.hasOwn(packageJson, 'build')) {
      return { status: 'FAIL', source: packageJsonPath, schema: schemaPath, unknownKeys: [], problems: [{ path: '$.build', reason: 'missing-build-config' }], skips };
    }
    if (!packageJson.build || typeof packageJson.build !== 'object' || Array.isArray(packageJson.build) || Object.keys(packageJson.build).length === 0) {
      return { status: 'FAIL', source: packageJsonPath, schema: schemaPath, unknownKeys: [], problems: [{ path: '$.build', reason: 'empty-build-config' }], skips };
    }
    const unknown = [];
    unknownKeys(packageJson.build ?? {}, buildSchema, root, '$.build', unknown);
    return { status: unknown.length ? 'FAIL' : 'PASS', source: packageJsonPath, schema: schemaPath, unknownKeys: unknown, problems: unknown.map((item) => ({ path: item, reason: 'unrecognized-key' })), skips };
  } catch (error) {
    return { status: 'UNKNOWN', source: packageJsonPath, schema: schemaPath, unknownKeys: [], problems: [{ reason: 'schema-unreadable', message: error.message }], skips };
  }
}

export async function runAudit({ exe, packageJson }) {
  const checks = {};
  if (exe) checks.windowsVersionResources = await auditExe(exe);
  if (packageJson) checks.electronBuilderConfig = await auditBuilderConfig(packageJson);
  if (!exe && !packageJson) checks.arguments = { status: 'FAIL', problems: [{ reason: 'provide --exe and/or --package-json' }], skips: [] };
  const status = Object.values(checks).every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
  return { tool: 'installer-identity-audit', status, checks };
}

function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--exe') result.exe = argv[++index];
    else if (argv[index] === '--package-json') result.packageJson = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return result;
}

function printReport(report) {
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nInstaller identity audit: ${report.status}`);
  for (const [name, check] of Object.entries(report.checks)) {
    console.log(`- ${name}: ${check.status} (${check.problems?.length ?? 0} problem(s), ${check.skips?.length ?? 0} skip(s))`);
    for (const problem of check.problems ?? []) console.log(`  - ${problem.path ?? problem.reason}: ${problem.message ?? problem.reason}`);
  }
}

const isMain = invokedDirectly(import.meta.url);
if (isMain) {
  try {
    const report = await runAudit(argumentsFrom(process.argv.slice(2)));
    printReport(report);
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    const report = { tool: 'installer-identity-audit', status: 'FAIL', checks: { arguments: { status: 'FAIL', problems: [{ reason: 'invalid-arguments', message: error.message }], skips: [] } } };
    printReport(report);
    process.exitCode = 1;
  }
}
