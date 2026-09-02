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
