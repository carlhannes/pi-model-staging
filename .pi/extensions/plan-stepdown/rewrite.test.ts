/**
 * Tests for the per-turn payload rewriter.
 *
 * Run with:  node --test --experimental-strip-types .pi/extensions/plan-stepdown/rewrite.test.ts
 *
 * Fixtures mirror real wire payloads from
 *   pi-mono/packages/ai/src/providers/openai-responses.ts (buildParams)
 *   pi-mono/packages/ai/src/providers/openai-completions.ts
 *   pi-mono/packages/ai/src/providers/anthropic.ts (buildParams)
 *   pi-mono/packages/ai/src/providers/google.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	applyRungToPayload,
	chooseRung,
	detectApi,
	rungAt,
	type TurnRung,
} from "./rewrite.ts";

// ============================================================================
// detectApi
// ============================================================================

test("detectApi: openai-responses payload", () => {
	const p = {
		model: "gpt-5.5",
		input: [{ role: "user", content: "hi" }],
		stream: true,
		reasoning: { effort: "high", summary: "auto" },
		store: false,
	};
	assert.equal(detectApi(p), "openai-responses");
});

test("detectApi: openai-completions payload", () => {
	const p = {
		model: "gpt-4o",
		messages: [{ role: "user", content: "hi" }],
		stream: true,
		reasoning_effort: "high",
	};
	assert.equal(detectApi(p), "openai-completions");
});

test("detectApi: anthropic with thinking", () => {
	const p = {
		model: "claude-sonnet-4-6",
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 8192,
		stream: true,
		thinking: { type: "adaptive", display: "summarized" },
	};
	assert.equal(detectApi(p), "anthropic");
});

test("detectApi: anthropic with system + max_tokens but no thinking", () => {
	const p = {
		model: "claude-haiku-4-5",
		messages: [{ role: "user", content: "hi" }],
		system: "You are helpful.",
		max_tokens: 8192,
		stream: true,
	};
	assert.equal(detectApi(p), "anthropic");
});

test("detectApi: google generative ai payload", () => {
	const p = {
		model: "gemini-3-pro",
		contents: [{ role: "user", parts: [{ text: "hi" }] }],
		generationConfig: { thinkingConfig: { thinkingBudget: 4096 } },
	};
	assert.equal(detectApi(p), "google");
});

test("detectApi: garbage", () => {
	assert.equal(detectApi(null), "unknown");
	assert.equal(detectApi(undefined), "unknown");
	assert.equal(detectApi("string"), "unknown");
	assert.equal(detectApi(42), "unknown");
	assert.equal(detectApi({ random: "field" }), "unknown");
});

// ============================================================================
// rungAt clamping
// ============================================================================

test("rungAt: returns rung at index", () => {
	const ladder = [
		{ modelId: "a", thinking: "high" as const },
		{ modelId: "b", thinking: "medium" as const },
	];
	assert.deepEqual(rungAt(ladder, 0), ladder[0]);
	assert.deepEqual(rungAt(ladder, 1), ladder[1]);
});

test("rungAt: clamps past end to last", () => {
	const ladder = [
		{ modelId: "a", thinking: "high" as const },
		{ modelId: "b", thinking: "medium" as const },
	];
	assert.deepEqual(rungAt(ladder, 2), ladder[1]);
	assert.deepEqual(rungAt(ladder, 999), ladder[1]);
});

test("rungAt: clamps negative to first", () => {
	const ladder = [{ modelId: "a", thinking: "high" as const }];
	assert.deepEqual(rungAt(ladder, -1), ladder[0]);
});

test("rungAt: empty ladder returns undefined", () => {
	assert.equal(rungAt([], 0), undefined);
});

// ============================================================================
// applyRungToPayload — OpenAI Responses
// ============================================================================

test("openai-responses: swaps model and reasoning.effort", () => {
	const original = {
		model: "gpt-5.5",
		input: [{ role: "user", content: "hi" }],
		stream: true,
		reasoning: { effort: "xhigh", summary: "auto" },
		include: ["reasoning.encrypted_content"],
	};
	const out = applyRungToPayload(original, {
		modelId: "gpt-5.4",
		thinking: "high",
	}) as Record<string, unknown>;

	assert.equal(out.model, "gpt-5.4");
	assert.deepEqual(out.reasoning, { effort: "high", summary: "auto" });
	// preserved fields
	assert.deepEqual(out.input, original.input);
	assert.equal(out.stream, true);
	assert.deepEqual(out.include, original.include);
});

test("openai-responses: adds reasoning when payload had none (with auto summary)", () => {
	const original = {
		model: "gpt-5.5",
		input: [{ role: "user", content: "hi" }],
		stream: true,
	};
	const out = applyRungToPayload(original, {
		modelId: "gpt-5.4",
		thinking: "medium",
	}) as Record<string, unknown>;
	assert.equal(out.model, "gpt-5.4");
	assert.deepEqual(out.reasoning, { effort: "medium", summary: "auto" });
});

test("openai-responses: does not mutate input", () => {
	const original = {
		model: "gpt-5.5",
		input: [{ role: "user", content: "hi" }],
		reasoning: { effort: "xhigh", summary: "auto" },
	};
	const snapshot = JSON.parse(JSON.stringify(original));
	applyRungToPayload(original, { modelId: "gpt-5.4", thinking: "low" });
	assert.deepEqual(original, snapshot);
});

// ============================================================================
// applyRungToPayload — OpenAI Completions
// ============================================================================

test("openai-completions: swaps model and reasoning_effort", () => {
	const original = {
		model: "gpt-4o",
		messages: [{ role: "user", content: "hi" }],
		stream: true,
		reasoning_effort: "high",
	};
	const out = applyRungToPayload(original, {
		modelId: "gpt-4o-mini",
		thinking: "low",
	}) as Record<string, unknown>;
	assert.equal(out.model, "gpt-4o-mini");
	assert.equal(out.reasoning_effort, "low");
	assert.deepEqual(out.messages, original.messages);
});

test("openai-completions: openrouter-style nested reasoning is also rewritten", () => {
	const original = {
		model: "openai/gpt-4o",
		messages: [{ role: "user", content: "hi" }],
		reasoning: { effort: "high" },
	};
	const out = applyRungToPayload(original, {
		modelId: "openai/gpt-4o-mini",
		thinking: "minimal",
	}) as Record<string, unknown>;
	assert.equal(out.model, "openai/gpt-4o-mini");
	assert.deepEqual(out.reasoning, { effort: "minimal" });
	// reasoning_effort top-level is also set
	assert.equal(out.reasoning_effort, "minimal");
});

test("openai-completions: adds reasoning_effort if payload had none", () => {
	const original = {
		model: "gpt-4o",
		messages: [{ role: "user", content: "hi" }],
	};
	const out = applyRungToPayload(original, {
		modelId: "gpt-4o-mini",
		thinking: "high",
	}) as Record<string, unknown>;
	assert.equal(out.model, "gpt-4o-mini");
	assert.equal(out.reasoning_effort, "high");
});

// ============================================================================
// applyRungToPayload — Anthropic adaptive thinking
// ============================================================================

test("anthropic adaptive: swaps model and writes output_config.effort", () => {
	const original = {
		model: "claude-opus-4-7",
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 8192,
		thinking: { type: "adaptive", display: "summarized" },
		output_config: { effort: "xhigh" },
	};
	const out = applyRungToPayload(original, {
		modelId: "claude-sonnet-4-6",
		thinking: "high",
	}) as Record<string, unknown>;
	assert.equal(out.model, "claude-sonnet-4-6");
	assert.deepEqual(out.output_config, { effort: "high" });
	// thinking object preserved
	assert.deepEqual(out.thinking, original.thinking);
});

test("anthropic budget-based: model swaps but budget is left alone", () => {
	const original = {
		model: "claude-sonnet-4-0",
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 8192,
		thinking: { type: "enabled", budget_tokens: 4096, display: "summarized" },
	};
	const out = applyRungToPayload(original, {
		modelId: "claude-haiku-4-5",
		thinking: "low",
	}) as Record<string, unknown>;
	assert.equal(out.model, "claude-haiku-4-5");
	// budget_tokens is left as-is — see comment in rewrite.ts
	assert.deepEqual(out.thinking, original.thinking);
	// no output_config injected
	assert.equal(out.output_config, undefined);
});

// ============================================================================
// applyRungToPayload — graceful degradation
// ============================================================================

test("unknown payload: model still rewritten", () => {
	const original = { model: "weird", whoknows: 1 };
	const out = applyRungToPayload(original, {
		modelId: "weird-2",
		thinking: "medium",
	}) as Record<string, unknown>;
	assert.equal(out.model, "weird-2");
	assert.equal(out.whoknows, 1);
});

test("non-object payload: passes through unchanged", () => {
	assert.equal(applyRungToPayload(null, { modelId: "x", thinking: "high" }), null);
	assert.equal(applyRungToPayload(undefined, { modelId: "x", thinking: "high" }), undefined);
	assert.equal(applyRungToPayload("oops", { modelId: "x", thinking: "high" }), "oops");
});

// ============================================================================
// chooseRung — mode/turn dispatch
// ============================================================================

const PLAN_LADDER: TurnRung[] = [
	{ modelId: "p1", thinking: "xhigh" },
	{ modelId: "p2", thinking: "high" },
];
const EXEC_LADDER: TurnRung[] = [
	{ modelId: "e1", thinking: "xhigh" },
	{ modelId: "e2", thinking: "high" },
	{ modelId: "e3", thinking: "medium" },
];

test("chooseRung: idle → null", () => {
	assert.equal(chooseRung("idle", 0, 0, PLAN_LADDER, EXEC_LADDER), null);
});

test("chooseRung: planning uses planTurn against PLAN_LADDER", () => {
	assert.deepEqual(chooseRung("planning", 0, 99, PLAN_LADDER, EXEC_LADDER), PLAN_LADDER[0]);
	assert.deepEqual(chooseRung("planning", 1, 99, PLAN_LADDER, EXEC_LADDER), PLAN_LADDER[1]);
	// past end → clamps to last
	assert.deepEqual(chooseRung("planning", 5, 99, PLAN_LADDER, EXEC_LADDER), PLAN_LADDER[1]);
});

test("chooseRung: executing uses execTurn against EXEC_LADDER", () => {
	assert.deepEqual(chooseRung("executing", 99, 0, PLAN_LADDER, EXEC_LADDER), EXEC_LADDER[0]);
	assert.deepEqual(chooseRung("executing", 99, 2, PLAN_LADDER, EXEC_LADDER), EXEC_LADDER[2]);
	assert.deepEqual(chooseRung("executing", 99, 99, PLAN_LADDER, EXEC_LADDER), EXEC_LADDER[2]);
});

// ============================================================================
// End-to-end: simulate a full agent run with 5 turns and confirm each turn's
// payload gets the right rung applied.
// ============================================================================

test("end-to-end: 5 exec turns walk down EXEC_LADDER and clamp", () => {
	const ladder: TurnRung[] = [
		{ modelId: "gpt-5.5", thinking: "xhigh" },
		{ modelId: "gpt-5.5", thinking: "high" },
		{ modelId: "gpt-5.4", thinking: "xhigh" },
		{ modelId: "gpt-5.4", thinking: "high" },
	];
	const basePayload = () => ({
		model: "gpt-5.5",
		input: [{ role: "user", content: "do the thing" }],
		stream: true,
		reasoning: { effort: "xhigh", summary: "auto" },
	});

	const seenModels: string[] = [];
	const seenEfforts: string[] = [];

	for (let turn = 0; turn < 5; turn++) {
		const rung = chooseRung("executing", 0, turn, [], ladder);
		assert.ok(rung, `rung should not be null at turn ${turn}`);
		const out = applyRungToPayload(basePayload(), rung) as {
			model: string;
			reasoning: { effort: string };
		};
		seenModels.push(out.model);
		seenEfforts.push(out.reasoning.effort);
	}

	assert.deepEqual(seenModels, [
		"gpt-5.5",
		"gpt-5.5",
		"gpt-5.4",
		"gpt-5.4",
		"gpt-5.4", // clamped
	]);
	assert.deepEqual(seenEfforts, ["xhigh", "high", "xhigh", "high", "high"]);
});
