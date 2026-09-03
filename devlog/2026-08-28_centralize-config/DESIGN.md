# Design

## Asset Boundary

Configuration defaults live in package assets:

- `config/acp.jsonc` contains the complete built-in configuration.
- `config/prompts/*.md` is deployment input for the global ACM prompt directory, not a package-cache asset.

TypeScript owns parsing, validation, layered overrides, dynamic interpolation, and orchestration. It must not duplicate values or prompt paragraphs from those assets.

## Configuration Flow

1. Parse and validate the bundled default object.
2. Clone it so callers cannot mutate shared defaults.
3. Apply the global ACP configuration when present.
4. Apply the `$OPENCODE_CONFIG_DIR` ACP configuration when present.
5. Apply the nearest project ACP configuration when present.
6. Preserve mandatory protected tools after each merge.

Malformed optional override files retain the existing warning-and-skip behavior. A malformed or missing bundled default is fatal because the package is incomplete.

## Prompt Flow

1. Deploy missing repository prompt files to `~/.config/opencode/acm/prompts/`.
2. Load every runtime prompt from that global directory.
3. Keep runtime data interpolation and extension composition in TypeScript.

## Packaging

`config/acp.jsonc` is an npm package allowlist entry. Package verification checks repository prompt sources but rejects `config/prompts/` from the tarball.

## Compatibility

Configuration layering remains supported. Prompt layering was later removed in favor of one global ACM prompt directory.
