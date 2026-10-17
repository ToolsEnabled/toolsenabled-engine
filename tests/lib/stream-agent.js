'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A person's own stream-json descriptor: tests use it as a second,
// person-added agent beside the bundled ones.
function install(env = process.env) {
  const descriptor = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/agents/claude.json'), 'utf8'));
  descriptor.id = 'sample-stream';
  descriptor.name = 'Sample Stream Agent';
  descriptor.command = 'sample-stream';
  delete descriptor.worker.held;
  descriptor.models.choices = Object.fromEntries(Object.entries(descriptor.models.choices)
    .map(([key, value]) => [key.replace(/^claude-/, 'sample-'), value]));
  descriptor.models.defaults = Object.fromEntries(Object.entries(descriptor.models.defaults)
    .map(([key, value]) => [key, value.replace(/^claude-/, 'sample-')]));
  const directory = path.join(env.TOOLSENABLED_STATE_ROOT, 'agents');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'sample-stream.json'), JSON.stringify(descriptor), { mode: 0o600 });
  return descriptor;
}

module.exports = Object.freeze({ install });
