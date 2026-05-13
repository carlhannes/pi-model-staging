# pi-model-staging

A [pi](https://pi.dev) extension that adds a **plan-then-implement** workflow
with a **single configurable model ladder**. The model and reasoning level
step down as the agent grinds through tool calls "by itself", and snap back
to the snappy/user-facing tier whenever control returns to you.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## The mental model

One ladder, one counter. The principle: **stepping only happens while the
LLM is working autonomously inside one agent run. Hand control back to the
user → reset to the top.**

```ts
const LADDER: Rung[] = [
    { modelId: "gpt-5.5:quick", thinking: "xhigh",  webSearchContextSize: "high"   }, // [0] snappy / user-facing
    { modelId: "gpt-5.4",       thinking: "xhigh",  webSearchContextSize: "high"   }, // [1] first autonomous step
    { modelId: "gpt-5.4",       thinking: "high",   webSearchContextSize: "medium" }, // [2]
    { modelId: "gpt-5.4",       thinking: "medium", webSearchContextSize: "medium" }, // [3]
    { modelId: "gpt-5.2",       thinking: "high",   webSearchContextSize: "low"    }, // [4]
    { modelId: "gpt-5.2",       thinking: "medium", webSearchContextSize: "low"    }, // [5]+ (last rung repeats)
];
```

| Situation                                                            | Rung used   |
|----------------------------------------------------------------------|-------------|
| Plan mode (every LLM call while shaping the plan)                    | `LADDER[0]` |
| Auto-injected "Please start implementation." run, turn 1             | `LADDER[1]` |
| Same run, turn 2, 3, ...                                             | step down   |
| `agent_end` during implementing → user gets control back             | reset to 0  |
| User follow-up prompt, turn 1 (LLM responding to user, "user-facing")| `LADDER[0]` |
| Same prompt, turn 2, 3, ... (autonomous tool calls)                  | step down   |
| Failed tool / bash / npm/pnpm/yarn/bun result during implementing   | bump next call to `LADDER[1]`, then continue at `LADDER[2]` |
| Re-entering `/plan`                                                  | `LADDER[0]` |

So `[0]` covers "user is in control or shaping the plan", `[1]` is "first
step into autonomous work", and `[2..]` are progressive degradation as the
agent keeps grinding without checking back in. Important tool results can
restart that autonomous cursor from `[1]` so error/test interpretation gets
stronger reasoning before stepping down again.

## How it actually works

The architectural problem: pi captures `model` and `reasoning` once when it
builds `AgentLoopConfig` ([agent.ts:413](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent.ts#L413))
and reuses them for every turn inside one agent run. Calling
`pi.setModel()` mid-loop never reaches the in-flight request.

This extension uses two mechanisms together:

1. **`pi.setModel()` once per plan→implementation cycle, at `/plan`.**
   Because every rung shares `PROVIDER`, that single binding carries the
   provider, baseUrl, and API key through plan mode, the auto-injected
   "Please start implementation." run, and any user follow-ups in
   implementing mode. We deliberately don't call it again — pi persists
   each `setModel()` as a default in `settings.json`, which would bounce
   around per turn.
2. **`before_provider_request` payload rewriting on every LLM call** —
   rewrites the wire payload's `model` and `reasoning_effort` /
   `reasoning.effort` / `output_config.effort` (depending on API) to
   whatever `LADDER[stage]` says. This is what enables stepping inside one
   agent run.

### Same-provider constraint

All rungs must live on the same provider. The HTTP client is built **before**
`before_provider_request` runs (e.g.
[anthropic.ts:466](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/anthropic.ts#L466)),
binding `baseUrl` + `apiKey` from the per-run model. Rewriting the payload
to reference a model on a different provider would still send the request
to the original endpoint with the original key — wrong destination, likely
wrong wire format too.

In practice: set the `provider` once (in `plan-stepdown.json`), then pick freely from the
models that provider exposes. If your provider is your own proxy (the
intended use case), you can use the model name to route to different
backend tiers — see [models.example.json](models.example.json) for the
proxy setup pattern.

If you need true per-turn cross-provider swaps, that requires a small
upstream patch to pi-mono (`createLoopConfig` → getter style). Not
included; see commit history if you want the rationale.

## Requirements

- [pi](https://pi.dev) (any recent version supporting the extension API —
  tested against pi-mono `main` as of May 2026)
- Node.js 22+ (only for running the test suite — pi itself bundles its own
  runtime via [jiti](https://github.com/unjs/jiti))
- A provider with one of the supported APIs:
  - OpenAI Responses (full support: model + reasoning effort)
  - OpenAI Completions (full support)
  - Anthropic adaptive thinking (model + effort via `output_config`)
  - Anthropic budget thinking (model only — budget is left untouched)
  - Google generative AI (model only — budget is left untouched)

## Install

**Official install — pinned to the latest release tag:**

```bash
# Global (adds to ~/.pi/agent/settings.json)
pi install git:github.com/carlhannes/pi-model-staging@v0.2.0

# Project-local (adds to .pi/settings.json — share with your team)
pi install -l git:github.com/carlhannes/pi-model-staging@v0.2.0

# Try once without persisting
pi -e git:github.com/carlhannes/pi-model-staging@v0.2.0
```

Pi clones the repo, reads the `pi.extensions` field from `package.json`,
and loads the extension automatically. The `@v0.2.0` pins to a specific
release so `pi update` won't surprise you with breaking changes — drop the
suffix if you want the latest `main`.

After install, configure the extension with JSON instead of editing the
source code directly — see [Configuration](#configuration).

Configuration files are loaded from:
- `~/.pi/agent/plan-stepdown.json` (global/user)
- `.pi/plan-stepdown.json` (project, overrides global)

If you want to hack on the extension itself, clone the repo and edit the
TypeScript source. For normal per-user or per-project setup, prefer the
JSON config files.

### Verify install

Inside `pi`, run `/help` and you should see `/plan`, `/stepdown`, and
`/stepdown-off`. If they're missing, check `pi --debug` startup logs for
extension load errors.

### Alternative: from a local clone (recommended for developing the extension itself)

```bash
git clone https://github.com/carlhannes/pi-model-staging
cd pi-model-staging
# Edit the extension source in .pi/extensions/plan-stepdown/
pi   # auto-discovers .pi/extensions/ when run from the project root
```

### Alternative: symlink for global use

```bash
git clone https://github.com/carlhannes/pi-model-staging
ln -s "$(pwd)/pi-model-staging/.pi/extensions/plan-stepdown" \
      ~/.pi/agent/extensions/plan-stepdown
```

## Configuration

`plan-stepdown` uses its own JSON config files, merged in this order:

1. built-in defaults in the extension
2. `~/.pi/agent/plan-stepdown.json` (global/user)
3. `.pi/plan-stepdown.json` (project)
4. `--stepdown-config /path/to/file.json` (one-off override)

Project config overrides global config. Arrays such as `ladder`, `tools.plan`,
and `tools.implementation` are treated as **replace**, not deep-merge.

### Example config

```json
{
  "provider": "openai-proxy",
  "ladder": [
    { "modelId": "gpt-5.5:quick", "thinking": "xhigh", "webSearchContextSize": "high" },
    { "modelId": "gpt-5.4", "thinking": "xhigh", "webSearchContextSize": "high" },
    { "modelId": "gpt-5.4", "thinking": "high", "webSearchContextSize": "medium" },
    { "modelId": "gpt-5.2", "thinking": "medium", "webSearchContextSize": "low" }
  ],
  "tools": {
    "plan": ["read", "bash", "grep", "find", "ls"],
    "implementation": ["read", "bash", "edit", "write", "grep", "find", "ls"]
  },
  "reasoningBump": {
    "bumpOnFailedBash": true,
    "bumpOnFailedTool": true,
    "bumpOnPackageManagerCommand": true,
    "packageManagerCommands": ["npm", "pnpm", "yarn", "bun"]
  },
  "openaiPromptCache": {
    "keyPrefix": "pi-model-staging:",
    "retention": "24h"
  },
  "openaiWebSearch": {
    "enabled": true,
    "locationEnabled": true
  }
}
```

### Field reference

**`provider`** — string. Must match a provider known to pi
(`pi --list-models` shows them, including custom ones from
`~/.pi/agent/models.json`). All rungs use this provider.

**`ladder`** — array of rungs.
- `modelId` — string. Must match a model ID for `provider`.
- `thinking` — `"minimal" | "low" | "medium" | "high" | "xhigh"`.
  Auto-clamped to model capabilities (e.g. setting `xhigh` on a model that
  only supports `high` will silently drop to `high`).
- `webSearchContextSize` — optional. `"low" | "medium" | "high" | "off"`.
  Controls OpenAI Responses native `web_search` tool context size for this rung.
  Use `"off"` to disable hosted search on a specific rung.

**`tools.plan` / `tools.implementation`** — arrays of tool names. These
replace the built-in defaults for each phase.

**`reasoningBump`** — controls which tool results temporarily reset the
next LLM call to the stronger autonomous rung.

**`openaiPromptCache`**
- `keyPrefix` — string prefix for the generated prompt-cache key.
- `retention` — `"24h"`, `"in_memory"`, or `null`.
  Use `null` to omit the retention field.

**`openaiWebSearch`**
- `enabled` — enable/disable OpenAI Responses hosted web search by default.
- `locationEnabled` — enable/disable approximate country/timezone metadata by default.

### One-off override file

For CI, experiments, or temporary project-specific routing, you can point
at another config file without changing your normal user/project config:

```bash
pi --stepdown-config ./ops/stepdown-ci.json
```

### Model and provider names

Run `pi --list-models` to see what's available. Custom providers (Ollama,
vLLM, LM Studio, your own proxy) configured in `~/.pi/agent/models.json`
work exactly the same — see [pi's models docs](https://pi.dev/docs/latest/models)
and [custom provider docs](https://pi.dev/docs/latest/custom-provider).

A starter [models.example.json](models.example.json) is included for the
"openai-responses-compatible proxy" use case — one provider with several
GPT-5.x model IDs (including `gpt-5.5:quick` for routing to a priority
tier). Copy into `~/.pi/agent/models.json` (or merge into your existing
file's `providers` map) and edit `baseUrl` / `apiKey` to match your setup.

### System-prompt nudges

The plan/implementation prompts are still part of the extension source.
If you want to change those messages, edit `PLAN_PROMPT` and
`IMPL_FIRST_PROMPT` in `.pi/extensions/plan-stepdown/index.ts`.

## Usage

### Interactive

```
> /plan
plan-stepdown: Plan mode ON. Every LLM call uses [0] openai-proxy/gpt-5.5:quick:xhigh

> How should I refactor the auth module?
[plan produced — every LLM call inside this run uses LADDER[0]]

[dialog appears]
Plan ready — what next?
  > Start implementation
    Refine — stay in plan mode
    Cancel — leave plan mode

> Start implementation
[implementation phase begins, first LLM call uses LADDER[1], next [2],
 next [3], ... last rung repeats. When done, status snaps back to LADDER[0]]

> also add tests for it
[user follow-up — first LLM call uses LADDER[0] (user-facing), then steps
 down through LADDER[1], LADDER[2], ... again]
```

### Headless / non-interactive (opt-in auto-approve)

If you want to skip the plan-approval dialog and automatically start implementation after the plan is produced:

```bash
pi -p --plan-auto-approve "Refactor the auth module"
```

**Warning:** `--plan-auto-approve` skips the human-in-the-loop approval step and may modify files.

The status line at the bottom shows the live cursor:
`▶ impl [2] openai-proxy/gpt-5.4:high (3/6)`.

### Commands

| Command          | What it does |
|------------------|--------------|
| `/plan`          | Enter plan mode, restrict to read-only tools, bind provider for the upcoming runs |
| `/stepdown`      | Print the ladder with the current cursor position |
| `/stepdown-off`  | Exit plan/implementation mode, restore full tools |

### State machine summary

In addition to the stage counter, the extension also supports **one-shot reasoning bumps**
inside implementing mode: when certain tool results arrive (e.g. failed tools, failing bash,
or npm/pnpm/yarn/bun output), the *next* LLM call temporarily uses `LADDER[1]` (or `LADDER[0]` if the ladder has
only one rung). After a bumped turn, the stage cursor continues at the rung *after* the bump (so a bump on `LADDER[1]` continues at `LADDER[2]`).

| Event                                  | Stage transition                              |
|----------------------------------------|-----------------------------------------------|
| `/plan`                                | `mode=planning, stage=0`                      |
| Every LLM call (planning)              | uses `LADDER[0]` regardless of stage          |
| Plan accepted                          | `mode=implementing, stage=1`                  |
| `turn_end` during implementing         | `stage = min(stage+1, LADDER.length-1)`       |
| `tool_result` trigger (implementing)   | queue bump for next LLM call (resets cursor)  |
| Aborted turn                           | stage NOT advanced (so /resume picks up here) |
| `agent_end` during implementing        | `stage=0` (reset for next user prompt)        |
| `/plan` again, or `/stepdown-off`      | reset                                         |

## Native web search (OpenAI Responses)

When using an OpenAI Responses-compatible provider, this extension enables the
hosted `web_search` tool by default.

- It injects `{ "type": "web_search" }` into the wire payload's `tools`.
- `search_context_size` follows the current ladder rung via
  `rung.webSearchContextSize` ("high" → "medium" → "low" as the extension steps
  down).
- Search is optional: if `tool_choice` is missing, it's set to `"auto"` so the
  model decides when to search.
- Only OpenAI Responses payloads are modified; Chat Completions payloads are
  left unchanged.
- The legacy `web_search_preview` tool is not used.

Location bias is enabled by default and sends approximate `country` and `timezone`
(no city/region). Timezone comes from Node's local `Intl` settings unless
overridden; country is inferred from common timezones such as
`Europe/Stockholm` → `SE`, or omitted when unknown.

Defaults come from `openaiWebSearch.enabled` and `openaiWebSearch.locationEnabled`
in `plan-stepdown.json`.

- Disable location metadata in config with `"openaiWebSearch": { "locationEnabled": false }`.
- Disable hosted search in config with `"openaiWebSearch": { "enabled": false }`.
- Disable location metadata via env with `PI_OPENAI_WEB_SEARCH_LOCATION=0`.
- Override country with `PI_OPENAI_WEB_SEARCH_COUNTRY=SE`.
- Override timezone with `PI_OPENAI_WEB_SEARCH_TIMEZONE=Europe/Stockholm`.

Env vars win for one-off runs. Disable web search globally via env with
`PI_OPENAI_WEB_SEARCH=0`, or disable it per rung with `webSearchContextSize: "off"`.

Caveat: Pi's visible cost/footer and citation rendering may not expose every
hosted web-search detail. The prompt asks the model to cite important web
sources explicitly in normal text.

## Prompt caching (OpenAI)

OpenAI automatically caches long prompt prefixes, which can reduce latency and input token costs.
Cache hits require **exact prefix matches** and typically only apply once prompts exceed ~1024 tokens.

This extension tries to improve cache affinity for OpenAI-compatible backends in a conservative way:

- It keeps pi/provider-provided cache fields if they already exist.
- If missing, it injects `prompt_cache_key` based on a stable hash of the local username + current working directory (cwd).
- It optionally requests extended retention via `prompt_cache_retention: "24h"`.
- **Respects user opt-out**: if the wire payload arrives with both
  `prompt_cache_key` AND `prompt_cache_retention` undefined, that's pi
  signalling caching is disabled (e.g. you set `cacheRetention: "none"`
  in pi settings). The extension passes the payload through untouched
  rather than re-enabling what you turned off.

### Configuration

In `plan-stepdown.json`:

- `openaiPromptCache.keyPrefix`: defaults to `"pi-model-staging:"`.
- `openaiPromptCache.retention`: defaults to `"24h"`.
  - Set it to `null` if your proxy rejects the field or you want to omit it.
  - We intentionally do **not** force an explicit in-memory value because different OpenAI SDK versions historically used different spellings (`in_memory` vs `in-memory`).

### Caveats

- Prompt caches are per-organization and per-model/backend. Stepping down across different model IDs (e.g. `gpt-5.4` → `gpt-5.2`) will not share KV cache.
- If you send >~15 req/min for the same prefix+key, OpenAI may overflow-route and reduce cache effectiveness.

### Monitoring

Check OpenAI usage fields (`cached_tokens`), or in pi watch session stats:
- `cacheRead` tokens increase on cache hits (for providers that report it).

## Tests

```bash
npm test
```

Runs unit tests via Node's built-in test runner with type stripping
(no extra deps). Coverage:

- API detection: OpenAI Responses / OpenAI Completions / Anthropic adaptive /
  Anthropic budget / Google / unknown payloads
- Payload rewriting per API: model + reasoning swap, no input mutation,
  graceful degradation on unknown payloads
- `chooseRung` mode/stage dispatch including clamping
- `nextStage` advancement (called from both normal turn_end and post-bump
  paths)
- OpenAI native web-search tool injection, including per-rung
  `search_context_size`, opt-out, duplicate-tool avoidance, and Chat
  Completions pass-through
- OpenAI prompt-cache key/retention augmentation, including the
  user-opt-out path
- Reasoning bump trigger detection (failed bash, failed tool calls, package-manager output)
- **End-to-end lifecycles** (two scenarios):
  - Plain plan → accept → implement → reset → follow-up, asserting the exact
    sequence of model + effort values at every LLM call
  - Bumped path: a `npm test`-style trigger mid-run, asserting the
    bumped turn uses LADDER[1] and the next normal turn resumes at
    LADDER[2] (not the pre-bump cursor)

The pure logic lives in [rewrite.ts](.pi/extensions/plan-stepdown/rewrite.ts)
(no pi imports), so tests run without pi or any LLM API keys.

## Troubleshooting

**`plan-stepdown: model X/Y not found`**
The model ID in your ladder doesn't match what's in `pi --list-models` for
`PROVIDER`. Fix the typo, or register a custom provider in
`~/.pi/agent/models.json`. The extension resets to idle on this error so it
won't keep firing.

**`plan-stepdown: no API key configured for X`**
Run `pi auth login` for that provider, or set the env var (see
[pi-mono/packages/ai/src/env-api-keys.ts](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/env-api-keys.ts)
for the var names per provider).

**Pi shows the wrong model in its status display**
We deliberately call `setModel()` only once at `/plan`. Pi's display reads
`agent.state.model` and so shows `LADDER[0]`'s model the whole time. The
*actual* model that hits the wire is whatever the per-call rewrite
substitutes — our own status widget shows the truth. We avoid calling
`setModel()` per turn because it persists the new model as the default in
`settings.json`, which would bounce around constantly.

**Status widget doesn't appear**
The widget needs an interactive TUI. In `pi --print` / `--mode json` /
`--mode rpc`, the widget is suppressed but the model swaps still happen.

**Plan-ready dialog never appears**
In non-interactive modes (`pi -p`, `--mode json`) there is no dialog UI. If you want the extension to automatically start implementation after planning, use `--plan-auto-approve`.

## Limitations

- All rungs must be on the same provider (architectural — see "Same-provider
  constraint" above).
- Anthropic budget thinking and Google models swap `model` only; the
  thinking budget is left alone. Use adaptive Anthropic models or set
  explicit budgets in your proxy if you need per-turn budget control.
- The state we persist across `/resume` is `mode + stage`. One-shot bump
  state is intentionally in-memory only. The state machine resumes correctly
  but the auto-injected `IMPL_FIRST_PROMPT` fires only once per accept, not
  on resume.
- `setModel()` is called only at `/plan` (once per plan→implementation cycle), so
  pi's own model display lags behind the actual rung in flight. Our
  status widget shows the truth — see Troubleshooting.

## How this extension is built

If you want to fork or learn from it:

- [.pi/extensions/plan-stepdown/index.ts](.pi/extensions/plan-stepdown/index.ts)
  — event subscriptions, mode/state, command registration.
- [.pi/extensions/plan-stepdown/rewrite.ts](.pi/extensions/plan-stepdown/rewrite.ts)
  — pure functions for API detection and payload rewriting. Zero pi
  imports so it's testable in isolation.
- [.pi/extensions/plan-stepdown/rewrite.test.ts](.pi/extensions/plan-stepdown/rewrite.test.ts)
  — unit tests with realistic payload fixtures, prompt-cache coverage
  (including user opt-out), reasoning-bump coverage, and two end-to-end
  lifecycle simulations (with and without a bump).

The pi APIs used are documented at:
- [pi extensions guide](https://pi.dev/docs/latest/extensions)
- [pi packages guide](https://pi.dev/docs/latest/packages)
- [extension type definitions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [`before_agent_start` emit site](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts#L1067)
- [`before_provider_request` plumbing](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/sdk.ts#L345)
- [`createLoopConfig`](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent.ts#L410)
  — explains why per-turn swaps need payload rewriting

The existing upstream
[plan-mode example](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/plan-mode)
is a good reference for the plan/implementation UX pattern this extension extends.

## Contributing

Issues and PRs welcome. The change surface is small:

- Logic changes go in `rewrite.ts` with corresponding tests in
  `rewrite.test.ts`. Run `npm test` before sending a PR.
- Pi-API integration lives in `index.ts`. There are no integration tests
  for this layer — verify by running `pi` locally and watching the status
  widget plus your provider's request logs.

If you add support for a new API family, add a fixture and a detection
test to `rewrite.test.ts`. The fixture should mirror what the corresponding
provider in
[pi-mono's `packages/ai/src/providers/`](https://github.com/badlogic/pi-mono/tree/main/packages/ai/src/providers)
actually sends on the wire.

## License

MIT — see [LICENSE](LICENSE).

This extension is independent of pi but builds on its public extension
API. pi itself is also MIT-licensed
([badlogic/pi-mono](https://github.com/badlogic/pi-mono)).
