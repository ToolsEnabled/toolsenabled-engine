const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const docIntel = require('../../src/lib/providers/doc-intel.js');
const { pdfInfo, PDF_MAX_BYTES } = docIntel;

async function withRefusalGuards({ stat, readFile }, run) {
  const originalStat = fs.stat;
  const originalReadFile = fs.readFile;
  const originalWriteFile = fs.writeFile;
  const originalSpawn = childProcess.spawn;
  let writes = 0;
  let spawns = 0;

  fs.stat = stat;
  fs.readFile = readFile;
  fs.writeFile = async (...args) => {
    writes += 1;
    throw new Error(`size refusal attempted a write to ${String(args[0])}`);
  };
  childProcess.spawn = (...args) => {
    spawns += 1;
    throw new Error(`size refusal attempted to spawn ${String(args[0])}`);
  };

  try {
    await run();
    assert.equal(writes, 0, 'a size refusal must not write anything');
    assert.equal(spawns, 0, 'a size refusal must not spawn a process');
  } finally {
    fs.stat = originalStat;
    fs.readFile = originalReadFile;
    fs.writeFile = originalWriteFile;
    childProcess.spawn = originalSpawn;
  }
}

async function runTests() {
  let checkCount = 0;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-intel-tests-'));
  try {
    const pdfPath = path.join(tempDir, 'test.pdf');
    await fs.writeFile(pdfPath, Buffer.from('%PDF-1.4\n<< /Type /Pages /Count 3 >>'));
    assert.strictEqual((await pdfInfo(pdfPath)).pageCount, 3);
    checkCount++;

    const notPdfPath = path.join(tempDir, 'not-a-pdf.txt');
    await fs.writeFile(notPdfPath, 'This is just text.');
    assert.deepStrictEqual(await pdfInfo(notPdfPath), { ok: false, error: 'PDF_INVALID' });
    checkCount++;

    assert.deepStrictEqual(await pdfInfo(path.join(tempDir, 'missing.pdf')), { ok: false, error: 'PDF_NOT_FOUND' });
    checkCount++;

    const encryptedPath = path.join(tempDir, 'encrypted.pdf');
    await fs.writeFile(encryptedPath, Buffer.from('%PDF-1.4\n/Encrypt\n<< /Type /Pages /Count 1 >>'));
    assert.strictEqual((await pdfInfo(encryptedPath)).encrypted, true);
    checkCount++;

    const unreadablePageCountPath = path.join(tempDir, 'unreadable-page-count.pdf');
    await fs.writeFile(unreadablePageCountPath, Buffer.from('%PDF-1.4\n<< /Type /Catalog >>'));
    assert.deepStrictEqual(await pdfInfo(unreadablePageCountPath), {
      ok: false,
      error: 'PDF_PAGE_COUNT_UNAVAILABLE',
    });
    checkCount++;

    // The pre-read limit must refuse from metadata alone. The read dependency
    // deliberately throws so this cannot pass by reaching the later duplicate
    // check, and the guards prove refusal has no write/process side effects.
    await withRefusalGuards({
      stat: async () => ({ size: PDF_MAX_BYTES + 1 }),
      readFile: async () => { throw new Error('oversized metadata must prevent reading'); },
    }, async () => {
      assert.deepStrictEqual(await pdfInfo('/fixture/oversized-before-read.pdf'), {
        ok: false,
        error: 'PDF_TOO_LARGE',
      });
    });
    checkCount++;

    // A file can grow between stat and read. Drive that race explicitly so the
    // post-read limit is independently covered rather than hidden by stat.
    await withRefusalGuards({
      stat: async () => ({ size: PDF_MAX_BYTES }),
      readFile: async () => Buffer.alloc(PDF_MAX_BYTES + 1),
    }, async () => {
      assert.deepStrictEqual(await pdfInfo('/fixture/grew-during-read.pdf'), {
        ok: false,
        error: 'PDF_TOO_LARGE',
      });
    });
    checkCount++;

    console.log(`doc-intel tests passed (${checkCount} checks).`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

runTests().catch(error => {
  console.error('Test failed:', error);
  process.exitCode = 1;
});
