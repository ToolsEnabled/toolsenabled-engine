# Generic worker model guidance

Validate each exact model, endpoint and protocol before relying on it as a ToolsEnabled Fleet worker. Ordinary chat support is insufficient: the model must return a structured function call and then use the real tool result. Fleet refuses malformed arguments and does not turn a plain-text suggestion into an authorized tool call. See [Generic workers](GENERIC-WORKERS.md) for configuration and limits. Codex's own model provider is configured separately through [OpenShell models](../adapters/openshell/MODELS.md).

## Compatibility checks

Use a private test endpoint and an independently verified memory roundtrip to check that a model can call `memory.set` and `memory.get` with object arguments. Repeat after changing the model version, endpoint or protocol. A protocol stub proves Fleet's transport behavior; it does not qualify the remote model.

Do not convert stringified JSON arguments or text that resembles a tool call into an API call. Treat malformed or absent function calls as a model compatibility failure for that task.

## OpenShell authentication

Attach the provider and authorize the exact endpoint for Fleet's Node executable. `--token-env` names the environment variable for `worker add`; `--key-env` serves the same purpose in a proof command. Neither option takes a key or a placeholder value.

When starting or resuming a worker, Fleet reads the selected variable, validates the `openshell:resolve:env:` prefix and supported identifier syntax, and forwards that injected placeholder unchanged. Missing, malformed or raw-key-looking values are refused before a request. The provider key remains with OpenShell. The placeholder is not passed to Fleet's MCP tool child, printed, or saved in connection metadata.
