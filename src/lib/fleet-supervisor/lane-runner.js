'use strict';

// Spawns one Gemini lane inside an already-created worktree.
//
// This deliberately does NOT reuse tools/gemini-fleet.js's runLane(): that
// function creates its own worktree via a helper that force-removes whatever
// is at the target path first, and the supervisor must never reach a
// force-remove it did not gate. Here the worktree is created and owned by
// src/lib/fleet-supervisor/worktree.js and merely passed in as `cwd`.
//
// The model, approval mode, output format, shell=false and windowsHide=true
// are kept identical to the reviewed gemini-fleet.js launcher so the verified
// Windows executable-resolution fix continues to apply. windowsHide matters
// for a second reason here: this process runs from a non-interactive scheduled
// task and must never put a console on the owner's desktop.
//
// ONE deliberate departure from that launcher (measured failure 2026-07-29,
// logs/fleet-supervisor.log `spawn ENAMETOOLONG` planning Q18/a second project): the
// brief NEVER travels on argv. Windows CreateProcess caps the assembled
// command line at ~32K chars, and a brief embeds a BUILD-QUEUE phase body
// verbatim, so `--prompt <brief>` made spawn itself throw for exactly the
// largest phases -- which then silently lost decomposition, the place
// decomposition matters most. The brief is written to a per-lane scratch file
// (same tmpdir convention as the per-lane settings home below) and redirected
// into the child's stdin as a FILE descriptor. gemini-cli's headless path
// reads non-TTY stdin in full and uses it verbatim as the prompt when no
// --prompt flag is present (verified in the installed 0.53.0 bundle:
// packages/cli readStdin() -> `input = stdinData`; headless mode is forced by
// non-TTY stdin/stdout regardless of --prompt). A file, not a pipe: there is
// no writer side to leave undrained and no EPIPE risk if the child dies early.

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runHarnessCommand } = require('./evidence.js');
const { executableFor } = require('../providers/cli-provider-gateway.js');
const { subscriptionLaunchEnvironment } = require('../providers/subscription-launch-env.js');
const { spawnHidden } = require('../proc/hidden-spawn');
const { deleteEnvNames } = require('../env-scrub.js');
const { DEFAULT_LANE_MODEL } = require('./lane-models.js');
const onboarding = require('../agent-onboarding.js');

// ---------------------------------------------------------------------------
// Vertex lane environment (owner order R58: burn the standing Vertex credit)
// ---------------------------------------------------------------------------
// THE CONSTRAINT THAT SHAPES ALL OF THIS: the operator's interactive gemini CLI
// is logged in as their own personal Google account with a PERSISTED
// `security.auth.selectedType = "oauth-personal"` in ~/.gemini/settings.json.
// gemini-cli reads that persisted choice BEFORE it consults
// GOOGLE_GENAI_USE_VERTEXAI, so env vars alone cannot switch a lane to Vertex.
// Rewriting the global file WOULD work and is exactly what must never happen:
// it would silently move the owner's own interactive sessions onto billed
// credit. A workspace-level .gemini/settings.json does NOT override it either
// (security-sensitive settings are excluded from the workspace merge).
//
// The mechanism that DOES work, verified live 2026-07-29 (exit 0, real
// content, stats.models = gemini-2.5-pro, 9565 tokens billed): point
// GEMINI_CLI_HOME at a fresh PER-LANE directory containing only a
// settings.json with selectedType "vertex-ai". That is a genuine user-settings
// layer scoped to one lane process. The global file is never opened for write.
//
// ADC: NO browser `gcloud auth application-default login` is required.
// application_default_credentials.json does not exist on this machine, but
// %APPDATA%/gcloud/legacy_credentials/<account>/adc.json does and is a
// type:"authorized_user" credential -- the exact shape
// GOOGLE_APPLICATION_CREDENTIALS accepts. That file is what the verified probe
// used. If it is ever missing, this module REFUSES the lane rather than
// silently falling back to the owner's subscription.
//
// GEMINI_CLI_TRUST_WORKSPACE=true is what makes a headless lane fail fast with
// a real error instead of hanging on the trusted-folder prompt -- the true
// cause of the historic "gemini-cli hangs on Vertex" misdiagnosis.
// THE BILLED ACCOUNT IS OPERATOR CONFIGURATION, NOT A PRODUCT CONSTANT.
// This was a hardcoded personal Gmail address until 2026-08-13. Two things
// were wrong with that at once: it published the operator's identity with the
// source, and a fork of the published tree would default to looking for HIS
// credential rather than its own -- a lane that cannot work for anybody else.
// It is now read at load time from the environment first, then from
// config/vertex-gemini.json#accountEmail, which is operator-local and is
// classified `excluded` in config/payload-boundary.json, so the value is
// configuration on this machine and absent from a publish.
// There is deliberately NO fallback literal. Unset resolves to null and the
// vertex branch of laneEnvironment() REFUSES -- the same fail-closed shape this
// module already applies to a missing project id and a missing ADC credential,
// and for the same reason: a lane that silently bills the wrong account is
// worse than a lane that does not run.
const VERTEX_ACCOUNT_CONFIG = path.join(__dirname, '..', '..', '..', 'config', 'vertex-gemini.json');

function configuredVertexAccount(env = process.env, fsImpl = fs) {
  const fromEnv = String(env.TOOLSENABLED_VERTEX_ACCOUNT || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(VERTEX_ACCOUNT_CONFIG, 'utf8'));
    const email = String((parsed && parsed.accountEmail) || '').trim();
    if (email) return email;
  } catch {
    // Absent or unparsable operator config is the UNCONFIGURED case, not a
    // crash. Requiring this module must never throw; the refusal belongs at the
    // point a vertex lane is actually asked for, where it can name the fix.
  }
  return null;
}

const VERTEX_ACCOUNT = configuredVertexAccount();
const VERTEX_LOCATION = 'us-central1';
const LANE_HOME_PREFIX = 'toolsenabled-fleet-lane-home-';

function vertexAdcPath(account = VERTEX_ACCOUNT, env = process.env) {
  if (!env.APPDATA || !account) return null;
  return path.join(env.APPDATA, 'gcloud', 'legacy_credentials', account, 'adc.json');
}

// A per-lane settings home carrying ONLY the auth type. Never the global file.
function createLaneHome(laneId, { tmpdir = os.tmpdir, fsImpl = fs, authType = 'vertex-ai' } = {}) {
  const dir = path.join(tmpdir(), `${LANE_HOME_PREFIX}${laneId}`);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(
    path.join(dir, 'settings.json'),
    `${JSON.stringify({ security: { auth: { selectedType: authType } } }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  return dir;
}

// Build the lane's environment for the chosen backend. Every Vertex/API-key
// shape is stripped first, then only what the selected backend needs is added
// back, so a stale inherited variable can never silently redirect billing.
function laneEnvironment({
  backend = 'subscription',
  laneId,
  project = null,
  location = VERTEX_LOCATION,
  account = VERTEX_ACCOUNT,
  baseEnv = process.env,
  fsImpl = fs,
  tmpdir = os.tmpdir
} = {}) {
  // Start from the cross-provider scrub, not the raw ambient environment. The
  // gemini-only list below never removed ANTHROPIC_API_KEY, so a lane
  // inherited the owner's machine-wide key and any claude CLI it reached
  // billed the API instead of his subscription. The vertex branch below
  // deliberately re-adds the Google routing variables after this point; that
  // is an explicit, audited choice to bill credits, which is exactly why the
  // scrub has to happen first rather than be skipped.
  //
  // The additional gemini/vertex names below were exact-case `delete env[name]`
  // until 2026-08-11 -- a hole reintroduced AFTER the shared scrub had closed
  // it. MEASURED: a parent carrying `google_application_credentials` produced a
  // surviving own key here and a real child that read the canonical name. A
  // scrub that runs first does not protect a list that runs after it.
  const env = deleteEnvNames(subscriptionLaunchEnvironment(baseEnv), [
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_PROJECT_ID',
    'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_CLI_HOME'
  ]);

  if (backend !== 'vertex') {
    // Subscription lane: the owner's already-persisted login is used as-is.
    if (project) env.GOOGLE_CLOUD_PROJECT = project;
    return { env, home: null, billing: { backend: 'subscription', account: null, project: project || null } };
  }

  if (!project) {
    const error = new Error('A vertex lane requires an explicit Google Cloud project id.');
    error.code = 'FLEET_VERTEX_PROJECT_MISSING';
    throw error;
  }
  if (!account) {
    // No configured billing identity. Refuse rather than guess one, for the
    // same reason as the credential check below: guessing bills somebody.
    const error = new Error(
      'A vertex lane requires a configured billing account. Set TOOLSENABLED_VERTEX_ACCOUNT, ' +
      'or accountEmail in config/vertex-gemini.json; refusing to guess an account to bill.'
    );
    error.code = 'FLEET_VERTEX_ACCOUNT_MISSING';
    throw error;
  }
  const adc = vertexAdcPath(account, baseEnv);
  if (!adc || !fsImpl.existsSync(adc)) {
    // Refuse rather than fall back to the subscription: a lane that silently
    // bills the wrong account is worse than a lane that does not run.
    const error = new Error(
      `No gcloud credential found for ${account} at ${adc || '(no APPDATA)'}; refusing to run a vertex lane ` +
      'without the credit account, and refusing to fall back to the subscription.'
    );
    error.code = 'FLEET_VERTEX_CREDENTIALS_MISSING';
    throw error;
  }
  const home = createLaneHome(laneId, { tmpdir, fsImpl });
  env.GEMINI_CLI_HOME = home;
  env.GEMINI_CLI_NO_RELAUNCH = 'true';
  env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
  env.GOOGLE_CLOUD_PROJECT = project;
  env.GOOGLE_CLOUD_LOCATION = location;
  env.GOOGLE_APPLICATION_CREDENTIALS = adc;
  return { env, home, billing: { backend: 'vertex', account, project } };
}

const MODEL = DEFAULT_LANE_MODEL;
const MAX_STDOUT_BYTES = 4_000_000;
const MAX_STDERR_BYTES = 64_000;
const MAX_REPORTED_FILES = 50;

// Per-lane scratch file carrying the brief into the child's stdin (see the
// header: the brief never travels on argv).
const LANE_BRIEF_PREFIX = 'toolsenabled-fleet-lane-brief-';
// Windows CreateProcess rejects command lines near 32,767 chars. With the
// brief off argv this bound is unreachable by construction; the preflight
// below pins that a future flag can never quietly grow argv back toward the
// limit and re-create the ENAMETOOLONG failure.
const MAX_COMMAND_LINE_CHARS = 30_000;

// Result contract: the brief asks every lane to end with `FILES-READ:` /
// `FILES-CHANGED:` lines naming the REAL repo-relative files it used. Parsed
// here so the supervisor can check the named files actually exist in the lane
// worktree -- a mechanical tripwire for the known Gemini failure mode of
// coding against imagined files/schemas. Absence of the lines is recorded as
// contract non-compliance, never invented.
function parseReportedFiles(responseText) {
  const text = String(responseText || '');
  const pick = label => {
    const match = new RegExp(`^${label}:\\s*(.*)$`, 'im').exec(text);
    if (!match) return null;
    const body = match[1].trim();
    if (!body || /^\(none\)$/i.test(body)) return [];
    return body.split(',')
      .map(item => item.trim().replace(/^`|`$/g, ''))
      .filter(item => item && item.length <= 260)
      .slice(0, MAX_REPORTED_FILES);
  };
  const filesRead = pick('FILES-READ');
  const filesChanged = pick('FILES-CHANGED');
  if (filesRead === null && filesChanged === null) return null;
  return { filesRead: filesRead || [], filesChanged: filesChanged || [] };
}

function changedFileCount(cwd, exec = execFileSync) {
  try {
    const out = String(exec('git', ['status', '--porcelain'], {
      cwd, encoding: 'utf8', windowsHide: true, shell: false
    })).trim();
    if (!out) return 0;
    // The lane's own ownership marker is not work product.
    return out.split('\n').filter(line => line.trim() && !line.includes('.toolsenabled-fleet-lane.json')).length;
  } catch {
    // A failed status probe does not establish that the worktree is clean.
    // Preserve the unmeasured state so callers cannot mistake an unavailable
    // git result for a definite zero-change lane.
    return null;
  }
}

function runLane({
  laneId,
  itemId,
  brief,
  cwd,
  timeoutMs = 20 * 60_000,
  cleanupTimeoutMs = 10_000,
  onStart = () => {},
  model = MODEL,
  // Optional dedicated Google Cloud project for CLI quota (the provider's own
  // quota error names GOOGLE_CLOUD_PROJECT as the fix for shared-pool
  // congestion). Never defaulted here -- the supervisor passes it from
  // explicit configuration, and the id is recorded on the lane.
  project = null,
  backend = 'subscription',
  projectRoot = cwd,
  profile = String(laneId || '').startsWith('plan-') ? 'planner' : 'builder',
  role = profile === 'planner' ? 'planner' : 'builder',
  agentId = null,
  tier = null,
  reportsTo = null,
  launchId = null,
  directiveId = /^Q\d{1,3}$/.test(String(itemId || '')) ? itemId : null,
  territory = null,
  buildEnvironment = laneEnvironment,
  buildOnboardingPacket = onboarding.buildOnboardingText,
  onboardingDependencies = {},
  // THE NO-PROVIDER SWITCH (R38). This starts a real gemini CLI process; the
  // packaged-QA fence that is supposed to stop provider spend must reach it
  // the same as codex/claude. See src/lib/proc/hidden-spawn.js.
  spawnImpl = spawnHidden,
  execImpl = execFileSync,
  resolveExecutable = executableFor
} = {}) {
  return new Promise(resolve => {
    if (!cwd || !fs.existsSync(cwd)) {
      return resolve({ ok: false, code: 'WORKTREE_MISSING', detail: String(cwd), changedFileCount: 0 });
    }
    const startedAt = Date.now();
    const { command, prefixArgs } = resolveExecutable('gemini');
    // No --prompt here on purpose: the brief reaches the child through a
    // scratch file on stdin (see the header comment). gemini-cli's headless
    // mode uses the whole of a non-TTY stdin verbatim as the prompt.
    const args = [
      ...prefixArgs,
      '--model', model,
      '--approval-mode', 'auto_edit',
      '--output-format', 'json'
    ];

    let env;
    let billing;
    let laneHome = null;
    try {
      const built = buildEnvironment({ backend, laneId, project });
      env = {
        ...built.env,
        TOOLSENABLED_AGENT_ROLE: role,
        TOOLSENABLED_AGENT_MODEL: model,
        TOOLSENABLED_PROJECT_ROOT: projectRoot,
        TOOLSENABLED_ONBOARDING_PACKET_VERSION: onboarding.PACKET_VERSION,
        TOOLSENABLED_ONBOARDING_LAUNCHER_PROVENANCE: 'launcher-bound'
      };
      if (agentId) env.TOOLSENABLED_AGENT_ID = agentId;
      if (tier) env.TOOLSENABLED_AGENT_TIER = tier;
      if (launchId) env.TOOLSENABLED_LAUNCH_ID = launchId;
      billing = built.billing;
      laneHome = built.home;
    } catch (error) {
      // A billing/credential misconfiguration is a REFUSAL, never a quiet
      // fallback onto the owner's subscription.
      return resolve({
        ok: false,
        code: (error && error.code) || 'LANE_ENV_REFUSED',
        detail: String(error && error.message).slice(0, 300),
        changedFileCount: 0
      });
    }

    const cleanupHome = () => {
      if (!laneHome) return;
      try { fs.rmSync(laneHome, { recursive: true, force: true }); } catch { /* best effort */ }
    };

    let prompt;
    try {
      const packet = buildOnboardingPacket({
        projectRoot,
        scope: 'task',
        profile,
        agentId: agentId || undefined,
        identityBinding: agentId ? 'launcher-bound' : 'none',
        role,
        provider: 'gemini',
        model,
        tier: tier || undefined,
        reportsTo: reportsTo || undefined,
        launchId: launchId || undefined,
        directiveId: directiveId || undefined,
        territory: territory || undefined,
        topic: `${itemId || ''} ${laneId || ''}`.trim()
      }, onboardingDependencies);
      if (typeof packet !== 'string' || !packet.trim()) throw new Error('packet builder returned no context');
      prompt = `${packet.trimEnd()}\n\n${String(brief == null ? '' : brief)}`;
      env.TOOLSENABLED_ONBOARDING_PACKET_HASH = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
    } catch (error) {
      cleanupHome();
      return resolve({
        ok: false,
        code: 'ONBOARDING_FAILED',
        detail: String(error && error.message || error).slice(0, 300),
        changedFileCount: 0
      });
    }

    // The brief goes to a per-lane scratch file, opened read-only and handed
    // to the child as its stdin. NEVER inside the worktree cwd: an untracked
    // brief file there would count as lane work product in changedFileCount.
    const briefFile = path.join(os.tmpdir(), `${LANE_BRIEF_PREFIX}${laneId}.txt`);
    let briefFd = null;
    const closeBriefFd = () => {
      if (briefFd === null) return;
      try { fs.closeSync(briefFd); } catch { /* already closed */ }
      briefFd = null;
    };
    const cleanupBrief = () => {
      closeBriefFd();
      try { fs.rmSync(briefFile, { force: true }); } catch { /* best effort */ }
    };
    try {
      fs.writeFileSync(briefFile, prompt, { encoding: 'utf8', mode: 0o600 });
      briefFd = fs.openSync(briefFile, 'r');
    } catch (error) {
      cleanupHome();
      cleanupBrief();
      return resolve({ ok: false, code: 'BRIEF_FILE_FAILED', detail: String(error && error.message).slice(0, 300), changedFileCount: 0 });
    }

    // Preflight: with the brief off argv this can only trip if argv itself is
    // grown -- refuse HERE, loudly, instead of letting Windows CreateProcess
    // throw ENAMETOOLONG at spawn time again.
    const commandLineChars = [command, ...args].join(' ').length;
    if (commandLineChars > MAX_COMMAND_LINE_CHARS) {
      cleanupHome();
      cleanupBrief();
      return resolve({
        ok: false,
        code: 'COMMAND_LINE_TOO_LONG',
        detail: `assembled command line is ${commandLineChars} chars (cap ${MAX_COMMAND_LINE_CHARS}); the brief already travels via the stdin file, so argv must stay small`,
        changedFileCount: 0
      });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      // The per-lane settings home holds no secret (only an auth-type string),
      // but it is per-lane scratch and must not accumulate across a long run.
      // Confirmed cleanup includes both native scope and wrapper closure;
      // unknown custody remains explicit in the shared runner's outcome.
      // The brief stays a readonly file throughout that lifetime.
      const custodyUnknown = result.code === 'CLEANUP_UNPROVEN';
      if (!custodyUnknown) {
        cleanupHome();
        cleanupBrief();
      }
      resolve({
        laneId,
        itemId,
        durationMs: Date.now() - startedAt,
        changedFileCount: custodyUnknown ? null : changedFileCount(cwd, execImpl),
        ...(custodyUnknown ? { retainedScratch: { briefFile, laneHome } } : {}),
        // Which account/product actually paid for this lane. Recorded so
        // credit burn is measurable rather than inferred afterwards.
        billing,
        ...result
      });
    };

    // Share the existing owned-scope timeout and closure proof, while keeping
    // the lane's measured file-descriptor input contract. Both native wrappers
    // duplicate this open file before returning; no writer pipe is introduced.
    runHarnessCommand({ executable: command, args }, {
      workspace: cwd, timeoutMs, cleanupTimeoutMs, env,
      spawnImpl(file, argv, options) {
        let child;
        // SPAWN-ALLOWLIST: forwards the harness's own options, which already carry
        // windowsHide: true (fleet-supervisor/evidence.js:226) over a spawnImpl that
        // defaults to spawnHidden (:214). Only stdio is overridden here, to keep the
        // lane's measured file-descriptor input contract. Stating the flag again
        // would let this line disagree with the harness that owns it.
        try { child = spawnImpl(file, argv, { ...options, stdio: [briefFd, 'pipe', 'pipe'] }); }
        finally { closeBriefFd(); }
        if (Number.isSafeInteger(child.pid)) {
          const started = () => {
            if (settled) return;
            // The retained scope PID remains useful for supervisor liveness,
            // but wrapper creation alone is not evidence that a lane began.
            try { onStart(child.pid, { pidKind: child.jobReady ? 'native-wrapper' : 'process' }); }
            catch { /* reporting must never kill the lane */ }
          };
          if (child.jobReady && typeof child.jobReady.then === 'function') {
            Promise.resolve(child.jobReady).then(started, () => {});
          } else started();
        }
        if (child.stdout) {
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', chunk => { if (!settled && stdout.length < MAX_STDOUT_BYTES) stdout += chunk; });
        }
        if (child.stderr) {
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', chunk => { if (!settled && stderr.length < MAX_STDERR_BYTES) stderr += chunk; });
        }
        return child;
      }
    }).then(run => {
      if (!run.ran) {
        return finish({ ok: false, code: run.code, cleanupConfirmed: run.cleanupConfirmed === true,
          detail: run.code === 'TIMEOUT' ? `lane exceeded ${timeoutMs}ms` : run.detail });
      }
      const exitCode = run.exitCode;
      let parsed = null;
      let outputParseFailed = false;
      try { parsed = JSON.parse(stdout); } catch { outputParseFailed = true; }
      let tokens = null;
      let reportedModels = null;
      const models = parsed && parsed.stats && parsed.stats.models;
      if (models) {
        tokens = 0;
        for (const entry of Object.values(models)) {
          const total = entry && entry.tokens && entry.tokens.total;
          if (Number.isFinite(total)) tokens += total;
        }
        // Invocation-level diagnostic only. `stats.models` can reveal that a
        // request was silently downgraded, but it is not an event tied to the
        // producing call. Q57 deliberately does NOT use even a one-element
        // aggregate as a served-model receipt; the supervisor quarantines it
        // until the CLI transport exposes per-producing-call provenance.
        reportedModels = Object.keys(models).slice(0, 8);
      }
      finish({
        // Exit zero only establishes success when the promised JSON envelope
        // can also be read. Otherwise `response: null` would make malformed
        // output indistinguishable from a valid envelope with no response.
        ok: exitCode === 0 && !outputParseFailed,
        code: exitCode !== 0 ? 'EXIT_NONZERO' : outputParseFailed ? 'OUTPUT_INVALID_JSON' : null,
        exitCode,
        cleanupConfirmed: run.cleanupConfirmed === true,
        reportedTokens: tokens,
        reportedModels,
        // The installed CLI JSON result has no provider-signed/per-call model
        // event. Keep this explicit rather than synthesising one from
        // stats.models. A future transport adapter may populate a narrowly
        // typed event only after it is captured from the provider; until then
        // the outcome writer must quarantine the producing-model receipt.
        perCallModelEvidence: null,
        // The model's own reply text, verbatim. Added so a caller that needs
        // more than the FILES-READ/FILES-CHANGED contract lines (the planning
        // pass parses a JSON sub-task list out of this) can reuse this spawn
        // path instead of re-implementing it. Existing callers are unaffected
        // -- this only adds a field.
        response: parsed && typeof parsed.response === 'string' ? parsed.response : null,
        reportedFiles: parseReportedFiles(parsed && parsed.response),
        // stderr can echo file content; keep only a short tail and never log it
        // anywhere a credential could survive.
        detail: exitCode === 0 ? null : stderr.slice(-300)
      });
    }, error => finish({ ok: false, code: 'LANE_LIFETIME_FAILED', cleanupConfirmed: false,
      detail: String(error && error.message || error).slice(0, 300) }));
  });
}

module.exports = {
  LANE_BRIEF_PREFIX,
  MAX_COMMAND_LINE_CHARS,
  MAX_REPORTED_FILES,
  MODEL,
  VERTEX_ACCOUNT,
  VERTEX_LOCATION,
  changedFileCount,
  createLaneHome,
  laneEnvironment,
  parseReportedFiles,
  runLane,
  vertexAdcPath
};
