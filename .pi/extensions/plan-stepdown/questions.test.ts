import test from "node:test";
import assert from "node:assert/strict";
import {
	PLAN_STEPDOWN_ASK_USER_TOOL_NAME,
	buildPlanningToolNames,
	formatPlanningQuestionPrompt,
	formatPlanningQuestionSummary,
	normalizePlanningQuestionRequest,
	PLANNING_QUESTION_GUIDELINES,
	registerPlanningQuestionTool,
} from "./questions.ts";

test("normalizePlanningQuestionRequest: trims prompts, options, and optional fields", () => {
	const request = normalizePlanningQuestionRequest({
		title: "  Planning questions  ",
		intro: "  Please answer these first.  ",
		questions: [
			{
				prompt: "  Which storage layer should we use?  ",
				options: ["  sqlite  ", "  postgres  "],
			},
			{
				prompt: "  Which features do we want?  ",
				options: [" auth ", " logging "],
				multiple: true,
				allowCustom: false,
				customPlaceholder: "  Anything else?  ",
			},
		],
	});

	assert.deepEqual(request, {
		title: "Planning questions",
		intro: "Please answer these first.",
		questions: [
			{
				prompt: "Which storage layer should we use?",
				options: ["sqlite", "postgres"],
				allowCustom: true,
			},
			{
				prompt: "Which features do we want?",
				options: ["auth", "logging"],
				multiple: true,
				allowCustom: false,
				customPlaceholder: "Anything else?",
			},
		],
	});
});

test("normalizePlanningQuestionRequest: rejects invalid planning questions", () => {
	assert.equal(
		normalizePlanningQuestionRequest({ questions: [{ prompt: "Choose one", options: ["only one"] }] }),
		null,
	);
	assert.equal(
		normalizePlanningQuestionRequest({ questions: [{ prompt: "", options: ["a", "b"] }] }),
		null,
	);
});

test("formatPlanningQuestionSummary: formats single and multi answers including custom input", () => {
	const summary = formatPlanningQuestionSummary(
		{
			title: "Planning questions",
			intro: "Please answer these first.",
			questions: [
				{ prompt: "Which storage layer should we use?", options: ["sqlite", "postgres"] },
				{ prompt: "Which features do we want?", options: ["auth", "logging"], multiple: true },
			],
		},
		[
			{ prompt: "Which storage layer should we use?", multiple: false, selected: ["sqlite"], customAnswers: [] },
			{
				prompt: "Which features do we want?",
				multiple: true,
				selected: ["auth", "logging"],
				customAnswers: ["custom sync"],
			},
		],
	);

	assert.equal(
		summary,
		[
			"Planning questions",
			"Please answer these first.",
			"",
			"1. Which storage layer should we use?",
			"   Answer: sqlite",
			"2. Which features do we want? [multi]",
			"   Selected: auth, logging",
			"   Custom: custom sync",
		].join("\n"),
	);
});

test("buildPlanningToolNames: keeps the question tool out of headless sessions", () => {
	const baseTools = ["read", PLAN_STEPDOWN_ASK_USER_TOOL_NAME, "grep", "read"];

	assert.deepEqual(buildPlanningToolNames(baseTools, false), ["read", "grep"]);
	assert.deepEqual(buildPlanningToolNames(baseTools, true), [PLAN_STEPDOWN_ASK_USER_TOOL_NAME, "read", "grep"]);
});

test("formatPlanningQuestionPrompt: reuses the shared planning-question guidelines", () => {
	const prompt = formatPlanningQuestionPrompt();
	assert.match(prompt, /^\[PLAN MODE: INTERACTIVE CLARIFICATION\]/);
	for (const guideline of PLANNING_QUESTION_GUIDELINES) {
		assert.match(prompt, new RegExp(guideline.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

function captureRegisteredTool() {
	let tool: any;
	registerPlanningQuestionTool({
		registerTool(definition: unknown) {
			tool = definition;
		},
	} as any);
	assert.ok(tool);
	return tool;
}

test("registerPlanningQuestionTool: reuses the shared prompt guidelines", () => {
	const tool = captureRegisteredTool();
	assert.deepEqual(tool.promptGuidelines, [...PLANNING_QUESTION_GUIDELINES]);
});

test("registerPlanningQuestionTool: single-choice flow returns the expected summary", async () => {
	const tool = captureRegisteredTool();
	const result = await tool.execute(
		"call-1",
		{
			title: "Planning questions",
			intro: "Please answer these first.",
			questions: [{ prompt: "Which storage layer should we use?", options: ["sqlite", "postgres"] }],
		},
		undefined,
		undefined,
		{
			hasUI: true,
			ui: {
				select: async () => "1. sqlite",
				input: async () => undefined,
				confirm: async () => true,
			},
		} as any,
	);

	assert.equal(result.content[0]?.text, [
		"Planning questions",
		"Please answer these first.",
		"",
		"1. Which storage layer should we use?",
		"   Answer: sqlite",
	].join("\n"));
});

test("registerPlanningQuestionTool: multi-choice flow supports toggles and custom answers", async () => {
	const tool = captureRegisteredTool();
	const selections = ["[ ] 1. auth", "[ ] 2. logging", "Type your own answer", "Submit selected answers"];
	const result = await tool.execute(
		"call-2",
		{
			title: "Planning questions",
			questions: [{ prompt: "Which features do we want?", options: ["auth", "logging"], multiple: true }],
		},
		undefined,
		undefined,
		{
			hasUI: true,
			ui: {
				select: async () => selections.shift(),
				input: async () => "custom sync",
				confirm: async () => true,
			},
		} as any,
	);

	assert.equal(result.content[0]?.text, [
		"Planning questions",
		"",
		"1. Which features do we want? [multi]",
		"   Selected: auth, logging",
		"   Custom: custom sync",
	].join("\n"));
});

test("registerPlanningQuestionTool: no-UI execution returns a minimal result without structured-input guidance", async () => {
	const tool = captureRegisteredTool();
	const result = await tool.execute(
		"call-3",
		{
			questions: [{ prompt: "Which storage layer should we use?", options: ["sqlite", "postgres"] }],
		},
		undefined,
		undefined,
		{ hasUI: false, ui: {} } as any,
	);

	assert.equal(result.content[0]?.text, "UI not available.");
	assert.equal(result.details?.cancelled, true);
	assert.doesNotMatch(result.content[0]?.text ?? "", /structured|option/i);
});
