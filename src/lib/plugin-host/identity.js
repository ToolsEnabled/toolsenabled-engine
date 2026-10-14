'use strict';

// A PLUGIN'S IDENTITY IS THE HASH OF ITS BYTES. THERE IS NOTHING ELSE TO SQUAT.
//
// The owner's decision, verbatim: "there are no partners yet so everyone other
// than me is a non partner. maybe just hash the package and give it that id or
// something, lets not waste time on unneccassary stuff. Users will need to
// download and add the program seperately, we are not offering a marketplace
// yet."
//
// So there is no registry of names, no publisher field anybody could claim, and
// no signature to check. The id IS the content digest, which buys three things
// for the price of one walk of the directory:
//
//   1. Two plugins cannot collide unless they are byte-identical, in which case
//      they are the same plugin.
//   2. A plugin that changes is a DIFFERENT plugin, so a capability the owner
//      granted cannot silently carry over to code they never saw. See grants.js:
//      a grant records the id, and the id moves when any byte moves.
//   3. There is no name to take. A plugin's name is a label, not a claim.
//
// WHY THE HASH IS LENGTH-PREFIXED AND NOT JOINED.
//
// The obvious implementation -- hash every relative path and its contents in
// sorted order, concatenated -- is NOT INJECTIVE, and the failure is the exact
// defect class this product's own scanner looks for. Concatenating "a/b" with
// "c" and "a" with "b/c" produces the same byte stream, so two different
// packages get one id. A delimiter does not fix it either, because the
// delimiter can occur inside a path or inside a file. Only a length prefix
// makes the boundary unforgeable: the reader always knows where each field
// ends without searching for a marker that the field is allowed to contain.
//
// THE RULE IS PUBLISHED SO AN AUTHOR CAN REPRODUCE IT. A plugin author who
// implements the same walk -- every file in the folder, sorted by relative path,
// each path and each blob length-prefixed, after a commitment to the file count --
// gets the same digest, and
// can therefore print the id their package will be admitted under before handing it
// to anybody. tests/plugin-host-identity.test.js pins the exact digest of an exact
// two-file package so a second implementation can be held to it without this
// repository.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// EVERY FILE IN THE FOLDER IS PART OF THE DIGEST. NOTHING IS SKIPPED.
//
// This walk used to leave out `.git`, `node_modules`, `__pycache__`, `logs`,
// `records`, `*.pyc` and `*.log`, as "run-time output", while the product told
// people "change any file in a plugin and it is a new plugin". That was false in
// the way that matters most (1.0.50 release review F2): node resolves a script's
// `require('dep')` from node_modules, and Python imports a cached or sourceless
// .pyc, without the reviewed code naming either file -- so a dependency changed
// after the person allowed the plugin ran under the old grant, and the measured
// probe ran the changed dependency with no refusal. `.git` is in the same class
// (git runs commands a `.git/config` names when a plugin's script calls git), and
// logs/records/*.log were simply files the person was told counted.
//
// Run-time output has a place that is not the package: the host gives every
// plugin that runs programs a workspace (its cwd and HOME) and, when allowed, a
// storage folder, both under the state root (index.js preparePaths). And the host
// itself never writes into a package: it runs Python with PYTHONDONTWRITEBYTECODE
// set (tool-bridge.js childEnvironment), so a plugin's own imports leave no cache
// beside its scripts. A package that writes into its own folder is a package that
// changed, and it is refused until the person decides about the new version.

// A package is small by construction: a manifest, some JSON, some scripts. The
// ceilings exist so that pointing the host at the wrong directory fails in a
// second with a sentence, instead of hashing a home directory.
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 12;
const ID_PREFIX_LENGTH = 16;

class PluginIdentityError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PluginIdentityError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PluginIdentityError(code, message, details);
}

// Walks the package and returns its files as sorted [relativePath, absolutePath]
// pairs. Symbolic links are REFUSED rather than followed or ignored: a followed
// link would let content outside the package decide the package's id (and could
// point at the owner's private files), and a silently ignored link would let two
// packages with different real contents share an id. Refusing is the only option
// that keeps the id honest, and it is a sentence the author can act on.
function packageFiles(root, { fsImpl = fs } = {}) {
  const absoluteRoot = path.resolve(String(root || ''));
  const found = [];
  let totalBytes = 0;

  const walk = (directory, depth) => {
    if (depth > MAX_DEPTH) {
      fail('PLUGIN_PACKAGE_TOO_DEEP',
        `A plugin package may nest at most ${MAX_DEPTH} directories deep. `
        + `${path.relative(absoluteRoot, directory)} is deeper than that.`);
    }
    let entries;
    try {
      entries = fsImpl.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      fail('PLUGIN_PACKAGE_UNREADABLE',
        `Cannot read ${directory}: ${error && error.message}. `
        + 'A plugin package must be a readable directory on this computer.');
    }
    for (const entry of entries.slice().sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail('PLUGIN_PACKAGE_SYMLINK',
          `${path.relative(absoluteRoot, absolute)} is a symbolic link. A plugin package may not `
          + 'contain links: the identity of a package has to be decided by the package, and a link '
          + 'hands that decision to whatever it points at. Replace the link with the real file.');
      }
      if (entry.isDirectory()) { walk(absolute, depth + 1); continue; }
      if (!entry.isFile()) {
        fail('PLUGIN_PACKAGE_SPECIAL_FILE',
          `${path.relative(absoluteRoot, absolute)} is neither a file nor a directory. `
          + 'A plugin package holds ordinary files only.');
      }
      const relative = path.relative(absoluteRoot, absolute).split(path.sep).join('/');
      found.push([relative, absolute]);
      if (found.length > MAX_FILES) {
        fail('PLUGIN_PACKAGE_TOO_LARGE',
          `A plugin package may hold at most ${MAX_FILES} files, and every file in its folder counts, including `
          + 'any .git or node_modules folder. This looks like the wrong directory, or a package carrying more than '
          + 'its tools run.');
      }
    }
  };

  let stat;
  try { stat = fsImpl.statSync(absoluteRoot); }
  catch (error) {
    fail('PLUGIN_PACKAGE_MISSING',
      `There is nothing at ${absoluteRoot}. Point the host at the directory you unpacked the plugin into.`,
      { cause: error && error.code });
  }
  if (!stat.isDirectory()) {
    fail('PLUGIN_PACKAGE_NOT_DIRECTORY', `${absoluteRoot} is not a directory. A plugin is a directory holding a plugin.json.`);
  }
  walk(absoluteRoot, 0);
  found.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return { root: absoluteRoot, files: found, totalBytes };
}

// The digest. Every field is preceded by its byte length, so the boundary
// between a path and its contents -- and between one file and the next -- cannot
// be moved by anything either field is allowed to contain.
function packageIdentity(root, { fsImpl = fs } = {}) {
  const { root: absoluteRoot, files } = packageFiles(root, { fsImpl });
  const hash = crypto.createHash('sha256');
  // The file COUNT is committed to first, for the same reason each field carries
  // its length: without it, a package and a package with an extra empty-named
  // entry could in principle agree.
  hash.update(Buffer.from(`files:${files.length}\n`, 'utf8'));
  let totalBytes = 0;
  const inventory = [];
  for (const [relative, absolute] of files) {
    let contents;
    try { contents = fsImpl.readFileSync(absolute); }
    catch (error) {
      fail('PLUGIN_PACKAGE_UNREADABLE',
        `Cannot read ${relative}: ${error && error.message}.`);
    }
    totalBytes += contents.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      fail('PLUGIN_PACKAGE_TOO_LARGE',
        `A plugin package may hold at most ${MAX_TOTAL_BYTES} bytes in total, and every file in its folder counts, `
        + 'including any .git or node_modules folder. This looks like the wrong directory, or a package carrying '
        + 'more than its tools run.');
    }
    const relativeBytes = Buffer.from(relative, 'utf8');
    hash.update(Buffer.from(`${relativeBytes.length}:`, 'utf8'));
    hash.update(relativeBytes);
    hash.update(Buffer.from(`${contents.length}:`, 'utf8'));
    hash.update(contents);
    inventory.push(Object.freeze({ path: relative, bytes: contents.length }));
  }
  const sha256 = hash.digest('hex');
  return Object.freeze({
    root: absoluteRoot,
    // The prefix is for humans reading a grant line. Nothing compares ids by the
    // prefix: grants.js compares the full sha256, because 16 hex characters is
    // 64 bits and a grant is not a place to spend a birthday bound.
    id: `plugin-${sha256.slice(0, ID_PREFIX_LENGTH)}`,
    sha256,
    fileCount: files.length,
    totalBytes,
    inventory: Object.freeze(inventory)
  });
}

module.exports = Object.freeze({
  PluginIdentityError,
  packageFiles,
  packageIdentity,
  ID_PREFIX_LENGTH,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  MAX_DEPTH
});
