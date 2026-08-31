# Design

## Asset Boundary

Runtime defaults live in package assets:

- `config/acp.jsonc` contains the complete built-in configuration.
- `config/prompts/*.md` contains fixed prompt text.

TypeScript owns parsing, validation, layered overrides, dynamic interpolation, and orchestration. It must not duplicate values or prompt paragraphs from those assets.

## Configuration Flow

1. Parse and validate the bundled default object.
2. Clone it so callers cannot mutate shared defaults.
3. Apply the global ACP configuration when present.
4. Apply the nearest project ACP configuration when present.
5. Preserve mandatory protected tools after each merge.

Malformed optional override files retain the existing warning-and-skip behavior. A malformed or missing bundled default is fatal because the package is incomplete.

## Prompt Flow

1. Load every bundled prompt asset from `config/prompts/`.
2. When custom prompts are disabled, use those bundled values directly.
3. When enabled, apply global prompt overrides and then project prompt overrides.
4. Keep runtime data interpolation and extension composition in TypeScript.

## Packaging

`config/` is an npm package allowlist entry. Package verification checks the config file and every prompt asset explicitly, in addition to the compiled entry points and documentation.

## Compatibility

This refactor changes the storage location of built-in defaults, not the user-facing configuration model. Global/project layering and `experimental.customPrompts` remain supported.
