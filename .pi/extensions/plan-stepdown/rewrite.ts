/**
 * Pure payload-rewriting logic for plan-stepdown's single ladder.
 *
 * Kept free of pi imports so it can be unit-tested in isolation. Detects
 * which provider API the payload speaks and rewrites the model + reasoning
 * fields on a copy. Same-provider only — see README.
 */

import { createHash } from "node:crypto";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export type Rung = {
	modelId: string;
	thinking: ThinkingLevel;
};

export type PromptCacheRetention = "in_memory" | "24h";

export type PromptCacheOptions = {
	/** Stable affinity key for OpenAI prompt caching. Usually pi's session id. */
	key?: string;
	/** Set to "24h" for extended retention, "in_memory" to request default memory retention, or undefined to omit. */
	retention?: PromptCacheRetention;
};

export type Mode = "idle" | "planning" | "executing";

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

export type ApiKind =
	| "openai-responses"
	| "openai-completions"
	| "anthropic"
	| "google"
	| "unknown";

/**
 * Which rung applies given mode + the executing-stage counter.
 *
 *   idle       → null (extension does nothing)
 *   planning   → ladder[0] (always, for every LLM call during planning)
 *   executing  → ladder[stage], clamped to last rung so going past the
 *                end repeats the strongest tier-down forever
 *
 * `stage` is a single global counter. It's set to 1 when the user accepts
 * the plan, then incremented at the end of every executing turn. So:
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

	if (out.prompt_cache_key === undefined && options.key && options.key.length > 0) {
		out.prompt_cache_key = options.key;
	}

	if (out.prompt_cache_retention === undefined && options.retention) {
		out.prompt_cache_retention = options.retention;
	}

	return out;
}
