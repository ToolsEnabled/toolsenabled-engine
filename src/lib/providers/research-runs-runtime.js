'use strict';

// Research owns its original native Job and private worker DB-close channel.
// Public status is descriptive, never a cleanup/migration receipt. The shared
// process registry is the same facade retained by the app's shutdown join.
const { getResearchWorkerSupervisor } = require('../research/worker-supervisor');

function retext(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/overnight advisory worker/gi, 'research worker')
    .replace(/overnight advisory/gi, 'research')
    .replace(/\badvisory\b/gi, 'research');
}

function recode(error) {
  if (error && typeof error.code === 'string' && error.code.startsWith('OVERNIGHT_ADVISORY_')) {
    error.code = error.code.startsWith('OVERNIGHT_ADVISORY_WORKER_')
      ? error.code.replace('OVERNIGHT_ADVISORY_WORKER_', 'RESEARCH_WORKER_')
      : error.code.replace('OVERNIGHT_ADVISORY_', 'RESEARCH_WORKER_');
  }
  if (error && typeof error.message === 'string') {
    error.message = retext(error.message);
  }
  return error;
}

function restatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    const error = new Error('The research worker lifecycle result could not be established.');
    error.code = 'RESEARCH_WORKER_RESULT_INVALID';
    throw error;
  }
  if (typeof status.detail === 'string') return { ...status, detail: retext(status.detail) };
  return status;
}

class ResearchRunsWorkerRuntime {
  constructor(options = {}) {
    this.inner = options.supervisor || getResearchWorkerSupervisor(options);
  }

  status() {
    try {
      const status = restatus(this.inner.snapshot());
      return { ...status, detail: status.reasonCode
        ? 'The research worker lifetime is unknown; its original owner must establish cleanup. No PID or elapsed-time guess can clear it.'
        : undefined };
    }
    catch (error) { throw recode(error); }
  }

  async start(input) {
    try { return restatus(await this.inner.start(input)); }
    catch (error) { throw recode(error); }
  }

  async stop(input) {
    try { return restatus(await this.inner.stop(input)); }
    catch (error) { throw recode(error); }
  }
}

module.exports = { ResearchRunsWorkerRuntime };
