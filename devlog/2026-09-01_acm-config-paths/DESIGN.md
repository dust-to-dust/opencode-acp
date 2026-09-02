# DESIGN - ACM Configuration Paths

- Task ID: `2026-09-01_acm-config-paths`
- Home Repo: `opencode-acp`
- Created: 2026-09-01
- Status: Implemented

## 1. Problem Statement

ACP currently has separate global, `OPENCODE_CONFIG_DIR`, and project lookup layers for configuration and prompts. The requested runtime contract is a single user configuration root with an optional project-root override.

## 2. Goals & Non-Goals

- **Goals**:
  - Use `~/.config/opencode/acm` as the sole global ACP user-data root.
  - Keep only global and project `.opencode` override layers.
  - Ensure local deployments contain the package assets used by the runtime.
- **Non-Goals**:
  - Moving the bundled package assets out of `config/`.
  - Automatically migrating old configuration files.
  - Changing OpenCode's plugin cache resolution.

## 3. Current Architecture

- **How it works today**: `lib/config.ts` loads bundled defaults, then global, `OPENCODE_CONFIG_DIR`, and nearest project `.opencode` config. `lib/prompts/store.ts` loads bundled prompts and resolves project, config-directory, and global prompt overrides. `scripts/dev-deploy.sh` copies only `dist/` and `package.json`.
- **Pain points**: User-editable paths are split across multiple roots, and a dev deployment does not copy required file-backed assets.

## 4. Proposed Architecture

- **Overview**:

  ```text
  package config/acp.jsonc + config/prompts/*.md
                    |
                    v
  ~/.config/opencode/acm/acp.jsonc + prompts/*.md
                     |
                     v
  <project>/.opencode/acp.jsonc + prompts/*.md
  ```

- **Key components**:
  - `lib/config.ts`: bundled defaults plus global ACM config plus project config.
  - `lib/prompts/store.ts`: bundled prompts plus global ACM prompt files plus project prompt files.
  - `scripts/dev-deploy.sh`: copies `config/` with the compiled package into each local cache target.
- **Data flow**: Bundled defaults are loaded first; global ACM values are merged second; project `.opencode` values are merged last. Prompt override selection uses project first, then global ACM.
- **API / interface changes**: `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` no longer affect ACP lookup.

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Global root | Keep existing paths; use `OPENCODE_CONFIG_DIR`; use one ACM root | `~/.config/opencode/acm` | Gives users one predictable location and matches the requested contract. |
| Project lookup | Search all ancestors for arbitrary overrides; use `.opencode` project root marker | `.opencode` project root marker only | Preserves OpenCode project scoping while removing unrelated config-directory layers. |
| Prompt asset deployment | Copy only compiled output; copy the package `config/` directory | Copy `config/` | Runtime prompt/config readers resolve file-backed assets relative to the deployed package. |

## 6. Impact Analysis

- **Backward compatibility**: Old global and config-directory files are no longer read automatically; users must move them to the ACM root. Project `.opencode` files retain their role.
- **Performance**: No material change; fewer filesystem locations are inspected.
- **Security**: Reduces accidental loading from an unrelated environment-specific config directory.
- **Dependencies** (new packages required): None.

## 7. Migration Plan

- **Steps**:
  1. Move `~/.config/opencode/acp.jsonc` to `~/.config/opencode/acm/acp.jsonc`.
  2. Move `~/.config/opencode/acp-prompts/` to `~/.config/opencode/acm/prompts/`.
  3. Restart OpenCode after deployment.
- **Feature flags / gradual rollout**: None.

## 8. Open Questions

- [x] Deployment destination is interpreted as `~/.config/opencode/acm`, consistent with the user's first requirement and follow-up confirmation.
