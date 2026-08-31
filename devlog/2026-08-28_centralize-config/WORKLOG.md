# Worklog

## Status

In progress.

## Changes

- Moved the initial built-in configuration draft to `config/acp.jsonc`.
- Moved the initial built-in prompt drafts to `config/prompts/`.
- Added the config asset directory to the npm package allowlist.
- Recorded the compatibility and packaging requirements before integrating the latest fork `master`.

## Integration Notes

- Fork PR #1 replaced range-based compression with semantic context blocks and was merged first as commit `3a446fe8011204fe2344b9cadee2004f2bb168a4`.
- The centralization branch overlaps heavily with that refactor. The branch changes will be committed before merging `master`, then conflicts will be resolved in favor of file-backed defaults while preserving semantic-context-block behavior.
- An accidentally added, unused `@weiyentan/opencode-plugin-github` dependency must not ship.

## Verification

- Pending after integration: type check, focused tests, full test suite, changed-file formatting, diff check, build, and package verification.
