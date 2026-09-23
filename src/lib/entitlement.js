'use strict';

// THE ONE PLACE THAT SAYS WHAT AN UNLICENSED INSTALL DOES.
//
// ============================================================================
// THE ANSWER, STATED ONCE, IN CODE, WHERE IT CAN BE READ AND TESTED:
//
//     AN UNLICENSED INSTALL IS FULLY FUNCTIONAL, FOREVER, AND IS NOT A FAULT.
//
// Not degraded. Not a trial. Not nagged. Not time-bombed. The complete local
// runtime, the direct transport, a self-hosted relay, and every safety control
// run identically with no licence, no account, and no network. See
// `UNLICENSED_INSTALL` below -- that constant IS the policy, and every surface
// that needs to know reads it from here rather than restating it.
//
// A licence buys exactly one thing: use of infrastructure WE operate. Today
// that set has exactly one member, `hosted-relay`.
// ============================================================================
//
// WHY THIS FILE EXISTS, AND WHY IT IS SHAPED AS A CLOSED SET.
//
// Product policy must be executable rather than inferred from prose. Without a
// closed declaration, a later call site could silently turn an unrestricted
// installation into a different product. The constants and gates below are the
// current built-in policy and are the only authority this module uses.
//
// So the shape here is deliberately a CLOSED WORLD. `GATED_CAPABILITIES` is
// the complete, frozen list of things a licence may gate. `decide()` throws on
// any capability id that is not in it. You cannot add an entitlement gate
// anywhere in this repository without adding it HERE first, and
// `tests/entitlement.js` fails the build if any file outside the sanctioned
// set calls `verifyKey` on its own. That is the mechanical version of "one
// place rather than five".
//
// THE FREE TIER IS PROTECTED STRUCTURALLY, NOT BY CONVENTION.
//
// `resolveEntitlement()` on an install with no licence on file returns without
// ever loading `providers/license.js`: the require is lazy and lives inside the
// branch that has a key to verify. A community install therefore does not merely
// SKIP a licence check -- it never loads the code that would perform one. This
// mirrors the structural argument in `providers/hosted-relay-entitlement.js`,
// which this module feeds, and is asserted mechanically in `tests/entitlement.js`.
//
// ABSENCE IS NOT EMPTINESS. This codebase has repeatedly shipped the defect
// where "nothing is configured" renders as "something is broken"
// (`machine-profile.js` and `peer-enrollment.js` both carry the same warning).
// The dangerous version here would be a health surface reporting an unlicensed
// install as a red state. It is not one. `describeInstallation().ok` is TRUE
// for a community install, always, because having bought nothing is the
// intended, supported, majority state of this product.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { ROOT } = require('./runtime');

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// THE POLICY
// ---------------------------------------------------------------------------

/**
 * What an install with no valid licence does. This is the whole answer to
 * "what does an unlicensed install do", and it is a constant so that no
 * surface can disagree with it by paraphrasing it.
 *
 * 'full-function' -- run the entire product, unmodified, indefinitely.
 * The only other values this project would ever consider are 'degraded' and
 * 'refused'; both are outside the configured product policy and neither is
 * implemented, because implementing an unreachable branch is how policy drifts.
 */
const UNLICENSED_INSTALL = 'full-function';

/** Human-readable expansion of the constant above, for any surface that shows it. */
const UNLICENSED_INSTALL_STATEMENT =
  'This installation is fully functional without a licence, permanently. '
  + 'The local runtime, direct machine-to-machine transport, a relay you host '
  + 'yourself, and every safety control are free and are never licence-checked. '
  + 'A licence pays only for infrastructure we operate on your behalf.';

/**
 * THE NAME OF THE THING BEING SOLD, STATED ONCE.
 *
 * There is ONE paid product, and `TIERS` below are PLANS WITHIN IT -- not three
 * separate products a customer has to tell apart.
 *
 * This constant is the current catalog name. Plan labels derive from it so
 * checkout, receipt, settings, and refusal surfaces cannot drift independently.
 * Commercial history and account-specific rationale do not belong in the
 * publishable engine; current installation policy is represented only by the
 * data below.
 */
const PAID_PRODUCT = 'ToolsEnabled Anywhere';

/**
 * The current price list. Recorded as data so a settings or billing surface
 * reads it instead of hardcoding a second copy of the same numbers. Prices here
 * are descriptive; charging requires a separately configured payment provider.
 *
 * `label` is the PLAN name. `qualifiedLabel` is what a customer should be shown
 * when the product is not already obvious from context -- a checkout line, a
 * receipt, a refusal message. It is DERIVED from `PAID_PRODUCT` rather than
 * written out, so the product cannot be renamed in one place and left stale in
 * another; that is the exact failure this constant was added to end.
 *
 * `productId` is deliberately NOT touched by any of this. It is an internal
 * identifier that maps a signed licence back to a tier (see `PRODUCT_TIERS`),
 * it is already recorded as the Stripe product id in the launch documents, and
 * renaming it would invalidate every licence that names it. A display name and
 * a key are different things and only one of them is safe to change.
 */
const TIERS = Object.freeze({
  community: Object.freeze({
    id: 'community',
    label: 'Community',
    // Community is the free product, not an entry plan of the paid product, so
    // its customer-facing label qualifies to itself.
    qualifiedLabel: 'Community',
    monthlyUsd: 0,
    requiresLicense: false,
    productId: null,
    grants: Object.freeze([])
  }),
  operator: Object.freeze({
    id: 'operator',
    label: 'Operator Cloud',
    qualifiedLabel: `${PAID_PRODUCT} -- Operator Cloud`,
    monthlyUsd: 19,
    annualUsd: 190,
    requiresLicense: true,
    productId: 'toolsenabled.operator-cloud.v1',
    grants: Object.freeze(['hosted-relay'])
  }),
  team: Object.freeze({
    // This table declares only values the entitlement system enforces. Seat or
    // device limits belong in a separately enforced catalog contract and must
    // not be inferred from this plan record.
    id: 'team',
    label: 'Team',
    qualifiedLabel: `${PAID_PRODUCT} -- Team`,
    monthlyUsd: 299,
    requiresLicense: true,
    productId: 'toolsenabled.team.v1',
    grants: Object.freeze(['hosted-relay'])
  })
});

/**
 * PLANS WE HAVE NOT LAUNCHED, WHOSE IDENTITIES MUST SHIP ANYWAY.
 *
 * `resolveEntitlement()` refuses a licence whose `product` is not in
 * `PRODUCT_TIERS`; reserved identifiers let installed clients recognize a
 * future signed product without making it sellable.
 *
 *     verifyKey -> { valid: true, active: true,
 *                    product: 'toolsenabled.every-computer.v1' }
 *     resolveEntitlement -> tier=community licensed=false
 *                           reason=license-product-unknown
 *     decide('hosted-relay', that) -> allowed=false ENTITLEMENT_REQUIRED
 *
 * Product identifiers are stable protocol keys. A newly issued identifier that
 * an installed client does not recognize is refused, so possible future ids are
 * declared here without price or sales authority.
 *
 * WHAT THIS IS NOT. Reserving an identifier is NOT creating a plan. Nothing
 * here has a price, nothing here is on sale, and nothing here can be sold:
 * these tiers are deliberately absent from `TIERS`, and `TIERS` is what the
 * two checkout paths validate against (`entitlement-grant.js` for Paddle and
 * `entitlement-fulfilment.js` for Stripe both refuse a tier id that is not an
 * own property of `TIERS` carrying `requiresLicense`), and what the app tree's
 * subscription catalog is generated from. So a reserved plan cannot reach a
 * price page, a checkout, or a receipt by accident. It can only be launched
 * deliberately, by moving its entry into `TIERS` with a price -- at which point
 * every client already in the field ALREADY KNOWS THE ID and honours it.
 *
 * NO `reserved: true` FLAG, DELIBERATELY. Membership in this object IS the
 * signal, and it is the one the code actually reads. A boolean beside it would
 * be a second answer to a question already answered, free to drift from the
 * first -- which is precisely why `seatMinimum` was deleted from `team` above.
 */
const RESERVED_TIERS = Object.freeze({
  everyComputer: Object.freeze({
    id: 'everyComputer',
    label: 'Every Computer',
    qualifiedLabel: `${PAID_PRODUCT} -- Every Computer`,
    // Deliberately unpriced and therefore unavailable to checkout surfaces.
    monthlyUsd: null,
    requiresLicense: true,
    productId: 'toolsenabled.every-computer.v1',
    grants: Object.freeze(['hosted-relay', 'website-access'])
  }),
  privateServer: Object.freeze({
    id: 'privateServer',
    label: 'Private Server',
    qualifiedLabel: `${PAID_PRODUCT} -- Private Server`,
    monthlyUsd: null,
    requiresLicense: true,
    productId: 'toolsenabled.private-server.v1',
    grants: Object.freeze(['hosted-relay', 'website-access'])
  }),
  enterprise: Object.freeze({
    id: 'enterprise',
    label: 'Enterprise',
    qualifiedLabel: `${PAID_PRODUCT} -- Enterprise`,
    // Deliberately unpriced and therefore unavailable to checkout surfaces.
    monthlyUsd: null,
    requiresLicense: true,
    productId: 'toolsenabled.enterprise.v1',
    grants: Object.freeze(['hosted-relay', 'website-access'])
  })
});

/**
 * Every tier this build can RECOGNIZE, sellable or reserved.
 *
 * Kept separate from `TIERS` on purpose, and the separation is load-bearing
 * rather than tidy: `TIERS` answers "what may be SOLD", `ALL_TIERS` answers
 * "what may be RECOGNIZED". Those are different questions with different
 * blast radii -- selling is server-side and always current, recognizing is
 * client-side and frozen into installs we cannot update -- and collapsing them
 * into one table is what created the trap above.
 */
const ALL_TIERS = Object.freeze({ ...TIERS, ...RESERVED_TIERS });

/**
 * productId -> tier id. A licence names its product; this is how a tier is read
 * back off it. Built from `ALL_TIERS`, so a reserved plan's licence resolves to
 * its own tier rather than being refused -- THIS LINE IS THE FIX. Nothing else
 * in this module reaches for `RESERVED_TIERS` to decide what may be sold.
 */
const PRODUCT_TIERS = Object.freeze(Object.fromEntries(
  Object.values(ALL_TIERS).filter(tier => tier.productId).map(tier => [tier.productId, tier.id])
));

/**
 * THE COMPLETE SET OF THINGS A LICENCE MAY GATE.
 *
 * Closed on purpose. `decide()` throws for anything not listed, so a new gate
 * cannot appear in some provider file without being declared here first, in
 * front of this doctrine, next to the free alternatives it must always name.
 *
 * This set may be smaller than descriptive product copy. Where
 * each of the other four actually lands -- and why three of them must never
 * become entries in this object -- is in `SOLD_PROMISES` below. Read that before
 * adding anything here, because the most likely reason to be adding something
 * here is a promise that already has an answer there.
 */
const GATED_CAPABILITIES = Object.freeze({
  'hosted-relay': Object.freeze({
    id: 'hosted-relay',
    label: 'Relay hosted by us',
    // Why THIS is the gated thing, in one sentence a customer would accept:
    // it is a server we pay for, run, and keep online for them.
    rationale: 'A relay server we operate, pay for, and keep online so two of your '
      + 'machines can reach each other across any network with no setup.',
    requiredTiers: Object.freeze(['operator', 'team']),
    // Every gate must name at least one free way to get the same job done;
    // `tests/entitlement.js` enforces it.
    freeAlternatives: Object.freeze([
      'direct: both machines on one private network, no server, no account',
      'self-hosted-relay: run the same relay yourself on any host you control'
    ]),
    // Enforced by the hosted operator, not by the customer's own install: the
    // authoritative refusal happens at relay admission in
    // src/lib/providers/hosted-relay-entitlement.js, on the machine WE run.
    enforcedAt: 'src/lib/providers/hosted-relay-entitlement.js connect()',
    // This source checkout is the customer/self-hosted tree.  The admission
    // wrapper belongs only to the operator deployment and is deliberately
    // omitted here; config/payload-boundary.json is the ratified authority that
    // names that boundary.  Keep this structured rather than asking a test to
    // infer deployment scope from prose in `enforcedAt`.
    enforcement: Object.freeze({
      side: 'operator-only',
      boundary: 'config/payload-boundary.json'
    })
  }),
  // Website access is a paid-tier entitlement included with its tier.
  //
  // It belongs in this table for the same reason `hosted-relay` does and for no
  // other: it is a server we pay for, run, and keep online. It is emphatically
  // NOT a piece of the product being withheld -- the desktop product does
  // everything, unlicensed, offline, forever, and the free alternative below
  // says so in the words a customer would use.
  //
  // Inclusion with its tier is why `requiredTiers` matches hosted-relay's
  // exactly rather than being sold separately: someone who bought a plan has
  // already bought this. A separate price for it would be a different product
  // and is outside the current product policy.
  //
  // THE GAP ON THIS ONE RUNS THE OTHER WAY, AND IS NOT FIXED BY DELETING THE
  // GATE. The launch README sells six things and this is not among them: a
  // stranger reading the page cannot learn that an account area comes with
  // their plan. So the page sells LESS than the product gives, which is the
  // mirror image of every other row in `SOLD_PROMISES` below. The remedy is a
  // sentence on the page, decided by whoever owns that page; it is emphatically
  // NOT to withdraw this entry so the two lists agree at the smaller number.
  'website-access': Object.freeze({
    id: 'website-access',
    label: 'Your account area on our website',
    rationale: 'A website we operate, pay for, and keep online so you can reach your machines, '
      + 'your subscription and your account from any browser -- the same inclusion as reaching '
      + 'them from your phone.',
    requiredTiers: Object.freeze(['operator', 'team']),
    freeAlternatives: Object.freeze([
      'the product itself: everything the website shows you lives on your own machine and is '
        + 'free, offline, and never licence-checked',
      'self-hosted-relay: reach your own machines through a relay you run, with no account here at all'
    ]),
    // Enforced where the thing being paid for actually runs -- on our web
    // server, never on the customer's computer. A browser cannot be trusted to
    // report its own tier, so nothing client-side is consulted.
    enforcedAt: 'src/lib/providers/paid-surface-entitlement.js admit()',
    enforcement: Object.freeze({
      side: 'operator-only',
      boundary: 'config/payload-boundary.json',
      // The production caller is operator code too.  Its absence from this
      // checkout is intentional for the same boundary, rather than evidence
      // that a customer-side gate should be invented.
      caller: 'src/lib/entitlement-fulfilment.js createPaidSurfaceAdmission()'
    })
  })
});

/**
 * The explicit, non-exhaustive list of what a licence must NEVER gate. This is
 * documentation with teeth: it is what a reviewer reads when someone proposes a
 * new gate, and it is what a customer is shown when they ask what "free" means.
 */
const NEVER_GATED = Object.freeze([
  'the local runtime and every tool it dispatches',
  'direct machine-to-machine transport on your own network',
  'a relay you host yourself',
  'pairing a second computer (peer enrollment and key rotation)',
  'the audit ledger, the kill switch, approvals, and every other safety control',
  'reading, exporting, or deleting your own data'
]);

/**
 * Customer-facing service promises and the enforcement disposition of each.
 *
 * `GATED_CAPABILITIES` answers "what may a licence gate". This answers the
 * different question a customer's money asks: "the page sold me six things --
 * which of them can this system actually deliver as an entitlement, and what
 * happens to the rest?" These rows make that relationship explicit without
 * carrying account-specific commercial history into the engine.
 *
 * NOTHING HERE MAY BE USED TO EDIT A PROMISE DOWN. A row that reads "the code
 * cannot do this" is a statement about the CODE. The remedy is always to build
 * the enforcement or to escalate the mismatch -- never to strike the sentence
 * from the page so the two agree at the lower number. Selling less and calling
 * it a fix is the failure this record exists to make visible.
 *
 * `disposition` is one of:
 *
 *   'gated'          this promise IS a declared capability, enforced at that
 *                    capability's `enforcedAt`.
 *   'gated-as'       this promise is a customer-facing NAME for something
 *                    already declared. It needs no new id, and adding one would
 *                    put two gates on one refusal.
 *   'operational'    a service commitment, not an entitlement gate. There is no
 *                    moment where a subject asks and code could answer no.
 *                    THESE MUST NOT BECOME CAPABILITIES; see each row's `why`.
 *   'policy-review'  product copy and enforcement policy conflict. The conflict
 *                    stays fail-closed until current product policy resolves it.
 */
const SOLD_PROMISES = Object.freeze([
  Object.freeze({
    promise: 'managed non-LAN connectivity',
    disposition: 'gated-as',
    capability: 'hosted-relay',
    why: 'This is the customer-facing name for the hosted relay, not a second thing. '
      + '`anywhere-netbird.js` records the mapping in the implementation\'s own terms: '
      + '`self-hosted-relay` means NetBird servers the CUSTOMER runs and is free because AGPLv3 '
      + 'makes it free; `hosted-relay` means NetBird servers WE run and is "ALREADY gated, at '
      + 'src/lib/providers/hosted-relay-entitlement.js connect()". A paying customer therefore '
      + 'already receives this promise, and receives it from the gate above. '
      + 'THE REASON THERE IS NO SECOND ID. The only other candidate is '
      + '`anywhere-transport.js decideTransport()`, which documents itself as a PRE-FLIGHT: it can '
      + 'refuse early and name the free alternatives, and it can never admit anything, because the '
      + 'authoritative check runs server-side and a local check that could grant access would be a '
      + 'licence check on the honour system. Declaring a capability whose enforcement is a function '
      + 'incapable of admitting would be a gate in name only. `anywhere-netbird.js` already refused '
      + 'the duplicate for the same reason -- "a second gate is a second thing to keep in agreement, '
      + 'and the two would eventually disagree" -- and that judgement is not re-litigated here.'
  }),
  Object.freeze({
    promise: 'device enrollment',
    disposition: 'policy-review',
    capability: null,
    resolved: false,
    why: 'Current product copy names device enrollment while `NEVER_GATED` protects peer enrollment '
      + 'and key rotation. The engine therefore records an unresolved policy conflict and refuses to '
      + 'invent a new entitlement gate. Current product policy must reconcile the copy and doctrine '
      + 'before either side changes.'
  }),
  Object.freeze({
    promise: 'the relay',
    disposition: 'gated',
    capability: 'hosted-relay',
    why: 'Declared, enforced, and proven end to end: a signed payment mints a licence, the licence '
      + 'reaches the operator\'s resolver, and `providers/hosted-relay-entitlement.js connect()` '
      + 'admits a pair it previously refused. This is the one promise on the page that was already '
      + 'a working gate before this record existed.'
  }),
  Object.freeze({
    promise: 'monitoring',
    disposition: 'operational',
    capability: null,
    why: 'NOT A GATE, AND MUST NOT BECOME ONE. An entitlement gate answers "may this identified '
      + 'subject use this thing" at a moment where refusing is meaningful. Monitoring is something '
      + 'WE do, on our own infrastructure, without being asked -- there is no moment where a '
      + 'customer requests it and code could answer no, and nothing in this repository watches a '
      + 'customer\'s machines on our behalf, so there is no call site to attach to. Declaring it '
      + 'anyway would manufacture exactly the defect this module exists to prevent: a mechanism '
      + 'nothing invokes, described as though it were wired. IF IT IS EVER DELIVERED THROUGH A '
      + 'SURFACE WE OPERATE -- an alert feed, a status view -- then the SURFACE is the gate, and it '
      + 'is `website-access` or a declared sibling of it with its own real `enforcedAt`. It is never '
      + 'a capability called "monitoring".'
  }),
  Object.freeze({
    promise: 'recovery',
    disposition: 'operational',
    capability: null,
    why: 'NOT A GATE, AND THE OBVIOUS PLACE TO PUT ONE IS A TRAP. The client-side half of recovery '
      + 'already exists and is FREE: `anywhere-netbird.js createReconnectPolicy()` is the '
      + 'reconnection state machine that survives a closed laptop lid and a change of network, it '
      + 'runs on the customer\'s own machine, and it is never licence-checked. Gating it would take '
      + 'working function away from an unlicensed install, which `UNLICENSED_INSTALL` forbids '
      + 'outright. The half we are actually paid for is us restoring service on infrastructure we '
      + 'run, and that has no call site here for the same reason monitoring does not.'
  }),
  Object.freeze({
    promise: 'support',
    disposition: 'operational',
    capability: null,
    why: 'NOT A GATE. Support is people answering. There is no software moment to refuse, and a '
      + 'capability called "support" would be a licence check on a mailbox. A FUTURE LANE MUST NOT '
      + '"FIX" THIS BY INVENTING ONE. If a helpdesk is ever placed behind a login, the thing being '
      + 'gated is admission to that surface -- `website-access`, or a declared sibling with its own '
      + '`enforcedAt` -- and the promise stays exactly as sold. '
      + '`tests/entitlement-sold-surface.test.js` fails the build if "monitoring", "recovery" or '
      + '"support" is ever declared in GATED_CAPABILITIES.'
  })
]);

// ---------------------------------------------------------------------------
// Errors and the installed-licence record
// ---------------------------------------------------------------------------

class EntitlementError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'EntitlementError';
    this.code = code;
    this.details = details;
  }
}

// Per-installation and MUST NOT be committed: it holds one customer's licence
// key. Sibling of config/machines.profile.json and config/peers.profile.json,
// ignored by the same rule.
const PROFILE_RELATIVE_PATH = path.join('config', 'entitlement.profile.json');

function profilePath(root) {
  return path.join(root || ROOT, PROFILE_RELATIVE_PATH);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function atomicWrite(file, contents, io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    io.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    io.renameSync(temporary, file);
  } finally {
    try { io.unlinkSync(temporary); } catch { /* renamed away, or never created */ }
  }
}

/**
 * Read the licence this installation has activated, if any.
 *
 * Absence is NORMAL and is reported as such -- never as an error, never as a
 * broken state. A file that exists but cannot be read or parsed is reported as
 * `damaged` and still yields a working community answer, because a hand-edited
 * config file must not be able to stop the product.
 */
function readInstalledLicense(root, dependencies = {}) {
  const io = dependencies.fs || fs;
  const file = profilePath(root);
  let raw;
  try {
    raw = io.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return Object.freeze({ present: false, licenseKey: null, source: 'absent', path: file });
    }
    return Object.freeze({
      present: false, licenseKey: null, source: 'unreadable', path: file,
      reason: `an entitlement record exists but could not be read (${error && error.code})`
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return Object.freeze({
      present: false, licenseKey: null, source: 'malformed', path: file,
      reason: `the entitlement record is not valid JSON (${error && error.message})`
    });
  }
  const licenseKey = plainObject(parsed) && typeof parsed.licenseKey === 'string' && parsed.licenseKey.trim()
    ? parsed.licenseKey.trim() : null;
  if (!licenseKey) {
    return Object.freeze({
      present: false, licenseKey: null, source: 'malformed', path: file,
      reason: 'the entitlement record contains no licence key'
    });
  }
  return Object.freeze({
    present: true,
    licenseKey,
    source: 'profile',
    path: file,
    activatedAt: typeof parsed.activatedAt === 'string' ? parsed.activatedAt : null
  });
}

/**
 * Store a licence on this installation. Callers are expected to have verified
 * it first (`activate()` does); this function is the durable write only.
 */
function writeInstalledLicense(root, { licenseKey, activatedAt }, dependencies = {}) {
  if (typeof licenseKey !== 'string' || !licenseKey.trim()) {
    throw new EntitlementError('ENTITLEMENT_LICENSE_KEY_INVALID', 'A licence key is required.');
  }
  const file = profilePath(root);
  const body = {
    schemaVersion: SCHEMA_VERSION,
    licenseKey: licenseKey.trim(),
    activatedAt: activatedAt || new Date((dependencies.now || (() => Date.now()))()).toISOString()
  };
  atomicWrite(file, `${JSON.stringify(body, null, 2)}\n`, dependencies.fs || fs);
  return Object.freeze({ path: file, activatedAt: body.activatedAt });
}

/** Remove the licence from this installation. Idempotent; returns whether one was present. */
function clearInstalledLicense(root, dependencies = {}) {
  const io = dependencies.fs || fs;
  const file = profilePath(root);
  try {
    io.unlinkSync(file);
    return Object.freeze({ path: file, removed: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return Object.freeze({ path: file, removed: false });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Resolution -- the single call that answers "what is this install entitled to"
// ---------------------------------------------------------------------------

/**
 * THE BRAND. An entitlement state is only an entitlement state if THIS module
 * minted it.
 *
 * WHY. `decide()` reads `licensed`, `active` and `tier` structurally off the
 * object it is handed. Structurally means a three-field object literal --
 * `{ licensed: true, active: true, tier: 'operator' }` -- was indistinguishable
 * from a verified Ed25519 licence, and every refusal in this file would have
 * agreed with it. That is not a bug in `decide()`; it is a missing boundary. The
 * signature check lives in `resolveEntitlement()`, so anything that reaches
 * `decide()` without passing through `resolveEntitlement()` has skipped it.
 *
 * WHAT THIS IS NOT. It is not "currently exploited". Measured at the time this
 * was added, the only non-test caller passing an entitlement into `decide()` was
 * `src/lib/anywhere-transport.js:125`, which documents itself as a pre-flight
 * that cannot admit anything because the authoritative check runs server-side in
 * `providers/hosted-relay-entitlement.js connect()`. This closes the seam BEFORE
 * its first real caller arrives, which is the only time closing it is cheap.
 *
 * A WeakSet rather than a symbol property or an `instanceof` class: the state is
 * a frozen plain object that gets serialized into health blocks and audit
 * details, and a brand carried ON the object would survive `JSON.parse(
 * JSON.stringify(state))` -- which is exactly the round trip an attacker-shaped
 * caller performs. Membership held OUTSIDE the object cannot be copied, cloned,
 * spread, or re-hydrated. This is the shape already used for internal-state
 * brands in `providers/tasks.js`.
 */
const RESOLVED_ENTITLEMENTS = new WeakSet();

/** Freeze a state and mark it as this module's own. The only minting path. */
function sealEntitlement(state) {
  const frozen = Object.freeze(state);
  RESOLVED_ENTITLEMENTS.add(frozen);
  return frozen;
}

/**
 * A TEST-ONLY seam for constructing a state the resolver cannot be made to
 * produce on demand (an expired-but-team licence, say, without minting one).
 *
 * It is exported because a suite needs it and hiding it would only push tests
 * into monkey-patching, which is worse. It is safe to export because it is
 * POLICED, not merely discouraged: `tests/entitlement.js A6` is a static scan
 * that fails the build if any file under `src/` or `tools/` names it, or passes
 * an object literal as the entitlement argument to `decide()` or
 * `requireCapability()`. A production caller that reaches for this goes RED.
 */
function sealEntitlementForTest(state) {
  if (!plainObject(state)) {
    throw new EntitlementError('ENTITLEMENT_STATE_INVALID', 'An entitlement state must be an object.');
  }
  return sealEntitlement({ ...state });
}

function communityEntitlement(reason, extra = {}) {
  return sealEntitlement({
    tier: 'community',
    tierLabel: TIERS.community.label,
    licensed: false,
    active: false,
    reason,
    unlicensedInstall: UNLICENSED_INSTALL,
    licenseId: null,
    licensee: null,
    product: null,
    expiresAt: null,
    ...extra
  });
}

/**
 * Refuse paid capabilities without claiming that a licence was absent when the
 * record or verifier could not establish that. `null` is load-bearing here:
 * callers can distinguish "measured and unlicensed" from "not measured", while
 * the gate's existing `!state.licensed` branch remains fail-closed.
 */
function unmeasuredEntitlement(reason, extra = {}) {
  return communityEntitlement(reason, {
    licensed: null,
    active: null,
    ...extra
  });
}

/**
 * Resolve this installation's entitlement.
 *
 * NEVER THROWS. Every failure mode -- no licence, unreadable record, forged
 * key, expired key, revoked key, a licence naming a product we do not
 * recognize -- yields the community-tier refusal carrying a machine-readable
 * `reason`. Failures that prevent a read or verification carry `licensed` and
 * `active` as null rather than falsely reporting a measured negative. A health
 * check, a status surface, or a first-run screen must not be able to crash
 * because of a bad licence file, and an install must not be able to LOSE local
 * function because of one.
 *
 * The refusal side is `decide()` below; this function only reports.
 */
function resolveEntitlement({ root, licenseKey } = {}, dependencies = {}) {
  let key = licenseKey;
  if (key === undefined) {
    const installed = readInstalledLicense(root, dependencies);
    if (!installed.present) {
      // The lazy require below is never reached on this path: a community
      // install does not load providers/license.js at all.
      const unresolved = installed.source === 'unreadable';
      return (unresolved ? unmeasuredEntitlement : communityEntitlement)(
        installed.source === 'absent' ? 'no-license-on-file' : `license-record-${installed.source}`,
        installed.reason ? { detail: installed.reason } : {}
      );
    }
    key = installed.licenseKey;
  }
  if (typeof key !== 'string' || !key.trim()) return communityEntitlement('no-license-on-file');

  const verifyKey = dependencies.verifyKey || require('./providers/license').verifyKey;
  let verified;
  try {
    verified = verifyKey({ licenseKey: key.trim(), checkRevocation: true }, dependencies.licenseDependencies || {});
  } catch (error) {
    return unmeasuredEntitlement('license-unverifiable', { detail: String((error && error.message) || error) });
  }
  if (!plainObject(verified)) {
    return unmeasuredEntitlement('license-unverifiable', {
      detail: 'verification returned an unrecognized result'
    });
  }
  if (verified.valid !== true) {
    return communityEntitlement('license-unverifiable', {
      detail: verified.reason || 'verification rejected the licence key'
    });
  }
  const tier = PRODUCT_TIERS[verified.product] || null;
  if (!tier) {
    // A validly signed licence for a product this build does not know about is
    // refused, not guessed at. Guessing is how a $19 key becomes a Team key.
    return communityEntitlement('license-product-unknown', {
      detail: `this build does not recognize the licensed product "${verified.product}"`,
      licenseId: verified.licenseId
    });
  }
  return sealEntitlement({
    tier,
    // ALL_TIERS, not TIERS: a reserved plan's licence resolves to a tier that
    // is deliberately not for sale, and it still has a name to show its holder.
    tierLabel: ALL_TIERS[tier].label,
    licensed: true,
    active: verified.active === true,
    reason: verified.active === true ? null : (verified.reason || 'inactive'),
    unlicensedInstall: UNLICENSED_INSTALL,
    licenseId: verified.licenseId,
    licensee: verified.licensee,
    product: verified.product,
    issuedAt: verified.issuedAt,
    expiresAt: verified.expiresAt,
    keyId: verified.keyId
  });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * May this installation use `capabilityId`?
 *
 * Closed world: an unknown capability id THROWS rather than returning "allowed"
 * or "refused". Both defaults are wrong. Returning allowed lets a typo silently
 * unlock a paid surface; returning refused lets a typo silently break a free
 * one. Throwing makes the mistake impossible to ship.
 */
function decide(capabilityId, entitlement) {
  // OWN PROPERTY ONLY. A plain object literal inherits from Object.prototype,
  // so GATED_CAPABILITIES['__proto__'] -- and 'constructor', 'toString',
  // 'valueOf', 'hasOwnProperty' -- returns a truthy INHERITED member rather
  // than undefined. The closed-world guard below then never fires, and
  // execution falls through to capability.freeAlternatives.join(), throwing a
  // bare uncoded TypeError instead of the documented
  // ENTITLEMENT_CAPABILITY_UNKNOWN.
  //
  // It never granted anything -- it threw before reaching either verdict, on a
  // null entitlement and on a genuine team-tier one alike -- so this is a
  // contract defect, not an escalation. It matters because the documented way
  // to handle an unknown capability is `catch (e) { if (e.code ===
  // 'ENTITLEMENT_CAPABILITY_UNKNOWN') ... }`, and a caller written that way
  // sees an unhandled crash instead of a refusal it was told to expect.
  //
  // Found by a red-team lane probing capability-id confusion.
  const capability = Object.prototype.hasOwnProperty.call(GATED_CAPABILITIES, capabilityId)
    ? GATED_CAPABILITIES[capabilityId]
    : undefined;
  if (!capability) {
    throw new EntitlementError(
      'ENTITLEMENT_CAPABILITY_UNKNOWN',
      `"${capabilityId}" is not a declared entitlement-gated capability. `
      + `Declare it in GATED_CAPABILITIES in src/lib/entitlement.js, or -- far more likely -- `
      + `it is free and must not be gated at all (see NEVER_GATED).`,
      { capabilityId, declared: Object.keys(GATED_CAPABILITIES) }
    );
  }
  // AN ENTITLEMENT THIS MODULE DID NOT MINT IS NOT AN ENTITLEMENT.
  //
  // Absent (null/undefined) is a legitimate, meaningful input -- "I have not
  // resolved one, decide for a community install" -- and stays supported,
  // because refusing it would break `decide(id, null)` at the one place a
  // caller genuinely has nothing. ANYTHING ELSE must carry the brand.
  //
  // This throws rather than degrading to community on purpose, and for the same
  // reason the unknown-capability branch above throws: a hand-built object
  // reaching here is a CALLER DEFECT, and silently treating it as community
  // would hide the defect while quietly changing what that caller's users can
  // do. `WeakSet.prototype.has` returns false for primitives rather than
  // throwing, so a string, a number or a boolean lands here too.
  if (entitlement !== undefined && entitlement !== null && !RESOLVED_ENTITLEMENTS.has(entitlement)) {
    throw new EntitlementError(
      'ENTITLEMENT_STATE_UNBRANDED',
      'This entitlement state was not produced by resolveEntitlement(), so nothing has verified a '
      + 'licence for it. Resolve the installation\'s entitlement and pass THAT, rather than '
      + 'constructing a state by hand -- a hand-built state is an unsigned claim of having paid.',
      { capabilityId }
    );
  }
  const state = entitlement || communityEntitlement('no-entitlement-supplied');
  const remedy = `Free alternatives that need no licence: ${capability.freeAlternatives.join('; ')}.`;

  if (!state.licensed) {
    return Object.freeze({
      capability: capability.id, allowed: false,
      code: 'ENTITLEMENT_REQUIRED',
      // NAME THE PRODUCT, THEN THE PLAN. This is the one string in this module a
      // paying customer actually reads, and it used to say only "needs an
      // Operator Cloud licence" -- a name that appears nowhere on the website
      // they bought from, which sells "ToolsEnabled Anywhere". Someone who had
      // already paid could reasonably read that as being told to buy a second,
      // different thing. The entry plan is read off `requiredTiers` rather than
      // hardcoded to `operator`, so a capability that starts at a higher plan
      // cannot quietly keep advertising the cheapest one.
      reason: `${capability.label} needs a ${PAID_PRODUCT} licence `
        + `(${TIERS[capability.requiredTiers[0]].label} plan or higher). ${capability.rationale}`,
      remedy, entitlement: state
    });
  }
  if (!state.active) {
    return Object.freeze({
      capability: capability.id, allowed: false,
      code: state.reason === 'revoked' ? 'ENTITLEMENT_REVOKED'
        : state.reason === 'expired' ? 'ENTITLEMENT_EXPIRED' : 'ENTITLEMENT_INACTIVE',
      reason: `The licence on this installation is ${state.reason || 'not active'}.`,
      remedy, entitlement: state
    });
  }
  // A RESERVED PLAN IS ADMITTED BY ITS OWN `grants`, NOT BY `requiredTiers`.
  //
  // Reserving the productId is only half of defusing the launch trap. Without
  // this branch an old install would resolve a future `Every Computer` licence
  // to the right tier and then refuse the relay anyway with
  // ENTITLEMENT_TIER_INSUFFICIENT -- a customer who paid, correctly identified,
  // and still locked out. Both halves have to ship in v1 or neither is worth
  // shipping.
  //
  // WHY NOT JUST PUT THE RESERVED IDS IN `requiredTiers`. Because
  // `requiredTiers` is PUBLISHED: the app tree generates its subscription
  // catalog from these objects, so listing them there would print the names of
  // unlaunched plans -- `privateServer` above all, which must never appear on a
  // price page -- into a customer-facing JSON file.
  //
  // WHY THIS IS NOT A SECOND SOURCE OF TRUTH. It is scoped to reserved tiers
  // and to them alone: for `community`, `operator` and `team` the decision
  // below is byte-for-byte the one it always was, and `grants` cannot be
  // widened by a caller (every tier object and every `grants` array is frozen,
  // which `tests/redteam/tier-escalation.test.js` ATTACK 7 already proves).
  // `state.tier` is never caller-supplied -- it is read off a verified
  // signature through `PRODUCT_TIERS` -- so nothing an attacker controls
  // reaches this branch.
  const reservedTier = Object.prototype.hasOwnProperty.call(RESERVED_TIERS, state.tier)
    ? RESERVED_TIERS[state.tier]
    : null;
  const admitted = reservedTier
    ? reservedTier.grants.includes(capability.id)
    : capability.requiredTiers.includes(state.tier);
  if (!admitted) {
    return Object.freeze({
      capability: capability.id, allowed: false,
      code: 'ENTITLEMENT_TIER_INSUFFICIENT',
      // TIER IDS ARE KEYS, NOT NAMES, AND A CUSTOMER MUST NEVER BE SHOWN ONE.
      // This line used to render as "Relay hosted by us requires operator or
      // team; this licence is community." Those are the internal ids from the
      // table above -- lowercase, unpurchasable, and appearing nowhere the
      // customer could have bought from. Someone holding a real licence would
      // have been told they need "operator" with no way to discover that the
      // thing on sale is called ToolsEnabled Anywhere. Labels are looked up
      // through TIERS so the id never reaches a human, and the product is named
      // for the same reason it is named in ENTITLEMENT_REQUIRED above.
      reason: `${capability.label} needs a ${PAID_PRODUCT} licence on the `
        // The plans OFFERED are read from `requiredTiers`, which names only
        // sellable tiers -- so this never tells a customer to buy something
        // that is not on sale. The plan they are ON is read from `ALL_TIERS`,
        // so a reserved-plan holder is told their plan's name instead of being
        // shown the raw internal id the old `? :` fallback would have printed.
        + `${capability.requiredTiers.map(id => TIERS[id].label).join(' or ')} plan; `
        + `this installation is on ${ALL_TIERS[state.tier] ? ALL_TIERS[state.tier].label : state.tier}.`,
      remedy, entitlement: state
    });
  }
  return Object.freeze({
    capability: capability.id, allowed: true, code: null, reason: null, remedy: null, entitlement: state
  });
}

/**
 * `decide()`, but throwing. Use at a call site that must not proceed unentitled.
 *
 * A supplied `entitlement` is preferred over resolving one -- that is the whole
 * point of the option, and it is what lets a surface resolve once and gate
 * several capabilities off the same answer. It is SAFE to prefer it only
 * because `decide()` below refuses any state this module did not mint; without
 * that brand check this option was "trust the caller's word for having paid".
 *
 * IT HAS NO PRODUCTION CALLER, AND THAT IS CORRECT. DO NOT "FIX" IT.
 *
 * docs/PLANNING-BRIEF.md lists "requireCapability() had zero callers" under its
 * traps, beside "Before trusting any gate, find its caller." That warning is
 * right and the obvious response to it is wrong. The enforced topology is:
 *
 *   hosted-relay   enforced in providers/hosted-relay-entitlement.js connect(),
 *                  which resolves the licence SERVER-SIDE by pairId from the
 *                  operator's ledger and never reads the customer's machine.
 *   website-access enforced in providers/paid-surface-entitlement.js admit(),
 *                  behind a deployment marker proving operator-only intent, and
 *                  called from entitlement-fulfilment.js.
 *   client side    anywhere-transport.js deliberately uses the NON-throwing
 *                  decide(), because a pre-flight has to present a refusal with
 *                  free alternatives rather than crash the caller.
 *
 * So every real gate is operator-side, and the one client-side consumer needs
 * the other shape. This function reads the LOCAL install's entitlement; a
 * shipped call site would gate a paid capability on a value the customer's own
 * machine supplies -- exactly the forgeable check the server-side design was
 * built to avoid. Wiring it would open a hole while appearing to close one.
 *
 * It stays because it is tested public API: redteam/tier-escalation.test.js
 * ATTACK 8 proves it refuses the same brand-bypass attempts decide() does, and
 * deleting it would delete that coverage. tests/entitlement-enforcement-points.test.js
 * fails if a production caller ever appears, and says all of this again there.
 */
function requireCapability(capabilityId, { root, entitlement } = {}, dependencies = {}) {
  const state = entitlement || resolveEntitlement({ root }, dependencies);
  const verdict = decide(capabilityId, state);
  if (!verdict.allowed) {
    const error = new EntitlementError(verdict.code, `${verdict.reason} ${verdict.remedy}`, { verdict });
    error.verdict = verdict;
    throw error;
  }
  return verdict;
}

/* Write the activation outcome to the tamper-evident ledger.
 *
 * Activation is a customer-facing decision point and must be represented in
 * the audit record. This helper records that outcome without becoming part of
 * the entitlement gate itself.
 *
 * THE KEY NEVER GOES IN. A `te1.` licence key is a BEARER credential -- whoever
 * holds it can present it. Writing one into an append-only, tamper-evident,
 * deliberately-preserved chain would put a live credential somewhere it can
 * never be removed from. Tier, expiry and licence id answer every question the
 * record needs to answer; the key answers none of them.
 *
 * FAIL-OPEN, DELIBERATELY. A customer who has paid must not be denied the
 * capability they bought because this machine's local ledger is unwritable. The
 * entitlement that actually gates the paid surface is checked SERVER-SIDE by
 * pairId (providers/hosted-relay-entitlement.js) and never reads anything from
 * the customer's disk, so this row is a RECORD, not the gate -- and a record
 * that can refuse service is a worse failure than a record with a hole in it.
 *
 * A FAILED WRITE WARNS; IT DOES NOT THROW, AND THAT IS A CORRECTION. The first
 * version of this re-threw on the next tick, reasoning that a silent hole in
 * the ledger is worse than a loud crash. That was wrong on its own terms: in
 * the Electron main process an unhandled throw takes the APP down a tick after
 * a successful activation -- denying the paying customer the thing this
 * function just decided not to deny them, and losing their session with it.
 * "Do not refuse service over a record" cannot be the reason for a design that
 * refuses service more violently.
 *
 * So it emits a named process warning instead: loud, greppable, in the log, and
 * survivable. The audit stack already accounts for its own failed writes in
 * durability state (audit.status reports breach counts), so this is the second
 * of two places the failure is visible, not the only one. */
const AUDIT_WARNING_NAME = 'EntitlementAuditWriteFailed';

function recordActivation(dependencies, action, target, details) {
  let emit;
  try {
    // Required lazily so a caller that never activates anything pays for the
    // audit stack. INSIDE the try because a failing require is exactly the
    // condition this function exists to survive -- the first version left it
    // outside, so a broken audit module threw AFTER the licence was already on
    // disk, turning a missing record into a failed activation for a customer
    // who had paid.
    emit = dependencies.record || require('./audit').record;
  } catch (error) {
    process.emitWarning(
      `${action} could not be recorded: the audit module failed to load `
      + `(${String(error && error.code || 'LOAD_FAILED')}). The entitlement itself is unaffected.`,
      AUDIT_WARNING_NAME);
    return;
  }

  // audit.record() DOES NOT THROW ON A FAILED WRITE -- it returns a status
  // object and the caller is expected to read it. The first version of this
  // wrapped the call in try/catch and discarded the return value, so the catch
  // was unreachable and the warning could never fire on the failure it was
  // written for. An adversarial review caught it; the test had injected a
  // throwing stub, which is a shape production never produces. That is the
  // canonical way a fail-open path rots: the handler is present, tested, and
  // wired to a condition that does not occur.
  let status;
  try {
    status = emit(action, target, details);
  } catch (error) {
    // Still handled, because an injected recorder or a future implementation
    // may throw. Both paths now lead to the same warning.
    process.emitWarning(
      `${action} could not be written to the audit ledger: ${String(error && error.message || error)}. `
      + 'The entitlement itself is unaffected; the record of it is incomplete.',
      AUDIT_WARNING_NAME);
    return;
  }

  // `ok: false` is the real failure signal. `disabled` is not a failure -- an
  // installation with auditing switched off is a choice, not a fault, and
  // warning about it on every activation would train the reader to ignore this
  // warning entirely.
  if (status && typeof status === 'object' && status.ok === false && status.disabled !== true) {
    const cause = Array.isArray(status.errors) && status.errors.length
      ? String(status.errors[0]?.code || status.errors[0]?.message || 'unknown').slice(0, 120)
      : 'no cause reported';
    process.emitWarning(
      `${action} was not durably recorded (${cause}). `
      + 'The entitlement itself is unaffected; the record of it is incomplete.',
      AUDIT_WARNING_NAME);
  }
}

/**
 * Verify a licence key and, only if it is genuinely usable, store it on this
 * installation. This is the moment an install becomes entitled, and it is the
 * one customer-facing decision point where a bad key is refused out loud.
 */
function activate({ root, licenseKey }, dependencies = {}) {
  const entitlement = resolveEntitlement({ root, licenseKey }, dependencies);
  if (!entitlement.licensed) {
    // A REFUSAL IS RECORDED TOO. Repeated rejected activations are the visible
    // half of someone trying keys, and a ledger that only holds successes
    // cannot show that at all.
    recordActivation(dependencies, 'entitlement.activation_refused', 'unlicensed', {
      code: 'ENTITLEMENT_ACTIVATION_REFUSED', reason: entitlement.reason, stored: false
    });
    throw new EntitlementError(
      'ENTITLEMENT_ACTIVATION_REFUSED',
      `That licence key was not accepted (${entitlement.reason}). Nothing was stored, `
      + 'and this installation keeps working exactly as it did.',
      { entitlement }
    );
  }
  if (!entitlement.active) {
    const code = entitlement.reason === 'revoked' ? 'ENTITLEMENT_REVOKED' : 'ENTITLEMENT_EXPIRED';
    recordActivation(dependencies, 'entitlement.activation_refused', entitlement.licenseId || 'unknown-licence', {
      code, reason: entitlement.reason, tier: entitlement.tier || null, stored: false
    });
    throw new EntitlementError(
      code,
      `That licence is ${entitlement.reason}, so it was not stored. `
      + 'This installation keeps working exactly as it did.',
      { entitlement }
    );
  }
  const written = writeInstalledLicense(root, { licenseKey }, dependencies);
  // Recorded AFTER the write, so the row means "this installation is entitled"
  // rather than "was about to be". An activation that failed to store must not
  // leave a success row behind it.
  recordActivation(dependencies, 'entitlement.activated', entitlement.licenseId || 'unknown-licence', {
    tier: entitlement.tier || null,
    expiresAt: entitlement.expiresAt || null,
    capabilities: Array.isArray(entitlement.capabilities) ? entitlement.capabilities : null,
    stored: true
  });
  return Object.freeze({ ...written, entitlement });
}

/**
 * The single block every status/health/first-run surface renders.
 *
 * `ok` is TRUE for a community install. An install that has bought nothing is
 * not unhealthy, and a health surface that paints it red is the
 * absence-as-emptiness defect wearing a billing hat.
 */
function describeInstallation({ root } = {}, dependencies = {}) {
  const entitlement = resolveEntitlement({ root }, dependencies);
  const capabilities = Object.keys(GATED_CAPABILITIES).map(id => {
    const verdict = decide(id, entitlement);
    return {
      capability: id,
      label: GATED_CAPABILITIES[id].label,
      allowed: verdict.allowed,
      code: verdict.code,
      reason: verdict.reason,
      remedy: verdict.remedy
    };
  });
  return Object.freeze({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    tier: entitlement.tier,
    tierLabel: entitlement.tierLabel,
    licensed: entitlement.licensed,
    active: entitlement.active,
    reason: entitlement.reason,
    licenseId: entitlement.licenseId,
    expiresAt: entitlement.expiresAt,
    unlicensedInstall: UNLICENSED_INSTALL,
    unlicensedInstallStatement: UNLICENSED_INSTALL_STATEMENT,
    licenseChecked: entitlement.licensed !== null
      && (entitlement.licensed || entitlement.reason !== 'no-license-on-file'),
    gatedCapabilities: Object.freeze(capabilities.map(Object.freeze)),
    neverGated: NEVER_GATED
  });
}

module.exports = Object.freeze({
  ALL_TIERS,
  EntitlementError,
  GATED_CAPABILITIES,
  NEVER_GATED,
  PAID_PRODUCT,
  PRODUCT_TIERS,
  PROFILE_RELATIVE_PATH,
  RESERVED_TIERS,
  SCHEMA_VERSION,
  SOLD_PROMISES,
  TIERS,
  UNLICENSED_INSTALL,
  UNLICENSED_INSTALL_STATEMENT,
  activate,
  clearInstalledLicense,
  decide,
  describeInstallation,
  profilePath,
  readInstalledLicense,
  requireCapability,
  resolveEntitlement,
  sealEntitlementForTest,
  writeInstalledLicense
});
