'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [initialCapture, respawnCapture, promptReady, allowUpdate, checkpointReady] = process.argv.slice(2);
const UPDATED_CHECKPOINT = 'updated-checkpoint-from-first-mission-bridge-run\n';

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function replaceAtomically(file, content) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, content, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* best effort fixture cleanup */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort fixture cleanup */ }
  }
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const match = prompt.match(/^Relative checkpoint path from the selected project root: ([^\r\n]+)$/m);
  if (!match) process.exit(5);
  const relative = match[1].trim();
  if (path.isAbsolute(relative) || relative.split('/').includes('..')) process.exit(6);
  const root = fs.realpathSync.native(process.cwd());
  const checkpoint = path.resolve(root, ...relative.split('/'));
  const parent = fs.realpathSync.native(path.dirname(checkpoint));
  if (!inside(root, checkpoint) || !inside(root, parent)) process.exit(7);

  if (prompt.includes('SUPERVISOR DIRECTIVES SINCE YOUR LAST RUN')) {
    if (!prompt.includes('CHECKPOINT FROM THE PRIOR RUN')
        || !prompt.includes(UPDATED_CHECKPOINT.trim())
        || !prompt.includes('resume-phase3-from-updated-checkpoint')) process.exit(8);
    fs.writeFileSync(respawnCapture, prompt, 'utf8');
    process.stdout.write('VERDICT: mission bridge respawn consumed updated checkpoint and supervisor directive\n');
    return;
  }

  if (!prompt.includes('INITIAL CHECKPOINT SEED (no prior progress')
      || prompt.includes('CHECKPOINT FROM THE PRIOR RUN')) process.exit(9);
  fs.writeFileSync(initialCapture, prompt, 'utf8');
  fs.writeFileSync(promptReady, 'ready\n', 'utf8');
  const timer = setInterval(() => {
    if (!fs.existsSync(allowUpdate)) return;
    clearInterval(timer);
    const seed = fs.readFileSync(checkpoint, 'utf8');
    if (!seed.includes('no child-authored progress has been recorded')) process.exit(10);
    replaceAtomically(checkpoint, UPDATED_CHECKPOINT);
    fs.writeFileSync(checkpointReady, 'ready\n', 'utf8');
    setInterval(() => {}, 1000);
  }, 20);
});
