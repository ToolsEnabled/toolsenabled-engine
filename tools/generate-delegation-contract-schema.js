'use strict';

const fs = require('node:fs');
const path = require('node:path');
const contracts = require('../src/lib/delegation-contracts');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'schemas', 'generated', 'delegation-contracts.schema.json');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function rendered() { return `${JSON.stringify(stable(contracts.schemaDocument()), null, 2)}\n`; }
function generate({ check = false } = {}) {
  const output = rendered();
  if (check) {
    if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8') !== output) throw new Error('delegation contract schema is stale');
  } else {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, output, 'utf8');
  }
  return output;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('only --check is supported');
  generate({ check: args[0] === '--check' });
  process.stdout.write(`Delegation contract schema ${args[0] === '--check' ? 'verified' : 'generated'}.\n`);
}
module.exports = { OUTPUT, generate, rendered, stable };
