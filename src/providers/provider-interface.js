'use strict';

/**
 * Model Provider Abstract Interface Contract
 */
class ModelProviderInterface {
  async listModels() {
    throw new Error('listModels() must be implemented by subclass');
  }

  async testCapability(model, capability) {
    throw new Error('testCapability() must be implemented by subclass');
  }

  async generate(request, signal) {
    throw new Error('generate() must be implemented by subclass');
  }

  async *stream(request, signal) {
    throw new Error('stream() must be implemented by subclass');
  }
}

module.exports = ModelProviderInterface;
