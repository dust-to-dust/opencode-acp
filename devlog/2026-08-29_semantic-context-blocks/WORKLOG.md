# WORKLOG - Semantic Context Blocks

- Task ID: `2026-08-29_semantic-context-blocks`
- Home Repo: `opencode-acp`
- Status: Completed
- Updated: 2026-08-29

## 1. Summary

- **What was done**: Replaced model-directed range compression with scheduler-triggered, keep-based semantic activity compression.
- **Why**: Reduce compression bookkeeping performed by the model while keeping the model responsible for information-retention choices.
- **Behavior / compatibility changes**: Yes. The model-facing ID and compression protocols are replaced without legacy-session migration.
- **Risk level**: High

## 2. Change Log

### Commits

| Commit  | Description                     |
| ------- | ------------------------------- |
| Pending | Semantic context block protocol |

### Key Files

- `lib/message-ids.ts` - stable activity and checkpoint references, including atomic tool activities.
- `lib/messages/inject/inject.ts` - scheduler-owned pending selections and concise cache-safe requests.
- `lib/compress/range.ts` - keep/facts/next-steps validation and complement compression.
- `lib/compress/state.ts` - immutable lineage and unbounded checkpoint generations.
- `lib/state/persistence.ts` - schema version 3 reset with no legacy migration.
- `lib/prompts/system.ts` - the single complete source of compression guidance.
- `scripts/e2e/` - selection-only fake LLM scenarios and exact nudge-state verification.

## 3. Design & Implementation Notes

- **Entry point / key function**: `createChatMessageTransformHandler`
- **Key configuration items**: Existing compression thresholds and protection settings.
- **Key logic explanation**: ACP freezes eligible A/checkpoint candidates when token growth crosses the configured threshold. The model chooses any retained candidates and records confirmed facts and next steps. ACP atomically replaces the omitted complement with one generation-advanced checkpoint.
- **Safety details**: Tool calls and their results share one A reference; protection applies to the whole activity; stale pending selections are refreshed; checkpoint carriers must remain visible; persistence is the transaction commit boundary.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run format:check
npm run typecheck
npm run test
bash -n scripts/e2e/run-e2e.sh
```

### Test Coverage

- New/modified tests cover activity references, complement selection, multi-turn scheduling, production recent-message protection, stale pending recovery, transaction rollback, carrier synchronization, exact-generation decompression, persistence reset, and end-to-end message transforms.
- Test count: 806.
- Key scenarios verified: A-to-B and A/B-to-C lineage, generations beyond Z, keep none/all/any, atomic tool activities, full baseline-growth-compress-growth cycle, and protected/recent exclusions.
- The baseline-reset regression test was verified to fail while the historical bug was temporarily restored, then the correct implementation was restored.

### Results

- **PASS**: `npm run typecheck`.
- **PASS**: `npm run test` - 806 passed, 0 failed.
- **PASS**: changed-file Prettier and `git diff --check`.
- **PASS**: E2E script parsing checks. Docker E2E was not run because it requires a fresh build, and the user explicitly prohibited constructing release artifacts.
- **NOT RUN**: `npm run build`, per explicit user instruction.

## 5. Risk Assessment & Rollback

- **Risk points**: Persisted state reset, model-facing tool replacement, semantic boundary stability, and pruning correctness.
- **Rollback method**: Revert this branch.
- **Compatibility notes**: Existing ACP session state is intentionally discarded after the state schema version changes.

## 6. Lessons Learned

- Keep dynamic requests small and stable; protocol guidance belongs in the system prompt.
- A checkpoint without its compress-call carrier must deactivate, otherwise source messages are hidden without a visible replacement.
- Multi-file patches are fragile after formatting; small patches against freshly read local context are more reliable.

## 7. Follow-ups

- [x] Complete implementation and verification.
- [ ] Run Docker E2E after a human authorizes building a fresh local bundle.
