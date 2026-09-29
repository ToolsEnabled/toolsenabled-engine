// This dependency-free helper lets agents ask a PDF for basic metadata without
// loading the whole document into a model context.

const fs = require('fs').promises;

const PDF_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Extract basic metadata from a PDF without throwing for expected input errors.
 * @param {string} filePath
 * @returns {Promise<{ok:boolean,pageCount?:number,bytes?:number,encrypted?:boolean,producer?:string|null,title?:string|null,error?:string}>}
 */
async function pdfInfo(filePath) {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, error: 'PDF_NOT_FOUND' };
    throw error;
  }

  if (stats.size > PDF_MAX_BYTES) return { ok: false, error: 'PDF_TOO_LARGE' };

  const buffer = await fs.readFile(filePath);
  if (buffer.length > PDF_MAX_BYTES) return { ok: false, error: 'PDF_TOO_LARGE' };
  if (buffer.length < 5) return { ok: false, error: 'PDF_INVALID' };
  if (buffer.toString('utf8', 0, 5) !== '%PDF-') return { ok: false, error: 'PDF_INVALID' };

  const content = buffer.toString('binary');
  const encrypted = /\/Encrypt\b/.test(content);
  const producerMatch = content.match(/\/Producer\s*\(([^)]{0,200})\)/);
  const titleMatch = content.match(/\/Title\s*\(([^)]{0,200})\)/);
  const producer = producerMatch ? producerMatch[1] : null;
  const title = titleMatch ? titleMatch[1] : null;

  let pageCount = 0;
  const pagesCountRegex = /\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g;
  const counts = [];
  let match;
  while ((match = pagesCountRegex.exec(content)) !== null) counts.push(parseInt(match[1], 10));
  if (counts.length > 0) {
    pageCount = Math.max(...counts);
  } else {
    const pageMatches = content.match(/\/Type\s*\/Page[^s]/g);
    if (!pageMatches) return { ok: false, error: 'PDF_PAGE_COUNT_UNAVAILABLE' };
    pageCount = pageMatches.length;
  }

  return { ok: true, pageCount, bytes: buffer.length, encrypted, producer, title };
}

module.exports = { pdfInfo, PDF_MAX_BYTES };
