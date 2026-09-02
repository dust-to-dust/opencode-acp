# Development and Local Verification

## Build Artifacts

- `dist/` contains bundled ESM JavaScript and generated declarations.

## Local Deployment

The supported local deployment helper is:

```bash
./scripts/dev-deploy.sh
./scripts/dev-deploy.sh --check
./scripts/dev-deploy.sh --no-build
```

The `--check` variant runs tests, type checking, building, and deployment. The `--no-build` variant deploys the existing `dist/` output.

OpenCode resolves the `latest` plugin cache under:

```text
~/.cache/opencode/packages/opencode-acp@latest/node_modules/opencode-acp/
```

The helper rebuilds the deployed package's runtime dependency tree, including the `@opencode-ai/plugin` peer dependency. It removes source-only `devDependencies` from the deployed metadata and marks the cache package as version `9.9.9`, while leaving the source package version unchanged.

After deployment, restart OpenCode because the running process caches the module. Inspect the deployed bundle when a deployment needs verification.

Do not use the older `~/.cache/opencode/node_modules/opencode-acp/` path for `@latest` resolution.

## Diagnostics

ACP diagnostics are normally written to:

```text
~/.config/opencode/logs/acp/context/<session_id>/<timestamp>.json
~/.config/opencode/logs/acp/daily/<date>.log
```

Context files contain per-request message snapshots. Daily logs always include warnings and errors; informational/debug output depends on the debug setting.

## Package and Platform Notes

- Runtime configuration and prompt assets must be present in the package, not only in the source tree.
- Run package verification after changing `package.json`'s `files` list or adding runtime assets.
- Prefer commands from `package.json` and the repository scripts over platform-specific ad-hoc commands.
- If a local environment exposes platform-specific failures, record the exact command and error in the worklog rather than weakening runtime behavior without a design decision.
