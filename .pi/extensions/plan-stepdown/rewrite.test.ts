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
	applyPromptCacheToPayload,
	applyRungToPayload,
	chooseRung,
	createPromptCacheKey,
	detectApi,
	detectReasoningBump,
	nextStage,
	startsWithShellCommand,
	type ReasoningBumpConfig,
	type Rung,
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

// (rungAt was inlined into chooseRung — its clamping behaviour is now
// covered by the chooseRung tests below.)

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
// createPromptCacheKey
// ============================================================================

test("createPromptCacheKey: hashes username + cwd with visible prefix", () => {
	const a = createPromptCacheKey("pi-model-staging:", "alice", "/repo/a");
	const b = createPromptCacheKey("pi-model-staging:", "alice", "/repo/a");
	const c = createPromptCacheKey("pi-model-staging:", "alice", "/repo/b");
	const d = createPromptCacheKey("pi-model-staging:", "bob", "/repo/a");

	assert.equal(a, b);
	assert.match(a, /^pi-model-staging:[0-9a-f]{32}$/);
	assert.notEqual(a, c);
	assert.notEqual(a, d);
	assert.ok(!a.includes("alice"));
	assert.ok(!a.includes("/repo/a"));
});

// ============================================================================
// applyPromptCacheToPayload — OpenAI prompt caching (augmentation)
// ============================================================================

test("prompt cache: openai-responses with pi-set key augments retention (the common path)", () => {
	// Realistic: pi has set prompt_cache_key from sessionId. Our extension
	// supplies the longer 24h retention on top. Both fields must end up in
	// the wire payload.
	const original = {
		model: "gpt-5.5",
		input: [{ role: "user", content: "hi" }],
		stream: true,
		prompt_cache_key: "pi-session-id-abc",
	};
	const out = applyPromptCacheToPayload(original, { key: "should-not-override", retention: "24h" }) as Record<
		string,
		unknown
	>;
	assert.equal(out.prompt_cache_key, "pi-session-id-abc"); // pi's key preserved
	assert.equal(out.prompt_cache_retention, "24h"); // retention augmented
	// preserved
	assert.equal(out.model, "gpt-5.5");
	assert.deepEqual(out.input, original.input);
});

test("prompt cache: openai-completions adds prompt_cache_key only when retention omitted", () => {
	const original = {
		model: "gpt-4o",
		messages: [{ role: "user", content: "hi" }],
		stream: true,
		// pi has set the key but not the retention — partial signal, NOT
		// "disabled". Augment retention only.
		prompt_cache_key: "pi-session-existing",
	};
	const out = applyPromptCacheToPayload(original, { key: "session-456" }) as Record<string, unknown>;
	assert.equal(out.prompt_cache_key, "pi-session-existing");
	assert.equal(out.prompt_cache_retention, undefined);
});

test("prompt cache: respects pi-disabled caching (both fields undefined → pass through)", () => {
	// When pi has cacheRetention: "none" in settings, it leaves BOTH
	// prompt_cache_key and prompt_cache_retention undefined. We must not
	// silently re-enable caching by injecting our key — see the comment
	// in applyPromptCacheToPayload.
	const original = {
		model: "gpt-5.5",
		input: [{ role: "user", content: "hi" }],
		stream: true,
	};
	const out = applyPromptCacheToPayload(original, { key: "should-not-be-injected", retention: "24h" }) as Record<
		string,
		unknown
	>;
	assert.equal(out.prompt_cache_key, undefined);
	assert.equal(out.prompt_cache_retention, undefined);
});

test("prompt cache: pi set retention but not key → augment key only (still treats as enabled)", () => {
	// Edge: pi set retention but not key. That's not the "disabled" signal
	// (which is BOTH undefined), so we should still augment the key.
	const original = {
		model: "gpt-5.5",
		input: [{ role: "user", content: "hi" }],
		prompt_cache_retention: "in_memory",
	};
	const out = applyPromptCacheToPayload(original, { key: "session-abc", retention: "24h" }) as Record<
		string,
		unknown
	>;
	assert.equal(out.prompt_cache_key, "session-abc");
	assert.equal(out.prompt_cache_retention, "in_memory");
});

test("prompt cache: preserves existing provider fields (including null)", () => {
	const original = {
		model: "gpt-5.5",
		input: [{ role: "user", content: "hi" }],
		prompt_cache_key: null,
		prompt_cache_retention: "24h",
	};
	const out = applyPromptCacheToPayload(original, { key: "session-should-not-override", retention: "24h" }) as Record<
		string,
		unknown
	>;
	assert.equal(out.prompt_cache_key, null);
	assert.equal(out.prompt_cache_retention, "24h");
});

test("prompt cache: non-openai payload passes through unchanged", () => {
	const original = {
		model: "gemini",
		contents: [{ role: "user", parts: [{ text: "hi" }] }],
	};
	const out = applyPromptCacheToPayload(original, { key: "session-1", retention: "24h" });
	assert.deepEqual(out, original);
});

test("prompt cache: does not mutate input", () => {
	const original = {
		model: "gpt-5.5",
		input: [{ role: "user", content: "hi" }],
		stream: true,
	};
	const snapshot = JSON.parse(JSON.stringify(original));
	applyPromptCacheToPayload(original, { key: "session-123", retention: "24h" });
	assert.deepEqual(original, snapshot);
});

// ============================================================================
// Reasoning bumps — trigger detection
// ============================================================================

test("startsWithShellCommand: matches only at start (after whitespace)", () => {
	assert.equal(startsWithShellCommand("npm test", "npm"), true);
	assert.equal(startsWithShellCommand("  npm   run build", "npm"), true);
	assert.equal(startsWithShellCommand("npm", "npm"), true);
	assert.equal(startsWithShellCommand("pnpm test", "npm"), false);
	assert.equal(startsWithShellCommand("echo npm test", "npm"), false);
	assert.equal(startsWithShellCommand("cd x && npm test", "npm"), false);
});

test("detectReasoningBump: bumps on failed bash", () => {
	const cfg: ReasoningBumpConfig = {
		bumpOnFailedBash: true,
		bumpOnPackageManagerCommand: true,
		packageManagerCommands: ["npm", "pnpm", "yarn", "bun"],
	};
	assert.equal(
		detectReasoningBump({ toolName: "bash", input: { command: "npm test" }, isError: true }, cfg),
		"failed bash command",
	);
});

test("detectReasoningBump: bumps on npm output even when successful", () => {
	const cfg: ReasoningBumpConfig = {
		bumpOnFailedBash: true,
		bumpOnPackageManagerCommand: true,
		packageManagerCommands: ["npm", "pnpm", "yarn", "bun"],
	};
	assert.equal(
		detectReasoningBump({ toolName: "bash", input: { command: "npm test" }, isError: false }, cfg),
		"npm command result",
	);
});

test("detectReasoningBump: bumps on other package managers", () => {
	const cfg: ReasoningBumpConfig = {
		bumpOnFailedBash: true,
		bumpOnPackageManagerCommand: true,
		packageManagerCommands: ["npm", "pnpm", "yarn", "bun"],
	};
	assert.equal(
		detectReasoningBump({ toolName: "bash", input: { command: "pnpm test" }, isError: false }, cfg),
		"pnpm command result",
	);
});

test("detectReasoningBump: no bump for non-matching bash", () => {
	const cfg: ReasoningBumpConfig = {
		bumpOnFailedBash: true,
		bumpOnPackageManagerCommand: true,
		packageManagerCommands: ["npm", "pnpm", "yarn", "bun"],
	};
	assert.equal(
		detectReasoningBump({ toolName: "bash", input: { command: "git status" }, isError: false }, cfg),
		null,
	);
});

const STAGE_LADDER: Rung[] = [
	{ modelId: "r0", thinking: "high" },
	{ modelId: "r1", thinking: "high" },
	{ modelId: "r2", thinking: "high" },
	{ modelId: "r3", thinking: "high" },
];

test("nextStage: advances by one, clamped to last rung", () => {
	assert.equal(nextStage(0, STAGE_LADDER), 1);
	assert.equal(nextStage(2, STAGE_LADDER), 3);
	assert.equal(nextStage(3, STAGE_LADDER), 3); // clamped
	assert.equal(nextStage(99, STAGE_LADDER), 3); // far past end
});

test("nextStage: post-bump caller passes the bump index — advance from there", () => {
	// Caller-side composition: nextStage(activeBumpIndex ?? stage, ladder)
	// A bump on [1] should resume at [2] regardless of where stage was.
	assert.equal(nextStage(1, STAGE_LADDER), 2);
});

test("nextStage: ladder size 1 stays at 0", () => {
	const ladder: Rung[] = [{ modelId: "only", thinking: "high" }];
	assert.equal(nextStage(0, ladder), 0);
});

test("nextStage: empty ladder returns 0", () => {
	assert.equal(nextStage(5, []), 0);
});

// ============================================================================
// chooseRung — mode/stage dispatch
// ============================================================================

const LADDER: Rung[] = [
	{ modelId: "quick", thinking: "xhigh" },  // [0] plan + user-facing
	{ modelId: "model-a", thinking: "xhigh" }, // [1] first autonomous step
	{ modelId: "model-a", thinking: "high" },  // [2]
	{ modelId: "model-b", thinking: "high" },  // [3]
];

test("chooseRung: idle → null", () => {
	assert.equal(chooseRung("idle", 0, LADDER), null);
	assert.equal(chooseRung("idle", 99, LADDER), null);
});

test("chooseRung: empty ladder → null", () => {
	assert.equal(chooseRung("planning", 0, []), null);
	assert.equal(chooseRung("implementing", 5, []), null);
});

test("chooseRung: planning always returns LADDER[0] regardless of stage", () => {
	assert.deepEqual(chooseRung("planning", 0, LADDER), LADDER[0]);
	assert.deepEqual(chooseRung("planning", 1, LADDER), LADDER[0]);
	assert.deepEqual(chooseRung("planning", 99, LADDER), LADDER[0]);
});

test("chooseRung: implementing returns LADDER[stage]", () => {
	assert.deepEqual(chooseRung("implementing", 0, LADDER), LADDER[0]);
	assert.deepEqual(chooseRung("implementing", 1, LADDER), LADDER[1]);
	assert.deepEqual(chooseRung("implementing", 2, LADDER), LADDER[2]);
	assert.deepEqual(chooseRung("implementing", 3, LADDER), LADDER[3]);
});

test("chooseRung: implementing past the end clamps to last", () => {
	assert.deepEqual(chooseRung("implementing", 4, LADDER), LADDER[3]);
	assert.deepEqual(chooseRung("implementing", 99, LADDER), LADDER[3]);
});

test("chooseRung: implementing with negative stage clamps to first", () => {
	assert.deepEqual(chooseRung("implementing", -1, LADDER), LADDER[0]);
});

// ============================================================================
// End-to-end lifecycle: simulate the full plan→exec→follow-up flow and
// confirm each LLM call gets the right rung's model + effort.
//
// The state machine driving stage transitions lives in index.ts, but the
// rules are simple enough to encode inline here:
//
//   /plan                              mode=planning, stage=0
//   turn_end during implementing       stage = min(stage+1, len-1)
//   accept                             mode=implementing, stage=1
//   agent_end during implementing      stage=0
// ============================================================================

test("end-to-end: full lifecycle uses correct rung at every LLM call", () => {
	const ladder: Rung[] = [
		{ modelId: "gpt-5.5:quick", thinking: "xhigh" },
		{ modelId: "gpt-5.5", thinking: "xhigh" },
		{ modelId: "gpt-5.5", thinking: "high" },
		{ modelId: "gpt-5.4", thinking: "high" },
	];
	const basePayload = () => ({
		model: "ignored",
		input: [{ role: "user", content: "x" }],
		stream: true,
		reasoning: { effort: "ignored", summary: "auto" },
	});

	const seen: string[] = [];

	function fire(mode: "planning" | "implementing", stage: number) {
		const rung = chooseRung(mode, stage, ladder);
		assert.ok(rung);
		const out = applyRungToPayload(basePayload(), rung) as {
			model: string;
			reasoning: { effort: string };
		};
		seen.push(`${out.model}:${out.reasoning.effort}`);
		return rung;
	}

	// /plan → mode=planning, stage=0
	let mode: "planning" | "implementing" = "planning";
	let stage = 0;

	// Plan run with 3 turns (LLM does some reads, asks for clarification).
	fire(mode, stage); // turn 1
	fire(mode, stage); // turn 2
	fire(mode, stage); // turn 3
	// agent_end during planning fires the dialog (no stage mutation here).

	// Accept → mode=implementing, stage=1, "Please start implementation."
	// auto-prompt fires.
	mode = "implementing";
	stage = 1;

	// Implementing run #1: 4 turns. stage advances at each turn_end.
	fire(mode, stage); stage = Math.min(stage + 1, ladder.length - 1); // turn 1
	fire(mode, stage); stage = Math.min(stage + 1, ladder.length - 1); // turn 2
	fire(mode, stage); stage = Math.min(stage + 1, ladder.length - 1); // turn 3
	fire(mode, stage); stage = Math.min(stage + 1, ladder.length - 1); // turn 4 (clamped)

	// agent_end during implementing → reset stage to 0.
	stage = 0;

	// User follow-up "also do X". Run #2: 3 turns.
	fire(mode, stage); stage = Math.min(stage + 1, ladder.length - 1); // turn 1
	fire(mode, stage); stage = Math.min(stage + 1, ladder.length - 1); // turn 2
	fire(mode, stage); stage = Math.min(stage + 1, ladder.length - 1); // turn 3

	// agent_end → reset.
	stage = 0;

	// One more follow-up, single turn.
	fire(mode, stage);

	assert.deepEqual(seen, [
		// 3 plan turns: all LADDER[0]
		"gpt-5.5:quick:xhigh",
		"gpt-5.5:quick:xhigh",
		"gpt-5.5:quick:xhigh",
		// Start implementation run: starts at LADDER[1], steps to [3], then clamps.
		"gpt-5.5:xhigh",
		"gpt-5.5:high",
		"gpt-5.4:high",
		"gpt-5.4:high", // clamped
		// Follow-up #1: starts at LADDER[0] (user-facing), steps down.
		"gpt-5.5:quick:xhigh",
		"gpt-5.5:xhigh",
		"gpt-5.5:high",
		// Follow-up #2 single turn: LADDER[0].
		"gpt-5.5:quick:xhigh",
	]);
});

// ============================================================================
// End-to-end with reasoning bump: simulate an implementing run where a bash
// failure mid-stream triggers a one-shot bump, then confirm the bumped turn
// uses LADDER[1] AND the next normal turn resumes at LADDER[2] (not back at
// the pre-bump stage cursor).
//
// State machine (subset relevant here):
//   tool_result trigger     pendingBump = { rungIndex: BUMP_RUNG_INDEX }
//   turn_start               activeBump = pendingBump; pendingBump = null
//   before_provider_request  rung = activeBump ? LADDER[bump] : LADDER[stage]
//   turn_end                 stage = nextStage(activeBump?.rungIndex ?? stage, ladder)
//                            activeBump = null
// ============================================================================

test("end-to-end with bump: bumped turn uses LADDER[1], next turn resumes at LADDER[2]", () => {
	const ladder: Rung[] = [
		{ modelId: "gpt-5.5:quick", thinking: "xhigh" }, // [0] never reached here
		{ modelId: "gpt-5.5", thinking: "xhigh" }, // [1] post-accept + bump target
		{ modelId: "gpt-5.5", thinking: "high" }, // [2] post-bump resume
		{ modelId: "gpt-5.4", thinking: "high" }, // [3]
	];
	const BUMP_INDEX = Math.min(1, ladder.length - 1);

	const basePayload = () => ({
		model: "ignored",
		input: [{ role: "user", content: "x" }],
		stream: true,
		reasoning: { effort: "ignored", summary: "auto" },
	});

	const seen: string[] = [];
	let stage = 1; // accept just happened
	let pendingBump: { rungIndex: number } | null = null;
	let activeBump: { rungIndex: number } | null = null;

	function fireTurn() {
		// turn_start: arm the bump if queued.
		if (pendingBump) {
			activeBump = pendingBump;
			pendingBump = null;
		}
		// before_provider_request: bump wins over normal stage.
		const rung = activeBump
			? ladder[activeBump.rungIndex]
			: chooseRung("implementing", stage, ladder);
		assert.ok(rung);
		const out = applyRungToPayload(basePayload(), rung) as {
			model: string;
			reasoning: { effort: string };
		};
		seen.push(`${out.model}:${out.reasoning.effort}`);
		// turn_end: advance stage from bump target if there was one.
		const activeBumpIndex = activeBump?.rungIndex;
		activeBump = null;
		stage = nextStage(activeBumpIndex ?? stage, ladder);
	}

	// Turn 1: normal post-accept turn. Should use LADDER[1].
	fireTurn();

	// Between turns 2 and 3 the agent ran `npm test` and the result fired a
	// bump trigger. Queue it before turn 2 starts.
	pendingBump = { rungIndex: BUMP_INDEX };

	// Turn 2: bump active. Should use LADDER[1] (the bump target).
	fireTurn();

	// Turn 3: no new bump. Stage was advanced from bump index (1) → 2.
	// Should use LADDER[2].
	fireTurn();

	// Turn 4: continues stepping down to LADDER[3].
	fireTurn();

	assert.deepEqual(seen, [
		"gpt-5.5:xhigh", // turn 1: LADDER[1] (post-accept default)
		"gpt-5.5:xhigh", // turn 2: LADDER[1] (bump target — same value here, but bump path used)
		"gpt-5.5:high", // turn 3: LADDER[2] (resumed AFTER the bump rung, not from pre-bump stage)
		"gpt-5.4:high", // turn 4: LADDER[3]
	]);
});
