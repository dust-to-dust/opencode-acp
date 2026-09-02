# REQ - Self-contained local development deployment

- Task ID: `2026-09-02_dev-deploy-dependencies`
- Home Repo: `opencode-acp`
- Created: 2026-09-02
- Status: Done
- Priority: P1
- Owner: OpenCode
- References: Local deployment failure diagnosed on 2026-09-02

## 1. Background & Problem Statement

- **Context**: `scripts/dev-deploy.sh` copies a locally built package into OpenCode's `@latest` cache and raises its deployed version to prevent registry replacement.
- **Current behavior**: When the cache has no dependency tree, the script leaves runtime and peer dependencies missing while the raised version prevents OpenCode from repairing the cache.
- **Expected behavior**: A local deployment owns dependency installation and leaves a self-contained, importable plugin cache.
- **Impact**: ACP silently fails to initialize, so compression tools, message IDs, and nudges are absent.

## 2. Constraints & Non-Goals

- Preserve the source package version.
- Use deployed version `9.9.9` so local builds are immediately recognizable and remain newer than registry releases.
- Install runtime dependencies and the `@opencode-ai/plugin` peer dependency without running dependency lifecycle scripts.
- Do not overwrite existing user ACM configuration or prompts.

## 3. Acceptance Criteria

- [x] A fresh deployment target receives all runtime dependencies.
- [x] `@opencode-ai/plugin` is installed even though it is also a development dependency in the source package.
- [x] The deployed package reports version `9.9.9`; the source package version is unchanged.
- [x] Importing the deployed `dist/index.js` succeeds.
- [x] A real OpenCode request initializes ACP and emits ACP diagnostics.

## 4. Proposed Approach

- Add one dependency-install helper to `scripts/dev-deploy.sh` and invoke it for primary and legacy cache targets after copying and version patching.
- Replace registry-relative version calculation with the fixed local-development marker `9.9.9`.
