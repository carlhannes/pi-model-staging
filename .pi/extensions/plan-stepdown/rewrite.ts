/**
 * Pure payload-rewriting logic for plan-stepdown's single ladder.
 *
 * Kept free of pi imports so it can be unit-tested in isolation. Detects
 * which provider API the payload speaks and rewrites the model + reasoning
 * fields on a copy. Same-provider only — see README.
 */

import { createHash } from "node:crypto";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
export type WebSearchContextSize = "low" | "medium" | "high";
export type WebSearchContextSetting = WebSearchContextSize | "off";

export type Rung = {
	modelId: string;
	thinking: ThinkingLevel;
	/** Native OpenAI Responses web_search context size for this rung. "off" disables hosted search for the rung. */
	webSearchContextSize?: WebSearchContextSetting;
};

export type PromptCacheRetention = "in_memory" | "24h";

export type PromptCacheOptions = {
	/** Stable affinity key for OpenAI prompt caching. Usually pi's session id. */
	key?: string;
	/** Set to "24h" for extended retention, "in_memory" to request default memory retention, or undefined to omit. */
	retention?: PromptCacheRetention;
};

export type OpenAIWebSearchOptions = {
	/** Default-on feature gate. Set false for proxies/models that reject hosted web_search. */
	enabled: boolean;
	/** Per-rung Responses web_search context size. "off" disables hosted search for this payload. */
	contextSize?: WebSearchContextSetting;
};

export type ReasoningBumpConfig = {
	/** Bump reasoning for the next LLM call when a bash command fails (non-zero exit, timeout, etc.). */
	bumpOnFailedBash: boolean;
	/** Bump reasoning for the next LLM call when a non-bash tool fails (edit exact-match errors, read failures, etc.). */
	bumpOnFailedTool: boolean;
	/** Bump reasoning for the next LLM call when a package-manager command output must be interpreted. */
	bumpOnPackageManagerCommand: boolean;
	/** Which executables count as package managers (matched at the start of the bash command). */
	packageManagerCommands: readonly string[];
};

export type ToolResultForBump = {
	toolName: string;
	input?: Record<string, unknown>;
	isError: boolean;
};

export type Mode = "idle" | "planning" | "implementing";

/**
 * Build a stable OpenAI prompt-cache affinity key for this local project.
 *
 * The namespace/prefix is deliberately outside the hash so provider logs can
 * identify this extension's keys without exposing the raw username or path.
 */
export function createPromptCacheKey(prefix: string, username: string, cwd: string): string {
	const digest = createHash("sha256").update(username).update("\0").update(cwd).digest("hex").slice(0, 32);
	return `${prefix}${digest}`;
}

/**
 * Advance the stage cursor by one, clamped to the last rung. The caller
 * decides what `from` should be — either the current stage (for a normal
 * turn_end) or the just-active bump's rung index (so post-bump stepping
 * resumes at the rung *after* the bump rather than wherever stage was).
 */
export function nextStage(from: number, ladder: readonly Rung[]): number {
	if (ladder.length === 0) return 0;
	return Math.min(from + 1, ladder.length - 1);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function startsWithShellCommand(command: string, executable: string): boolean {
	const trimmed = command.trimStart();
	if (!trimmed) return false;
	const pattern = new RegExp(`^${escapeRegExp(executable)}(?:$|[\\s;&|()<>])`);
	return pattern.test(trimmed);
}

export function detectReasoningBump(event: ToolResultForBump, config: ReasoningBumpConfig): string | null {
	// Priority: failures first (most important to recover correctly).
	if (event.toolName === "bash") {
		const command = typeof event.input?.command === "string" ? event.input.command : undefined;
		if (config.bumpOnFailedBash && event.isError) return "failed bash command";

		if (command && config.bumpOnPackageManagerCommand) {
			const pm = config.packageManagerCommands.find((name) => startsWithShellCommand(command, name));
			if (pm) return `${pm} command result`;
		}

		return null;
	}

	if (config.bumpOnFailedTool && event.isError) {
		return `failed ${event.toolName} tool`;
	}

	return null;
}

export type ApiKind =
	| "openai-responses"
	| "openai-completions"
	| "anthropic"
	| "google"
	| "unknown";

/**
 * Which rung applies given mode + the implementation-stage counter.
 *
 *   idle           → null (extension does nothing)
 *   planning       → ladder[0] (always, for every LLM call during planning)
 *   implementing   → ladder[stage], clamped to last rung so going past the
 *                    end repeats the strongest tier-down forever
 *
 * `stage` is a single global counter. It's set to 1 when the user accepts
 * the plan, then incremented at the end of every implementing turn. So:
 *   stage=1 → ladder[1]  (first LLM call after plan accepted)
 *   stage=2 → ladder[2]  (second LLM call)
 *   ...and so on
 */
export function chooseRung(
	mode: Mode,
	stage: number,
	ladder: readonly Rung[],
): Rung | null {
	if (mode === "idle") return null;
	if (ladder.length === 0) return null;
	if (mode === "planning") return ladder[0];
	const idx = Math.max(0, Math.min(stage, ladder.length - 1));
	return ladder[idx];
}

/**
 * Detect the provider API by sniffing distinctive payload fields. The
 * payload is the wire request body about to be sent — see
 * pi-mono/packages/ai/src/providers/*.ts for the exact builders.
 */
export function detectApi(payload: unknown): ApiKind {
	if (!payload || typeof payload !== "object") return "unknown";
	const p = payload as Record<string, unknown>;

	// OpenAI Responses uses `input` (array) instead of `messages`.
	if (Array.isArray(p.input)) return "openai-responses";

	// Google uses `contents` with `generationConfig`.
	if (Array.isArray(p.contents)) return "google";

	// Anthropic and OpenAI Completions both have `messages`. Anthropic has
	// `max_tokens` (required) and may have top-level `system` or `thinking`.
	if (Array.isArray(p.messages)) {
		if (
			"thinking" in p ||
			"output_config" in p ||
			(typeof p.max_tokens === "number" && "system" in p)
		) {
			return "anthropic";
		}
		return "openai-completions";
	}

	return "unknown";
}

/**
 * Return a NEW payload object with model + reasoning swapped for `rung`.
 * Never mutates the input. Same-provider only — caller is responsible for
 * making sure the rung's model lives on the same provider as the original.
 */
export function applyRungToPayload(payload: unknown, rung: Rung): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const api = detectApi(payload);
	const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };

	out.model = rung.modelId;

	switch (api) {
		case "openai-responses": {
			const prev = (out.reasoning as Record<string, unknown> | undefined) ?? {};
			out.reasoning = { ...prev, effort: rung.thinking };
			if (!("summary" in prev)) {
				(out.reasoning as Record<string, unknown>).summary = "auto";
			}
			break;
		}
		case "openai-completions": {
			out.reasoning_effort = rung.thinking;
			if (
				typeof out.reasoning === "object" &&
				out.reasoning !== null &&
				"effort" in (out.reasoning as Record<string, unknown>)
			) {
				out.reasoning = { ...(out.reasoning as Record<string, unknown>), effort: rung.thinking };
			}
			break;
		}
		case "anthropic": {
			const thinking = out.thinking as Record<string, unknown> | undefined;
			if (thinking?.type === "adaptive") {
				out.output_config = { effort: rung.thinking };
			}
			break;
		}
		case "google":
			break;
		case "unknown":
			break;
	}

	return out;
}

function hasHostedWebSearchTool(tools: unknown[]): boolean {
	return tools.some((tool) => {
		if (!tool || typeof tool !== "object") return false;
		const type = (tool as Record<string, unknown>).type;
		// We only inject modern `web_search`, but avoid adding a second hosted
		// search tool if another layer already supplied the legacy preview tool.
		return type === "web_search" || type === "web_search_preview";
	});
}

/**
 * Add OpenAI Responses native hosted web search to a NEW payload object.
 * Existing coding/function tools are preserved, and `web_search` is never
 * duplicated. Non-Responses payloads pass through unchanged.
 */
export function applyOpenAIWebSearchToPayload(payload: unknown, options: OpenAIWebSearchOptions): unknown {
	if (!options.enabled) return payload;
	const contextSize = options.contextSize ?? "low";
	if (contextSize === "off") return payload;
	if (!payload || typeof payload !== "object") return payload;
	if (detectApi(payload) !== "openai-responses") return payload;

	const p = payload as Record<string, unknown>;
	if (p.tools !== undefined && !Array.isArray(p.tools)) return payload;

	const existingTools = Array.isArray(p.tools) ? p.tools : [];
	const out: Record<string, unknown> = { ...p };

	if (!hasHostedWebSearchTool(existingTools)) {
		out.tools = [...existingTools, { type: "web_search", search_context_size: contextSize }];
	}

	if (out.tool_choice === undefined) {
		out.tool_choice = "auto";
	}

	return out;
}

/**
 * Add OpenAI prompt-cache affinity fields to a NEW payload object when they
 * are missing. Existing provider/pi values are preserved, including `null`
 * (explicitly disabled) and non-empty strings.
 *
 * This is intentionally separate from applyRungToPayload(): model/effort
 * rewriting is the core feature, while prompt caching is a conservative
 * OpenAI-only augmentation. Non-OpenAI payloads pass through unchanged.
 */
export function applyPromptCacheToPayload(payload: unknown, options: PromptCacheOptions): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const api = detectApi(payload);
	if (api !== "openai-responses" && api !== "openai-completions") return payload;

	const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };

	// Respect explicit user opt-out. Pi sets prompt_cache_key based on
	// session id and prompt_cache_retention based on compat config; when both
	// are undefined here that's pi signalling "caching disabled" (typically
	// because the user set cacheRetention: "none" in pi settings — see
	// pi-mono/packages/ai/src/providers/openai-responses.ts:226). Augmenting
	// in that case would silently re-enable what the user turned off, so we
	// pass the payload through untouched.
	const piDisabledCaching =
		out.prompt_cache_key === undefined && out.prompt_cache_retention === undefined;
	if (piDisabledCaching) return out;

	if (out.prompt_cache_key === undefined && options.key && options.key.length > 0) {
		out.prompt_cache_key = options.key;
	}

	if (out.prompt_cache_retention === undefined && options.retention) {
		out.prompt_cache_retention = options.retention;
	}

	return out;
}
