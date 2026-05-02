# pi-model-staging

A pi extension that adds a **plan-then-execute** mode with two layers of model
"stepdown":

- **Per-run ladder** — applied at `before_agent_start`. One rung per user
  prompt. Can change provider freely.
- **Per-turn ladder** — applied at `before_provider_request`. One rung per
  LLM call inside a single agent run. **Same provider only** (see "Why
  same-provider only" below).

You can use either layer or both. Edit the four ladders at the top of
[.pi/extensions/plan-stepdown/index.ts](.pi/extensions/plan-stepdown/index.ts).

## Why two layers

pi captures `model` and `reasoning` once when it builds `AgentLoopConfig`
([pi-mono/packages/agent/src/agent.ts:413](pi-mono/packages/agent/src/agent.ts:413)) and reuses them for every turn
inside one agent run. So calling `pi.setModel()` mid-loop never reaches the
in-flight request — it only takes effect on the next `agent.prompt()` call.

To step the model **inside** a single agent run we hook
`before_provider_request`, which fires right before the wire request is sent
([pi-mono/packages/coding-agent/src/core/sdk.ts:345](pi-mono/packages/coding-agent/src/core/sdk.ts:345)). We rewrite the
serialized payload — `model` and `reasoning_effort` / `reasoning.effort` /
`output_config.effort` depending on the API — to whatever the per-turn rung
says.

## Why same-provider only (per-turn)

The HTTP client is built **before** `before_provider_request` runs. See e.g.
[pi-mono/packages/ai/src/providers/anthropic.ts:466](pi-mono/packages/ai/src/providers/anthropic.ts:466). It binds
`baseUrl`, `apiKey`, and headers from the per-run model. If you rewrite the
payload to reference a model on a different provider, the request still goes
to the original provider's endpoint with the original key — wrong.

The per-run ladder has no such constraint and can hop providers freely.

If you want true per-turn cross-provider swaps, the cleanest fix is a small
patch to `createLoopConfig` in pi-mono — see "Approach B" in the answer
history. Not implemented here.

## Install

The extension lives at [.pi/extensions/plan-stepdown/](.pi/extensions/plan-stepdown/) — pi auto-discovers it
when run from this directory. No `npm install` needed; pi resolves the
`@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai` imports itself.

To use globally:

```bash
ln -s "$(pwd)/.pi/extensions/plan-stepdown" ~/.pi/agent/extensions/plan-stepdown
```

## Usage

In the pi prompt:

```
/plan
> How should I refactor the auth module?
```

The first prompt uses `PLAN_RUN_LADDER[0]` overall, with each LLM call
inside it stepping through `PLAN_TURN_LADDER`. When the model finishes
producing a plan, you'll get a "Plan ready" dialog:

- **Execute the plan** — flips to executing, restarts at `EXEC_RUN_LADDER[0]`
  and `EXEC_TURN_LADDER[0]`. The next prompt's first LLM call uses
  `EXEC_TURN_LADDER[0]`, second uses `[1]`, etc.
- **Refine** — stays in plan mode; advances ladders.
- **Cancel** — back to idle.

Useful commands:

- `/stepdown` — show current ladder positions
- `/stepdown-off` — exit plan/exec mode

## Configuring ladders

Open [.pi/extensions/plan-stepdown/index.ts](.pi/extensions/plan-stepdown/index.ts) and edit:

```ts
const EXEC_RUN_LADDER: RunRung[] = [
    { provider: "openai", modelId: "gpt-5.5", thinking: "xhigh" },
    // ...
];

const EXEC_TURN_LADDER: TurnRung[] = [
    { modelId: "gpt-5.5", thinking: "xhigh" },   // first LLM call of every exec run
    { modelId: "gpt-5.5", thinking: "high" },    // second
    { modelId: "gpt-5.4", thinking: "xhigh" },   // third
    { modelId: "gpt-5.4", thinking: "high" },    // fourth+
];
```

Provider/model IDs must match `pi --list-models`. The last rung repeats
forever, so a 4-rung ladder over 100 turns just stays at rung 4.

## Tests

The payload-rewrite logic is in a separate pure module
([rewrite.ts](.pi/extensions/plan-stepdown/rewrite.ts)) so it can be tested without pi or any LLM.

```bash
npm test
```

Runs 24 tests covering: API detection (OpenAI Responses / OpenAI Completions
/ Anthropic adaptive / Anthropic budget / Google / unknown), payload
rewriting per API, ladder clamping, mode-aware rung selection, and a 5-turn
end-to-end walk through a ladder.

## Reference

The local clone of pi-mono in [pi-mono/](pi-mono/) (gitignored) is kept as a
reference. Key files this extension uses or relies on:

- [pi-mono/packages/coding-agent/docs/extensions.md](pi-mono/packages/coding-agent/docs/extensions.md) — extension API surface
- [pi-mono/packages/coding-agent/src/core/extensions/types.ts](pi-mono/packages/coding-agent/src/core/extensions/types.ts) — typed event/API definitions
- [pi-mono/packages/coding-agent/src/core/sdk.ts:345](pi-mono/packages/coding-agent/src/core/sdk.ts:345) — `before_provider_request` plumbing
- [pi-mono/packages/coding-agent/src/core/agent-session.ts:1067](pi-mono/packages/coding-agent/src/core/agent-session.ts:1067) — `before_agent_start` emit before `agent.prompt()`
- [pi-mono/packages/agent/src/agent.ts:410](pi-mono/packages/agent/src/agent.ts:410) — `createLoopConfig` capturing `state.model` (the reason per-turn swaps need payload rewriting)
- [pi-mono/packages/ai/src/providers/openai-responses.ts:217](pi-mono/packages/ai/src/providers/openai-responses.ts:217) — example payload shape
- [pi-mono/packages/coding-agent/examples/extensions/plan-mode/](pi-mono/packages/coding-agent/examples/extensions/plan-mode/) — upstream plan-mode example
