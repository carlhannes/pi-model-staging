# pi-model-staging

A [pi](https://pi.dev) extension that adds a **plan-then-execute** workflow
with a **single configurable model ladder**. The model and reasoning level
step down as the agent grinds through tool calls "by itself", and snap back
to the snappy/user-facing tier whenever control returns to you.

## The mental model

One ladder, one counter. The principle: **stepping only happens while the
LLM is working autonomously inside one agent run. Hand control back to the
user → reset to the top.**

```ts
const LADDER: Rung[] = [
    { modelId: "gpt-5.5:quick", thinking: "xhigh" }, // [0] snappy / user-facing
    { modelId: "gpt-5.5",       thinking: "xhigh" }, // [1] first autonomous step
    { modelId: "gpt-5.5",       thinking: "high"  }, // [2]
    { modelId: "gpt-5.4",       thinking: "high"  }, // [3]
    { modelId: "gpt-5.2",       thinking: "high"  }, // [4]+ (last rung repeats)
];
```

| Situation                                                            | Rung used   |
|----------------------------------------------------------------------|-------------|
| Plan mode (every LLM call while shaping the plan)                    | `LADDER[0]` |
| Auto-injected "Execute the plan." run, turn 1                        | `LADDER[1]` |
| Same run, turn 2, 3, ...                                             | step down   |
| `agent_end` during executing → user gets control back                | reset to 0  |
| User follow-up prompt, turn 1 (LLM responding to user, "user-facing")| `LADDER[0]` |
| Same prompt, turn 2, 3, ... (autonomous tool calls)                  | step down   |
| Failing bash / npm/pnpm/yarn/bun result during executing             | bump next call to `LADDER[1]`, then continue at `LADDER[2]` |
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

1. **`pi.setModel()` once at `/plan`** — binds the provider, baseUrl, and
   API key for every agent run that follows. We don't call it again, to
   avoid pi's setModel side-effect of persisting a new default in your
   settings.
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

In practice: change the `PROVIDER` constant once, then pick freely from the
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
pi install git:github.com/carlhannes/pi-model-staging@v0.1.0

# Project-local (adds to .pi/settings.json — share with your team)
pi install -l git:github.com/carlhannes/pi-model-staging@v0.1.0

# Try once without persisting
pi -e git:github.com/carlhannes/pi-model-staging@v0.1.0
```

Pi clones the repo, reads the `pi.extensions` field from `package.json`,
and loads the extension automatically. The `@v0.1.0` pins to a specific
release so `pi update` won't surprise you with breaking changes — drop the
suffix if you want the latest `main`.

After install you'll need to edit the ladder in `index.ts` for your own
model setup — see [Configuration](#configuration). The simplest way to do
that is to clone and run from a checkout (next section), or to copy
`.pi/extensions/plan-stepdown/index.ts` into your own project's
`.pi/extensions/` directory and edit it there.

### Verify install

Inside `pi`, run `/help` and you should see `/plan`, `/stepdown`, and
`/stepdown-off`. If they're missing, check `pi --debug` startup logs for
extension load errors.

### Alternative: from a local clone (recommended for editing the ladder)

```bash
git clone https://github.com/carlhannes/pi-model-staging
cd pi-model-staging
# Edit PROVIDER + LADDER in .pi/extensions/plan-stepdown/index.ts
pi   # auto-discovers .pi/extensions/ when run from the project root
```

### Alternative: symlink for global use

```bash
git clone https://github.com/carlhannes/pi-model-staging
ln -s "$(pwd)/pi-model-staging/.pi/extensions/plan-stepdown" \
      ~/.pi/agent/extensions/plan-stepdown
```

## Configuration

Open [.pi/extensions/plan-stepdown/index.ts](.pi/extensions/plan-stepdown/index.ts)
and edit the two things near the top:

```ts
const PROVIDER = "openai-proxy";

const LADDER: Rung[] = [
    { modelId: "gpt-5.5:quick", thinking: "xhigh" }, // [0] plan + user-facing
    { modelId: "gpt-5.5",       thinking: "xhigh" }, // [1] first autonomous step
    { modelId: "gpt-5.5",       thinking: "high"  }, // [2]
    { modelId: "gpt-5.4",       thinking: "high"  }, // [3]
    { modelId: "gpt-5.2",       thinking: "high"  }, // [4]+ (clamps here forever)
];
```

### Field reference

**`PROVIDER`** — string. Must match a provider known to pi
(`pi --list-models` shows them, including custom ones from
`~/.pi/agent/models.json`). All rungs use this provider.

**`Rung`**
- `modelId` — string. Must match a model ID for `PROVIDER`.
- `thinking` — `"minimal" | "low" | "medium" | "high" | "xhigh"`.
  Auto-clamped to model capabilities (e.g. setting `xhigh` on a model that
  only supports `high` will silently drop to `high`).

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

### Tools allowed in plan vs execute

Edit `PLAN_TOOLS` / `EXEC_TOOLS` in `index.ts` if the defaults don't match
your tool set. Default plan-mode tools are read-only: `read`, `bash`,
`grep`, `find`, `ls`. Default execute tools add `edit` and `write`.

### Reasoning bump triggers

Edit `REASONING_BUMP` in `index.ts` to change which tool results restart the
autonomous cursor from `LADDER[1]` (or `LADDER[0]` for a one-rung ladder).
Defaults:

- failed bash commands (`isError: true`, including non-zero exit codes and timeouts)
- bash commands that start with `npm`, `pnpm`, `yarn`, or `bun`

After the bumped turn completes, normal stepping resumes at the rung after the
bump. With the default ladder that means `[1]` for the bumped turn, then `[2]`,
then `[3]`, and so on.

### System-prompt nudges

Edit `PLAN_PROMPT` and `EXEC_FIRST_PROMPT` in `index.ts` to change the
messages that get injected at the start of plan / execute phases.

## Usage

```
> /plan
plan-stepdown: Plan mode ON. Every LLM call uses [0] openai-proxy/gpt-5.5:quick:xhigh

> How should I refactor the auth module?
[plan produced — every LLM call inside this run uses LADDER[0]]

[dialog appears]
Plan ready — what next?
  > Execute the plan
    Refine — stay in plan mode
    Cancel — leave plan mode

> Execute the plan
[exec phase begins, first LLM call uses LADDER[1], next [2], next [3], ...
 last rung repeats. When done, status snaps back to LADDER[0]]

> also add tests for it
[user follow-up — first LLM call uses LADDER[0] (user-facing), then steps
 down through LADDER[1], LADDER[2], ... again]
```

The status line at the bottom shows the live cursor:
`▶ exec [2] openai-proxy/gpt-5.5:high (3/5)`.

### Commands

| Command          | What it does |
|------------------|--------------|
| `/plan`          | Enter plan mode, restrict to read-only tools, bind provider for the upcoming runs |
| `/stepdown`      | Print the ladder with the current cursor position |
| `/stepdown-off`  | Exit plan/execute mode, restore full tools |

### State machine summary

In addition to the stage counter, the extension also supports **one-shot reasoning bumps**
inside executing mode: when certain tool results arrive (e.g. failing bash, npm/pnpm/yarn/bun
output), the *next* LLM call temporarily uses `LADDER[1]` (or `LADDER[0]` if the ladder has
only one rung). After a bumped turn, the stage cursor continues at the rung *after* the bump (so a bump on `LADDER[1]` continues at `LADDER[2]`).

| Event                                  | Stage transition                              |
|----------------------------------------|-----------------------------------------------|
| `/plan`                                | `mode=planning, stage=0`                      |
| Every LLM call (planning)              | uses `LADDER[0]` regardless of stage          |
| Plan accepted                          | `mode=executing, stage=1`                     |
| `turn_end` during executing            | `stage = min(stage+1, LADDER.length-1)`       |
| `tool_result` trigger (executing)      | queue bump for next LLM call (resets cursor)  |
| Aborted turn                           | stage NOT advanced (so /resume picks up here) |
| `agent_end` during executing           | `stage=0` (reset for next user prompt)        |
| `/plan` again, or `/stepdown-off`      | reset                                         |

## Prompt caching (OpenAI)

OpenAI automatically caches long prompt prefixes, which can reduce latency and input token costs.
Cache hits require **exact prefix matches** and typically only apply once prompts exceed ~1024 tokens.

This extension tries to improve cache affinity for OpenAI-compatible backends in a conservative way:

- It keeps pi/provider-provided cache fields if they already exist.
- If missing, it injects `prompt_cache_key` based on a stable hash of the local username + current working directory (cwd).
- It optionally requests extended retention via `prompt_cache_retention: "24h"`.

### Configuration

In `.pi/extensions/plan-stepdown/index.ts`:

- `OPENAI_PROMPT_CACHE_KEY_PREFIX`: defaults to `"pi-model-staging:"`.
- `OPENAI_PROMPT_CACHE_RETENTION`: defaults to `"24h"`.
  - Set it to `undefined` if your proxy rejects the field.
  - We intentionally do **not** force an explicit in-memory value because different OpenAI SDK versions historically used different spellings (`in_memory` vs `in-memory`).

### Caveats

- Prompt caches are per-organization and per-model/backend. Stepping down across different model IDs (e.g. `gpt-5.5` → `gpt-5.4`) will not share KV cache.
- If you send >~15 req/min for the same prefix+key, OpenAI may overflow-route and reduce cache effectiveness.

### Monitoring

Check OpenAI usage fields (`cached_tokens`), or in pi watch session stats:
- `cacheRead` tokens increase on cache hits (for providers that report it).

## Tests

```bash
npm test
```

Runs 42 unit tests via Node's built-in test runner with type stripping
(no extra deps). Coverage:

- API detection: OpenAI Responses / OpenAI Completions / Anthropic adaptive /
  Anthropic budget / Google / unknown payloads
- Payload rewriting per API: model + reasoning swap, no input mutation,
  graceful degradation on unknown payloads
- `chooseRung` mode/stage dispatch including clamping
- OpenAI prompt-cache key/retention augmentation
- Reasoning bump trigger detection and post-bump stage advancement
- **End-to-end lifecycle**: simulates a full plan run → accept → exec run
  with stepping → agent_end reset → user follow-up → second reset, and
  asserts the exact sequence of model + effort values that hits the wire
  at every LLM call

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
The dialog is gated on `ctx.hasUI`. In non-interactive modes you'll need
to flip phases manually with another extension or by re-prompting after
the plan finishes.

## Limitations

- All rungs must be on the same provider (architectural — see "Same-provider
  constraint" above).
- Anthropic budget thinking and Google models swap `model` only; the
  thinking budget is left alone. Use adaptive Anthropic models or set
  explicit budgets in your proxy if you need per-turn budget control.
- The state we persist across `/resume` is `mode + stage`. One-shot bump
  state is intentionally in-memory only. The state machine resumes correctly
  but the auto-injected `EXEC_FIRST_PROMPT` fires only once per accept, not
  on resume.
- `setModel()` is called only at `/plan`, so re-entering `/plan` after a
  long executing session will re-bind the provider but pi's display may
  still lag for a moment until the next turn.

## How this extension is built

If you want to fork or learn from it:

- [.pi/extensions/plan-stepdown/index.ts](.pi/extensions/plan-stepdown/index.ts)
  — event subscriptions, mode/state, command registration.
- [.pi/extensions/plan-stepdown/rewrite.ts](.pi/extensions/plan-stepdown/rewrite.ts)
  — pure functions for API detection and payload rewriting. Zero pi
  imports so it's testable in isolation.
- [.pi/extensions/plan-stepdown/rewrite.test.ts](.pi/extensions/plan-stepdown/rewrite.test.ts)
  — 42 unit tests with realistic payload fixtures, prompt-cache coverage,
  reasoning-bump coverage, and full lifecycle simulation.

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
is a good reference for the plan/execute UX pattern this extension extends.

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
