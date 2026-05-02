/**
 * Pure payload-rewriting logic for plan-stepdown's per-turn ladder.
 *
 * Kept free of pi imports so it can be unit-tested in isolation. Detects
 * which provider API the payload speaks and rewrites the model + reasoning
 * fields in place of a copy. Same-provider only — see README for why.
 */

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export type TurnRung = {
	modelId: string;
	thinking: ThinkingLevel;
};

export type ApiKind =
	| "openai-responses"
	| "openai-completions"
	| "anthropic"
	| "google"
	| "unknown";

/**
 * Pick the rung for a given turn index, clamped so going past the end
 * just repeats the last rung forever.
 */
export function rungAt<R>(ladder: readonly R[], turnIdx: number): R | undefined {
	if (ladder.length === 0) return undefined;
	const idx = Math.max(0, Math.min(turnIdx, ladder.length - 1));
	return ladder[idx];
}

/**
 * Detect the provider API by sniffing distinctive payload fields. The
 * payload is the wire request body about to be sent to the provider — see
 * pi-mono/packages/ai/src/providers/*.ts for the exact builders.
 */
export function detectApi(payload: unknown): ApiKind {
	if (!payload || typeof payload !== "object") return "unknown";
	const p = payload as Record<string, unknown>;

	// OpenAI Responses uses `input` (array) instead of `messages`. See
	// openai-responses.ts: `{ model, input, stream, prompt_cache_key, ... }`.
	if (Array.isArray(p.input)) return "openai-responses";

	// Google uses `contents` with `generationConfig`. See google.ts.
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
		// Anthropic without a system prompt and without thinking enabled is
		// indistinguishable from openai-completions on shape alone. We assume
		// completions; pi will set thinking on Anthropic models that support
		// it, so the ambiguous case is rare in practice.
		return "openai-completions";
	}

	return "unknown";
}

/**
 * Return a NEW payload object with model/reasoning swapped for `rung`.
 * Never mutates the input. Same-provider only — caller is responsible for
 * making sure the rung's model lives on the same provider as the original.
 */
export function applyRungToPayload(payload: unknown, rung: TurnRung): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const api = detectApi(payload);
	const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };

	out.model = rung.modelId;

	switch (api) {
		case "openai-responses": {
			const prev = (out.reasoning as Record<string, unknown> | undefined) ?? {};
			out.reasoning = { ...prev, effort: rung.thinking };
			// Echo summary if it was set; if reasoning wasn't enabled at all
			// before, default to "auto" so we don't drop encrypted reasoning.
			if (!("summary" in prev)) {
				(out.reasoning as Record<string, unknown>).summary = "auto";
			}
			// `include` controls encrypted reasoning blocks — preserve if set.
			break;
		}
		case "openai-completions": {
			out.reasoning_effort = rung.thinking;
			// OpenRouter compat uses nested `reasoning.effort`. If the original
			// payload had it, keep that shape too.
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
			// Adaptive thinking models use top-level `output_config.effort`.
			if (thinking?.type === "adaptive") {
				out.output_config = { effort: rung.thinking };
			}
			// Budget-based thinking uses `thinking.budget_tokens` directly. We
			// don't try to translate effort→tokens here; if you need that,
			// set the ladder up with explicit budgets in a separate field or
			// pre-translate in your proxy. The model swap still applies.
			break;
		}
		case "google": {
			// Google uses generationConfig.thinkingConfig.thinkingBudget. Same
			// caveat as Anthropic budget-based: we leave the budget alone and
			// only swap the model. Pi maps effort→budget; doing it here would
			// duplicate that mapping.
			break;
		}
		case "unknown":
			// Best-effort: just rewrite model. Better than crashing.
			break;
	}

	return out;
}

/**
 * Decide which ladder + turn index applies given the current mode and
 * counters. Returns null if the extension shouldn't act this turn.
 */
export type Mode = "idle" | "planning" | "executing";

export function chooseRung(
	mode: Mode,
	planTurn: number,
	execTurn: number,
	planLadder: readonly TurnRung[],
	execLadder: readonly TurnRung[],
): TurnRung | null {
	if (mode === "idle") return null;
	const ladder = mode === "planning" ? planLadder : execLadder;
	const idx = mode === "planning" ? planTurn : execTurn;
	return rungAt(ladder, idx) ?? null;
}
