'use strict';

const assert = require('node:assert/strict');
const registry = require('../../../src/providers/provider-registry');
const ScriptedFakeProvider = require('../../helpers/scripted-provider');

function testProviderRegistry() {
  console.log('🧪 Testing ProviderRegistry...');

  const fake1 = new ScriptedFakeProvider();
  const fake2 = new ScriptedFakeProvider();

  // Test 1: Register provider
  registry.register('fake1', fake1);
  assert.equal(registry.get('fake1'), fake1);
  assert.throws(() => registry.get(), /must be selected explicitly/);
  registry.register('fake1', fake1, true);
  assert.equal(registry.get(), fake1);
  console.log('  ✅ Provider registration passed.');

  // Test 2: Register second provider
  registry.register('fake2', fake2);
  assert.equal(registry.get('fake2'), fake2);
  assert.deepEqual(registry.list(), ['fake1', 'fake2']);
  console.log('  ✅ Multiple provider handling passed.');

  // Test 3: Unregistered provider error
  assert.throws(() => {
    registry.get('unknown');
  }, /Provider 'unknown' is not registered/);
  console.log('  ✅ Unregistered provider lookup error passed.');

  // Test 4: Falsy provider IDs are looked up rather than collapsed into the default
  const emptyIdProvider = new ScriptedFakeProvider();
  registry.register('', emptyIdProvider);
  assert.equal(registry.get(''), emptyIdProvider);
  assert.equal(registry.get(), fake1);
  console.log('  ✅ Falsy provider ID handling passed.');

  console.log('🎉 ALL PROVIDER REGISTRY TESTS PASSED CLEANLY!\n');
}

testProviderRegistry();
