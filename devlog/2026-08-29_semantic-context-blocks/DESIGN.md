# DESIGN - Semantic Context Blocks

- Task ID: `2026-08-29_semantic-context-blocks`
- Home Repo: `opencode-acp`
- Created: 2026-08-29
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** ACP currently delegates compression timing, boundaries, and summarization to the model. The model should instead receive a small, mandatory selection task only when ACP's scheduler decides compression is needed.
- **Why now?** Stable, finer blocks improve selective retention and reduce repeated compression instructions without adding another model call.

## 2. Goals & Non-Goals

- **Goals**:
    - Stable `A001` source blocks and generation-advanced compressed blocks.
    - Deterministic, persisted semantic grouping at conversation activity boundaries.
    - Plugin-owned timing with a concise model-facing keep request.
    - Compressed output consisting of retained full blocks plus confirmed facts and next steps.
- **Non-Goals**:
    - Legacy session migration.
    - Plugin-initiated LLM calls.
    - A model-independent keep quota.
    - Embedding or classifier dependencies.

## 3. Current Architecture

- **How it works today**: Raw messages receive `mNNNNN` aliases. A nudge asks the model to call `compress` with contiguous start/end IDs and a detailed summary. Compression creates numeric `bN` blocks, and later tiers summarize those blocks again.
- **Pain points**: Timing and range choices are model-owned, ranges are only weakly grouped by message/turn boundaries, and detailed guidance is repeated in dynamic suffixes.

## 4. Proposed Architecture

- **Overview**:

```text
completed messages -> deterministic semantic groups -> stable A blocks
       |                                               |
token scheduler -> concise mandatory selection --------+
                                                       v
model keep/facts/nextSteps -> validation -> complement compression
                                      -> retained blocks + B checkpoint
```

- **Key components**:
    - A semantic-block index persisted per session.
    - A generation-aware reference codec (`A001`, `B001`, ...).
    - A keep-based compression tool.
    - A scheduler-generated suffix containing only candidates, cache boundary, and the required tool shape.
- **Data flow**: Group completed conversation activities, assign source IDs once, select eligible blocks outside protected/recent content, inject the request at the existing nudge threshold, then replace non-kept candidates with one next-generation checkpoint while retained blocks remain visible and unchanged.
- **API / interface changes**: Replace range `startId/endId/summary` input with `keep`, `confirmedFacts`, and `nextSteps`. Candidates are frozen in session state and shown in the scheduler request rather than echoed back through the tool. Legacy arguments are rejected.

## 5. Design Decisions & Rationale

| Decision      | Options Considered                                  | Chosen            | Why                                                                      |
| ------------- | --------------------------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| Trigger owner | Model, plugin scheduler, hidden LLM                 | Plugin scheduler  | Meets the requirement without recursion or extra inference cost.         |
| Granularity   | Arbitrary token chunks, embeddings, activity groups | Activity groups   | Deterministic, cheap, and keeps tool calls with their results.           |
| Identity      | Rename nodes, immutable lineage                     | Immutable lineage | Retained IDs remain stable and many-to-one compression is representable. |
| Keep limit    | Plugin budget, model choice                         | Model choice      | Explicit user requirement.                                               |
| Compatibility | Migration, reset                                    | Reset             | Explicit user requirement and simpler state semantics.                   |

## 6. Impact Analysis

- **Backward compatibility**: Intentionally none. A state schema version mismatch discards old persisted state.
- **Performance**: Linear grouping and candidate construction; no network calls or new heavy dependencies.
- **Security**: Existing protected-tool, protected-file, and recent-content exclusions remain enforced by ACP.
- **Dependencies**: No new packages.

## 7. Migration Plan

- **Steps**: None. Old state is ignored and a fresh semantic-block state is created.
- **Feature flags / gradual rollout**: None requested.

## 8. Open Questions

- None. Implementation details may be simplified where the existing message-level prune model makes finer part-level slicing disproportionately complex.
