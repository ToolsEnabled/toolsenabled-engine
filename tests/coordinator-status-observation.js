'use strict';

const assert = require('node:assert/strict');
const observation = require('../src/lib/coordinator-status-observation');

function searchWith(entries) {
  return (input) => {
    assert.deepEqual(input, { namespace: 'agent-coord', query: 'controller/', limit: 20 });
    return { entries };
  };
}

// A recent rolling controller wave record is activity evidence, but its
// private value/note never cross this observation boundary.
{
  const result = observation.observe({ nowMs: 1_000, maxAgeMs: 100 }, {
    search: searchWith([{
      namespace: 'agent-coord',
      key: 'controller/codex-luna-gemini-wave-20260729',
      updatedAtMs: 950,
      revision: 8,
      value: { secretLikeNarration: 'never expose this' },
      note: 'also never expose this'
    }])
  });
  assert.deepEqual(result, { state: 'recent', lastUpdatedAgeMs: 50 });
  assert.equal(Object.hasOwn(result, 'value'), false);
  assert.equal(Object.hasOwn(result, 'note'), false);
  assert.equal(Object.hasOwn(result, 'key'), false);
}

// Only named coordinator-status or rolling-wave records qualify; unrelated
// controller keys and newer future timestamps cannot manufacture liveness.
{
  const result = observation.observe({ nowMs: 1_000, maxAgeMs: 100 }, {
    search: searchWith([
      { namespace: 'agent-coord', key: 'controller/review/12', updatedAtMs: 999 },
      { namespace: 'agent-coord', key: 'controller/codex-wave-20260729', updatedAtMs: 1_001 },
      { namespace: 'other', key: 'controller/coordinator-status', updatedAtMs: 999 }
    ])
  });
  assert.deepEqual(result, { state: 'silent', lastUpdatedAgeMs: null });
}

{
  const stale = observation.observe({ nowMs: 1_000, maxAgeMs: 100 }, {
    search: searchWith([{
      namespace: 'agent-coord', key: 'controller/coordinator-status', updatedAtMs: 800
    }])
  });
  assert.deepEqual(stale, { state: 'silent', lastUpdatedAgeMs: 200 });

  const unavailable = observation.observe({ nowMs: 1_000, maxAgeMs: 100 }, {
    search: () => { throw new Error('database unavailable'); }
  });
  assert.deepEqual(unavailable, { state: 'unobserved', lastUpdatedAgeMs: null });
}

// A saturated bounded search cannot establish that no qualifying record
// exists: newer unrelated records may have crowded one out of the result.
{
  const saturated = Array.from({ length: observation.SEARCH_LIMIT }, (_, index) => ({
    namespace: 'agent-coord', key: `controller/review/${index}`, updatedAtMs: 900 + index
  }));
  const result = observation.observe({ nowMs: 1_000, maxAgeMs: 100 }, {
    search: searchWith(saturated)
  });
  assert.deepEqual(result, { state: 'unobserved', lastUpdatedAgeMs: null });
}

console.log('coordinator-status-observation tests passed.');
