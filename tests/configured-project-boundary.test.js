/* Mutation coverage:
 * Replaced the module's descendant-boundary return expression with `return true`.
 * The mutation landed: yes (the edited line was found in the module).
 * This isolated test went red: yes (a sibling-prefix escape was accepted).
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const boundary = require('../src/lib/configured-project-boundary.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function missing(code = 'ENOENT') {
  return Object.assign(new Error(code), { code });
}

function ioFixture({ files = new Map(), existing = new Set(), readError, statError } = {}) {
  return {
    readFileSync(file, encoding) {
      assert.equal(encoding, 'utf8');
      if (readError) throw readError;
      if (!files.has(file)) throw missing();
      return files.get(file);
    },
    statSync(file) {
      if (statError) throw statError;
      if (!existing.has(file)) throw missing();
      return { isDirectory: () => true };
    }
  };
}

function run() {
  process.stdout.write('configured-project-boundary\n');

  check('reads trimmed current settings before the current install-local file', () => {
    const io = ioFixture({
      files: new Map([[boundary.LOCAL_CONFIG_FILE, JSON.stringify({ root: '/from-file', storeItemId: 'file-id' })]])
    });
    const env = {
      [boundary.ROOT_ENV_VAR]: '  /current/root  ',
      [boundary.STORE_ITEM_ID_ENV_VAR]: ' current-id '
    };
    assert.equal(boundary.readConfiguredRoot({ env, io }), '/current/root');
    assert.equal(boundary.protectedStoreItemId({ env, io }), 'current-id');
    assert.equal(boundary.readConfiguredValue('CURRENT', 'root', { env: { CURRENT: ' ' }, io }), '/from-file');

    const historicalRootName = ['TOOLSENABLED', 'AI', 'CALENDAR', 'ROOT'].join('_');
    assert.equal(boundary.readConfiguredRoot({
      env: { [historicalRootName]: '/historical/root' },
      io: ioFixture()
    }), null, 'a historical project-specific environment name must grant no boundary authority');
  });

  check('falls back to the current local file and rejects malformed configured values', () => {
    const configured = ioFixture({
      files: new Map([[boundary.LOCAL_CONFIG_FILE, JSON.stringify({ root: ' /file/root ', storeItemId: ' file-id ' })]])
    });
    assert.equal(boundary.readConfiguredRoot({ env: {}, io: configured }), '/file/root');
    assert.equal(boundary.protectedStoreItemId({ env: {}, io: configured }), 'file-id');

    const malformed = ioFixture({ files: new Map([[boundary.LOCAL_CONFIG_FILE, '{not-json']]) });
    assert.throws(() => boundary.readConfiguredRoot({ env: {}, io: malformed }), SyntaxError);
    const wrongType = ioFixture({ files: new Map([[boundary.LOCAL_CONFIG_FILE, JSON.stringify({ root: 42 })]]) });
    assert.throws(() => boundary.readConfiguredRoot({ env: {}, io: wrongType }), TypeError);
  });

  check('distinguishes absent, ready, missing, and failed root checks', () => {
    assert.deepEqual(boundary.configuredRootStatus({ env: {}, io: ioFixture() }), {
      state: boundary.STATE.NOT_CONFIGURED, root: null
    });

    const root = path.resolve('/configured/project');
    const ready = boundary.configuredRootStatus({
      env: { [boundary.ROOT_ENV_VAR]: root },
      io: ioFixture({ existing: new Set([root]) })
    });
    assert.deepEqual(ready, { state: boundary.STATE.READY, root });
    assert.equal(Object.isFrozen(ready), true);
    assert.deepEqual(boundary.configuredRootStatus({
      env: { [boundary.ROOT_ENV_VAR]: root }, io: ioFixture()
    }), { state: boundary.STATE.MISSING, root });
    assert.deepEqual(boundary.configuredRootStatus({
      env: { [boundary.ROOT_ENV_VAR]: root }, io: ioFixture({ statError: missing('EACCES') })
    }), { state: boundary.STATE.CHECK_FAILED, root });
    assert.deepEqual(boundary.configuredRootStatus({
      env: {}, io: ioFixture({ readError: missing('EACCES') })
    }), { state: boundary.STATE.CHECK_FAILED, root: null });
  });

  check('resolves only a ready root and refuses an indeterminate check', () => {
    const root = path.resolve('/configured/project');
    assert.equal(boundary.resolveConfiguredRoot({ env: {}, io: ioFixture() }), null);
    assert.equal(boundary.resolveConfiguredRoot({
      env: { [boundary.ROOT_ENV_VAR]: root }, io: ioFixture({ existing: new Set([root]) })
    }), root);
    assert.throws(() => boundary.resolveConfiguredRoot({
      env: { [boundary.ROOT_ENV_VAR]: root }, io: ioFixture({ statError: missing('EACCES') })
    }), /Could not establish/);
  });

  check('matches only the exact configured Store item id', () => {
    const options = { env: { [boundary.STORE_ITEM_ID_ENV_VAR]: 'protected-id' }, io: ioFixture() };
    assert.equal(boundary.isProtectedStoreItem('protected-id', options), true);
    assert.equal(boundary.isProtectedStoreItem('other-id', options), false);
    assert.equal(boundary.isProtectedStoreItem('', options), false);
    assert.equal(boundary.isProtectedStoreItem(null, options), false);
    assert.equal(boundary.isProtectedStoreItem('protected-id', { env: {}, io: ioFixture() }), false);
  });

  check('accepts the configured root and descendants but rejects sibling-prefix escapes', () => {
    const root = path.resolve('/configured/project');
    const options = {
      env: { [boundary.ROOT_ENV_VAR]: root },
      io: ioFixture({ existing: new Set([root]) })
    };
    assert.equal(boundary.isWithinConfiguredRoot(root, options), true);
    assert.equal(boundary.isWithinConfiguredRoot(path.join(root, 'dist', 'extension.zip'), options), true);
    assert.equal(boundary.isWithinConfiguredRoot(path.resolve('/configured/project-escape/file'), options), false);
    assert.equal(boundary.isWithinConfiguredRoot(path.resolve('/configured/other/file'), options), false);
    assert.equal(boundary.isWithinConfiguredRoot(root, { env: {}, io: ioFixture() }), false);
    assert.throws(() => boundary.isWithinConfiguredRoot(root, {
      env: { [boundary.ROOT_ENV_VAR]: root }, io: ioFixture()
    }), /configured-but-missing/);
  });

  process.stdout.write(`\nconfigured-project-boundary: ${passed} checks passed\n`);
}

try {
  run();
} catch (error) {
  process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`);
  process.exitCode = 1;
}
