# Architecture

This document contains implementation detail that is useful when changing ACP architecture or data flow. The current source and package assets remain the source of truth when this document and code disagree.

## Module Boundaries

| Area | Responsibility |
| --- | --- |
| `index.ts` | Plugin entry point; wires hooks, tools, commands, configuration, and state. |
| `lib/hooks.ts` | System prompt, message transform, command, event, and text-complete hooks. |
| `lib/config.ts` | Configuration loading, parsing, validation, and migration behavior. |
| `lib/compress/` | Semantic checkpoint compression, decompression, state mutation, timing, and quality gates. |
| `lib/messages/` | Message querying, shaping, filtering, pruning, synchronization, IDs, token accounting, and nudges. |
| `lib/state/` | Session state, persistence, tool cache, model limits, and state utilities. |
| `lib/prompts/` | Fixed prompt loading, dynamic prompt composition, and prompt extensions. |
| `lib/gc/` | Age-based cleanup, summary truncation, and emergency context cleanup. |
| `lib/commands/` | `/acp` and `/dcp` command handlers. |
| `lib/ui/` | Notifications and context/stat formatting. |
| `tests/` | Unit, property, functional, integration, and E2E tests. |

The main dependency direction is:

```text
config -> state -> hooks
config/state -> compress pipeline -> activity/message tools
hooks -> messages, prompts, gc, state, commands, ui
``` 

`hooks.ts` is the orchestrator. `config.ts` should remain a leaf with no internal module dependency. The compression subsystem should be consumed through its pipeline or tool entry points rather than by reaching into unrelated state mutations.

## Request Lifecycle

`index.ts` registers these major paths:

```text
system transform -> render configured ACP system prompt
message transform -> state -> cleanup/activities/checkpoints -> GC/prune -> semantic nudge/IDs -> metadata cleanup
compress tool -> validate frozen candidates -> create checkpoint -> persist/notify
event hook -> track compression tool timing
text complete -> remove hallucinated message/block references
command hook -> /acp commands and /dcp compatibility alias
```

The message transform runs for every LLM request. Its order is load-bearing:

1. Resolve or create the session state and update per-turn/model state.
2. Remove stale model references and apply message filters.
3. Assign stable activity references and synchronize checkpoints and tool caches.
4. Run GC and compute the pre-prune context.
5. Prune messages covered by active checkpoints and handle emergency tool-output cleanup.
6. Freeze eligible semantic candidates when the scheduler fires, then inject the compression request and visible metadata.
7. Remove failed/consumed synthetic content and stale metadata, then persist diagnostics.

For example, checkpoint synchronization must happen before pruning, and activity references must be stable before the scheduler freezes a candidate set.

## Compression Model

The message transform groups eligible context into immutable model-facing activities such as `A001`. Tool calls and their results form one activity. Existing summaries are exposed as checkpoint references such as `B001`, with later letters representing later generations.

- The scheduler decides when compression is required and stores a frozen candidate list in session state.
- The model submits `keep`, `confirmedFacts`, and `nextSteps`; omitted eligible candidates are atomically replaced by one checkpoint.
- A checkpoint retains direct/effective message IDs, token counts, generation, survival data, and parent/consumed relationships so it can be pruned, nested, or decompressed safely.
- Stale candidates or invalid references reject the operation without partially mutating state. A keep-all operation clears the pending request without creating a checkpoint.
- Growth and emergency thresholds, checkpoint aging, truncation, and cleanup remain configuration- and implementation-defined; inspect `lib/state/`, `lib/compress/`, and `lib/gc/` before changing them.

## Message References and Protection

ACP keeps internal session-local message mappings and separate stable activity/checkpoint references:

```text
OpenCode raw message IDs -> A001 activity
compressed activity/checkpoint set -> B001 (then later generations)
```

Raw IDs and DCP-compatible metadata names remain in OpenCode and persisted state. The semantic activity/checkpoint references are the model-facing compression interface. Protected, synthetic, recent, and structurally unsafe groups are excluded before candidates are frozen.

Protection is enforced at candidate-selection and pruning layers, not only in checkpoint text. Do not rely on protected content being restated in `confirmedFacts` because later GC or truncation could remove it.

## State and Assets

- Session persistence is under the OpenCode storage area, normally `~/.local/share/opencode/storage/plugin/acp/{sessionId}.json`; honor the platform's configured data root.
- Built-in configuration comes from `config/acp.jsonc`; optional user layers apply global, `$OPENCODE_CONFIG_DIR`, then nearest project overrides.
- Built-in fixed prompts come from `config/prompts/`; when `experimental.customPrompts` is enabled, editable overrides resolve project, config-dir, then global locations.
- Runtime values such as token counts, candidate IDs, cache boundaries, checkpoint ages, and statistics stay in TypeScript and are interpolated into prompt templates.
- Package assets required at runtime must be included in the npm package allowlist and verified by `scripts/verify-package.mjs`.
