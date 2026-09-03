# Prompt Injection Data Flow

## Boundaries

- Static ACP operating rules from `config/prompts/system.md` are wrapped as a DCP-compatible system reminder and appended by `experimental.chat.system.transform`.
- Dynamic limit guidance from `config/prompts/context-limit-nudge.md` is appended to the latest real user message by `experimental.chat.messages.transform` only when a compression selection request is emitted at the max or emergency threshold.
- The context-limit guidance and frozen candidate request share one user-message suffix so urgency, eligible IDs, and the cache boundary reach the model together.

## Removed Paths

- Turn and iteration nudges belonged to the old anchored-message scheduler and are not part of semantic candidate scheduling.
- The how-to-compress asset only fed an uncalled legacy quality-rejection formatter.
- Removing these paths narrows `RuntimePrompts` to prompts with a verified model-facing consumer.

## Upstream Comparison

Upstream `ranxianglei/opencode-acp` at `ba5ef36934e7bfca3cb1d5046a87ff9d01a2d42b` uses the same context roles: static rules in the system transform and context-limit guidance in the message transform. This fork intentionally keeps dynamic guidance on the latest persisted user message because OpenCode does not guarantee that a transform-added synthetic message reaches the provider.

## Prompt Source Boundary

All runtime prompt fields are resolved from `~/.config/opencode/acm/prompts/`. There is no feature flag, project override, fixed-prompt branch, or bundled-file fallback. The repository `config/prompts/` directory is deployment input only; deployment copies missing files to the global directory and excludes that source directory from the cached plugin package.
