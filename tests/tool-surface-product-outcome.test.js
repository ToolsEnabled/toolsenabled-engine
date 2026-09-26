'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { captureProductExecution, productError } = require('../tools/lib/tool-surface-product-outcome');

async function main() {
  const missing = path.join(__dirname, `missing-tool-surface-input-${process.pid}`);
  const outcome = await captureProductExecution(() => fs.readFile(missing, 'utf8'));

  assert.equal(outcome.origin, 'product');
  assert.equal(outcome.kind, 'failure');
  assert.match(outcome.message, /ENOENT/);

  const refusal = Object.assign(new Error('id is required'), { code: 'INVALID_PARAMS' });
  assert.deepEqual(productError(refusal), {
    origin: 'product',
    kind: 'refusal',
    code: 'INVALID_PARAMS',
    message: 'id is required'
  });
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
