'use strict';

const ModelProviderInterface = require('./provider-interface');

class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.defaultProviderId = null;
  }

  register(id, provider, isDefault = false) {
    if (!(provider instanceof ModelProviderInterface)) {
      throw new Error(`Provider ${id} must inherit from ModelProviderInterface`);
    }
    this.providers.set(id, provider);
    // Registration order is not a provider choice.  In particular, loading a
    // hosted adapter before a local one must not quietly make the hosted
    // adapter win.  A default exists only when the caller explicitly declares
    // one with isDefault.
    if (isDefault) this.defaultProviderId = id;
  }

  get(id) {
    if (id === undefined && this.defaultProviderId === null) {
      throw new Error('Provider must be selected explicitly; no default provider is configured');
    }
    const targetId = id ?? this.defaultProviderId;
    const provider = this.providers.get(targetId);
    if (!provider) {
      throw new Error(`Provider '${targetId}' is not registered`);
    }
    return provider;
  }

  list() {
    return Array.from(this.providers.keys());
  }
}

module.exports = new ProviderRegistry();
