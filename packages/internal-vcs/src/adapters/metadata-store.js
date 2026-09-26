'use strict';

const { declareAdapter } = require('./contract');

/** Append-only records, compare-and-swap, snapshot reads, and rebuildable projections. */
module.exports = declareAdapter('MetadataStore', {
  appendEvent: { request: 'LifecycleTransition|domain-event', result: 'ParticipantReceipt' },
  compareAndSwap: { request: 'expectedSnapshot+event+FenceBinding[]', result: 'ParticipantReceipt' },
  readSnapshot: { request: 'subjectId+snapshotId?', result: 'SnapshotToken+record' },
  rebuildProjection: { request: 'projectionId+controlLogRange', result: 'ProofRecord' },
});
