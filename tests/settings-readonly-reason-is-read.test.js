'use strict';

// THE CATALOGUE SAYS WHICH ROWS ARE READ-ONLY, AND SAYS WHY. SOMETHING HAS TO
// READ THAT.
//
// THE DEFECT, MEASURED ON THIS TREE.
//   * `readOnlyReason` is a settings-registry field. src/lib/settings-registry.js
//     lists it in FIELDS, validates it (readback controls only, never blank),
//     and tests/capability-settings-honest.test.js pins its wording on the two
//     machine-boundary rows. The shipped config/settings-registry.json carries
//     one on capability.tier and one on capability.workspace_roots.
//   * No executable file read its VALUE. Grepping the whole tree for
//     `readOnlyReason` outside the validator found only the validator, its
//     own shape test, and the two catalogue rows.
//   * tools/settings-set.js -- the product's only write path for a user
//     setting -- instead kept a second, hand-maintained copy of the same fact,
//     `MACHINE_BOUNDARY_READBACKS`, a literal set of those two ids, and refused
//     with `read-only; change it through the named authority instead`. That
//     sentence never names the authority, so a person told it still does not
//     know what to change. The catalogue already held the sentence that does
//     ("... To change it, run ToolsEnabled setup again yourself; ..."), and
//     they never saw it.
//
// So this file asserts the two halves that were missing: the declaration is
// what decides, and the person is refused in the words written for them.

const assert = require('node:assert/strict');
const test = require('node:test');

const registryModule = require('../src/lib/settings-registry');
const settingsSet = require('../tools/settings-set');

function declaredReadOnly(entries) {
  return entries.filter(entry => typeof entry.readOnlyReason === 'string' && entry.readOnlyReason.trim() !== '');
}

test('a shipped row that declares a read-only reason is refused in exactly those words', () => {
  const { entries } = registryModule.loadRegistry();
  const declared = declaredReadOnly(entries);
  assert.ok(declared.length > 0, 'the shipped catalogue must still carry at least one read-only readback');

  for (const entry of declared) {
    const refusal = settingsSet.coerce(entry, 'a value a person typed');
    assert.equal(refusal.ok, false, `${entry.id} declares a read-only reason, so the writer must refuse it`);
    assert.equal(refusal.allowed, entry.readOnlyReason.trim(),
      `${entry.id} must be refused in the catalogue's own sentence, not a placeholder that names no authority`);
  }
});

// THE MUTATION GUARD. This id exists nowhere in the product; a writer that
// still carried a hardcoded list of ids cannot refuse it, and a writer that
// reads the row cannot do anything else.
test('the read-only decision comes from the row, not from a list of ids kept in the writer', () => {
  const reason = 'Read-only here because a different record owns it. Change it where that record is written.';
  const invented = {
    id: 'invented.row_the_writer_has_never_heard_of',
    control: 'readback',
    default: '',
    readOnlyReason: reason
  };
  assert.deepEqual(settingsSet.coerce(invented, 'typed by a person'), { ok: false, allowed: reason });
});

test('a readback that declares no reason stays writable', () => {
  // model.endpoint and model.name are readbacks src/lib/providers/customer-model.js
  // reads out of settings.json, so making every readback read-only would break
  // the one provider path that depends on them.
  const { byId } = registryModule.loadRegistry();
  for (const id of ['model.endpoint', 'model.name']) {
    assert.deepEqual(settingsSet.coerce(byId.get(id), 'https://example.invalid/v1'),
      { ok: true, value: 'https://example.invalid/v1' },
      `${id} declares no read-only reason and must keep its write path`);
  }
  assert.deepEqual(
    settingsSet.coerce({ id: 'invented.row_with_no_reason', control: 'readback', default: '' }, 'typed'),
    { ok: true, value: 'typed' });
  assert.deepEqual(
    settingsSet.coerce({ id: 'invented.row_blank_reason', control: 'readback', default: '', readOnlyReason: '   ' }, 'typed'),
    { ok: true, value: 'typed' },
    'a blank declaration declares nothing; the loader already refuses it as an entry');
});

// WHAT THE PERSON ACTUALLY SEES. Coercion runs before the interactive-terminal
// check in main(), so this is the whole path a person walks into, with no TTY.
test('the command a person runs prints the sentence that says what to change', () => {
  const written = [];
  const streams = {
    stdin: { isTTY: false },
    stdout: { isTTY: false, write: text => written.push(['out', text]) },
    stderr: { write: text => written.push(['err', text]) }
  };
  const code = settingsSet.main(['capability.tier', 'unrestricted'], {}, streams);
  assert.equal(code, 1, 'a read-only row must not be written');

  const stderr = written.filter(([stream]) => stream === 'err').map(([, text]) => text).join('');
  const { byId } = registryModule.loadRegistry();
  const reason = byId.get('capability.tier').readOnlyReason.trim();
  assert.ok(stderr.includes(reason),
    `the refusal must carry the catalogue's reason. It said: ${JSON.stringify(stderr)}`);
  assert.ok(/setup/i.test(stderr), 'the refusal must name the thing the person runs instead');
});
