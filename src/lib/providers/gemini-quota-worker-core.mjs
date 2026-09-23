import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { unavailable, validEmail, plain } = require('./gemini-quota-protocol.js');

const retiredClientTier = tier => tier?.reasonCode === 'UNSUPPORTED_CLIENT'
  || typeof tier?.reasonMessage === 'string' && /client is no longer supported/i.test(tier.reasonMessage);

export async function readGeminiQuota(sdk, { home, cwd, id, project = null }) {
  const { Config, AuthType, getOauthClient, CodeAssistServer } = sdk;
  const config = new Config({ sessionId: id, cwd, targetDir: cwd, model: 'gemini-2.5-pro', debugMode: false,
    noBrowser: true, interactive: false, telemetry: { enabled: false, logPrompts: false },
    usageStatisticsEnabled: false, enableHooks: false, enableHooksUI: false,
    enableAgents: false, mcpEnabled: false, extensionsEnabled: false,
    enableInteractiveShell: false, coreTools: [], allowedTools: [], mcpServers: {},
    fileFiltering: { enableFileWatcher: false, enableRecursiveFileSearch: false, enableFuzzySearch: false },
    adk: { agentSessionNoninteractiveEnabled: false, agentSessionInteractiveEnabled: false }
  });
  let client;
  try { client = await getOauthClient(AuthType.LOGIN_WITH_GOOGLE, config); }
  catch { return unavailable('GEMINI_CACHED_AUTH_UNAVAILABLE'); }
  // Cached google_accounts.json can describe a previous sign-in. Query the
  // current authenticated client; never use the cached label as identity proof.
  let email = null;
  try {
    const response = await client.request({ url: 'https://www.googleapis.com/oauth2/v2/userinfo', method: 'GET' });
    if (validEmail(response?.data?.email)) email = response.data.email;
  } catch { /* Quota remains current, but a pinned identity cannot be proved. */ }
  // A later quota/service failure does not undo a successful authenticated
  // userinfo request. Eligibility/project refusals remain distinct outcomes.
  const quotaUnavailable = code => unavailable(code, email);
  const server = new CodeAssistServer(client, project, {}, id, undefined, undefined, undefined, config);
  let loaded;
  try { loaded = await server.loadCodeAssist({ mode: 'HEALTH_CHECK',
    ...(project ? { cloudaicompanionProject: project } : {}),
    metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI',
      ...(project ? { duetProject: project } : {}) } }); }
  catch { return quotaUnavailable('GEMINI_SERVICE_UNAVAILABLE'); }
  if (loaded?.ineligibleTiers?.some(tier => tier?.reasonCode === 'VALIDATION_REQUIRED')) return quotaUnavailable('GEMINI_VALIDATION_REQUIRED');
  // Google stopped serving individual accounts through Gemini CLI on
  // 2026-06-18 (github.com/google-gemini/gemini-cli/discussions/28017) and says
  // so as an ineligible tier. An account that still has a tier and a project
  // (a Code Assist licence) keeps serving; only one without them is retired.
  if (!(loaded?.currentTier && (loaded.cloudaicompanionProject || project))
    && loaded?.ineligibleTiers?.some(retiredClientTier)) return quotaUnavailable('GEMINI_CLIENT_RETIRED');
  if (!loaded?.currentTier || loaded.currentTier.hasAcceptedTos === false) return quotaUnavailable('GEMINI_NOT_PROVISIONED');
  const selectedProject = loaded.cloudaicompanionProject || project;
  if (typeof selectedProject !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(selectedProject)) return quotaUnavailable('GEMINI_PROJECT_UNAVAILABLE');
  if (project && selectedProject !== project) return quotaUnavailable('GEMINI_PROJECT_CHANGED');
  let quota;
  try { quota = await server.retrieveUserQuota({ project: selectedProject }); }
  catch { return quotaUnavailable('GEMINI_SERVICE_UNAVAILABLE'); }
  if (!plain(quota)) return quotaUnavailable('GEMINI_USAGE_MALFORMED');
  // The parent owns the shared decoder. Project just its input fields, never
  // arbitrary SDK response metadata, token objects or raw exception messages.
  const buckets = Array.isArray(quota?.buckets) ? quota.buckets.slice(0, 257).map(bucket => {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return null;
    const out = {};
    for (const key of ['modelId', 'tokenType', 'remainingFraction', 'remainingAmount', 'resetTime']) {
      const value = bucket[key];
      out[key] = value == null || typeof value === 'number' || typeof value === 'string' && value.length <= 128 ? value : false;
    }
    return out;
  }) : quota?.buckets === undefined ? [] : null;
  return { status: 'observed', email, quota: { buckets }, observedAt: new Date().toISOString() };
}
