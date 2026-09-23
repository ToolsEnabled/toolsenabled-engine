'use strict';

const { imageLockWrite, imageTag } = require('../src/lib/providers/agent-sandbox');

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--image-tag') process.stdout.write(`${imageTag()}\n`);
  else {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--scoped')) throw new Error('Use --image-tag, --scoped, or no arguments for a legacy image lock.');
    const lock = imageLockWrite(args[0] === '--scoped' ? imageTag() : undefined);
    process.stdout.write(`${JSON.stringify({
      status: 'locked',
      contract: lock.contract,
      imageId: lock.imageId,
      contextSha256: lock.contextSha256
    })}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.code || 'SANDBOX_IMAGE_LOCK_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
}
