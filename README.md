# pi-model-staging

A pi extension that adds a **plan-then-execute** mode with per-prompt model
"stepdown": each LLM call (== each agent run for one user prompt) walks down a
ladder you define — different provider, different model, lower thinking level,
whatever you want.

## Why

You want a snappy "priority" provider while you're shaping the plan, and a
slower/cheaper one once the agent is grinding through it. Or you want xhigh
thinking on the first execution prompt and `high` after. Or both.

## How it works

- `/plan` puts you in plan mode (read-only tools).
- The next prompt you submit uses `PLAN_LADDER[0]`.
- Each subsequent prompt advances the ladder one rung. The last rung repeats.
- When the agent finishes a planning run, you get a "Plan ready" dialog:
  - **Execute the plan** — flips to executing, restarts at `EXEC_LADDER[0]`.
  - **Refine** — stays in plan mode; ladder keeps advancing.
  - **Cancel** — back to idle.
- During executing, each prompt advances `EXEC_LADDER`.
- `/stepdown` shows where you are. `/stepdown-off` resets.

The stepping happens at `before_agent_start`, the only seam where a model swap
is guaranteed to take effect — pi captures the model into `AgentLoopConfig`
once per run (see [pi-mono/packages/agent/src/agent.ts:413](pi-mono/packages/agent/src/agent.ts:413)) and reuses it for every
turn inside that run. So the ladder advances per user prompt, not per
LLM-call-within-a-run. (You probably want it that way anyway — degrading the
model halfway through a coherent task tends to produce worse output.)

## Install

The extension lives at [.pi/extensions/plan-stepdown/index.ts](.pi/extensions/plan-stepdown/index.ts) — a project-local
location pi auto-discovers. Just run `pi` from this directory.

To use it globally:

```bash
ln -s "$(pwd)/.pi/extensions/plan-stepdown" ~/.pi/agent/extensions/plan-stepdown
```

## Configure your ladders

Edit the `PLAN_LADDER` and `EXEC_LADDER` arrays at the top of
[.pi/extensions/plan-stepdown/index.ts](.pi/extensions/plan-stepdown/index.ts). Provider + model IDs must match
`pi --list-models`. Custom providers in `~/.pi/agent/models.json` work too.

## References

The local clone of pi-mono in [pi-mono/](pi-mono/) (gitignored) is kept as a
reference. Everything the extension uses is in:

- [pi-mono/packages/coding-agent/docs/extensions.md](pi-mono/packages/coding-agent/docs/extensions.md) — extension API surface
- [pi-mono/packages/coding-agent/src/core/extensions/types.ts](pi-mono/packages/coding-agent/src/core/extensions/types.ts) — typed event/API definitions
- [pi-mono/packages/coding-agent/src/core/agent-session.ts:1411](pi-mono/packages/coding-agent/src/core/agent-session.ts:1411) — `setModel` impl
- [pi-mono/packages/coding-agent/src/core/agent-session.ts:1067](pi-mono/packages/coding-agent/src/core/agent-session.ts:1067) — `before_agent_start` emit, before `agent.prompt()`
- [pi-mono/packages/agent/src/agent.ts:410](pi-mono/packages/agent/src/agent.ts:410) — `createLoopConfig` capturing `state.model`
- [pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts](pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts) — the upstream plan-mode example we modeled the UX after
