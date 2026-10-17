'use strict';

// Every terminal-question refusal an agent can meet
// through the action rules reaches it as its own sentence, not as "internal
// error" (src/lib/error-taxonomy.js). Checked with the MCP server's toolError,
// which builds exactly what the agent's CLI shows.

require('./lib/isolated-environment').activate('openshell-action-rules-refusals');
const test = require('node:test');
const assert = require('node:assert/strict');

const { toolError } = require('../src/mcp-server');

const KEEPS_ITS_SENTENCE = Object.freeze({
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  PERSON_CHANNEL_FULL: 'INPUT_REQUIRED',
  PERSON_CHANNEL_UNREADABLE: 'INPUT_REQUIRED',
  PERSON_CHANNEL_UNWRITABLE: 'INPUT_REQUIRED',
  PERSON_CHANNEL_TEXT_INVALID: 'INVALID_REQUEST',
  PERSON_CHANNEL_TIMEOUT_INVALID: 'INVALID_REQUEST'
});

test('each refusal reaches the agent as its own sentence', () => {
  for (const [code, category] of Object.entries(KEEPS_ITS_SENTENCE)) {
    const sentence = `The ${code.toLowerCase().replace(/_/g, ' ')} sentence, naming what to do.`;
    const result = toolError(Object.assign(new Error(sentence), { code }));
    assert.equal(result.isError, true, code);
    assert.equal(result.content[0].text, sentence, `${code} lost its sentence`);
    assert.equal(result.structuredContent.error.code, code);
    assert.equal(result.structuredContent.error.taxonomy.code, category, code);
  }
});

test('a lock held for seconds is the one exception: it says to try again later, which is what to do', () => {
  const result = toolError(Object.assign(new Error('The file stayed locked for 5 seconds.'), { code: 'PERSON_CHANNEL_BUSY' }));
  assert.equal(result.structuredContent.error.taxonomy.classification, 'retry-after-time');
  assert.match(result.content[0].text, /Try again later/);
});
