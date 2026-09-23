import argparse, io, os, sys, re

# Wave one of the 1500-lane program: six swarms x 150 report-only hunt lanes.
# Shape inherited from stamp-hunt-corpus.py, which validated and dispatched
# clean: INVESTIGATOR role, target = the report file, fence = the report file,
# read-only otherwise. Per-lane parametrization is the audited file list; the
# meaningfulness lives in the per-swarm checklist, which cites the measured
# incidents that define each class.

SP = os.path.dirname(os.path.abspath(__file__))
GUARDS = io.open(os.path.join(SP, 'guards.txt'), encoding='utf-8').read().strip()

APP = None
ENGINE = None
PAID = None

def existing_directory(value):
    root = os.path.realpath(os.path.abspath(value))
    if not os.path.isdir(root):
        raise argparse.ArgumentTypeError('directory does not exist: ' + value)
    return root

def parse_args(argv):
    parser = argparse.ArgumentParser(
        description='Generate the wave-one corpus from explicitly selected repositories.')
    parser.add_argument('--app-root', required=True, type=existing_directory,
                        help='root of the ToolsEnabled app repository')
    parser.add_argument('--engine-root', required=True, type=existing_directory,
                        help='root of the ToolsEnabled engine repository')
    parser.add_argument('--paid-root', required=True, type=existing_directory,
                        help='root containing the website and standalone products')
    parser.add_argument('--out-root', type=os.path.abspath,
                        help='output parent (default: CORPUS_OUT or this script directory)')
    return parser.parse_args(argv)

def files_under(root, rels, exts, exclude=()):
    out = []
    for rel in rels:
        base = os.path.join(root, rel)
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            p = os.path.join(base, name)
            if not os.path.isfile(p):
                continue
            if not any(name.endswith(e) for e in exts):
                continue
            if any(x in name for x in exclude):
                continue
            out.append((rel.replace('\\', '/') + '/' + name, os.path.getsize(p)))
    return out

def files_recursive(root, rels, exts, exclude=(), skip_dirs=('node_modules', '.git', 'dist', 'build', 'worktree', 'data', 'drafts', 'originals', 'output', '__pycache__', '.pytest_cache', 'test', 'tests', 'installers')):
    out = []
    seen = set()
    for rel in rels:
        base = os.path.join(root, rel)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in skip_dirs]
            for name in sorted(filenames):
                if not any(name.endswith(e) for e in exts):
                    continue
                if any(x in name for x in exclude):
                    continue
                p2 = os.path.join(dirpath, name)
                relpath = os.path.relpath(p2, root).replace(os.sep, '/')
                if relpath in seen:
                    continue
                seen.add(relpath)
                out.append((relpath, os.path.getsize(p2)))
    return out

def slugify(relpath):
    s = relpath.rsplit('/', 1)[-1]
    for ext in ('.test.mjs', '.mjs', '.cjs', '.js', '.py', '.css', '.html'):
        if s.endswith(ext):
            s = s[: -len(ext)]
            break
    s = re.sub(r'[^A-Za-z0-9]+', '-', s).strip('-').lower()
    return s or 'file'

def group_into_lanes(files, lane_count):
    """files: [(rel, size)] sorted any way. Return exactly lane_count groups
    covering every file: largest files solo, smallest paired/tripled."""
    files = sorted(files, key=lambda t: -t[1])
    n = len(files)
    if n <= lane_count:
        return [[f] for f in files]
    # k lanes carry ceil-groups from the tail so total lanes == lane_count
    lanes = []
    extras = n - lane_count            # how many files must share
    solo = lane_count - extras         # lanes with exactly one file (if extras <= lane_count)
    if extras <= lane_count:
        lanes = [[f] for f in files[:solo]]
        tail = files[solo:]
        # pair them: first half of tail with second half reversed
        half = len(tail) // 2
        for a, b in zip(tail[:half], reversed(tail[half:])):
            lanes.append([a, b])
        if len(tail) % 2:
            lanes[-1].append(tail[half])
    else:
        # distribute round-robin
        lanes = [[] for _ in range(lane_count)]
        for i, f in enumerate(files):
            lanes[i % lane_count].append(f)
    assert len(lanes) <= lane_count, (len(lanes), lane_count)
    assert sum(len(l) for l in lanes) == n
    return lanes

TEMPLATE = """ROLE: INVESTIGATOR — {title}; change nothing.

# Outcome

A written audit report, not a fix. This lane audits ONLY the file(s) named
below, exhaustively, against every class in the checklist. Findings only if
REAL and quoted — a phantom finding wastes a refutation lane, a missed one
ships. Zero findings is an honest and acceptable answer stated with the
evidence of the audit performed.

# Repository and scope

Work from the {repo_desc}
Every path is repository-relative. THIS LANE IS READ-ONLY except for its
report file. You may read ANY file in the repository to establish a producer
contract, an owner module, or a caller — the audit is of the named file(s),
but its evidence may come from anywhere in the tree.

# The file(s) under audit

{targets_block}

Read each named file COMPLETELY before writing anything. When more than one
file is named, audit each fully and keep its findings in its own section.

# The checklist

{checklist}

# Exact writable fence

FENCE:
- {report}
END FENCE

Every other file is read-only. Run no build, no installer, no server, and no
live browser. Running read-only enumeration greps is permitted.

# DONE definition and report

Done means the report carries: the audited file list with each file's line
count as you measured it, every finding with file:line + quoted code +
concrete consequence + the plausible trigger, deliberate-and-documented cases
distinguished from defects (a comment stating why something absorbs a failure
makes it deliberate), a GAPS section naming anything unexamined by name, and
a final line `FINDINGS: <n> real, <m> notes` — zero is honest.

{guards}

CONTRACT/1
role      INVESTIGATOR
target    {report}
do        {do_line}
because   {because}
done      the report states each audited file with its measured line count, every finding with file:line, quoted code, consequence and trigger, distinguishes documented deliberate cases, names every gap, and ends with the FINDINGS count line
report    {report}
"""

APP_DESC = ("app repository as published at mirror ToolsEnabled/app, branch "
            "`cloud-mirror/app` (the source checkout some documents call desktop-app).")
ENGINE_DESC = ("engine repository as published at mirror ToolsEnabled/engine, branch "
               "`cloud-mirror/engine`.")
WEB_DESC = ("website repository as published at mirror ToolsEnabled/Website, branch "
            "`cloud-mirror/website`. The clone root contains `website/`, `server/`, "
            "`deploy/`, `tools/` and `config/` as siblings; resolve every path in "
            "this brief against that clone root.")

SRC_CHECKLIST = """Audit the named file(s) against each class. Each class has bitten this
codebase, measured, within the last two weeks; the DETECT lines in the guards
block below bind the vocabulary/test classes.

1. SWALLOWED FAILURES — empty catch blocks; catches that neither rethrow nor
   surface to a user-visible or logged path; `.catch(() => {})`; optional
   calls (`?.()`) where the surrounding contract requires the thing to exist;
   Promise chains whose rejection has no consumer. Deliberate absorption with
   a comment stating why is NOT a finding.
2. DISPOSAL AND LIFECYCLE — every listener, timer, interval, animation frame,
   observer, or store subscription this file registers, traced to a teardown
   on the surface's own destroy path. Missing teardown, partial teardown, or
   a re-mount that stacks a second registration is a finding. Measured this
   week: four surfaces queued frames and never cancelled them.
3. WIRE CONTRACTS — every field this file reads from a packet, event, IPC
   answer, or JSON record, checked against what the producer actually sends
   (READ THE PRODUCER — you have the whole tree). A field read that nothing
   sends, a field sent that this consumer silently drops, or two outcomes the
   producer distinguishes that this consumer collapses (a kill read as a
   failure was measured this week) are findings.
4. VOCABULARY — user-visible phrases typed as literals where an owner module
   in THIS tree exports the same phrase (find the tree's own copy/vocabulary
   owners first; if the tree has none, say so and mark the class not
   applicable). Strip comments first. Seven retypes were measured and
   repaired in a sibling tree this week; the audit is whether this file
   carries the same shape.
5. RACE AND REENTRY — async handlers that can run twice concurrently against
   shared state; a start/stop pair where stop during start leaves the surface
   claiming the wrong state (measured this week: a session stopped mid-start
   reported the product refused); missing single-flight guards on operations
   the UI can trigger repeatedly.
6. ADDRESS-TRUSTED TRUTH — status files, caches, ports, stamps, or storage
   read as truth without freshness or writer-identity evidence. A leak
   detector excluding rows by BARE PID hid a real leak this week; name what
   else answers by address here.
7. PLATFORM PORTABILITY — path handling that breaks on Windows (separator
   assumptions, POSIX-root checks, split('/') on filesystem input) or spawn
   calls that break with .cmd shims or inherit ambient env a child reads.
8. ACCEPTANCE FENCES — if this file implements any check that admits or
   refuses input (auth, permission, session, eligibility), report what it
   accepts and whether any code path widens it. REPORT ONLY — proposing an
   edit to what a check accepts is out of scope for every lane in this
   program."""

TEST_CHECKLIST = """For EACH named test file, answer the one question that decides whether it is
evidence or decoration: WHAT SUBJECT MUTATION WOULD TURN IT RED, AND WOULD IT?

1. For every test() in the file, name the specific production change (file +
   symbol + the concrete bad value) that the test exists to catch, and judge
   from the assertions whether that change would actually fail it. A test
   whose assertions stay green under its own bad value is VACUOUS — the
   measured class: this week a shipped negative control asserted 45/45 both
   with and without the fix it guarded.
2. Flag assertion shapes true for every value: assert.ok on a truthy constant,
   deepEqual of a thing against itself, regex that matches anything, a match
   against output the test itself constructed rather than observed.
3. Flag swallowed failures inside tests: try/catch that converts a throw into
   a pass, promise rejections never awaited, a helper whose failure exits 0.
4. Flag platform-blind assertions (POSIX-only paths in expected values — the
   class that bit twice this week) and self-arming violations (a skip decided
   by an env var or fixture constant instead of observed product capability).
5. Flag fixture drift: fixtures shaped unlike what the real producer sends
   (this week a fixture carried a `kind` field no producer has ever sent, and
   the surface accepted a shape no real press can deliver).
STATIC ANALYSIS ONLY: judge from the source; do not execute any test — the
fence forbids the writes and servers a run would produce, and a static
judgment is what keeps 150 reports comparable.
For each finding: file, test name, the quoted assertion, the bad value that
slips through, and the smallest strengthening that would catch it (described,
not applied)."""

TOOLS_CHECKLIST = """Audit the named tool(s) as OPERATIONAL code — things people and gates run,
where a wrong answer poisons decisions downstream.

1. EXIT-CODE HONESTY — every failure path must reach a nonzero exit; a caught
   error that prints and exits 0, a skipped step that reports done, or a
   pipeline (`a | b`) hiding a's exit code are findings. Measured this week:
   a release helper's exit-2 path fell through to success.
2. SWALLOWED FAILURES — as in any file: empty catches, `.catch(() => {})`,
   log-only error paths on operations whose callers need the failure.
3. ADDRESS-TRUSTED TRUTH — records read without freshness/writer checks;
   ports probed as identity; stamps trusted without content comparison. A
   gate reading a record only one script writes, while people run the same
   check other ways, is the measured suite-status class.
4. SPAWN AND ENV SEAMS — child processes launched with bare names a planted
   cwd file could shadow; .cmd/.bat shims Node >= 20.12 refuses with
   shell:false; ambient process.env passed wholesale to children that read
   routing/config variables (measured mutating a REAL research draft this
   week); shell:true with interpolated arguments.
5. PLATFORM PORTABILITY — POSIX path assumptions in a Windows-run tool.
6. DESTRUCTIVE-OPERATION GUARDS — any delete, overwrite, reset, or kill:
   does it verify its target first, and can it reach data outside its
   sandbox? A worktree removal deleted through a junction this week; name
   every path here that COULD.
7. REPORT-vs-REALITY — every summary line the tool prints, checked against
   what it measured: a count that includes skips, a "passed" that includes
   not-run, a total derived from a different denominator than displayed.
8. ACCEPTANCE FENCES — if the tool admits/refuses anything (credentials,
   payloads, publishes), report what it accepts; proposing changes to that
   is out of scope."""

PRODUCT_CHECKLIST = """Audit the named product file(s). These ship in standalone desktop products a
customer installs; the classes below were each measured in a sibling product
THIS WEEK, so the audit is whether this file carries the same shapes.

1. FRESH-INSTALL PATHS — any code that reads a file, model, or directory the
   installer does not ship: does it behave when the thing is absent? Measured
   twice this week: a pause control answered HTTP 500 on every fresh install
   because a lock helper reported failure for a file that does not exist yet,
   and a fresh deck rendered zero clickable elements. For every existsSync /
   read of state: name what a customer's first launch actually has.
2. SWALLOWED FAILURES — empty catches, log-only error paths, handlers that
   answer 200 after an internal failure (name any such route), JSON.parse of
   disk/network data without a surfaced failure path, fetch/XHR error paths
   that leave the UI loading forever.
3. WIRE CONTRACTS — fields read vs fields the producer sends, on both sides
   of every HTTP route and IPC seam this file touches. Read the other side.
4. LIFECYCLE — child processes (COM hosts, python engines, doc hosts) traced
   from spawn to verified stop; pid records that outlive the process; locks
   applied on pause and re-applied after writes (the measured re-lock class);
   temp/backup files created and never cleaned.
5. DATA SAFETY — every write path: can it reach a path outside the product's
   own data directory? Ambient env (SUITE_DATA_DIR / SCRIBE_DATA /
   WEB_EDITOR_DATA class) inherited by children; relative roots resolving
   against the source tree (a relative siteRoot edited a TRACKED starter
   this week); backups made before destructive rewrites.
6. ADDRESS-TRUSTED TRUTH — status files, pid records, caches, ports, or
   stamps read as truth without freshness or writer-identity evidence; a
   record only one writer maintains while other paths mutate the state.
7. PLATFORM PORTABILITY — path handling that breaks on Windows (separator
   assumptions, POSIX-root checks, split('/') on filesystem input) and
   spawn calls that inherit ambient env or break on .cmd shims.
8. UI HONESTY — every sentence this file renders about state (saved, paused,
   locked, failed): is it derived from the operation's actual result, or
   assumed? A success message on a fire-and-forget write is the class."""

def because_for(files, extra):
    total_lines = 0
    for rel, _ in files:
        pass
    return extra

def stamp(outdir, project, prefix, repo_desc, lanes, checklist, title_fmt, because_fmt, root_for_lines):
    os.makedirs(outdir, exist_ok=True)
    used = set()
    count = 0
    for lane in lanes:
        rels = [rel for rel, _ in lane]
        slug = slugify(rels[0]) if len(rels) == 1 else slugify(rels[0]) + '-x' + str(len(rels))
        base_slug, n = slug, 2
        while slug in used:
            slug = f'{base_slug}-{n}'; n += 1
        used.add(slug)
        report = f'REPORT-{prefix}-{slug}.md'
        lines = 0
        for rel in rels:
            p = os.path.join(root_for_lines, rel.replace('/', os.sep))
            try:
                lines += sum(1 for _ in io.open(p, encoding='utf-8', errors='replace'))
            except OSError:
                pass
        targets_block = '\n'.join(f'- `{rel}`' for rel in rels)
        title = title_fmt.format(name=rels[0] if len(rels) == 1 else f'{len(rels)} files led by {rels[0]}')
        because = because_fmt.format(count=len(rels), lines=lines)
        do_line = title + ', reporting file:line, quoted code, consequence and trigger for every finding, with named gaps'
        body = TEMPLATE.format(title=title, repo_desc=repo_desc, targets_block=targets_block,
                               checklist=checklist, report=report, guards=GUARDS,
                               do_line=do_line, because=because)
        assert len(body) <= 29000, (slug, len(body))
        name = f'{project}__{prefix}-{slug}.contract'
        io.open(os.path.join(outdir, name), 'w', encoding='utf-8', newline='\n').write(body)
        count += 1
    return count

def main(argv=None):
    global APP, ENGINE, PAID
    args = parse_args(sys.argv[1:] if argv is None else argv)
    APP, ENGINE, PAID = args.app_root, args.engine_root, args.paid_root
    out_base = os.path.join(args.out_root or os.environ.get('CORPUS_OUT', SP), 'wave1')

    # S1: app src, one lane per module (largest solo, smallest paired)
    s1 = files_under(APP, ['src', 'src/views'], ('.js',))
    n = stamp(os.path.join(out_base, 's1-app-src'), 'app', 's1', APP_DESC,
              group_into_lanes(s1, 150), SRC_CHECKLIST,
              'audit {name} against the eight measured defect classes',
              'this lane audits {count} module(s) totalling {lines} lines that have never had a per-module audit, against 8 classes each measured in this tree within 14 days',
              APP)
    print('s1-app-src:', n, 'lanes /', len(s1), 'files')

    # S2: app test-strength, ~3-4 test files per lane
    s2 = files_under(APP, ['tools/test'], ('.test.mjs',))
    n = stamp(os.path.join(out_base, 's2-app-tests'), 'app', 's2', APP_DESC,
              group_into_lanes(s2, 150), TEST_CHECKLIST,
              'judge whether {name} would actually turn red under the bad values they claim to catch',
              'this lane audits {count} test file(s) totalling {lines} lines; a negative control measured this week reported 45/45 with its guarded fix both present and reverted, so green alone proves nothing',
              APP)
    print('s2-app-tests:', n, 'lanes /', len(s2), 'files')

    # S3: engine src, 150 largest
    s3_all = files_under(ENGINE, ['src', 'src/lib'] + ['src/lib/' + d for d in sorted(os.listdir(os.path.join(ENGINE, 'src', 'lib'))) if os.path.isdir(os.path.join(ENGINE, 'src', 'lib', d))], ('.js', '.mjs', '.cjs'))
    s3 = sorted(s3_all, key=lambda t: -t[1])[:150]
    n = stamp(os.path.join(out_base, 's3-engine-src'), 'engine', 's3', ENGINE_DESC,
              [[f] for f in s3], SRC_CHECKLIST,
              'audit {name} against the eight measured defect classes',
              'this lane audits {count} module(s) totalling {lines} lines, selected as the 150 largest of 483 engine source modules, none of which has had a per-module audit',
              ENGINE)
    print('s3-engine-src:', n, 'lanes /', len(s3_all), 'files enumerated')

    # S4: engine tools, all 216 in 150 lanes
    s4 = files_under(ENGINE, ['tools'], ('.js', '.mjs', '.cjs', '.ps1'))
    n = stamp(os.path.join(out_base, 's4-engine-tools'), 'engine', 's4', ENGINE_DESC,
              group_into_lanes(s4, 150), TOOLS_CHECKLIST,
              'audit {name} as operational tooling whose wrong answer poisons downstream decisions',
              'this lane audits {count} tool(s) totalling {lines} lines; 3 gates and tools were measured lying or dying silently in 7 days (an exit-2 falling through to success, a leak detector excluding live rows by reused PID, a harvest reading 404 as no-diff)',
              ENGINE)
    print('s4-engine-tools:', n, 'lanes /', len(s4), 'files')

    # S5: the three standalone products
    s5 = (files_recursive(PAID, ['website/software/presentation-suite'], ('.js',), exclude=('.test.',)) +
          files_recursive(PAID, ['website/software/scribe'], ('.js', '.py'), exclude=('test_', '.test.')) +
          files_recursive(PAID, ['website/software/web-editor'], ('.js',), exclude=('.test.',)) +
          files_recursive(PAID, ['website/software/shared'], ('.js',), exclude=('.test.',)))
    n = stamp(os.path.join(out_base, 's5-products'), 'website', 's5', WEB_DESC,
              group_into_lanes(s5, 150), PRODUCT_CHECKLIST,
              'audit {name} for the fresh-install, data-safety and lifecycle classes measured in the sibling products',
              'this lane audits {count} product file(s) totalling {lines} lines; 3 real defects were measured across these products in 48 hours (a 500 on every fresh install, a deck with zero clickable elements, a test edit landing in a real research draft)',
              PAID)
    print('s5-products:', n, 'lanes /', len(s5), 'files')

    # S5 top-up: the products' own test files, test-strength checklist
    s5t = (files_recursive(PAID, ['website/software/presentation-suite'], ('.test.js',)) +
           files_recursive(PAID, ['website/software/scribe'], ('.js', '.py'), exclude=()) +
           files_recursive(PAID, ['website/software/web-editor'], ('.test.js',)) +
           files_recursive(PAID, ['website/software/shared'], ('.test.js',)))
    s5t = [f for f in s5t if ('.test.' in f[0] or '/test_' in f[0] or f[0].rsplit('/',1)[-1].startswith('test_'))]
    n2 = stamp(os.path.join(out_base, 's5-products'), 'website', 's5t', WEB_DESC,
               group_into_lanes(s5t, 150 - n), TEST_CHECKLIST,
               'judge whether {name} would actually turn red under the bad values they claim to catch',
               'this lane audits {count} product test file(s) totalling {lines} lines; a pause test measured this week passed while the control it guarded answered 500 on every fresh install',
               PAID)
    print('s5-product-tests:', n2, 'lanes /', len(s5t), 'files')

    # S6: website operational surface: server, site tools, testkit, deploy, site js
    s6 = (files_recursive(PAID, ['server'], ('.js', '.mjs')) +
          files_recursive(PAID, ['website/tools'], ('.mjs', '.js')) +
          files_recursive(PAID, ['website/software/testkit'], ('.mjs',), exclude=('.test.',)) +
          files_recursive(PAID, ['deploy'], ('.sh', '.mjs', '.js')) +
          files_under(PAID, ['website/public'], ('.js', '.css')))
    n = stamp(os.path.join(out_base, 's6-website'), 'website', 's6', WEB_DESC,
              group_into_lanes(s6, 150), TOOLS_CHECKLIST,
              'audit {name} as operational website/release code whose wrong answer poisons gates or customers',
              'this lane audits {count} file(s) totalling {lines} lines; the release chain measured 4 instrument defects in 7 days, including a geometry checker whose later sections never ran behind an earlier failure',
              PAID)
    print('s6-website:', n, 'lanes /', len(s6), 'files')

    # S6 top-up: the website's own test files, test-strength checklist
    s6t = (files_recursive(PAID, ['website/tools'], ('.test.mjs',), skip_dirs=('node_modules',)) +
           files_recursive(PAID, ['website/software/testkit'], ('.test.mjs',)) +
           files_recursive(PAID, ['server'], ('.test.js', '.test.mjs')))
    n2 = stamp(os.path.join(out_base, 's6-website'), 'website', 's6t', WEB_DESC,
               group_into_lanes(s6t, 150 - n), TEST_CHECKLIST,
               'judge whether {name} would actually turn red under the bad values they claim to catch',
               'this lane audits {count} website test file(s) totalling {lines} lines; 2 site drivers measured this month asserted a superseded routing law and produced a withdrawn headline finding',
               PAID)
    print('s6-website-tests:', n2, 'lanes /', len(s6t), 'files')

if __name__ == '__main__':
    main()
