# Architecture

This document contains implementation detail that is useful when changing ACP architecture or data flow. The current source and package assets remain the source of truth when this document and code disagree.

## Module Boundaries

| Area | Responsibility |
| --- | --- |
| `index.ts` | Plugin entry point; wires hooks, tools, commands, configuration, and state. |
| `lib/hooks.ts` | System prompt, message transform, command, event, and text-complete hooks. |
| `lib/config.ts` | Configuration loading, parsing, validation, and migration behavior. |
| `lib/compress/` | Compression, decompression, range resolution, state mutation, timing, and quality gates. |
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
config/state -> compress pipeline -> range/message tools
hooks -> messages, prompts, gc, state, commands, ui
```

`hooks.ts` is the orchestrator. `config.ts` should remain a leaf with no internal module dependency. The compression subsystem should be consumed through its pipeline or tool entry points rather than by reaching into unrelated state mutations.

## Request Lifecycle

`index.ts` registers these major paths:

```text
system transform -> render configured ACP system prompt
message transform -> state -> cleanup/sync -> prune -> nudges/IDs -> final metadata cleanup
compress tool -> prepare -> resolve/apply state -> persist/evaluate/notify
event hook -> track compression tool timing
text complete -> remove hallucinated message/block references
command hook -> /acp commands and /dcp compatibility alias
```

The message transform runs for every LLM request. Its order is load-bearing:

1. Resolve or create the session state and update per-turn/model state.
2. Remove stale model references and apply message filters.
3. Assign stable `mNNNNN` references and synchronize compression blocks/tool caches.
4. Run GC and compute the pre-prune context.
5. Prune messages covered by active blocks and handle emergency tool-output cleanup.
6. Inject nudges and visible message IDs/ranges.
7. Remove failed/consumed synthetic content and stale metadata, then persist diagnostics.

For example, block synchronization must happen before pruning, and visible IDs must be stable before the model can submit compression boundaries.

## Compression Model

Each compression creates a `CompressionBlock` with a `blockId`, `runId`, topic, summary, direct/effective message IDs and token counts, generation, survival data, and relationship metadata.

- New blocks can consume or nest older blocks.
- The state retains parent/child and consumed relationships so compression can be represented and recovered.
- `young` and `old` generation behavior, block aging, truncation, and emergency merging are configuration- and implementation-defined; inspect `lib/state/`, `lib/compress/`, and `lib/gc/` before changing them.
- Range mode resolves `mNNNNN` boundaries; block-oriented operations resolve `bN` boundaries.
- Reversed boundaries, expired IDs, tool-use/tool-result pairs, and protected content are handled by the search/range layer and must remain tested.

## Message References and Protection

ACP keeps a session-local bidirectional mapping:

```text
OpenCode raw message ID <-> m00001
```

Raw IDs remain in OpenCode and persisted state. The short references are model-facing aliases. `assignMessageRefs()` maintains the mapping and `injectMessageIds()` exposes valid references and message metadata to the model. Protected messages use `BLOCKED` where appropriate.

Protection is enforced at the selection and pruning layers, not only in summary text. Do not rely on protected content being appended to a summary because later GC or summary truncation could remove it.

## State and Assets

- Session persistence is under the OpenCode storage area, normally `~/.local/share/opencode/storage/plugin/acp/{sessionId}.json`; honor the platform's configured data root.
- Configuration and fixed prompt assets must be loaded according to the current implementation. Do not reintroduce environment, project, or home-directory probing without an explicit compatibility decision.
- Runtime values such as token counts, message ranges, IDs, block ages, and statistics stay in TypeScript and are interpolated into prompt templates.
- Package assets required at runtime must be included in the npm package allowlist and verified by `scripts/verify-package.mjs`.
