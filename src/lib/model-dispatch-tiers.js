'use strict'

// The native dispatch rows below are extracted unchanged from
// mission-bridge/actions.js. Consumers share their declared classes and
// model-specific efforts; these rows do not establish entitlement or price.
const TIERS = Object.freeze({
  // Codex's gpt-6 line, added 2026-09-07 for the 1.0.42 cut. The id, display
  // name and efforts are transcribed from `model/list` on codex-cli 0.153.4
  // (CODEX-MODEL-CATALOG-20260907.json, measuredAt 2026-09-07T13:33:58.032Z),
  // never guessed from the marketing name. The owner K3 reversal makes the
  // product default `medium`: "default should be medium thats what codex does
  // and we are using their model".
  // `tier: 'premium'` is the DISPATCH class (agent-org.js only accepts
  // cheap/standard/premium) and is not a price claim -- agent-session-observer
  // still reports this model's COST tier as unknown, because no rate card for
  // it has been measured. Those two are different questions on purpose.
  astra: Object.freeze({ kind: 'codex', provider: 'codex', seats: Object.freeze(['astra']), tier: 'premium', model: 'gpt-6-astra', cliModel: 'gpt-6-astra', effort: 'medium' }),
  // gpt-5.6-luna offers no ultra (~/.codex/models_cache.json, codex-cli
  // 0.156.0, 2026-09-25), so its allowed set is listed, as on the narrower
  // Claude rows below; the application offers the same five.
  luna: Object.freeze({ kind: 'codex', provider: 'codex', seats: Object.freeze(['luna']), tier: 'cheap', model: 'gpt-5.6-luna', cliModel: 'gpt-5.6-luna', effort: 'medium', efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) }),
  terra: Object.freeze({ kind: 'codex', provider: 'codex', seats: Object.freeze(['terra']), tier: 'standard', model: 'gpt-5.6-terra', cliModel: 'gpt-5.6-terra', effort: 'high' }),
  sol: Object.freeze({ kind: 'codex', provider: 'codex', seats: Object.freeze(['sol']), tier: 'premium', model: 'gpt-5.6-sol', cliModel: 'gpt-5.6-sol', effort: 'xhigh' }),
  // gpt-6-sol and gpt-6-luna are NOT dispatch tiers in 1.0.48. Each would need
  // a seat of its own, and a saved org overlay (agent-org-store.js read()) is a
  // snapshot that never gains a seat a later config/agent-org.json adds, so
  // every existing installation would refuse the row with
  // BRIDGE_AGENT_DECLARATION_MISSING. The application offers them tree-only.
  'claude-fable': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'cheap', model: 'claude/fable', cliModel: 'fable' }),
  'claude-sonnet': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'standard', model: 'claude/sonnet', cliModel: 'sonnet' }),
  'claude-opus': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'premium', model: 'claude/opus', cliModel: 'opus' }),
  // ONE ROW PER CLAUDE MODEL, added 2026-09-25 for 1.0.48. Owner: "users need
  // to be able to select all the models from the providers ... I need opus5
  // and sonnet5". The three rows above are ALIASES: each runs whatever the
  // installed Claude Code serves for that word (`opus` is Opus 5.5 from CLI
  // 2.1.280 and Opus 5 before it), so Opus 5 could not be reached at all and
  // Sonnet 5 only while `sonnet` still meant it. Their ids stay exactly as
  // they are: signed usage rows, ledgers and continuations hold them.
  //
  // Each row below pins ONE model. The id is the one the Claude Code model
  // catalog served this machine on 2026-09-25
  // (~/.claude/cache/model-catalog/dae081fd-...-cc.json), and every one of
  // them appears in the installed CLI 2.1.283. `cliModel` is that id, handed
  // to the CLI as `--model <id>`. Haiku's catalog id is the dated
  // claude-haiku-4-5-20251001; the row passes the undated name, which is what
  // the CLI's own `haiku` alias resolves to (claude-cli-install.js).
  //
  // `tier` is the DISPATCH class, as on astra: Opus premium, Sonnet standard,
  // Fable and Haiku cheap -- the classes the alias rows already carry.
  //
  // `efforts` is present only where the MODEL offers less than the Claude
  // launcher accepts (tool-registry.js AGENT_SPAWN_EFFORT_BY_PROVIDER): the
  // catalog gives Haiku 4.5 no effort setting at all, and Opus 4.6 and Sonnet
  // 4.6 no xhigh. It is the allowed set, never a default. Like every Claude row
  // these carry no `effort`: the lane passes no --effort and the model's own
  // default applies.
  // Claude Code 2.1.295 model catalog, checked 2026-10-09; existing Claude seat pool.
  'claude-sonnet-5-5': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'standard', model: 'claude/claude-sonnet-5-5', cliModel: 'claude-sonnet-5-5', efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) }),
  'claude-haiku-5-5': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'cheap', model: 'claude/claude-haiku-5-5', cliModel: 'claude-haiku-5-5', efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) }),
  'claude-opus-5-5': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'premium', model: 'claude/claude-opus-5-5', cliModel: 'claude-opus-5-5' }),
  'claude-opus-5': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'premium', model: 'claude/claude-opus-5', cliModel: 'claude-opus-5' }),
  'claude-sonnet-5': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'standard', model: 'claude/claude-sonnet-5', cliModel: 'claude-sonnet-5' }),
  'claude-fable-5-1': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'cheap', model: 'claude/claude-fable-5-1', cliModel: 'claude-fable-5-1' }),
  'claude-fable-5': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'cheap', model: 'claude/claude-fable-5', cliModel: 'claude-fable-5' }),
  'claude-haiku-4-5': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'cheap', model: 'claude/claude-haiku-4-5', cliModel: 'claude-haiku-4-5', efforts: Object.freeze([]) }),
  'claude-opus-4-8': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'premium', model: 'claude/claude-opus-4-8', cliModel: 'claude-opus-4-8' }),
  'claude-opus-4-7': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'premium', model: 'claude/claude-opus-4-7', cliModel: 'claude-opus-4-7' }),
  'claude-opus-4-6': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'premium', model: 'claude/claude-opus-4-6', cliModel: 'claude-opus-4-6', efforts: Object.freeze(['low', 'medium', 'high', 'max']) }),
  'claude-sonnet-4-6': Object.freeze({ kind: 'claude', provider: 'claude', seats: Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4']), tier: 'standard', model: 'claude/claude-sonnet-4-6', cliModel: 'claude-sonnet-4-6', efforts: Object.freeze(['low', 'medium', 'high', 'max']) }),
  // A MODEL ON THE USER'S OWN GPU, IN THE SAME TABLE AS THE PAID ONES.
  //
  // Owner, 2026-08-12: "they should be able to launch a qwen2.5 on their gpu or
  // something as a node, not just claude or codex." Everything above bills
  // somebody. This row does not, which is why it belongs beside them rather than
  // in a separate "advanced/self-hosted" corner -- the free path is the product,
  // not a consolation.
  //
  // `cliModel: null` is load-bearing, not an omission. A local node has no
  // vendor CLI and no API key; every column here that assumes a credentialed
  // provider is deliberately empty, and the code paths below tolerate that. The
  // concrete model is NOT pinned here because it depends on what the user has
  // pulled -- local-node-runtime.js resolves it at dispatch and refuses honestly
  // if nothing is installed.
  //
  // FOUR SEATS OF ITS OWN. The presence registry refuses a second live lane per
  // identity, so borrowing the claude-* seats would have made a local node and a
  // Claude worker mutually exclusive on the same machine -- the machine most
  // likely to be running several local lanes precisely because they are free.
  local: Object.freeze({ kind: 'local', provider: 'local', seats: Object.freeze(['local-node-1', 'local-node-2', 'local-node-3', 'local-node-4']), tier: 'cheap', model: 'local/auto', cliModel: null })
});

const TREE_ONLY_SPAWN_TIERS = Object.freeze({
  // Codex CLI models_cache.json, checked 2026-10-09; no new dispatch seat.
  'gpt-6.1-sol': Object.freeze({ provider: 'codex', model: 'gpt-6.1-sol', cliModel: 'gpt-6.1-sol',
    efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) }),
  'gpt-6-luna': Object.freeze({ provider: 'codex', model: 'gpt-6-luna', cliModel: 'gpt-6-luna',
    efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) })
});
const NATIVE_MODEL_CAP_TIERS = Object.freeze({ ...TIERS, ...TREE_ONLY_SPAWN_TIERS });

function selectionError(code, message) {
  throw Object.assign(new Error(message), { code })
}
const MAX_MODEL_ID_LENGTH = 2048;

function validateNativeModelId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MODEL_ID_LENGTH
      || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    selectionError('AGENT_MODEL_INVALID', 'A native model must be a non-blank identifier of at most 2048 characters without control characters.')
  }
  return value
}
function nativeClient(row) {
  return row?.client === 'native-cli' || row?.client === 'native-local' ? null : row?.client || null
}
function knownNativeRows(model, provider, client, tiers) {
  return Object.values(tiers).filter(row => row && row.provider === provider && nativeClient(row) === client
    && (row.model === model || row.cliModel === model))
}
function validateNativeModelEffort(model, effort, { provider, client = null, tiers = NATIVE_MODEL_CAP_TIERS } = {}) {
  const rows = knownNativeRows(validateNativeModelId(model), provider, client, tiers);
  const selectedEffort = provider === 'claude' && effort === 'ultra' ? 'max' : effort;
  if (selectedEffort != null && rows.some(row => Array.isArray(row.efforts) && !row.efforts.includes(selectedEffort))) {
    selectionError('AGENT_MODEL_EFFORT_UNSUPPORTED', 'The chosen native model does not support the configured effort. Choose a supported effort explicitly.');
  }
  return effort;
}
function declaredClass(rows, classOrder) {
  const classes = new Set(rows.map(row => row.tier).filter(value => typeof value === 'string'))
  if (classes.size !== 1) return null
  const value = [...classes][0]
  return Array.isArray(classOrder) && classOrder.includes(value) ? value : null
}
function resolveNativeModelSelection({ base, model, provider = base?.provider, client = nativeClient(base),
    effort, tiers = TIERS, classOrder } = {}) {
  const exactModel = validateNativeModelId(model)
  const selectedRows = knownNativeRows(exactModel, provider, client, tiers)
  const baseRows = typeof base?.model === 'string' ? knownNativeRows(base.model, provider, client, tiers) : []
  const declaredRows = [...baseRows, ...selectedRows].filter(row => typeof row.tier === 'string')
  if (declaredRows.length && (!Array.isArray(classOrder) || declaredRows.some(row => !classOrder.includes(row.tier)))) {
    selectionError('AGENT_MODEL_CAP_METADATA_UNAVAILABLE', 'The installed engine cannot verify the declared native model classes.')
  }
  const baseClass = typeof base?.tier === 'string' && classOrder?.includes(base.tier)
    ? base.tier : declaredClass(baseRows, classOrder)
  const selectedClass = declaredClass(selectedRows, classOrder)
  if (baseClass !== null && selectedClass !== null
      && classOrder.indexOf(selectedClass) > classOrder.indexOf(baseClass)) {
    selectionError('AGENT_MODEL_TIER_CAP_EXCEEDED', 'The chosen native model exceeds the approved base dispatch class. Choose a model within that class or approve a different base tier.')
  }
  const effortRows = selectedRows.filter(row => Array.isArray(row.efforts))
  validateNativeModelEffort(exactModel, effort, { provider, client, tiers });
  return Object.freeze({ model: exactModel, provider, client, baseClass, selectedClass,
    known: selectedRows.length > 0,
    efforts: effortRows.length ? Object.freeze(effortRows[0].efforts.filter(value => effortRows.every(row => row.efforts.includes(value)))) : null })
}

const NATIVE_START_TIERS = Object.freeze({
    'agy-gemini-3-8-flash-high': { provider: 'gemini', client: 'antigravity', model: 'gemini/antigravity/gemini-3.8-flash-high', effort: 'high' },
    'agy-gemini-3-8-flash-medium': { provider: 'gemini', client: 'antigravity', model: 'gemini/antigravity/gemini-3.8-flash-medium', effort: 'medium' },
    'agy-gemini-3-8-flash-low': { provider: 'gemini', client: 'antigravity', model: 'gemini/antigravity/gemini-3.8-flash-low', effort: 'low' },
    'agy-gemini-3-7-flash-high': { provider: 'gemini', client: 'antigravity', model: 'gemini/antigravity/gemini-3.7-flash-high', effort: 'high' },
    'agy-gemini-3-7-flash-medium': { provider: 'gemini', client: 'antigravity', model: 'gemini/antigravity/gemini-3.7-flash-medium', effort: 'medium' },
    'agy-gemini-3-7-flash-low': { provider: 'gemini', client: 'antigravity', model: 'gemini/antigravity/gemini-3.7-flash-low', effort: 'low' },
    'agy-gemini-3-6-flash-high': { provider: 'gemini', client: 'antigravity', model: 'gemini/antigravity/gemini-3.6-flash-high', effort: 'high' },
    'agy-gemini-3-6-flash-medium': { provider: 'gemini', client: 'antigravity', model: 'gemini/antigravity/gemini-3.6-flash-medium', effort: 'medium' },
    'agy-gemini-3-6-flash-low': { provider: 'gemini', client: 'antigravity', model: 'gemini/antigravity/gemini-3.6-flash-low', effort: 'low' },
    'agy-gemini-3-1-pro-high': { provider: 'gemini', client: 'antigravity', model: 'gemini/antigravity/gemini-3.1-pro-high', effort: 'high' },
    'agy-gemini-3-1-pro-low': { provider: 'gemini', client: 'antigravity', model: 'gemini/antigravity/gemini-3.1-pro-low', effort: 'low' },
    gemini: { provider: 'gemini', model: 'gemini/auto' },
    'gemini-3-1-pro': { provider: 'gemini', model: 'gemini/gemini-3.1-pro-preview' },
    'gemini-3-flash': { provider: 'gemini', model: 'gemini/gemini-3-flash-preview' },
    'gemini-3-1-flash-lite': { provider: 'gemini', model: 'gemini/gemini-3.1-flash-lite' },
    'gemini-2-5-pro': { provider: 'gemini', model: 'gemini/gemini-2.5-pro' },
    'gemini-2-5-flash': { provider: 'gemini', model: 'gemini/gemini-2.5-flash' },
    grok: { provider: 'grok', model: 'grok/auto' },
    'grok-4-6': { provider: 'grok', model: 'grok/grok-4.6', effort: 'xhigh' },
    'grok-4-5': { provider: 'grok', model: 'grok/grok-4.5' },
    astra: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' },
    'gpt-6-sol': { provider: 'codex', model: 'gpt-6-sol', effort: 'medium' },
    'gpt-6-luna': { provider: 'codex', model: 'gpt-6-luna', effort: 'medium' },
    'gpt-6.1-sol': { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
    luna: { provider: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
    terra: { provider: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
    sol: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
    'claude-fable': { provider: 'claude', model: 'claude/fable' },
    'claude-sonnet': { provider: 'claude', model: 'claude/sonnet' },
    'claude-opus': { provider: 'claude', model: 'claude/opus' },
    'claude-opus-5-5': { provider: 'claude', model: 'claude/claude-opus-5-5' },
    'claude-opus-5': { provider: 'claude', model: 'claude/claude-opus-5' },
    'claude-sonnet-5': { provider: 'claude', model: 'claude/claude-sonnet-5' },
    'claude-sonnet-5-5': { provider: 'claude', model: 'claude/claude-sonnet-5-5' },
    'claude-haiku-5-5': { provider: 'claude', model: 'claude/claude-haiku-5-5' },
    'claude-fable-5-1': { provider: 'claude', model: 'claude/claude-fable-5-1' },
    'claude-fable-5': { provider: 'claude', model: 'claude/claude-fable-5' },
    'claude-haiku-4-5': { provider: 'claude', model: 'claude/claude-haiku-4-5' },
    'claude-opus-4-8': { provider: 'claude', model: 'claude/claude-opus-4-8' },
    'claude-opus-4-7': { provider: 'claude', model: 'claude/claude-opus-4-7' },
    'claude-opus-4-6': { provider: 'claude', model: 'claude/claude-opus-4-6' },
    'claude-sonnet-4-6': { provider: 'claude', model: 'claude/claude-sonnet-4-6' },
    /* A model on this computer, gated exactly like the claude rows: it opens
       when the payload carries src/lib/agent-engine/local-node-process.js
       (see loadLocalEngine()) and is refused by name when it does not. The
       engine resolves the concrete model at start from the person's own
       model.* settings or from what the runtime holds; `local/auto` is the
       word for that, and a session this host cannot actually start must
       still refuse rather than silently start Codex instead. */
    local: { provider: 'local', model: 'local/auto' },
  })

function nativeModelForDescriptor(model, { provider, client = null } = {}, tiers = NATIVE_START_TIERS) {
  if (model === undefined || model === null) return null
  const declared = Object.values(tiers).find(row => row.provider === provider
    && (row.client || null) === client && row.model === model)
  if (!declared) return model
  const prefix = client ? `${provider}/${client}/` : `${provider}/`
  if (!client && model === `${provider}/auto`) return null
  return typeof model === 'string' && model.startsWith(prefix) ? model.slice(prefix.length) : model
}

module.exports = { TIERS, TREE_ONLY_SPAWN_TIERS, MAX_MODEL_ID_LENGTH, validateNativeModelId, validateNativeModelEffort, resolveNativeModelSelection, NATIVE_START_TIERS, nativeModelForDescriptor }
