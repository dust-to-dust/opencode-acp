import assert from "node:assert/strict"
import test from "node:test"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "../lib/compress/state"
import type { CompressionStateInput, SelectionResolution } from "../lib/compress/types"
import { formatMessageIdTag } from "../lib/message-ids"
import { createSessionState } from "../lib/state/state"

function selection(ids: string[], tokens = 100): SelectionResolution {
    return {
        startReference: { kind: "message", rawIndex: 0, messageId: ids[0] },
        endReference: { kind: "message", rawIndex: ids.length - 1, messageId: ids.at(-1) },
        messageIds: ids,
        messageTokenById: new Map(ids.map((id) => [id, tokens])),
        toolIds: [],
        requiredBlockIds: [],
    }
}

function input(startId: string, endId: string, runId = 1): CompressionStateInput {
    return {
        topic: "Context checkpoint",
        batchTopic: undefined,
        startId,
        endId,
        mode: "range",
        runId,
        compressMessageId: `compress-${runId}`,
        compressCallId: `call-${runId}`,
        summaryTokens: 20,
    }
}

test("block and run IDs remain monotonic", () => {
    const state = createSessionState()
    assert.deepEqual([allocateBlockId(state), allocateBlockId(state)], [1, 2])
    assert.deepEqual([allocateRunId(state), allocateRunId(state)], [1, 2])
})

test("wrapCompressedSummary uses the requested generation ref", () => {
    const summary = wrapCompressedSummary(4, 2, "Confirmed facts:\n- decision")
    assert.ok(summary.startsWith(COMPRESSED_BLOCK_HEADER))
    assert.ok(summary.includes("Confirmed facts:"))
    assert.ok(summary.endsWith(formatMessageIdTag("C4")))
})

test("compressing raw A activities creates a B checkpoint", () => {
    const state = createSessionState()
    applyCompressionState(
        state,
        input("A1", "A2"),
        selection(["raw-1", "raw-2"]),
        "raw-2",
        1,
        wrapCompressedSummary(1, 1, "Confirmed facts:\n- done"),
        [],
    )

    const block = state.prune.messages.blocksById.get(1)
    assert.equal(block?.ref, "B1")
    assert.equal(block?.tier, 1)
    assert.deepEqual(block?.directMessageIds, ["raw-1", "raw-2"])
    assert.deepEqual(state.prune.messages.byMessageId.get("raw-1")?.activeBlockIds, [1])
})

test("compressing a B checkpoint and a raw A activity creates C", () => {
    const state = createSessionState()
    applyCompressionState(
        state,
        input("A1", "A1"),
        selection(["raw-1"]),
        "raw-1",
        1,
        "B summary",
        [],
    )
    applyCompressionState(
        state,
        input("B1", "A2", 2),
        selection(["raw-2"]),
        "raw-2",
        2,
        "C summary",
        [1],
    )

    const first = state.prune.messages.blocksById.get(1)
    const second = state.prune.messages.blocksById.get(2)
    assert.equal(first?.active, false)
    assert.equal(first?.deactivatedByBlockId, 2)
    assert.equal(second?.ref, "C2")
    assert.equal(second?.tier, 2)
    assert.deepEqual(second?.effectiveMessageIds.sort(), ["raw-1", "raw-2"])
    assert.deepEqual(second?.consumedBlockIds, [1])
})

test("generation is one above the deepest consumed checkpoint without a tier cap", () => {
    const state = createSessionState()
    applyCompressionState(state, input("A1", "A1"), selection(["raw-1"]), "raw-1", 1, "B", [])
    const first = state.prune.messages.blocksById.get(1)!
    first.tier = 27
    first.ref = "AB1"

    applyCompressionState(state, input("AB1", "AB1", 2), selection([]), "raw-1", 2, "AC", [1])
    assert.equal(state.prune.messages.blocksById.get(2)?.tier, 28)
    assert.equal(state.prune.messages.blocksById.get(2)?.ref, "AC2")
})
