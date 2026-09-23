# `owner.ledger` package charter

## Purpose

Captures owner words verbatim and provides narrow read-only ledger queries,
including request-scope ids, archive, and merge across the request lifecycle.

## Public API

`src/lib/owner-directive-notification.js`,
`src/lib/request-id.js`, `src/lib/request-version/`; tools:
`tools/ledger-query.js`, `tools/owner-capture.js`, `tools/ledger-archive.js`,
`tools/ledger-merge.js`, `tools/ledger-truth.js`,
`tools/ledger-verbatim-migration.js`, `tools/legacy-dotted-migration.js`,
`tools/owner-scope-proposal.js`; the R-ledger surface behind /Request:
`src/lib/r-ledger.js`, `tools/r-ledger.js`, `tools/r-ledger-check.js`, and
`tools/owner-spool-draft.js`, the one review pass over spooled owner turns.

One ledger, one filing API (owner ruling 2026-09-02).
`src/lib/owner-request-store.js` is the single write path for the person's
requests at every tier -- global, session, tree, thread -- into
`reports/OWNER-REQUEST-LEDGER.json`, with an append-only hash chain in
`state/owner-request-record-events.jsonl`; it also serves the tier reads
agents boot with. `src/lib/r-ledger.js` is a thin adapter over it that keeps
the names every caller already requires. `reports/R-LEDGER.md` and
`state/r-ledger/*.md` are no longer read or written.

`ledger.read` exposes paginated reads of R, T, A and P records, including task
completion and ask answers, without accepting a filesystem path. It is available
at read-only permission levels. Scope/key filters use the same placement fields
as the filing tools; returned records do not grant authority.

History verification covers every ledger family. An explicit owner repair can
call `owner-request-store.recoverHistory({sourceHistoryFile, actor: 'owner'},
options)` for records imported without their journal. Recovery requires both the
record core and its saved event reference to match a preserved chain. It keeps
the source bytes, appends recovery events, and never changes words or statuses.
Subsequent reads verify the preserved evidence as well as the active journal.

A write refuses with `R_LEDGER_CHAIN_APPEND_UNCONFIRMED` when a saved record
names an append the local journal cannot confirm. Restore preserved history
with `recoverHistory` first when authentic evidence is available. When that
history is unavailable, the person can explicitly adopt the current records;
ordinary writes never adopt automatically, including under Basic policy.

The native Ledger page uses
`previewUnconfirmedHistory({actor: 'owner'}, options)` to receive
`{revision, token, count}`, then explicitly confirms with
`adoptUnconfirmedHistory({actor: 'owner', revision, token}, options)`.
The token binds the exact document bytes and journal head/sequence. Adoption
rechecks that snapshot under the write lock and refuses a changed snapshot
with `R_LEDGER_ADOPTION_STALE`. Both operations recompute journal hashes even
under Basic and preserve known append/identity custody checks. They refuse a
broken journal or a lost identity already known to the writer.

Adoption changes custody metadata only: each affected record retains its
words, status and earlier history, then adds an `adopt` history row naming the
unconfirmed reference. The journal uses the existing `edit` envelope with a
hash-covered `operation: 'adopt-unconfirmed-history'` and that reference. It
does not claim the missing history was verified or reconstructed. No new
journal kind or schema version is needed: the frozen pre-adoption reader in
`tests/fixtures/legacy-owner-request-store-pre-adopt.cjs` verifies this journal
and appends normally, under both Basic and verified-history policy.

Both repairs require `actor: 'owner'`. The explicit person-operated CLI remains
`node tools/r-ledger.js recover --from <preserved history>` or
`node tools/r-ledger.js adopt`. The CLI may omit the preview pair; the native
page always supplies it. No agent tool exposes either repair.

## Allowed dependencies

Q46-observed: `agent-comms`, `controller`, `domains.misc`, `fleet`,
`kernel.runtime`, `mission-bridge`, `owner.digest`, `providers.gateway`.

`providers.gateway`: reached only by the spool draft tool, which spends nothing
and calls no model -- it is the launch-environment scrub every child process
here goes through, not a provider call.

`kernel.runtime`: the capture/query/archive/spool tools resolve the ledger's
location through `runtime-state-root.js` instead of each computing a state root.

## Action classes

`RECORD`, `LOCAL-WORK`.

## Must not do

Do not paraphrase away owner intent or write credentials into the ledger.

## Verification

`node tests/ledger-query.js`; `node tests/package-charters.js`.
