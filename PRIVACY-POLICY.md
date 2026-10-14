# ToolsEnabled Privacy Policy

**Version 1.0 — effective the date of first publication, shown on the
published page.** This policy describes what the software does on your machine
and what our hosted service holds about you if you create an account. Every
mechanical claim in it was checked against the code at publication.

This policy describes what happens to your data when you use **ToolsEnabled**
— the local AI agent runtime, its optional hosted relay, and related desktop
tooling described in `docs/design/MONETIZATION-DECISION-R1229.md`. It does
**not** cover other, separately named products (for example, the "AI
Calendar" Chrome extension), which have their own privacy policies. It also
does not cover the internal tooling this company's own engineers and agents
use to build ToolsEnabled — only the product a customer installs and runs.

Every factual claim below was checked directly against the product's source
code on the date above. Where the code did not give a clear answer, that is
stated as an open question instead of a guess. This policy will need to be
re-verified before each release that changes how data moves.

**Who "we" are.** Throughout this policy, "we," "us," and "the Company" mean
**ToolsEnabled, Inc.**, a Delaware corporation, reachable at the addresses in
§11. `<<GATE — entity: publishes as written the moment Delaware accepts the
certificate filed 2026-08-18. Until then the software is provided by its
author personally.>>`

---

## 1. The short version

ToolsEnabled is built to run on your own computer and keep your data there
by default. As of today:

- **There is a ToolsEnabled account, and it never leaves your computer.**
  You create it in the app, with a name you choose and a password. **We do
  not hold it.** There is no server to hold it on: no email address is
  asked for, nothing is transmitted when you create it or sign in, and there
  is no company-side database of users. Your password itself is never
  stored anywhere, in any form that could be turned back into it — what is
  written to your own disk is a scrypt verifier (N=2^17, r=8, p=1, with a
  random per-account salt), and the sign-in that keeps you signed in between
  launches is encrypted by Windows' own protected storage.
  **Two consequences you should know before you make one:** because no
  server holds it, *we cannot reset it for you* — a forgotten password means
  making a new account; and because it lives on your machine, it identifies
  who is using this copy rather than proving who you are to anyone else.
  Its purpose is the audit log in §3: so the record of what your assistant
  did can say who asked for it.
- **We do not run any analytics, telemetry, or crash-reporting service.**
  There is no Sentry, PostHog, Mixpanel, Segment, or similar SDK anywhere in
  the product, and no code that phones home usage statistics. (Re-verified by
  direct source search on 2026-08-12; the product has exactly one runtime
  dependency, Playwright. See §4.)
- **The audit log the product keeps of its own actions stays on your
  machine.** It is not uploaded anywhere by us. (See §3.)
- **The product keeps three other stores of your data on your own disk**, and
  an older version of this policy failed to mention any of them: an
  **encrypted credential vault** that can hold API keys, sign-in tokens,
  passwords and — if you choose to save one — **a full payment card number**
  (§2A); a **browser profile**, which is a real Chrome profile holding
  cookies, history and saved logins for the sites your agent visits (§2B);
  and a **spend ledger** recording amounts and purposes of purchases (§2C).
  All three stay on your machine. None is uploaded by us.
- **The local software talks to no server of ours.** If you choose to create
  an account, our hosted service holds a small record about you — your email,
  a hash of your password, which computers you enrolled and what you named
  them, your acceptance of these documents, and nothing else. That is the one
  place where "everything stays on your computer" stops being true, and §6A
  says exactly what is in it and how you delete it — with a button.
- **What does leave your machine** is what you'd expect from an AI agent
  tool: prompts and file content go to the AI provider (Anthropic, OpenAI,
  Google, or a model you run yourself) that *you* configured, using *your*
  account. Full detail in §2.
- **Cloud Mirror is an optional, explicit-opt-in feature.** If you enable it,
  the product publishes only the classified, tracked snapshot you selected to
  the exact private GitHub repository you selected. Public repositories are
  refused. Full detail in §2.d.

If any of this changes — the hosted relay actually ships, telemetry gets
added, the local account above becomes a *hosted* account we hold — this
policy must be rewritten to match before that feature ships, not after. That
rule has already been broken once: the vault, the browser profile and the
paid-side record in §7 all existed before this policy described them, which
is why the 2026-08-12 re-verification at the top of this document exists.

---

## 2. What leaves your machine, and to whom

ToolsEnabled's core job is running AI agents, which means sending your
prompts, instructions, and (when you give an agent file access) file
contents to an AI model. That is inherent to the product working at all, not
a hidden data flow. Today there are four distinct paths, verified directly
against the code:

### 2.a Provider CLIs you already have installed (Claude Code, Codex, Gemini CLI)

For most agent work, ToolsEnabled does not talk to Anthropic, OpenAI, or
Google itself. It launches the CLI tool you already have installed
(`claude`, `codex`, `gemini`) as a subprocess and lets *that* tool
communicate with its provider, using *your* login — a subscription sign-in
or an API key you provide, not a key we hold. The code that launches these
subprocesses (`src/lib/providers/cli-provider-gateway.js`) actively strips
ambient provider API-key environment variables before handing control to the
CLI, specifically so the CLI is forced to use your own account rather than
some other key. **We do not see or store the content of these
conversations**; it passes from your machine to the provider you chose, under
the account you chose, under that provider's own privacy terms — not ours.

### 2.b A local model on your own network (Ollama)

One code path (`src/lib/providers/model.js`) talks to a local Ollama
instance for certain "quick" completions. Its address comes only from the
installation's private `config/machines.profile.json`; no personal address is
shipped in the product. With no peer configured, local-model use is unavailable.
With exactly one peer, that peer is the local-model host. If several peers are
configured, local-model requests refuse as ambiguous because the current
settings schema has no explicit GPU-peer selector. These requests stay on the
user-configured network path and are not sent to a ToolsEnabled-operated model
service.

### 2.c Google Vertex AI, using an account we operate

A smaller set of backend features (advisory/report generation —
`src/lib/providers/vertex-gemini.js` and its sibling files) make direct
HTTPS calls to Google's Vertex AI API. Unlike §2.a, these calls use **our
own operator Google Cloud account and credentials**, not an account you
configure. Prompt text is sent to Google under our account and is subject to
Google's Vertex AI terms and data-handling policies as the operator's
customer.

**Open question, flagged rather than guessed at:** it is not fully clear
from the code alone whether this path ever carries a paying customer's
prompts (as opposed to being purely an internal/operator-facing report
generator). Before this policy is finalized, someone who knows the product
roadmap needs to confirm: does any customer-facing feature route through
this operator-owned Vertex path? If yes, this section needs to say plainly
"this feature sends your prompt through our Google Cloud account," which is
a meaningfully different privacy fact than "your prompt goes to the account
you configured" (§2.a).

A content filter (`containsSensitiveMaterial`) runs before certain requests
in paths 2.b and 2.c to block prompts that look like they contain credentials
or session tokens — a safety net, not a guarantee that no sensitive content
is ever sent.

### 2.d Optional Cloud Mirror to your private GitHub repository

Cloud Mirror is disabled until you explicitly register it for a project. During
registration, each customer must create or supply a dedicated private GitHub
repository in an account they control and configure that exact GitHub
`owner/repository` destination. ToolsEnabled supplies no repository: there is
no ToolsEnabled-owned or default repository, no preconfigured repository name,
and no fallback destination. The product verifies the exact configured
destination and refuses a public repository; there is no public-repository
override.

When you publish, the feature sends a tracked source snapshot to the selected
private repository. The snapshot contains only files classified for mirroring
by the project's boundary manifest, plus Git tree and commit metadata needed to
represent and verify that snapshot. Those source files and metadata leave your
machine and are then stored by GitHub under the selected account. GitHub's
privacy, security, and retention terms apply, including any repository or
account retention controls you configure there. ToolsEnabled does not operate
that repository or receive a separate copy.

The product also keeps local Cloud Mirror state: a registry recording the
project, source root, exact repository and branch binding, boundary manifest,
and privacy-verification time, plus publication receipts and bounded receipt
history used to prove freshness. This state remains on your machine. Disabling
a binding marks it disabled and removes its local publication receipt; it does
not delete or alter data already stored in the GitHub repository.

### 2.e What we did not find

We did not find any code path where ToolsEnabled itself relays your prompts,
file contents, or conversation history to a server operated by us for any
purpose other than what's described in §2.c. There is no general-purpose
"send usage data to ToolsEnabled" call anywhere in the product.

---

## 2A. The credential vault — including, if you save one, your card number

**New in the 2026-08-12 revision. This section did not exist before, and the
product has had a vault the whole time.**

ToolsEnabled stores the credentials it needs in an encrypted file on your own
computer.

**Where it is.** `vault/secrets.json` inside the product's data folder. On a
normal install that is
`%APPDATA%\ToolsEnabled\capability\vault\secrets.json`.

**How it is protected.** With Windows' own Data Protection API (DPAPI), tied
to your Windows sign-in. There is no separate password and no key file of our
own: Windows holds the key material, and a copy of the file taken to another
machine or opened under another Windows account cannot be decrypted. The
folder's permissions are set explicitly so that only your Windows account,
`SYSTEM`, and Administrators can open it. (An earlier version inherited
permissions that made the vault readable by any account on the machine; that
was found and fixed. We are telling you because it happened.)

**What can go in it.** Whatever you connect: AI-provider API keys, Google and
Chrome Web Store OAuth tokens, a GitHub
token, search-service keys, hosting-provider tokens, payment-provider API
keys, and — for a couple of sites — an actual website password you asked it
to keep.

**Two entries need saying out loud, because most people would not guess a
developer tool holds them:**

- **A full payment card.** If you use the feature that saves a card, what is
  written to the vault is the cardholder name, the card number and expiry
  date, plus a billing postal code. **The card's security code (CVC/CVV) is
  never stored** — the product asks for it at the moment of a spend and
  discards it. This is a hard rule of the payment-card industry standard, not
  a preference: the security code is the one card element that may never be
  persisted, anywhere, by anyone. This is not a
  token, not the last four digits — it is the card. It never leaves your
  machine: it is written by a local dialog, it is on a deny-list that stops
  any agent, log, report, or tool response from ever reading it back, and
  **no code in the product currently uses it for anything.** The part that
  would spend it has not been built. You should still know it is there.

- **A legal name.** If you use the identity feature, your given and family
  name are stored in the same vault under the same deny-list.

**Does it leave your machine?** The file does not. There is no backup, sync,
or export of it, by us or by anything in the product. But the *credentials
inside it are used for their purpose* — an API key in the vault is what gets
attached to a request to that provider, which is the entire point of saving
it. So the effect of a key leaves your machine whenever you use the thing it
unlocks.

**Every read is logged.** Each time a secret is fetched, listed, or checked
for existence, a line is appended to `secrets.json.access.log` recording
**which key and what action — never the value**.

**What you can delete.** Secrets can be deleted **one key at a time**. There
is **no "empty the vault" command**, and no export. See §8, which is honest
about this rather than promising otherwise.

---

## 2B. The browser profile — cookies, history, and saved logins, on your disk

**New in the 2026-08-12 revision.**

When ToolsEnabled drives a browser for you, it does not use your everyday
Chrome. It launches Chrome against a **separate profile of its own**, and
that profile is a real, ordinary Chrome profile directory that persists
between runs.

**Where it is.** `profiles/chrome` in the product's data folder — on a normal
install, `%APPDATA%\ToolsEnabled\capability\profiles\chrome`.

**What accumulates in it.** Exactly what accumulates in any Chrome profile,
for whatever sites your agent visits: **cookies and logged-in sessions**
(`Default\Network\Cookies`), **browsing history** (`Default\History`), **any
passwords Chrome saves** (`Default\Login Data`), site data, cache, favicons,
and extension state. If your agent signs in to a website on your behalf, the
session that keeps it signed in lives here.

**It is kept apart from your own Chrome, deliberately.** The product will only
attach to a browser it launched itself and can prove it owns; it never adopts
or reads the Chrome you use personally, and its cleanup tooling names your
real Chrome profile as a path it must never touch.

**What reaches the AI model.** Page text, screenshots and page structure the
agent asks for do go to the AI provider — that is how browser automation
works. Before any of that is handed over, cookie values, `Authorization`
headers, bearer tokens and credential-shaped URL parameters are stripped out.
That filter protects what is *returned to the model*. It does not change what
Chrome writes to the profile on your disk, which is everything listed above.

**Nothing from this profile is transmitted to us.**

**What you can delete.** The whole folder, by hand. **There is no in-product
"reset browser profile" command.** Deleting the folder signs the agent out of
everything and is safe to do.

---

## 2C. Virtual payment cards and the spend ledger

**New in the 2026-08-12 revision.**

ToolsEnabled can issue **virtual payment cards with spending limits** through
Stripe Issuing, so an agent can be given a card that physically cannot spend
more than a set amount per day.

**What is sent to Stripe** when a card is created: a cardholder name, and
optionally an email address, a phone number, and a full billing address;
then the card's currency, its daily spending limit, and any merchant-country
or category restrictions. Stripe is the card issuer and this information is
handled under Stripe's terms, not ours.

**What is stored on your machine.** Only the trimmed result: the card's Stripe
id, cardholder id, type, status, currency, **the last four digits**, the
expiry month and year, and the spending controls. **The full card number and
CVC are never returned to the product and are never stored** — Stripe does
not hand them over and there is no code anywhere that asks for them.

Do not confuse this with §2A. They are different features: the virtual-card
feature never stores a card number; the vault's "saved card" feature stores a
whole one.

**The spend ledger.** Spending is recorded in a local database,
`state/toolsenabled.sqlite3`. Each row holds a date, a timestamp, an amount,
a purpose, a provider name, and a reference — **no card number, no cardholder
name, no address**. It stays on your machine.

---

## 3. The audit log

ToolsEnabled keeps a local, tamper-evident log of the actions its agents
take (which tool was called, when, with what high-level parameters) so you
can review what an agent did. This log:

- Is stored in a local SQLite database on your own machine
  (`state/audit.sqlite3`), hash-chained and signed with a key held in your
  machine's local secret store. We verified directly that the code writing
  and reading this log (`src/lib/audit-store.js`, `src/lib/audit.js`) makes
  no network calls of any kind.
- **Is not uploaded to us, or to anyone.** There is no off-machine audit
  custody service. If one is ever built it will be opt-in, and this policy
  will be updated first to describe exactly what leaves your machine and
  where it goes.
- Is honestly *not* a tamper-proof vault against every threat. Our own
  engineering documentation states plainly: it is "local tamper evidence,
  not remote WORM storage" — someone with the same level of access as you
  have on your own machine could, in principle, alter both the log and the
  key that signs it. We are repeating that limitation here rather than
  letting a security document say it while a privacy document stays silent.
- **Cannot have single entries removed, and you should know that before you
  ask.** Every entry is hashed together with the one before it and signed, so
  the log is append-only by construction. There is no "delete this event"
  command and there could not be one that worked: removing a row would break
  the chain and the next verification would report it. The only way to erase
  something from the audit log is to **delete the whole log file**, which is
  yours to do and which we tell you how to do in §8. This is a deliberate
  design trade: the log is only worth having because it cannot be quietly
  edited, and that property and selective deletion cannot both be true.

---

## 4. Telemetry, analytics, and crash reports

**We do not currently collect any of these.** Specifically, verified by
direct source-code search across the entire product:

- No analytics or telemetry SDK (Sentry, PostHog, Mixpanel, Segment, or
  similar) exists anywhere in the codebase.
- No code sends usage statistics, feature-usage counts, or behavioral data
  to any server we operate.
- No automatic crash-reporting exists. If the desktop application crashes,
  the planned failure-handling design (`docs/design/INSTALLER-EXPERIENCE.md`)
  copies a diagnostic bundle to your clipboard for **you** to send to
  whoever is helping you — this is a manual, user-initiated action, not
  automatic transmission to us.

**Open question:** the launch gate this product is being built toward
(`docs/coordinator/R1162-MONETIZATION-FINAL-DECISION.md`) explicitly lists
"consented metrics wired" as a requirement before general release. That
means **opt-in** usage metrics are planned but not yet built. When they are
built, this section must be rewritten before that feature ships to describe
exactly what is collected, that it is opt-in, how to turn it off, and how
long it is retained. Nothing in this policy should be read as pre-approving
that future feature's design — it doesn't exist yet.

We also could not confirm from this source tree whether the packaged desktop
application (built from a separate installer checkout, not the engine
repository this policy was verified against) adds any Electron-level crash
reporting. This is flagged as an open item to verify against that other
checkout before publication, not asserted either way.

---

## 5. Licensing data

**Corrected 2026-08-12. The previous version of this section said no tier was
technically enforced. That is no longer true, and the way it became true
matters for your privacy, so it is spelled out.**

A licence is a signed key that is checked **offline**, by Ed25519 signature
against a local revocation list, with **no network call to verify it**. That
part is unchanged.

What changed is *where the check now happens*. There are two places, and
**both of them are on machines we operate, never on yours**:

1. **Admission to the relay we host.** When your machine asks our relay to
   connect it to your other machine, our relay checks the licence before
   accepting.
2. **Admission to your account area on our website.** Same idea, on our web
   server.

**Nothing on your computer checks a licence.** An installation with no licence
does not merely skip the check — it never loads the code that would perform
one. That is enforced by a test that fails the build if any part of the
product outside a short, named list tries to check a licence on its own.

Practically: an unlicensed ToolsEnabled is the complete product, permanently,
and there is no licensing data on your machine at all unless you bought
something.

**Payment details.** Nothing is sold at launch, so there is no payment
relationship and no payment record. If we ever charge for the hosted service,
a payment provider — not us — will collect the card, we will never see or
store the number, and this section and §6A will be rewritten *before* the
first charge.

---

## 6. Our hosted service — free at launch, and running

We operate a service that connects your computers to each other over the
internet without you running a server, and gives you an account area on our
website. **At launch it is free.** The allowance is 2 connected computers and
1 active web session per account, counted only on our side (Terms of Use §1a).
Everything else — the local runtime, direct connections on your own network, a
relay you run yourself, the audit log, the kill switch, the approvals — is
free, permanent, never licence-checked, and never touches our infrastructure.

**On whether our servers can read your traffic.** The relay is built to move
opaque, end-to-end encrypted frames it has no way to open. That is held in
place by a test that reads the relay's own source and fails if it ever tries
to parse a frame, and by a second test asserting no frame content reaches its
logs. What the servers *do* see is described honestly in §6A: who you are
(your email), which of your computers are connected, and when — the metadata a
connection service cannot avoid knowing. Not the content.

**Where it runs.** `<<FACT — engineering names at provisioning: provider +
region, one of the four permitted arrangements in
legal/positions/SERVER-HOSTING-ACCEPTABILITY.md; accounting buys. Publishes
only once named.>>` Backups are encrypted on our server before they leave it
and are held by a **different** provider than the one running the service, for
90 days. Server request logs are kept for 90 days and never contain your
session token or cookies. All of this is a commitment made **before the first
account exists**, in our provisioning runbook, not a description written after
the fact.

Self-hosting the same relay yourself remains free and unlimited — the complete
source is published under the same MIT licence, documentation is provided, and
it is the way to use the product with no account here at all. There is no
support commitment on the free product; see the Terms of Use §5.

---

## 6A. What we keep about you if you create an account

Everything above is about your machine. This section is about ours. Nothing
here applies to you unless you create an account; the software works fully
without one.

**What the account record holds** — checked against the database schema, not
against memory:

- **your email address** — the one thing an account cannot work without, since
  it is how the account is found and how we would ever reach you;
- **a one-way hash of your password** — never the password. We use scrypt with
  a per-account random salt; there is no way to turn the stored value back
  into what you typed;
- **a one-way hash of each active session token** — never the token itself. A
  copy of our database is not a set of live logins;
- **which of your computers are enrolled** through the service, **the name you
  gave each one**, and when each was enrolled or removed. The name is the one
  piece of free text you write that we keep — if you name a machine after
  yourself or your employer, that is what is in our database, so name them how
  you like them seen. We do **not** record when a computer last contacted us;
  a connection does not touch its record;
- **your acceptance of these documents** — which document, which version, a
  fingerprint of its exact text, and when you accepted it. This is the
  evidence that you agreed to what you agreed to, and your account page shows
  it to you. It is deleted with the account;
- **when the account was created**, and whether it has been disabled;
- **if you sign in with Google:** the identifier Google issues for your
  account, so we can match you on your next sign-in. Nothing else from Google
  — no contacts, no mail, no profile beyond the address you already gave us.
  `<<BUILD — paid lane, owner-ruled 2026-08-18: Google sign-in ships at
  launch. The store already has the column, the lookup and the link path
  (`account-store.js` byGoogle / linkGoogle / the CHECK constraint); the OAuth
  route that populates it is the remaining build. This bullet publishes as
  written.>>`

**What it does not hold:** no card, no billing address, no phone, no name
unless your email is one, no record of when your machines connect, no content
of anything your computers say to each other — our servers cannot read that
traffic even in principle. Nothing is sold at launch, so there is no payment
record at all. If we ever charge for the service, this section will be
rewritten *before* the first charge, and the payment provider — not us — will
handle the card.

**How it is stored.** In a database on the server we operate, on an encrypted
disk, backed up encrypted to a second provider for 90 days (§6).

**How long we keep it.** For as long as your account exists. **You can delete
your account, and deletion is real:** the account, its sessions and its
connected-computer records are removed end to end, and the backups do not
resurrect them past the 90-day retention window. This is a commitment we made
before the first account existed and proved against a test account, not a
policy written afterwards. **You delete your account yourself, from your
account page — a button, not a request.** If you cannot reach your account,
email legal@toolsenabled.com from the account's address and we will delete it
for you.

*(The delete button shipped 2026-08-18 — paid lane, `/account/`, confirmation
in place with the record shown before it is destroyed. The BUILD note that
stood here is resolved.)*

**Who else sees it.** `<<FACT — engineering names at provisioning: the
transactional-email provider used for account-verification and sign-in mail
sees your email address; it is listed here as a sub-processor. Publishes only
once named.>>` Our hosting and backup providers hold the encrypted database
and its backups and cannot read either. No one else.

---

## 7. Children's privacy

ToolsEnabled is not directed at children. **The local software** collects
nothing and sends nothing, so there is nothing it could knowingly collect from
a child. **The hosted account** is different: it collects an email address, so
we set an age floor. You must be at least **16** to create an account, and we
do not knowingly keep an account for anyone younger. If you believe a child
has created one, tell us at the address in §11 and we will delete it.

---

## 8. Your data: what you can actually do, and what we cannot do yet

**If you have a hosted account (§6A), you can also delete it, and that
deletion is real and end to end (§6A). Everything else in this section is
about the data on your own machine, which you control completely without
asking us anything.**

**Rewritten 2026-08-12. The previous version said data rights were "trivially
satisfied" because everything is local. That was too comfortable an answer,
and parts of it were wrong. Here is the checked one.**

### 8.1 Where your data is, so you can go and look at it

On a normal install, everything the product writes about you is under one
folder:

```
%APPDATA%\ToolsEnabled\
```

Inside it, the things worth knowing by name:

| What | Where |
|---|---|
| The signed audit log (§3) | `capability\state\audit.sqlite3` |
| General state and the spend ledger (§2C) | `capability\state\toolsenabled.sqlite3` |
| The encrypted credential vault (§2A) | `capability\vault\secrets.json` |
| Who read which secret, and when (§2A) | `capability\vault\secrets.json.access.log` |
| The browser profile: cookies, history, logins (§2B) | `capability\profiles\chrome\` |
| Screenshots the product took | `capability\captures\` |
| Plain-text action logs | `capability\logs\` |
| Your local account and app settings | directly under `%APPDATA%\ToolsEnabled\` |

In a developer checkout the same folders sit inside the checkout instead.

### 8.2 What you can do today — these work

- **Delete everything.** Delete `%APPDATA%\ToolsEnabled`. That removes the
  vault, the audit log, the state database, the browser profile, the
  screenshots, the logs, and your local account. Nothing is held anywhere
  else on your machine, and — unless you created a hosted account — nothing
  is held by us at all. If you did, §6A's delete button removes that too.
- **Delete the browser profile only.** Delete
  `capability\profiles\chrome`. This signs the agent out of every site.
- **Delete one saved credential.** The vault supports deleting a single key.
- **Read your own audit log.** The product can show you recent entries and
  verify that the log has not been altered.
- **Choose what happens to your data when you uninstall.** The installer is
  designed to ask, and to **keep** your data rather than destroy it if it
  cannot ask. *Before this policy is published, someone must confirm that the
  shipped installer actually contains this behaviour* — the code for it was
  read in a separate desktop-shell checkout, not in the engine this policy was
  verified against. Until that is confirmed, do not rely on this bullet.

### 8.3 What is not built — stated plainly, because promising it would be a lie

None of the following exists in the product today. They are not hidden behind
a support request; there is no code that does them.

- **There is no data export.** No command, button, or tool produces a
  portable file containing your data. You can view the most recent audit
  entries, capped, on screen. That is not portability.
- **Your hosted account, if you have one, has a delete button** on your
  account page. It shows you the record — your address, your machines, what
  you agreed to and its fingerprint — before it destroys it, and deletion is
  end to end (§6A). Your *local* account is deleted by deleting files
  (above), because it was never anywhere but on your machine.
- **You cannot delete one entry from the audit log.** See §3: the log is
  hash-chained, so selective deletion is not possible without detection. The
  whole file, or nothing.

**One contradiction we are pointing at ourselves.** The product's own code
lists "reading, exporting, or deleting your own data" among the things a
licence must never be allowed to gate. That is a good commitment and we stand
by it — but export does not exist yet, so today it is a promise that it will
never *cost* anything, not a promise that it *works*. Both halves are true and
you should have both.

### 8.4 What we will do until the software catches up

Until export and deletion are built, a request is handled by a person. Once
there is an address to send it to (§11), we will say what we hold, and we will
delete what we can. We are not stating a response-time commitment here because
we have not agreed one, and an invented number would be worse than none.

### 8.5 Legal rights are not being claimed here

**We are not making a GDPR, UK GDPR, CCPA, or any other compliance claim.**
Those regimes impose specific duties — response deadlines, a defined request
process, a lawful basis, and in some cases a named representative — and
whether they apply to this product, and where, is a question for a lawyer, not
for this document. It is on the approval queue and has not been answered.
Nothing in this section should be read as satisfying any of them.

Note also that this policy describes ToolsEnabled, Inc. (see the top of this
document). `<<GATE — entity: publishes as written the moment Delaware accepts
the certificate filed 2026-08-18. Until then the software is provided by its
author personally.>>`

---

## 9. Security

See `SECURITY.md` for how to report a vulnerability and for the current,
honest state of independent security review (there has not been one yet).

---

## 10. Changes to this policy

We will post updates here with a new "Last updated" date. Material changes —
anything that changes what leaves your machine or who can see it — will be
called out explicitly, not buried in a version bump.

---

## 11. Contact

Privacy questions, data requests, and legal notices: **legal@toolsenabled.com**
Help and abuse reports about the hosted service: **support@toolsenabled.com**
ToolsEnabled, Inc., 16192 Coastal Highway, Lewes, DE 19958 (our registered
agent's office).

---

## Open questions this policy could not resolve from code alone

Collected here so they are not lost inside the sections above:

1. Whether the Vertex AI advisory path (§2.c) ever carries customer prompts
   or is purely an internal/operator tool.
2. How the local-Ollama path (§2.b) is meant to be configured for a
   customer's own machine, versus its current owner-specific wiring.
3. Whether the packaged Electron desktop shell (built from a separate
   installer checkout not covered by this verification pass) adds any crash
   reporting or telemetry not present in the engine repository checked here.
   **The same uncertainty now also covers the uninstall-time data choice in
   §8.2** — that behaviour was read in the desktop-shell checkout and has not
   been confirmed present in a shipped installer.
4. The legal entity name and jurisdiction (§0), pending incorporation.
5. **New, 2026-08-12.** Whether any legal regime (GDPR, UK GDPR, CCPA, or
   another) applies to this product, and therefore what §8 is legally
   required to contain. This is a lawyer's question and no part of this
   document assumes an answer; the question stands for the free hosted
   account and is docketed beside TE-L-0008 as the "global free-account
   privacy floor."
None of these were guessed at above; each is stated as unresolved.
