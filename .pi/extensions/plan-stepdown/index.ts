/**
 * plan-stepdown
 *
 * Plan-then-execute mode for pi with two layers of model "stepping":
 *
 *   PER-RUN ladders   — applied at before_agent_start, swap the actual model
 *                       (any provider, any API). Advances per user prompt.
 *   PER-TURN ladders  — applied at before_provider_request, rewrite the wire
 *                       payload's `model` and reasoning fields. Same provider
 *                       only (auth/baseUrl are bound to the per-run model).
 *                       Advances on every LLM call inside one agent run.
 *
 * Why two layers:
 *   pi captures `model` and `reasoning` once per agent run (see
 *   pi-mono/packages/agent/src/agent.ts:413). Calling pi.setModel() mid-loop
 *   does not reach the in-flight request. We work around this by rewriting
 *   the serialized payload at the last possible moment (onPayload, exposed
 *   to extensions as before_provider_request).
 *
 * Same-provider constraint:
 *   The HTTP client is built BEFORE onPayload runs (see e.g.
 *   pi-mono/packages/ai/src/providers/anthropic.ts:466). It binds baseUrl,
 *   apiKey, and headers from the original model. Rewriting the payload to
 *   reference a model on a different provider would still send the request
 *   to the original provider's endpoint with the original key — wrong.
 *   Per-turn ladders therefore must keep the same provider; only `modelId`
 *   and `thinking` should vary.
 *
 * Commands:
 *   /plan          — enter plan mode, top of PLAN ladders, read-only tools
 *   /stepdown      — show current ladder positions
 *   /stepdown-off  — leave plan/exec mode, restore full tools
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel as PiThinkingLevel } from "@mariozechner/pi-ai";
import { applyRungToPayload, chooseRung, type Mode, type TurnRung } from "./rewrite.js";

// ---------------------------------------------------------------------------
// Per-run ladder: one rung per user prompt. Can change provider freely.
// ---------------------------------------------------------------------------

type RunRung = {
	provider: string;
	modelId: string;
	thinking: PiThinkingLevel;
};

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

// ---------------------------------------------------------------------------
// Per-turn ladder: one rung per LLM call inside a run. Same provider only —
// see the long comment at the top of this file.
// ---------------------------------------------------------------------------

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

	// Per-run counters: index of NEXT rung. Used at before_agent_start.
	let planRun = 0;
	let execRun = 0;

	// Per-turn counters: reset on agent_start, incremented at turn_end.
	let planTurn = 0;
	let execTurn = 0;

	function rungLabel(rung: { provider?: string; modelId: string; thinking: PiThinkingLevel }): string {
		const prefix = rung.provider ? `${rung.provider}/` : "";
		return `${prefix}${rung.modelId}:${rung.thinking}`;
	}

	function persist(): void {
		pi.appendEntry("plan-stepdown-state", { mode, planRun, execRun });
	}

	async function applyRunRung(rung: RunRung, ctx: ExtensionContext): Promise<boolean> {
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
				`plan-stepdown: setModel failed for ${rungLabel(rung)}: ${
					err instanceof Error ? err.message : String(err)
				}`,
				"error",
			);
			return false;
		}
		pi.setThinkingLevel(rung.thinking);
		return true;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (mode === "idle") {
			ctx.ui.setStatus("plan-stepdown", undefined);
			return;
		}
		const runLadder = mode === "planning" ? PLAN_RUN_LADDER : EXEC_RUN_LADDER;
		const turnLadder = mode === "planning" ? PLAN_TURN_LADDER : EXEC_TURN_LADDER;
		const runIdx = Math.min(mode === "planning" ? planRun : execRun, runLadder.length - 1);
		const turnIdx = Math.min(mode === "planning" ? planTurn : execTurn, turnLadder.length - 1);
		const runRung = runLadder[runIdx];
		const turnRung = turnLadder[turnIdx];
		const color = mode === "planning" ? "warning" : "accent";
		const icon = mode === "planning" ? "📋 plan" : "▶ exec";
		const label =
			`${icon} run ${runIdx + 1}/${runLadder.length} ${rungLabel(runRung)}` +
			` · turn ${turnIdx + 1}/${turnLadder.length} ${turnRung.modelId}:${turnRung.thinking}`;
		ctx.ui.setStatus("plan-stepdown", ctx.ui.theme.fg(color, label));
	}

	function reset(ctx: ExtensionContext): void {
		mode = "idle";
		planRun = 0;
		execRun = 0;
		planTurn = 0;
		execTurn = 0;
		pi.setActiveTools(EXEC_TOOLS);
		updateStatus(ctx);
		persist();
	}

	// -------------------------------------------------------------------------
	// /plan: enter plan mode. Tool restriction + status; the actual model swap
	// happens on the next prompt via before_agent_start.
	// -------------------------------------------------------------------------
	pi.registerCommand("plan", {
		description: "Enter plan mode — read-only tools, top of plan ladders",
		handler: async (_args, ctx) => {
			mode = "planning";
			planRun = 0;
			execRun = 0;
			planTurn = 0;
			execTurn = 0;
			pi.setActiveTools(PLAN_TOOLS);
			updateStatus(ctx);
			persist();
			ctx.ui.notify(
				`Plan mode ON. Next prompt: run rung ${rungLabel(PLAN_RUN_LADDER[0])} · ` +
					`turn rung ${PLAN_TURN_LADDER[0].modelId}:${PLAN_TURN_LADDER[0].thinking}`,
				"info",
			);
		},
	});

	pi.registerCommand("stepdown", {
		description: "Show plan-stepdown ladder positions",
		handler: async (_args, ctx) => {
			if (mode === "idle") {
				ctx.ui.notify("plan-stepdown: idle. Run /plan to start.", "info");
				return;
			}
			const runLadder = mode === "planning" ? PLAN_RUN_LADDER : EXEC_RUN_LADDER;
			const turnLadder = mode === "planning" ? PLAN_TURN_LADDER : EXEC_TURN_LADDER;
			const runIdx = Math.min(mode === "planning" ? planRun : execRun, runLadder.length - 1);
			const turnIdx = Math.min(mode === "planning" ? planTurn : execTurn, turnLadder.length - 1);
			const runLines = runLadder.map(
				(r, i) => `${i === runIdx ? "→" : "  "} ${i + 1}. ${rungLabel(r)}`,
			);
			const turnLines = turnLadder.map(
				(r, i) => `${i === turnIdx ? "→" : "  "} ${i + 1}. ${r.modelId}:${r.thinking}`,
			);
			ctx.ui.notify(
				`${mode.toUpperCase()} run ladder:\n${runLines.join("\n")}\n\n` +
					`${mode.toUpperCase()} turn ladder (in-run):\n${turnLines.join("\n")}`,
				"info",
			);
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
	// before_agent_start: applies the per-run rung. Fires before pi builds
	// AgentLoopConfig (which captures model+reasoning for the whole run).
	// -------------------------------------------------------------------------
	pi.on("before_agent_start", async (_event, ctx) => {
		if (mode === "idle") return;

		const ladder = mode === "planning" ? PLAN_RUN_LADDER : EXEC_RUN_LADDER;
		const idx = mode === "planning" ? planRun : execRun;
		const clampedIdx = Math.min(idx, ladder.length - 1);
		const rung = ladder[clampedIdx];

		const ok = await applyRunRung(rung, ctx);
		if (!ok) {
			reset(ctx);
			return;
		}

		// Advance run counter so NEXT prompt uses the next rung.
		if (mode === "planning") planRun += 1;
		else execRun += 1;

		updateStatus(ctx);
		persist();

		// Inject phase nudge as a custom message on the first run of each phase.
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
	// agent_start: reset per-turn counter at the start of each agent run.
	// -------------------------------------------------------------------------
	pi.on("agent_start", async () => {
		planTurn = 0;
		execTurn = 0;
	});

	// -------------------------------------------------------------------------
	// before_provider_request: THE per-turn seam. Rewrite the wire payload's
	// model + reasoning to whatever the per-turn ladder says for this turn.
	// Returning the rewritten payload replaces what gets sent.
	// -------------------------------------------------------------------------
	pi.on("before_provider_request", (event) => {
		const rung = chooseRung(mode, planTurn, execTurn, PLAN_TURN_LADDER, EXEC_TURN_LADDER);
		if (!rung) return;
		return applyRungToPayload(event.payload, rung);
	});

	// -------------------------------------------------------------------------
	// turn_end: advance per-turn counter so the NEXT turn picks the next rung.
	// Don't advance on aborted turns so /resume picks up where we left off.
	// -------------------------------------------------------------------------
	pi.on("turn_end", async (event, ctx) => {
		if (mode === "idle") return;
		const stop =
			(event.message as { stopReason?: string } | undefined)?.stopReason;
		if (stop === "aborted") return;

		if (mode === "planning") planTurn += 1;
		else execTurn += 1;
		updateStatus(ctx);
	});

	// -------------------------------------------------------------------------
	// agent_end: planning run finished — ask the user to accept the plan.
	// -------------------------------------------------------------------------
	pi.on("agent_end", async (_event, ctx) => {
		if (mode !== "planning") return;
		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select("Plan ready — what next?", [
			"Execute the plan",
			"Refine — stay in plan mode (advances ladders)",
			"Cancel — leave plan mode",
		]);

		if (choice === "Execute the plan") {
			mode = "executing";
			execRun = 0;
			execTurn = 0;
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
	});

	// -------------------------------------------------------------------------
	// session_start: restore counters across resume.
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plan-stepdown-state",
			)
			.pop() as
			| { data?: { mode: Mode; planRun: number; execRun: number } }
			| undefined;
		if (last?.data) {
			mode = last.data.mode;
			planRun = last.data.planRun;
			execRun = last.data.execRun;
			// per-turn counters reset on agent_start so we don't restore them.
			if (mode === "planning") pi.setActiveTools(PLAN_TOOLS);
			updateStatus(ctx);
		}
	});
}
