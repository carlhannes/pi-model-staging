# pi-model-staging

A [pi](https://pi.dev) extension that adds a **plan-then-execute** workflow
with a configurable **model ladder** — step the model and/or thinking level
down on each LLM call (or each user prompt) inside a single conversation.

Use cases:
- Burn `xhigh` thinking on the first turn of a task, step down so the boring
  follow-up tool calls don't pay for full reasoning.
- Use a "priority" / fast endpoint while you're shaping the plan, then a
  cheaper endpoint while the agent is grinding through it.
- Route different model names to different backend tiers via your own proxy.

## How it works

Two independent ladders, both active at once:

| Ladder        | Hook                       | Granularity            | Cross-provider? |
|---------------|----------------------------|------------------------|-----------------|
| **Per-run**   | `before_agent_start`       | One rung per user prompt | Yes           |
| **Per-turn**  | `before_provider_request`  | One rung per LLM call   | **No** — same provider only |

Why two: pi captures `model` and `reasoning` once when it builds
`AgentLoopConfig` ([agent.ts:413](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent.ts#L413))
and reuses them for every turn inside one agent run. Calling `pi.setModel()`
mid-loop never reaches the in-flight request — it only takes effect on the
*next* `agent.prompt()` call. So:

- **Per-run** uses the documented `pi.setModel()` / `pi.setThinkingLevel()`
  API and switches anything (provider, baseUrl, API key) freely.
- **Per-turn** rewrites the serialized wire payload at
  `before_provider_request` ([sdk.ts:345](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/sdk.ts#L345)),
  changing `model` and `reasoning_effort` / `reasoning.effort` /
  `output_config.effort` depending on the API. The HTTP client is built
  *before* this hook fires, so `baseUrl` + `apiKey` stay locked to the
  per-run model — same provider only.

If you need cross-provider per-turn swaps, that requires a small upstream
patch to pi-mono (`createLoopConfig` → getter style). Not included here; see
the comment block at the top of `index.ts` for the full reasoning.

## Requirements

- [pi](https://pi.dev) (any recent version supporting the extension API —
  tested against pi-mono `main` as of May 2026)
- Node.js 22+ (only for running the test suite — pi itself bundles its own
  runtime via [jiti](https://github.com/unjs/jiti))
- Provider with one of the supported APIs:
  - OpenAI Responses (full support: model + reasoning effort)
  - OpenAI Completions (full support)
  - Anthropic adaptive thinking (model + effort via `output_config`)
  - Anthropic budget thinking (model only — budget is left untouched)
  - Google generative AI (model only — budget is left untouched)

## Install

### As a pi package (recommended)

```bash
# Project-local — adds to .pi/settings.json
pi install -l git:github.com/<your-org>/pi-model-staging

# Global — adds to ~/.pi/agent/settings.json
pi install git:github.com/<your-org>/pi-model-staging

# Try once without persisting
pi -e git:github.com/<your-org>/pi-model-staging
```

Pi reads the `pi.extensions` field from this repo's `package.json` and loads
the extension automatically. You'll need to fork/edit the ladders in
`index.ts` for your own model setup — see [Configuration](#configuration).

### From a local clone

```bash
git clone https://github.com/<your-org>/pi-model-staging
cd pi-model-staging
# Edit ladders in .pi/extensions/plan-stepdown/index.ts to match your models
pi   # auto-discovers .pi/extensions/ when run from the project root
```

### Symlink for global use

```bash
git clone https://github.com/<your-org>/pi-model-staging
ln -s "$(pwd)/pi-model-staging/.pi/extensions/plan-stepdown" \
      ~/.pi/agent/extensions/plan-stepdown
```

### Verify

Inside `pi`, run `/help` and you should see `/plan`, `/stepdown`, and
`/stepdown-off`. If they're missing, check `pi --debug` startup logs for
extension load errors.

## Configuration

Open [.pi/extensions/plan-stepdown/index.ts](.pi/extensions/plan-stepdown/index.ts)
and edit the four ladders near the top:

```ts
// Per-run: one rung per user prompt. Can change provider freely.
const PLAN_RUN_LADDER: RunRung[] = [
    { provider: "openai-priority", modelId: "gpt-5.5", thinking: "xhigh" },
    { provider: "openai-priority", modelId: "gpt-5.5", thinking: "high" },
];

const EXEC_RUN_LADDER: RunRung[] = [
    { provider: "openai", modelId: "gpt-5.5", thinking: "xhigh" },
    { provider: "openai", modelId: "gpt-5.5", thinking: "high" },
    { provider: "openai", modelId: "gpt-5.4", thinking: "xhigh" },
    { provider: "openai", modelId: "gpt-5.4", thinking: "high" },
];

// Per-turn: one rung per LLM call inside a run. Same provider only.
const PLAN_TURN_LADDER: TurnRung[] = [
    { modelId: "gpt-5.5", thinking: "xhigh" },
    { modelId: "gpt-5.5", thinking: "high" },
    { modelId: "gpt-5.5", thinking: "medium" },
];

const EXEC_TURN_LADDER: TurnRung[] = [
    { modelId: "gpt-5.5", thinking: "xhigh" },
    { modelId: "gpt-5.5", thinking: "high" },
    { modelId: "gpt-5.4", thinking: "xhigh" },
    { modelId: "gpt-5.4", thinking: "high" },
];
```

### Field reference

**`RunRung`** (per-run)
- `provider` — string. Must match a provider known to pi (`pi --list-models`
  shows them, including custom ones from `~/.pi/agent/models.json`).
- `modelId` — string. Must match a model ID for that provider.
- `thinking` — `"minimal" | "low" | "medium" | "high" | "xhigh"`. Auto-clamped
  to model capabilities (e.g. setting `xhigh` on a model that only supports
  `high` will silently drop to `high`).

**`TurnRung`** (per-turn)
- Same as `RunRung` minus `provider` (see same-provider constraint above).

### Model and provider names

Run `pi --list-models` to see what's available. Custom providers (Ollama,
vLLM, LM Studio, your own proxy) configured in `~/.pi/agent/models.json`
work exactly the same — see [pi's models docs](https://pi.dev/docs/latest/models)
and [custom provider docs](https://pi.dev/docs/latest/custom-provider).

### Tools allowed in plan vs execute

Edit `PLAN_TOOLS` / `EXEC_TOOLS` if the defaults don't match your tool set.
Default plan-mode tools are read-only: `read`, `bash`, `grep`, `find`, `ls`.
Default execute tools add `edit` and `write`.

### System-prompt nudges

Edit `PLAN_PROMPT` and `EXEC_FIRST_PROMPT` to change the messages that get
injected at the start of plan / execute phases.

## Usage

```
> /plan
plan-stepdown: Plan mode ON. Next prompt: run rung openai-priority/gpt-5.5:xhigh ·
turn rung gpt-5.5:xhigh

> How should I refactor the auth module?
[plan produced — ladder ticks per LLM call]

[dialog appears]
Plan ready — what next?
  > Execute the plan
    Refine — stay in plan mode (advances ladders)
    Cancel — leave plan mode

> Execute the plan
[exec phase begins, EXEC_RUN_LADDER[0] applied, EXEC_TURN_LADDER walks each LLM call]
```

The status line at the bottom shows live ladder positions:
`▶ exec run 1/4 openai/gpt-5.5:xhigh · turn 3/4 gpt-5.4:xhigh`.

### Commands

| Command          | What it does |
|------------------|--------------|
| `/plan`          | Enter plan mode, restrict to read-only tools, queue `PLAN_RUN_LADDER[0]` for next prompt |
| `/stepdown`      | Print the active ladders with the current cursor position |
| `/stepdown-off`  | Exit plan/execute mode, restore full tools |

### How rungs advance

- `agent_start` → reset per-turn counter (`planTurn` / `execTurn` = 0)
- `before_agent_start` → apply per-run rung at index `planRun`/`execRun`,
  then increment that counter
- `before_provider_request` → apply per-turn rung at index
  `planTurn`/`execTurn` (does not increment — increment happens at
  `turn_end`)
- `turn_end` → increment per-turn counter, but **not** if the turn was
  aborted (so `/resume` picks up at the same rung)

The last rung repeats forever — a 4-rung ladder over 100 turns just stays at
rung 4.

## Tests

```bash
npm test
```

Runs 24 unit tests via Node's built-in test runner with type stripping
(no extra deps). Coverage:

- API detection: OpenAI Responses / OpenAI Completions / Anthropic adaptive /
  Anthropic budget / Google / unknown payloads
- Payload rewriting per API: model + reasoning swap, no input mutation,
  graceful degradation on unknown payloads
- Ladder clamping: empty / past end / negative
- Mode-aware rung selection (`chooseRung`)
- End-to-end: 5-turn execution with a 4-rung ladder, asserting model and
  effort sequence including clamp at the end

The pure logic lives in [rewrite.ts](.pi/extensions/plan-stepdown/rewrite.ts) (no pi imports),
so tests run without pi or any LLM API keys.

## Troubleshooting

**`plan-stepdown: model X/Y not found`**
The provider/model name in your ladder doesn't match what's in
`pi --list-models`. Fix the typo, or register a custom provider in
`~/.pi/agent/models.json`. The extension resets to idle on this error so it
won't keep firing.

**`plan-stepdown: no API key configured for X`**
Run `pi auth login` for that provider, or set the env var (see
[pi-mono/packages/ai/src/env-api-keys.ts](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/env-api-keys.ts)
for the var names per provider).

**Per-turn rung doesn't seem to apply**
Confirm the per-run model and the per-turn `modelId` are on the same
provider (same `provider` field in `pi --list-models`). If the per-run model
is `openai/gpt-5.5` and the per-turn rung says `modelId: "anthropic-model"`,
the request still goes to OpenAI's endpoint with the OpenAI key — wrong
shape, wrong destination.

**Status widget doesn't appear**
The widget needs an interactive TUI. In `pi --print` / `--mode json` /
`--mode rpc`, the widget is suppressed but the model swaps still happen.

**`pi.setModel failed for ...`**
Usually means auth wasn't configured for that provider. Surface the full
error from your terminal — it's forwarded from `setModel`'s thrown error.

**Plan-ready dialog never appears**
The dialog is gated on `ctx.hasUI`. In non-interactive modes you'll need to
flip phases manually with another extension or by re-prompting after the
plan finishes.

## Limitations

- Per-turn ladders are same-provider only (architectural — see top of file).
- Anthropic budget thinking and Google models swap `model` only; the thinking
  budget is left alone. Use adaptive Anthropic models or set explicit budgets
  in your proxy if you need per-turn budget control.
- Refining a plan keeps advancing both ladders. If you want refinement to
  reset to the top of the plan ladder, edit the `agent_end` handler in
  `index.ts` — three lines.
- The state we persist across `/resume` is `mode + planRun + execRun`. The
  per-turn counters reset on every agent run anyway, so they're not stored.

## How this extension is built

If you want to fork or learn from it:

- [.pi/extensions/plan-stepdown/index.ts](.pi/extensions/plan-stepdown/index.ts)
  — event subscriptions, mode/state, command registration.
- [.pi/extensions/plan-stepdown/rewrite.ts](.pi/extensions/plan-stepdown/rewrite.ts)
  — pure functions for API detection and payload rewriting. Zero pi imports
  so it's testable in isolation.
- [.pi/extensions/plan-stepdown/rewrite.test.ts](.pi/extensions/plan-stepdown/rewrite.test.ts)
  — 24 unit tests with realistic payload fixtures.

The pi APIs used are documented at:
- [pi extensions guide](https://pi.dev/docs/latest/extensions)
- [pi packages guide](https://pi.dev/docs/latest/packages)
- [extension type definitions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [`before_agent_start` emit site](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts#L1067)
- [`before_provider_request` plumbing](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/sdk.ts#L345)
- [`createLoopConfig`](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent.ts#L410)
  — explains why per-turn swaps need payload rewriting

The existing upstream [plan-mode example](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/plan-mode)
is a good reference for the plan/execute UX pattern this extension extends.

## Contributing

Issues and PRs welcome. The change surface is small:

- Logic changes go in `rewrite.ts` with corresponding tests in
  `rewrite.test.ts`. Run `npm test` before sending a PR.
- Pi-API integration lives in `index.ts`. There are no integration tests for
  this layer — verify by running `pi` locally and watching the status
  widget plus your provider's request logs.

If you add support for a new API family, add a fixture and a detection test
to `rewrite.test.ts`. The fixture should mirror what the corresponding
provider in [pi-mono's `packages/ai/src/providers/`](https://github.com/badlogic/pi-mono/tree/main/packages/ai/src/providers)
actually sends on the wire.

## License

MIT — see [LICENSE](LICENSE).

This extension is independent of pi but builds on its public extension API.
pi itself is also MIT-licensed
([badlogic/pi-mono](https://github.com/badlogic/pi-mono)).
