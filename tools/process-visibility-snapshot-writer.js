#!/usr/bin/env node
'use strict';

// Fixed stdin-only entry point used by tools/collect-process-visibility.ps1.
// It exposes no file, task, process, or argv selection to the caller.  Its
// stdout is deliberately just a safe receipt because the elevated UAC helper
// records child output in diagnostics.

const writer = require('../src/lib/supervision/process-visibility-writer.js');

const MAX_STDIN_BYTES = writer.MAX_SERIALIZED_BYTES;

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exitCode = 2;
}

if (process.argv.length !== 2) {
  fail('PROCESS_VISIBILITY_WRITER_ARGS_REFUSED');
} else {
  const chunks = [];
  let bytes = 0;
  let inputSettled = false;
  process.stdin.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) {
      inputSettled = true;
      fail('PROCESS_VISIBILITY_WRITER_INPUT_OVERSIZE');
      process.stdin.destroy();
      return;
    }
    chunks.push(chunk);
  });
  process.stdin.on('error', () => {
    inputSettled = true;
    fail('PROCESS_VISIBILITY_WRITER_INPUT_FAILED');
  });
  process.stdin.on('close', () => {
    // A premature close establishes neither a complete document nor an input
    // error. Refuse it rather than exiting successfully without a receipt.
    if (!inputSettled) fail('PROCESS_VISIBILITY_WRITER_INPUT_FAILED');
  });
  process.stdin.on('end', () => {
    inputSettled = true;
    if (process.exitCode) return;
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('PROCESS_VISIBILITY_WRITER_INPUT_INVALID_JSON'); return; }
    try {
      const receipt = writer.writeProcessVisibilitySnapshot(input);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        capturedAtMs: receipt.capturedAtMs,
        taskCount: receipt.taskCount,
        processCount: receipt.processCount,
        bytes: receipt.bytes
      })}\n`);
    } catch (error) {
      // Contract errors name a class only; they never echo input strings or
      // process arguments into the elevated helper's output.
      fail((error && error.code) || 'PROCESS_VISIBILITY_WRITER_FAILED');
    }
  });
}
