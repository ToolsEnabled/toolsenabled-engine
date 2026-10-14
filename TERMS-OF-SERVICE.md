# ToolsEnabled Terms of Service

**Status: DRAFT. Prepared for owner review and legal counsel before
publication. Not yet in effect. Do not publish or link this document, and do
not represent to any customer that it governs their use of the product, until
the owner has approved it and a lawyer has reviewed it** (see
`docs/design/LAUNCH-APPROVALS.md`). Sections below marked **[LAWYER]** contain
standard-shape legal language that has not been drafted or reviewed by a
licensed attorney and must not be treated as enforceable until it has been.

Last updated: 2026-08-13

**Correction note, 2026-08-14 (legal lane).** Four changes, each marked where
it appears: (a) §2's Paddle bullet was **false** — live mode is a
configuration file now, not a source-code pin — and is corrected; (b) §3
"free and supported" → **"free and documented"** (owner decision — no support
policy exists to back the old word); (c) §0 records the decided entity
(ToolsEnabled, Inc., Delaware C-corp — decided, not yet filed); (d) §11 now
names the two structural problems counsel must solve, not just a state.
`REFUND-POLICY.md` was corrected the same day: Paddle is the decided merchant
of record, the same sandbox-pin falsehood is fixed, and all five owner
decisions are ruled (tokens stand pending counsel review).

**Correction note, 2026-08-13.** Two changes, both marked where they appear.
(a) §1's price table published a **"3-seat minimum"** on the Team plan;
`src/lib/entitlement.js` records that minimum as **deleted**, and the deletion
as the decision. Removed, with the reason kept beside the table. (b) §5.1 now
names the specific blocker in `REFUND-POLICY.md` — **there is no refund
window** — rather than referring to "owner decisions still open" in a document
the reader has not opened yet. §3's licence position is **unchanged**: it said
MIT before this pass and it was right. `REFUND-POLICY.md` Appendix B was the
document that disagreed, asserting `AGPL-3.0-or-later`, and it has been
corrected to match §3 rather than §3 being moved toward it.

**Re-verification note, 2026-08-12.** Re-checked against the code. Three
things had gone stale and are corrected below, each marked: the **paid
product's name and what it contains** (§1), the claim that **no licence is
technically enforced** (§2 and §5 — that is no longer true, and where it is
now enforced matters), and the absence of any statement about **what the
product stores on your computer** (new §1.2). A **refund and cancellation
policy** now exists as a separate document and is referenced from new §5.1;
before today there was none, which meant a subscription could not honestly be
sold at all.

---

## 0. Who this agreement is with

"ToolsEnabled," "we," "us," and "the Company" refer to the legal entity that
operates ToolsEnabled. **As of this document's date, that entity has not
been formed.** **Updated 2026-08-14:** the owner has decided the entity —
**ToolsEnabled, Inc., a Delaware C-corporation** — and the filing packet is
prepared (`ENTITY-FILING-READY.md`), but **the incorporation has not been
filed, so the entity still does not exist.** This section must be completed
with the filed entity's legal name, state, and principal address before this
document takes effect. Until then, ToolsEnabled is operated directly by its
founder, and any use of the product is with him personally, not a company.

---

## 1. What you're agreeing to use

ToolsEnabled is a local-first AI agent runtime: software that runs AI coding
and automation agents (via provider tools you configure, such as Claude Code
or Codex) with a configurable level of access to your own computer.

**Corrected 2026-08-12.** The free product is **ToolsEnabled**. The paid
product is **ToolsEnabled Anywhere**, and it has plans inside it — it is one
paid thing, not several products to tell apart.

| | Price in code | What it is |
|---|---|---|
| **ToolsEnabled** (Community) | $0, permanently | The whole local product. Not a trial, not a demo. Never licence-checked. |
| **ToolsEnabled Anywhere** — Operator Cloud | $19/mo or $190/yr | Our relay and your account area on our website. **Not available for purchase — see §2.** |
| **ToolsEnabled Anywhere** — Team | $299/mo, flat | Same, as a team plan. **Not available for purchase, and see the warning below.** |

**A paid plan buys exactly two things**, and both are servers we run: a relay
we host, and your account area on our website. That is a closed list in the
code, so nothing else can quietly become paid. Explicitly free forever, and
named as such in the code so no screen can disagree: the local runtime and
every tool it dispatches, direct machine-to-machine transport on your own
network, a relay you host yourself, pairing a second computer, the audit
ledger, the kill switch, approvals, and every other safety control.

Stated the other way round, in the words of our own commercial-licensing
document so that this table cannot be read as implying otherwise:
**ToolsEnabled Anywhere is a hosted service, not a feature unlock. Nothing in
this product is disabled, crippled or time-limited in order to sell it.** If
you can already reach your own machines, the free product is complete and you
need nothing from us.

**Two warnings about that table, for the owner rather than for a customer —
neither may be published as-is:**

- **The price is not settled.** The code says $19/month; the owner's own
  recorded words say "roughly $19.99 per month". The code itself flags the
  gap and says not to change the number without asking him, because a price
  on a receipt cannot be edited afterwards. **[OWNER DECISION]**
- **The Team plan has no owner authorisation on record.** The code states
  that no owner instruction anywhere authorises a $299/month Team plan; it
  came from an internal council, not from him. It must not appear on any
  price list until he has seen it. **[OWNER DECISION]**
- **Removed 2026-08-13: the "3-seat minimum".** The table above published one
  until today, and `REFUND-POLICY.md` §2 published the same figure. There is
  no such minimum. `src/lib/entitlement.js` records that `seatMinimum: 3` was
  deleted from the Team tier and that **the deletion is the decision, not an
  omission**: nothing enforced it, it was being copied into the
  customer-facing subscription catalogue regardless, and printed next to
  `$299` it read either as $299 or as $299 × 3 = $897. **Team is a flat
  $299/month.** The scope the owner's ruling attaches to it — up to 5 people
  and 15 computers — is deliberately not restated in the table, because
  nothing in this product counts people or computers and a second unenforced
  number would reintroduce the same defect under a new name.

### 1.2 What the product keeps on your computer

**New 2026-08-12.** These terms previously said nothing about this. The
product stores, on your own machine: an **encrypted credential vault** (which
can hold API keys, tokens, some site passwords, and — if you use that feature
— a full payment card number); a **tamper-evident audit log** of what your
agents did; a **dedicated browser profile** holding cookies, history and
saved logins for sites your agent visits; and a **spend ledger**. It can also
issue **virtual payment cards with spending limits** through Stripe.

`PRIVACY-POLICY.md` §2A–§2C, §3 and §8 describe each one, where it lives, and
how to delete it. Read that document; it is not boilerplate and it is where
the detail actually is.

### 1.1 The single most important disclosure: this product can be given
complete, unsandboxed control of your computer

Depending on the configuration you choose, ToolsEnabled can let an AI agent
**read, change, and delete any file on your computer, and run any program on
it, without asking you first.** This is a real, currently-shipping mode of
operation, not a hypothetical edge case — it is, in the product's own
engineering documentation, "what the product was originally built for." If
you choose this configuration, you are accepting that risk knowingly. The
product is designed to make this choice explicit, with a specific,
non-generic warning at the point you enable it, rather than a boilerplate
disclaimer buried here — but this document is also where it must be stated
plainly, because it is the fact that most changes the risk profile of using
this software. A mistake made by an agent running in this mode is not
limited to any one folder and is not automatically reversible.

Configurations exist (and are the recommended default for anyone not
deliberately choosing full access) that confine an agent to a folder you
pick, enforced by the operating system rather than by an on-screen promise.
Read your configuration's actual description in the product before assuming
which one applies to you.

## 2. Current availability — read before assuming you can pay us

**As of this document's date, ToolsEnabled cannot actually charge for
anything.** This is stated here, not softened, because a Terms of Service
that describes a working paid product when none exists would be false. The
following are independently verified facts about the current state of the
product, each with its own approval item in `docs/design/LAUNCH-APPROVALS.md`:

- **Corrected 2026-08-12.** The previous version of this bullet said licence
  verification "is not wired to refuse execution." **That is no longer
  true**, and the correction is in your favour — see §5. Licence checks now
  exist, and they run **only on servers we operate**, never on your computer.
  An installation with no licence is still refused nothing, ever.
- No network surface of this product is reachable over the public internet.
- **The relay the paid product depends on has not been deployed.** The code
  is written and tested; no server has been bought and no domain registered.
  Nothing is running.
- The installer used to distribute this software is not code-signed (see
  `docs/design/CODE-SIGNING-DECISION.md`), so Windows will show a security
  warning on first run.
- **No customer can be charged today.** **Corrected 2026-08-14 — the previous
  version of this bullet was false and said so more confidently than the truth
  allowed.** It claimed the Paddle integration was pinned to sandbox "in source
  code" and could not touch real money without someone editing code. That is
  no longer how it works: **Paddle's live mode is now a configuration file**
  (`config/paddle-environment.json` — its absence is what keeps Paddle in
  sandbox), so the barrier is configuration, not code. The Stripe integration
  points at Stripe's production API and would charge real customers if live
  keys existed. As of the last check no merchant credential of either kind was
  configured, no products or prices had been created, and there is no checkout
  page anywhere — all of which is configuration, so **re-verify on the day
  this document is published** rather than trusting this sentence. See
  `docs/design/PAYMENT-PATH-DECISION.md`.
- **No entity exists to be paid** — see §0.

Nothing in this document should be read as an offer to sell a paid tier
until these are resolved and this section is updated to say so.

## 3. Open-source status of the local runtime **[LAWYER — verify before
relying on this section]**

**The product is licensed under the MIT License.** On 2026-08-12 the owner
relicensed both halves from `AGPL-3.0-or-later` to `MIT`. This supersedes the
earlier internal decision in
`docs/coordinator/R1162-MONETIZATION-FINAL-DECISION.md`, which had set AGPL-3.0
plus a contributor license agreement; that document remains as the record of
what was decided at the time and is no longer the live position.

What is true today, verified directly against the repository:

- **Done.** The local runtime declares `"license": "MIT"` and ships the
  standard MIT License text as its `LICENSE` file, alongside `NOTICE` and
  `THIRD-PARTY-LICENSES.md`. The grant is real; it is made by that `LICENSE`
  file, and nothing in this document adds to or narrows it. The desktop
  interface half declares the same licence, and a gate
  (`tests/source-license-drift.test.js`) fails the build if the two ever
  disagree.
- **Done, in place of the CLA: contributor terms.** Outside contributions are
  accepted under the Developer Certificate of Origin 1.1 — a `Signed-off-by`
  line on each commit, no copyright assignment. A CLA is no longer required,
  because what is sold is operating a server rather than a licence to the
  code, and MIT already permits sublicensing of inbound contributions. See
  `CONTRIBUTING.md` and `CONTRIBUTORS.md`.
- **No longer applicable: the extension SDK carve-out.** An Apache-2.0 SDK was
  planned so third-party integrations could embed the extension protocol
  without inheriting copyleft terms. Under MIT there is nothing to inherit, so
  the carve-out has no purpose. Nothing is offered under Apache-2.0 today.
- **Not done: the hosted control plane licence.** Nothing is offered under
  FSL-1.1. The server-side implementation is simply not in this repository;
  what is sold is our operation of it, and running your own server instead is
  free and documented. *(Changed from "free and supported" 2026-08-14, owner
  decision: "supported" promised a support commitment that has no policy,
  channel, scope, or cap behind it. "Documented" is the promise we can keep
  today; the word can be upgraded when a support policy exists.)*
- **Excluded.** An internal secure-messaging engine referred to internally
  as SecureAgentChannel is still under development and is explicitly
  excluded from any external release pending a separate decision from the
  owner — do not represent it as open, licensed, or available.

**What MIT does not include.** It grants copyright permissions and contains no
express patent grant. Apache-2.0 is similar in shape and adds one. MIT was
chosen deliberately; this is recorded so the absence is a known position rather
than an oversight.

`private: true` remains set in `package.json`. That flag only blocks
publication to the npm registry, which this runtime is not packaged for; it
does not restrict the MIT rights above and is not a reservation of them.

Publication of the source is a separate act from the grant, and this
document does not assert that it has happened. Check the actual `LICENSE`
file and `package.json` in the version you have.

## 4. Acceptable use **[LAWYER]**

You agree not to use ToolsEnabled to:

- Violate any law, or the terms of any AI provider (Anthropic, OpenAI,
  Google, or any other) whose service you connect through ToolsEnabled;
- Attempt to circumvent the license-verification, kill-switch, or audit
  mechanisms described in the product;
- Resell or sublicense the software beyond what your tier's license
  (once one actually exists — see §2 and §3) permits.

This is a starting shape, not vetted acceptable-use language. A real
acceptable-use policy needs counsel, particularly given the product's own
unsandboxed-operation mode (§1.1) and the multi-agent messaging feature
noted in §7.

## 5. License keys and termination

**Corrected 2026-08-12. The previous version of this section said no licence
check had a caller and paid features were not technically restricted. That
gap has been closed, and how it was closed is the important part.**

A paid plan is represented by a signed licence key, checked **offline** by
signature against a local revocation list, with no network call to verify it.

The check now has two real callers, and **both run on machines we operate**:

1. **Admission to the relay we host.** Our relay checks the licence before
   accepting a connection, and refuses if anything about the check fails.
2. **Admission to your account area on our website.** The same, on our web
   server. Nothing your browser reports about itself is trusted.

**No licence check runs on your computer, and none ever will for the free
product.** An unlicensed installation does not merely skip the check — it
never loads the code that performs one. That is held in place by a test that
fails the build if any part of the product outside a short, named list tries
to check a licence on its own.

Stated as a commitment rather than as an accident: **an unlicensed
ToolsEnabled is fully functional, permanently.** Not degraded, not a trial,
not nagged, not time-limited.

**When your access to the paid parts ends.** If a subscription is cancelled,
lapses for non-payment, or is reversed by a chargeback, the licence is
revoked and the servers we operate stop admitting you. Your ToolsEnabled
keeps working exactly as before. The product's own message says it in these
words: *"Your product keeps working; only the paid, vendor-operated parts
stop."*

We may also revoke a licence key for breach of these terms or for fraud.

### 5.1 Refunds and cancellation

**New 2026-08-12.** Refunds, cancellation, failed payments, and chargebacks
are covered by a separate document, **`REFUND-POLICY.md`**, which describes
what the software actually does in each case rather than what a template
would say. It is a draft with owner decisions still open, and — like this
document — it may not be published until those are made and a lawyer has
reviewed it. **No subscription may be sold before it is published**, because
a person is entitled to read the refund terms before paying, not after.

**Updated 2026-08-13 — the specific blocker, named here rather than left in
the other document.** There is **no refund window**: how long a buyer has to
ask for their money back has not been decided, and no drafter has invented
one. That blank and the four other unmade decisions each carry the literal
token `[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]` in `REFUND-POLICY.md`, so
a publication check can grep for a single plain-ASCII string across both
files. **While that string appears in `REFUND-POLICY.md`, neither document may
be published and nothing may be sold.**

## 6. Third-party AI providers

ToolsEnabled connects to AI providers you choose and authenticate with
directly (see `PRIVACY-POLICY.md` §2 for exactly how). We are not a party to
your agreement with Anthropic, OpenAI, Google, or any other provider, we do
not control their pricing, availability, or content policies, and we are not
responsible for their acts or omissions. If a provider changes its terms,
pricing, or availability in a way that affects ToolsEnabled, that is outside
our control.

## 7. Multi-agent messaging — a known limitation, disclosed rather than
hidden

If you use ToolsEnabled's agent-to-agent coordination feature to run
multiple agents that pass messages to each other, be aware: as of this
document's date, that transport is not the hardened, independently-reviewed
secure channel referenced in §3. The product's own internal security
doctrine describes the current transport candidly as
"plaintext/shared-key/self-asserted-sender." **This system has not had a
formal security or legal review.** Its functionality and security are not
guaranteed. Do not rely on it to carry anything you would not accept another
process on the same machine, or another agent in the same fleet, being able
to read or spoof the origin of.

## 8. No warranty **[LAWYER]**

TO THE MAXIMUM EXTENT PERMITTED BY LAW, TOOLSENABLED IS PROVIDED "AS IS" AND
"AS AVAILABLE," WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
WITHOUT LIMITATION WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE, AND NON-INFRINGEMENT. This is standard-shape disclaimer language,
not attorney-drafted or reviewed for this product or this jurisdiction —
**do not treat this section as enforceable until counsel has reviewed it**,
particularly given §1.1's unsandboxed-operation disclosure, which a court
may hold to a higher specificity standard than boilerplate.

## 9. Limitation of liability **[LAWYER]**

TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT WILL WE BE LIABLE FOR ANY
INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY
LOSS OF DATA, ARISING FROM YOUR USE OF TOOLSENABLED — INCLUDING DAMAGE CAUSED
BY AN AGENT OPERATING IN THE UNSANDBOXED MODE DESCRIBED IN §1.1, WHICH YOU
HAVE BEEN TOLD CAN MODIFY OR DELETE ANY FILE ON YOUR COMPUTER. Same caveat as
§8: this is unreviewed standard-shape language, and the interaction between a
liability cap and a product that can, by explicit design, take destructive
action on a user's machine is exactly the kind of question that needs a
lawyer who has read the actual product, not a template.

## 10. No independent security review yet

Per the product's own security doctrine
(`docs/design/SECURITY-POSTURE-DOCTRINE.md` §5): where a formal security or
legal review has not happened and is not scheduled, that gets disclosed here
rather than silently assumed. **As of this document's date, ToolsEnabled has
not had an independent external security review.** One is planned — see
`docs/design/LAUNCH-APPROVALS.md` for cost and scheduling — but has not
occurred. Nothing in this product's marketing or documentation should be
read as a claim that it has been independently audited unless and until that
happens and this section is updated.

## 11. Governing law **[LAWYER]**

Intended to be the State of Delaware, matching the decided incorporation
(§0, updated 2026-08-14) — this cannot be finalized until the filing is
actually complete. **Two things counsel must reshape here, not just fill in
(recorded 2026-08-14):** a Delaware choice-of-law clause does not displace
CLRA/UCL protections for a California consumer, and with Paddle as merchant
of record (see `REFUND-POLICY.md` §0) the buyer's contract for the money is
with Paddle under Paddle's terms — so this clause governs less than it
appears to, and its final shape is a counsel question.

## 12. Changes to these terms

We will update the "Last updated" date and, for material changes, provide
notice through the product itself before the change takes effect.

## 13. Contact

**Open item, same as `PRIVACY-POLICY.md` §11:** no company domain is
registered yet, so there is no support or legal contact address to publish.
Complete this section before publishing this document.

---

## Summary of what this document cannot do yet

This draft is grounded in the actual product as it exists today, verified
against source code rather than assumed. It cannot be finalized because:

1. The operating entity does not exist yet (§0).
2. The product cannot currently charge anyone anything (§2).
3. Only part of the licence structure it describes has happened (§3).
4. Every section marked **[LAWYER]** is standard-shape language, not legal
   advice, and needs a licensed attorney's review before it is enforceable —
   particularly §8/§9 given the product's unsandboxed-operation mode.
5. There is no contact address (§13).
6. **Added 2026-08-12.** The price and the existence of the Team plan are
   both undecided by the owner (§1), and a price list cannot be published
   with either one guessed.
7. **Added 2026-08-12, updated 2026-08-13.** `REFUND-POLICY.md` exists but has
   **five** open owner decisions in it (§5.1) — the fifth, how fast a refund
   request is answered, was previously buried inline in that document with the
   shape of a commitment already made. The first of the five is the refund
   window itself. Until they are answered and that document is published, no
   subscription may be sold.

Each of these is carried into `docs/design/LAUNCH-APPROVALS.md` as its own
decision item rather than resolved by guessing here.

**Where these documents must appear before anyone pays** — which surface,
which link, which order — is planned in `docs/launch/LEGAL-PUBLICATION.md`.
An accurate document nobody meets before paying does not do the job it
exists for.
