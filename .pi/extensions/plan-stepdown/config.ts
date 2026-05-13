import {
	type PromptCacheRetention,
	type ReasoningBumpConfig,
	type Rung,
} from "./rewrite.ts";

export type PlanStepdownConfig = {
	provider?: string;
	ladder?: Rung[];
	tools?: {
		plan?: string[];
		implementation?: string[];
	};
	reasoningBump?: Partial<ReasoningBumpConfig>;
	openaiPromptCache?: {
		keyPrefix?: string;
		retention?: PromptCacheRetention | null;
	};
	openaiWebSearch?: {
		enabled?: boolean;
		locationEnabled?: boolean;
	};
};

export type ResolvedPlanStepdownConfig = {
	provider: string;
	ladder: Rung[];
	tools: {
		plan: string[];
		implementation: string[];
	};
	reasoningBump: ReasoningBumpConfig;
	openaiPromptCache: {
		keyPrefix: string;
		retention: PromptCacheRetention | null;
	};
	openaiWebSearch: {
		enabled: boolean;
		locationEnabled: boolean;
	};
};

export const DEFAULT_PLAN_STEPDOWN_CONFIG: ResolvedPlanStepdownConfig = {
	provider: "openai",
	ladder: [
		{ modelId: "gpt-5.5", thinking: "xhigh", webSearchContextSize: "high" },
		{ modelId: "gpt-5.4", thinking: "xhigh", webSearchContextSize: "high" },
		{ modelId: "gpt-5.4", thinking: "high", webSearchContextSize: "medium" },
		{ modelId: "gpt-5.4", thinking: "medium", webSearchContextSize: "medium" },
		{ modelId: "gpt-5.4-mini", thinking: "xhigh", webSearchContextSize: "low" },
	],
	tools: {
		plan: ["read", "bash", "grep", "find", "ls"],
		implementation: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	},
	reasoningBump: {
		bumpOnFailedBash: true,
		bumpOnFailedTool: true,
		bumpOnPackageManagerCommand: true,
		packageManagerCommands: ["npm", "pnpm", "yarn", "bun"],
	},
	openaiPromptCache: {
		keyPrefix: "pi-model-staging:",
		retention: "24h",
	},
	openaiWebSearch: {
		enabled: true,
		locationEnabled: true,
	},
};

export type ParsePlanStepdownConfigResult = {
	config: PlanStepdownConfig;
	warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isThinkingLevel(value: unknown): value is Rung["thinking"] {
	return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isWebSearchContextSetting(value: unknown): value is NonNullable<Rung["webSearchContextSize"]> {
	return value === "low" || value === "medium" || value === "high" || value === "off";
}

function isPromptCacheRetention(value: unknown): value is PromptCacheRetention {
	return value === "24h" || value === "in_memory";
}

function isRung(value: unknown): value is Rung {
	if (!isRecord(value)) return false;
	if (typeof value.modelId !== "string" || value.modelId.trim().length === 0) return false;
	if (!isThinkingLevel(value.thinking)) return false;
	if (value.webSearchContextSize !== undefined && !isWebSearchContextSetting(value.webSearchContextSize)) {
		return false;
	}
	return true;
}

export function parsePlanStepdownConfig(input: unknown, sourceName = "config"): ParsePlanStepdownConfigResult {
	const warnings: string[] = [];
	const config: PlanStepdownConfig = {};

	if (!isRecord(input)) {
		warnings.push(`${sourceName}: expected a JSON object`);
		return { config, warnings };
	}

	if (input.provider !== undefined) {
		if (typeof input.provider === "string" && input.provider.trim().length > 0) {
			config.provider = input.provider;
		} else {
			warnings.push(`${sourceName}: provider must be a non-empty string`);
		}
	}

	if (input.ladder !== undefined) {
		if (!Array.isArray(input.ladder)) {
			warnings.push(`${sourceName}: ladder must be an array`);
		} else if (input.ladder.length === 0) {
			warnings.push(`${sourceName}: ladder must not be empty`);
		} else if (!input.ladder.every(isRung)) {
			warnings.push(`${sourceName}: ladder entries must each have modelId, thinking, and optional webSearchContextSize`);
		} else {
			config.ladder = input.ladder.map((rung) => ({ ...rung }));
		}
	}

	if (input.tools !== undefined) {
		if (!isRecord(input.tools)) {
			warnings.push(`${sourceName}: tools must be an object`);
		} else {
			const tools: NonNullable<PlanStepdownConfig["tools"]> = {};
			if (input.tools.plan !== undefined) {
				if (isStringArray(input.tools.plan)) {
					tools.plan = [...input.tools.plan];
				} else {
					warnings.push(`${sourceName}: tools.plan must be an array of strings`);
				}
			}
			if (input.tools.implementation !== undefined) {
				if (isStringArray(input.tools.implementation)) {
					tools.implementation = [...input.tools.implementation];
				} else {
					warnings.push(`${sourceName}: tools.implementation must be an array of strings`);
				}
			}
			if (Object.keys(tools).length > 0) {
				config.tools = tools;
			}
		}
	}

	if (input.reasoningBump !== undefined) {
		if (!isRecord(input.reasoningBump)) {
			warnings.push(`${sourceName}: reasoningBump must be an object`);
		} else {
			const reasoningBump: NonNullable<PlanStepdownConfig["reasoningBump"]> = {};
			if (input.reasoningBump.bumpOnFailedBash !== undefined) {
				if (typeof input.reasoningBump.bumpOnFailedBash === "boolean") {
					reasoningBump.bumpOnFailedBash = input.reasoningBump.bumpOnFailedBash;
				} else {
					warnings.push(`${sourceName}: reasoningBump.bumpOnFailedBash must be a boolean`);
				}
			}
			if (input.reasoningBump.bumpOnFailedTool !== undefined) {
				if (typeof input.reasoningBump.bumpOnFailedTool === "boolean") {
					reasoningBump.bumpOnFailedTool = input.reasoningBump.bumpOnFailedTool;
				} else {
					warnings.push(`${sourceName}: reasoningBump.bumpOnFailedTool must be a boolean`);
				}
			}
			if (input.reasoningBump.bumpOnPackageManagerCommand !== undefined) {
				if (typeof input.reasoningBump.bumpOnPackageManagerCommand === "boolean") {
					reasoningBump.bumpOnPackageManagerCommand = input.reasoningBump.bumpOnPackageManagerCommand;
				} else {
					warnings.push(`${sourceName}: reasoningBump.bumpOnPackageManagerCommand must be a boolean`);
				}
			}
			if (input.reasoningBump.packageManagerCommands !== undefined) {
				if (isStringArray(input.reasoningBump.packageManagerCommands)) {
					reasoningBump.packageManagerCommands = [...input.reasoningBump.packageManagerCommands];
				} else {
					warnings.push(`${sourceName}: reasoningBump.packageManagerCommands must be an array of strings`);
				}
			}
			if (Object.keys(reasoningBump).length > 0) {
				config.reasoningBump = reasoningBump;
			}
		}
	}

	if (input.openaiPromptCache !== undefined) {
		if (!isRecord(input.openaiPromptCache)) {
			warnings.push(`${sourceName}: openaiPromptCache must be an object`);
		} else {
			const openaiPromptCache: NonNullable<PlanStepdownConfig["openaiPromptCache"]> = {};
			if (input.openaiPromptCache.keyPrefix !== undefined) {
				if (typeof input.openaiPromptCache.keyPrefix === "string") {
					openaiPromptCache.keyPrefix = input.openaiPromptCache.keyPrefix;
				} else {
					warnings.push(`${sourceName}: openaiPromptCache.keyPrefix must be a string`);
				}
			}
			if (input.openaiPromptCache.retention !== undefined) {
				if (input.openaiPromptCache.retention === null || isPromptCacheRetention(input.openaiPromptCache.retention)) {
					openaiPromptCache.retention = input.openaiPromptCache.retention;
				} else {
					warnings.push(`${sourceName}: openaiPromptCache.retention must be "24h", "in_memory", or null`);
				}
			}
			if (Object.keys(openaiPromptCache).length > 0) {
				config.openaiPromptCache = openaiPromptCache;
			}
		}
	}

	if (input.openaiWebSearch !== undefined) {
		if (!isRecord(input.openaiWebSearch)) {
			warnings.push(`${sourceName}: openaiWebSearch must be an object`);
		} else {
			const openaiWebSearch: NonNullable<PlanStepdownConfig["openaiWebSearch"]> = {};
			if (input.openaiWebSearch.enabled !== undefined) {
				if (typeof input.openaiWebSearch.enabled === "boolean") {
					openaiWebSearch.enabled = input.openaiWebSearch.enabled;
				} else {
					warnings.push(`${sourceName}: openaiWebSearch.enabled must be a boolean`);
				}
			}
			if (input.openaiWebSearch.locationEnabled !== undefined) {
				if (typeof input.openaiWebSearch.locationEnabled === "boolean") {
					openaiWebSearch.locationEnabled = input.openaiWebSearch.locationEnabled;
				} else {
					warnings.push(`${sourceName}: openaiWebSearch.locationEnabled must be a boolean`);
				}
			}
			if (Object.keys(openaiWebSearch).length > 0) {
				config.openaiWebSearch = openaiWebSearch;
			}
		}
	}

	return { config, warnings };
}

export function mergePlanStepdownConfig(
	base: ResolvedPlanStepdownConfig,
	overrides: PlanStepdownConfig,
): ResolvedPlanStepdownConfig {
	return {
		provider: overrides.provider ?? base.provider,
		ladder: overrides.ladder ? overrides.ladder.map((rung) => ({ ...rung })) : base.ladder.map((rung) => ({ ...rung })),
		tools: {
			plan: overrides.tools?.plan ? [...overrides.tools.plan] : [...base.tools.plan],
			implementation: overrides.tools?.implementation
				? [...overrides.tools.implementation]
				: [...base.tools.implementation],
		},
		reasoningBump: {
			...base.reasoningBump,
			...overrides.reasoningBump,
			packageManagerCommands: overrides.reasoningBump?.packageManagerCommands
				? [...overrides.reasoningBump.packageManagerCommands]
				: [...base.reasoningBump.packageManagerCommands],
		},
		openaiPromptCache: {
			keyPrefix: overrides.openaiPromptCache?.keyPrefix ?? base.openaiPromptCache.keyPrefix,
			retention:
				overrides.openaiPromptCache && "retention" in overrides.openaiPromptCache
					? overrides.openaiPromptCache.retention ?? null
					: base.openaiPromptCache.retention,
		},
		openaiWebSearch: {
			enabled: overrides.openaiWebSearch?.enabled ?? base.openaiWebSearch.enabled,
			locationEnabled: overrides.openaiWebSearch?.locationEnabled ?? base.openaiWebSearch.locationEnabled,
		},
	};
}
