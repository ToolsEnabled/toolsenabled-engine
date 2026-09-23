'use strict';

const assert = require('node:assert/strict');
const { TerminalDisplay } = require('../tools/zed-context-terminal');

const terminalReset = '\x1b[2J\x1b[3J\x1b[H';

function permanentTail(output) {
  const resetAt = output.lastIndexOf(terminalReset);
  return resetAt === -1 ? output : output.slice(resetAt + terminalReset.length);
}

function makeDisplay(options = {}) {
  let output = '';
  const display = new TerminalDisplay({ write(value) { output += value.toString(); } }, {
    columns: 100,
    transientMs: 500,
    maxPreviewMs: 500,
    ...options
  });
  display.setPermanentReplay(() => display.writeContext('durable context', { redraw: false }));
  display.writeContext('durable context');
  return { display, get output() { return output; } };
}

// The race: native preview expires, raw command bytes arrive, then the
// projector observes structured activity. The bytes must survive only until
// that explicit re-arm point and must never appear in the permanent tail.
{
  let now = 0;
  const fixture = makeDisplay({ now: () => now, maxSuppressedPreviewBytes: 64 });
  const { display } = fixture;
  display.showRawPreview('NATIVE PREVIEW');
  assert.equal(display.expireRawPreview(), true);
  assert.equal(display.rawPreviewSuppressed, true);
  const beforeSuppressedBytes = fixture.output.length;
  assert.equal(display.showRawPreview('MEANINGFUL TOOL BYTES'), false);
  assert.equal(fixture.output.length, beforeSuppressedBytes);
  assert.equal(display.suppressedPreview.length, 'MEANINGFUL TOOL BYTES'.length);

  display.showActivity('shell');
  assert.equal(display.rawPreviewActive, true);
  assert.equal(display.rawPreviewSuppressed, false);
  assert.match(fixture.output, /MEANINGFUL TOOL BYTES/);
  assert.equal(display.expireRawPreview(), true);
  assert.doesNotMatch(permanentTail(fixture.output), /MEANINGFUL TOOL BYTES/);
  display.finish();
}

// Passive redraws are retained only as a short-lived candidate; they never
// reopen the native UI without a structured activity or user interaction.
{
  let now = 0;
  const fixture = makeDisplay({ now: () => now, suppressedPreviewMs: 50 });
  const { display } = fixture;
  display.showRawPreview('NATIVE PREVIEW');
  display.expireRawPreview();
  const afterExpiry = fixture.output.length;
  assert.equal(display.showRawPreview('PASSIVE STATUS REDRAW'), false);
  assert.equal(fixture.output.length, afterExpiry);
  now = 51;
  display.showActivity('late activity');
  assert.equal(display.rawPreviewActive, false, 'stale bytes must not reopen native UI');
  assert.doesNotMatch(permanentTail(fixture.output), /PASSIVE STATUS REDRAW/);
  display.finish();
}

// Slash menus remain held by the existing hard-deadline rule, and cleanup
// removes the active preview plus every timer/buffer.
{
  const fixture = makeDisplay();
  const { display } = fixture;
  display.handleKeypress('/', { name: '/' });
  display.showRawPreview('NATIVE SLASH MENU');
  assert.equal(display.expireRawPreview(), false);
  assert.equal(display.rawPreviewActive, true);
  assert.match(fixture.output, /NATIVE SLASH MENU/);
  display.handleKeypress(undefined, { name: 'backspace' });
  assert.equal(display.restoreRawPreview(), true);
  assert.equal(display.rawPreviewActive, false);
  display.finish();
  assert.equal(display.suppressedPreview.length, 0);
  assert.equal(display.suppressedPreviewTimer, null);
  assert.equal(display.rawPreviewTimer, null);
  assert.equal(display.rawPreviewHardTimer, null);
}

// A real keypress is another explicit re-arm and must flush a still-fresh
// suppressed buffer before the input mirror updates the line.
{
  let now = 0;
  const fixture = makeDisplay({ now: () => now });
  const { display } = fixture;
  display.showRawPreview('NATIVE PREVIEW');
  display.expireRawPreview();
  display.showRawPreview('USER-REARMED TOOL BYTES');
  display.handleKeypress('x', { name: 'x' });
  assert.equal(display.rawPreviewActive, true);
  assert.match(fixture.output, /USER-REARMED TOOL BYTES/);
  display.finish();
}

console.log('Zed context-terminal preview race, stale suppression, passive redraw, and slash-hold tests passed.');
