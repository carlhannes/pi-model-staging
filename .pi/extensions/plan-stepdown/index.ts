/**
 * plan-stepdown
 *
 * Plan-then-execute mode for pi with a single configurable model ladder.
 *
 * One ladder. One counter. One mental model:
 *
 *   LADDER[0]   "snappy / user-facing tier" (e.g. gpt-5.5:quick)
 *               used while the user is in control:
 *               - every LLM call inside plan mode
 *               - the first turn of any user follow-up prompt during
 *                 executing (the LLM responding directly to the user)
 *
 *   LADDER[1]   "first autonomous step" (e.g. gpt-5.5 xhigh)
 *               used for the first LLM call after the plan is accepted
 *               (the auto-injected "Execute the plan." run), and then for
 *               turn 2 of each user follow-up.
 *
 *   LADDER[2..] cheaper / weaker — used while the agent is working by
 *               itself inside one run (turn 3, 4, 5...). Last rung repeats
 *               forever once you're past the end.
 *
 * Stepping only happens while the agent is "working by itself" inside
 * one run. As soon as the run ends and control returns to the user
 * (agent_end during executing), the stage resets so the next prompt
 * starts at the snappy tier again.
 *
 * How the swap actually happens:
 *
 *   • setModel() runs exactly twice per plan→exec cycle: once at /plan,
 *     once when you accept the plan. This binds the provider/baseUrl/auth
 *     for the agent run that follows.
 *
 *   • before_provider_request rewrites the wire payload's `model` and
 *     `reasoning.effort` (or `reasoning_effort` etc, depending on API) on
 *     every single LLM call so the actual model and thinking level match
 *     LADDER[stage]. This is what enables stepping inside one agent run —
 *     pi captures `model` once per run into AgentLoopConfig
 *     (pi-mono/packages/agent/src/agent.ts:413), so we have to rewrite the
 *     serialized request to step within a run.
 *
 * Same-provider constraint: every rung must be on PROVIDER. The HTTP
 * client is built before before_provider_request runs (e.g.
 * pi-mono/packages/ai/src/providers/anthropic.ts:466), binding baseUrl
 * and apiKey to the per-run model. Rewriting the payload to a different
 * provider's model still sends the request to the original endpoint with
 * the wrong key.
 *
 * Commands:
 *   /plan          — enter plan mode, lock to read-only tools
 *   /stepdown      — show the ladder with the cursor
 *   /stepdown-off  — leave plan/exec mode, restore full tools
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { applyRungToPayload, chooseRung, type Mode, type Rung } from "./rewrite.js";

// ---------------------------------------------------------------------------
// Configure here. Edit freely.
//
// All rungs must be on PROVIDER (see same-provider note above). Provider
// and modelIds must match `pi --list-models`. See models.example.json for
// a matching openai-responses-compatible proxy config.
// ---------------------------------------------------------------------------

const PROVIDER = "openai-proxy";

const LADDER: Rung[] = [
	{ modelId: "gpt-5.5:quick", thinking: "xhigh" }, // [0] plan mode (every LLM call)
	{ modelId: "gpt-5.5", thinking: "xhigh" }, // [1] first call after plan accepted
	{ modelId: "gpt-5.5", thinking: "high" }, // [2]
	{ modelId: "gpt-5.4", thinking: "high" }, // [3]
	{ modelId: "gpt-5.2", thinking: "high" }, // [4]+ (clamps here forever)
];

// Tools available during planning — read-only.
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls"];
const EXEC_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const PLAN_PROMPT = `[PLAN MODE]
You are in plan mode. Do not modify any files.

Produce a numbered plan under a heading "Plan:" — one short line per step.
Ask clarifying questions before guessing. Stop when the plan is ready; the
user will accept it before you start executing.`;

const EXEC_FIRST_PROMPT = `[EXECUTING PLAN]
Execute the plan you just produced. Edit/write tools are available again.`;

// ---------------------------------------------------------------------------

export default function planStepdownExtension(pi: ExtensionAPI): void {
	let mode: Mode = "idle";
	// Single global counter. 0 during planning, set to 1 on accept,
	// incremented at every turn_end during executing (clamped to ladder end).
	let stage = 0;

	function rungLabel(rung: Rung, idx: number): string {
		return `[${idx}] ${PROVIDER}/${rung.modelId}:${rung.thinking}`;
	}

	function activeRungIndex(): number {
		if (mode === "idle") return -1;
		if (mode === "planning") return 0;
		return Math.min(stage, LADDER.length - 1);
	}

	function persist(): void {
		pi.appendEntry("plan-stepdown-state", { mode, stage });
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (mode === "idle") {
			ctx.ui.setStatus("plan-stepdown", undefined);
			return;
		}
		const idx = activeRungIndex();
		const rung = LADDER[idx];
		const color = mode === "planning" ? "warning" : "accent";
		const icon = mode === "planning" ? "📋 plan" : "▶ exec";
		const label = `${icon} ${rungLabel(rung, idx)} (${idx + 1}/${LADDER.length})`;
		ctx.ui.setStatus("plan-stepdown", ctx.ui.theme.fg(color, label));
	}

	async function bindProviderForRung(rung: Rung, ctx: ExtensionContext): Promise<boolean> {
		// Bind the provider/baseUrl/auth for the upcoming agent run by calling
		// setModel. The actual per-LLM-call model/effort is overridden again
		// at before_provider_request, so this just needs to land on a model
		// hosted by PROVIDER.
		const model = ctx.modelRegistry.find(PROVIDER, rung.modelId);
		if (!model) {
			ctx.ui.notify(
				`plan-stepdown: model ${PROVIDER}/${rung.modelId} not found — fix the ladder or run pi --list-models`,
				"error",
			);
			return false;
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			ctx.ui.notify(`plan-stepdown: no API key configured for ${PROVIDER}`, "error");
			return false;
		}
		try {
			const ok = await pi.setModel(model);
			if (!ok) return false;
		} catch (err) {
			ctx.ui.notify(
				`plan-stepdown: setModel failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return false;
		}
		pi.setThinkingLevel(rung.thinking);
		return true;
	}

	function reset(ctx: ExtensionContext): void {
		mode = "idle";
		stage = 0;
		pi.setActiveTools(EXEC_TOOLS);
		updateStatus(ctx);
		persist();
	}

	// -------------------------------------------------------------------------
	// /plan: enter plan mode, bind PROVIDER + LADDER[0], restrict tools.
	// -------------------------------------------------------------------------
	pi.registerCommand("plan", {
		description: "Enter plan mode — read-only tools, LADDER[0] for every call",
		handler: async (_args, ctx) => {
			mode = "planning";
			stage = 0;
			pi.setActiveTools(PLAN_TOOLS);
			const ok = await bindProviderForRung(LADDER[0], ctx);
			if (!ok) {
				reset(ctx);
				return;
			}
			updateStatus(ctx);
			persist();
			ctx.ui.notify(`Plan mode ON. Every LLM call uses ${rungLabel(LADDER[0], 0)}`, "info");
		},
	});

	pi.registerCommand("stepdown", {
		description: "Show the plan-stepdown ladder",
		handler: async (_args, ctx) => {
			if (mode === "idle") {
				ctx.ui.notify("plan-stepdown: idle. Run /plan to start.", "info");
				return;
			}
			const cur = activeRungIndex();
			const lines = LADDER.map((r, i) => {
				const marker = i === cur ? "→" : "  ";
				const tag =
					i === 0
						? "(plan mode)"
						: i === 1
							? "(first call after accept)"
							: i === LADDER.length - 1
								? "(last — repeats)"
								: "";
				return `${marker} ${rungLabel(r, i)} ${tag}`.trim();
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
	// before_agent_start: inject the phase nudge as the first message of each
	// new agent run. Model is already bound (at /plan or at accept).
	// -------------------------------------------------------------------------
	pi.on("before_agent_start", async () => {
		if (mode === "planning") {
			return {
				message: { customType: "plan-stepdown-context", content: PLAN_PROMPT, display: false },
			};
		}
		if (mode === "executing" && stage === 1) {
			// Only inject "executing" prompt at the very first executing turn.
			return {
				message: { customType: "plan-stepdown-context", content: EXEC_FIRST_PROMPT, display: false },
			};
		}
	});

	// -------------------------------------------------------------------------
	// before_provider_request: THE per-LLM-call seam. Rewrite the wire
	// payload's model + reasoning to LADDER[active]. Returning the
	// rewritten payload replaces what gets sent.
	// -------------------------------------------------------------------------
	pi.on("before_provider_request", (event) => {
		const rung = chooseRung(mode, stage, LADDER);
		if (!rung) return;
		return applyRungToPayload(event.payload, rung);
	});

	// -------------------------------------------------------------------------
	// turn_end: advance the stage counter during executing. Don't advance on
	// aborted turns so /resume continues at the same rung.
	// -------------------------------------------------------------------------
	pi.on("turn_end", async (event, ctx) => {
		if (mode !== "executing") return;
		const stop = (event.message as { stopReason?: string } | undefined)?.stopReason;
		if (stop === "aborted") return;

		stage = Math.min(stage + 1, LADDER.length - 1);
		updateStatus(ctx);
		persist();
	});

	// -------------------------------------------------------------------------
	// agent_end: two distinct cases.
	//
	//   planning  → show the accept dialog. On accept, jump stage to 1 so
	//               the auto-injected "Execute the plan." run starts at
	//               LADDER[1] (carrying the plan forward into autonomous
	//               work). On cancel, reset.
	//
	//   executing → control is going back to the user. Reset stage to 0 so
	//               their next prompt starts at the snappy/user-facing
	//               tier again. Stepping only happens inside one run.
	// -------------------------------------------------------------------------
	pi.on("agent_end", async (_event, ctx) => {
		if (mode === "executing") {
			stage = 0;
			updateStatus(ctx);
			persist();
			return;
		}

		if (mode !== "planning") return;
		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select("Plan ready — what next?", [
			"Execute the plan",
			"Refine — stay in plan mode",
			"Cancel — leave plan mode",
		]);

		if (choice === "Execute the plan") {
			mode = "executing";
			stage = 1;
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
		// Refine: do nothing. Mode stays "planning"; LADDER[0] continues to apply.
	});

	// -------------------------------------------------------------------------
	// session_start: restore mode + stage across resume.
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plan-stepdown-state",
			)
			.pop() as { data?: { mode: Mode; stage: number } } | undefined;
		if (last?.data) {
			mode = last.data.mode;
			stage = last.data.stage;
			if (mode === "planning") pi.setActiveTools(PLAN_TOOLS);
			updateStatus(ctx);
		}
	});
}
