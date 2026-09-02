import assert from "node:assert/strict"
import test from "node:test"
import {
    assignMessageRefs,
    formatBlockRef,
    formatGenerationLabel,
    formatMessageIdTag,
    formatMessageRef,
    parseBlockGeneration,
    parseBlockRef,
    parseBoundaryId,
    parseMessageRef,
} from "../lib/message-ids"
import { createSessionState } from "../lib/state/state"
import type { WithParts } from "../lib/state/types"

function message(id: string, role: "user" | "assistant" = "assistant", parts?: any[]): WithParts {
    return {
        info: {
            id,
            sessionID: "session-ids",
            role,
            time: { created: 1 },
            ...(role === "assistant"
                ? {
                      parentID: "parent",
                      modelID: "model",
                      providerID: "provider",
                      mode: "normal",
                      agent: "build",
                      path: { cwd: "/", root: "/" },
                      cost: 0,
                      tokens: {
                          input: 0,
                          output: 0,
                          reasoning: 0,
                          cache: { read: 0, write: 0 },
                      },
                  }
                : {
                      agent: "build",
                      model: { providerID: "provider", modelID: "model" },
                  }),
        } as any,
        parts: parts ?? [{ type: "text", text: id }],
    }
}

test("formats raw activities as stable A refs", () => {
    assert.equal(formatMessageRef(1), "A1")
    assert.equal(formatMessageRef(123), "A123")
    assert.equal(formatMessageRef(1000), "A1000")
    assert.equal(parseMessageRef(" a001 "), null)
    assert.equal(parseMessageRef("A5"), 5)
    assert.equal(parseMessageRef("m00001"), null)
})

test("formats checkpoints by compression generation", () => {
    assert.equal(formatBlockRef(1), "B1")
    assert.equal(formatBlockRef(4, 2), "C4")
    assert.equal(formatBlockRef(28, 26), "AA28")
    assert.equal(formatGenerationLabel(0), "A")
    assert.equal(formatGenerationLabel(26), "AA")
    assert.equal(parseBlockRef(" c004 "), null)
    assert.equal(parseBlockRef("B1"), 1)
    assert.equal(parseBlockGeneration("C4"), 2)
    assert.equal(parseBlockGeneration("C004"), null)
    assert.equal(parseBlockRef("b1"), 1)
})

test("parses A refs and checkpoint refs as distinct boundary kinds", () => {
    assert.deepEqual(parseBoundaryId("A7"), {
        kind: "message",
        ref: "A7",
        index: 7,
    })
    assert.deepEqual(parseBoundaryId("C4"), {
        kind: "compressed-block",
        ref: "C4",
        blockId: 4,
    })
    assert.deepEqual(parseBoundaryId("B4"), {
        kind: "compressed-block",
        ref: "B4",
        blockId: 4,
    })
    assert.equal(parseBoundaryId("A007"), null)
    assert.equal(parseBoundaryId("C004"), null)
})

test("assignMessageRefs is monotonic and stable", () => {
    const state = createSessionState()
    const first = message("raw-1", "user")
    const second = message("raw-2")
    assert.equal(assignMessageRefs(state, [first, second]), 2)
    assert.equal(state.messageIds.byRawId.get("raw-1"), "A1")
    assert.equal(state.messageIds.byRawId.get("raw-2"), "A2")

    assert.equal(assignMessageRefs(state, [second, first, message("raw-3")]), 1)
    assert.equal(state.messageIds.byRawId.get("raw-1"), "A1")
    assert.equal(state.messageIds.byRawId.get("raw-3"), "A3")
})

test("message refs remain unchanged when a pruned message leaves the context", () => {
    const state = createSessionState()
    const first = message("raw-1", "user")
    const second = message("raw-2")
    const third = message("raw-3")

    assignMessageRefs(state, [first, second, third])
    assignMessageRefs(state, [first, third, message("raw-4")])

    assert.equal(state.messageIds.byRawId.get("raw-1"), "A1")
    assert.equal(state.messageIds.byRawId.get("raw-2"), "A2")
    assert.equal(state.messageIds.byRawId.get("raw-3"), "A3")
    assert.equal(state.messageIds.byRawId.get("raw-4"), "A4")
})

test("existing refs are not rewritten when tool activity members are rejoined", () => {
    const state = createSessionState()
    const call = message("assistant-call", "assistant", [
        { type: "tool", tool: "bash", callID: "call-1", state: { status: "running" } },
    ])
    const result = message("tool-result", "user", [
        {
            type: "tool",
            tool: "bash",
            callID: "call-1",
            state: { status: "completed", output: "done" },
        },
    ])

    assignMessageRefs(state, [call])
    assignMessageRefs(state, [result])
    assignMessageRefs(state, [call, result])

    assert.equal(state.messageIds.byRawId.get("assistant-call"), "A1")
    assert.equal(state.messageIds.byRawId.get("tool-result"), "A2")
    assert.equal(state.messageIds.byRef.get("A1"), "assistant-call")
    assert.equal(state.messageIds.byRef.get("A2"), "tool-result")
})

test("compress tool carrier messages do not receive A refs", () => {
    const state = createSessionState()
    const carrier = message("compress-message", "assistant", [
        {
            type: "tool",
            tool: "compress",
            callID: "call-1",
            state: { status: "completed", input: {}, output: "ok" },
        },
    ])
    assert.equal(assignMessageRefs(state, [carrier]), 0)
    assert.equal(state.messageIds.byRawId.has("compress-message"), false)
})

test("tool calls and their independently stored results share one A ref", () => {
    const state = createSessionState()
    const call = message("assistant-call", "assistant", [
        {
            type: "tool",
            tool: "bash",
            callID: "call-1",
            state: { status: "running", input: { command: "pwd" } },
        },
    ])
    const result = message("tool-result", "user", [
        {
            type: "tool",
            tool: "bash",
            callID: "call-1",
            state: { status: "completed", input: { command: "pwd" }, output: "/workspace" },
        },
    ])

    assert.equal(assignMessageRefs(state, [call]), 1)
    assert.equal(assignMessageRefs(state, [call, result]), 1)
    assert.equal(state.messageIds.byRawId.get("assistant-call"), "A1")
    assert.equal(state.messageIds.byRawId.get("tool-result"), "A1")
})

test("message ID tags preserve deterministic attribute order", () => {
    const tagName = ["dcp", "message", "id"].join("-")
    assert.equal(
        formatMessageIdTag("A5", { type: "text", tokens: "12" }),
        `\n<${tagName} tokens="12" type="text">A5</${tagName}>`,
    )
})

test("ref formatters reject invalid indexes", () => {
    assert.throws(() => formatMessageRef(0), /out of bounds/)
    assert.throws(() => formatBlockRef(0), /Invalid block ID/)
    assert.throws(() => formatBlockRef(1, 0), /Invalid compression generation/)
})
