/**
 * plan-stepdown
 *
 * Plan-then-execute mode for pi, with a hand-rolled "model ladder" that steps
 * the model and/or thinking level down on each agent run (= each user prompt
 * the agent processes).
 *
 * Two independent ladders, you edit them below:
 *   PLAN_LADDER  — used while you're shaping the plan (read-only tools)
 *   EXEC_LADDER  — used after you accept the plan (full tools)
 *
 * Each ladder is a list of "rungs". Rung 0 is the first prompt in that phase,
 * rung 1 the second, etc. The last rung repeats forever, so you can keep
 * iterating without falling off the end.
 *
 * Why per-prompt and not per-LLM-call:
 *   pi's agent loop captures `model` and `reasoning` ONCE per run when it
 *   builds AgentLoopConfig (see pi-mono/packages/agent/src/agent.ts:413). The
 *   config is then reused for every turn inside that run. before_agent_start
 *   fires BEFORE that config is built (agent-session.ts:1067-1104), so it's
 *   the only clean seam where a model swap is guaranteed to take effect for
 *   the upcoming run. Stepping down mid-task would also tend to produce worse
 *   output — the model is partway through a coherent piece of work — so this
 *   is also the seam you actually want.
 *
 * Use cases:
 *   - "Priority"/fast provider for planning, slower/cheaper one for execution.
 *   - Burn xhigh thinking on the first execution prompt, step down so cheaper
 *     follow-ups don't pay for full reasoning.
 *
 * Commands:
 *   /plan          — enter plan mode at PLAN_LADDER[0], lock to read-only tools
 *   /stepdown      — show the current ladder position
 *   /stepdown-off  — leave plan/exec mode and stop swapping models
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Configure your ladders here. Edit freely.
//
// `provider` and `modelId` must match what `pi --list-models` prints. Custom
// providers configured in ~/.pi/agent/models.json work too. Set EXEC_LADDER[0]
// equal to PLAN_LADDER[0] if you want "first call after plan accepted to use
// the same model as planning".
// ---------------------------------------------------------------------------

type Rung = {
	provider: string;
	modelId: string;
	thinking: ThinkingLevel; // "minimal" | "low" | "medium" | "high" | "xhigh"
};

const PLAN_LADDER: Rung[] = [
	// Snappy / priority provider while you're shaping the plan.
	{ provider: "openai-priority", modelId: "gpt-5.5", thinking: "xhigh" },
	{ provider: "openai-priority", modelId: "gpt-5.5", thinking: "high" },
];

const EXEC_LADDER: Rung[] = [
	// First exec prompt mirrors plan rung 0 (same model/level), so the model
	// "carries the thought" into execution. Then we step down.
	{ provider: "openai", modelId: "gpt-5.5", thinking: "xhigh" },
	{ provider: "openai", modelId: "gpt-5.5", thinking: "high" },
	{ provider: "openai", modelId: "gpt-5.4", thinking: "xhigh" },
	{ provider: "openai", modelId: "gpt-5.4", thinking: "high" },
];

// Tools available during planning. The agent literally cannot edit/write here.
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls"];
// Restored when execution starts.
const EXEC_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// Injected as the first message of each plan/exec run.
const PLAN_PROMPT = `[PLAN MODE]
You are in plan mode. Do not modify any files.

Produce a numbered plan under a heading "Plan:" — one short line per step.
Ask clarifying questions before guessing. Stop when the plan is ready; the
user will accept it before you start executing.`;

const EXEC_FIRST_PROMPT = `[EXECUTING PLAN]
Execute the plan you just produced. Edit/write tools are available again.`;

// ---------------------------------------------------------------------------

type Mode = "idle" | "planning" | "executing";

export default function planStepdownExtension(pi: ExtensionAPI): void {
	let mode: Mode = "idle";
	// How many runs we've STARTED in each phase (== index of next rung).
	let planRun = 0;
	let execRun = 0;

	function rungAt(ladder: Rung[], idx: number): Rung {
		return ladder[Math.min(idx, ladder.length - 1)];
	}

	function rungLabel(r: Rung): string {
		return `${r.provider}/${r.modelId}:${r.thinking}`;
	}

	async function applyRung(rung: Rung, ctx: ExtensionContext): Promise<boolean> {
		const model = ctx.modelRegistry.find(rung.provider, rung.modelId);
		if (!model) {
			ctx.ui.notify(
				`plan-stepdown: model ${rung.provider}/${rung.modelId} not found — fix the ladder or run pi --list-models`,
				"error",
			);
			return false;
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			ctx.ui.notify(`plan-stepdown: no API key configured for ${rung.provider}`, "error");
			return false;
		}
		try {
			const ok = await pi.setModel(model);
			if (!ok) return false;
		} catch (err) {
			ctx.ui.notify(
				`plan-stepdown: setModel failed for ${rungLabel(rung)}: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return false;
		}
		// setModel re-clamps thinking automatically; setting again pins it to
		// what the rung asked for (still clamped to model capabilities).
		pi.setThinkingLevel(rung.thinking);
		return true;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (mode === "planning") {
			const r = rungAt(PLAN_LADDER, planRun);
			const idx = Math.min(planRun, PLAN_LADDER.length - 1);
			ctx.ui.setStatus(
				"plan-stepdown",
				ctx.ui.theme.fg("warning", `📋 plan ${idx + 1}/${PLAN_LADDER.length} ${rungLabel(r)}`),
			);
		} else if (mode === "executing") {
			const r = rungAt(EXEC_LADDER, execRun);
			const idx = Math.min(execRun, EXEC_LADDER.length - 1);
			ctx.ui.setStatus(
				"plan-stepdown",
				ctx.ui.theme.fg("accent", `▶ exec ${idx + 1}/${EXEC_LADDER.length} ${rungLabel(r)}`),
			);
		} else {
			ctx.ui.setStatus("plan-stepdown", undefined);
		}
	}

	function persist(): void {
		pi.appendEntry("plan-stepdown-state", { mode, planRun, execRun });
	}

	function reset(ctx: ExtensionContext): void {
		mode = "idle";
		planRun = 0;
		execRun = 0;
		pi.setActiveTools(EXEC_TOOLS);
		updateStatus(ctx);
		persist();
	}

	// -------------------------------------------------------------------------
	// /plan — enter plan mode, restrict tools, prepare rung 0 of PLAN_LADDER
	// -------------------------------------------------------------------------
	pi.registerCommand("plan", {
		description: "Enter plan mode — read-only tools, top of PLAN_LADDER",
		handler: async (_args, ctx) => {
			mode = "planning";
			planRun = 0;
			execRun = 0;
			pi.setActiveTools(PLAN_TOOLS);
			// Don't apply the rung here — before_agent_start will apply it the
			// moment the user actually submits a prompt. We just stage state.
			updateStatus(ctx);
			persist();
			ctx.ui.notify(
				`Plan mode ON. Next prompt will use ${rungLabel(rungAt(PLAN_LADDER, 0))}`,
				"info",
			);
		},
	});

	pi.registerCommand("stepdown", {
		description: "Show current plan-stepdown ladder position",
		handler: async (_args, ctx) => {
			if (mode === "idle") {
				ctx.ui.notify("plan-stepdown: idle. Run /plan to start.", "info");
				return;
			}
			const ladder = mode === "planning" ? PLAN_LADDER : EXEC_LADDER;
			const idx = Math.min(mode === "planning" ? planRun : execRun, ladder.length - 1);
			const lines = ladder.map((r, i) => {
				const marker = i === idx ? "→" : "  ";
				return `${marker} ${i + 1}. ${rungLabel(r)}`;
			});
			ctx.ui.notify(`${mode.toUpperCase()} ladder:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("stepdown-off", {
		description: "Disable plan-stepdown and restore full tools",
		handler: async (_args, ctx) => {
			reset(ctx);
			ctx.ui.notify("plan-stepdown: off", "info");
		},
	});

	// -------------------------------------------------------------------------
	// before_agent_start: THE seam. Fires after the user submits a prompt and
	// before pi builds AgentLoopConfig (which captures model/reasoning for the
	// whole run). We swap the model here, advance the counter, and inject the
	// phase-specific nudge.
	// -------------------------------------------------------------------------
	pi.on("before_agent_start", async (_event, ctx) => {
		if (mode === "idle") return;

		const ladder = mode === "planning" ? PLAN_LADDER : EXEC_LADDER;
		const idx = mode === "planning" ? planRun : execRun;
		const rung = rungAt(ladder, idx);

		const ok = await applyRung(rung, ctx);
		if (!ok) {
			// Bad rung — bail to idle so the user gets ONE clear error, not one
			// per prompt. They can fix the ladder and run /plan again.
			reset(ctx);
			return;
		}

		// Advance ladder so the NEXT prompt picks the next rung.
		if (mode === "planning") planRun += 1;
		else execRun += 1;

		updateStatus(ctx);
		persist();

		// Inject phase nudge as a custom message on the first run of each phase.
		// Returning a `message` from before_agent_start prepends it before the
		// user's actual prompt is processed.
		if (mode === "planning" && idx === 0) {
			return {
				message: { customType: "plan-stepdown-context", content: PLAN_PROMPT, display: false },
			};
		}
		if (mode === "executing" && idx === 0) {
			return {
				message: { customType: "plan-stepdown-context", content: EXEC_FIRST_PROMPT, display: false },
			};
		}
	});

	// -------------------------------------------------------------------------
	// agent_end: if we just finished a planning run, ask the user to accept
	// the plan. On accept, flip to executing and trigger a new agent run with
	// "Execute the plan." — that fresh run goes through before_agent_start
	// again and picks up EXEC_LADDER[0].
	// -------------------------------------------------------------------------
	pi.on("agent_end", async (_event, ctx) => {
		if (mode !== "planning") return;
		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select("Plan ready — what next?", [
			"Execute the plan",
			"Refine — stay in plan mode (advances ladder)",
			"Cancel — leave plan mode",
		]);

		if (choice === "Execute the plan") {
			mode = "executing";
			execRun = 0;
			pi.setActiveTools(EXEC_TOOLS);
			updateStatus(ctx);
			persist();
			pi.sendMessage(
				{ customType: "plan-stepdown-execute", content: "Execute the plan.", display: true },
				{ triggerTurn: true },
			);
		} else if (choice === "Cancel — leave plan mode") {
			reset(ctx);
		}
		// Refine: do nothing. Mode stays "planning"; next user prompt advances
		// PLAN_LADDER. If the user wants to jump back to rung 0 for a refinement,
		// they can run /plan again.
	});

	// -------------------------------------------------------------------------
	// session_start: restore counters across resume so /resume continues from
	// the right rung.
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plan-stepdown-state",
			)
			.pop() as { data?: { mode: Mode; planRun: number; execRun: number } } | undefined;
		if (last?.data) {
			mode = last.data.mode;
			planRun = last.data.planRun;
			execRun = last.data.execRun;
			if (mode === "planning") pi.setActiveTools(PLAN_TOOLS);
			updateStatus(ctx);
		}
	});
}
