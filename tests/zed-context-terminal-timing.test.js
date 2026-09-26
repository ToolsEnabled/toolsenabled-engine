'use strict';

const assert = require('node:assert/strict');
const { TerminalDisplay } = require('../tools/zed-context-terminal');

const terminalReset = '\x1b[2J\x1b[3J\x1b[H';
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function permanentTail(output) {
  const resetAt = output.lastIndexOf(terminalReset);
  return resetAt === -1 ? output : output.slice(resetAt + terminalReset.length);
}

async function main() {
  let output = '';
  const display = new TerminalDisplay({ write(value) { output += value.toString(); } }, { columns: 100 });
  display.setPermanentReplay(() => display.writeContext('durable context', { redraw: false }));
  display.writeContext('durable context');
  display.renderDynamic();

  display.showRawPreview('NATIVE COMMAND PREVIEW');
  await wait(350);
  assert.equal(display.rawPreviewActive, true, 'native output should still be visible before 500 ms');
  assert.match(output, /NATIVE COMMAND PREVIEW/);

  await wait(350);
  assert.equal(display.rawPreviewActive, false, 'native output should be gone shortly after 500 ms');
  assert.match(permanentTail(output), /durable context/);
  assert.doesNotMatch(permanentTail(output), /NATIVE COMMAND PREVIEW/);

  display.handleKeypress('/', { name: '/' });
  display.showRawPreview('NATIVE SLASH MENU');
  await wait(2100);
  assert.equal(display.rawPreviewActive, true, 'an active slash draft must hold the native picker');
  assert.match(output.slice(output.lastIndexOf(terminalReset)), /NATIVE SLASH MENU/);

  display.handleKeypress(undefined, { name: 'backspace' });
  await wait(700);
  assert.equal(display.rawPreviewActive, false, 'closing the slash draft must restore context');
  assert.match(permanentTail(output), /durable context/);
  assert.doesNotMatch(permanentTail(output), /NATIVE SLASH MENU/);
  display.finish();
  console.log('Zed context-terminal 500 ms and slash-hold timing test passed.');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
