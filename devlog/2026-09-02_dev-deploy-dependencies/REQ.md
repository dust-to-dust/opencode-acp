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

## 5. Prompt Injection Cleanup

### Problem

The centralized prompt store still exposes obsolete turn, iteration, and quality-rejection prompts. The semantic compression scheduler does not use the old anchored nudge path, while the retained system and context-limit prompts need tests at their final model-facing injection boundaries.

### Acceptance Criteria

- Remove `turn-nudge.md`, `iteration-nudge.md`, and `how-to-compress.md` plus their unused runtime fields, preview entries, helper chain, tests, and package assertions.
- Inject `system.md` only through the system prompt transform.
- Inject `context-limit-nudge.md` into the latest real user message only when the max-context or emergency threshold is reached and a compression request is emitted.
- Keep the semantic candidate set and cache boundary in the same user-message injection.
- Verify final transformed system and message payloads, not only prompt loading.
- Compare the injection boundaries with upstream `ranxianglei/opencode-acp` before completion.

## 6. Single Global Prompt Source

### Problem

ACP currently mixes bundled cache assets, an opt-in global override, project overrides, and a separate fixed-prompt path. A file exposed under `~/.config/opencode/acm/prompts/` can therefore be ignored even after OpenCode restarts.

### Acceptance Criteria

- Remove `experimental.customPrompts`, `FIXED_PROMPT_FILES`, project prompt discovery, and their configuration/runtime chains.
- Load every runtime prompt exclusively from `~/.config/opencode/acm/prompts/`.
- Keep prompt assets out of OpenCode's cached plugin package.
- Make `scripts/dev-deploy.sh` install every runtime prompt into the global ACM prompt directory without overwriting existing user edits.
- Remove obsolete prompt files from the deployment source and deployed global directory.
- Update schema, documentation, package verification, and tests to enforce the single-source behavior.

## 7. Immediate System Nudge Injection

### Problem

Compression nudges are currently appended to the latest user message. This gives dynamic ACP guidance the wrong role and can defer visibility until another user message is processed.

### Acceptance Criteria

- Compute compression eligibility during the message transform without modifying user message content.
- Inject the resulting compression request through the system transform in the same model request.
- Preserve pending candidate freezing, cache-boundary selection, context-limit guidance, and nudge state transitions.
- Verify the final system payload and confirm that the user payload remains unchanged.
