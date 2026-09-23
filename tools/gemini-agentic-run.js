#!/usr/bin/env node
'use strict';

// Thin CLI wrapper around src/lib/providers/gemini-agentic.js's runAgenticTask.
// Usage:
//   node tools/gemini-agentic-run.js --input <path/to/input.json>
// input.json shape: {"taskBrief": "...", "workspacePath": "C:\\...", "allowedPaths": ["src/lib/example.js"],
//                     "maxMinutes": 15, "model": "gemini-3.1-pro-preview", "backend": "subscription"}
// Prints one bounded JSON result packet to stdout and exits 0 on success,
// or a bounded {"ok":false,"code":...} packet with a non-zero exit on failure.
// The disposable worktree is never deleted by this script; the caller
// reviews `worktreePath` and calls gemini-agentic.js's cleanupWorktree
// (or a future dispatcher tool) once a merge decision has been made.

const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('../src/lib/runtime');
const { runAgenticTask, GeminiAgenticError } = require('../src/lib/providers/gemini-agentic');

function parseArgs(argv) {
  const args = { input: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--input' && argv[i + 1]) { args.input = argv[i + 1]; i += 1; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    process.stderr.write('Usage: node tools/gemini-agentic-run.js --input <path/to/input.json>\n');
    process.exitCode = 2;
    return;
  }
  const inputPath = path.resolve(args.input);
  const input = readJson(inputPath, null);
  if (!input) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'GEMINI_AGENTIC_RUN_INPUT_MISSING' })}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runAgenticTask(input);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    const isKnown = error instanceof GeminiAgenticError;
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: isKnown ? error.code : 'GEMINI_AGENTIC_RUN_UNEXPECTED_ERROR',
      message: error && typeof error.message === 'string' ? error.message.slice(0, 2000) : 'Unknown error.',
      details: isKnown ? error.details : undefined
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

main();
