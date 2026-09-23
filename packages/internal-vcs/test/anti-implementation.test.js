'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function javascriptFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  });
}

test('runtime implementation is fenced to approved milestone directories', () => {
  const sourceRoot = path.resolve(__dirname, '..', 'src');
  const forbiddenEverywhere = [
    /\bimport\s*\(/,
    /\brequire\s*\(\s*[^'\"]/,
    /\bfetch\s*\(/,
    /\bWebSocket\b/,
    /\.listen\s*\(/,
    /\bset(?:Timeout|Interval|Immediate)\s*\(/,
    /\bqueueMicrotask\s*\(/,
    /\bnew\s+(?:Worker|Function)\s*\(/,
    /\beval\s*\(/,
    /\bprocess\.(?:binding|dlopen)\b/,
  ];

  for (const file of javascriptFiles(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const imports = [...executable.matchAll(/require\(['"]([^'"]+)['"]\)/g)];
    const relative = path.relative(sourceRoot, file).replace(/\\/g, '/');
    const approvedRuntime = /^m[1-9]\//.test(relative);
    for (const [, imported] of imports) {
      if (!approvedRuntime) {
        assert.ok(imported.startsWith('.'), `${file} imports runtime dependency ${imported}`);
      } else if (!imported.startsWith('.')) {
        assert.match(imported, /^node:(?:child_process|crypto|fs|path)$/, `${file} imports unapproved runtime dependency ${imported}`);
      }
    }
    for (const pattern of forbiddenEverywhere) {
      assert.doesNotMatch(executable, pattern, `${file} contains behavior outside M1-M2 authority`);
    }
    assert.doesNotMatch(executable, /shell\s*:\s*true/, `${file} enables shell-string execution`);
  }
});

test('the frozen service shape refuses use without an explicitly bound runtime', () => {
  const serviceRoot = path.resolve(__dirname, '..', 'src', 'services');
  for (const file of javascriptFiles(serviceRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /require\('\.\.\/unbound-service'\)/);
    assert.match(source, /return unboundService\('/);
  }
});

test('M1 control records and storage have no content or Git coupling', () => {
  const milestoneRoot = path.resolve(__dirname, '..', 'src', 'm1');
  for (const file of javascriptFiles(milestoneRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /require\(['"]\.\.\/(?:adapters\/)?(?:content-store|git-bridge|m2)/);
    assert.doesNotMatch(source, /\bgit(?:Executable|Directory|Object|Bridge)\b/i);
  }
});
