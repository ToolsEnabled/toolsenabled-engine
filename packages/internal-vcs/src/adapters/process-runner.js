'use strict';

const { declareAdapter } = require('./contract');

/** Explicit argv execution with success/failure/indeterminate attribution. */
module.exports = declareAdapter('ProcessRunner', {
  runChecked: { request: 'executable+argv+limits', result: 'typed process result' },
  runPipeline: { request: 'explicit process stages+limits', result: 'typed attributed process result' },
});
