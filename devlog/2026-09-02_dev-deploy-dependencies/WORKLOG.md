# WORKLOG - Self-contained local development deployment

- Task ID: `2026-09-02_dev-deploy-dependencies`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-02

## 1. Summary

- **What was done**: The local deploy helper now fixes the deployed version at `9.9.9`, strips source-only development metadata, clears stale dependency state, and installs production plus peer dependencies inside the deployed package directory.
- **Why**: Local deployment must not rely on an existing OpenCode npm cache after preventing registry replacement.
- **Behavior / compatibility changes**: Local deployment behavior only.
- **Risk level**: Low

## 2. Change Log

### Key Files

- `scripts/dev-deploy.sh` - owns deployed dependency installation and applies the `9.9.9` local marker.
- `docs/development.md` - documents dependency rebuilding and deployed metadata behavior.

## 3. Testing & Verification

- `bash -n scripts/dev-deploy.sh` passed.
- `./scripts/dev-deploy.sh --no-build` completed and installed 33 packages into a clean target dependency directory.
- Deployed metadata reports `version=9.9.9`, has no `devDependencies`, and retains peer `@opencode-ai/plugin >=1.4.3`.
- `npm ls --omit=dev --depth=0` reports only the five expected direct runtime/peer packages.
- Direct ESM import printed `ACP_IMPORT_OK`.
- `opencode run -m openai/gpt-5.6-sol "Reply with OK only."` returned `OK`; ACP diagnostics recorded initialization, model-limit seeding, message transformation, and `current=9.9.9` during the update check.
- `git diff --check` passed.

## 4. Prompt Injection Cleanup

- Status: Done.
- Confirmed upstream injects static ACP rules through the system transform and dynamic context-limit guidance through the message transform.
- The local semantic scheduler retains its safer latest-real-user-message target instead of restoring upstream's synthetic suffix message.
- Removed the turn, iteration, and how-to-compress prompt assets, their prompt-store fields, preview/package entries, anchored injection helpers, obsolete anchor state, and the unused quality-rejection formatter.
- `system.md` is verified through the final system-transform payload. `context-limit-nudge.md` is verified on the latest real user message together with the frozen candidate list and cache boundary, and remains absent from ordinary growth nudges.
- Added the missing `qualityGate.algorithms` object to the bundled config so the complete config remains loadable.
- Verification passed: 812/812 tests, `npm run typecheck`, `npm run build`, `npm run verify:package`, targeted Prettier checks, and `git diff --check`.

## 5. Single Global Prompt Source

- Status: Done.
- Root cause confirmed: `compression-request.md` was classified as a fixed bundled asset, while global overrides were disabled by default and only three other prompt files were eligible for override.
- Target data flow: repository deployment source -> global ACM prompt directory -> `PromptStore` -> runtime consumers. Cached package and project prompt paths are excluded.
- Removed the prompt feature flag and fixed/bundled prompt split from config, schema, runtime, tests, preview tooling, and current documentation.
- Deployment now installs seven missing global prompts without overwriting edits, removes three obsolete prompts, and leaves no prompt directory in either cache target.
- Verified the deployed global `compression-request.md` through `npm run dcp -- --show compression-request`; it prints the user-edited `Maybe it's time to compress` text.
- Verification passed: 809/809 tests, `npm run typecheck`, `npm run check:package`, Git Bash syntax validation, real `--no-build` deployment, targeted Prettier checks, and `git diff --check`.
- Full `npm run format:check` remains blocked by the repository baseline of 624 pre-existing unformatted files; no unrelated bulk formatting was performed.
