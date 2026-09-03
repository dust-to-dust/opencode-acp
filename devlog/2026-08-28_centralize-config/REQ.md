# Centralize Configuration and Prompts

## Problem

ACP defaults and built-in prompt text are embedded across TypeScript modules. This makes the effective runtime contract difficult to inspect, package, and update without changing implementation code.

## Requirements

- Make `config/acp.jsonc` the sole source of built-in configuration defaults.
- Make Markdown files under `config/prompts/` the sole source of built-in prompt text.
- Preserve global and project configuration layering over the bundled defaults.
- This historical prompt-override requirement is superseded: runtime prompts now have one global ACM source.
- Keep dynamic runtime values and prompt composition in TypeScript.
- Include required configuration assets in the npm package while excluding prompt files from the cache.
- Keep the existing ACP/DCP compatibility identifiers unchanged.
- Do not add runtime dependencies for this refactor.

## Acceptance Criteria

- The plugin loads bundled defaults without user configuration.
- Global and project config files override only the values they specify.
- Protected tools still include the mandatory `compress` tool after overrides.
- Prompt loading uses the global ACM directory with no feature gate or project precedence.
- Prompt preview tooling lists and renders every public prompt key without stale references.
- Missing, empty, or invalid bundled assets fail with actionable errors.
- Type checking, tests, formatting, package verification, and tarball inspection pass.

## Constraints

- The semantic-context-block implementation already merged into fork `master` remains authoritative when its behavior conflicts with older range-compression code.
- Existing user and project configuration files are a compatibility contract.
- `package.json` version remains unchanged on this non-release branch.
