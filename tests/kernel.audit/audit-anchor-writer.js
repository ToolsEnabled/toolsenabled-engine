'use strict';

const audit = require('../../src/lib/audit');
try {
  const status = audit.requireRecord('cross-process.intent', 'isolated-test', {});
  if (!status.anchored) throw new Error('writer did not protect its audit intent');
} finally {
  audit.resetForTests();
}
