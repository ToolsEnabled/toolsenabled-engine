'use strict';

// Thin CLI over the Drive provider so uploads are hands-off from the shell or a
// scheduled job. Requires a one-time `node tools/google-oauth-login.js` first.
//
//   node tools/drive-upload.js --find "Joshua Pickard"
//   node tools/drive-upload.js --file "C:\path\Personal Statement.docx" --folder <folderId> [--name "Personal Statement.docx"]
//
// With no credentials in the vault the provider throws a clear setup error.

const { driveUpload, driveFindFolder } = require('../src/lib/providers/drive');
// R1162 seccouncil Stage 1b item 3: `driveUpload`/`driveFindFolder` already
// call the real, non-stubbed policy.assertActive internally, so this CLI was
// not actually bypassing the kill switch. Call it explicitly here too, at the
// entrypoint, so the gate is visible in this file and does not depend on a
// reader tracing into the provider to confirm mediation.
const { assertActive } = require('../src/lib/policy');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main() {
  const account = arg('--account');
  const findName = arg('--find');
  if (findName) {
    assertActive('drive.find');
    const out = await driveFindFolder({ name: findName, account });
    if (!out || !Array.isArray(out.files)) {
      throw new Error('Drive folder search returned no measurable file list.');
    }
    const files = out.files;
    if (!files.length) { console.error(`No folder named "${findName}" is visible to this account.`); process.exit(1); }
    for (const f of files) {
      const owner = (f.owners && f.owners[0] && (f.owners[0].displayName || f.owners[0].emailAddress)) || 'shared drive';
      console.log(`${f.id}\t${f.name}\t(${owner})`);
    }
    return;
  }

  const filePath = arg('--file');
  if (!filePath) {
    console.error('Usage:\n  node tools/drive-upload.js --find "<folder name>"\n'
      + '  node tools/drive-upload.js --file "<path>" --folder <folderId> [--name "<name>"]');
    process.exit(2);
  }
  assertActive('drive.upload');
  const result = await driveUpload({
    filePath, folderId: arg('--folder') || null, name: arg('--name'), account
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(e => { console.error('Upload error:', e.message); process.exit(1); });
