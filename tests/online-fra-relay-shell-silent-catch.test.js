'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'online-fra-relay-shell.js'), 'utf8');

/* Regression contract: "the operation did not happen" (a peer simply has not
   answered) and "the operation could not be established" (our socket write
   failed) must not produce the same observable report. This deliberately
   guards the event boundary: it is the caller-visible answer that the silent
   catches previously falsified. */
assert.match(source, /catch \{\s*sayOnce\('hello_dropped', leg\.name, DROP\.SOCKET_CLOSED\); return; \}\s*sayOnce\('hello_repeated', leg\.name, DROP\.ANSWER_RESENT\);/,
  'a failed duplicate-answer write must report socket-closed, not answer-resent');
assert.match(source, /catch \{[\s\S]*?sayOnce\('renewal_failed', leg\.name, DROP\.SOCKET_CLOSED\);\s*return;\s*\}\s*emit\('online_fra_shell_renewed'/,
  'a failed cutover probe must report renewal_failed, not renewed');

console.log('online-fra-relay-shell silent catches: did not happen remains distinct from could not be established');
