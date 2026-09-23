#!/usr/bin/env node
'use strict';

const {
  SourceFreezeError,
  freezeSources,
  verifySources,
  thawSources,
  sourceFreezeStatus
} = require('../src/lib/source-freeze');

function usage() {
  return [
    'Usage:',
    '  node tools/source-freeze.js freeze --repo <root> --owner <id> --manifest <path> --path <relative> [--path <relative> ...]',
    '  node tools/source-freeze.js verify --repo <root> --manifest <path> --manifest-sha256 <hex>',
    '  node tools/source-freeze.js thaw --repo <root> --owner <id> --manifest <path> --manifest-sha256 <hex>',
    '  node tools/source-freeze.js status --repo <root>'
  ].join('\n');
}

function parse(argv) {
  const [action, ...rest] = argv;
  if (!['freeze', 'verify', 'thaw', 'status'].includes(action)) throw new Error(usage());
  const values = { action, paths: [] };
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag || !flag.startsWith('--') || value === undefined) throw new Error(usage());
    if (flag === '--path') values.paths.push(value);
    else if (flag === '--repo') {
      if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}\n${usage()}`);
      seen.add(flag);
      values.repoRoot = value;
    } else if (flag === '--owner') {
      if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}\n${usage()}`);
      seen.add(flag);
      values.owner = value;
    } else if (flag === '--manifest') {
      if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}\n${usage()}`);
      seen.add(flag);
      values.manifestPath = value;
    } else if (flag === '--manifest-sha256') {
      if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}\n${usage()}`);
      seen.add(flag);
      values.manifestSha256 = value;
    }
    else throw new Error(`Unknown option: ${flag}\n${usage()}`);
  }
  const required = ['repoRoot'];
  if (action !== 'status') required.push('manifestPath');
  if (action === 'freeze' || action === 'thaw') required.push('owner');
  if (action === 'verify' || action === 'thaw') required.push('manifestSha256');
  if (required.some((key) => !values[key])) throw new Error(usage());
  if (action === 'freeze' && values.paths.length === 0) throw new Error(usage());
  if (action !== 'freeze' && values.paths.length > 0) throw new Error(`--path is valid only for freeze\n${usage()}`);
  if (action === 'freeze' && values.manifestSha256) throw new Error(`--manifest-sha256 is not valid for freeze\n${usage()}`);
  if (action === 'verify' && values.owner) throw new Error(`--owner is not valid for verify\n${usage()}`);
  if (action === 'status' && (values.owner || values.manifestPath || values.manifestSha256 || values.paths.length > 0)) {
    throw new Error(`status accepts only --repo\n${usage()}`);
  }
  return values;
}

function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  let result;
  if (options.action === 'freeze') result = freezeSources(options);
  if (options.action === 'verify') result = verifySources(options);
  if (options.action === 'thaw') result = thawSources(options);
  if (options.action === 'status') result = sourceFreezeStatus(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const code = error instanceof SourceFreezeError ? error.code : 'SOURCE_FREEZE_USAGE_ERROR';
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parse, usage };
