'use strict';

// Turns one OpenShell sandbox denial log line into plain words, the exact
// `openshell` command the person could run from outside to allow it, and the
// narrowest `policy.local` proposal the agent itself could submit from
// inside. Shapes and CLI flags are taken from
// https://docs.nvidia.com/openshell/latest/how-it-works/policies/network-rules and .../policies/advisor.
// This module does no network I/O and holds no gateway access; it only reads
// text the agent is handed and produces text/JSON for a caller to send.

const NET_OPEN_RE = /NET:OPEN\s+\[(\w+)\]\s+DENIED\s+(\S+)\((\d+)\)\s*->\s*([^\s:]+):(\d+)(?:\s*\[[^\]]*\])*?\s*\[reason:(.+?)\]\s*$/;
const HTTP_RE = /HTTP:(\w+)\s+\[(\w+)\]\s+DENIED\s+(\w+)\s+(\S+?)(?:\s*\[[^\]]*\])*?\s*\[reason:(.+?)\]\s*$/;
// OpenShell 0.1.2 also logs the sandbox's DNS refusing a name no rule allows,
// just before the program's connection attempt is refused as NET:OPEN:
//   NET:REFUSE [MED] DENIED example.com [reason:policy_dns_ineligible]
const NET_REFUSE_RE = /NET:REFUSE\s+\[(\w+)\]\s+DENIED\s+([^\s[]+)(?:\s*\[[^\]]*\])*?\s*\[reason:(.+?)\]\s*$/;

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function riskLevelWord(level) {
  const word = { LOW: 'low', MED: 'medium', HIGH: 'high' }[String(level).toUpperCase()];
  return word || String(level).toLowerCase();
}

function sanitizeForRuleName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'target';
}

/**
 * Parses one denial line into a structured record, or returns null if the
 * line matches neither documented shape. The line may carry a leading
 * `[timestamp] [sandbox] [OCSF ] [ocsf] ` prefix (as in a full sandbox log)
 * or none at all (as in the task's own example and, per the advisor docs,
 * possibly `GET /v1/denials`'s shape) -- the parser looks for the first
 * `NET:OPEN`/`HTTP:<VERB>` token rather than anchoring to line start.
 */
function parseDenialLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  const netMatch = NET_OPEN_RE.exec(trimmed);
  if (netMatch) {
    const [, level, binary, pid, host, port, reason] = netMatch;
    return Object.freeze({
      kind: 'net_open',
      riskLevel: level.toUpperCase(),
      binary,
      pid: Number(pid),
      host,
      port: Number(port),
      method: null,
      path: null,
      reason: reason.trim(),
      raw: line
    });
  }
  const refuseMatch = NET_REFUSE_RE.exec(trimmed);
  if (refuseMatch) {
    const [, level, host, reason] = refuseMatch;
    return Object.freeze({
      kind: 'dns_refused',
      riskLevel: level.toUpperCase(),
      binary: null,
      pid: null,
      host,
      port: null,
      method: null,
      path: null,
      reason: reason.trim(),
      raw: line
    });
  }
  const httpMatch = HTTP_RE.exec(trimmed);
  if (httpMatch) {
    const [, , level, method, urlText, reason] = httpMatch;
    let host = null;
    let port = null;
    let path = urlText;
    try {
      const url = new URL(urlText);
      host = url.hostname;
      port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      path = url.pathname + url.search;
    } catch {
      // urlText was not a parseable absolute URL; leave host/port null and
      // keep the raw text as the path so the caller still sees everything
      // OpenShell reported, even if this explainer cannot build a command.
    }
    return Object.freeze({
      kind: 'http_request',
      riskLevel: level.toUpperCase(),
      binary: null,
      pid: null,
      host,
      port,
      method: method.toUpperCase(),
      path,
      reason: reason.trim(),
      raw: line
    });
  }
  return null;
}

function ruleNameFor(parsed, binary) {
  const bin = binary || parsed.binary;
  const binPart = bin ? sanitizeForRuleName(bin.split('/').pop()) : 'agent';
  const hostPart = sanitizeForRuleName(parsed.host || 'target');
  return `allow_${binPart}_${hostPart}`;
}

/**
 * Builds the plain-words explanation and the exact `openshell` CLI command
 * for one parsed (or raw) denial line. `binary` lets a caller supply the
 * process it knows made the request when the log line itself does not carry
 * one (true for every `HTTP:<method>` line -- confirmed against the
 * tutorial's own example, which names no binary at all).
 */
function explainDenial(lineOrParsed, { sandboxName = '<sandbox-name>', binary } = {}) {
  const parsed = typeof lineOrParsed === 'string' ? parseDenialLine(lineOrParsed) : lineOrParsed;
  if (!parsed) {
    return Object.freeze({
      understood: false,
      plainText: 'This line did not match a known denial shape (NET:OPEN, NET:REFUSE or HTTP:<method> ... DENIED), so no command can be suggested for it.',
      raw: typeof lineOrParsed === 'string' ? lineOrParsed : null
    });
  }

  const effectiveBinary = binary || parsed.binary;
  const ruleName = ruleNameFor(parsed, effectiveBinary);
  const riskWord = riskLevelWord(parsed.riskLevel);

  if (parsed.kind === 'net_open') {
    const plainText =
      `${parsed.binary} (pid ${parsed.pid}) tried to reach ${parsed.host}:${parsed.port} and OpenShell blocked the connection itself, ` +
      `before any request could be inspected -- ${riskWord} risk. No rule in the sandbox's policy names this binary, host and port at all. ` +
      `OpenShell's own reason: "${parsed.reason}".`;
    const suggestedCommand =
      `openshell policy update ${sandboxName} \\\n` +
      `  --rule-name ${ruleName} \\\n` +
      `  --binary ${parsed.binary} \\\n` +
      `  --add-endpoint ${parsed.host}:${parsed.port} \\\n` +
      `  --wait`;
    return Object.freeze({
      understood: true,
      kind: parsed.kind,
      riskLevel: parsed.riskLevel,
      plainText,
      suggestedCommand,
      note:
        'This allows the connection with no request-level (L7) restriction. If this is really an HTTPS JSON API and only reads are ' +
        `needed, use --add-endpoint ${parsed.host}:${parsed.port}:read-only:rest:enforce instead -- narrower than a bare allow.`,
      ruleName,
      binaryRequired: false,
      parsed
    });
  }

  if (parsed.kind === 'dns_refused') {
    return Object.freeze({
      understood: true,
      kind: parsed.kind,
      riskLevel: parsed.riskLevel,
      plainText:
        `A program asked the sandbox to look up ${parsed.host} and OpenShell refused, because no rule in the sandbox's policy allows ` +
        `that host (${riskWord} risk). This line names neither the program nor the port; the connection attempt that follows is logged ` +
        `as a NET:OPEN denial for the same host, and that is the line to propose. OpenShell's own reason: "${parsed.reason}".`,
      suggestedCommand: null,
      ruleName,
      binaryRequired: !effectiveBinary,
      parsed
    });
  }

  // http_request
  if (!parsed.host || !parsed.port) {
    return Object.freeze({
      understood: true,
      kind: parsed.kind,
      riskLevel: parsed.riskLevel,
      plainText:
        `A ${parsed.method} request was denied at the request level (${riskWord} risk), but the destination in the log line ` +
        `("${parsed.raw}") could not be parsed as a URL, so no command can be suggested.`,
      suggestedCommand: null,
      ruleName,
      binaryRequired: !effectiveBinary,
      parsed
    });
  }

  const readOnly = READ_ONLY_METHODS.has(parsed.method);
  const binaryForCommand = effectiveBinary || '<binary-path>';
  const plainText =
    `A ${parsed.method} request to ${parsed.host}:${parsed.port}${parsed.path} was denied at the request level, not at the connection ` +
    `level -- ${riskWord} risk. A network rule already allows reaching this destination; either no allow rule covers this method and ` +
    `path, or a deny rule matches it. OpenShell's own reason: "${parsed.reason}".` +
    (effectiveBinary ? '' : ' The denial line does not name the process that made the request, so the suggested command below needs it filled in.');

  const suggestedCommand = readOnly
    ? `openshell policy update ${sandboxName} \\\n` +
      `  --rule-name ${ruleName} \\\n` +
      `  --binary ${binaryForCommand} \\\n` +
      `  --add-endpoint ${parsed.host}:${parsed.port}:read-only:rest:enforce \\\n` +
      `  --wait`
    : `openshell policy update ${sandboxName} \\\n` +
      `  --rule-name ${ruleName} \\\n` +
      `  --binary ${binaryForCommand} \\\n` +
      `  --add-endpoint ${parsed.host}:${parsed.port}::rest:enforce \\\n` +
      `  --add-allow ${parsed.host}:${parsed.port}:${parsed.method}:${parsed.path} \\\n` +
      `  --wait`;

  return Object.freeze({
    understood: true,
    kind: parsed.kind,
    riskLevel: parsed.riskLevel,
    plainText,
    suggestedCommand,
    ruleName,
    binaryRequired: !effectiveBinary,
    parsed
  });
}

/**
 * The narrowest `POST /v1/proposals` body for a parsed denial, in the shape
 * advisor.mdx's own example proposal uses. Throws `OPENSHELL_PROPOSAL_NO_BINARY`
 * rather than emitting a rule with an empty `binaries` list -- network-rules.mdx
 * is explicit that such a rule "matches no binary and allows nothing," so a
 * caller must supply the binary it knows about (for an `http_request` denial,
 * the log line never carries one).
 */
function buildNarrowestProposal(lineOrParsed, { intentSummary, binary } = {}) {
  const parsed = typeof lineOrParsed === 'string' ? parseDenialLine(lineOrParsed) : lineOrParsed;
  if (!parsed) {
    const error = new Error('Cannot build a proposal from a denial line that did not match a known shape.');
    error.code = 'OPENSHELL_PROPOSAL_UNPARSEABLE';
    throw error;
  }
  if (parsed.kind === 'dns_refused') {
    const error = new Error(
      `A refused lookup names no program or port. Propose the NET:OPEN denial for ${parsed.host} that follows it instead.`
    );
    error.code = 'OPENSHELL_PROPOSAL_DNS_ONLY';
    throw error;
  }
  const effectiveBinary = binary || parsed.binary;
  if (!effectiveBinary) {
    const error = new Error(
      'No binary is known for this denial (an HTTP:<method> line never names one) -- pass { binary } explicitly, ' +
        'or the proposed rule would allow nothing.'
    );
    error.code = 'OPENSHELL_PROPOSAL_NO_BINARY';
    throw error;
  }
  if (!parsed.host || !parsed.port) {
    const error = new Error('No host/port could be determined for this denial, so no endpoint can be proposed.');
    error.code = 'OPENSHELL_PROPOSAL_NO_ENDPOINT';
    throw error;
  }

  const ruleName = ruleNameFor(parsed, effectiveBinary);
  const endpoint = { host: parsed.host, port: parsed.port };
  if (parsed.kind === 'http_request') {
    // Agents cannot propose protocol: tcp or tls: skip (advisor.mdx), and
    // omitting protocol here would allow ANY method/path once connected, so
    // for a request-level denial the narrowest proposal names exactly the
    // method and path that were blocked.
    endpoint.protocol = 'rest';
    endpoint.enforcement = 'enforce';
    endpoint.rules = [{ allow: { method: parsed.method, path: parsed.path } }];
  }
  // For net_open, protocol is deliberately omitted: advisor.mdx says agents
  // cannot propose protocol: tcp at all, and omitting it (rather than
  // guessing rest) is the narrowest thing an agent can propose for a
  // connection it has not seen make any request yet.

  return {
    intent_summary:
      intentSummary ||
      (parsed.kind === 'net_open'
        ? `Allow ${effectiveBinary} to reach ${parsed.host}:${parsed.port}.`
        : `Allow ${effectiveBinary} to ${parsed.method} ${parsed.path} on ${parsed.host}:${parsed.port}.`),
    operations: [
      {
        addRule: {
          ruleName,
          rule: {
            name: ruleName,
            endpoints: [endpoint],
            binaries: [{ path: effectiveBinary }]
          }
        }
      }
    ]
  };
}

module.exports = Object.freeze({
  parseDenialLine,
  explainDenial,
  buildNarrowestProposal
});
