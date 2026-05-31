import test from "node:test";
import assert from "node:assert/strict";
import {
	PLAN_STEPDOWN_ASK_USER_TOOL_NAME,
	buildPlanningToolNames,
	formatPlanningQuestionSummary,
	normalizePlanningQuestionRequest,
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
