# Changelog

## v0.3.2 - 2026-05-13

### Changed
- README install docs now lead with the published npm package (`pi install npm:pi-model-staging`) instead of GitHub tag installs.
- Added package management guidance for `pi list`, `pi update`, `pi remove`, and `pi config`.
- Added migration guidance for users switching from older git/local installs to the npm package to avoid duplicate commands.
- Kept GitHub tag installs and local clone/symlink workflows documented as alternatives for source-based usage and development.

## v0.3.1 - 2026-05-13

### Changed
- `/stepdown` now shows the resolved provider/config ladder and current cursor even when idle.
- `/stepdown` now reports the currently loaded session config, including tool lists, prompt-cache settings, web-search settings, and missing provider-registry models.
- README command/docs updated to describe the always-available `/stepdown` behavior and the `/reload`/restart requirement after config edits.

## v0.3.0 - 2026-05-13

### Added
- Opt-in headless auto-approval: `--plan-auto-approve` starts in plan mode and automatically transitions to implementation after planning.
- Per-user and per-project stepdown configuration via JSON:
  - `~/.pi/agent/plan-stepdown.json` (global)
  - `.pi/plan-stepdown.json` (project override)
  - `--stepdown-config <path>` (one-off override)
- Config parsing/merge tests.

### Changed
- Default provider is now `openai` with a built-in ladder: `gpt-5.5` → `gpt-5.4` (xhigh/high/medium) → `gpt-5.4-mini`.
- Documentation updated to prefer JSON configuration over editing the extension source.

## v0.2.0 - 2026-05-04

### Added
- One-shot reasoning bumps in implementation mode after failed tools, failed bash commands, or package-manager commands (`npm`, `pnpm`, `yarn`, `bun`).
- OpenAI Responses native `web_search` injection with per-rung `search_context_size`, opt-outs, and approximate country/timezone location bias.
- OpenAI prompt-cache hints: stable `prompt_cache_key` derived from local username + cwd and optional `prompt_cache_retention: "24h"`.
- More complete unit coverage, including prompt cache, web search, reasoning bumps, and end-to-end lifecycle simulations.

### Changed
- Renamed the user-facing phase language from “execute” to “implement”.
- Expanded the default ladder to six rungs and documented the defaults used by the extension.
- Improved plan/implementation prompts and README install guidance with pinned git refs.

### Notes
- All rungs still must live on the same provider; model changes are applied via provider payload rewriting.
- If you customized the previous `EXEC_*` constants, migrate those local edits to `IMPL_TOOLS` and `IMPL_FIRST_PROMPT`.

## v0.1.0 - 2026-05-04

- Initial release of `pi-model-staging` with `/plan`, `/stepdown`, `/stepdown-off`, single-provider model ladder stepping, and payload-level model/reasoning rewriting.
