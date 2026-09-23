'use strict';

// An actual harmless child reports only the argv and selected config-directory
// field it received. It never reads the named MCP/settings files, credentials,
// project instructions, or network. The version probe has no side effects.
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('claude-argv-test-peer 1\n');
  process.exit(0);
}
const root = process.env.TOOLSENABLED_TEST_ROOT;
const output = process.env.TOOLSENABLED_TEST_CLAUDE_ARGV_OUTPUT;
const relative = root && output ? path.relative(root, output) : '..';
if (!root || !output || !path.isAbsolute(output) || !relative
    || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('test-owned argv output required');
const configKeys = Object.keys(process.env).filter(key => key.toUpperCase() === 'CLAUDE_CONFIG_DIR');
fs.writeFileSync(output, JSON.stringify({
  pid: process.pid,
  argv: process.argv.slice(2),
  configDirectories: configKeys.map(key => process.env[key]),
}), { flag: 'wx' });
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const packet = JSON.parse(line);
  if (packet.type === 'control_request' && packet.request?.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: packet.request_id } }) + '\n');
  }
});
process.stdin.once('end', () => process.exit(0));
