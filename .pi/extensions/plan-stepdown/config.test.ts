import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PLAN_STEPDOWN_CONFIG,
	mergePlanStepdownConfig,
	parsePlanStepdownConfig,
} from "./config.ts";

test("parsePlanStepdownConfig: rejects non-object", () => {
	const { config, warnings } = parsePlanStepdownConfig("oops", "global");
	assert.deepEqual(config, {});
	assert.ok(warnings.some((w) => w.includes("global")));
});

test("parsePlanStepdownConfig: parses minimal valid provider override", () => {
	const { config, warnings } = parsePlanStepdownConfig({ provider: "x" }, "project");
	assert.deepEqual(warnings, []);
	assert.equal(config.provider, "x");
});

test("parsePlanStepdownConfig: parses ladder", () => {
	const { config, warnings } = parsePlanStepdownConfig(
		{
			ladder: [
				{ modelId: "m1", thinking: "high" },
				{ modelId: "m2", thinking: "low", webSearchContextSize: "off" },
			],
		},
		"project",
	);
	assert.deepEqual(warnings, []);
	assert.ok(config.ladder);
	assert.equal(config.ladder?.length, 2);
});

test("parsePlanStepdownConfig: rejects invalid thinking levels", () => {
	const { config, warnings } = parsePlanStepdownConfig(
		{ ladder: [{ modelId: "m1", thinking: "turbo" }] },
		"project",
	);
	assert.equal(config.ladder, undefined);
	assert.ok(warnings.some((warning) => warning.includes("ladder entries")));
});

test("parsePlanStepdownConfig: rejects empty ladder", () => {
	const { config, warnings } = parsePlanStepdownConfig({ ladder: [] }, "project");
	assert.equal(config.ladder, undefined);
	assert.ok(warnings.some((warning) => warning.includes("must not be empty")));
});

test("mergePlanStepdownConfig: project overrides replace ladder arrays", () => {
	const base = DEFAULT_PLAN_STEPDOWN_CONFIG;
	const merged = mergePlanStepdownConfig(base, {
		ladder: [{ modelId: "only", thinking: "medium" }],
	});
	assert.equal(merged.ladder.length, 1);
	assert.equal(merged.ladder[0]?.modelId, "only");
});

test("mergePlanStepdownConfig: tools arrays replace", () => {
	const base = DEFAULT_PLAN_STEPDOWN_CONFIG;
	const merged = mergePlanStepdownConfig(base, {
		tools: { plan: ["read"], implementation: ["read", "write"] },
	});
	assert.deepEqual(merged.tools.plan, ["read"]);
	assert.deepEqual(merged.tools.implementation, ["read", "write"]);
});

test("mergePlanStepdownConfig: prompt cache retention can be set to null", () => {
	const base = DEFAULT_PLAN_STEPDOWN_CONFIG;
	const merged = mergePlanStepdownConfig(base, {
		openaiPromptCache: { retention: null },
	});
	assert.equal(merged.openaiPromptCache.retention, null);
});
