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
 *   LADDER[1]   "first autonomous step" (e.g. gpt-5.4 xhigh)
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
 *     (pi/packages/agent/src/agent.ts:413), so we have to rewrite the
 *     serialized request to step within a run.
 *
 * Same-provider constraint: every rung must be on PROVIDER. The HTTP
 * client is built before before_provider_request runs (e.g.
 * pi/packages/ai/src/providers/anthropic.ts:466), binding baseUrl
 * and apiKey to the per-run model. Rewriting the payload to a different
 * provider's model still sends the request to the original endpoint with
 * the wrong key.
 *
 * Commands:
 *   /plan          — enter plan mode, lock to read-only tools
 *   /stepdown      — show the resolved config and current cursor
 *   /stepdown-off  — leave plan/implementation mode, restore full tools
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyOpenAIWebSearchToPayload,
	applyPromptCacheToPayload,
	applyRungToPayload,
	capThinkingLevel,
	chooseContextSafeRungIndex,
	chooseRungIndex,
	createPromptCacheKey,
	detectReasoningBump,
	extractLatestAssistantText,
	formatAcceptedPlanContext,
	hasCustomMessage,
	isMaxOutputTokensLikeStop,
	nextReasoningEffortForMaxOutput,
	nextStage,
	normalizeAcceptedPlan,
	type MessageWithRole,
	type Mode,
	type OpenAIWebSearchUserLocation,
	type Rung,
	type ThinkingLevel,
} from "./rewrite.ts";
import {
	DEFAULT_PLAN_STEPDOWN_CONFIG,
	mergePlanStepdownConfig,
	parsePlanStepdownConfig,
	type ResolvedPlanStepdownConfig,
} from "./config.ts";
import {
	buildPlanningToolNames,
	formatPlanningQuestionPrompt,
	registerPlanningQuestionTool,
} from "./questions.ts";

// ---------------------------------------------------------------------------
// Configure here. Edit freely.
//
// All rungs must be on PROVIDER (see same-provider note above). Provider
// and modelIds must match `pi --list-models`. See models.example.json for
// a matching openai-responses-compatible proxy config.
// ---------------------------------------------------------------------------

const PLAN_AUTO_APPROVE_FLAG = "plan-auto-approve";
const STEP_DOWN_CONFIG_FLAG = "stepdown-config";

const OPENAI_WEB_SEARCH_ENABLED_ENV = process.env.PI_OPENAI_WEB_SEARCH;
const OPENAI_WEB_SEARCH_LOCATION_ENABLED_ENV = process.env.PI_OPENAI_WEB_SEARCH_LOCATION;

const TIMEZONE_COUNTRY: Record<string, string> = {
	"Europe/Stockholm": "SE",
	"Europe/London": "GB",
	"Europe/Berlin": "DE",
	"Europe/Paris": "FR",
	"Europe/Amsterdam": "NL",
	"Europe/Copenhagen": "DK",
	"Europe/Oslo": "NO",
	"Europe/Helsinki": "FI",
	"Europe/Madrid": "ES",
	"Europe/Rome": "IT",
	"America/New_York": "US",
	"America/Chicago": "US",
	"America/Denver": "US",
	"America/Los_Angeles": "US",
	"America/Toronto": "CA",
	"America/Vancouver": "CA",
	"Asia/Tokyo": "JP",
	"Asia/Seoul": "KR",
	"Asia/Singapore": "SG",
	"Australia/Sydney": "AU",
};

// ---------------------------------------------------------------------------
// Runtime-loaded configuration.
//
// Sources (merged, project takes precedence):
// - ~/.pi/agent/plan-stepdown.json (global)
// - <cwd>/.pi/plan-stepdown.json (project)
//
// Arrays (ladder, tool lists) are treated as replace-not-merge.
// ---------------------------------------------------------------------------

const BUMP_RUNG_INDEX = 1;
const CONTEXT_FALLBACK_RESERVE_TOKENS = 16384;
const MAX_CONSECUTIVE_LENGTH_AUTO_CONTINUES = 2;
const MAX_CONSECUTIVE_MAX_OUTPUT_RESCUES = 3;
const MAX_OUTPUT_RESCUE_REASON = "max output tokens exhausted";
const ACCEPTED_PLAN_ENTRY_TYPE = "plan-stepdown-accepted-plan";
const ACCEPTED_PLAN_CONTEXT_CUSTOM_TYPE = "plan-stepdown-accepted-plan-context";
const IMPLEMENTATION_KICKOFF_CUSTOM_TYPE = "plan-stepdown-implement";
const IMPLEMENTATION_KICKOFF_MESSAGE = "Please start implementation.";
const IMPLEMENTATION_CONTINUE_CUSTOM_TYPE = "plan-stepdown-continue";
const IMPLEMENTATION_CONTINUE_MESSAGE =
	"Continue from where you left off. Keep the next step concise; if the implementation is complete, summarize what changed and stop.";

function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function getConfiguredAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	return configured ? expandHomePath(configured) : join(homedir(), ".pi", "agent");
}

function loadJson(path: string): { found: boolean; value?: unknown; error?: string } {
	const resolvedPath = expandHomePath(path);
	if (!existsSync(resolvedPath)) return { found: false };
	try {
		return { found: true, value: JSON.parse(readFileSync(resolvedPath, "utf-8")) };
	} catch (error) {
		return {
			found: true,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function resolveConfig(ctx: ExtensionContext, pi: ExtensionAPI): { config: ResolvedPlanStepdownConfig; warnings: string[] } {
	const warnings: string[] = [];

	let config = DEFAULT_PLAN_STEPDOWN_CONFIG;

	const globalPath = join(getConfiguredAgentDir(), "plan-stepdown.json");
	const projectPath = join(ctx.cwd, ".pi", "plan-stepdown.json");
	const overridePath = pi.getFlag(STEP_DOWN_CONFIG_FLAG);

	const globalJson = loadJson(globalPath);
	if (globalJson.error) {
		warnings.push(`${globalPath}: invalid JSON (${globalJson.error})`);
	} else if (globalJson.found) {
		const parsed = parsePlanStepdownConfig(globalJson.value, globalPath);
		warnings.push(...parsed.warnings);
		config = mergePlanStepdownConfig(config, parsed.config);
	}

	const projectJson = loadJson(projectPath);
	if (projectJson.error) {
		warnings.push(`${projectPath}: invalid JSON (${projectJson.error})`);
	} else if (projectJson.found) {
		const parsed = parsePlanStepdownConfig(projectJson.value, projectPath);
		warnings.push(...parsed.warnings);
		config = mergePlanStepdownConfig(config, parsed.config);
	}

	if (typeof overridePath === "string" && overridePath.trim().length > 0) {
		const resolvedOverridePath = expandHomePath(overridePath);
		const json = loadJson(resolvedOverridePath);
		if (json.error) {
			warnings.push(`${resolvedOverridePath}: invalid JSON (${json.error})`);
		} else if (!json.found) {
			warnings.push(`stepdown-config: file not found: ${resolvedOverridePath}`);
		} else {
			const parsed = parsePlanStepdownConfig(json.value, resolvedOverridePath);
			warnings.push(...parsed.warnings);
			config = mergePlanStepdownConfig(config, parsed.config);
		}
	}

	// Respect env vars as a last-mile operational override.
	if (OPENAI_WEB_SEARCH_ENABLED_ENV !== undefined || OPENAI_WEB_SEARCH_LOCATION_ENABLED_ENV !== undefined) {
		config = mergePlanStepdownConfig(config, {
			openaiWebSearch: {
				...(OPENAI_WEB_SEARCH_ENABLED_ENV !== undefined
					? { enabled: OPENAI_WEB_SEARCH_ENABLED_ENV !== "0" }
					: {}),
				...(OPENAI_WEB_SEARCH_LOCATION_ENABLED_ENV !== undefined
					? { locationEnabled: OPENAI_WEB_SEARCH_LOCATION_ENABLED_ENV !== "0" }
					: {}),
			},
		});
	}

	return { config, warnings };
}

const PLAN_PROMPT = `[PLAN MODE]

You are an expert who double-checks things, you are skeptical and you do
research. The user is not always right and neither are you, but you both
strive for accuracy. You both try to look at things from multiple
perspectives. You're collaborating on this codebase together.

Be humble and questioning. Practice thinking before talking. Be completely
honest at all times, state your assumptions, and if you're uncertain say
so — and if possible, look things up via file search, web search
when available, or \`bash\` + \`curl\` / \`wget\` as a fallback.

# Principles (apply throughout, with reasonable exceptions)

* **Single source of truth** — do NOT create duplicate data sources or files
  that do the same/similar thing. When refactoring or making a new version,
  suggest REMOVING the old code or data so we don't get confused about
  which file does what — unless the user has explicitly said no breaking
  changes. Most of the time, we will work with git, which means it's fine to
  remove files, since they can be recovered. But be mindful if you do not
  detect any git repo in the current workspace.
* **KISS — Keep It Simple, Stupid** — think long-term. We need to
  understand how the code works in 6 months / a year. The simplest way is
  often the best, so think twice before implementing — is there a simpler
  way? Think carefully, if Senior Developer would say the code is 
  overcomplicated, then do something simpler instead.
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
* Search through the codebase (Using \`grep\`, \`find\`, \`ls\`, etc)
* Analyze project structure
* Gather information from the web using web search when
  available, or \`bash\` + \`curl\` / \`wget\` as a fallback
* Review documentation files
* Look at git history via \`bash\` (\`git log\`, \`git blame\`, \`git diff\`)

You CANNOT use \`edit\` or \`write\` — the extension has removed them. If
you reach for them you'll get an error. The purpose of plan mode is to
analyze the right approach BEFORE any implementation, so don't try to
work around it. You MAY however utilize bash to execute code and
verify things while planning to avoid unknown unknowns.

If you're uncertain, state the uncertainty and your assumptions clearly.
If a safe conservative assumption is possible, proceed with a plan based
on that assumption and call it out explicitly. If no safe plan can be made
without clarification, stop and ask the blocking question clearly instead
of inventing implementation steps.

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

After the plan is accepted, the extension will switch to implementation
mode and auto-send "Please start implementation." Edit/write tools will
then be restored.

Depending on how pi is running, approval may happen through an interactive
choice or through an explicit auto-approve flag. Do not assume additional
human input will be available after the plan.

Possible outcomes after planning:

* **Start implementation** — switch to implementation mode with edit/write
  tools restored.
* **Refine — stay in plan mode** — continue planning and incorporate the
  requested feedback.
* **Cancel — leave plan mode** — drop back to normal pi.

When revising the plan based on feedback, restate the WHOLE plan so the
user can track the diff between revisions and the conclusions reached
during planning.`;

const IMPL_FIRST_PROMPT = `[IMPLEMENTATION MODE]

The plan you produced has been approved. Edit and write tools are
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
  plan**, stop and report the contradiction clearly before continuing — don't
  quietly rework the plan in your head.
* When creating migrations and similar, utilize a bash tool to confirm
  the correct time and date for the filename when creating the migration file(s).

# When you've finished the plan

Before reporting done, do this in order:

1. **Sanity check** — pick one or a handful of the files you 
   modified (or one of the higher-risk steps) and review it as if you were a colleague
   peer-reviewing the change. Look for mistakes that could come from
   working in parallel with external changes — a human or another process may
   have edited files at the same time.
2. **Run linting and type checking** — find the tools in \`package.json\`
   / READMEs / config files. If the codebase has many pre-existing lint
   or type errors, focus only on errors in files you changed.
3. **Update docs** — if you changed something that was documented,
   update the docs in this same pass.

Then summarize what changed and report back.`;

// ---------------------------------------------------------------------------

export default function planStepdownExtension(pi: ExtensionAPI): void {
	let mode: Mode = "idle";
	pi.registerFlag(PLAN_AUTO_APPROVE_FLAG, {
		description: "Start in plan mode and automatically approve the produced plan",
		type: "boolean",
		default: false,
	});
	pi.registerFlag(STEP_DOWN_CONFIG_FLAG, {
		description: "Path to a plan-stepdown config JSON file (overrides global/project config)",
		type: "string",
	});
	let runtimeConfig: ResolvedPlanStepdownConfig = DEFAULT_PLAN_STEPDOWN_CONFIG;
	// Single global counter. 0 during planning, set to 1 on accept,
	// incremented at every turn_end during implementing (clamped to ladder end).
	let stage = 0;

	// One-shot bump state.
	let pendingBump: { rungIndex: number; reason: string } | null = null;
	let activeBump: { rungIndex: number; reason: string } | null = null;
	let pendingMaxOutputRescue:
		| { rungIndex: number; from: ThinkingLevel; to: ThinkingLevel }
		| null = null;
	let activeMaxOutputRescue:
		| { rungIndex: number; from: ThinkingLevel; to: ThinkingLevel }
		| null = null;
	let activeContextFallback:
		| { fromIndex: number; toIndex: number; contextTokens: number; contextWindow: number }
		| null = null;
	let lastProviderRequest: { rungIndex: number; thinking: ThinkingLevel } | null = null;
	let acceptedPlan: string | null = null;
	let consecutiveLengthAutoContinues = 0;
	let consecutiveMaxOutputRescues = 0;
	let autonomousMessageToken = 0;
	let planningQuestionsToolRegistered = false;

	function rungLabel(rung: Rung, idx: number): string {
		return `[${idx}] ${runtimeConfig.provider}/${rung.modelId}:${rung.thinking}`;
	}

	function activeRungIndex(): number {
		if (mode === "idle") return -1;
		if (mode === "planning") return 0;
		return Math.min(stage, runtimeConfig.ladder.length - 1);
	}

	function effectiveRungIndexForStatus(): number {
		if (mode === "idle") return -1;
		if (activeContextFallback) return activeContextFallback.toIndex;
		if (mode === "planning") return 0;
		if (activeBump) return activeBump.rungIndex;
		if (activeMaxOutputRescue) return activeMaxOutputRescue.rungIndex;
		return activeRungIndex();
	}

	function formatMaxOutputRescue(rescue: { rungIndex: number; from: ThinkingLevel; to: ThinkingLevel } | null): string | null {
		if (!rescue) return null;
		const rung = runtimeConfig.ladder[rescue.rungIndex];
		if (!rung) return null;
		return `${rungLabel({ ...rung, thinking: rescue.from }, rescue.rungIndex)} → ${rescue.to}`;
	}

	function getAppliedRung(rung: Rung): Rung {
		const rescue = pendingMaxOutputRescue ?? activeMaxOutputRescue;
		if (!rescue) return rung;
		const thinking = capThinkingLevel(rung.thinking, rescue.to);
		return thinking === rung.thinking ? rung : { ...rung, thinking };
	}

	function formatStepdownReport(ctx: ExtensionContext): string {
		const currentIdx = effectiveRungIndexForStatus();
		const currentRung = currentIdx >= 0 ? runtimeConfig.ladder[currentIdx] : null;
		const ladderLines = runtimeConfig.ladder.map((rung, idx) => {
			const marker = idx === currentIdx ? "→" : " ";
			const tags: string[] = [];
			if (idx === 0) tags.push("plan/user-facing");
			if (idx === 1) tags.push("first autonomous step");
			if (idx === runtimeConfig.ladder.length - 1) tags.push("last — repeats");
			if (rung.webSearchContextSize) tags.push(`web=${rung.webSearchContextSize}`);
			const model = ctx.modelRegistry.find(runtimeConfig.provider, rung.modelId);
			if (!model) tags.push("missing from provider registry");
			else tags.push(`ctx=${model.contextWindow.toLocaleString()}`);
			return `${marker} ${rungLabel(rung, idx)}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`;
		});

		const lines = [
			`plan-stepdown: ${mode}`,
			`provider: ${runtimeConfig.provider}`,
			`cursor: ${currentRung ? `${rungLabel(currentRung, currentIdx)} (${currentIdx + 1}/${runtimeConfig.ladder.length})` : "none (idle)"}`,
		];

		if (activeContextFallback) {
			lines.push(
				`context fallback: [${activeContextFallback.fromIndex}] → [${activeContextFallback.toIndex}] at ~${activeContextFallback.contextTokens.toLocaleString()}/${activeContextFallback.contextWindow.toLocaleString()} tokens`,
			);
		}
		if (activeBump) {
			lines.push(`active bump: [${activeBump.rungIndex}] ${activeBump.reason}`);
		} else if (pendingBump) {
			lines.push(`next bump: [${pendingBump.rungIndex}] ${pendingBump.reason}`);
		}
		if (activeMaxOutputRescue) {
			const label = formatMaxOutputRescue(activeMaxOutputRescue);
			if (label) lines.push(`max-output rescue: active ${label}`);
		}
		if (pendingMaxOutputRescue) {
			const label = formatMaxOutputRescue(pendingMaxOutputRescue);
			if (label) lines.push(`max-output rescue: next ${label}`);
		}
		if (consecutiveLengthAutoContinues > 0) {
			lines.push(`length auto-continue: ${consecutiveLengthAutoContinues}/${MAX_CONSECUTIVE_LENGTH_AUTO_CONTINUES}`);
		}
		if (consecutiveMaxOutputRescues > 0) {
			lines.push(`max-output rescues: ${consecutiveMaxOutputRescues}/${MAX_CONSECUTIVE_MAX_OUTPUT_RESCUES}`);
		}
		lines.push(`accepted plan: ${acceptedPlan ? `stored (${acceptedPlan.length.toLocaleString()} chars)` : "none"}`);
		lines.push(`plan questions: ${mode === "planning" && ctx.hasUI ? "interactive" : "inactive"}`);

		lines.push(
			"",
			"ladder:",
			...ladderLines,
			"",
			`tools.plan.base: ${runtimeConfig.tools.plan.join(", ")}`,
			`tools.plan.effective: ${buildPlanningToolNames(runtimeConfig.tools.plan, mode === "planning" && ctx.hasUI).join(", ")}`,
			`tools.implementation: ${runtimeConfig.tools.implementation.join(", ")}`,
			`openaiPromptCache: keyPrefix=${runtimeConfig.openaiPromptCache.keyPrefix}, retention=${runtimeConfig.openaiPromptCache.retention ?? "off"}`,
			`openaiWebSearch: enabled=${runtimeConfig.openaiWebSearch.enabled}, locationEnabled=${runtimeConfig.openaiWebSearch.locationEnabled}`,
		);

		return lines.join("\n");
	}

	function persist(): void {
		pi.appendEntry("plan-stepdown-state", { mode, stage });
	}

	function clearTransientState(): void {
		pendingBump = null;
		activeBump = null;
		pendingMaxOutputRescue = null;
		activeMaxOutputRescue = null;
		activeContextFallback = null;
		lastProviderRequest = null;
		consecutiveLengthAutoContinues = 0;
		consecutiveMaxOutputRescues = 0;
	}

	function setAcceptedPlan(plan: string | null | undefined): void {
		const nextPlan = normalizeAcceptedPlan(plan);
		if (acceptedPlan === nextPlan) return;
		acceptedPlan = nextPlan;
		pi.appendEntry(ACCEPTED_PLAN_ENTRY_TYPE, { plan: nextPlan });
	}

	function restoreAcceptedPlan(entries: readonly { type: string; customType?: string; data?: { plan?: unknown } }[]): string | null {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type !== "custom" || entry.customType !== ACCEPTED_PLAN_ENTRY_TYPE) continue;
			return normalizeAcceptedPlan(entry.data?.plan);
		}
		return null;
	}

	function extractAcceptedPlan(messages: readonly MessageWithRole[]): string | null {
		return extractLatestAssistantText(messages);
	}

	function buildAcceptedPlanContextMessage(): MessageWithRole | null {
		if (mode !== "implementing" || !acceptedPlan) return null;
		return {
			role: "custom",
			customType: ACCEPTED_PLAN_CONTEXT_CUSTOM_TYPE,
			content: formatAcceptedPlanContext(acceptedPlan),
			display: false,
			timestamp: Date.now(),
		};
	}

	function ensurePlanningQuestionsToolRegistered(): void {
		if (planningQuestionsToolRegistered) return;
		registerPlanningQuestionTool(pi);
		planningQuestionsToolRegistered = true;
	}

	function setPlanningTools(ctx: ExtensionContext): void {
		if (ctx.hasUI) {
			ensurePlanningQuestionsToolRegistered();
		}
		pi.setActiveTools(buildPlanningToolNames(runtimeConfig.tools.plan, ctx.hasUI));
	}

	function setImplementationTools(): void {
		pi.setActiveTools(buildPlanningToolNames(runtimeConfig.tools.implementation, false));
	}

	function buildPlanPrompt(ctx: ExtensionContext): string {
		return ctx.hasUI ? `${PLAN_PROMPT}\n\n${formatPlanningQuestionPrompt()}` : PLAN_PROMPT;
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
		return createPromptCacheKey(runtimeConfig.openaiPromptCache.keyPrefix, getLocalUsername(), ctx.cwd);
	}

	function normalizeCountry(country: string | undefined): string | undefined {
		if (!country) return undefined;
		const normalized = country.trim().toUpperCase();
		return /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
	}

	function normalizeTimezone(timezone: string | undefined): string | undefined {
		const normalized = timezone?.trim();
		return normalized && normalized.length > 0 ? normalized : undefined;
	}

	function detectSystemTimezone(): string | undefined {
		try {
			return normalizeTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
		} catch {
			return undefined;
		}
	}

	function countryFromTimezone(timezone: string | undefined): string | undefined {
		if (!timezone) return undefined;
		return TIMEZONE_COUNTRY[timezone];
	}

	function getOpenAIWebSearchUserLocation(): OpenAIWebSearchUserLocation | undefined {
		if (!runtimeConfig.openaiWebSearch.locationEnabled) return undefined;
		const timezone = normalizeTimezone(process.env.PI_OPENAI_WEB_SEARCH_TIMEZONE) ?? detectSystemTimezone();
		const country =
			normalizeCountry(process.env.PI_OPENAI_WEB_SEARCH_COUNTRY) ?? countryFromTimezone(timezone);
		if (!timezone && !country) return undefined;
		return { type: "approximate", ...(country ? { country } : {}), ...(timezone ? { timezone } : {}) };
	}

	function queueAutonomousFollowUp(
		ctx: ExtensionContext,
		customType: string,
		content: string,
		guard: () => boolean,
	): void {
		const message = { customType, content, display: true };

		// During agent_end the run is still active, so queue as a follow-up instead
		// of trying to trigger a new idle turn. This survives Pi's queued-message
		// continuation path and also gives overflow compaction recovery a concrete
		// message to continue with.
		if (!ctx.isIdle()) {
			pi.sendMessage(message, { deliverAs: "followUp" });
			return;
		}

		const token = ++autonomousMessageToken;
		setTimeout(() => {
			if (token !== autonomousMessageToken) return;
			if (!guard()) return;
			pi.sendMessage(message, { triggerTurn: true });
		}, 0);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (mode === "idle") {
			ctx.ui.setStatus("plan-stepdown", undefined);
			return;
		}
		const idx = effectiveRungIndexForStatus();
		const rung = runtimeConfig.ladder[idx];
		const color = mode === "planning" ? "warning" : "accent";
		const icon = mode === "planning" ? "📋 plan" : "▶ impl";

		const suffixParts: string[] = [];
		if (activeContextFallback) {
			suffixParts.push(`ctx→[${activeContextFallback.toIndex}]`);
		}
		if (mode === "implementing") {
			if (activeBump) {
				suffixParts.push(`↑ ${activeBump.reason}`);
			} else if (pendingBump) {
				suffixParts.push(`next↑ ${pendingBump.reason}`);
			}
			if (activeMaxOutputRescue) {
				suffixParts.push(`mo ${activeMaxOutputRescue.from}→${activeMaxOutputRescue.to}`);
			} else if (pendingMaxOutputRescue) {
				suffixParts.push(`next-mo ${pendingMaxOutputRescue.from}→${pendingMaxOutputRescue.to}`);
			}
			if (consecutiveLengthAutoContinues > 0) {
				suffixParts.push(`↻len ${consecutiveLengthAutoContinues}/${MAX_CONSECUTIVE_LENGTH_AUTO_CONTINUES}`);
			}
			if (consecutiveMaxOutputRescues > 0) {
				suffixParts.push(`↻mo ${consecutiveMaxOutputRescues}/${MAX_CONSECUTIVE_MAX_OUTPUT_RESCUES}`);
			}
		}

		const suffix = suffixParts.length > 0 ? ` ${suffixParts.join(" ")}` : "";
		const label = `${icon} ${rungLabel(rung, idx)} (${idx + 1}/${runtimeConfig.ladder.length})${suffix}`;
		ctx.ui.setStatus("plan-stepdown", ctx.ui.theme.fg(color, label));
	}

	async function bindProviderForRung(rung: Rung, ctx: ExtensionContext): Promise<boolean> {
		// Bind the provider/baseUrl/auth for the upcoming agent run by calling
		// setModel. The actual per-LLM-call model/effort is overridden again
		// at before_provider_request, so this just needs to land on a model
		// hosted by runtimeConfig.provider.
		const model = ctx.modelRegistry.find(runtimeConfig.provider, rung.modelId);
		if (!model) {
			ctx.ui.notify(
				`plan-stepdown: model ${runtimeConfig.provider}/${rung.modelId} not found — fix the ladder or run pi --list-models`,
				"error",
			);
			return false;
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			ctx.ui.notify(`plan-stepdown: no API key configured for ${runtimeConfig.provider}`, "error");
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
		autonomousMessageToken++;
		mode = "idle";
		stage = 0;
		clearTransientState();
		setAcceptedPlan(null);
		setImplementationTools();
		updateStatus(ctx);
		persist();
	}

	async function enterPlanMode(ctx: ExtensionContext): Promise<boolean> {
		autonomousMessageToken++;
		mode = "planning";
		stage = 0;
		clearTransientState();
		setAcceptedPlan(null);
		setPlanningTools(ctx);
		const ok = await bindProviderForRung(runtimeConfig.ladder[0], ctx);
		if (!ok) {
			reset(ctx);
			return false;
		}
		updateStatus(ctx);
		persist();
		ctx.ui.notify(`Plan mode ON. Every LLM call uses ${rungLabel(runtimeConfig.ladder[0], 0)}`, "info");
		return true;
	}

	function startImplementation(ctx: ExtensionContext): void {
		mode = "implementing";
		stage = 1;
		clearTransientState();
		setImplementationTools();
		updateStatus(ctx);
		persist();

		queueAutonomousFollowUp(ctx, IMPLEMENTATION_KICKOFF_CUSTOM_TYPE, IMPLEMENTATION_KICKOFF_MESSAGE, () => {
			return mode === "implementing" && stage === 1;
		});
	}

	// -------------------------------------------------------------------------
	// /plan: enter plan mode, bind PROVIDER + LADDER[0], restrict tools.
	// -------------------------------------------------------------------------
	pi.registerCommand("plan", {
		description: "Enter plan mode — read-only tools, LADDER[0] for every call",
		handler: async (_args, ctx) => {
			await enterPlanMode(ctx);
		},
	});

	pi.registerCommand("stepdown", {
		description: "Show the resolved plan-stepdown config and current cursor",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatStepdownReport(ctx), "info");
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
	pi.on("before_agent_start", async (_event, ctx) => {
		if (mode === "planning") {
			return {
				message: { customType: "plan-stepdown-context", content: buildPlanPrompt(ctx), display: false },
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

	pi.on("context", async (event) => {
		if (mode !== "implementing" || !acceptedPlan) return;
		if (hasCustomMessage(event.messages, ACCEPTED_PLAN_CONTEXT_CUSTOM_TYPE)) return;
		const acceptedPlanMessage = buildAcceptedPlanContextMessage();
		if (!acceptedPlanMessage) return;
		return {
			messages: [acceptedPlanMessage, ...event.messages],
		};
	});

	// -------------------------------------------------------------------------
	// turn_start: if a bump is queued, arm it for this turn.
	// -------------------------------------------------------------------------
	pi.on("turn_start", async (_event, ctx) => {
		activeContextFallback = null;
		lastProviderRequest = null;
		if (mode !== "implementing") {
			updateStatus(ctx);
			return;
		}
		if (!pendingBump) {
			if (pendingMaxOutputRescue) {
				activeMaxOutputRescue = pendingMaxOutputRescue;
				pendingMaxOutputRescue = null;
			}
			updateStatus(ctx);
			return;
		}
		activeBump = pendingBump;
		pendingBump = null;
		pendingMaxOutputRescue = null;
		activeMaxOutputRescue = null;
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
			runtimeConfig.reasoningBump,
		);
		if (!reason) return;

		if (runtimeConfig.ladder.length === 0) return;
		const bumpIndex = Math.min(BUMP_RUNG_INDEX, runtimeConfig.ladder.length - 1);

		pendingBump = { rungIndex: bumpIndex, reason };
		updateStatus(ctx);
	});

	// -------------------------------------------------------------------------
	// before_provider_request: THE per-LLM-call seam. Rewrite the wire
	// payload's model + reasoning to LADDER[active]. Returning the
	// rewritten payload replaces what gets sent.
	// -------------------------------------------------------------------------
	pi.on("before_provider_request", (event, ctx) => {
		const preferredIndex =
			activeBump?.rungIndex ?? activeMaxOutputRescue?.rungIndex ?? chooseRungIndex(mode, stage, runtimeConfig.ladder);
		if (preferredIndex === null) return;

		const contextUsage = ctx.getContextUsage();
		const acceptedPlanContext = acceptedPlan ? formatAcceptedPlanContext(acceptedPlan) : null;
		const acceptedPlanTokens = acceptedPlanContext ? Math.ceil(acceptedPlanContext.length / 4) : 0;
		const selection = chooseContextSafeRungIndex(
			preferredIndex,
			runtimeConfig.ladder,
			runtimeConfig.ladder.map((candidate) => ({
				contextWindow: ctx.modelRegistry.find(runtimeConfig.provider, candidate.modelId)?.contextWindow,
			})),
			contextUsage?.tokens === null || contextUsage?.tokens === undefined
				? contextUsage?.tokens
				: contextUsage.tokens + acceptedPlanTokens,
			CONTEXT_FALLBACK_RESERVE_TOKENS,
		);
		if (!selection) return;

		const rung = runtimeConfig.ladder[selection.index];
		const appliedRung = getAppliedRung(rung);
		lastProviderRequest = { rungIndex: selection.index, thinking: appliedRung.thinking };
		const model = ctx.modelRegistry.find(runtimeConfig.provider, rung.modelId);
		const nextContextFallback =
			selection.fallback && contextUsage?.tokens
				? {
					fromIndex: preferredIndex,
					toIndex: selection.index,
					contextTokens: contextUsage.tokens,
					contextWindow: model?.contextWindow ?? 0,
				}
				: null;
		const contextFallbackChanged =
			activeContextFallback?.fromIndex !== nextContextFallback?.fromIndex ||
			activeContextFallback?.toIndex !== nextContextFallback?.toIndex ||
			activeContextFallback?.contextTokens !== nextContextFallback?.contextTokens ||
			activeContextFallback?.contextWindow !== nextContextFallback?.contextWindow;
		activeContextFallback = nextContextFallback;
		if (contextFallbackChanged) updateStatus(ctx);

		let payload = applyRungToPayload(event.payload, appliedRung);
		const webSearchEnabled = runtimeConfig.openaiWebSearch.enabled && model?.api === "openai-responses";
		payload = applyOpenAIWebSearchToPayload(payload, {
			enabled: webSearchEnabled,
			contextSize: rung.webSearchContextSize ?? "low",
			userLocation: webSearchEnabled ? getOpenAIWebSearchUserLocation() : undefined,
		});

		const supportsLongCacheRetention = model?.compat?.supportsLongCacheRetention ?? true;
		const promptCacheRetention =
			runtimeConfig.openaiPromptCache.retention === "24h" && !supportsLongCacheRetention
				? undefined
				: runtimeConfig.openaiPromptCache.retention === null
					? undefined
					: runtimeConfig.openaiPromptCache.retention;

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

		// If a bump, rescue override, or context fallback was active for this
		// turn, advance from the rung that actually handled the request.
		// Otherwise advance from the current stage as normal.
		const actualRungIndex = lastProviderRequest?.rungIndex ?? activeContextFallback?.toIndex ?? activeBump?.rungIndex ?? activeMaxOutputRescue?.rungIndex ?? stage;
		activeBump = null;
		activeMaxOutputRescue = null;
		activeContextFallback = null;

		stage = nextStage(actualRungIndex, runtimeConfig.ladder);
		if (stop !== "length") {
			consecutiveLengthAutoContinues = 0;
		}
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
	pi.on("agent_end", async (event, ctx) => {
		if (mode === "implementing") {
			const lastAssistant = [...event.messages]
				.reverse()
				.find((message) => message.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
			const stop = lastAssistant?.stopReason;
			const errorMessage = lastAssistant?.errorMessage;
			const maxOutputLike = isMaxOutputTokensLikeStop({ stopReason: stop, errorMessage });
			const hasPendingUserMessages = ctx.hasPendingMessages();

			pendingBump = null;
			activeBump = null;
			activeContextFallback = null;

			if (maxOutputLike && !hasPendingUserMessages && consecutiveMaxOutputRescues < MAX_CONSECUTIVE_MAX_OUTPUT_RESCUES && lastProviderRequest) {
				const nextEffort = nextReasoningEffortForMaxOutput(lastProviderRequest.thinking);
				if (nextEffort) {
					pendingMaxOutputRescue = {
						rungIndex: lastProviderRequest.rungIndex,
						from: lastProviderRequest.thinking,
						to: nextEffort,
					};
					consecutiveMaxOutputRescues++;
					consecutiveLengthAutoContinues = 0;
					updateStatus(ctx);
					persist();
					queueAutonomousFollowUp(
						ctx,
						IMPLEMENTATION_CONTINUE_CUSTOM_TYPE,
						IMPLEMENTATION_CONTINUE_MESSAGE,
						() => mode === "implementing" && stage > 0,
					);
					return;
				}
				if (runtimeConfig.ladder.length > 0) {
					pendingMaxOutputRescue = null;
					activeMaxOutputRescue = null;
					pendingBump = {
						rungIndex: Math.min(BUMP_RUNG_INDEX, runtimeConfig.ladder.length - 1),
						reason: MAX_OUTPUT_RESCUE_REASON,
					};
					consecutiveMaxOutputRescues++;
					consecutiveLengthAutoContinues = 0;
					updateStatus(ctx);
					persist();
					queueAutonomousFollowUp(
						ctx,
						IMPLEMENTATION_CONTINUE_CUSTOM_TYPE,
						IMPLEMENTATION_CONTINUE_MESSAGE,
						() => mode === "implementing" && stage > 0,
					);
					return;
				}
			}

			if (
				stop === "length" &&
				!hasPendingUserMessages &&
				consecutiveLengthAutoContinues < MAX_CONSECUTIVE_LENGTH_AUTO_CONTINUES
			) {
				consecutiveLengthAutoContinues++;
				updateStatus(ctx);
				persist();
				queueAutonomousFollowUp(
					ctx,
					IMPLEMENTATION_CONTINUE_CUSTOM_TYPE,
					IMPLEMENTATION_CONTINUE_MESSAGE,
					() => mode === "implementing" && stage > 0,
				);
				return;
			}

			clearTransientState();
			stage = 0;
			updateStatus(ctx);
			persist();
			return;
		}

		if (mode !== "planning") return;
		if (pi.getFlag(PLAN_AUTO_APPROVE_FLAG) === true) {
			setAcceptedPlan(extractAcceptedPlan(event.messages));
			startImplementation(ctx);
			return;
		}
		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select("Plan ready — what next?", [
			"Start implementation",
			"Refine — stay in plan mode",
			"Cancel — leave plan mode",
		]);

		if (choice === "Start implementation") {
			setAcceptedPlan(extractAcceptedPlan(event.messages));
			startImplementation(ctx);
		} else if (choice === "Cancel — leave plan mode") {
			reset(ctx);
		}
		// Refine: do nothing. Mode stays "planning"; LADDER[0] continues to apply.
	});

	// -------------------------------------------------------------------------
	// session_start: restore mode + stage across resume.
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const resolved = resolveConfig(ctx, pi);
		runtimeConfig = resolved.config;
		for (const warning of resolved.warnings) {
			ctx.ui.notify(`plan-stepdown: ${warning}`, "warning");
		}

		const branchEntries = ctx.sessionManager.getBranch();
		const last = branchEntries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plan-stepdown-state",
			)
			.pop() as { data?: { mode: Mode; stage: number } } | undefined;
		acceptedPlan = restoreAcceptedPlan(branchEntries);
		if (last?.data) {
			mode = last.data.mode;
			stage = last.data.stage;
			clearTransientState();
			if (mode === "planning") setPlanningTools(ctx);
			if (mode === "implementing") setImplementationTools();
			updateStatus(ctx);
		}
		if (pi.getFlag(PLAN_AUTO_APPROVE_FLAG) === true && mode === "idle") {
			await enterPlanMode(ctx);
		}
	});
}
