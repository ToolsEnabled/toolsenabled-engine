#!/usr/bin/env node

// THE OWNER-DATA GUARD FOR THE ENGINE REPOSITORY.
//
// WHAT QUESTION THIS ANSWERS, and why it is a different question from the one
// next door. config/payload-boundary.json and tools/check-payload-boundary.mjs
// answer "does this file run on the customer's machine or on ours" -- the
// free/paid axis. They say NOTHING about whether a file that is legitimately
// open carries the builder's email address, home directory, machine name or
// live cloud project id. The manifest states that gap itself, in $mechanismGaps:
//
//     "NO OWNER-DATA GUARD EXISTS IN THIS REPOSITORY. ... Green here is not
//      clearance to publish."
//
// This file is that second guard. Customer distribution needs both, and neither
// substitutes for the other.
//
// ---------------------------------------------------------------------------
// WHY THIS SCANS A GIT FILE LIST AND NOT A BUILD DIRECTORY.
//
// The app repository has a tool of the same name. It scans release/ or dist/ --
// a BUILT PAYLOAD -- which is right for the artifact it guards and wrong for
// this one. This repository ships customer-distributable source as a classified
// set derived from git ls-files, not from any build output. A build-output scanner pointed at
// this tree could be perfectly green while every file it never looked at went
// out. Measured, not reasoned: the 2026-08-13 publication-leak audit found nine
// classes of owner data in the open set, and recorded that the build-output
// scanner "could not have covered this question".
//
// So the population here is the tracked files the manifest classifies `open`.
// That set is computed with the DISTRIBUTION rule (open.paths / open.prefixes
// over `git ls-files`) rather
// than the boundary checker's restrictive-precedence rule, because the
// distribution rule is the one that describes what may move, and where the two
// differ that set is the wider of the two. A guard must scan what
// ships, not what a stricter reading says should ship.
//
// ---------------------------------------------------------------------------
// FIVE RULES GOVERN THIS FILE.
//
//   1. NEVER PRINT A FOUND VALUE. Findings are reported as file, line and KIND.
//      No excerpt, no offset-into-the-line, no capture group, no "did you mean".
//      This report is written to be pasted into terminals, issues and handoffs;
//      a leak report that quotes the leak is a second copy of the leak, in a
//      place with weaker handling than the original. The published audit this
//      guard implements adopted the same rule for the same reason.
//
//      This is enforced structurally, not by care: KINDS ARE A CLOSED ENUM
//      DEFINED IN THIS FILE. The identity profile picks a kind; it cannot supply
//      a label. Otherwise the first person to write {"label": "<their email>"}
//      would have their address printed by the guard that exists to keep it
//      quiet. For the same reason the profile holds literals only and no
//      user-supplied regular expressions -- a bad regex is reported by echoing
//      its source.
//
//   2. FAIL CLOSED, INCLUDING ON IGNORANCE. Any finding exits 1. A file in the
//      publishable set that cannot be read is itself a finding, not a skip: a
//      file this guard could not look at is a file nobody has cleared, and
//      "unreadable" resolving to "clean" is the absence-as-emptiness defect
//      every other guard in this repository has had to name.
//
//   3. NO PROFILE, NO PASS. Without an identity profile this guard would report
//      a clean scan while looking for nothing that identifies anybody. That is
//      exactly how the original became useless: it was believed to be wired up,
//      its profile was absent, and absence read as success. A missing, empty,
//      unedited or malformed profile is exit 2 -- a REFUSAL, deliberately a
//      different exit code from a finding, so "I have not set this up" can never
//      be mistaken for "the tree is clean".
//
//   4. THE PROFILE IS NEVER RESOLVED FROM INSIDE THE REPOSITORY. Not from
//      private/, not from a gitignored path. The values in it are the exact
//      values this guard exists to keep out of the tree, and a file inside the
//      work tree is one `git add -A` and one .gitignore edit away from being
//      committed -- after which the guard's own configuration is the leak. A
//      path under the repository root is REFUSED rather than warned about, so
//      the safe arrangement is the only arrangement.
//
//   5. ASSERT BY NAMED PATH, NEVER BY COUNT. Counts are printed as information
//      and compared against nothing, matching tools/check-payload-boundary.mjs
//      rule 3. Two different sets of the same size are indistinguishable by
//      counting, and the one time it matters is the one time they differ in
//      content rather than size.
//
// ---------------------------------------------------------------------------
// WHAT IT LOOKS FOR: TWO HALVES, AND THE SPLIT IS THE POINT.
//
// SHAPE RULES are product facts -- true for any builder, no identity needed. A
// consumer mailbox, a Windows home-directory path with a real account segment in
// it, a DESKTOP-xxxxxxx machine name, a cloud service-account address. These
// keep working for the next contributor, whose name no profile will ever hold.
//
// IDENTITY LITERALS are who the builder is -- account name, aliases, machine
// names, project ids, LAN prefix. Hardcoding those protects exactly one person
// and gives the next one nowhere to put their own, so they live in a profile
// outside the tree.
//
// The shape rules are deliberately written so that the audit's own approved
// remediations PASS. `C:\Users\<you>\...`, `C:\Users\testuser\...`,
// `primary@example.com` and `example.invalid` are the substitutions the audit
// prescribes; a guard that flagged its own prescribed fix would be argued with
// and then overridden, and an overridden guard protects nothing.
//
// EXIT CODES:
//   0  every file in the publishable set was read, and none carries owner data
//   1  FINDINGS -- owner-identifying data is in the set that would be published
//   2  guard error -- no usable identity profile, no manifest, not a git work
//      tree, or nothing to scan. Never a verdict about the tree.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// git runs hooks and this repo sets core.hooksPath, so a git child must not
// inherit ambient provider credentials. The shared scrub is CJS; createRequire
// is the supported way to reach it from an .mjs module. Same reasoning, same
// call, as tools/check-payload-boundary.mjs.
const { safeLaunchEnvironment } = createRequire(import.meta.url)("../src/lib/providers/subscription-launch-env.js");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "config", "payload-boundary.json");
const MANIFEST_RELATIVE = "config/payload-boundary.json";
const PROFILE_ENV = "TE_OWNER_DATA_PROFILE";

// A READING aid only. The verdict is always taken over every finding (rule 5).
const PRINT_LIMIT = 120;

class GuardError extends Error {}

// ---------------------------------------------------------------------------
// THE KINDS. A CLOSED ENUM, AND THE ONLY VOCABULARY THE REPORT CAN SPEAK.
//
// Rule 1 lives here. Every line this guard prints about a finding is assembled
// from a path, a line number and one of these keys -- none of which can carry a
// matched value. The description is for the operator reading the refusal; it is
// never derived from the data.
// ---------------------------------------------------------------------------

const KINDS = new Map([
  // Supplied by the identity profile.
  ["owner-email-address", "a mailbox belonging to the builder"],
  ["owner-account-alias", "an account alias the builder signs in with"],
  ["owner-personal-name", "the builder's personal name"],
  ["windows-account-name", "the builder's Windows account name"],
  ["machine-name", "a machine or host name from the builder's estate"],
  ["cloud-project-id", "a live cloud project identifier"],
  ["private-network-prefix", "the builder's private LAN address range"],
  ["repository-tree-name", "the name of a private working tree or repository"],
  ["session-transcript-id", "a private session or transcript identifier"],
  ["owner-identifier", "another identifier the builder declared as their own"],
  // Built in. True for any builder, no profile needed.
  ["personal-email-shape", "a consumer mailbox address (gmail/outlook/icloud/...)"],
  ["home-directory-path", "an absolute path naming a real account's home directory"],
  ["machine-name-shape", "a default-form Windows machine name (DESKTOP-/LAPTOP-)"],
  ["cloud-project-id-shape", "a value in the generated cloud-project-id form"],
  ["cloud-service-account", "a cloud service-account identity address"],
  // Structural.
  ["unreadable", "a publishable file this guard could not read, so nobody has cleared it"],
]);

const PROFILE_KINDS = [
  "owner-email-address",
  "owner-account-alias",
  "owner-personal-name",
  "windows-account-name",
  "machine-name",
  "cloud-project-id",
  "private-network-prefix",
  "repository-tree-name",
  "session-transcript-id",
  "owner-identifier",
];

// ---------------------------------------------------------------------------
// SHAPE RULES.
// ---------------------------------------------------------------------------

// A CONSUMER MAILBOX IN A PUBLISHED PRODUCT REPOSITORY IS A PERSON'S ADDRESS.
//
// Not a heuristic about who: nobody puts a stranger's gmail in their source, and
// the reserved-for-documentation domains (example.com, example.org,
// example.invalid, *.test) that the audit prescribes as the fix are not on this
// list and never match. This rule is what catches an address the profile has
// never heard of -- a future contributor's, or an address the owner forgot he
// used -- which is the half of the problem a profile structurally cannot cover.
const CONSUMER_MAIL_DOMAINS = [
  "gmail.com", "googlemail.com",
  "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "live.co.uk", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com",
  "aol.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "gmx.de", "web.de", "t-online.de",
  "zoho.com", "fastmail.com", "tutanota.com", "hushmail.com",
  "yandex.com", "yandex.ru", "mail.ru",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "cox.net",
  "charter.net", "earthlink.net", "btinternet.com", "sky.com", "orange.fr",
  "naver.com", "qq.com", "163.com", "126.com",
];

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ACCOUNT SEGMENTS THAT NAME NOBODY.
//
// `C:\Users\<you>\...` is the shape packages/servercontrol/README.txt already
// uses correctly and the shape the audit prescribes for the 25 files that leak
// the real one; `C:\Users\testuser\...` is what it prescribes for the two suites
// that use the path as a TEST PATTERN. Both must pass, or the guard fails the
// tree that took its own advice. Anything containing < > % $ { } is a template
// by construction and covers %USERNAME%, $env:USERNAME and ${user} without
// enumerating them.
// `user` AND `test` ARE ON THIS LIST AND THAT IS SAFE, WHICH IS NOT OBVIOUS.
// Excusing them costs nothing, because an account genuinely NAMED "user" is
// still caught -- by the identity profile's windows-account-name entry, which is
// the authoritative half of this pair. The shape rule only has to cover accounts
// no profile knows about, and nobody's real account is the word "user" in a file
// that is plainly showing the reader where a path goes. Measured before adding
// them: tests/agent-engine/codex-adapter.js was reported for `C:\Users\user\` and
// `C:\Users\test\`, which are the generic examples this rule is supposed to let
// through.
// The built-in Windows accounts belong to the machine rather than to a person,
// and the role words identify a part rather than a human. Both are excused on
// the same argument as `user`: the profile still catches an account genuinely
// named any of them, so nothing is lost and 6 fixture reports are.
const PLACEHOLDER_ACCOUNTS = new Set([
  "public", "default", "defaultuser", "default user", "all users", "alluser",
  "administrator", "admin", "guest", "system",
  "testuser", "test-user", "test_user", "someuser", "user", "test",
  "owner", "customer", "operator", "developer", "someone", "person",
  "youruser", "your-user", "your_user", "yourname",
  "example", "exampleuser", "builder", "runner", "ci", "username",
]);

// Naming conventions that announce themselves as invented. Substring rather than
// equality, because these arrive as `fixture-user`, `sample_account`,
// `redacted-owner` and so on, and enumerating the combinations is whack-a-mole.
const PLACEHOLDER_MARKERS = ["fixture", "sample", "dummy", "placeholder", "synthetic", "redacted", "anonymous", "example"];

function isPlaceholderAccount(segment) {
  const value = segment.toLowerCase();
  if (/[<>%${}]/.test(value)) return true;
  // `|` cannot occur in a Windows filename at all, so a segment containing one is
  // a regular expression or a shell pipe that happens to sit after `C:\Users\`,
  // not a path. Found as an alternation in tests/agent-onboarding-hook-contract.js.
  if (value.includes("|")) return true;
  // `C:\Users\...\AppData` -- an ellipsis is prose, not an account.
  if (/^\.+$/.test(value)) return true;
  if (PLACEHOLDER_MARKERS.some((marker) => value.includes(marker))) return true;
  return PLACEHOLDER_ACCOUNTS.has(value);
}

const SHAPE_RULES = [
  {
    kind: "personal-email-shape",
    regex: new RegExp(
      `[A-Za-z0-9._%+-]+@(?:${CONSUMER_MAIL_DOMAINS.map(escapeForRegex).join("|")})(?![A-Za-z0-9.-])`,
      "gi",
    ),
  },
  {
    // A drive-rooted path whose Users\ segment names a real account. The
    // lookbehind is the URL-scheme guard the app repo's version had to learn the
    // hard way: unanchored, `[A-Za-z]:[\\/]` matches the `s:/` inside `https://`.
    // A drive letter is one letter, so the character before it is never a letter,
    // and every scheme ending in one is excluded by that alone. `[A-Za-z]` rather
    // than `\b` on purpose -- `\b` would also excuse a digit or underscore before
    // the drive letter and so would MISS `9C:\Users\<a real account>`.
    //
    // EVERY PATH WRITTEN IN THIS FILE'S OWN COMMENTS USES A PLACEHOLDER SEGMENT,
    // and that is a constraint rather than a style note: this file is publishable
    // source, so an illustrative `C:\Users\<a name>` in a comment would make the
    // guard fail on itself. A rule that cannot be satisfied does not get fixed,
    // it gets overridden -- and then it is not protecting anything at all. The
    // same reasoning is why tests/no-owner-data.test.js assembles every value it
    // plants from fragments.
    // THE SEPARATOR IS {1,2} AND THAT IS THE WHOLE RULE'S COVERAGE.
    //
    // Written as a single separator this matched `.gitignore`, `.ps1` and
    // `.toml` -- and silently missed every `.js` and `.json` file in the tree,
    // because a Windows path in JavaScript source is escaped: the bytes on disk
    // read `C:\\Users\\<you>`. That is the form the audit found in
    // tools/ledger-authority.js, the retired machine-A promotion tool and
    // sidecars/native-agent/native-agent-mcp.json, which is to say the majority
    // of the finding. Caught by a fixture in tests/no-owner-data.test.js, not by
    // reading: the guard reported the identity-profile hit on the same line and
    // looked like it was working.
    kind: "home-directory-path",
    regex: /(?<![A-Za-z])[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([^\\/\r\n"'`,;:)\]}\s]{1,64})/g,
    accept: (match) => !isPlaceholderAccount(match[1]),
  },
  {
    // The Windows default computer name. The remediation the audit prescribes
    // for this finding removes the literal entirely rather than substituting
    // one, so flagging a synthetic `DESKTOP-<7 chars>` too is intended, not an
    // over-match. (Written with a placeholder here for the reason given above:
    // spelled out, this comment would fail its own rule.)
    //
    // CASE-SENSITIVE, AND THE FIRST RUN IS WHY. Windows generates this name in
    // upper case and every real instance in this tree is upper case. Run
    // case-insensitively it also matched ordinary hyphenated English of the
    // right length -- `desktop-browser`, `desktop-capture` -- for 62 hits in one
    // fixture plus nine source files, none of them a machine name. That is the
    // failure mode the app repo's guard has already recorded twice: a rule whose
    // alarming label is mostly noise is a rule nobody reads, which costs the one
    // real hit it exists for. Upper case only drops all 62 and keeps both real
    // ones in executable source and their direct regression tests.
    kind: "machine-name-shape",
    regex: /\b(?:DESKTOP|LAPTOP)-[A-Z0-9]{7}\b/g,
  },
  {
    // The `project-<uuid>` form the audit found in README.md and in three
    // fleet-supervisor modules. Eight hex digits is enough to identify the shape;
    // the rest of the UUID is not needed and is not consumed, because nothing
    // downstream ever prints the match.
    //
    // DELIBERATELY NARROW: the general GCP project-id space is
    // `[a-z][a-z0-9-]{4,28}[a-z0-9]`, which matches most hyphenated English, so a
    // shape rule over it would be noise. Project ids outside this form are the
    // identity profile's job -- see "what this does not cover".
    //
    // Narrow is not the same as inert. On its first run this rule found the live
    // Vertex project id 157 times in tests/fixtures/agent-roster-fleet-state.json
    // and twice in tests/agent-roster-events-and-attribution.js, beside a
    // "vertex" key and an account field somebody had already redacted by hand --
    // an exposure the audit's own pass over that fixture did not enumerate,
    // because it counted account-name occurrences there and not project ids.
    kind: "cloud-project-id-shape",
    regex: /\bproject-[0-9a-f]{8}\b/g,
  },
  {
    // Unambiguous by construction: nothing but a real GCP service account is
    // named this way, and one in a published tree is a live cloud identity.
    kind: "cloud-service-account",
    regex: /[a-z0-9](?:[a-z0-9-]{4,28})@[a-z][a-z0-9-]{4,28}\.iam\.gserviceaccount\.com/gi,
  },
];

// ---------------------------------------------------------------------------
// THE IDENTITY PROFILE.
//
// WHY IT IS RESOLVED FROM OUTSIDE THE REPOSITORY, which is the one design
// decision in this file worth arguing rather than stating.
//
// The app repo's guard reads private/owner-data-patterns.owner.json -- inside
// its work tree, kept out by .gitignore. That is one edit away from failing
// silently in the worst possible direction: the file holds, by definition,
// every string this guard exists to keep out of the published tree, so a
// gitignore change or a `git add -f` publishes the guard's own configuration.
// The values would then be in git history, where deleting them does nothing.
//
// A DPAPI vault read was the other candidate and was rejected: it costs a
// PowerShell spawn, pins the guard to Windows, and makes the tool unrunnable in
// the one place a publication gate most needs to run unattended.
//
// So resolution is, in order: an explicitly-named --profile, the PROFILE_ENV
// variable, then a per-user location outside any checkout. None of those can be
// a repository path -- assertProfileOutsideRepositories() refuses one -- so
// there is no path at which a real profile could be committed by accident. That
// is a structural guarantee rather than a promise about a .gitignore line.
// ---------------------------------------------------------------------------

function defaultProfilePath() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA;
    if (base) return path.join(base, "ToolsEnabled", "owner-data-profile.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "toolsenabled", "owner-data-profile.json");
  const home = os.homedir();
  if (home) return path.join(home, ".config", "toolsenabled", "owner-data-profile.json");
  return null;
}

const PROFILE_TEMPLATE = {
  schemaVersion: 1,
  $comment: [
    "IDENTITY PROFILE for tools/check-no-owner-data.mjs.",
    "",
    "THIS FILE MUST NOT LIVE INSIDE ANY CHECKOUT. Every value in it is a string",
    "that must never be published, so a copy inside a work tree is one `git add`",
    "away from being the leak. The guard refuses a profile path under a",
    "repository root for that reason.",
    "",
    "`kind` comes from a closed list the guard defines; it is what gets PRINTED",
    "when something matches. The `value` is never printed, anywhere, by anything.",
    "Delete the entries you do not need -- an entry you keep with a REPLACE-ME",
    "value is refused, because a profile full of placeholders finds nothing and",
    "reports clean.",
  ],
  identity: [
    { kind: "windows-account-name", value: "REPLACE-ME-windows-account" },
    { kind: "owner-email-address", value: "REPLACE-ME-you@your-domain.example" },
    { kind: "owner-account-alias", value: "REPLACE-ME-cloud-account-alias" },
    { kind: "owner-personal-name", value: "REPLACE-ME-Surname" },
    { kind: "machine-name", value: "REPLACE-ME-MACHINE-NAME" },
    { kind: "cloud-project-id", value: "REPLACE-ME-cloud-project-id" },
    { kind: "private-network-prefix", value: "REPLACE-ME-192.0.2." },
    { kind: "repository-tree-name", value: "REPLACE-ME-private-tree-name" },
  ],
  publishedAttribution: ["REPLACE-ME-Your Published Name"],
};

// PUBLISHED ATTRIBUTION IS NOT A LEAK.
//
// The builder's surname genuinely must be matched: it appears inside account
// aliases, a hardcoded mail address and a home directory. But the same string is
// required by MIT's own terms in LICENSE, and required by the owner in NOTICE
// and CONTRIBUTORS.md -- all three are in the publishable set. A guard that
// forbids it forbids the product from stating who wrote it, and gets overridden
// on the day a real leak is behind it too.
//
// So the string stays matched and the attribution is excused, narrowly:
//   - only identity-profile kinds can be excused; a shape rule never can, so a
//     home-directory path or a consumer mailbox cannot be laundered by putting
//     the author's name beside it;
//   - a match is excused only when it lies WHOLLY INSIDE an occurrence of a
//     declared attribution string on the same line;
//   - excusals are counted and printed, including the zero. An excusal that
//     cannot be seen in the output is a bypass wearing a comment.
function loadProfile(resolved) {
  const shown = resolved.path;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolved.path, "utf8"));
  } catch (error) {
    // The message names the file and the parser's complaint. It must never echo
    // file CONTENT: a JSON syntax error message from a profile is one of the few
    // places a real value could reach stdout without anybody intending it.
    throw new GuardError(
      `identity profile ${shown} is present but unreadable (${error.name}). ` +
        "Fix the file; its contents are deliberately not quoted here.",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GuardError(`identity profile ${shown} must be a JSON object.`);
  }
  if (parsed.schemaVersion !== 1) {
    throw new GuardError(`identity profile ${shown}: schemaVersion must be 1.`);
  }
  if (!Array.isArray(parsed.identity)) {
    throw new GuardError(`identity profile ${shown} must contain an "identity" array.`);
  }

  const patterns = [];
  for (let index = 0; index < parsed.identity.length; index += 1) {
    const entry = parsed.identity[index];
    const where = `identity profile ${shown} entry ${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new GuardError(`${where} must be an object with "kind" and "value".`);
    }
    if (!PROFILE_KINDS.includes(entry.kind)) {
      // The kind is enumerated so the report cannot be made to print a value
      // (rule 1). An unknown kind is refused rather than passed through as a
      // free-text label, which is what would reopen that hole.
      throw new GuardError(
        `${where} has kind ${JSON.stringify(entry.kind)}, which is not one of: ${PROFILE_KINDS.join(", ")}.`,
      );
    }
    if (typeof entry.value !== "string" || !entry.value.trim()) {
      throw new GuardError(`${where} has no usable string value.`);
    }
    const value = entry.value;
    if (/^REPLACE-ME/i.test(value.trim())) {
      throw new GuardError(
        `${where} still holds a REPLACE-ME placeholder. A profile of placeholders matches nothing and ` +
          "would report this tree clean while looking for nobody. Fill it in or delete the entry.",
      );
    }
    if (value.trim().length < 3) {
      throw new GuardError(
        `${where} is shorter than 3 characters. A one- or two-character pattern matches everywhere and ` +
          "would make this guard unusable rather than strict.",
      );
    }
    if (entry.caseSensitive !== undefined && typeof entry.caseSensitive !== "boolean") {
      throw new GuardError(`${where}: "caseSensitive" must be a boolean when present.`);
    }
    patterns.push({
      kind: entry.kind,
      index,
      needles: needleForms(value),
      caseSensitive: entry.caseSensitive === true,
    });
  }

  if (patterns.length === 0) {
    throw new GuardError(
      `identity profile ${shown} declares no identity patterns. An empty profile protects nobody and ` +
        "would report a clean scan while looking for nothing.",
    );
  }

  const attribution = [];
  if (parsed.publishedAttribution !== undefined) {
    if (!Array.isArray(parsed.publishedAttribution)) {
      throw new GuardError(`identity profile ${shown}: "publishedAttribution" must be an array of strings.`);
    }
    for (const value of parsed.publishedAttribution) {
      if (typeof value !== "string" || value.trim().length < 3) {
        throw new GuardError(`identity profile ${shown}: every publishedAttribution entry must be a string of 3+ characters.`);
      }
      if (/^REPLACE-ME/i.test(value.trim())) continue;
      attribution.push({ needles: needleForms(value), caseSensitive: false });
    }
  }

  return { patterns, attribution, path: resolved.path, source: resolved.source };
}

// A literal has to be matched against text that may have been decoded either as
// raw bytes (latin1, which is what every ASCII source file effectively is) or as
// real characters (a UTF-16 file). For an ASCII value the two forms are the same
// string and this returns one needle; for a value with non-ASCII characters it
// returns both, so neither decoding can hide it. Deduplicated so the common case
// costs exactly one scan.
function needleForms(value) {
  const forms = new Set([value, Buffer.from(value, "utf8").toString("latin1")]);
  return [...forms];
}

function resolveProfilePath(explicit) {
  if (explicit) return { path: path.resolve(explicit), source: "--profile" };
  const fromEnvironment = process.env[PROFILE_ENV];
  if (fromEnvironment && fromEnvironment.trim()) {
    return { path: path.resolve(fromEnvironment.trim()), source: PROFILE_ENV };
  }
  const fallback = defaultProfilePath();
  if (fallback) return { path: fallback, source: "default per-user location" };
  return null;
}

// RULE 4, ENFORCED. A profile under a work tree is refused, never warned about.
function assertProfileOutsideRepositories(profilePath, repositories) {
  for (const repository of repositories) {
    const root = path.resolve(repository);
    const relative = path.relative(root, profilePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      throw new GuardError(
        `identity profile ${profilePath} is INSIDE the repository ${root}. Every value in that file is a ` +
          "string this guard exists to keep out of a published tree, so a copy inside a work tree is one " +
          "`git add -f` away from being the leak itself -- and once committed, deleting it does not remove " +
          "it from history. Move it outside every checkout and point at it with --profile or " +
          `${PROFILE_ENV}.`,
      );
    }
  }
}

function requireProfile(explicit, repositories) {
  const resolved = resolveProfilePath(explicit);
  if (!resolved) {
    throw new GuardError(
      "no identity profile could be located and no default per-user location exists on this platform. " +
        `Pass --profile <path>, or set ${PROFILE_ENV}.`,
    );
  }
  assertProfileOutsideRepositories(resolved.path, repositories);
  if (!existsSync(resolved.path)) {
    // RULE 3. This is the failure the original guard shipped with: its profile
    // was absent, so it matched nothing, so it reported clean, so nobody knew it
    // was doing nothing. Naming all three sources here is the difference between
    // a refusal somebody can act on and one they route around.
    throw new GuardError(
      `no identity profile at ${resolved.path} (chosen from: ${resolved.source}).\n` +
        "  REFUSING rather than passing. Without a profile this guard would scan the whole publishable set,\n" +
        "  find nothing that identifies anybody, and report it clean -- which is precisely how the guard this\n" +
        "  one replaces came to be believed in while doing nothing.\n" +
        "  Provide one, in order of precedence:\n" +
        "    --profile <path>\n" +
        `    ${PROFILE_ENV}=<path>\n` +
        `    ${defaultProfilePath() || "(no per-user default on this platform)"}\n` +
        "  Start from a template:  node tools/check-no-owner-data.mjs --print-template > <path outside any checkout>\n" +
        "  It must NOT live inside a checkout; a path under a repository root is refused.",
    );
  }
  return loadProfile(resolved);
}

// ---------------------------------------------------------------------------
// THE PUBLISHABLE SET.
// ---------------------------------------------------------------------------

function git(repository, arguments_, what) {
  try {
    return execFileSync("git", ["-C", repository, ...arguments_], {
      encoding: "utf8",
      env: safeLaunchEnvironment(process.env, { context: "owner data guard git" }),
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new GuardError("git is not on PATH, so the publishable set cannot be determined at all.");
    }
    const detail = `${error?.stderr || ""}`.trim() || error?.message || "unknown git failure";
    throw new GuardError(`${what} failed in ${repository}: ${detail}`);
  }
}

// -z because git QUOTES paths containing spaces or non-ASCII bytes in its default
// output, and a quoted path is a different string that would match no manifest
// entry. -s carries the mode, which is the only way to see a symlink here.
function trackedFiles(repository) {
  const raw = git(repository, ["ls-files", "-s", "-z"], "git ls-files");
  const files = [];
  const symlinks = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) throw new GuardError(`git ls-files produced an unparseable record: ${JSON.stringify(record)}`);
    const mode = record.slice(0, record.indexOf(" "));
    const file = record.slice(tab + 1);
    if (mode === "120000") symlinks.push(file);
    else files.push(file);
  }
  return { files, symlinks };
}

// THE CUSTOMER-DISTRIBUTION RULE, COPIED DELIBERATELY.
//
// The boundary manifest describes eligible source with exactly this test:
// open.paths has the file, or an open.prefixes entry prefixes it. It does NOT
// apply the boundary checker's restrictive-first precedence. Reimplementing the
// stricter rule here would scan a SMALLER set than the one that ships, and a
// leak guard that scans less than the distributable set is a guard with a blind
// spot shaped exactly like a classification bug.
function loadOpenRules(manifestFile) {
  if (!existsSync(manifestFile)) {
    throw new GuardError(
      `${manifestFile} is missing. Without the boundary manifest there is no publishable set to scan, ` +
        "and scanning the whole tree would report findings in files that are never published.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (error) {
    throw new GuardError(`${MANIFEST_RELATIVE} is present but unreadable: ${error.message}`);
  }
  const open = parsed?.open;
  if (!open || typeof open !== "object" || Array.isArray(open)) {
    throw new GuardError(`${MANIFEST_RELATIVE} must contain an "open" object.`);
  }

  let pathEntries = [];
  if (open.paths !== undefined) {
    if (Array.isArray(open.paths)) pathEntries = open.paths;
    else if (open.paths && typeof open.paths === "object") pathEntries = Object.keys(open.paths);
    else {
      throw new GuardError(`${MANIFEST_RELATIVE} open.paths must be an array or object.`);
    }
  }
  if (!pathEntries.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new GuardError(`${MANIFEST_RELATIVE} open.paths entries must be non-empty strings.`);
  }

  let prefixes = [];
  if (open.prefixes !== undefined) {
    if (!Array.isArray(open.prefixes)) {
      throw new GuardError(`${MANIFEST_RELATIVE} open.prefixes must be an array.`);
    }
    if (!open.prefixes.every((entry) => typeof entry === "string" && entry.length > 0)) {
      throw new GuardError(`${MANIFEST_RELATIVE} open.prefixes entries must be non-empty strings.`);
    }
    prefixes = open.prefixes;
  }

  const paths = new Set(pathEntries);
  if (paths.size === 0 && prefixes.length === 0) {
    throw new GuardError(
      `${MANIFEST_RELATIVE} classifies nothing as "open". Nothing to check -- and a guard that reports ` +
        "clean because it was handed an empty set is the failure this file exists to prevent.",
    );
  }
  return { paths, prefixes };
}

function selectPublishable(tracked, rules) {
  return tracked.filter((file) => rules.paths.has(file) || rules.prefixes.some((prefix) => file.startsWith(prefix)));
}

// ---------------------------------------------------------------------------
// SCANNING.
//
// ONE PASS PER FILE, NO CHILD PROCESSES, NOTHING PER-FILE THAT IS NOT O(bytes).
// The whole publishable set is ~24 MB today; this has to stay cheap enough to
// sit in a check chain, so: literals are matched with native indexOf over a
// single decoded string, the lowercase copy is made once per file rather than
// once per pattern, and the line index is built ONLY for a file that already
// produced a hit -- a clean file pays nothing for the reporting machinery.
// ---------------------------------------------------------------------------

// Decoding is chosen for FAITHFULNESS, not prettiness. latin1 maps one byte to
// one character and never fails, so an ASCII source file decodes to exactly its
// own bytes and nothing can hide behind a replacement character. A UTF-16 file
// is decoded as UTF-16 so its line breaks and its text are both real.
//
// NAMED LIMITATION: a UTF-16 file with no BOM is scanned as single-byte text,
// where an ASCII literal appears interleaved with NULs and will be missed. git
// treats such a file as binary and no file in this tree is one; a BOM-less
// UTF-16 file added later is a hole, and it is named here rather than assumed
// away.
function decodeBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buffer.toString("latin1");
}

function lineIndex(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function occurrences(haystack, needle) {
  const hits = [];
  if (!needle) return hits;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return hits;
    hits.push({ offset: at, length: needle.length });
    from = at + 1; // overlapping occurrences are still occurrences
  }
}

function scanFile(text, profile) {
  const lowered = text.toLowerCase();
  const raw = [];

  for (const rule of SHAPE_RULES) {
    rule.regex.lastIndex = 0;
    let match;
    while ((match = rule.regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        rule.regex.lastIndex += 1;
        continue;
      }
      if (rule.accept && !rule.accept(match)) continue;
      raw.push({ kind: rule.kind, offset: match.index, length: match[0].length, excusable: false });
    }
  }

  for (const pattern of profile.patterns) {
    for (const needle of pattern.needles) {
      const target = pattern.caseSensitive ? text : lowered;
      const probe = pattern.caseSensitive ? needle : needle.toLowerCase();
      for (const hit of occurrences(target, probe)) {
        raw.push({ kind: pattern.kind, offset: hit.offset, length: hit.length, excusable: true });
      }
    }
  }

  if (raw.length === 0) return { hits: [], excused: 0 };

  // Attribution spans are computed only once a file has already produced a hit,
  // so a clean scan never pays for them.
  let spans = [];
  if (profile.attribution.length > 0 && raw.some((hit) => hit.excusable)) {
    for (const entry of profile.attribution) {
      for (const needle of entry.needles) {
        for (const hit of occurrences(lowered, needle.toLowerCase())) {
          spans.push({ start: hit.offset, end: hit.offset + hit.length });
        }
      }
    }
  }

  let excused = 0;
  const kept = [];
  for (const hit of raw) {
    if (hit.excusable && spans.length > 0) {
      const inside = spans.some((span) => hit.offset >= span.start && hit.offset + hit.length <= span.end);
      if (inside) {
        excused += 1;
        continue;
      }
    }
    kept.push(hit);
  }
  return { hits: kept, excused };
}

// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    repository: REPO_ROOT,
    profile: null,
    mode: "scan",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--print-template") {
      options.mode = "template";
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.mode = "help";
      continue;
    }
    if (argument === "--repo" || argument === "--manifest" || argument === "--profile") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new GuardError(`${argument} needs a path.`);
      if (argument === "--repo") options.repository = value;
      if (argument === "--manifest") options.manifest = value;
      if (argument === "--profile") options.profile = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new GuardError(`unknown flag ${argument}`);
    throw new GuardError(`unexpected argument ${JSON.stringify(argument)}; use --repo <path>.`);
  }
  options.repository = path.resolve(options.repository);
  options.manifest = path.resolve(options.manifest);
  return options;
}

const HELP = `check-no-owner-data.mjs -- does the customer-distributable set carry the builder's identity?

  --repo <path>       repository to scan (default: this checkout)
  --manifest <path>   boundary manifest (default: ${MANIFEST_RELATIVE})
  --profile <path>    identity profile. MUST be outside every checkout.
                      Falls back to ${PROFILE_ENV}, then a per-user location.
  --print-template    write a starter profile to stdout and exit

It reads the tracked files the manifest classifies "open" -- the source set
eligible for authenticated customer or self-hosted distribution -- and never a build directory.

It never prints a matched value. Findings are file, line and kind only.

Exit 0 clean; 1 findings; 2 refusal (no usable profile, no manifest, nothing to scan).
`;

function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.mode === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.mode === "template") {
    process.stdout.write(`${JSON.stringify(PROFILE_TEMPLATE, null, 2)}\n`);
    process.stderr.write(
      "\nWrite that OUTSIDE every checkout, replace every REPLACE-ME value, and delete the entries you do " +
        `not need. Then point at it with --profile or ${PROFILE_ENV}.\n`,
    );
    return 0;
  }

  const inside = git(options.repository, ["rev-parse", "--is-inside-work-tree"], "git rev-parse").trim();
  if (inside !== "true") throw new GuardError(`nothing to check: not a git work tree: ${options.repository}`);

  // Profile first, and before a single file is read: a setup problem must cost
  // milliseconds, not a full scan, and must never be reachable only after the
  // walk has already printed half a report.
  const profile = requireProfile(options.profile, [options.repository, REPO_ROOT]);

  const rules = loadOpenRules(options.manifest);
  const { files: tracked, symlinks } = trackedFiles(options.repository);
  if (tracked.length === 0 && symlinks.length === 0) {
    throw new GuardError(`nothing to check: git tracks 0 files in ${options.repository}`);
  }

  const publishable = selectPublishable(tracked, rules);
  const publishableSymlinks = selectPublishable(symlinks, rules);
  if (publishable.length === 0 && publishableSymlinks.length === 0) {
    throw new GuardError(
      `nothing to check: no tracked file in ${options.repository} is classified "open". A clean verdict ` +
        "over an empty set is not a clean verdict.",
    );
  }

  const findings = new Map(); // "file\0line\0kind" -> {file, line, kind, count}
  const record = (file, line, kind) => {
    const key = `${file}\0${line === null ? "" : line}\0${kind}`;
    const existing = findings.get(key);
    if (existing) existing.count += 1;
    else findings.set(key, { file, line, kind, count: 1 });
  };

  let bytesScanned = 0;
  let filesScanned = 0;
  let excusedTotal = 0;

  // A symlink in the publishable set is reported, not followed: its name is
  // classified but its content is somewhere else entirely, so following it would
  // clear one path while publishing another's bytes.
  for (const file of publishableSymlinks) record(file, null, "unreadable");

  for (const file of publishable) {
    let buffer;
    try {
      const full = path.join(options.repository, file);
      const stat = statSync(full);
      if (!stat.isFile()) throw new Error("not a regular file");
      buffer = readFileSync(full);
    } catch {
      // RULE 2. Tracked-but-deleted, unreadable, or replaced by a directory.
      // The publisher would copy this path; nobody has read it; that is a
      // finding. The underlying error is deliberately not echoed -- an ENOENT
      // message carries the absolute path, which carries the account name.
      record(file, null, "unreadable");
      continue;
    }

    filesScanned += 1;
    bytesScanned += buffer.length;

    const text = decodeBuffer(buffer);
    const { hits, excused } = scanFile(text, profile);
    excusedTotal += excused;
    if (hits.length === 0) continue;

    const starts = lineIndex(text);
    for (const hit of hits) record(file, lineOf(starts, hit.offset), hit.kind);
  }

  const byKind = new Map();
  for (const pattern of profile.patterns) byKind.set(pattern.kind, (byKind.get(pattern.kind) ?? 0) + 1);
  const profileSummary = [...byKind.entries()].sort().map(([kind, count]) => `${kind}=${count}`).join(", ");

  console.log("Owner-data guard: the publishable set of " + MANIFEST_RELATIVE);
  console.log(`Repository: ${options.repository}`);
  console.log(`Identity profile: ${profile.path} (via ${profile.source}; ${profile.patterns.length} pattern(s): ${profileSummary})`);
  console.log(`Shape rules: ${SHAPE_RULES.length} (built in; no identity needed, and never excusable).`);
  console.log(
    `Publishable set: ${publishable.length + publishableSymlinks.length} of ${tracked.length + symlinks.length} tracked file(s) ` +
      "(informational -- this guard asserts on named paths, never on a count).",
  );
  console.log(`Scanned: ${filesScanned} file(s), ${bytesScanned} byte(s).`);
  console.log(
    `Excused as published attribution: ${excusedTotal} ` +
      `(${profile.attribution.length} permitted string(s); shape rules are never excused).`,
  );

  const ordered = [...findings.values()].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.kind.localeCompare(right.kind),
  );

  if (ordered.length === 0) {
    console.log("\nOWNER-DATA GUARD: clean. No owner-identifying data in the publishable set.");
    console.log("This clears the files listed above ONLY, at this commit, against this profile. It says nothing");
    console.log("about withheld files, about git history, or about what a reader could infer from the design.");
    return 0;
  }

  const fileCount = new Set(ordered.map((finding) => finding.file)).size;
  console.error(`\nOWNER DATA IN THE PUBLISHABLE SET -- ${ordered.length} finding(s) across ${fileCount} file(s).`);
  console.error(
    "NO MATCHED VALUE IS PRINTED BELOW, and that is deliberate: this report gets pasted into terminals,\n" +
      "issues and handoffs, and a leak report that quotes the leak is a second copy of the leak in a place\n" +
      "with weaker handling than the original. Open the named line and read it yourself.\n",
  );

  for (const finding of ordered.slice(0, PRINT_LIMIT)) {
    const at = finding.line === null ? "" : `:${finding.line}`;
    const times = finding.count > 1 ? ` x${finding.count}` : "";
    console.error(`  ${finding.file}${at}  --  ${finding.kind}${times}`);
  }
  if (ordered.length > PRINT_LIMIT) {
    // The line list truncates; the FILE list never does. Whoever has to fix this
    // needs the complete set of files to open, and a per-line list long enough
    // to be cut is exactly when that matters most. Rule 5 still holds: the counts
    // beside each path are information, and the verdict was taken over every
    // finding above.
    console.error(
      `  ... and ${ordered.length - PRINT_LIMIT} more line(s). TRUNCATED FOR READING ONLY -- the verdict is ` +
        "taken over every one of them. Every affected file, in full:",
    );
    const perFile = new Map();
    for (const finding of ordered) perFile.set(finding.file, (perFile.get(finding.file) ?? 0) + finding.count);
    for (const [file, count] of [...perFile.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
      console.error(`    ${String(count).padStart(6)}  ${file}`);
    }
  }

  const kindTotals = new Map();
  for (const finding of ordered) kindTotals.set(finding.kind, (kindTotals.get(finding.kind) ?? 0) + finding.count);
  console.error("\nBY KIND:");
  for (const [kind, count] of [...kindTotals.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
    console.error(`  ${String(count).padStart(6)}  ${kind}  --  ${KINDS.get(kind)}`);
  }

  console.error(
    "\nFix by redacting the file or reclassifying it in " +
      `${MANIFEST_RELATIVE} -- never by removing the pattern from the profile. A guard that stops looking\n` +
      "for something goes on reporting clean while covering less, and the loss is invisible.",
  );
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof GuardError) {
    console.error(`Owner-data guard REFUSED: ${error.message}`);
  } else {
    console.error(`Owner-data guard REFUSED: ${error.stack || error.message}`);
  }
  // Exit 2, never 1. "I was not set up" and "the tree is dirty" are different
  // problems with different fixes, and a caller that cannot tell them apart will
  // eventually treat one as the other.
  process.exitCode = 2;
}
