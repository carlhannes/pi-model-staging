# Changelog

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
