#!/usr/bin/env node

// THE OPEN / PAID BOUNDARY FOR THE ENGINE REPOSITORY, AS A GATE.
//
// WHAT QUESTION THIS ANSWERS. "If this repository were published under the
// open-source licence, what exactly would that licence cover, and is anything
// in the tree not covered by it?" Until this file existed the engine repo had
// no answer at all: three separate lanes independently hit the same wall --
// there was no config/payload-boundary.json here, so "what does the published
// licence actually cover" had no checkable answer, only prose.
//
// THE OWNER'S RULE, WHICH THIS FILE ENFORCES AND DOES NOT DECIDE:
//
//     CLIENT-SIDE IS FREE AND OPEN. SERVER-SIDE IS OURS AND PAID.
//
// Running your own server for any capability is free. Paying us buys us
// OPERATING the server. So a module is withheld only if it runs exclusively on
// infrastructure WE operate for a paying customer -- the relay we host, hosted
// FRA, the secure phone path, a hosted vault, enrolment we manage. A module
// that runs on the customer's machine, or on a server THEY operate, is open --
// and stays open even when it talks to our paid service.
//
// THE DECISION IS NOT IN THIS FILE. config/payload-boundary.json holds it.
// This file is the mechanism that makes it take effect and makes getting it
// wrong loud.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SOURCE GATE AND NOT A PAYLOAD GATE.
//
// The app repository's tools/check-payload-boundary.mjs guards the installer
// PAYLOAD -- the 224 plain .js files electron-builder copies into
// resources/capability. This repository ships no payload. What it can leak is
// the repository itself, and `git push` to a public remote publishes exactly
// the modules a payload gate never touches. So the unit here is the TRACKED
// FILE SET, and the file set comes from `git ls-files`, never from walking the
// disk: what a publish exposes is what git TRACKS. Untracked build output is
// not published (walking would wrongly indict it) and a tracked file deleted
// from the working tree still is (walking would wrongly miss it).
//
// ---------------------------------------------------------------------------
// FOUR RULES GOVERN THIS FILE. The first three are the app gate's, kept
// deliberately identical so the two guards are read the same way. The fourth is
// new here, and is argued where it is implemented.
//
//   1. FAIL, DO NOT WARN. Anything classified paid, excluded or pending exits
//      1. There is no flag that turns this into a warning, because a guard that
//      can be downgraded is downgraded on the day it finally catches something.
//
//   2. UNCLASSIFIED IS A FAILURE, NOT A DEFAULT. Every tracked file must be
//      named in the manifest. A file that appears tomorrow and matches nothing
//      stops the gate until a human classifies it. Defaulting the unknown to
//      `open` would mean the next server-side module anyone adds is published
//      by silence -- the absence-as-consent defect this project has now found
//      repeatedly, in its worst form: invisible failure, published source.
//
//      This rule is also what makes a TYPO safe. A `paid` entry spelled wrongly
//      matches nothing -- but the real file then matches nothing either, so it
//      lands in unclassified and fails. A misspelled boundary cannot silently
//      ship the thing it was meant to hold back.
//
//   3. ASSERT BY NAMED PATH, NEVER BY COUNT. There is no expected-file-count
//      anywhere in this file and there must never be one. Two different sets of
//      the same size are indistinguishable by counting, and the one time it
//      matters is the one time they differ in content rather than size. Counts
//      are printed as information and are never compared against anything.
//
//   4. A FILE THAT REQUIRES A WITHHELD MODULE CANNOT BE OPEN, AND THAT IS
//      CHECKED, NOT TRUSTED. The app repo's manifest already states this rule
//      in prose -- "A file that requires a paid module cannot be open" -- and
//      prose does not refuse anything. It is a mechanism here. See
//      requireClosureViolations() for how, and for what it deliberately cannot
//      see.
//
//   4b. AN OPEN FILE MAY NOT REQUIRE ITS WAY OUT OF THE REPOSITORY. Added when
//      the relay service moved to its own private repo: rule 4 can only see
//      edges that land on a tracked path, so an edge pointing at a sibling
//      directory resolved to nothing and was skipped in silence. An escaping
//      require is broken in every clone of the open half regardless of what it
//      points at, and if it points at the private relay it is the split's one
//      directional rule broken. Argued at resolveSpecifier().
//
// EXIT CODES:
//   0  every tracked file is classified open, nothing withheld is present, and
//      no open file requires a withheld one
//   1  VIOLATIONS -- the tree carries paid/excluded/pending/unclassified files,
//      an open file requires a withheld one or requires above the repository
//      root, or history carries a withheld path
//   2  guard error -- the manifest is missing, malformed or self-contradictory,
//      or the target is not a git work tree

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// git runs hooks and this repo sets core.hooksPath, so a git child must not
// inherit ambient provider credentials. The shared scrub is CJS; createRequire
// is the supported way to reach it from an .mjs module.
const { safeLaunchEnvironment } = createRequire(import.meta.url)("../src/lib/providers/subscription-launch-env.js");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "config", "payload-boundary.json");
const MANIFEST_RELATIVE = "config/payload-boundary.json";

const CLASSES = ["excluded", "paid", "open"];
const STATUS_PROPOSED = "proposed";
const STATUS_RATIFIED = "owner-ratified";

// How many paths to NAME before switching to a per-directory rollup. A READING
// aid and nothing else -- the verdict is always taken over the whole set (rule
// 3). The cap exists because the honest answer for a whole repository can be
// hundreds of paths, and a gate that answers with an unreadable wall gets
// skimmed instead of read.
const PRINT_LIMIT = 60;

class GuardError extends Error {}

// ---------------------------------------------------------------------------
// Manifest loading and validation.
//
// Everything below throws GuardError, which becomes exit 2. A malformed
// boundary must never be reported as a clean tree, and must never be confused
// with a violation: those are different problems with different fixes, and
// telling them apart is the difference between "fix your manifest" and "you are
// about to publish the server-side half".
// ---------------------------------------------------------------------------

// Paths are repository-relative and POSIX, matching `git ls-files` output
// exactly. Anything else is rejected rather than normalised, because a manifest
// entry that does not match the way git names files is an entry that silently
// classifies nothing -- and rule 2 is only load-bearing if entries mean what
// they appear to mean.
function assertUsablePath(value, where, { directory = false } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GuardError(`${MANIFEST_RELATIVE}: ${where} contains an empty or non-string entry.`);
  }
  if (value !== value.trim()) {
    throw new GuardError(`${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} has surrounding whitespace.`);
  }
  if (value.includes("\\")) {
    throw new GuardError(
      `${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} uses a backslash. ` +
        "git names files with forward slashes on every platform, so a backslash entry would match nothing.",
    );
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new GuardError(
      `${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} is absolute. ` +
        "Entries are repository-relative so the same manifest checks any clone.",
    );
  }
  if (value.startsWith("./") || value.split("/").includes("..") || value.split("/").includes(".")) {
    throw new GuardError(
      `${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} is not in normal form ` +
        '(no "./", no "..", no bare "." segments).',
    );
  }
  if (directory && !value.endsWith("/")) {
    throw new GuardError(
      `${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} must end with "/" so it is ` +
        'unambiguously a directory prefix. Without it, "docs" would also match "docsite.md".',
    );
  }
  if (!directory && value.endsWith("/")) {
    throw new GuardError(`${MANIFEST_RELATIVE}: ${where} entry ${JSON.stringify(value)} is a file path and must not end with "/".`);
  }
}

function readList(container, key, where) {
  const value = container[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GuardError(`${MANIFEST_RELATIVE}: ${where}.${key} must be an array.`);
  return value;
}

function loadManifest(file) {
  if (!existsSync(file)) {
    // NAME THE FILE THAT WAS ACTUALLY LOOKED FOR, not the default. An earlier
    // draft printed the default relative path regardless of --manifest, so a run
    // with a mistyped --manifest reported that config/payload-boundary.json was
    // missing while it sat there in perfect health. A guard error that misnames
    // its own cause sends the reader to the wrong file.
    throw new GuardError(
      `${file} is missing. This guard holds the open/paid boundary and has been given ` +
        "no boundary to hold, so it would pass a tree containing anything at all.",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new GuardError(`${MANIFEST_RELATIVE} is present but unreadable: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GuardError(`${MANIFEST_RELATIVE} must be a JSON object.`);
  }
  if (parsed.schemaVersion !== 1) {
    throw new GuardError(`${MANIFEST_RELATIVE}: schemaVersion must be 1, found ${JSON.stringify(parsed.schemaVersion)}.`);
  }
  if (parsed.status !== STATUS_PROPOSED && parsed.status !== STATUS_RATIFIED) {
    throw new GuardError(
      `${MANIFEST_RELATIVE}: status must be ${JSON.stringify(STATUS_PROPOSED)} or ` +
        `${JSON.stringify(STATUS_RATIFIED)}, found ${JSON.stringify(parsed.status)}.`,
    );
  }

  const rules = { excluded: { paths: [], prefixes: [] }, paid: { paths: [], prefixes: [] }, open: { paths: [] } };

  for (const name of CLASSES) {
    const section = parsed[name];
    if (section === undefined) continue;
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw new GuardError(`${MANIFEST_RELATIVE}: "${name}" must be an object.`);
    }
    for (const entry of readList(section, "paths", name)) {
      assertUsablePath(entry, `${name}.paths`);
      rules[name].paths.push(entry);
    }
    // PREFIXES ARE ALLOWED ONLY IN THE DIRECTION THAT FAILS THE GATE.
    //
    // A too-broad `paid` or `excluded` prefix over-matches, which turns the gate
    // red and gets corrected in minutes. A too-broad `open` prefix over-permits
    // everything beneath it -- so the next server-side module dropped into that
    // directory would be classified open by a rule written before it existed,
    // and would publish. `open` is therefore exact paths only: every openly
    // published file is named by a human, once.
    if (name === "open") {
      if (section.prefixes !== undefined) {
        throw new GuardError(
          `${MANIFEST_RELATIVE}: "open" may not use prefixes. An open prefix would classify files ` +
            "that do not exist yet, so a server-side module added under it later would publish by " +
            "silence. List open files by exact path.",
        );
      }
      continue;
    }
    for (const entry of readList(section, "prefixes", name)) {
      assertUsablePath(entry, `${name}.prefixes`, { directory: true });
      rules[name].prefixes.push(entry);
    }
  }

  // `pending` HERE MEANS SOMETHING NARROWER THAN IN THE APP MANIFEST, AND THE
  // DIFFERENCE IS THE WHOLE REASON IT IS SAFE TO REUSE THE WORD.
  //
  // There, pending is tolerated: it means "decided, still shipping", and the
  // payload gate stays green so ordinary dev builds are not blocked by removal
  // work nobody has done yet. Here there is no dev build to keep green. This
  // gate answers ONLY the publish question, and publishing is precisely the act
  // a pending file is waiting to not happen. So pending REFUSES -- which is
  // exactly what the app gate's own `--source` mode does with it.
  //
  // What pending is for here: a file the owner rule does not cleanly decide, or
  // one that is open on its merits but cannot be published until a require()
  // edge is broken or a config is neutralised. Without it, those could only be
  // expressed by failing over a decision nobody has made, or -- far worse -- by
  // quietly calling them open to make the gate green.
  const pending = new Map();
  if (parsed.pending !== undefined) {
    if (!parsed.pending || typeof parsed.pending !== "object" || Array.isArray(parsed.pending)) {
      throw new GuardError(`${MANIFEST_RELATIVE}: "pending" must be an object of path -> reason.`);
    }
    for (const [entry, reason] of Object.entries(parsed.pending)) {
      assertUsablePath(entry, "pending");
      if (typeof reason !== "string" || !reason.trim()) {
        throw new GuardError(
          `${MANIFEST_RELATIVE}: pending entry ${JSON.stringify(entry)} has no reason. ` +
            "A pending item without a stated reason is an unexplained exception, which is how a " +
            "temporary list becomes permanent.",
        );
      }
      pending.set(entry, reason.trim());
    }
  }

  // RATIFICATION MUST FORCE A DECISION ON EVERY PENDING ITEM.
  //
  // "The owner has decided" and "these items are undecided" cannot both be true.
  // Making that contradiction a hard error is what turns his decision into
  // enforcement: flipping status to owner-ratified is impossible until every
  // pending path has been moved into open, paid or excluded. Nothing can be
  // ratified by being overlooked.
  if (parsed.status === STATUS_RATIFIED && pending.size > 0) {
    throw new GuardError(
      `${MANIFEST_RELATIVE}: status is ${JSON.stringify(STATUS_RATIFIED)} but ${pending.size} path(s) ` +
        `are still "pending": ${[...pending.keys()].slice(0, 10).join(", ")}${pending.size > 10 ? ", ..." : ""}. ` +
        "A ratified boundary cannot contain undecided items. Move each into open, paid or excluded.",
    );
  }

  // A path in two classes is an ambiguous decision in the one file whose whole
  // job is to be unambiguous. Precedence would resolve it safely but silently,
  // and a boundary that is silently resolved is a boundary nobody can read.
  const owner = new Map();
  const claim = (entry, label) => {
    const previous = owner.get(entry);
    if (previous && previous !== label) {
      throw new GuardError(
        `${MANIFEST_RELATIVE}: ${JSON.stringify(entry)} is declared in both "${previous}" and "${label}". ` +
          "One path, one class.",
      );
    }
    if (previous === label) {
      throw new GuardError(`${MANIFEST_RELATIVE}: ${JSON.stringify(entry)} is listed twice in "${label}".`);
    }
    owner.set(entry, label);
  };
  for (const name of CLASSES) for (const entry of rules[name].paths) claim(entry, name);
  for (const entry of pending.keys()) claim(entry, "pending");

  return { status: parsed.status, rules, pending };
}

// ---------------------------------------------------------------------------
// Classification.
//
// Precedence is fixed and runs strictest-first: excluded, paid, pending, open.
// A path reachable by both a restrictive prefix and an open exact path resolves
// to the restrictive one, so a mistake in the open list can never unblock
// something held back. (The duplicate check above already refuses the literal
// case; this ordering covers a prefix overlapping an exact entry, which is a
// legitimate editing state and must resolve closed.)
// ---------------------------------------------------------------------------

function classify(relativePath, { rules, pending }) {
  for (const name of ["excluded", "paid"]) {
    const exact = rules[name].paths.find((entry) => entry === relativePath);
    if (exact) return { klass: name, rule: `${name}.paths: ${exact}` };
    const prefix = rules[name].prefixes.find((entry) => relativePath.startsWith(entry));
    if (prefix) return { klass: name, rule: `${name}.prefixes: ${prefix}` };
  }
  if (pending.has(relativePath)) return { klass: "pending", rule: pending.get(relativePath) };
  if (rules.open.paths.includes(relativePath)) return { klass: "open", rule: `open.paths: ${relativePath}` };
  return { klass: "unclassified", rule: null };
}

// ---------------------------------------------------------------------------
// git.
// ---------------------------------------------------------------------------

function git(repository, args, what) {
  try {
    return execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      env: safeLaunchEnvironment(process.env, { context: "payload boundary git" }),
      // History enumeration on this repository is ~1.2MB today and only grows.
      // A truncated stdout would silently shorten the set this guard reasons
      // over, which is the one failure mode it cannot have.
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new GuardError("git is not on PATH, so the publish question cannot be answered at all.");
    }
    const detail = `${error?.stderr || ""}`.trim() || error?.message || "unknown git failure";
    throw new GuardError(`${what} failed in ${repository}: ${detail}`);
  }
}

// -z because git QUOTES paths containing spaces or non-ASCII bytes in its
// default output. A quoted path is a different string from the real one, so it
// would match no manifest entry -- under rule 2 that lands in `unclassified`
// and fails, which is the safe direction, but it fails for a reason the
// operator cannot act on. -s carries the mode alongside, which is the only way
// to tell a symlink from a regular file here.
function trackedFiles(repository) {
  const raw = git(repository, ["ls-files", "-s", "-z"], "git ls-files");
  const files = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) throw new GuardError(`git ls-files produced an unparseable record: ${JSON.stringify(record)}`);
    const mode = record.slice(0, record.indexOf(" "));
    const file = record.slice(tab + 1);
    // A symlink is a file whose real content this guard cannot classify from
    // its name, and a repository publishes the link. Following it would
    // classify one path while exposing another's bytes. Refusing is the only
    // fail-closed answer.
    if (mode === "120000") throw new GuardError(`refusing to classify a symlink in the tree: ${file}`);
    files.push(file);
  }
  return files;
}

// EVERY PATH IN EVERY REACHABLE COMMIT, which is precisely what a clone of a
// published repository hands over.
//
// `rev-list --all --objects` rather than `log --name-only`: it enumerates the
// trees themselves rather than per-commit diffs, so it cannot miss a path that
// only ever existed on one side of a merge, and it is faster besides. --all
// covers refs/heads, refs/tags AND refs/remotes -- deliberately wider than
// "what is pushed today", because a local branch is one command from being
// pushed and remote-tracking refs show what already is.
//
// WHAT THIS CANNOT SEE, stated so nobody reads more into a green history line
// than it earns: the check is by PATH. A withheld module that lived in history
// under a name the manifest does not classify, or whose body was pasted into
// some other file, is invisible to it. It answers "were these modules ever
// here", not "was this secret ever here".
//
// BLOBS ONLY, AND THE FILTER IS NOT COSMETIC. `rev-list --objects` emits TREES
// beside blobs, and a tree carries the directory's path -- so an unfiltered read
// reports `docs/coordinator` as a withheld "path" that is "HISTORY ONLY -- gone
// from the tip", about a directory that is plainly still there. Measured on this
// repository the first run that way: 3326 history hits, most of them directories,
// each labelled with the phrase reserved for the genuinely dangerous case. A
// finding list where the alarming label is mostly noise is a finding list nobody
// reads, which costs exactly the one real hit it was built to surface. Object
// types come from `cat-file --batch-check` over the ids rev-list already gave us.
function historicalPaths(repository) {
  const raw = git(repository, ["rev-list", "--all", "--objects"], "git rev-list");
  const records = [];
  const ids = [];
  for (const line of raw.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) continue; // a commit or root tree: an object with no path
    const file = line.slice(space + 1);
    if (!file) continue;
    records.push({ id: line.slice(0, space), file });
    ids.push(line.slice(0, space));
  }

  let typed;
  try {
    typed = execFileSync("git", ["-C", repository, "cat-file", "--batch-check=%(objecttype)"], {
      encoding: "utf8",
      env: safeLaunchEnvironment(process.env, { context: "payload boundary git" }),
      input: `${ids.join("\n")}\n`,
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const detail = `${error?.stderr || ""}`.trim() || error?.message || "unknown git failure";
    throw new GuardError(`git cat-file failed in ${repository}: ${detail}`);
  }

  // One type line per id, in order. A length mismatch means this guard would be
  // pairing the wrong type with the wrong path, so it refuses rather than
  // guessing -- silently mislabelling trees as blobs is the defect being fixed.
  const typeLines = typed.endsWith("\n") ? typed.slice(0, -1).split("\n") : typed.split("\n");
  if (typeLines.length !== records.length) {
    throw new GuardError(
      `git cat-file returned ${typeLines.length} type line(s) for ${records.length} object(s); ` +
        "refusing to pair types with paths on an incomplete or extra read.",
    );
  }

  const versions = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const objectType = typeLines[index].trim();
    if (!new Set(["blob", "tree", "commit", "tag"]).has(objectType)) {
      throw new GuardError(
        `git cat-file could not establish the type of object ${records[index].id}: ${JSON.stringify(typeLines[index])}`,
      );
    }
    if (objectType !== "blob") continue;
    const { file } = records[index];
    versions.set(file, (versions.get(file) ?? 0) + 1);
  }
  return versions;
}

// ---------------------------------------------------------------------------
// RULE 4: AN OPEN FILE MAY NOT REQUIRE A WITHHELD ONE.
//
// WHY THIS IS A MECHANISM AND NOT A REVIEW HABIT. The app repo already learned
// the lesson the expensive way in the other direction: ONE literal require() in
// src/lib/system-status.js dragged three modules the owner had ruled must not
// ship into the payload, and every test still passed. The mirror image is what
// this checks -- publishing a file whose dependency is withheld produces an open
// half that cannot even load, and nothing else in the repository would say so.
//
// THE SCAN IS TEXTUAL, DELIBERATELY, AND MIRRORS tools/pack-capability-layer.mjs.
// A runtime trace would be more precise and would be the wrong instrument: what
// gets published is TEXT, and a require() inside a function, inside a lazy
// branch, or inside a comment is published identically to a top-level one. The
// packer already established that only the disappearance of the SPECIFIER TEXT
// removes an edge; this reads the same edges the same way, so the two agree.
//
// WHAT IT CANNOT SEE, named rather than assumed:
//   * computed requires -- require(variable), require(`${a}/b`). None resolve
//     here, so an edge built that way is invisible. The packer refuses computed
//     requires for exactly this reason; this guard does not police them.
//   * ESM `import` statements. This repository's runtime is CommonJS; the .mjs
//     files are build tooling. An import edge into a withheld module would be
//     missed.
//   * non-JavaScript references -- a PowerShell script invoking a withheld tool
//     by path, or a JSON manifest naming one.
// Each of those is a real hole. None of them makes the covered case less true,
// and a partial mechanism that names its edges beats a rule nobody runs.
// ---------------------------------------------------------------------------

// RULE 4b: AN OPEN FILE MAY NOT REQUIRE ITS WAY OUT OF THE REPOSITORY.
//
// WHY THIS EXISTS, AND WHY RULE 4 ALONE STOPPED BEING ENOUGH. Rule 4 catches an
// open file reaching a withheld file INSIDE this tree. The moment the relay
// service was split into its own private repository, a second shape appeared
// that rule 4 is structurally blind to: `require("../../toolsenabled-relay-
// private/src/lib/online-fra-rendezvous-relay")`. That specifier resolves to
// nothing in trackedSet, so resolveSpecifier() returned null and the edge was
// skipped in silence -- the exact absence-as-consent defect this file argues
// against everywhere else, arriving through the door the split just opened.
//
// The consequence is worse than a missed classification. An escaping require is
// ALWAYS broken in a published clone, whatever it points at: the person who
// clones the open repo does not have the sibling directory, so the open half
// cannot load. Whether the target is withheld, private, or entirely innocent
// does not change that, which is why this refuses on the ESCAPE itself rather
// than trying to classify something outside the manifest's authority.
//
// The split's one rule is directional -- private may read open, open may never
// read private -- and this is the half of it that a machine can enforce.
const REQUIRE_LITERAL = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

// True when `index` sits inside a quoted string on its own line.
//
// Deliberately line-scoped rather than whole-file. A whole-file scanner has to
// decide what a `/` is -- divide, regex literal, comment -- and gets it wrong in
// the silent direction: one misread regex flips the quote state for everything
// after it, so a real escape 400 lines later reads as "inside a string" and
// disappears. Restarting at each newline bounds that blast radius to one line.
//
// The cost is a require inside a multi-line template literal, which stays
// visible. For a rule that fires on the SHAPE of a path -- and whose whole
// purpose is to notice an open file reaching at private code -- being noisy
// about a rare fixture beats being quiet about a real one.
function insideStringLiteral(body, index) {
  const lineStart = body.lastIndexOf("\n", index - 1) + 1;
  let quote = null;
  for (let i = lineStart; i < index; i += 1) {
    const character = body[i];
    if (quote !== null) {
      if (character === "\\") { i += 1; continue; } // an escaped quote does not close the string
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
  }
  return quote !== null;
}

function resolveSpecifier(fromFile, specifier, trackedSet) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  // A normalised path still starting with ".." has climbed above the repository
  // root. Reported, never resolved: there is nothing above the root this guard
  // has any authority over, and guessing would be worse than refusing.
  if (base === ".." || base.startsWith("../")) return { escapes: base };
  for (const candidate of [base, `${base}.js`, `${base}.json`, `${base}/index.js`]) {
    if (trackedSet.has(candidate)) return { target: candidate };
  }
  return null;
}

function requireClosureViolations(repository, openFiles, trackedSet, verdictOf) {
  const found = [];
  const escapes = [];
  for (const file of openFiles) {
    if (!/\.(js|mjs|cjs)$/.test(file)) continue;
    const full = path.join(repository, file);
    if (!existsSync(full)) {
      throw new GuardError(
        `cannot scan tracked open file ${file}: it is missing from the work tree, so its require closure was not measured`,
      );
    }
    let body;
    try {
      body = readFileSync(full, "utf8");
    } catch (error) {
      throw new GuardError(`cannot read tracked file ${file}: ${error.message}`);
    }
    const seen = new Set();
    for (const match of body.matchAll(REQUIRE_LITERAL)) {
      const resolved = resolveSpecifier(file, match[1], trackedSet);
      if (!resolved) continue;
      if (resolved.escapes !== undefined) {
        // QUOTED require() TEXT IS A FIXTURE, NOT AN EDGE, AND THE FIRST RUN OF
        // THIS RULE PROVED IT MATTERS. tests/unified-agent-p04-boundaries.js
        // writes the literal string "require('../../../Portfolio Dashboard/
        // frontend/app.js');" into a temp file as test DATA. Reporting that as a
        // boundary breach is a false alarm in the one section that must never
        // produce them: a finding list whose alarming label is mostly noise is a
        // finding list nobody reads, which costs the one real hit it exists for.
        //
        // Rule 4 does not need this guard because it only fires when a specifier
        // RESOLVES to a tracked withheld path, and fixture strings almost never
        // do. Rule 4b fires on the shape of the path alone, so it needs the
        // discriminator explicitly.
        //
        // NAMED LIMITATION, in the style of the rest of this file: a real edge
        // hidden inside a quoted string -- eval("require('../../private/x')") --
        // is suppressed by this. That is already invisible to rule 4, which
        // names computed requires as a hole it does not police. A genuine
        // top-level require is never preceded by a quote character.
        //
        // AND THE FIRST SPELLING OF THIS SUPPRESSION WAS TOO NARROW, WHICH THE
        // SAME FIXTURE PROVED A SECOND TIME. Testing only the ONE character
        // before `require(` catches line 50 of the file above -- where the
        // string opens immediately -- and misses line 52, where the string body
        // begins "// " and the preceding character is therefore a space. Same
        // file, same fixture, same false alarm, still reported. A discriminator
        // that only recognises the tidiest spelling of the thing it is looking
        // for is not a discriminator.
        //
        // So read the quote STATE up to the match instead of the byte before
        // it. Scoped to the match's own line: a require genuinely inside a
        // multi-line template literal is still reported, which is the direction
        // that keeps a real escape visible rather than the one that hides it.
        if (insideStringLiteral(body, match.index)) continue;
        const key = `escape:${match[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        escapes.push({ file, specifier: match[1] });
        continue;
      }
      const { target } = resolved;
      if (seen.has(target)) continue;
      seen.add(target);
      const klass = verdictOf(target);
      if (klass === "paid" || klass === "excluded" || klass === "pending") {
        found.push({ file, target, klass });
      }
    }
  }
  return { found, escapes };
}

// ---------------------------------------------------------------------------

function rollupByDirectory(paths) {
  const counts = new Map();
  for (const file of paths) {
    const slash = file.indexOf("/");
    const bucket = slash === -1 ? "(repository root)" : file.slice(0, file.indexOf("/", slash + 1) + 1 || slash + 1);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function printPaths(lines, emit) {
  const named = lines.slice(0, PRINT_LIMIT);
  for (const line of named) emit(`  ${line.text}`);
  if (lines.length > named.length) {
    emit(
      `  ... and ${lines.length - named.length} more. The list above is TRUNCATED FOR READING ONLY -- ` +
        "the verdict is taken over every one of them. Where the work is:",
    );
    for (const [bucket, count] of rollupByDirectory(lines.map((line) => line.path))) {
      emit(`    ${count}\t${bucket}`);
    }
  }
}

function parseArguments(argv) {
  let manifest = DEFAULT_MANIFEST;
  let repository = REPO_ROOT;
  let repositoryGiven = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--manifest") {
      manifest = argv[index + 1];
      if (!manifest) throw new GuardError("--manifest needs a path.");
      index += 1;
      continue;
    }
    if (argv[index] === "--repo") {
      repository = argv[index + 1];
      if (!repository) throw new GuardError("--repo needs a path.");
      repositoryGiven = true;
      index += 1;
      continue;
    }
    if (argv[index].startsWith("--")) throw new GuardError(`unknown flag ${argv[index]}`);
    throw new GuardError(`unexpected argument ${JSON.stringify(argv[index])}; use --repo <path>.`);
  }
  return { manifest: path.resolve(manifest), repository: path.resolve(repository), repositoryGiven };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const boundary = loadManifest(options.manifest);

  // Confirm it is a git work tree BEFORE anything else. A plain directory would
  // otherwise produce an empty file set and an empty history, and then a
  // confident, wrong "nothing withheld is present" -- the absence-as-emptiness
  // defect in the place it would cost the most.
  const inside = git(options.repository, ["rev-parse", "--is-inside-work-tree"], "git rev-parse").trim();
  if (inside !== "true") throw new GuardError(`nothing to check: not a git work tree: ${options.repository}`);

  const tracked = trackedFiles(options.repository);
  if (tracked.length === 0) {
    throw new GuardError(`nothing to check: git tracks 0 files in ${options.repository}`);
  }
  const trackedSet = new Set(tracked);

  const verdicts = new Map();
  const found = { excluded: [], paid: [], pending: [], unclassified: [], open: [] };
  for (const file of tracked) {
    const verdict = classify(file, boundary);
    verdicts.set(file, verdict);
    found[verdict.klass].push(file);
  }
  const verdictOf = (file) => (verdicts.get(file) ?? classify(file, boundary)).klass;

  const { found: closure, escapes } = requireClosureViolations(options.repository, found.open, trackedSet, verdictOf);

  // History is asked only about the RESTRICTIVE classes. Requiring every path
  // that ever existed to be classified would be unmeetable -- history holds
  // every scratch file and every renamed-away path this repo ever had -- and an
  // unmeetable gate is a disabled gate. Unclassified fails at the tip, where it
  // is both actionable and the thing that actually publishes.
  const history = historicalPaths(options.repository);
  const historyHits = [];
  for (const file of [...history.keys()].sort()) {
    const klass = classify(file, boundary).klass;
    if (klass !== "paid" && klass !== "excluded") continue;
    historyHits.push({ path: file, klass, versions: history.get(file) });
  }
  const historyOnly = historyHits.filter((hit) => !trackedSet.has(hit.path));

  console.log(`Source publish boundary: ${MANIFEST_RELATIVE} (status: ${boundary.status})`);
  console.log(`Repository: ${options.repository}`);
  console.log(`Tracked files: ${tracked.length} (informational -- this guard asserts on named paths, never on a count).`);
  console.log(
    `Classified: open=${found.open.length} pending=${found.pending.length} paid=${found.paid.length} ` +
      `excluded=${found.excluded.length} unclassified=${found.unclassified.length}`,
  );
  console.log(`Require-closure: ${closure.length} open file(s) require a withheld module.`);
  console.log(`Repository escapes: ${escapes.length} open file(s) require a path above the repository root.`);
  console.log(`History: ${history.size} distinct path(s) across all reachable refs.`);

  const violations =
    found.paid.length +
    found.excluded.length +
    found.pending.length +
    found.unclassified.length +
    closure.length +
    escapes.length;

  if (violations === 0 && historyHits.length === 0) {
    console.log("\nSource publish boundary: clean. Every tracked file is open, nothing withheld is present or in history.");
    return;
  }

  console.error(`\nSOURCE PUBLISH REFUSED -- ${options.repository}`);

  for (const [label, heading] of [
    ["excluded", "MUST NOT BE PUBLISHED AT ALL (excluded)"],
    ["paid", "SERVER-SIDE -- ours. Publishing the source publishes these (paid)"],
  ]) {
    if (found[label].length === 0) continue;
    console.error(`\n${heading} -- ${found[label].length} file(s):`);
    printPaths(found[label].map((file) => ({ path: file, text: file })), (line) => console.error(line));
  }

  if (found.pending.length > 0) {
    console.error(
      `\nPENDING -- ${found.pending.length} file(s) the boundary does not yet decide, or that are open on ` +
        "their merits but blocked by a dependency. Pending REFUSES here: this gate answers only the " +
        "publish question, and publishing is the act these are waiting to not happen.",
    );
    printPaths(
      found.pending.map((file) => ({ path: file, text: `${file}  --  ${verdicts.get(file).rule}` })),
      (line) => console.error(line),
    );
  }

  if (found.unclassified.length > 0) {
    console.error(
      `\nUNCLASSIFIED -- ${found.unclassified.length} tracked file(s) are named nowhere in ` +
        `${MANIFEST_RELATIVE}. This is a failure by design: an unknown file is not assumed open, so a ` +
        "repository whose publishable set has never been classified cannot be published by silence.",
    );
    printPaths(found.unclassified.map((file) => ({ path: file, text: file })), (line) => console.error(line));
  }

  if (closure.length > 0) {
    console.error(
      `\nREQUIRE-CLOSURE -- ${closure.length} file(s) classified open contain a literal require() that ` +
        "resolves to a withheld file. An open half that cannot load is not an open half. Fix by breaking " +
        "the edge, not by widening the class of the thing it reaches:",
    );
    printPaths(
      closure.map((hit) => ({ path: hit.file, text: `${hit.file}  ->  ${hit.target}  [${hit.klass}]` })),
      (line) => console.error(line),
    );
  }

  if (escapes.length > 0) {
    console.error(
      `\nREPOSITORY ESCAPE -- ${escapes.length} file(s) classified open require a path ABOVE this ` +
        "repository's root. Whoever clones the open half does not have whatever is up there, so the " +
        "published tree cannot load. If the target is the private relay repo this is also the split's " +
        "one rule broken: private may read open, open may never read private:",
    );
    printPaths(
      escapes.map((hit) => ({ path: hit.file, text: `${hit.file}  ->  ${hit.specifier}` })),
      (line) => console.error(line),
    );
  }

  if (historyHits.length > 0) {
    console.error(
      `\nGIT HISTORY -- ${historyHits.length} paid/excluded path(s) are reachable from this repository's ` +
        "refs. Publishing the repository publishes these regardless of what the tip looks like: a clone " +
        "carries every reachable commit, and `git show <commit>:<path>` reads the file straight back out.",
    );
    printPaths(
      historyHits.map((hit) => ({
        path: hit.path,
        text:
          `${hit.path}   [${hit.klass}; ${hit.versions} version(s); ` +
          `${trackedSet.has(hit.path) ? "at the tip and in history" : "HISTORY ONLY -- gone from the tip"}]`,
      })),
      (line) => console.error(line),
    );
    if (historyOnly.length > 0) {
      console.error(
        `\n${historyOnly.length} of those are the dangerous kind: absent from the working tree, so every ` +
          "tip-only check reports them clean. Deleting a file in a new commit does not remove it from the " +
          "repository -- only rewriting history does, and that is a decision, not a fix this guard makes.",
      );
    }
  }

  console.error(
    "\nA red result here is fixed by classifying the tree and removing what must not be published -- " +
      "never by widening a rule to make the colour change.",
  );

  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  if (error instanceof GuardError) {
    console.error(`Payload boundary guard error: ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(`Payload boundary guard error: ${error.stack || error.message}`);
    process.exitCode = 2;
  }
}
