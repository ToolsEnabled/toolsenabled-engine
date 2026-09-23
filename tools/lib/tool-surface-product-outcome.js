'use strict';

function isSystemFailure(error) {
  return Boolean(error)
    && typeof error === 'object'
    && typeof error.syscall === 'string'
    && error.syscall.trim().length > 0
    && (typeof error.errno === 'number' || typeof error.errno === 'string');
}

function productError(error) {
  return error && !isSystemFailure(error) && typeof error.code === 'string' && error.code.trim()
    ? { origin: 'product', kind: 'refusal', code: error.code, message: error.message || null }
    : { origin: 'product', kind: 'failure', message: error && error.message ? error.message : String(error) };
}

async function captureProductExecution(operation) {
  try {
    return { origin: 'product', kind: 'answer', value: await operation() };
  } catch (error) {
    return productError(error);
  }
}

module.exports = Object.freeze({ captureProductExecution, productError });
