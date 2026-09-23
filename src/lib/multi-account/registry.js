'use strict';
// The multi-account registry: which accounts this machine can run as.
//
// THREE PROVIDERS, ONE FILE, AND THE FIELD NAME IS THE PROVIDER'S OWN WORD.
// A Codex account names a `profileDir` and is selected with CODEX_HOME; a
// Claude account names a `configDir` and is selected with CLAUDE_CONFIG_DIR; a
// Gemini account names a `homeDir` and is selected with GEMINI_CLI_HOME.
// They are not spelled the same because they are not the same thing: CODEX_HOME
// is a whole home directory the CLI owns, CLAUDE_CONFIG_DIR is the
// configuration directory the official Claude program signs itself into, and
// GEMINI_CLI_HOME is the directory the Gemini CLI treats as the user's home
// (its `.gemini` folder is created inside it). Naming all three `profileDir`
// would have made two of the entries lie about what their value is. Internally
// each entry also carries `home`, which is whichever of the three that entry
// declared, so every consumer below resolves ONE field and needs no provider
// branch of its own.
//
// NAMES ARE UNIQUE PER PROVIDER, NOT GLOBALLY, and that is a requirement rather
// than a relaxation: the same person's account is called the same thing on both
// providers -- one human being with one e-mail who subscribes to both -- and a
// global rule would force one of those two entries to be given a name its owner
// does not recognise. Selection is always made within a provider (accountsFor),
// so a name shared across providers is never ambiguous.
//
// Isolation model (reused, not invented): one complete Codex home directory per
// account, selected with the CODEX_HOME environment variable. This is the
// technique already proven by config/codex.json and
// src/lib/mission-bridge/actions.js -- the owner called it "subfolders as the
// launchpad". Each home carries its own auth.json, config.toml and session
// state, so accounts coexist and nothing is ever swapped in place. The
// alternative that this replaces is still visible on this machine as a
// timestamped `~/.codex/auth.json.bak-<account>-<date>` file: a manual
// backup-and-overwrite of a single shared home, which loses session state and
// races any concurrent process. (The real filename is deliberately not written
// here -- it names one of the builder's own accounts, and this file ships.)
//
// This module reads names and directories ONLY. No credential value is read,
// returned, logged or stored here. Liveness is not decided here either --
// see health.js, because the presence of an auth.json proves nothing about
// whether the account can actually serve a request.

const fs = require('node:fs');
const path = require('node:path');

const { normalizeRankWindow, normalizeReservePercent, normalizeSelectionMode } = require('./selection-modes.js');

const DEFAULT_EXHAUSTED_AT_PERCENT = 99;

// What each provider calls its home, and the file whose PRESENCE means somebody
// has signed in there at least once. That is a provisioning check and nothing
// more -- see profileProvisioned() for why presence proves so little, and
// health.js for what actually decides whether an account can serve.
//
// The three file names are measured, not guessed: a Codex home holds auth.json
// (config/codex.json and every existing consumer already agree on that), a
// Claude configuration directory holds .credentials.json -- the same file the
// app's own provider-cli-presence surface already looks for when it tells a
// person whether they are signed in -- and a Gemini home holds
// `.gemini/oauth_creds.json`. The Gemini pair was verified against the
// upstream gemini-cli source rather than assumed: packages/core/src/utils/
// paths.ts's homedir() honours GEMINI_CLI_HOME before the operating system's
// answer, and packages/core/src/config/storage.ts names OAUTH_FILE as
// 'oauth_creds.json' inside the `.gemini` directory under that home.
//
// NOTHING HERE OPENS ANY OF THESE FILES. The name is used for an existence
// check and for nothing else, in this module and in every module that reads
// this table.
const PROVIDERS = Object.freeze({
  codex: Object.freeze({ id: 'codex', dirField: 'profileDir', homeEnv: 'CODEX_HOME', signInFile: 'auth.json' }),
  claude: Object.freeze({ id: 'claude', dirField: 'configDir', homeEnv: 'CLAUDE_CONFIG_DIR', signInFile: '.credentials.json' }),
  gemini: Object.freeze({ id: 'gemini', dirField: 'homeDir', homeEnv: 'GEMINI_CLI_HOME', signInFile: 'oauth_creds.json' }),
  grok: Object.freeze({ id: 'grok', dirField: 'configDir', homeEnv: 'GROK_HOME', signInFile: 'auth.json' })
});

const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

function providerSpec(provider) {
  return typeof provider === 'string' && Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : null;
}

// "codex, claude and gemini": the supported kinds as one readable list, for
// every refusal that has to name them. Built from the table so a fourth
// provider changes the sentence without anybody retyping it.
function describeProviders(ids = PROVIDER_IDS) {
  if (ids.length <= 1) return ids.join('');
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

class MultiAccountError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MultiAccountError';
    this.code = code;
    this.details = details;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// A registry that cannot be parsed is a refusal, never an empty account list.
// An empty list silently means "no account is usable", which this system is
// required to report loudly rather than degrade into.
function parseRegistry(raw, { source }) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MultiAccountError('ACCOUNTS_REGISTRY_UNPARSABLE',
      `The account registry at ${source} is not valid JSON, so no account can be selected.`,
      { source });
  }
  if (!plainObject(parsed) || !Array.isArray(parsed.accounts)) {
    throw new MultiAccountError('ACCOUNTS_REGISTRY_INVALID',
      `The account registry at ${source} has no "accounts" array.`, { source });
  }

  const exhaustedAtPercent = Number.isSafeInteger(parsed.exhaustedAtPercent)
    && parsed.exhaustedAtPercent > 0 && parsed.exhaustedAtPercent <= 100
    ? parsed.exhaustedAtPercent
    : DEFAULT_EXHAUSTED_AT_PERCENT;

  /* WHICH ACCOUNT GOES FIRST, KEPT BESIDE THE ACCOUNTS IT ORDERS.
   *
   * The alternative was a second file, and a second file is a second answer:
   * the rotation would read one and the screen that lists these accounts would
   * write the other, and the day they disagreed nothing would say which was in
   * force. Both fields are OPTIONAL and both fall back to the cautious value --
   * ./selection-modes.js normalises anything it does not recognise to `manual`,
   * which never moves between accounts on its own. A registry written before
   * these fields existed therefore behaves exactly as it always did.
   *
   * ABSENT IS `null`, NOT `manual`, AND THAT DISTINCTION IS LOAD-BEARING. The
   * caller layers this over an older setting (rotation.js states the order of
   * precedence), and normalising an absent field to `manual` would make "this
   * file predates the dropdown" indistinguishable from "the person chose to be
   * asked" -- the second of which must win over the older setting and the first
   * of which must not. */
  const selectionMode = parsed.selectionMode === undefined || parsed.selectionMode === null
    ? null
    : normalizeSelectionMode(parsed.selectionMode);
  const reservePercent = parsed.reservePercent === undefined || parsed.reservePercent === null
    ? null
    : normalizeReservePercent(parsed.reservePercent);
  const rankWindow = parsed.rankWindow === undefined || parsed.rankWindow === null
    ? null
    : normalizeRankWindow(parsed.rankWindow);
  /* ONE RULE PER PROGRAM, when the person set one (owner, 2026-09-02: "by
     provider"). `selectionByProvider` holds, per provider id, the same three
     fields the record holds globally; a field left out inherits the global
     one, and a program with no entry inherits everything. Absent stays null,
     never an empty table, for the same reason the global fields do. */
  const selectionByProvider = plainObject(parsed.selectionByProvider)
    ? Object.freeze(Object.fromEntries(Object.entries(parsed.selectionByProvider)
      .filter(([id, entry]) => Object.hasOwn(PROVIDERS, id) && plainObject(entry))
      .map(([id, entry]) => [id, Object.freeze({
        selectionMode: entry.selectionMode === undefined || entry.selectionMode === null ? null : normalizeSelectionMode(entry.selectionMode),
        reservePercent: entry.reservePercent === undefined || entry.reservePercent === null ? null : normalizeReservePercent(entry.reservePercent),
        rankWindow: entry.rankWindow === undefined || entry.rankWindow === null ? null : normalizeRankWindow(entry.rankWindow)
      })])))
    : null;

  const seenNames = new Set();
  const seenDirs = new Set();
  let antigravityRegistered = false;
  const accounts = parsed.accounts.map((entry, index) => {
    if (!plainObject(entry)) {
      throw new MultiAccountError('ACCOUNTS_ENTRY_INVALID',
        `Account entry ${index} in ${source} is not an object.`, { source, index });
    }
    for (const field of ['name', 'provider']) {
      if (!nonEmptyString(entry[field])) {
        throw new MultiAccountError('ACCOUNTS_ENTRY_INVALID',
          `Account entry ${index} in ${source} is missing a "${field}".`, { source, index, field });
      }
    }
    const spec = providerSpec(entry.provider);
    if (!spec) {
      throw new MultiAccountError('ACCOUNTS_PROVIDER_UNSUPPORTED',
        `Account "${entry.name}" declares provider "${entry.provider}"; this registry supports ${describeProviders()}.`,
        { source, name: entry.name, provider: entry.provider });
    }
    if (!nonEmptyString(entry[spec.dirField])) {
      throw new MultiAccountError('ACCOUNTS_ENTRY_INVALID',
        `Account entry ${index} in ${source} is a ${spec.id} account, so it is missing a "${spec.dirField}".`,
        { source, index, field: spec.dirField });
    }
    if (entry.client != null && (spec.id !== 'gemini' || entry.client !== 'antigravity')) {
      throw new MultiAccountError('ACCOUNTS_CLIENT_UNSUPPORTED',
        'Only Gemini accounts may select the supported Antigravity client.', { source, index });
    }
    if (entry.client === 'antigravity') {
      if (antigravityRegistered) throw new MultiAccountError('ACCOUNTS_CLIENT_SIGNIN_SHARED',
        'Antigravity uses the current OS sign-in. Additional folders cannot be registered as separate accounts or allowance.', { source });
      antigravityRegistered = true;
    }
    const name = entry.name.trim();
    // Duplicate names would make `use <name>` ambiguous and could silently
    // route a launch to the wrong identity -- the exact failure this system
    // exists to prevent.
    if (seenNames.has(`${spec.id}:${name.toLowerCase()}`)) {
      throw new MultiAccountError('ACCOUNTS_NAME_DUPLICATE',
        `Account name "${name}" appears more than once under provider "${spec.id}" in ${source}.`,
        { source, name, provider: spec.id });
    }
    seenNames.add(`${spec.id}:${name.toLowerCase()}`);

    const role = nonEmptyString(entry.role) ? entry.role.trim().toLowerCase() : null;
    if (role !== null && seenNames.has(`${spec.id}:role:${role}`)) {
      throw new MultiAccountError('ACCOUNTS_ROLE_DUPLICATE',
        `Role "${role}" is assigned to more than one ${spec.id} account in ${source}.`,
        { source, role, provider: spec.id });
    }
    if (role !== null) seenNames.add(`${spec.id}:role:${role}`);

    const priority = Number.isSafeInteger(entry.priority) && entry.priority > 0
      ? entry.priority
      : index + 1;

    const home = entry[spec.dirField].trim();
    return Object.freeze({
      name,
      role,
      provider: spec.id,
      ...(entry.client ? { client: entry.client } : {}),
      // The provider's own word for its directory, echoed back so a caller that
      // writes this entry out again produces the file it read in.
      [spec.dirField]: home,
      // The one field every consumer below resolves. Same value; one name.
      home,
      expectEmail: nonEmptyString(entry.expectEmail) ? entry.expectEmail.trim().toLowerCase() : null,
      priority
    });
  });

  if (accounts.length === 0) {
    throw new MultiAccountError('ACCOUNTS_REGISTRY_EMPTY',
      `The account registry at ${source} lists no accounts.`, { source });
  }

  for (const account of accounts) {
    const key = `${account.provider}:${account.home.toLowerCase()}`;
    // Two accounts of the SAME provider sharing one home is not multi-account:
    // they would overwrite each other's sign-in, which is precisely the failure
    // mode the per-directory launchpad replaced. Scoped by provider because two
    // DIFFERENT providers pointed at one directory is merely unusual, not
    // self-defeating -- they read different files inside it.
    if (seenDirs.has(key)) {
      throw new MultiAccountError('ACCOUNTS_PROFILE_DIR_SHARED',
        `More than one ${account.provider} account in ${source} uses "${account.home}".`,
        { source, provider: account.provider, home: account.home });
    }
    seenDirs.add(key);
  }

  accounts.sort((a, b) => (a.priority - b.priority)
    || a.provider.localeCompare(b.provider)
    || a.name.localeCompare(b.name));
  /* One limit per window, each optional. Absent means "use the single
     number", which is what every registry written before this said. */
  const percentOrNull = value => (Number.isSafeInteger(value) && value > 0 && value <= 100 ? value : null);
  const exhaustedAtPercentHourly = percentOrNull(parsed.exhaustedAtPercentHourly);
  const exhaustedAtPercentWeekly = percentOrNull(parsed.exhaustedAtPercentWeekly);
  return Object.freeze({ exhaustedAtPercent, exhaustedAtPercentHourly, exhaustedAtPercentWeekly, selectionMode, reservePercent, rankWindow, selectionByProvider, accounts: Object.freeze(accounts), source });
}

function loadRegistry({ configPath, fsImpl = fs } = {}) {
  if (!nonEmptyString(configPath)) {
    throw new MultiAccountError('ACCOUNTS_REGISTRY_PATH_INVALID', 'No account registry path was given.');
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(configPath, 'utf8');
  } catch (error) {
    // ENOENT/ENOTDIR are the only two codes that establish the file truly is
    // not there -- the same line profileProvisioned() draws below, and the one
    // readForUpdate() in ./registry-write.js already draws for the write path,
    // under this same pair of codes. Everything else -- EACCES, EPERM, EISDIR,
    // EBUSY, EIO, an injected failure -- means the read could not be made, and
    // says nothing about whether the file exists.
    if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
      // A file that could not be READ must never be reported as a file that
      // is not there: this is the could-not-look / not-there seam, and this
      // catch used to answer both conditions with one sentence. Measured
      // 2026-09-03 against the live action ledger: cloud.account_list alone
      // logged 313 mcp.tool.failed records carrying the "not there" sentence
      // below -- 41.5% of every recorded tool failure -- and any one of them
      // caused by a permission or I/O fault would have told the owner to "add
      // an account" onto a registry that may have been sitting right there,
      // unreadable for a reason that has nothing to do with registration.
      throw new MultiAccountError('ACCOUNTS_REGISTRY_UNREADABLE',
        `The account registry at ${configPath} could not be read, so no account could be selected.`,
        { source: configPath, cause: (error && error.code) || null });
    }
    /* THE PATH STAYS; THE INSTRUCTION GOES.
     *
     * This sentence used to end "Create it before switching accounts", which
     * made a JSON file the customer's next step -- for a file in a directory
     * they have no reason to know exists, in a format nothing told them. That
     * was accurate for as long as nothing in the product wrote this file, and
     * ./registry-write.js is the end of that: adding an account creates the
     * directory and writes the entry.
     *
     * The path is still named because a developer reading a log needs to know
     * WHICH registry was looked for -- there is more than one candidate (see
     * ./registry-location.js) -- and because the bridge strips paths out of
     * anything that reaches a person anyway
     * (src/lib/mission-bridge/errors.js). What a customer must not be handed is
     * a filename as an ACTION, and that is what changed. */
    throw new MultiAccountError('ACCOUNTS_REGISTRY_MISSING',
      `No account registry at ${configPath}. Add an account in ToolsEnabled and it will be written; nobody has to create this file by hand.`,
      { source: configPath, cause: error.code || null });
  }
  return parseRegistry(raw, { source: configPath });
}

// Relative directories resolve against the user profile, matching the existing
// config/codex.json contract so both files mean the same thing by the same
// string.
function resolveProfileDir(account, { homeDir } = {}) {
  // `home` is what parseRegistry() produces; the provider's own field is still
  // accepted so a hand-built account literal -- which tools/account.js and
  // several tests construct directly -- keeps resolving without going through
  // the parser. `profileDir` stays the last fallback for the Codex literals
  // that predate the table.
  const spec = providerSpec(plainObject(account) ? account.provider : null);
  const declared = plainObject(account)
    ? (nonEmptyString(account.home)
      ? account.home
      : (spec && nonEmptyString(account[spec.dirField]) ? account[spec.dirField] : account.profileDir))
    : null;
  if (!nonEmptyString(declared)) {
    throw new MultiAccountError('ACCOUNTS_ENTRY_INVALID', 'Account has no directory to resolve.');
  }
  if (path.isAbsolute(declared)) return path.resolve(declared);
  if (!nonEmptyString(homeDir)) {
    throw new MultiAccountError('ACCOUNTS_HOME_DIR_UNKNOWN',
      `Account "${account.name}" uses a relative directory but no home directory is known.`,
      { name: account.name });
  }
  return path.resolve(path.join(homeDir, declared));
}

// WHERE THE SIGN-IN FILE SITS INSIDE A RESOLVED HOME. Codex and Claude keep it
// directly in the directory the entry names. The Gemini CLI does not: it treats
// GEMINI_CLI_HOME as a HOME directory and writes its own `.gemini` folder inside
// it, so the file whose presence means "signed in" is one level down. Stated in
// one place so every presence check (here, launch.js, health.js) asks about the
// same path. Still a path only; nothing here opens it.
const GEMINI_STATE_DIR = '.gemini';

function signInFilePath(resolvedHome, spec) {
  return spec.id === 'gemini'
    ? path.join(resolvedHome, GEMINI_STATE_DIR, spec.signInFile)
    : path.join(resolvedHome, spec.signInFile);
}

// Presence of auth.json is a NECESSARY but NOT SUFFICIENT condition. It says a
// home has been signed in at some point. It does not say the account can serve
// a request today: this machine has an auth.json whose id_token expired
// 2026-08-09 while `codex login status` still answered "Logged in", and the
// same account still served a live request because the CLI refreshed off its
// refresh_token. So this is a provisioning check only. Never route on it.
function profileProvisioned(account, { homeDir, fsImpl = fs } = {}) {
  // An invalid declaration is not evidence that the sign-in file is absent.
  // Let resolveProfileDir()'s refusal reach the caller instead of turning a
  // failure to identify the directory into a confident "not provisioned".
  const resolved = resolveProfileDir(account, { homeDir });
  if (account?.client === 'antigravity') {
    throw new MultiAccountError('ACCOUNT_PROVISIONING_UNKNOWN',
      'Antigravity sign-in must be checked through its native client, not a legacy Gemini credential file.',
      { name: account.name, provider: account.provider, cause: 'NATIVE_CLIENT_STATUS_REQUIRED' });
  }
  // The file is chosen from the entry's own provider, defaulting to the Codex one
  // so an account literal built before this registry knew about a second provider
  // still asks exactly the question it always asked.
  const spec = providerSpec(plainObject(account) ? account.provider : null) || PROVIDERS.codex;
  try {
    const isolation = require('../provider-session-isolation');
    const credentialPath = isolation.assertIsolatedCredential(signInFilePath(resolved, spec), isolation.isolationContext());
    return fsImpl.statSync(credentialPath).isFile();
  } catch (error) {
    // These two errors establish that the requested file cannot exist at this
    // path. Permission, I/O, and injected filesystem failures establish no
    // such thing and must remain unknown to the caller.
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw new MultiAccountError('ACCOUNT_PROVISIONING_UNKNOWN',
      `Could not determine whether account "${account.name}" has been provisioned.`,
      { name: account.name, provider: spec.id, cause: error && error.code ? error.code : null });
  }
}

// The accounts of ONE provider, in priority order. Selection is always made
// within a provider: a Claude session cannot fail over onto a Codex account, and
// offering it one would be a category error wearing a routing decision.
function accountsFor(registry, provider) {
  if (!registry || !Array.isArray(registry.accounts)) {
    throw new MultiAccountError('ACCOUNTS_REGISTRY_INVALID',
      'Cannot list accounts because the registry has no "accounts" array.');
  }
  if (!nonEmptyString(provider)) return registry.accounts.slice();
  const needle = provider.trim().toLowerCase();
  return registry.accounts.filter(account => account.provider === needle);
}

function findAccount(registry, selector, { provider = null } = {}) {
  if (!nonEmptyString(selector)) return null;
  const needle = selector.trim().toLowerCase();
  const pool = provider ? accountsFor(registry, provider) : registry.accounts;
  return pool.find(account => account.name.toLowerCase() === needle)
    || pool.find(account => account.role === needle)
    || null;
}

function requireAccount(registry, selector, { provider = null } = {}) {
  const account = findAccount(registry, selector, { provider });
  if (!account) {
    const known = (provider ? accountsFor(registry, provider) : registry.accounts)
      .map(entry => (entry.role ? `${entry.name} (${entry.role})` : entry.name))
      .join(', ');
    throw new MultiAccountError('ACCOUNT_UNKNOWN',
      `No account named "${selector}". Known accounts: ${known}.`,
      { selector });
  }
  return account;
}

/* The three exhaustion fields as ONE thing to hand on.
 *
 * They always travel together -- a probe that gets the single number and not
 * the two per-window ones judges the week by the hour's limit -- and there
 * are five places that pass them down. Spreading one call is the difference
 * between adding a field here and remembering five call sites. */
function exhaustionThresholds(source) {
  const from = source && typeof source === 'object' ? source : {};
  return {
    exhaustedAtPercent: from.exhaustedAtPercent,
    exhaustedAtPercentHourly: from.exhaustedAtPercentHourly === undefined ? null : from.exhaustedAtPercentHourly,
    exhaustedAtPercentWeekly: from.exhaustedAtPercentWeekly === undefined ? null : from.exhaustedAtPercentWeekly
  };
}

module.exports = Object.freeze({
  DEFAULT_EXHAUSTED_AT_PERCENT,
  GEMINI_STATE_DIR,
  PROVIDERS,
  PROVIDER_IDS,
  MultiAccountError,
  accountsFor,
  describeProviders,
  exhaustionThresholds,
  findAccount,
  loadRegistry,
  parseRegistry,
  profileProvisioned,
  providerSpec,
  requireAccount,
  resolveProfileDir,
  signInFilePath
});
