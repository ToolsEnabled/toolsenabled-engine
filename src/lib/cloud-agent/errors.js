'use strict';

// The one error type every cloud-agent module throws. A bounded `.code`
// lets a caller branch on failure kind without parsing message text.
class CloudAgentError extends Error {
  // `details` is optional and carries STRUCTURE the message can only describe.
  // It exists for the same reason `.code` does, one step further on: a batch
  // admission refuses with a list of findings, and a caller that had to
  // recover that list by parsing the sentence would be doing exactly the
  // message-parsing this class was written to avoid. Omitted, it is absent
  // rather than an empty object, so "this refusal carries no structure" and
  // "this refusal carries none yet" stay distinguishable.
  constructor(code, message, details) {
    super(message);
    this.name = 'CloudAgentError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { CloudAgentError };
