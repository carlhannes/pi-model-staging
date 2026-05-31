import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PLAN_STEPDOWN_ASK_USER_TOOL_NAME = "plan_stepdown_ask_user";

const MAX_PLANNING_QUESTIONS = 4;
const MIN_PLANNING_QUESTIONS = 1;
const MIN_PLANNING_OPTIONS = 2;
const MAX_PLANNING_OPTIONS = 4;
const CUSTOM_ANSWER_LABEL = "Type your own answer";
const SUBMIT_ANSWERS_LABEL = "Submit selected answers";
const DEFAULT_CUSTOM_PLACEHOLDER = "Type your own answer";
const PLANNING_QUESTION_PROMPT_INTRO =
	`Interactive UI is available, so you may use the \`${PLAN_STEPDOWN_ASK_USER_TOOL_NAME}\` tool for high-level judgement questions that materially affect the plan.`;

export const PLANNING_QUESTION_GUIDELINES = [
	`Use ${PLAN_STEPDOWN_ASK_USER_TOOL_NAME} only for high-level judgement questions that materially change the plan.`,
	`Do not use ${PLAN_STEPDOWN_ASK_USER_TOOL_NAME} for nitpicky implementation details.`,
	`Keep each call small: ${MIN_PLANNING_QUESTIONS}-${MAX_PLANNING_QUESTIONS} questions, with ${MIN_PLANNING_OPTIONS}-${MAX_PLANNING_OPTIONS} options each.`,
	"Prefer single-choice questions when the user should pick one path, and checkbox-style questions when the answers are independent.",
	"Use a custom answer only when none of the listed options fit.",
	"If a question does not materially change the plan, make a conservative assumption instead of asking.",
] as const;

export function formatPlanningQuestionPrompt(): string {
	return [
		"[PLAN MODE: INTERACTIVE CLARIFICATION]",
		"",
		PLANNING_QUESTION_PROMPT_INTRO,
		"",
		"Rules:",
		...PLANNING_QUESTION_GUIDELINES.map((guideline) => `- ${guideline}`),
	].join("\n");
}

export type PlanningQuestionSpec = {
	prompt: string;
	options: string[];
	multiple?: boolean;
	allowCustom?: boolean;
	customPlaceholder?: string;
};

export type PlanningQuestionRequest = {
	title?: string;
	intro?: string;
	questions: PlanningQuestionSpec[];
};

export type PlanningQuestionAnswer = {
	prompt: string;
	multiple: boolean;
	selected: string[];
	customAnswers: string[];
};

export const PLANNING_QUESTION_TOOL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {
		title: { type: "string" },
		intro: { type: "string" },
		questions: {
			type: "array",
			minItems: MIN_PLANNING_QUESTIONS,
			maxItems: MAX_PLANNING_QUESTIONS,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					prompt: { type: "string" },
					options: {
						type: "array",
						minItems: MIN_PLANNING_OPTIONS,
						maxItems: MAX_PLANNING_OPTIONS,
						items: { type: "string" },
					},
					multiple: { type: "boolean" },
					allowCustom: { type: "boolean" },
					customPlaceholder: { type: "string" },
				},
				required: ["prompt", "options"],
			},
		},
	},
	required: ["questions"],
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeOptionValues(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const options: string[] = [];
	for (const item of value) {
		const option = normalizeText(item);
		if (!option) return null;
		options.push(option);
	}
	return options.length >= MIN_PLANNING_OPTIONS && options.length <= MAX_PLANNING_OPTIONS ? options : null;
}

function normalizeQuestion(value: unknown): PlanningQuestionSpec | null {
	if (!isRecord(value)) return null;
	const prompt = normalizeText(value.prompt);
	const options = normalizeOptionValues(value.options);
	if (!prompt || !options) return null;

	if (value.multiple !== undefined && typeof value.multiple !== "boolean") return null;
	if (value.allowCustom !== undefined && typeof value.allowCustom !== "boolean") return null;

	const customPlaceholder = normalizeText(value.customPlaceholder);
	return {
		prompt,
		options,
		...(value.multiple !== undefined ? { multiple: value.multiple } : {}),
		...(value.allowCustom !== undefined ? { allowCustom: value.allowCustom } : { allowCustom: true }),
		...(customPlaceholder ? { customPlaceholder } : {}),
	};
}

export function normalizePlanningQuestionRequest(input: unknown): PlanningQuestionRequest | null {
	if (!isRecord(input)) return null;

	const title = normalizeText(input.title);
	const intro = normalizeText(input.intro);
	if (!Array.isArray(input.questions)) return null;
	if (input.questions.length < MIN_PLANNING_QUESTIONS || input.questions.length > MAX_PLANNING_QUESTIONS) return null;

	const questions: PlanningQuestionSpec[] = [];
	for (const item of input.questions) {
		const question = normalizeQuestion(item);
		if (!question) return null;
		questions.push(question);
	}

	return {
		...(title ? { title } : {}),
		...(intro ? { intro } : {}),
		questions,
	};
}

function uniqueStrings(values: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = normalizeText(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function parseNumberedChoice(choice: string): number | null {
	const match = /(\d+)\./.exec(choice);
	if (!match) return null;
	const index = Number(match[1]);
	return Number.isInteger(index) && index > 0 ? index - 1 : null;
}

function pushUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

function buildQuestionTitle(request: PlanningQuestionRequest, index: number): string {
	const prefix = request.questions.length > 1 ? `${index + 1}/${request.questions.length}: ` : "";
	return `${prefix}${request.questions[index].prompt}`;
}

function formatAnswerLine(answer: PlanningQuestionAnswer): string[] {
	if (answer.multiple) {
		const lines = [`   Selected: ${answer.selected.length > 0 ? answer.selected.join(", ") : "none"}`];
		if (answer.customAnswers.length > 0) {
			lines.push(`   Custom: ${answer.customAnswers.join("; ")}`);
		}
		return lines;
	}

	const singleAnswer = answer.selected[0] ?? answer.customAnswers[0] ?? "none";
	return [`   Answer: ${singleAnswer}`];
}

export function formatPlanningQuestionSummary(request: PlanningQuestionRequest, answers: readonly PlanningQuestionAnswer[]): string {
	const lines: string[] = [];
	lines.push(request.title ?? "Planning question answers");
	if (request.intro) {
		lines.push(request.intro);
	}
	lines.push("");

	for (let index = 0; index < request.questions.length; index++) {
		const question = request.questions[index];
		const answer = answers[index] ?? { prompt: question.prompt, multiple: !!question.multiple, selected: [], customAnswers: [] };
		lines.push(`${index + 1}. ${question.prompt}${question.multiple ? " [multi]" : ""}`);
		lines.push(...formatAnswerLine(answer));
	}

	return lines.join("\n");
}

export function buildPlanningToolNames(baseTools: readonly string[], hasUI: boolean): string[] {
	const filtered = uniqueStrings(baseTools.filter((name) => name !== PLAN_STEPDOWN_ASK_USER_TOOL_NAME));
	return hasUI ? uniqueStrings([PLAN_STEPDOWN_ASK_USER_TOOL_NAME, ...filtered]) : filtered;
}

async function askSingleQuestion(
	title: string,
	question: PlanningQuestionSpec,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<PlanningQuestionAnswer | null> {
	const options = question.options.map((option, index) => `${index + 1}. ${option}`);
	if (question.allowCustom !== false) options.push(CUSTOM_ANSWER_LABEL);

	for (;;) {
		const choice = await ctx.ui.select(title, options, { signal });
		if (choice === undefined) return null;
		if (choice === CUSTOM_ANSWER_LABEL) {
			const custom = normalizeText(
				await ctx.ui.input(title, question.customPlaceholder ?? DEFAULT_CUSTOM_PLACEHOLDER, { signal }),
			);
			if (!custom) continue;
			return { prompt: question.prompt, multiple: false, selected: [], customAnswers: [custom] };
		}

		const index = parseNumberedChoice(choice);
		if (index === null || index < 0 || index >= question.options.length) continue;
		return { prompt: question.prompt, multiple: false, selected: [question.options[index]], customAnswers: [] };
	}
}

async function askMultiQuestion(
	title: string,
	question: PlanningQuestionSpec,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<PlanningQuestionAnswer | null> {
	const selected = new Set<number>();
	const customAnswers: string[] = [];

	for (;;) {
		const options = question.options.map((option, index) => {
			const marker = selected.has(index) ? "[x]" : "[ ]";
			return `${marker} ${index + 1}. ${option}`;
		});
		if (question.allowCustom !== false) options.push(CUSTOM_ANSWER_LABEL);
		options.push(SUBMIT_ANSWERS_LABEL);

		const choice = await ctx.ui.select(title, options, { signal });
		if (choice === undefined) return null;
		if (choice === SUBMIT_ANSWERS_LABEL) {
			return {
				prompt: question.prompt,
				multiple: true,
				selected: question.options.filter((_, index) => selected.has(index)),
				customAnswers,
			};
		}
		if (choice === CUSTOM_ANSWER_LABEL) {
			const custom = normalizeText(
				await ctx.ui.input(title, question.customPlaceholder ?? DEFAULT_CUSTOM_PLACEHOLDER, { signal }),
			);
			if (custom) pushUnique(customAnswers, custom);
			continue;
		}

		const index = parseNumberedChoice(choice);
		if (index === null || index < 0 || index >= question.options.length) continue;
		if (selected.has(index)) selected.delete(index);
		else selected.add(index);
	}
}

function buildCancelledResult(message: string): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
	return {
		content: [{ type: "text", text: message }],
		details: { cancelled: true },
	};
}

export function registerPlanningQuestionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: PLAN_STEPDOWN_ASK_USER_TOOL_NAME,
		label: "Ask planning questions",
		description: "Ask high-level judgement questions during plan mode and collect structured answers before the final plan.",
		promptSnippet: "Ask high-level plan questions with options before the final plan.",
		promptGuidelines: [...PLANNING_QUESTION_GUIDELINES],
		parameters: PLANNING_QUESTION_TOOL_PARAMETERS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const request = normalizePlanningQuestionRequest(params);
			if (!request) {
				return buildCancelledResult("Invalid planning question payload.");
			}

			if (!ctx.hasUI) {
				return buildCancelledResult("UI not available.");
			}

			const answers: PlanningQuestionAnswer[] = [];
			for (const [index, question] of request.questions.entries()) {
				const title = buildQuestionTitle(request, index);
				const answer = question.multiple
					? await askMultiQuestion(title, question, ctx, signal)
					: await askSingleQuestion(title, question, ctx, signal);
				if (!answer) {
					return buildCancelledResult("The user cancelled the planning questions.");
				}
				answers.push(answer);
			}

			const summary = formatPlanningQuestionSummary(request, answers);
			const confirmed = await ctx.ui.confirm(request.title ?? "Review planning answers", summary, { signal });
			if (!confirmed) {
				return buildCancelledResult("The user cancelled before submitting the planning answers.");
			}

			return {
				content: [{ type: "text", text: summary }],
				details: {
					request,
					answers,
					summary,
				},
			};
		},
	});
}
