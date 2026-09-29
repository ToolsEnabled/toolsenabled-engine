'use strict';

// R1162 P9 -- this deliberately edits the JSON text rather than stringify-ing
// the parsed ledger.  `verbatim` is evidence, so migration may add only the
// availability marker and must preserve every pre-existing byte (including
// escaping choices) in request and verbatim strings.

const fs = require('node:fs/promises');
const path = require('node:path');
const { acquireLedgerLock } = require('./owner-capture');

const DEFAULT_FILES = Object.freeze([
  path.join(__dirname, '..', 'reports', 'OWNER-REQUEST-LEDGER.json'),
  path.join(__dirname, '..', 'reports', 'OWNER-REQUEST-LEDGER.json.bak')
]);

class VerbatimMigrationError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'VerbatimMigrationError';
    this.exitCode = code;
  }
}

function skipWhitespace(text, index) {
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function scanString(text, index) {
  if (text[index] !== '"') throw new VerbatimMigrationError('Expected a JSON string.', 3);
  index += 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '"') return index + 1;
    index += 1;
  }
  throw new VerbatimMigrationError('Unterminated JSON string.', 3);
}

function scanValue(text, index) {
  index = skipWhitespace(text, index);
  const start = index;
  const character = text[index];
  if (character === '"') return { start, end: scanString(text, index) };
  if (character === '{' || character === '[') {
    const closing = character === '{' ? '}' : ']';
    index += 1;
    index = skipWhitespace(text, index);
    if (text[index] === closing) return { start, end: index + 1 };
    while (index < text.length) {
      if (character === '{') {
        const keyEnd = scanString(text, index);
        index = skipWhitespace(text, keyEnd);
        if (text[index] !== ':') throw new VerbatimMigrationError('Malformed JSON object.', 3);
        index = scanValue(text, index + 1).end;
      } else {
        index = scanValue(text, index).end;
      }
      index = skipWhitespace(text, index);
      if (text[index] === closing) return { start, end: index + 1 };
      if (text[index] !== ',') throw new VerbatimMigrationError('Malformed JSON collection.', 3);
      index = skipWhitespace(text, index + 1);
    }
    throw new VerbatimMigrationError('Unterminated JSON collection.', 3);
  }
  while (index < text.length && !/[\s,}\]]/.test(text[index])) index += 1;
  if (index === start) throw new VerbatimMigrationError('Malformed JSON value.', 3);
  return { start, end: index };
}

function objectMembers(text, objectStart) {
  if (text[objectStart] !== '{') throw new VerbatimMigrationError('Expected ledger root object.', 3);
  const members = [];
  let index = skipWhitespace(text, objectStart + 1);
  if (text[index] === '}') return members;
  while (index < text.length) {
    const keyStart = index;
    const keyEnd = scanString(text, index);
    let key;
    try { key = JSON.parse(text.slice(keyStart, keyEnd)); }
    catch { throw new VerbatimMigrationError('Malformed JSON object key.', 3); }
    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ':') throw new VerbatimMigrationError('Malformed JSON object.', 3);
    const value = scanValue(text, index + 1);
    members.push({ key, value });
    index = skipWhitespace(text, value.end);
    if (text[index] === '}') return members;
    if (text[index] !== ',') throw new VerbatimMigrationError('Malformed JSON object.', 3);
    index = skipWhitespace(text, index + 1);
  }
  throw new VerbatimMigrationError('Unterminated JSON object.', 3);
}

function requestObjectSpans(text) {
  const rootStart = skipWhitespace(text, 0);
  const rootMembers = objectMembers(text, rootStart);
  const requests = rootMembers.filter(member => member.key === 'requests');
  if (requests.length !== 1 || text[requests[0].value.start] !== '[') {
    throw new VerbatimMigrationError('Ledger must contain exactly one requests array.', 3);
  }
  const spans = [];
  let index = skipWhitespace(text, requests[0].value.start + 1);
  if (text[index] === ']') return spans;
  while (index < text.length) {
    const value = scanValue(text, index);
    if (text[value.start] !== '{') throw new VerbatimMigrationError('Each ledger request must be an object.', 3);
    spans.push(value);
    index = skipWhitespace(text, value.end);
    if (text[index] === ']') return spans;
    if (text[index] !== ',') throw new VerbatimMigrationError('Malformed requests array.', 3);
    index = skipWhitespace(text, index + 1);
  }
  throw new VerbatimMigrationError('Unterminated requests array.', 3);
}

function migrateLedgerText(text, { advanceRevision = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  let ledger;
  try { ledger = JSON.parse(text); }
  catch { throw new VerbatimMigrationError('Ledger JSON is malformed.', 3); }
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || !Array.isArray(ledger.requests)) {
    throw new VerbatimMigrationError('Ledger must be an object with a requests array.', 3);
  }
  const rootStart = skipWhitespace(text, 0);
  const rootMembers = objectMembers(text, rootStart);
  const spans = requestObjectSpans(text);
  if (spans.length !== ledger.requests.length) {
    throw new VerbatimMigrationError('Ledger request text does not match parsed requests.', 3);
  }
  const inserts = [];
  const changedIds = [];
  for (let index = 0; index < ledger.requests.length; index += 1) {
    const request = ledger.requests[index];
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.id !== 'string') {
      throw new VerbatimMigrationError(`Invalid request at index ${index}.`, 3);
    }
    const hasVerbatim = Object.hasOwn(request, 'verbatim');
    const marker = request.verbatimAvailable;
    if (hasVerbatim && marker === false) {
      throw new VerbatimMigrationError(`Request ${request.id} has verbatim and cannot be marked unavailable.`, 3);
    }
    if (hasVerbatim || marker === false) continue;
    if (marker !== undefined) {
      throw new VerbatimMigrationError(`Request ${request.id} has an invalid verbatimAvailable marker.`, 3);
    }
    // Insert immediately before the object's final brace.  This is the only
    // mutation: all original bytes remain in their original order.
    inserts.push({ index: spans[index].end - 1, text: ', "verbatimAvailable": false' });
    changedIds.push(request.id);
  }
  const edits = inserts;
  let revisionBefore = null;
  let revisionAfter = null;
  if (changedIds.length > 0 && advanceRevision) {
    if (!Number.isInteger(ledger.revision) || ledger.revision < 0 || typeof ledger.updatedAt !== 'string') {
      throw new VerbatimMigrationError('Active ledger must have an integer revision and string updatedAt before migration.', 3);
    }
    const revisionMember = rootMembers.find(member => member.key === 'revision');
    const updatedAtMember = rootMembers.find(member => member.key === 'updatedAt');
    if (!revisionMember || !updatedAtMember) throw new VerbatimMigrationError('Active ledger is missing revision metadata.', 3);
    revisionBefore = ledger.revision;
    revisionAfter = ledger.revision + 1;
    edits.push({ index: revisionMember.value.start, end: revisionMember.value.end, text: String(revisionAfter) });
    edits.push({ index: updatedAtMember.value.start, end: updatedAtMember.value.end, text: JSON.stringify(today) });
  }
  let migrated = text;
  for (const edit of edits.sort((left, right) => right.index - left.index)) {
    migrated = `${migrated.slice(0, edit.index)}${edit.text}${migrated.slice(edit.end === undefined ? edit.index : edit.end)}`;
  }
  return Object.freeze({ text: migrated, changedIds: Object.freeze(changedIds), revisionBefore, revisionAfter });
}

async function migrateFile(file, { write = false, advanceRevision = path.resolve(file) === path.resolve(DEFAULT_FILES[0]) } = {}) {
  const original = await fs.readFile(file, 'utf8');
  const result = migrateLedgerText(original, { advanceRevision });
  if (write && result.changedIds.length > 0) {
    const temporary = `${file}.verbatim-migration-${process.pid}.tmp`;
    await fs.writeFile(temporary, result.text, 'utf8');
    await fs.rename(temporary, file);
  }
  return Object.freeze({
    file, changedIds: result.changedIds, changed: result.changedIds.length > 0,
    revisionBefore: result.revisionBefore, revisionAfter: result.revisionAfter
  });
}

async function stageMigration(files = DEFAULT_FILES) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new VerbatimMigrationError('Migration requires at least one ledger file.', 3);
  }
  const staged = [];
  for (const file of files) {
    const original = await fs.readFile(file, 'utf8');
    const advanceRevision = path.resolve(file) === path.resolve(DEFAULT_FILES[0]);
    const result = migrateLedgerText(original, { advanceRevision });
    const temporary = result.changedIds.length > 0
      ? `${file}.verbatim-migration-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`
      : null;
    if (temporary) {
      await fs.writeFile(temporary, result.text, 'utf8');
      const stagedText = await fs.readFile(temporary, 'utf8');
      JSON.parse(stagedText);
      if (migrateLedgerText(stagedText, { advanceRevision }).changedIds.length !== 0) {
        throw new VerbatimMigrationError(`Staged migration for ${file} is not idempotent.`, 4);
      }
    }
    staged.push({ file, original, temporary, result });
  }
  return staged;
}

async function restoreFile(file, original) {
  const temporary = `${file}.verbatim-migration-rollback-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, original, 'utf8');
  await fs.rename(temporary, file);
}

// The active ledger and its historical backup are a paired evidence set. A
// writer must not race owner-capture, and a failed second rename must be
// reported only after an attempted restore of anything already committed.
async function migrateAllFiles({ files = DEFAULT_FILES, write = false, acquireLock = acquireLedgerLock } = {}) {
  const lock = write ? acquireLock(DEFAULT_FILES[0]) : null;
  let staged = [];
  const results = [];
  try {
    staged = await stageMigration(files);
    if (write) {
      const committed = [];
      try {
        for (const item of staged) {
          if (!item.temporary) continue;
          await fs.rename(item.temporary, item.file);
          committed.push(item);
        }
      } catch (error) {
        let rollbackFailure = null;
        for (const item of committed.reverse()) {
          try { await restoreFile(item.file, item.original); }
          catch (restoreError) { rollbackFailure = restoreError; }
        }
        throw new VerbatimMigrationError(
          rollbackFailure
            ? `Paired ledger migration failed and rollback also failed: ${rollbackFailure.message}`
            : `Paired ledger migration failed; committed files were restored: ${error.message}`,
          5
        );
      }
    }
    for (const item of staged) {
      results.push(Object.freeze({
        file: item.file, changedIds: item.result.changedIds, changed: item.result.changedIds.length > 0,
        revisionBefore: item.result.revisionBefore, revisionAfter: item.result.revisionAfter
      }));
    }
    return Object.freeze(results);
  } finally {
    let cleanupFailure = null;
    for (const item of staged) {
      if (item.temporary) {
        try { await fs.unlink(item.temporary); }
        catch (error) {
          // A successful rename removes the temporary path.  Any other cleanup
          // failure is unknown state and must not be reported as a clean run.
          if (error.code !== 'ENOENT') cleanupFailure = cleanupFailure || error;
        }
      }
    }
    if (lock) lock.release();
    if (cleanupFailure) throw cleanupFailure;
  }
}

async function main(argv = process.argv) {
  const args = argv.slice(2);
  if (args.some(arg => !['--write', '--check'].includes(arg)) || args.filter(arg => arg === '--write').length > 1 || args.filter(arg => arg === '--check').length > 1 || (args.includes('--write') && args.includes('--check'))) {
    throw new VerbatimMigrationError('Usage: node tools/ledger-verbatim-migration.js [--check|--write]', 2);
  }
  const write = args.includes('--write');
  const results = await migrateAllFiles({ write });
  console.log(JSON.stringify({ mode: write ? 'write' : 'check', files: results }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Error: ${error.message}`);
    process.exit(error instanceof VerbatimMigrationError ? error.exitCode : 10);
  });
}

module.exports = Object.freeze({
  DEFAULT_FILES,
  VerbatimMigrationError,
  migrateLedgerText,
  migrateFile,
  stageMigration,
  migrateAllFiles
});
