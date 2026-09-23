'use strict';

const fs = require('node:fs');

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  if (!prompt.includes('SUPERVISOR DIRECTIVES SINCE YOUR LAST RUN')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (!prompt.includes('checkpoint-marker-r1146')) process.exit(8);
  if (!prompt.includes('resume-after-deliberate-kill')) process.exit(9);
  fs.writeFileSync(process.argv[2], prompt, 'utf8');
  process.stdout.write('VERDICT: respawn received checkpoint and queued direction\n');
});
