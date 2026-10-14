'use strict';

// AN EMPTY PATH IS A CALLER'S CHOICE, NOT AN ABSENT ARGUMENT.
//
// assertPathValueInsideRoots() returned early for undefined, null AND '' on the
// stated reasoning that an absent value is not an escape: "the provider
// substitutes its own installation-owned default, never a caller choice". That
// is true of undefined and null. It is not true of an empty string, which is
// something the caller supplied and which every `args.x || default` idiom turns
// into the default -- so a confined caller that cannot name a path outside its
// workspace could select one anyway, by naming nothing at all.
//
// MEASURED on this build, before the fix:
//   search.index's `root` is REQUIRED, so an omitted root never reaches the
//   handler. But its schema is a bare {type:'string'} with no minLength, the
//   validator accepts {root: ''}, the fence waved it through, and
//   src/lib/search.js:240 resolves String(args.root || '.') to '.' -- the
//   server's working directory, i.e. the install root, not the agent's
//   workspace. A confined/workspace agent could make the indexer walk and store
//   content from outside its fence.
//
// What it could NOT do is read it back: search.js currentlyAllowedSearchRows()
// re-checks every row against the workspace roots at query time. The write still
// happened, which is why this is worth closing rather than shrugging at.
//
// launch.detect already carried a hand-written special case for exactly this
// shape. One tool got a carve-out where the rule belonged in the fence.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const surface = require('../src/lib/confined-tool-surface.js');
const { TOOL_REGISTRY } = require('../src/lib/tool-registry.js');

/* A root that exists on disk: the fence realpaths what it is given, so a
 * fixture root that is not there refuses every path for the wrong reason and
 * would make the cases below pass without testing anything. */
function workspace() {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.te-fence-'));
  fs.mkdirSync(path.join(root, 'project'), { recursive: true });
  return root;
}

const CONFINED = { tier: 'confined', profile: 'workspace' };
const admits = (tool, args, roots) => {
  try { surface.assertArgumentsConfined(tool, args, roots, CONFINED); return true; }
  catch { return false; }
};

test('an empty path argument is refused for every workspace-fenced argument', () => {
  const root = workspace();
  try {
    // Read the fenced map out of the module rather than restating it, so a tool
    // added to the fence later is covered here automatically instead of quietly
    // not being.
    const fenced = surface.workspaceFencedArguments
      ? surface.workspaceFencedArguments()
      : { 'search.index': ['root'], 'search.query': ['root'], 'deployment.detect': ['cwd'],
          'launch.plan': ['cwd'], 'launch.detect': ['cwd'], 'terraform.validate': ['cwd'],
          'extension.validate': ['cwd'], 'extension.package': ['cwd', 'outputPath'],
          'drive.upload': ['filePath'] };
    let checked = 0;
    for (const [tool, args] of Object.entries(fenced)) {
      for (const argument of args) {
        assert.equal(admits(tool, { [argument]: '' }, [root]), false,
          `${tool} accepted an empty '${argument}', which resolves to the tool's own default`);
        checked += 1;
      }
    }
    assert.ok(checked >= 9, `only ${checked} fenced arguments were checked; the map is not being read`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a genuinely absent argument still passes, which is the case this must not break', () => {
  // undefined and null mean "not supplied", and the provider substitutes its own
  // installation-owned default. Refusing those too would break every confined
  // caller that legitimately omits an optional argument.
  const root = workspace();
  try {
    assert.equal(admits('deployment.detect', {}, [root]), true, 'an omitted cwd must still be allowed');
    assert.equal(admits('deployment.detect', { cwd: undefined }, [root]), true);
    assert.equal(admits('deployment.detect', { cwd: null }, [root]), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a real path inside the workspace still works, and one outside is still refused', () => {
  // The control. Without it, a fence that refused everything would satisfy the
  // first case in this file and look like a fix.
  const root = workspace();
  try {
    assert.equal(admits('deployment.detect', { cwd: path.join(root, 'project') }, [root]), true,
      'a path inside the workspace must still be admitted');
    assert.equal(admits('deployment.detect', { cwd: root }, [root]), true,
      'the workspace root itself must still be admitted');
    assert.equal(admits('deployment.detect', { cwd: '/etc' }, [root]), false,
      'a path outside the workspace must still be refused');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the schema does not stop this, which is why the fence has to', () => {
  // search.index's root is REQUIRED, so it is tempting to assume an empty value
  // cannot arrive. It can: `required` only asks whether the key is present.
  const entry = TOOL_REGISTRY.find(tool => tool.name === 'search.index');
  assert.ok(entry.inputSchema.required.includes('root'), 'root is required');
  assert.equal(entry.inputSchema.properties.root.minLength, undefined,
    'root has no minLength, so "" satisfies the schema and reaches the handler');
});
