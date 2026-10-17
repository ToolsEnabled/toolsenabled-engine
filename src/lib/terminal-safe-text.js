'use strict';

// This is a display boundary, never a protocol or history normalizer. Make
// terminal controls visible rather than executing them or hiding their text.
// Escaping each control also neutralizes partial OSC/CSI sequences and escape
// prefixes split between events, without carrying parser state across writes.
const UNSAFE_TERMINAL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/;
const UNSAFE_TERMINAL_ALL = new RegExp(UNSAFE_TERMINAL.source, 'g');

function terminalSafeText(text) {
  if (typeof text !== 'string') throw new TypeError('Terminal text must be a string.');
  // Preserve line breaks and indentation. A lone CR can overwrite an existing
  // line, so only the ordinary CRLF pair becomes a displayed newline.
  return text.replace(/\r\n/g, '\n').replace(UNSAFE_TERMINAL_ALL,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Stored page fields use a visible replacement character. Keep zero-width
// spacing controls out of these fields too; the stream renderer above retains
// U+200D so ordinary emoji sequences in worker output stay intact.
function terminalDisplayText(value) {
  return String(value ?? '').replace(UNSAFE_TERMINAL_ALL, '\uFFFD').replace(/[\u200b-\u200d]/g, '\uFFFD');
}

module.exports = Object.freeze({ terminalSafeText, terminalDisplayText, UNSAFE_TERMINAL });
