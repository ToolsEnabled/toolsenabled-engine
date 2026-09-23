'use strict';

// --- WHAT WILL ACTUALLY HAPPEN ON *THIS* COMPUTER (owner, R1536 tier 1) ------
//
// The owner: "if we can grab their settings then just tell them and let them
// choose to change their settings right there or if we cant grab them then
// direct them how to".
//
// So this module reads the Windows settings that decide whether an operation
// needing administrator rights will run silently, ask, or be refused outright,
// and turns them into one sentence about THEIR machine. A surface that can call
// this must not fall back to a generic "this usually needs a step" -- telling
// somebody what will happen on their computer beats telling them what usually
// happens on computers.
//
// IT READS AND NEVER WRITES, AND THAT IS A PROPERTY OF THE FILE RATHER THAN OF
// ITS CALLERS. There is no code path here that opens anything for write, and
// the only executables it will run are reg.exe and whoami.exe with query-only
// arguments. R1529's hard boundary is that this product never changes a
// machine's security posture; a module whose whole job is to look at that
// posture is exactly where that boundary would be crossed first, so it is
// stated and enforced here.
//
// READING THIS COSTS NO ELEVATION. HKLM\SOFTWARE\Microsoft\Windows\
// CurrentVersion\Policies\System is readable by Users on a default install;
// only writing it needs an administrator. That is why tier 1 is normally
// reachable and tier 2 is the exception rather than the rule.
//
// WHY THIS EXISTS AT ALL: R1529 concluded "no ToolsEnabled app setting requires
// UAC elevation" after seeing no prompt on the owner's machine. Measured on
// that machine 2026-08-12: EnableLUA=1 but ConsentPromptBehaviorAdmin=0, which
// is "elevate without prompting" -- every elevation request from an
// administrator's token is granted with no dialog at all. The absence of a
// prompt there was a property of that machine, not of the product. An honest
// answer therefore has to come from reading the settings, never from watching
// whether a box appeared.

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { safeLaunchEnvironment } = require('./providers/subscription-launch-env.js');

const POLICY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';

// The values that decide the answer. Each carries the Windows default so a
// reader can see how far a machine has been moved from stock, which is the
// thing the R1529 false negative turned on.
const POLICY_VALUES = Object.freeze({
  enableLua: Object.freeze({ name: 'EnableLUA', windowsDefault: 1 }),
  consentPromptBehaviorAdmin: Object.freeze({ name: 'ConsentPromptBehaviorAdmin', windowsDefault: 5 }),
  consentPromptBehaviorUser: Object.freeze({ name: 'ConsentPromptBehaviorUser', windowsDefault: 3 }),
  promptOnSecureDesktop: Object.freeze({ name: 'PromptOnSecureDesktop', windowsDefault: 1 }),
  filterAdministratorToken: Object.freeze({ name: 'FilterAdministratorToken', windowsDefault: 0 }),
});

const ADMINISTRATORS_SID = 'S-1-5-32-544';

// What an operation needs from Windows. These are genuinely different questions
// and they get different answers on the same machine, which is why a single
// "does this need admin" boolean was never going to be honest:
//
//   'elevation-request'  the operation asks Windows for administrator rights
//                        (a RunAs launch, an installer, an elevated console).
//                        What happens is decided by the consent-prompt policy.
//   'protected-write'    the operation simply writes something protected with
//                        the token it already has and never asks. What happens
//                        is decided by whether that token is already elevated.
const NEEDS = Object.freeze(['elevation-request', 'protected-write']);

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/* Parse one `reg query` line. Returns null for anything unrecognized rather
   than guessing -- an unreadable value has to stay unreadable. */
function parseRegQuery(output, valueName) {
  if (typeof output !== 'string') return null;
  const pattern = new RegExp(`^\\s*${valueName}\\s+REG_DWORD\\s+(0x[0-9a-fA-F]+)\\s*$`, 'm');
  const match = pattern.exec(output);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 16);
  return Number.isFinite(parsed) ? parsed : null;
}

function systemExecutable(name) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', name);
}

/* THE ENVIRONMENT THESE TWO CHILDREN GET, and why it is not process.env.
   Omitting `env` makes node fall back to the FULL parent environment, so
   reg.exe and whoami.exe were being handed every API key, token, and
   subscription credential this process holds -- for two reads that need none of
   them. tools/check-spawn-env-scrub.js flagged both call sites, which is what
   it exists for; the remedy it names is this function and NOT a hand-rolled
   delete list, because Windows environment names are case-insensitive while a
   plain JavaScript object is not, so `delete env.ANTHROPIC_API_KEY` leaves
   `anthropic_api_key` sitting there for the child.

   Computed once at module load rather than per call: these are query-only
   system binaries invoked on a status path, and the scrub also asserts that no
   billing credential survived it -- work worth doing once rather than on every
   posture read. SystemRoot and the rest of the machine environment survive the
   scrub, which is what reg.exe and whoami.exe actually need. */
const SYSTEM_QUERY_ENVIRONMENT = safeLaunchEnvironment(process.env, { context: 'uac-posture system query' });

function defaultReadRegistryValue(valueName) {
  const output = execFileSync(systemExecutable('reg.exe'), ['query', POLICY_KEY, '/v', valueName], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
    env: SYSTEM_QUERY_ENVIRONMENT,
  });
  return parseRegQuery(output, valueName);
}

/* `whoami /groups` answers both halves of the account question in one read: it
   lists the Administrators group when the account is an administrator, and
   marks it "Group used for deny only" when UAC has filtered it out of the
   running token. A filtered token is the ordinary state for an administrator on
   a machine with UAC on, and it is exactly the state in which a protected write
   fails while an elevation request succeeds. */
function defaultReadTokenGroups() {
  return execFileSync(systemExecutable('whoami.exe'), ['/groups', '/fo', 'csv'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
    env: SYSTEM_QUERY_ENVIRONMENT,
  });
}

function parseTokenGroups(output) {
  if (typeof output !== 'string' || output.trim() === '') return { administrator: null, tokenFiltered: null };
  const rows = output.split(/\r?\n/);
  // A successful process is not necessarily a successful measurement: reject
  // truncated, diagnostic, or otherwise unparseable stdout instead of treating
  // the absence of the Administrators SID in it as proof of a standard account.
  const sidField = /(?:^|,)\s*"S-\d+(?:-\d+)+"\s*(?:,|$)/i;
  if (!rows.some((row) => sidField.test(row))) {
    return { administrator: null, tokenFiltered: null };
  }
  const administratorsField = new RegExp(`(?:^|,)\\s*"${ADMINISTRATORS_SID}"\\s*(?:,|$)`, 'i');
  const line = rows.find((row) => administratorsField.test(row));
  if (!line) return { administrator: false, tokenFiltered: false };
  // Present but deny-only means: an administrator account whose running token
  // has had the group stripped. Only the two states we understand are answers;
  // localized or unfamiliar attributes must not silently mean "elevated".
  if (/deny only/i.test(line)) return { administrator: true, tokenFiltered: true };
  if (/enabled/i.test(line)) return { administrator: true, tokenFiltered: false };
  return { administrator: true, tokenFiltered: null };
}

/**
 * Read this machine's UAC posture. Never writes anything.
 *
 * Every reader is injectable so the decision logic is testable without a
 * registry, and so a test can assert the UNREADABLE path -- which is the path
 * that decides whether a person gets tier 1 or tier 2, and therefore the one
 * most worth exercising.
 */
function readPosture({
  readRegistryValue = defaultReadRegistryValue,
  readTokenGroups = defaultReadTokenGroups,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') {
    return Object.freeze({
      platform, readable: false, windows: false,
      values: Object.freeze({}), unreadable: Object.freeze([]),
      account: Object.freeze({ administrator: null, tokenFiltered: null }),
      uacEnabled: null,
      note: 'These settings are a Windows idea. This computer is not running Windows, so there is nothing here to read.',
    });
  }

  const values = {};
  const unreadable = [];
  for (const [key, spec] of Object.entries(POLICY_VALUES)) {
    let read = null;
    try { read = numeric(readRegistryValue(spec.name)); } catch { read = null; }
    // ABSENT IS NOT UNREADABLE, AND NEITHER IS GUESSED. FilterAdministratorToken
    // is genuinely absent on most machines and Windows then behaves as 0. A
    // value we could not read at all is a different fact and is listed as one,
    // because a surface must be able to say "we could not check" rather than
    // quietly assuming the stock value and being wrong in the direction that
    // makes the product look better.
    if (read === null) { unreadable.push(spec.name); values[key] = null; }
    else values[key] = read;
  }

  let account = { administrator: null, tokenFiltered: null };
  try { account = parseTokenGroups(readTokenGroups()); } catch { account = { administrator: null, tokenFiltered: null }; }

  const enableLua = values.enableLua;
  return Object.freeze({
    platform, windows: true,
    // READABLE MEANS "ENOUGH TO ANSWER", not "everything was read". The two
    // facts that decide every case are whether UAC is on and whether this
    // account is an administrator; the rest refine the sentence.
    readable: enableLua !== null && account.administrator !== null,
    values: Object.freeze(values),
    unreadable: Object.freeze(unreadable),
    account: Object.freeze(account),
    uacEnabled: enableLua === null ? null : enableLua !== 0,
    policyKey: POLICY_KEY,
    note: '',
  });
}

/* THE SENTENCE, FOR ONE OPERATION, ON THIS MACHINE.
 *
 * `outcome` is a closed vocabulary so a surface can style it without parsing
 * prose, and so this file cannot start emitting a fourth kind of answer nobody
 * designed a screen for:
 *
 *   'silent'      it will run, and Windows will not ask. The most dangerous
 *                 answer to leave unsaid, and the one the owner's machine gives.
 *   'consent'     Windows will show an approve/deny box.
 *   'credentials' Windows will ask for an administrator's name and password.
 *   'refused'     it cannot run, and Windows will not offer a way to allow it.
 *   'allowed'     no administrator rights are involved at all here.
 *   'unknown'     we could not read enough to say. Said out loud, never guessed.
 */
function describeForOperation(posture, need) {
  if (!NEEDS.includes(need)) throw new TypeError(`unknown operation need: ${need}`);
  if (!posture || posture.windows !== true) {
    return frozenAnswer('unknown', 2, 'This copy could not check what your computer would do, so it will not tell you either way.');
  }
  if (!posture.readable) {
    return frozenAnswer('unknown', 2,
      'This copy could not read your computer\u2019s administrator-prompt settings, so it will not guess what will happen. The steps below are what it would take if Windows does ask you.');
  }

  const { administrator, tokenFiltered } = posture.account;
  const uacOff = posture.uacEnabled === false;

  if (need === 'protected-write') {
    // Nothing here asks Windows for anything. The only question is whether the
    // token this program is already running with is an administrator token.
    if (uacOff && administrator) {
      return frozenAnswer('allowed', 1,
        'On your computer this will just work: UAC is switched off and you are an administrator, so this program is already running with full rights. That is also why nothing on this computer will ever ask you before making a change like this one.');
    }
    if (administrator === true && tokenFiltered === null) {
      return frozenAnswer('unknown', 2,
        'You are an administrator, but this copy could not establish whether this program is already running with those rights, so it will not guess whether Windows will allow this write.');
    }
    if (tokenFiltered === false && administrator === true) {
      return frozenAnswer('allowed', 1, 'On your computer this will just work, because this program is already running with administrator rights.');
    }
    return frozenAnswer('refused', 1,
      administrator
        ? 'On your computer Windows will refuse this, and it will not ask you first. You are an administrator, but programs do not run with those rights until something is started as an administrator, and this program never does that to itself. The steps below are how you would do this part yourself.'
        : 'On your computer Windows will refuse this, and it will not ask you first, because your account is not an administrator. The steps below need somebody who is.');
  }

  // need === 'elevation-request'
  if (uacOff) {
    return administrator
      ? frozenAnswer('silent', 1,
        'On your computer this will run without asking you anything, because UAC is switched off. Nothing will appear on screen and nothing will wait for you. If you would rather be asked, turning UAC back on is the change that does it.')
      : frozenAnswer('refused', 1,
        'On your computer this cannot run at all. UAC is switched off, and with it off Windows gives an account that is not an administrator no way to allow something like this \u2014 there is no prompt to approve. Somebody with an administrator account would have to do this part.');
  }

  if (administrator === false) {
    const user = posture.values.consentPromptBehaviorUser;
    if (user === 0) {
      return frozenAnswer('refused', 1,
        'On your computer this cannot run. Your account is not an administrator, and this computer is set to refuse these requests outright rather than offer you a prompt. Somebody with an administrator account would have to do this part.');
    }
    if (user === null) {
      return frozenAnswer('unknown', 2,
        'Your account is not an administrator. This copy could not read whether Windows will offer you a password box or refuse outright, so it will not guess.');
    }
    return frozenAnswer('credentials', 1,
      'On your computer Windows will ask for an administrator\u2019s username and password before this can run. If you do not have those, this part cannot be done from your account, and nothing else stops working.');
  }

  const admin = posture.values.consentPromptBehaviorAdmin;
  if (admin === null) {
    return frozenAnswer('unknown', 2,
      'You are an administrator, but this copy could not read whether Windows will ask you before allowing this. It will not guess which.');
  }
  if (admin === 0) {
    // The measured state of the owner's own machine, and the reason a whole
    // lane concluded this product needed no administrator rights at all.
    return frozenAnswer('silent', 1,
      'On your computer this will run without asking you anything. Windows is set to give administrator rights to programs that ask for them without showing you a prompt first. That is not the Windows default \u2014 normally you would see an approval box \u2014 and it means changes like this one happen on this computer without you seeing them.');
  }
  if (admin === 1 || admin === 2) {
    return frozenAnswer('credentials', 1,
      'On your computer Windows will ask you to type your password before allowing this. You can say no, and nothing else stops working.');
  }
  return frozenAnswer('consent', 1,
    'On your computer Windows will show you an approval box before this can run. You can say no, and nothing else stops working.');
}

function frozenAnswer(outcome, tier, sentence) {
  return Object.freeze({ outcome, tier, sentence });
}

// --- HOW OFTEN THIS ASKS YOU FOR SOMETHING (owner, R1536 tier 3) -------------
//
// "It should be labeled as typically requires a user step, rarely, sometimes
// etc so they know".
//
// The label is a claim about MACHINES IN GENERAL at their default settings, and
// it is derived from how commonly the condition that triggers the step is true
// on a stock Windows install -- never from how often it happened here. The
// machine this was written on grants elevation silently, so "it never asked me"
// is evidence about one registry value and about nothing else.
const FREQUENCIES = Object.freeze(['typically', 'sometimes', 'rarely', 'never']);

const FREQUENCY_WORDING = Object.freeze({
  typically: 'Typically needs a step from you.',
  sometimes: 'Sometimes needs a step from you.',
  rarely: 'Rarely needs a step from you.',
  never: 'Does not need a step from you.',
});

/**
 * The label a surface shows, with a tier-1 reading allowed to overrule it.
 *
 * The general label is a good answer and the specific one is a better answer:
 * where we can read the machine, "on your computer this will ask you to approve
 * it" replaces "sometimes needs a step from you", because a person deciding
 * what to do next is asking about their computer and not about computers.
 */
function frequencyLabel(declared, answer) {
  const general = FREQUENCIES.includes(declared) ? declared : null;
  const wording = general ? FREQUENCY_WORDING[general] : '';
  if (!answer || answer.tier !== 1) {
    return Object.freeze({
      tier: 2, source: 'general', label: wording,
      detail: answer ? answer.sentence : '',
      declared: general,
    });
  }
  const specific = {
    silent: 'On your computer: runs without asking you.',
    consent: 'On your computer: asks you to approve it.',
    credentials: 'On your computer: asks for a password.',
    refused: 'On your computer: cannot run without the step below.',
    allowed: 'On your computer: nothing is needed from you.',
    unknown: wording,
  }[answer.outcome] || wording;
  return Object.freeze({
    tier: 1, source: 'measured', label: specific,
    detail: answer.sentence,
    declared: general,
  });
}

module.exports = Object.freeze({
  POLICY_KEY, POLICY_VALUES, NEEDS, FREQUENCIES, FREQUENCY_WORDING,
  readPosture, describeForOperation, frequencyLabel,
  parseRegQuery, parseTokenGroups,
});
