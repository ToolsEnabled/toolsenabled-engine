/* Mutation check (2026-08-27):
 * In duty-registry.js, changed `duty.kind === kind` to `duty.kind !== kind`.
 * The edit landed: yes (the mutated expression was confirmed in the module).
 * This isolated test went red: yes (exit code 1 on the first filter assertion).
 */
'use strict';

const assert = require('node:assert/strict');

const registry = require('../src/lib/coordinator/duty-registry.js');

function run() {
  const duties = [
    { id: 'poll', kind: registry.DUTY_KIND.MECHANICAL },
    { id: 'decide', kind: registry.DUTY_KIND.JUDGEMENT },
    { id: 'repair', kind: registry.DUTY_KIND.MECHANICAL }
  ];

  assert.deepEqual(
    registry.listDuties({ kind: registry.DUTY_KIND.MECHANICAL, duties }),
    [duties[0], duties[2]],
    'listDuties must return only duties whose kind matches the requested kind'
  );
  assert.deepEqual(
    registry.listDuties({ kind: registry.DUTY_KIND.JUDGEMENT, duties }),
    [duties[1]],
    'listDuties must support the other exported duty kind as a filter value'
  );

  const unfiltered = registry.listDuties({ duties });
  assert.deepEqual(unfiltered, duties, 'omitting kind must list every supplied duty');
  assert.notStrictEqual(unfiltered, duties, 'the unfiltered result must be a defensive array copy');
  unfiltered.pop();
  assert.equal(duties.length, 3, 'mutating the returned list must not mutate the caller\'s registry');

  process.stdout.write('coordinator-duty-registry listDuties behaviour: PASS\n');
}

run();
