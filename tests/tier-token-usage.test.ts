import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { SessionState, CompressionBlock } from "../lib/state/types.ts"
import { getTierTokenUsage, loadPruneMessagesState } from "../lib/state/utils.ts"
import type { PersistedPruneMessagesState } from "../lib/state/persistence.ts"
import { formatBlockRef } from "../lib/message-ids.ts"

function makeBlock(
    id: number,
    tier: number | undefined,
    summaryTokens: number,
    survivedCount = 5,
): CompressionBlock {
    return {
        blockId: id,
        ref: formatBlockRef(id, tier ?? 1),
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens,
        durationMs: 0,
        tier,
        topic: `block-${id}`,
        startId: "A001",
        endId: "A010",
        anchorMessageId: `msg-${id}`,
        compressMessageId: `compress-${id}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: Date.now(),
        summary: "test summary",
        survivedCount,
        generation: survivedCount >= 5 ? "old" : "young",
    }
}

function makeState(blocks: CompressionBlock[]): SessionState {
    const blocksById = new Map<number, CompressionBlock>()
    const activeBlockIds = new Set<number>()
    for (const b of blocks) {
        blocksById.set(b.blockId, b)
        if (b.active) activeBlockIds.add(b.blockId)
    }
    return {
        sessionId: "test",
        isSubAgent: false,
        compressPermission: "allow",
        prune: {
            messages: {
                byMessageId: new Map(),
                blocksById,
                activeBlockIds,
                activeByAnchorMessageId: new Map(),
                nextBlockId: blocks.length + 1,
                nextRunId: 2,
                markedForCleanup: new Set(),
            },
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
            lastPerMessageNudgeTurn: 0,
            lastPerMessageNudgeTokens: undefined,
            lastNudgeShownTokens: undefined,
            lastToolOutputNudgeTokens: undefined,
            shouldInjectThisTurn: undefined,
            compressBaselineSet: false,
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        messageIds: {
            byRawId: new Map(),
            byRef: new Map(),
            nextRef: 1,
        },
        compressionTiming: { pending: new Map(), completed: [] },
        toolParameters: new Map(),
    } as unknown as SessionState
}

describe("getTierTokenUsage", () => {
    it("returns zero for all tiers when no blocks exist", () => {
        const state = makeState([])
        const usage = getTierTokenUsage(state)
        assert.equal(usage.tier1Tokens, 0)
        assert.equal(usage.tier2Tokens, 0)
        assert.equal(usage.tier3Tokens, 0)
    })

    it("counts tier 1 blocks (explicit tier=1)", () => {
        const state = makeState([makeBlock(1, 1, 1000), makeBlock(2, 1, 2000)])
        const usage = getTierTokenUsage(state)
        assert.equal(usage.tier1Tokens, 3000)
        assert.equal(usage.tier2Tokens, 0)
        assert.equal(usage.tier3Tokens, 0)
    })

    it("counts undefined tier as tier 1", () => {
        const state = makeState([makeBlock(1, undefined, 1500), makeBlock(2, undefined, 500)])
        const usage = getTierTokenUsage(state)
        assert.equal(usage.tier1Tokens, 2000)
        assert.equal(usage.tier2Tokens, 0)
        assert.equal(usage.tier3Tokens, 0)
    })

    it("counts tier 2 separately and aggregates unbounded higher tiers", () => {
        const state = makeState([
            makeBlock(1, 1, 1000),
            makeBlock(2, 2, 500),
            makeBlock(3, 2, 300),
            makeBlock(4, 3, 100),
            makeBlock(5, 26, 50),
        ])
        const usage = getTierTokenUsage(state)
        assert.equal(usage.tier1Tokens, 1000)
        assert.equal(usage.tier2Tokens, 800)
        assert.equal(usage.tier3Tokens, 150)
    })

    it("skips inactive blocks", () => {
        const inactive = makeBlock(1, 1, 1000)
        inactive.active = false
        const state = makeState([inactive, makeBlock(2, 1, 2000)])
        const usage = getTierTokenUsage(state)
        assert.equal(usage.tier1Tokens, 2000)
    })

    it("handles mixed tiers correctly", () => {
        const state = makeState([
            makeBlock(1, undefined, 100),
            makeBlock(2, 1, 200),
            makeBlock(3, 2, 50),
            makeBlock(4, undefined, 300),
            makeBlock(5, 3, 25),
            makeBlock(6, 2, 75),
            makeBlock(7, 42, 10),
        ])
        const usage = getTierTokenUsage(state)
        assert.equal(usage.tier1Tokens, 600)
        assert.equal(usage.tier2Tokens, 125)
        assert.equal(usage.tier3Tokens, 35)
    })
})

describe("tier field persistence round-trip", () => {
    it("preserves unbounded positive tiers and stable refs through loadPruneMessagesState", () => {
        const persisted: PersistedPruneMessagesState = {
            nextBlockId: 4,
            nextRunId: 2,
            byMessageId: {},
            blocksById: {
                "1": { ...makeBlock(1, 1, 1000), tier: 1 },
                "2": { ...makeBlock(2, 4, 500), tier: 4 },
                "3": { ...makeBlock(3, 26, 100), tier: 26 },
            },
        }

        const loaded = loadPruneMessagesState(persisted)

        assert.equal(loaded.blocksById.get(1)?.tier, 1)
        assert.equal(loaded.blocksById.get(2)?.tier, 4)
        assert.equal(loaded.blocksById.get(3)?.tier, 26)
        assert.equal(loaded.blocksById.get(1)?.ref, "B001")
        assert.equal(loaded.blocksById.get(2)?.ref, "E002")
        assert.equal(loaded.blocksById.get(3)?.ref, "AA003")
    })

    it("defaults missing tier to undefined (treated as tier 1 by consumers)", () => {
        const persisted: PersistedPruneMessagesState = {
            nextBlockId: 2,
            nextRunId: 2,
            byMessageId: {},
            blocksById: {
                "1": { ...makeBlock(1, undefined, 1000), tier: undefined },
            },
        }

        const loaded = loadPruneMessagesState(persisted)

        assert.equal(loaded.blocksById.get(1)?.tier, undefined)
        const state = makeState([loaded.blocksById.get(1)!])
        assert.equal(getTierTokenUsage(state).tier1Tokens, 1000)
    })

    it("preserves tiers above the former three-tier limit", () => {
        const persisted: PersistedPruneMessagesState = {
            nextBlockId: 2,
            nextRunId: 2,
            byMessageId: {},
            blocksById: {
                "1": { ...makeBlock(1, 99, 1000), tier: 99 },
            },
        }

        const loaded = loadPruneMessagesState(persisted)

        assert.equal(loaded.blocksById.get(1)?.tier, 99)
        assert.equal(loaded.blocksById.get(1)?.ref, formatBlockRef(1, 99))
    })

    it("rejects non-positive and fractional tier values", () => {
        const persisted: PersistedPruneMessagesState = {
            nextBlockId: 4,
            nextRunId: 2,
            byMessageId: {},
            blocksById: {
                "1": { ...makeBlock(1, 1, 1000), tier: 0 },
                "2": { ...makeBlock(2, 1, 1000), tier: -1 },
                "3": { ...makeBlock(3, 1, 1000), tier: 1.5 },
            },
        }

        const loaded = loadPruneMessagesState(persisted)

        assert.equal(loaded.blocksById.get(1)?.tier, undefined)
        assert.equal(loaded.blocksById.get(2)?.tier, undefined)
        assert.equal(loaded.blocksById.get(3)?.tier, undefined)
    })

    it("preserves effectiveCompressedTokens through loadPruneMessagesState", () => {
        const persisted: PersistedPruneMessagesState = {
            nextBlockId: 2,
            nextRunId: 2,
            byMessageId: {},
            blocksById: {
                "1": {
                    ...makeBlock(1, 2, 500),
                    compressedTokens: 0,
                    effectiveCompressedTokens: 100000,
                },
            },
        }

        const loaded = loadPruneMessagesState(persisted)

        assert.equal(loaded.blocksById.get(1)?.effectiveCompressedTokens, 100000)
    })

    it("defaults missing effectiveCompressedTokens to undefined", () => {
        const persisted: PersistedPruneMessagesState = {
            nextBlockId: 2,
            nextRunId: 2,
            byMessageId: {},
            blocksById: {
                "1": { ...makeBlock(1, 1, 1000) },
            },
        }

        const loaded = loadPruneMessagesState(persisted)

        assert.equal(loaded.blocksById.get(1)?.effectiveCompressedTokens, undefined)
    })
})
