import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { buildCompressedBlockGuidance } from "../lib/prompts/extensions/nudge"
import { createSessionState } from "../lib/state"

const contextLimitNudge = readFileSync(
    join(process.cwd(), "config", "prompts", "context-limit-nudge.md"),
    "utf-8",
)

test("CONTEXT_LIMIT_NUDGE frames compression as a step with decompress safety net", () => {
    assert.match(contextLimitNudge, /time to compress/i)
    assert.match(contextLimitNudge, /decompress/i)
    assert.doesNotMatch(contextLimitNudge, /\b(MUST|CRITICAL)\b/)
})

test("buildCompressedBlockGuidance shows compact summary with block count", () => {
    const state = createSessionState()
    for (const id of [1, 2, 3]) {
        state.prune.messages.activeBlockIds.add(id)
        state.prune.messages.blocksById.set(id, {
            summaryTokens: id * 100,
            createdAt: Date.now(),
            active: true,
        } as never)
    }

    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /Compressed blocks: 3/)
    assert.match(guidance, /600 summary/)
    assert.match(guidance, /acp_status/)
})

test("buildCompressedBlockGuidance shows last compression age", () => {
    const state = createSessionState()
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.blocksById.set(1, {
        summaryTokens: 500,
        createdAt: Date.now() - 5 * 60_000,
        active: true,
    } as never)

    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /5m ago/)
})

test("buildCompressedBlockGuidance aggregates summary tokens across blocks", () => {
    const state = createSessionState()
    for (const id of [1, 2, 3]) {
        state.prune.messages.activeBlockIds.add(id)
        state.prune.messages.blocksById.set(id, {
            summaryTokens: id * 1000,
            createdAt: Date.now(),
            active: true,
        } as never)
    }

    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /6\.0K summary/)
    assert.match(guidance, /acp_status for details/)
})
