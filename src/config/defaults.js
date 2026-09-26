'use strict';

module.exports = {
  version: 1,
  server: {
    port: 3888,
    host: '127.0.0.1'
  },
  ollama: {
    host: '127.0.0.1',
    port: 11434,
    defaultModel: 'hermes3:8b',
    timeoutMs: 30000
  },
  engine: {
    maxTokenBudget: 8192,
    defaultTemperature: 0.2,
    enableThinkingTags: true
  },
  security: {
    sandboxBoundary: 'ToolsEnabled',
    secretRedaction: true
  }
};
