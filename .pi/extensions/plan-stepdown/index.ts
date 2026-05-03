/**
 * plan-stepdown
 *
 * Plan-then-implement mode for pi with a single configurable model ladder.
 *
 * One ladder. One counter. One mental model:
 *
 *   LADDER[0]   "snappy / user-facing tier" (e.g. gpt-5.5:quick)
 *               used while the user is in control:
 *               - every LLM call inside plan mode
 *               - the first turn of any user follow-up prompt during
 *                 implementing (the LLM responding directly to the user)
 *
 *   LADDER[1]   "first autonomous step" (e.g. gpt-5.5 xhigh)
 *               used for the first LLM call after the plan is accepted
 *               (the auto-injected "Please start implementation." run),
 *               and then for turn 2 of each user follow-up.
 *
 *   LADDER[2..] cheaper / weaker — used while the agent is working by
 *               itself inside one run (turn 3, 4, 5...). Last rung repeats
 *               forever once you're past the end.
 *
 * Stepping only happens while the agent is "working by itself" inside
 * one run. As soon as the run ends and control returns to the user
 * (agent_end during implementing), the stage resets so the next prompt
 * starts at the snappy tier again.
 *
 * How the swap actually happens:
 *
 *   • setModel() runs exactly once per plan→implementation cycle, at /plan.
 *     Because every rung shares PROVIDER, that single binding carries
 *     provider / baseUrl / auth through plan mode, the auto-injected
 *     "Please start implementation." run, and any user follow-ups in
 *     implementing mode. We avoid calling setModel again because it
 *     persists the model as a default in pi settings, which would bounce
 *     around per turn.
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
 *   /stepdown-off  — leave plan/implementation mode, restore full tools
 */

import { userInfo } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	applyOpenAIWebSearchToPayload,
	applyPromptCacheToPayload,
	applyRungToPayload,
	chooseRung,
	createPromptCacheKey,
	detectReasoningBump,
	nextStage,
	type Mode,
	type PromptCacheRetention,
	type ReasoningBumpConfig,
	type Rung,
} from "./rewrite.js";

// ---------------------------------------------------------------------------
// Configure here. Edit freely.
//
// All rungs must be on PROVIDER (see same-provider note above). Provider
// and modelIds must match `pi --list-models`. See models.example.json for
// a matching openai-responses-compatible proxy config.
// ---------------------------------------------------------------------------

const PROVIDER = "openai-proxy";

// Conservative OpenAI prompt-cache augmentation.
// - key: stable hash of local username + cwd, with a project-specific prefix
//   outside the hash so raw local details are not sent to the provider.
// - retention: use "24h" for GPT-5.x / gpt-4.1 direct OpenAI-compatible backends,
//   or set to undefined if your proxy rejects the field.
// We intentionally OMIT explicit in-memory retention to stay compatible with
// both older and newer OpenAI SDK/type spellings.
const OPENAI_PROMPT_CACHE_KEY_PREFIX = "pi-model-staging:";
const OPENAI_PROMPT_CACHE_RETENTION: PromptCacheRetention | undefined = "24h";
const OPENAI_WEB_SEARCH_ENABLED = process.env.PI_OPENAI_WEB_SEARCH !== "0";

// One-shot reasoning bump triggers.
// When a trigger fires, the *next* LLM call in implementing mode temporarily
// uses LADDER[BUMP_RUNG_INDEX] (clamped if the ladder is shorter).
const REASONING_BUMP: ReasoningBumpConfig = {
	bumpOnFailedBash: true,
	bumpOnFailedTool: true,
	bumpOnPackageManagerCommand: true,
	packageManagerCommands: ["npm", "pnpm", "yarn", "bun"],
};

// The rung to bump to. Always ladder[1] (the "first autonomous step" tier),
// or clamped to the last rung if the ladder is shorter.
const BUMP_RUNG_INDEX = 1;

const LADDER: Rung[] = [
	{ modelId: "gpt-5.5:quick", thinking: "xhigh", webSearchContextSize: "high" }, // [0] plan mode (every LLM call)
	{ modelId: "gpt-5.5", thinking: "xhigh", webSearchContextSize: "high" }, // [1] first call after plan accepted
	{ modelId: "gpt-5.5", thinking: "high", webSearchContextSize: "medium" }, // [2]
	{ modelId: "gpt-5.4", thinking: "high", webSearchContextSize: "low" }, // [3]
	{ modelId: "gpt-5.2", thinking: "high", webSearchContextSize: "low" }, // [4]+ (clamps here forever)
];

// Tools available during planning — read-only.
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls"];
const IMPL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const PLAN_PROMPT = `[PLAN MODE]

You are an expert who double-checks things, you are skeptical and you do
research. The user is not always right and neither are you, but you both
strive for accuracy. You both try to look at things from multiple
perspectives. You're collaborating on this codebase together.

Be humble and questioning. Practice thinking before talking. Be completely
honest at all times, state your assumptions, and if you're uncertain say
so — and if possible, look it up via file search, native OpenAI web search
when available, or \`bash\` + \`curl\` as a fallback.

# Principles (apply throughout, with reasonable exceptions)

* **Single source of truth** — do NOT have duplicate data sources or files
  that do the same/similar thing. When refactoring or making a new version,
  suggest REMOVING the old code or data so we don't get confused about
  which file does what — unless the user has explicitly said no breaking
  changes.
* **KISS — Keep It Simple, Stupid** — think long-term. We need to
  understand how the code works in 6 months / a year. The simplest way is
  often the best, so think twice before implementing — is there a simpler
  way?
* **LOW RISK, HIGH IMPACT** — think carefully about multiple scenarios,
  analyze risk in each. Almost always pick the lowest risk route with the
  highest impact.
* **DRY — Don't Repeat Yourself** — if we tend to do something similarly
  in two places, consider generalizing into a library function. Hard
  balance: don't overcomplicate. Rather too late than too soon.
* **Separation of Concerns / Single Responsibility** — modular and
  organized without overcomplicating. Same balance as DRY.
* **Prefer the natural way of programming for the language** — in
  JS/TS, prefer functions over classes. Work with how the language was
  designed rather than enforcing alien principles.
* **Modify and augment rather than delete and re-create** — when
  refactoring, MOVE or COPY a file via \`bash\` and then MODIFY it,
  instead of reading and re-writing the whole file from scratch. Lower
  risk of losing context.
* **Rationale and assumptions** — always state these so your thought
  process is transparent.
* **Update docs** — if something documented changes, flag (and later
  update) the docs that need it.
* **No early optimization** — no caches, speed tricks, or fancy features
  unless explicitly asked. Simplicity is the key.
* **Check available tooling** — \`package.json\`, READMEs, etc. for
  linting and type-safety tools available for use after implementation.

# Plan mode rules (you are here)

In PLAN MODE you do Research & Analysis ONLY:

* Read files and examine code (\`read\`)
* Search through the codebase (\`grep\`, \`find\`, \`ls\`)
* Analyze project structure
* Gather information from the web using native OpenAI web search when
  available, or \`bash\` + \`curl\` as a fallback
* Review documentation files
* Look at git history via \`bash\` (\`git log\`, \`git blame\`, \`git diff\`)

You CANNOT use \`edit\` or \`write\` — the extension has removed them. If
you reach for them you'll get an error. The purpose of plan mode is to
analyze the right approach BEFORE any implementation, so don't try to
work around it.

If you're uncertain at any point, STOP and ASK questions before showing
your plan. State your assumptions clearly. If an assumption turns out to
be wrong, take a step back, reflect on the root cause, and tell the user
what caught your eye or wasn't what you expected.

# Plan output

When you're ready, present (in this order):

When using web search, cite the important sources explicitly in your normal
response text.

1. **Summary and purpose** of the task from your point of view
2. **Overall changes** needed in the codebase to reach the goal
3. **Risk assessment** — the scenarios you considered, the risks in
   each, and how to mitigate them
4. **Confidence level** — your honest read on how certain the plan is
   right
5. **Step-by-step plan** under a heading "Plan:" — one numbered line per
   step (this is what the implementation phase will work from)

Keep the plan to a high architectural standard — DRY, KISS, separation
of concerns.

# After you present the plan

The user will see a dialog with three choices:

* **Start implementation** — the extension auto-sends "Please start
  implementation." and you switch to implementation mode (with edit/write
  restored)
* **Refine — stay in plan mode** — you stay here; the user will give
  more feedback
* **Cancel — leave plan mode** — drops back to normal pi

When revising the plan based on feedback, restate the WHOLE plan so the
user can track the diff between revisions and the conclusions reached
during planning.`;

const IMPL_FIRST_PROMPT = `[IMPLEMENTATION MODE]

The user has approved the plan you produced. Edit and write tools are
available again. Implement the plan you laid out, applying the same
collaboration principles you used while planning (single source of truth,
KISS, low-risk/high-impact, DRY, separation of concerns, natural language
idioms, modify-don't-recreate, no early optimization).

# While implementing

* **Track progress** — keep tabs on which plan steps are done.
* **State assumptions and rationale** as you go.
* **Modify and augment, don't delete and re-create** — edit files in
  place; when restructuring, MOVE or COPY first via \`bash\` rather than
  reading and rewriting from scratch.
* If anything during implementation **contradicts an assumption from the
  plan**, STOP and tell the user before continuing — don't quietly
  rework the plan in your head.

# When you've finished the plan

Before reporting done, do this in order:

1. **Sanity check** — pick one of the files you modified (or one of the
   higher-risk steps) and review it as if you were a colleague
   peer-reviewing the change. Look for mistakes that could come from
   working in parallel with the user (they may have edited files at the
   same time).
2. **Run linting and type checking** — find the tools in \`package.json\`
   / READMEs / config files. If the codebase has many pre-existing lint
   or type errors, focus only on errors in files you changed.
3. **Update docs** — if you changed something that was documented,
   update the docs in this same pass.

Then summarize what changed and report back.`;

// ---------------------------------------------------------------------------

export default function planStepdownExtension(pi: ExtensionAPI): void {
	let mode: Mode = "idle";
	// Single global counter. 0 during planning, set to 1 on accept,
	// incremented at every turn_end during implementing (clamped to ladder end).
	let stage = 0;

	// One-shot bump state.
	let pendingBump: { rungIndex: number; reason: string } | null = null;
	let activeBump: { rungIndex: number; reason: string } | null = null;

	function rungLabel(rung: Rung, idx: number): string {
		return `[${idx}] ${PROVIDER}/${rung.modelId}:${rung.thinking}`;
	}

	function activeRungIndex(): number {
		if (mode === "idle") return -1;
		if (mode === "planning") return 0;
		return Math.min(stage, LADDER.length - 1);
	}

	function effectiveRungIndexForStatus(): number {
		if (mode === "idle") return -1;
		if (mode === "planning") return 0;
		if (activeBump) return activeBump.rungIndex;
		return activeRungIndex();
	}

	function persist(): void {
		pi.appendEntry("plan-stepdown-state", { mode, stage });
	}

	function getLocalUsername(): string {
		try {
			const username = userInfo().username;
			if (username) return username;
		} catch {
			// Fall back below. userInfo() can fail in restricted environments.
		}
		return process.env.USER || process.env.USERNAME || process.env.LOGNAME || "unknown";
	}

	function getPromptCacheKey(ctx: ExtensionContext): string {
		return createPromptCacheKey(OPENAI_PROMPT_CACHE_KEY_PREFIX, getLocalUsername(), ctx.cwd);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (mode === "idle") {
			ctx.ui.setStatus("plan-stepdown", undefined);
			return;
		}
		const idx = effectiveRungIndexForStatus();
		const rung = LADDER[idx];
		const color = mode === "planning" ? "warning" : "accent";
		const icon = mode === "planning" ? "📋 plan" : "▶ impl";

		let suffix = "";
		if (mode === "implementing") {
			if (activeBump) {
				suffix = ` ↑ ${activeBump.reason}`;
			} else if (pendingBump) {
				suffix = ` next↑ ${pendingBump.reason}`;
			}
		}

		const label = `${icon} ${rungLabel(rung, idx)} (${idx + 1}/${LADDER.length})${suffix}`;
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
		pendingBump = null;
		activeBump = null;
		pi.setActiveTools(IMPL_TOOLS);
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
			pendingBump = null;
			activeBump = null;
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
		if (mode === "implementing" && stage === 1) {
			// Only inject the implementation-mode prompt at the very first
			// implementing turn.
			return {
				message: { customType: "plan-stepdown-context", content: IMPL_FIRST_PROMPT, display: false },
			};
		}
	});

	// -------------------------------------------------------------------------
	// turn_start: if a bump is queued, arm it for this turn.
	// -------------------------------------------------------------------------
	pi.on("turn_start", async (_event, ctx) => {
		if (mode !== "implementing") return;
		if (!pendingBump) return;
		activeBump = pendingBump;
		pendingBump = null;
		updateStatus(ctx);
	});

	// -------------------------------------------------------------------------
	// tool_result: detect important outputs/errors and queue a one-shot bump for
	// the *next* LLM call.
	// -------------------------------------------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		if (mode !== "implementing") return;

		const reason = detectReasoningBump(
			{ toolName: event.toolName, input: event.input, isError: event.isError },
			REASONING_BUMP,
		);
		if (!reason) return;

		if (LADDER.length === 0) return;
		const bumpIndex = Math.min(BUMP_RUNG_INDEX, LADDER.length - 1);

		pendingBump = { rungIndex: bumpIndex, reason };
		updateStatus(ctx);
	});

	// -------------------------------------------------------------------------
	// before_provider_request: THE per-LLM-call seam. Rewrite the wire
	// payload's model + reasoning to LADDER[active]. Returning the
	// rewritten payload replaces what gets sent.
	// -------------------------------------------------------------------------
	pi.on("before_provider_request", (event, ctx) => {
		const rung = activeBump ? LADDER[activeBump.rungIndex] : chooseRung(mode, stage, LADDER);
		if (!rung) return;

		let payload = applyRungToPayload(event.payload, rung);
		const model = ctx.modelRegistry.find(PROVIDER, rung.modelId);

		payload = applyOpenAIWebSearchToPayload(payload, {
			enabled: OPENAI_WEB_SEARCH_ENABLED && model?.api === "openai-responses",
			contextSize: rung.webSearchContextSize ?? "low",
		});

		const supportsLongCacheRetention = model?.compat?.supportsLongCacheRetention ?? true;
		const promptCacheRetention =
			OPENAI_PROMPT_CACHE_RETENTION === "24h" && !supportsLongCacheRetention
				? undefined
				: OPENAI_PROMPT_CACHE_RETENTION;

		payload = applyPromptCacheToPayload(payload, {
			key: getPromptCacheKey(ctx),
			retention: promptCacheRetention,
		});
		return payload;
	});

	// -------------------------------------------------------------------------
	// turn_end: advance the stage counter during implementing. Don't advance
	// on aborted turns so /resume continues at the same rung.
	// -------------------------------------------------------------------------
	pi.on("turn_end", async (event, ctx) => {
		if (mode !== "implementing") return;
		const stop = (event.message as { stopReason?: string } | undefined)?.stopReason;
		if (stop === "aborted") return;

		// If a bump was active for this turn, advance from the bumped rung
		// (so a bump on [1] continues at [2]). Otherwise advance from the
		// current stage as normal.
		const activeBumpIndex = activeBump?.rungIndex;
		activeBump = null;

		stage = nextStage(activeBumpIndex ?? stage, LADDER);
		updateStatus(ctx);
		persist();
	});

	// -------------------------------------------------------------------------
	// agent_end: two distinct cases.
	//
	//   planning      → show the accept dialog. On accept, jump stage to 1
	//                   so the auto-injected "Please start implementation."
	//                   run starts at LADDER[1] (carrying the plan forward
	//                   into autonomous work). On cancel, reset.
	//
	//   implementing  → control is going back to the user. Reset stage to 0
	//                   so their next prompt starts at the snappy/user-
	//                   facing tier again. Stepping only happens inside one
	//                   run.
	// -------------------------------------------------------------------------
	pi.on("agent_end", async (_event, ctx) => {
		if (mode === "implementing") {
			stage = 0;
			pendingBump = null;
			activeBump = null;
			updateStatus(ctx);
			persist();
			return;
		}

		if (mode !== "planning") return;
		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select("Plan ready — what next?", [
			"Start implementation",
			"Refine — stay in plan mode",
			"Cancel — leave plan mode",
		]);

		if (choice === "Start implementation") {
			mode = "implementing";
			stage = 1;
			pendingBump = null;
			activeBump = null;
			pi.setActiveTools(IMPL_TOOLS);
			updateStatus(ctx);
			persist();
			pi.sendMessage(
				{ customType: "plan-stepdown-implement", content: "Please start implementation.", display: true },
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
			pendingBump = null;
			activeBump = null;
			if (mode === "planning") pi.setActiveTools(PLAN_TOOLS);
			updateStatus(ctx);
		}
	});
}
