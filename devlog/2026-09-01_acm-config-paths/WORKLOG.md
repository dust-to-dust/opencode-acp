# Worklog: Centralize ACM Config and Prompt Paths

## 1. Changes

- Moved the global ACP config lookup to `~/.config/opencode/acm/acp.jsonc` or `acp.json`.
- Removed the `XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR` ACP config layers.
- Kept nearest project `.opencode/acp.jsonc` or `acp.json` as the only project override.
- Moved global editable prompt files to `~/.config/opencode/acm/prompts/`.
- Kept nearest project `.opencode/prompts/` as the only prompt override layer.
- Updated local deployment to copy package `config/` assets alongside `dist/`.
- Updated local deployment to initialize `~/.config/opencode/acm/` with a
  non-destructive config starter and prompt files.
- Updated English and Chinese configuration, README, and architecture documentation.
- Added tests proving ignored environment-based config layers do not override ACM paths.

## 2. Verification

### Completed

- `node --import tsx --test tests/config-providers.test.ts tests/prompts.test.ts`: 24 passed after including the bundled `gc.batchCleanup.highThreshold` default of `75%` in the expected merged config.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `bash -n scripts/dev-deploy.sh`: passed.
- `npm test`: 813 tests passed, 0 failed, 17 suites.
- `npm run verify:package`: passed with 170 tarball entries.
- `git diff --check`: passed.
- `prettier --check` passed for the files changed by this task.
- `bash -n scripts/dev-deploy.sh`: passed after ACM directory initialization and Windows path handling were added.
- Git Bash deployment `./scripts/dev-deploy.sh --no-build`: passed; deployed `v1.14.27`, copied package assets, and initialized five files under `~/.config/opencode/acm/prompts/`.

### Pending

- `npm run format:check` remains blocked by the repository baseline: approximately 655 existing files are already unformatted. Full formatting was intentionally not run because the worktree contains unrelated user changes.

## 3. Compatibility and Migration

- Existing files under `~/.config/opencode/acp.jsonc`, `~/.config/opencode/acp-prompts/`, `$XDG_CONFIG_HOME`, and `$OPENCODE_CONFIG_DIR` are no longer read by ACP.
- No automatic migration is performed. Users must copy desired settings into `~/.config/opencode/acm/` and prompt files into `~/.config/opencode/acm/prompts/`.
- Package defaults remain in `config/acp.jsonc` and `config/prompts/`; they are copied into the development plugin cache by `scripts/dev-deploy.sh`.
