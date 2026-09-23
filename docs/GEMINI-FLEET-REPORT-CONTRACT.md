# Gemini fleet report contract

`GeminiReport/v2` is the mandatory semantic-evidence format for a report-only
Gemini lane. A materialized model response is not evidence that the response
is useful, grounded, or attributable to the lane that produced it. v2 is a
bounded transcription of one pre-authorized source line, never a model
summary, test verdict, review, or acceptance conclusion.

`GeminiReport/v1` remains parseable so historic artifacts retain their
transport record, but it is **semantically unverified**. A v1 artifact can
never produce a new accepted lane receipt.

## v2 contract

The lane specification supplies exact source paths, exact deterministic
commands, and one or more evidence anchors. Each anchor has:

- `source`: a listed regular repository file;
- `line`: the one-based logical source-line number; and
- `sha256`: the lowercase SHA-256 of that logical line's UTF-8 bytes, excluding
  its LF or CRLF terminator.

Preflight resolves every source beneath the real repository root, rejects
symlinks/junctions in the component chain, reads the declared line, and rejects
the lane if its hash does not exactly match. It then retains an opaque,
in-process bound contract; a lookalike object is not sufficient for v2 report
materialization.

The final report must contain exactly these six lines, in this order (one final
newline is tolerated):

```text
REPORT-CONTRACT: GeminiReport/v2
ROLE: gemini-report-lane
SOURCES: path/one.js, path/two.md
EVIDENCE-COMMAND: node tests/example.js
EVIDENCE-ANCHOR: source=path/one.js; line=1; sha256=<sha256-of-logical-source-line>
CLAIM: <the exact anchored source line>
```

- `SOURCES` must exactly equal the lane's source list.
- `EVIDENCE-COMMAND` must exactly equal one authorized deterministic
  `node tests/...` command. It records a permitted command; the report is
  never allowed to claim that it passed.
- `EVIDENCE-ANCHOR` must exactly equal one preflight-bound anchor. Wrong path,
  line, or hash is rejected.
- The bytes after `CLAIM: ` must exactly equal the bound logical source line.
  Paraphrase, source-label substitution, extra prose, extra claims, blank
  lines, or formatting drift are rejected. Secret-like output is rejected by
  the report writer before any artifact is materialized.
- `ROLE` is fixed. A report-only Gemini lane cannot claim reviewer,
  coordinator, owner, test, or acceptance authority.

## Migration and receipt boundary

New waves default to v2 and require evidence anchors. A legacy wave may
explicitly declare `version: "GeminiReport/v1"`; its existing structural
format remains transport-valid only and the durable acceptance boundary emits
`R125_REPORT_EVIDENCE_UNVERIFIED` even with an otherwise valid provider
receipt. Do not treat that as a retry or a successful semantic report.

The supervisor loads this document at construction and records its version and
digest in durable supervisor state. The report-wave runner independently loads
the same definition before it accepts a report. Provider model receipts,
secret-like output refusal, one-artifact diff checks, and independent review
remain separate gates.

Each wave specification gets a dedicated `prompts/` directory beside that
specification. A lane names only one plain `*.prompt.txt` filename from that
directory. Absolute paths, separators, dot-segments, missing files, symlinks,
and path escapes are rejected before any worktree or provider process exists.
Lane IDs, item IDs, and destination report names are unique within a wave
before parallel execution begins.

The current CLI exposes only aggregate `stats.models`. That is diagnostic data,
not a per-producing-call served-model receipt, so it cannot make a report wave
accepted. A report may be structurally valid but remains quarantined until a
future runner supplies a genuine Q57-compatible per-call receipt. Each result
therefore emits bounded R122/R125 acceptance or rejection metrics, never
provider text.
