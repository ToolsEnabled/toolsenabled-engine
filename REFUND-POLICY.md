# ToolsEnabled Refund and Cancellation Policy

**Status: DRAFT. Not in effect. Do not publish, link, or show at a checkout
until (a) the owner has set the numbers in "Decisions only the owner can
make" below, (b) a lawyer has reviewed it, and (c) the operating entity exists.
Nothing is on sale today — see §1.**

> ### STOP — THE REFUND WINDOW IS NOT SET
>
> `[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]`
>
> **This document does not say how long you have to ask for your money back,
> because nobody has decided.** It has not been guessed at, and the gap is
> marked rather than left silent: every unmade decision below carries that
> exact token. **If the literal string
> `[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]` appears anywhere in this file,
> this file may not be published, linked, or shown at a checkout.** It is one
> plain-ASCII string, so a publication check can grep for it and a reader
> cannot walk past it.

Last updated: 2026-08-13

**Corrected 2026-08-13.** Two statements in the 2026-08-12 version were false.
Both are fixed below and marked where they appear:

- **The licence.** Appendix B item 5 said the product was
  `AGPL-3.0-or-later` and built its central legal question on **AGPL section
  13**. **The product is MIT.** `package.json` declares `"license": "MIT"` and
  `LICENSE` is the standard MIT License text — which is what
  `TERMS-OF-SERVICE.md` §3 has said all along. Two documents that a buyer is
  meant to read *before* paying disagreed about the licence of the thing being
  sold. Appendix B item 5 is rewritten, and the reasoning that existed only
  because of the AGPL is **removed rather than find-and-replaced**, with each
  removal named there.
- **The 3-seat minimum.** §2's price table published "$299/month, 3-seat
  minimum" for the Team plan. **There is no such minimum.**
  `src/lib/entitlement.js` records the deletion of `seatMinimum: 3` as the
  decision itself, not an omission. Removed here and in `TERMS-OF-SERVICE.md`
  §1.

This document describes what happens to your money and to your access when you
cancel, ask for a refund, or dispute a charge. Every mechanical statement in it
was checked against the code that actually decides the outcome
(`src/lib/entitlement-grant.js` and `src/lib/entitlement.js`), and the code is
quoted in Appendix A so you can check it too. Where the software would
contradict a sentence, the sentence is not in here.

---

## Decisions only the owner can make

This policy cannot be published until these are settled. Each one is a business
choice, not an engineering fact, so **none of them is invented here.** A number
that nobody decided is worse than a blank, because a buyer reads it as a
promise and a drafter cannot make one.

**How the blanks are marked, so none of them can ship unnoticed.** Every unmade
decision carries the literal token
`[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]` — here, and again at every place
in the body where that decision would otherwise be stated. Where a value
appears beside one of those tokens it is a **suggestion to the owner, never a
commitment**; it must be replaced by his answer or deleted, and it must not be
published as it stands.

> **Status change, 2026-08-14: all five decisions are RULED, and the tokens
> still stand.** The owner answered all five on the Paddle-verified decision
> sheet (`toolsenabled\legal\reports\R-005-refund-decision-sheet.md`): any
> charge — first or renewal — refundable within **14 days** of that charge;
> cancellation takes effect at the **end of the period already paid for**;
> annual plans **prorated by unused whole months, always paired with
> cancellation**; refund requests answered **within 5 business days**, with
> processing wording that names Paddle. The tokens are NOT cleared by this
> note: per the publication gate, the ruled values are written into the body
> and the tokens removed **only after documented counsel review** — the
> rulings are the input to that review, not a substitute for it.

1. **The refund window — the decision this entire document exists to carry.**
   `[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]`
   *Suggestion only, not a decision and not a commitment: 30 days from the
   first charge.* The reasoning offered with it, also not a decision: monthly
   billing means a 30-day window is at most one period, which is the same
   exposure the code already accepts (Appendix A, note 4).
2. **Whether renewals are refundable, and for how long after the renewal
   charge.** `[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]`
   *Suggestion only: 7 days after a renewal charge.*
3. **Whether cancelling ends hosted access immediately or at the end of the
   period already paid for.** `[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]`
   *Suggestion only: at the end of the period you already paid for.* The
   software supports both and the choice is literally a parameter — see
   Appendix A, note 6.
4. **Annual plans: refunded in full, or prorated?**
   `[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]`
   *Suggestion only: prorated for unused whole months.* Read Appendix A note 5
   before deciding this one: for an annual plan the code's default behaviour is
   materially more expensive than for a monthly plan.
5. **How fast we answer a refund request.**
   `[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]`
   *Suggestion only: within 5 business days.* Raised to its own numbered
   decision on 2026-08-13; it was previously inline in §4, where it had the
   shape of a commitment that had already been made.

Until 1–5 are answered, the rest of this document is accurate about the
mechanism and silent about the promise.

---

## 0. Who you would be buying from — not yet a company

"We" and "us" mean the business that operates ToolsEnabled. **As of this
document's date that business is not formed.** ToolsEnabled, Inc. is *in
formation*: it has not been filed, so it does not exist and cannot be a party
to anything. Until it is filed, any sale would be a sale by the founder
personally.

**This section must be rewritten the moment the entity is filed**, with the
real legal name, the state, and the address. Everywhere below that says "we",
the answer to "who, exactly, owes me this refund?" changes on that day.

There is a second question about who you buy from, and it is not cosmetic.
**Decided 2026-08-14 by the owner: we sell through Paddle, and Paddle is the
merchant of record.** What that means, stated plainly because it changes who
you are actually contracting with:

- **Paddle is legally the seller.** The charge on your statement is Paddle's,
  and **Paddle's own buyer terms and refund policy apply to the transaction**
  (paddle.com/legal/buyer-terms and /legal/refund-policy).
- **This policy governs your access; Paddle decides the money.** Anything this
  policy grants you beyond Paddle's baseline still binds — Paddle's refund
  policy applies "the highest level of rights" where a supplier grants more —
  and we can never pay you a refund directly: we instruct Paddle, and Paddle
  makes the refund to your payment method.

*(The prior draft presented Stripe-as-seller as an open alternative. The code
still supports both (`GRANT_PROVIDERS` in `src/lib/entitlement-grant.js`);
the business decision is made, and the remaining lawyer work is reviewing
this policy against Paddle's buyer terms — not choosing.)* **[LAWYER]**

---

## 1. Nothing is on sale yet

Stated first, because a refund policy for a product nobody can buy would be
theatre. As of this date:

- The Paddle integration runs against **Paddle's sandbox**. **Corrected
  2026-08-14: the previous sentence said it was pinned there "in source code"
  and could not touch real money without someone editing code. That is no
  longer true — live mode is now a configuration file**
  (`config/paddle-environment.json`; its absence is what keeps sandbox), so
  the barrier is configuration, not code. No live configuration and no
  merchant credential exists as of this date — re-verify on the day this
  document is published.
- No merchant account exists, and the prices in the code are **descriptive**:
  `src/lib/entitlement.js` says so directly — "nothing in this repository can
  charge anyone; that requires a merchant account the owner has not created."
- There is no website, no checkout page, and no registered domain.

When any of that changes, this section must be deleted and the "Decisions only
the owner can make" block must already be answered.

---

## 2. What you would actually be buying

The paid product is **ToolsEnabled Anywhere**. It is one product with plans
inside it, not several products:

| Plan | Price in code | What it is |
|---|---|---|
| Community | $0, forever | The whole local product. Not a trial. Never licence-checked. |
| Operator Cloud | $19/month or $190/year | ToolsEnabled Anywhere |
| Team | $299/month, flat | ToolsEnabled Anywhere, team plan |

**Two warnings about that table, for the owner, not for the customer:**

- The `$19` figure does not match the owner's own recorded words ("roughly
  $19.99 per month"). `src/lib/entitlement.js` flags this itself and says do
  not change the number without asking him. A price on a receipt is not
  editable after the fact. **[OWNER DECISION]**
- The **Team plan has no owner authorisation on record at all.** The same file
  states that no owner instruction anywhere authorises a $299/month Team
  plan. It must not appear on a price list until he has seen it.
  **[OWNER DECISION]**
- **Removed 2026-08-13: the "3-seat minimum".** This table published one until
  today. There is no such minimum, and its absence is a decision rather than an
  oversight: `src/lib/entitlement.js` records that `seatMinimum: 3` was deleted
  from the Team tier because nothing in the product enforced it, it was being
  copied into the customer-facing subscription catalogue anyway, and printed
  beside `$299` it read two ways — $299, or $299 × 3 = $897. **Team is a flat
  $299/month.** The same file records the owner's ruling that Team covers up to
  5 people and 15 computers; that scope is deliberately *not* restated in the
  table above, because nothing in this product counts people or computers and a
  second unenforced number would be the defect that was just removed, wearing a
  new name. Do not re-add either figure to this table.

**A paid plan buys exactly two things.** Both are servers we pay for and keep
online:

1. **A relay we host**, so two of your computers can reach each other across
   any network without you running a server.
2. **Your account area on our website**, so you can reach your machines and
   your subscription from a browser.

That is the complete list. It is a closed list in the code
(`GATED_CAPABILITIES`), and a new paid gate cannot be added anywhere in the
product without being added there first.

### What you keep no matter what happens to your money

This is the most important paragraph in this document.

**An unlicensed ToolsEnabled install is fully functional, forever.** Not a
trial, not degraded, not nagged, not time-limited. If you cancel, if we refund
you, if you dispute the charge, if you never pay us at all — the local runtime,
the direct machine-to-machine connection on your own network, a relay you run
yourself, the audit log, the kill switch, the approvals, and every other safety
control keep working exactly as they did.

The code states this as a single constant so that no screen anywhere can
disagree with it: `UNLICENSED_INSTALL = 'full-function'`. The product's own
refusal message, shown to a customer whose subscription has ended, says it in
these words: *"Your product keeps working; only the paid, vendor-operated parts
stop."*

So when this policy talks about "losing access", it means **losing the relay we
host and the account area on our website**. It never means losing your
software, your data, your files, or your ability to keep using ToolsEnabled.

---

## 3. Cancelling

You can cancel at any time. You do not need a reason and you do not need to ask
us.

- Cancelling stops future charges.
- Cancelling ends your hosted access — and **when** it ends is decision #3,
  which is unmade: **`[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]`**. This
  sentence has no ending until the owner supplies one, and none has been
  invented for it.
- Cancelling is not the same as a refund. It stops the next charge; it does not
  return the last one. If you want money back, see §4.
- Your account record is **not deleted** when you cancel. That is deliberate:
  if you come back, you should find your account rather than a hole where it
  was. If you want the record deleted, see §7 — and read it, because we cannot
  yet do everything you might expect there.

## 4. Asking for a refund

> ### STOP — THERE IS NO REFUND WINDOW IN THIS DOCUMENT
>
> `[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]`
>
> **Decisions #1 and #2 — how long after the first charge you may ask for your
> money back, and whether a renewal charge is refundable at all — have not been
> made.** Nothing has been put here in their place, and nothing should be: a
> window invented by whoever was drafting is a promise the business never
> agreed to, made to a person who is about to hand over money. Every other
> section of this policy describes what the software actually does and can be
> checked against the code. This section is the *promise*, and the promise does
> not exist yet. **This document cannot be published while this box is here,
> and the box may only be replaced by the owner's own answer.**

To ask, contact us at the address in §9. Tell us the email you paid with.

**How fast we answer** is decision #5, and it is also unmade:
`[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]`. No response time is stated
here, because none has been agreed. `PRIVACY-POLICY.md` §8.4 takes the same
position on data requests, for the same reason: an invented number would be
worse than none.

If we sell through Paddle, Paddle is the seller and the refund is processed by
Paddle under Paddle's own terms (§0). We will still handle your access as
described below.

## 5. What a refund does to your access — read this, it is not what you expect

**A refund does not by itself switch off your hosted access.** This is a real
property of the software, not a loophole, and it is written down here because
the software will behave this way whatever a policy says.

Access follows **the subscription**, not the money. Those are two separate
things in the payment provider and in our code:

- **We refund you.** Your money comes back. Nothing happens to your access.
- **We cancel your subscription.** Your hosted access ends (per §3).

When we give you a refund because you are leaving, **we do both** — refund the
money and cancel the subscription. That is our commitment, and it is the thing
a human at our end has to do, because no webhook will do it for us.

Why the software works this way, in plain terms: a refund is something *we*
choose to do, and we do it for many reasons that have nothing to do with ending
someone's service — fixing an overcharge, a goodwill credit, a partial refund
after a bad week, a proration when you change plans. If every refund killed
access, every one of those kindnesses would break a paying customer's product.
The software also genuinely cannot tell, from the refund notification alone,
whether it was your whole month or two dollars of it, and it refuses to guess.

**The consequence, stated against ourselves:** if we refund you and forget to
cancel, you keep hosted access until the period you were refunded for runs out,
plus three days. That is our mistake to eat, and it is visible in our own
records. See Appendix A, note 5 for why this matters much more on an annual
plan than a monthly one.

## 6. If a payment fails

A declined card does not end your service on the spot.

When your payment fails, your provider keeps retrying it. We **hold** your
access for **three days** from the first failed attempt while that happens.
During the hold nothing about your product changes.

- If the retry succeeds, the hold clears and you will probably never have
  noticed.
- If three days pass with no successful payment, the hold ends and hosted
  access stops.

The three days run from the **first** failure and are not restarted by later
retries — otherwise the window would never close.

If your subscription is then cancelled for non-payment, everything in §2 still
applies: your local ToolsEnabled keeps working.

## 7. Chargebacks — please talk to us first

A chargeback (a "dispute") is when you ask your bank to reverse the charge
instead of asking us. We would much rather you asked us, and here is the honest
reason why, in mechanical terms:

- **A chargeback immediately ends your hosted access.** Unlike a refund, this
  one is automatic. The software treats a chargeback as revoking the licence
  the moment the notification arrives.
- **It is a one-way door in the software.** Once a subscription has been ended
  by a chargeback, **no payment notification of any kind can turn it back on** —
  not a reversal of the dispute, not a new payment, not a resumed subscription.
  Restoring it requires a person at our end who can see what happened. That is
  deliberate: money was taken back by a route nobody here chose, and a webhook
  is not allowed to undo that decision.
- **A chargeback warning is not a chargeback.** If your bank tells us a dispute
  *may* be raised, nothing happens to your access. Warnings are often
  withdrawn, and taking access away on a warning would be taking away something
  we could not easily give back.
- **Your record survives it.** Ending access never deletes your account record.
  If a dispute was a mistake, there is something to restore.

And again: a chargeback does not touch your local ToolsEnabled install. It
keeps working, forever, exactly as it did.

If you dispute a charge, the fastest way back is to email us (§9). It needs a
human either way.

## 8. Annual plans

**Whether an annual plan is refunded in full or prorated is decision #4, and it
is unmade: `[[UNSET-OWNER-DECISION-BLOCKS-PUBLICATION]]`.** Nothing is stated
here in its place.

One warning that belongs in front of that decision rather than behind it: the
"refund does not cancel" behaviour in §5 is bounded by **one billing period**.
On a monthly plan that is a month. On the $190 annual plan **that is a year**.
Any annual refund must be paired with a cancellation by a human at our end, or
the customer keeps a year of hosted service they have been paid back for.

## 9. How to reach us

**Open item — blocks publication.** No company domain is registered, so there
is no support or billing mailbox to publish here. A refund policy with no way
to ask for a refund is not a policy. This must be filled in with a real, live,
monitored address before this document is shown to anyone.

## 10. Changes to this policy

We will post changes here with a new "Last updated" date. If a change makes
refunds harder, it applies only to purchases made after the change, never
backwards to something you already bought.

---

## Appendix A — the code that decides this

Reproduced so the policy can be checked rather than trusted. Source:
`src/lib/entitlement-grant.js` (`PADDLE_EVENTS`,
`PADDLE_REVOKING_ADJUSTMENTS`, `applyHold`, `applyRevoke`,
`applyGrantOrRenew`) and `src/lib/entitlement-fulfilment.js`
(`RENEWAL_GRACE_MS`, `ledgerRowStanding`).

| What happens at the payment provider | What the software does to hosted access |
|---|---|
| Subscription created / activated / resumed | Grants access |
| Payment succeeds (renewal) | Extends access to the end of the new paid period |
| Subscription status is `active` or `trialing` | Access continues |
| Subscription status is `past_due` | **Holds** access for 3 days from the first failure (note 3) |
| Subscription cancelled | **Ends** access |
| Subscription paused | **Ends** access |
| Subscription status not recognised by this build | **Ends** access (fails closed) |
| **Refund** | **Nothing.** Access is unchanged (note 1) |
| **Credit / partial credit / proration** | **Nothing.** Access is unchanged |
| **Chargeback** | **Ends** access immediately (note 2) |
| Chargeback *warning* | Nothing |
| Chargeback reversed / credit reversed | Nothing — never restores access (note 2) |
| Chargeback that was rejected or reversed by the bank | Nothing — it did not stand |
| A notification the build cannot read | Refuses, changes nothing, and says so |

**Note 1 — why a refund does not revoke.** The code's own words: *"ACCESS
FOLLOWS THE SUBSCRIPTION, NOT THE MONEY. A refund is an act by the OPERATOR …
An operator who also means to end the access ends the subscription."* It also
records that the refund notification states only the adjustment's own totals,
not the original transaction's, so "was this the whole period or two dollars of
it" **cannot be answered** from the notification, and the code has no way to
ask.

**Note 2 — the chargeback one-way door.** A subscription ended by a chargeback
records *why*, and the grant path refuses to revive it: *"a chargeback-voided
row is never revived here at all: the money was taken back, nobody at this end
chose it, and restoring access needs an operator who can see the dispute, not a
webhook."*

**Note 3 — the hold.** `RENEWAL_GRACE_MS = 3 * 24 * 60 * 60 * 1000` — three
days. The hold writes a `graceEndsAtMs` onto the record, which every access
check reads, so the hold ends by itself with nothing having to run. The clock
starts at the first dunning signal and is not restarted by later retries.

**Note 4 — the same three days appear twice.** A licence is issued to expire at
the end of the paid period **plus three days**, to absorb clock differences and
late webhooks. So a customer who is briefly offline or whose renewal
notification is slow does not lose service.

**Note 5 — the bounded exposure, in the code's own words:** *"a customer who is
refunded in full and whose subscription is NOT cancelled keeps hosted access
until the paid period they were refunded for ends, plus RENEWAL_GRACE_MS. That
is at most one billing period."* On the annual plan, one billing period is one
year. §8 exists because of this sentence.

**Note 6 — immediate vs end-of-period cancellation is a parameter.** The
cancellation call accepts `immediately` or `next_billing_period`
(`subscriptionCancel` in `src/lib/providers/paddle.js`). Owner decision #3 is
choosing which one we use; nothing needs to be built either way.

**Note 7 — nothing here can be triggered by a customer claiming to have paid.**
Every entitlement change requires a notification carrying the payment
provider's valid signature over its exact bytes. There is no route that accepts
"I paid, please grant me access."

---

## Appendix B — what still needs a lawyer, and what changes when the entity is filed

Neither the author of this document nor the owner is a lawyer. Nothing here is
legal advice, and the items below are flagged rather than guessed at.

**Needs a licensed attorney before publication:**

1. **Consumer statutory refund rights.** Many places give buyers cancellation
   or withdrawal rights that override a seller's policy, and some of them apply
   the moment you sell to someone who lives there. This document deliberately
   states **no** jurisdiction and claims **no** governing law. A lawyer has to
   say which rules apply and what this policy must therefore contain.
2. **Merchant-of-record consequences (§0).** If Paddle is the seller, the
   customer's contract for the money is with Paddle, and this policy must not
   contradict Paddle's buyer terms. Which document wins, and what we may
   promise on top, is a legal question.
3. **Sales tax and VAT on refunds.** Refunding tax that has already been
   remitted is not the same operation as refunding the price. Untouched here.
4. **Whether the refund window may differ between plans, renewals, and
   countries** without creating a problem.
5. **The interaction between §2 ("you keep the software forever") and the
   licensing position.**

   > **Corrected 2026-08-13. The 2026-08-12 version of this item was wrong
   > about the licence.** It stated that the runtime was
   > `AGPL-3.0-or-later` and built its central question on **AGPL section
   > 13**. **The product is MIT.** The licence moved twice on 2026-08-12 —
   > all-rights-reserved, then `AGPL-3.0-or-later`, then `MIT` in commit
   > `b4c9016` — and this appendix was written against the middle value and
   > left there. Verified for this correction: `package.json` declares
   > `"license": "MIT"`, `LICENSE` is the standard MIT License text, and
   > `tests/source-license-drift.test.js` fails the build if the engine and
   > desktop halves ever disagree. **`TERMS-OF-SERVICE.md` §3 is the section
   > that states the licence position; this appendix must never restate it
   > differently, and if the two ever diverge again, §3 is the one to trust
   > and this item is the one that is stale.**

   *Settled, and simpler under MIT than it was under the AGPL:* a customer who
   stops paying keeps the licence grant on the source. It was never
   conditioned on payment — MIT's grant is unconditional on its face and has
   no term tied to a subscription — and what a lapsed customer loses is the
   hosted service, which was never under the licence at all, because the
   server-side implementation is not in this repository. That is the live
   position in `TERMS-OF-SERVICE.md` §3, and §2 above is consistent with it.
   The internal record reached the same conclusion before the relicence, but
   it reasoned from the AGPL and its wording says so; **those sentences are
   superseded and must not be quoted forward into a published document.**
   The position is also still internal and **has not been lawyer-reviewed**,
   so counsel should confirm it rather than inherit it.

   **Removed rather than rewritten: the clauses that existed only because of
   the AGPL.** Each is named here so that its removal is a record instead of a
   gap, and so nobody restores it by finding the old text in history.

   - **The AGPL section 13 question — removed, because it does not arise.**
     The previous version called this "the sharpest licensing question the
     paid product raises": if the repository containing the operator-side
     gates were published under the AGPL, would *operating* the hosted
     service from it oblige us to offer its Corresponding Source to that
     service's users? **MIT contains no such term.** It has no network-use
     clause, no Corresponding Source concept, and no obligation triggered by
     running a service. This is not an open question that we have stopped
     tracking; it is a question that the licence in force does not pose.
     Deleting it is the correct treatment — restating it with "MIT"
     substituted for "AGPL" would have produced a sentence with no referent.
   - **The `-or-later` suffix — removed.** The previous version said the
     suffix was "load-bearing and was a deliberate choice". MIT is
     unversioned. There is no suffix, and nothing for it to carry.
   - **"Copyleft" as the reason the source matters — removed.** The old
     reasoning treated publication of the source as the event that imposed
     duties on us. Under MIT, publication imposes no duty on us; it grants
     permissions to whoever receives it. The direction of the obligation is
     the thing that changed, which is why this could not be a find-and-replace.

   **Kept, because it survives the licence change intact:** the distinction
   between the installed product and the published source. It is still easy to
   get wrong and still worth handing to counsel — **they are not the same
   distribution.**

   - **The installed product contains no licence check.** The desktop
     installer's payload boundary classifies every entitlement module as
     non-shipping, so someone who receives the built application receives
     nothing to remove.
   - **The published source does contain them.** All six entitlement
     modules — the licence resolver, the relay admission gate, the website
     admission gate, the grant path, the fulfilment ledger and the webhook
     listener — are tracked in this repository today (re-verified with
     `git ls-files` on 2026-08-13). Under MIT a source recipient may modify
     and redistribute them, and MIT says so expressly rather than leaving it
     to be argued.

   The *consequence* of that is small, and worth saying so plainly: someone
   who strips the check can only admit themselves to a relay they host
   themselves, which is already free, supported, and named as a free
   alternative in the code. Under MIT this is a commercial fact about the
   moat, not a licensing exposure — there is no obligation it can breach.

   **Updated, not deleted: the payload boundary.** The previous version said
   this repository had "no payload-boundary file at all", and that until one
   existed, "what does the AGPL grant cover" had no checkable answer. Both
   halves have moved.

   - The file now exists: `config/payload-boundary.json`, read by
     `tools/check-payload-boundary.mjs`, which refuses a source publish if a
     tracked file is classified nowhere. It carries `"status": "proposed"`,
     and `src/lib/entitlement.js` is still listed under `pending` rather than
     classified — so the boundary is drawn but not yet ruled on.
   - The question it was needed to answer is no longer a licensing question.
     MIT grants rights over what is actually published and creates **no duty
     to publish anything**, so the grant's scope is simply whatever the
     published tree contains, and it is checkable by looking at that tree.
     The boundary still matters — it is what decides what goes into the tree,
     and therefore what a competitor gets for free — but that is a **release
     and commercial decision**, no longer a prerequisite for answering a
     question about our own legal obligations.

   **What is actually left for counsel here, stated narrowly so it is not
   inherited at the old question's weight.** MIT grants copyright permissions
   and contains **no express patent grant**; `TERMS-OF-SERVICE.md` §3 records
   that absence as a known, deliberate position rather than an oversight.
   Whether that absence matters for a paid hosted service sold alongside MIT
   source is a question for a lawyer, and it is the only licensing question
   this document still needs to hand over. It is a much smaller question than
   the one it replaces.

**Changes the day ToolsEnabled, Inc. is actually filed:**

- §0 gets the real legal name, state of incorporation, and business address,
  and stops saying the entity does not exist.
- "Who owes you the refund" changes from a person to a company.
- A merchant account can be opened in the company's name, which unblocks §1 —
  and the moment it does, §1 must be deleted rather than left standing as a
  false statement that nothing is for sale.
- The tax questions in item 3 above become live rather than hypothetical.

**Explicitly not in this document, and not to be added without counsel:**
no governing law, no venue, no arbitration clause, no class-action waiver, no
liability cap, and no warranty disclaimer. Their absence is deliberate. See
`TERMS-OF-SERVICE.md` for the sections that carry standard-shape language and
the **[LAWYER]** marks on them.
