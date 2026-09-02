# ACP E2E Tests

End-to-end tests for ACP's scheduler-driven semantic activity selection using a fake LLM server.

## Quick Start

```bash
# Build ACP and run all scenarios
./scripts/e2e/run-e2e.sh

# Run one scenario
./scripts/e2e/run-e2e.sh scripts/e2e/scenarios/09-nudge-refire-after-compress.json

# Reuse an existing dist bundle during local iteration
SKIP_BUILD=1 ./scripts/e2e/run-e2e.sh
```

Prerequisites: `opencode`, `bun`, `node`, and `curl` on `PATH`.

## Flow

The runner creates an isolated OpenCode home and project under `/tmp/acp-e2e`, starts the fake OpenAI-compatible server, executes each scripted conversation, and verifies ACP's persisted state. The fake project keeps OpenCode's Git project identity cache out of the real repository's `.git/opencode` file.

The fake LLM does not choose when compression starts. It emits growth text or tool output until ACP appends `[ACP compression required]`. It then parses the eligible `A`/checkpoint refs from that fixed tail request and calls:

```json
{
    "keep": [],
    "confirmedFacts": ["Durable facts from this scenario."],
    "nextSteps": []
}
```

This exercises the real growth gate, pending selection, semantic checkpoint commit, baseline reset, and subsequent growth cycle.

## Scenarios

| File                                  | Description                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `06-nudge-triggered.json`             | Context growth triggers an ACP selection request and one or more checkpoints.                   |
| `08-nudge-with-protection.json`       | The same flow with `preserveRecentMessages: 5`; protected recent activities remain in context.  |
| `09-nudge-refire-after-compress.json` | Multi-turn growth, compression, baseline reset, more growth, and another request.               |
| `10-autonomous-nudge-refire.json`     | A single autonomous tool loop grows context and completes two scheduler-triggered compressions. |

## Scenario Fields

- `respond: "nudge-compress"` emits `growthText` until ACP requests compression, then sends a selection call.
- `respond: "autonomous-nudge"` uses tool output for growth and repeats until `maxCompressCount` is reached.
- `summary` becomes the single durable entry in `confirmedFacts`.
- `acpConfig` overrides the isolated scenario configuration.
- `verify.minBlockCount` and `verify.maxBlockCount` constrain checkpoint count.
- `verify.nudgeBaselineSet` checks that `lastPerMessageNudgeTokens` exists.
- `verify.nudgeBaselineMin` checks its persisted numeric value.
- `verify.pendingCompressionSet` checks whether a request remains unresolved.
- `verify.maxCompressCallsVisible` and `verify.maxNudgeCount` constrain request history behavior.

The runner builds by default. Set `SKIP_BUILD=1` only when `dist/index.js` already contains the changes being tested.
