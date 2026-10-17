# Models in ToolsEnabled Fleet

Fleet has three model paths. Codex and Claude workers use their native CLIs. `toolsenabled model` configures a Codex model endpoint. `toolsenabled worker` runs a compatible model directly through Fleet's generic worker transport. Each path uses the same offered Fleet tools and the permission level saved at setup.

## Native Codex and Claude workers

Install and sign in to the provider CLI separately, then run `toolsenabled setup --agents`. A worker launched through `agent.spawn` inherits the tree's permission limits. OpenShell policy confines the sandbox and its child processes. The [OpenShell setup guide](README.md) explains the CLI sign-ins and tree controls.

## Custom endpoint for Codex

`toolsenabled model` writes Codex's own configuration. It does not send a model request itself. The endpoint must support the Responses API and the tool format sent by the installed Codex CLI.

```shell
toolsenabled model add my-model --base-url https://MODEL_HOST/v1 --model EXACT_MODEL_ID --key-env MODEL_API_KEY
toolsenabled model list
toolsenabled model use my-model
codex --profile my-model
```

`model add` creates a named Codex profile. `model use` selects it as the default for Codex and Fleet's Codex workers; Claude workers are unaffected. `model remove my-model` removes configuration written by this command and restores a prior default where possible. `model profile` creates an OpenShell provider profile for review and import on the host; run `toolsenabled model help` for its options.

For a keyed endpoint in OpenShell, attach a provider whose policy admits the exact endpoint and Codex executable. The sandbox should receive only OpenShell's resolver placeholder in the named environment variable. Fleet refuses a raw key found in that variable during `model add`. Keep the real key with OpenShell.

A successful Codex configuration or protocol stub does not prove that a particular remote model can call Fleet tools. Check the exact model, endpoint and protocol with a real `memory.set` and `memory.get` roundtrip before relying on it.

## Direct generic worker

`toolsenabled worker` supports Chat Completions, Responses and Anthropic Messages endpoints that return structured function calls. It can use an OpenShell-injected placeholder in a sandbox, a named environment variable in host mode, or no authentication for a loopback endpoint.

```shell
toolsenabled worker add my-worker --transport openai-chat \
  --endpoint https://MODEL_HOST/v1/chat/completions \
  --model EXACT_MODEL_ID --source api --auth openshell --token-env MODEL_API_KEY
toolsenabled worker run my-worker --prompt 'Read the Fleet task list.'
```

Use `--transport openai-responses` with a full `/responses` endpoint when the model supports that protocol. The worker requires a tool call for its first exchange and refuses plain chat or malformed tool arguments as a worker turn. Messages uses `--transport anthropic-messages` with an endpoint ending in `/v1/messages`. Local unauthenticated HTTP permits exact loopback hosts and `host.openshell.internal` for a local source; all other plain-HTTP hosts are refused. Use the latter to reach the host's already running server through OpenShell policy. See [generic worker setup and limits](../../docs/GENERIC-WORKERS.md) and [model validation](../../docs/MODELS.md).

Fleet's protocol tests use local stand-in endpoints. Compatibility and quality are claims about an exact model and endpoint after a real tool roundtrip, not about a provider's catalog as a whole.

Use `toolsenabled agents add DISCOVERED_ID --model EXACT_MODEL_ID [--name NAME]`
to save an available API endpoint or running local server using the same
validation as `worker add`. API discovery stores only the key variable name;
in OpenShell that variable must contain the provider's resolver placeholder.

With the tree enabled, saved `model-NAME` tiers are full tree members in both
host and OpenShell mode, and can delegate to other saved models. A whole tree
can use local servers. Each worker inherits its parent's permission level and
role restrictions; at level 1 only Fleet read tools are offered. Fleet starts
no model server and installs or signs in no agent CLI.
