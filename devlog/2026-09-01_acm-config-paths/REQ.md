# ACM Configuration Paths

- Task ID: `2026-09-01_acm-config-paths`
- Home Repo: `opencode-acp`
- Created: 2026-09-01
- Status: Completed
- Priority: P1

## 1. Background & Problem Statement

- **Context**: Runtime ACP configuration and customizable prompts currently use separate global and config-directory locations.
- **Current behavior (symptom)**: The plugin reads global files from `~/.config/opencode`, optionally reads `$OPENCODE_CONFIG_DIR`, and the development deploy script omits the packaged `config/` assets.
- **Expected behavior at completion**: User configuration is rooted at `~/.config/opencode/acm`; the then-supported project prompt layer was superseded on 2026-09-03 by the single global prompt source requirement.
- **Impact**: Configuration is difficult to locate and local deployments can fail to load bundled prompts/configuration.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: ESM TypeScript runtime
  - OS/Arch: Windows development environment with Git Bash deployment support
- **Minimal reproduction steps**:
  1. Set `OPENCODE_CONFIG_DIR` and observe that ACP reads an additional configuration/prompt layer.
  2. Run `./scripts/dev-deploy.sh` and inspect the deployed package for `config/` and the user ACM directory for `prompts/`.
- **Relevant configuration**: Existing paths include `~/.config/opencode/acp.jsonc` and `~/.config/opencode/acp-prompts/`.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Do not add runtime dependencies.
  - This historical package prompt boundary was superseded; prompt files are now excluded from the cache package.
  - Preserve project override precedence over the global configuration.
  - Preserve ACP/DCP compatibility identifiers and existing prompt interpolation behavior.
  - Do not modify `package.json` version.
- **Non-Goals** (explicitly out of scope): Migrating or deleting existing user files automatically; changing the OpenCode plugin cache location.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
   - [x] Global config resolves only from `~/.config/opencode/acm/acp.jsonc` or `acp.json`.
   - [x] Global prompt files resolve only below `~/.config/opencode/acm/prompts/`.
   - [x] `$OPENCODE_CONFIG_DIR` is not read for ACP config or prompt overrides.
   - [x] Historical project prompt precedence was implemented and later removed.
   - [x] Development deployment behavior was later changed to copy only `config/acp.jsonc` into plugin cache targets.
- **Performance / Stability**:
   - [x] Historical optional prompt fallback behavior was later removed.
- **Regression**:
   - [x] New/modified tests cover the path and precedence changes and pass.

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/config.ts`
  - `lib/prompts/store.ts`
  - `scripts/dev-deploy.sh`
  - `tests/config-providers.test.ts`
  - `tests/prompts.test.ts`
  - `CONFIGURATION.md`
  - `CONFIGURATION.zh-CN.md`
  - `README.md`
  - `README.zh-CN.md`
- **Risks**: Existing users with files at the old locations will need to move them manually.
- **Rollback strategy**: Revert the path and deployment changes; no persisted data format changes are introduced.
