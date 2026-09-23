'use strict';

/* A lane child that does nothing but prove it was started and then stop.
 *
 * It exists so tests/loop-guided-child-confinement.test.js can assert the argv
 * that REACHED A REAL SPAWN. The dispatch path composes the child command as
 * `[...command.prefixArgs, ...generatedArgs]`
 * (src/lib/mission-bridge/actions.js:628), so this fixture is passed as a prefix
 * argument and the real confinement argv arrives after it as trailing argv this
 * file deliberately ignores. That is the point: the flags under test are the
 * ones the product actually built, not a stand-in the test injected.
 *
 * It writes the argv it was given to the file named by its first argument, so
 * the assertion can be made against what the CHILD saw rather than against what
 * the parent believes it sent.
 */

const fs = require('node:fs');

const [argvCapture] = process.argv.slice(2);

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  try {
    fs.writeFileSync(argvCapture, JSON.stringify({
      argv: process.argv.slice(2),
      promptBytes: Buffer.byteLength(prompt, 'utf8')
    }), 'utf8');
  } catch { /* the test fails on the missing capture, which is the honest signal */ }
  process.stdout.write('VERDICT: loop confinement fixture observed its argv\n');
});
