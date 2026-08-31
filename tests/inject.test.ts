import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { assignMessageRefs, formatMessageIdTag } from "../lib/message-ids"
import { injectCompressNudges, injectMessageIds } from "../lib/messages/inject/inject"
import type { RuntimePrompts } from "../lib/prompts/store"
import {
    createSessionState,
    type CompressionBlock,
    type SessionState,
    type WithParts,
} from "../lib/state"

const SID = "ses-inject-selection"
const logger = new Logger(false)
const prompts = {} as RuntimePrompts

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 900_000,
            minContextLimit: 0,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            nudgeGrowthTokens: 2_000,
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 1,
            preserveRecentTokens: 0,
            preserveLastUserMessage: true,
            minNudgeContextPercent: 0,
            minNudgeGrowthRatio: 0,
            minNudgeGrowthFloor: 100,
            minCompressRange: 0,
            maxSummaryLengthHard: 10_000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2_000,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3_000,
            majorGcThresholdPercent: "100%",
            batchCleanup: {
                lowThreshold: "60%",
                highThreshold: "75%",
                forceThreshold: "90%",
            },
        },
    }
}

function textPart(messageID: string, text: string): WithParts["parts"][number] {
    return {
        id: `part-${messageID}`,
        messageID,
        sessionID: SID,
        type: "text",
        text,
    }
}

function userMessage(id: string, text: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SID,
            agent: "build",
            model: { providerID: "test", modelID: "model" },
            time: { created },
        } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

function assistantMessage(
    id: string,
    text: string,
    created: number,
    inputTokens: number,
    extraParts: WithParts["parts"] = [],
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SID,
            parentID: "parent",
            modelID: "model",
            providerID: "test",
            mode: "normal",
            agent: "build",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: {
                input: inputTokens,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
            },
            time: { created },
        } as WithParts["info"],
        parts: [...extraParts, textPart(id, text)],
    }
}

function toolPart(
    messageID: string,
    callID: string,
    tool: string,
    output: string,
): WithParts["parts"][number] {
    return {
        id: `part-${callID}`,
        messageID,
        sessionID: SID,
        type: "tool",
        tool,
        callID,
        state: { status: "completed", input: {}, output },
    } as WithParts["parts"][number]
}

function initializeState(messages: WithParts[]): SessionState {
    const state = createSessionState()
    state.sessionId = SID
    state.modelContextLimit = 1_000_000
    assignMessageRefs(state, messages)
    return state
}

function transformed(messages: WithParts[]): WithParts[] {
    return structuredClone(messages)
}

function messageText(message: WithParts): string {
    return message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
}

test("injectMessageIds renders stable A activity refs", () => {
    const messages = [
        userMessage("user-1", "request", 1),
        assistantMessage("assistant-1", "result", 2, 10),
    ]
    const state = initializeState(messages)

    injectMessageIds(state, buildConfig(), messages)

    assert.match(messageText(messages[0]), /<dcp-message-id[^>]*>A001<\/dcp-message-id>/)
    assert.match(messageText(messages[1]), /<dcp-message-id[^>]*>A002<\/dcp-message-id>/)
})

test("injectMessageIds appends the same A ref to every completed tool output", () => {
    const assistant = assistantMessage("assistant-1", "result", 2, 10, [
        toolPart("assistant-1", "call-1", "bash", "first"),
        toolPart("assistant-1", "call-2", "read", "second"),
    ])
    const messages = [userMessage("user-1", "request", 1), assistant]
    const state = initializeState(messages)

    injectMessageIds(state, buildConfig(), messages)

    const outputs = assistant.parts
        .filter((part) => part.type === "tool" && part.state.status === "completed")
        .map((part) => part.state.output)
    assert.equal(outputs.length, 2)
    assert.ok(outputs.every((output) => output.includes("A002")))
})

test("injectCompressNudges is inert when compression permission is denied", () => {
    const messages = [
        userMessage("user-1", "request", 1),
        assistantMessage("assistant-1", "result", 2, 100_000),
    ]
    const state = initializeState(messages)
    const config = buildConfig()
    config.compress.permission = "deny"

    const current = transformed(messages)
    injectCompressNudges(state, config, logger, current, prompts)

    assert.equal(current.length, messages.length)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, undefined)
    assert.equal(state.nudges.pendingCompression, undefined)
})

test("scheduler establishes a baseline before it requests compression", () => {
    const messages = [
        userMessage("user-1", "request", 1),
        assistantMessage("assistant-1", "result", 2, 100_000),
    ]
    const state = initializeState(messages)

    const current = transformed(messages)
    injectCompressNudges(state, buildConfig(), logger, current, prompts)

    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)
    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.equal(state.nudges.pendingCompression, undefined)
    assert.equal(current.length, messages.length)
})

test("multi-turn growth freezes a short cache-safe selection request", () => {
    const config = buildConfig()
    const raw = [
        userMessage("user-1", "initial request", 1),
        assistantMessage("assistant-1", "finished result", 2, 100_000),
        userMessage("user-2", "continue", 3),
    ]
    const state = initializeState(raw)

    const firstTurn = transformed(raw)
    injectCompressNudges(state, config, logger, firstTurn, prompts)
    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)
    assert.equal(state.nudges.pendingCompression, undefined)

    raw.push(assistantMessage("assistant-2", "recent result", 4, 103_000))
    assignMessageRefs(state, raw)
    const secondTurn = transformed(raw)
    injectCompressNudges(state, config, logger, secondTurn, prompts)
    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)
    assert.deepEqual(state.nudges.pendingCompression, {
        candidates: ["A002"],
        cacheBoundary: "A002",
        createdAtTokens: 103_000,
    })

    const request = messageText(secondTurn.at(-1)!)
    assert.match(request, /^\[ACP compression required\]/)
    assert.match(request, /Eligible blocks \(oldest first\):\nA002/)
    assert.match(request, /Cache boundary: A002/)
    assert.doesNotMatch(request, /Confirmed facts|compression philosophy|HOW TO COMPRESS/i)

    const pendingTurn = transformed(raw)
    const latestAssistant = pendingTurn.find((message) => message.info.id === "assistant-2")!
    if (latestAssistant.info.role === "assistant") latestAssistant.info.tokens.input = 106_000
    injectCompressNudges(state, config, logger, pendingTurn, prompts)
    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)
    assert.equal(messageText(pendingTurn.at(-1)!), request)
})

test("nothing eligible does not consume the growth baseline", () => {
    const config = buildConfig()
    const raw = [
        userMessage("user-1", "request", 1),
        assistantMessage("assistant-1", "recent result", 2, 103_000),
    ]
    const state = initializeState(raw)
    state.nudges.lastPerMessageNudgeTokens = 100_000

    const protectedTurn = transformed(raw)
    injectCompressNudges(state, config, logger, protectedTurn, prompts)
    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)
    assert.equal(state.nudges.pendingCompression, undefined)

    raw.push(userMessage("user-2", "next request", 3))
    assignMessageRefs(state, raw)
    const eligibleTurn = transformed(raw)
    injectCompressNudges(state, config, logger, eligibleTurn, prompts)
    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)
    assert.deepEqual(state.nudges.pendingCompression?.candidates, ["A002"])
})

test("protected tool activities never enter the pending candidate set", () => {
    const config = buildConfig()
    config.compress.protectedTools = ["skill"]
    const raw = [
        userMessage("user-1", "request", 1),
        assistantMessage("assistant-1", "protected result", 2, 100_000, [
            toolPart("assistant-1", "call-skill", "skill", "instructions"),
        ]),
        userMessage("user-2", "intermediate request", 3),
        assistantMessage("assistant-2", "ordinary result", 4, 103_000),
        userMessage("user-3", "latest request", 5),
    ]
    const state = initializeState(raw)
    state.nudges.lastPerMessageNudgeTokens = 100_000

    const current = transformed(raw)
    injectCompressNudges(state, config, logger, current, prompts)

    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.deepEqual(state.nudges.pendingCompression?.candidates, ["A003", "A004"])
    assert.ok(!state.nudges.pendingCompression?.candidates.includes("A002"))
})

test("stale pending candidates are replaced without consuming the growth baseline", () => {
    const config = buildConfig()
    const raw = [
        userMessage("user-1", "request", 1),
        assistantMessage("assistant-1", "completed result", 2, 103_000),
        userMessage("user-2", "continue", 3),
    ]
    const state = initializeState(raw)
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.nudges.pendingCompression = {
        candidates: ["A999"],
        cacheBoundary: "A999",
        createdAtTokens: 101_000,
    }

    const current = transformed(raw)
    injectCompressNudges(state, config, logger, current, prompts)

    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)
    assert.deepEqual(state.nudges.pendingCompression?.candidates, ["A002"])
})

test("activities with a missing tool member are not offered for compression", () => {
    const config = buildConfig()
    const raw = [
        userMessage("user-1", "request", 1),
        assistantMessage("assistant-1", "completed result", 2, 103_000),
        userMessage("user-2", "continue", 3),
    ]
    const state = initializeState(raw)
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.messageIds.byRawId.set("missing-tool-result", "A002")

    injectCompressNudges(state, config, logger, transformed(raw), prompts)

    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)
    assert.equal(state.nudges.pendingCompression, undefined)
})

test("protected user and tagged activities are excluded from selection", () => {
    const raw = [
        userMessage("user-1", "request", 1),
        assistantMessage("assistant-1", "first result", 2, 100_000),
        userMessage("user-2", "<protect>private constraint</protect>", 3),
        assistantMessage("assistant-2", "second result", 4, 103_000),
        userMessage("user-3", "continue", 5),
    ]

    const tagConfig = buildConfig()
    tagConfig.compress.protectTags = true
    const tagState = initializeState(raw)
    tagState.nudges.lastPerMessageNudgeTokens = 100_000
    injectCompressNudges(tagState, tagConfig, logger, transformed(raw), prompts)
    assert.deepEqual(tagState.nudges.pendingCompression?.candidates, ["A002", "A004"])

    const userConfig = buildConfig()
    userConfig.compress.protectUserMessages = true
    const userState = initializeState(raw)
    userState.nudges.lastPerMessageNudgeTokens = 100_000
    injectCompressNudges(userState, userConfig, logger, transformed(raw), prompts)
    assert.deepEqual(userState.nudges.pendingCompression?.candidates, ["A002", "A004"])
})

test("protecting one member excludes the entire tool activity", () => {
    const config = buildConfig()
    config.compress.protectedTools = ["skill"]
    const call = assistantMessage("assistant-call", "starting", 2, 100_000, [
        toolPart("assistant-call", "shared-call", "bash", "started"),
    ])
    const result = userMessage("tool-result", "result", 3)
    result.parts.push(toolPart("tool-result", "shared-call", "skill", "protected instructions"))
    const raw = [
        userMessage("user-1", "request", 1),
        call,
        result,
        assistantMessage("assistant-2", "ordinary result", 4, 103_000),
        userMessage("user-2", "continue", 5),
    ]
    const state = initializeState(raw)
    state.nudges.lastPerMessageNudgeTokens = 100_000

    injectCompressNudges(state, config, logger, transformed(raw), prompts)

    assert.equal(state.messageIds.byRawId.get("assistant-call"), "A002")
    assert.equal(state.messageIds.byRawId.get("tool-result"), "A002")
    assert.deepEqual(state.nudges.pendingCompression?.candidates, ["A003"])
})

test("recent-message protection includes visible checkpoint carriers", () => {
    const config = buildConfig()
    config.compress.preserveRecentMessages = 2
    const carrier = assistantMessage("compress-1", "checkpoint", 3, 103_000, [
        toolPart("compress-1", "compress-call-1", "compress", "created B001"),
    ])
    const raw = [
        userMessage("user-1", "request", 1),
        assistantMessage("assistant-1", "compressed source", 2, 100_000),
        carrier,
        userMessage("user-2", "continue", 4),
    ]
    const state = initializeState(raw)
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 100,
        summaryTokens: 20,
        durationMs: 0,
        topic: "checkpoint",
        startId: "A002",
        endId: "A002",
        anchorMessageId: "assistant-1",
        ref: "B001",
        tier: 1,
        compressMessageId: "compress-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["assistant-1"],
        directToolIds: [],
        effectiveMessageIds: ["assistant-1"],
        effectiveToolIds: [],
        summary: "checkpoint summary",
        createdAt: 3,
        survivedCount: 0,
        generation: "young",
    } satisfies CompressionBlock)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.byMessageId.set("assistant-1", {
        tokenCount: 10,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    injectCompressNudges(state, config, logger, transformed(raw), prompts)
    assert.equal(state.nudges.pendingCompression, undefined)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)

    config.compress.preserveRecentMessages = 1
    injectCompressNudges(state, config, logger, transformed(raw), prompts)
    assert.deepEqual(state.nudges.pendingCompression?.candidates, ["B001"])
})

test("formatMessageIdTag accepts semantic activity refs", () => {
    const tag = formatMessageIdTag("C014")
    assert.match(tag, /<dcp-message-id>C014<\/dcp-message-id>/)
})
