# Worklog

## Status

Complete.

## Changes

- Moved the initial built-in configuration draft to `config/acp.jsonc`.
- Moved the initial built-in prompt drafts to `config/prompts/`.
- Added the config asset directory to the npm package allowlist.
- Recorded the compatibility and packaging requirements before integrating the latest fork `master`.
- Loaded fixed compression-request text from a bundled prompt while keeping candidate and cache-boundary interpolation in TypeScript.
- Preserved semantic activity/checkpoint compression, provider/model overrides, protected-content filtering, and configuration-directory layering from fork `master`.
- Removed obsolete prompt assets and range-era runtime paths that are no longer consumed by the semantic implementation.
- Made package cleaning and package verification portable to Windows without adding dependencies.

## Integration Notes

- Fork PR #1 replaced range-based compression with semantic context blocks and was merged first as commit `3a446fe8011204fe2344b9cadee2004f2bb168a4`.
- The centralization branch overlapped heavily with that refactor. Conflicts were resolved in favor of file-backed defaults while preserving semantic-context-block behavior.
- The accidentally added, unused `@weiyentan/opencode-plugin-github` dependency was removed before integration.

## Verification

- Type checking passed with `npm run typecheck`.
- Focused centralization and semantic integration tests passed.
- The full tracked test suite passed: 810 tests, 17 suites, 0 failures.
- Changed-file Prettier checks and `git diff --check` passed; Git reported only local LF/CRLF conversion warnings.
- `tsup` and declaration generation completed successfully.
- Prompt preview listing and rendering completed successfully.
- Package verification passed for `opencode-acp@1.14.26`; the dry-run tarball contained 170 entries including the bundled config and prompt assets.
