# REQ - Semantic Context Blocks

- Task ID: `2026-08-29_semantic-context-blocks`
- Home Repo: `opencode-acp`
- Created: 2026-08-29
- Status: Completed
- Priority: P1
- Owner: OpenCode
- References: User request

## 1. Background & Problem Statement

- **Context**: ACP currently exposes message IDs and asks the model to choose when, where, and how to compress contiguous message ranges.
- **Current behavior (symptom)**: Compression timing and range selection consume model attention, range boundaries are message-oriented rather than semantic, and nudge text repeats compression guidance already present in the system prompt.
- **Expected behavior**: ACP decides when compression is required, presents stable semantic blocks as candidates, and asks the model only which blocks to retain plus a compact record of confirmed facts and next steps.
- **Impact**: Compression becomes a bounded selection task, while stable block IDs keep the unchanged context prefix cache-friendly between compression events.

## 2. Reproduction

- **Environment**:
    - Node: project-supported Node.js
    - OS/Arch: GitHub Codespaces Linux
- **Minimal reproduction steps**:
    1. Grow a session until ACP's configured compression threshold is reached.
    2. Observe that the current nudge asks the model to choose compression timing/ranges and write unrestricted summaries.
- **Relevant configuration**: Existing compression thresholds and protected-content settings remain authoritative.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: None. Existing persisted sessions are intentionally ignored; no migration is provided.
    - Performance requirements: Semantic boundaries and IDs must remain stable between compression events so unchanged prefixes remain cacheable.
    - Resource limits: The selection prompt must be concise and must not repeat compression rules from the system prompt.
    - ACP chooses the trigger time; the model alone chooses how many candidate blocks to retain.
    - Missing one or two optional blocks in `keep` is acceptable; avoid defensive protocol complexity.
- **Non-Goals**:
    - Calling an LLM from the plugin.
    - Preserving legacy `mNNNNN` / `bN` state or tool compatibility.
    - Imposing a keep count or keep-token budget on the model.
    - Embedding-based semantic clustering.

## 4. Acceptance Criteria

- **Correctness**:
    - [x] Completed source content is exposed as stable `A001`-style semantic blocks.
    - [x] A compression over source blocks creates `B001`-style blocks; recompression advances the generation letter.
    - [x] Unchanged retained blocks keep their IDs; IDs change only when source blocks are replaced by a compressed block.
    - [x] ACP determines when to inject a concise mandatory compression request.
    - [x] The request includes the compressible candidate block range/list and identifies the cache-safe boundary.
    - [x] Full compression guidance appears only in the system prompt, not in trigger messages.
    - [x] The model submits retained block IDs, confirmed facts, and next steps; the plugin compresses unretained candidates.
    - [x] Protected and recent content remains outside the candidate set.
- **Performance / Stability**:
    - [x] Semantic block construction is deterministic and introduces no LLM or embedding call.
    - [x] Invalid selections do not partially mutate compression state.
- **Regression**:
    - [x] New and modified tests cover multi-turn trigger state, production recent-message protection, compression lineage, persistence reset, and full growth/compression cycles.
    - [x] Changed-file formatting, typecheck, and all tests pass. Build was intentionally not run per the user's explicit instruction not to construct release artifacts.

## 5. Proposed Approach

- **Affected modules & entry files**:
    - `lib/state/types.ts` and `lib/state/persistence.ts` - new persisted semantic-block state with a schema-version reset.
    - `lib/messages/inject/` - deterministic semantic grouping, candidate display, concise scheduler-owned trigger.
    - `lib/compress/` - keep-based tool contract and generation-aware state mutation.
    - `lib/prompts/` - system-only selection/compression rules.
    - `index.ts` - register the revised tool contract.
- **Risks**: This intentionally invalidates persisted sessions and changes the model-facing compression API.
- **Rollback strategy**: Revert this branch; no data migration or downgrade path is promised.
