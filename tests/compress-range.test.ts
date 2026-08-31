import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginConfig } from "../lib/config"
import { createCompressRangeTool } from "../lib/compress/range"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import type { RuntimePrompts } from "../lib/prompts/store"
import { createSessionState, type WithParts } from "../lib/state"
import { singletonRegistry } from "./registry-stub"

const dataHome = join(tmpdir(), `opencode-acp-selection-tests-${process.pid}`)
process.env.XDG_DATA_HOME = dataHome
mkdirSync(dataHome, { recursive: true })

function config(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: true, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            lastSegmentSoftBlock: false,
            minCompressRange: 0,
            maxSummaryLengthHard: 5000,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: {
                lowThreshold: "60%",
                highThreshold: "75%",
                forceThreshold: "90%",
            },
        },
    } as PluginConfig
}

function message(
    sessionID: string,
    id: string,
    role: "user" | "assistant",
    text: string,
    created: number,
    inputTokens = 0,
): WithParts {
    return {
        info: {
            id,
            sessionID,
            role,
            time: { created },
            ...(role === "user"
                ? {
                      agent: "build",
                      model: { providerID: "test", modelID: "model" },
                  }
                : {
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
                  }),
        } as any,
        parts: [
            {
                id: `part-${id}`,
                messageID: id,
                sessionID,
                type: "text",
                text,
            },
        ],
    }
}

function setup(rawMessages: WithParts[], pluginConfig = config()) {
    const sessionID = rawMessages[0].info.sessionID
    const state = createSessionState()
    state.sessionId = sessionID
    const logger = new Logger(false)
    const compress = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        registry: singletonRegistry(state),
        logger,
        config: pluginConfig,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "Select blocks" }
            },
        },
    } as any)
    return { state, compress, sessionID, pluginConfig }
}

function toolContext(sessionID: string, messageID: string, callID: string) {
    return {
        ask: async () => {},
        metadata: () => {},
        sessionID,
        messageID,
        callID,
    }
}

test("compresses the complement of keep into one B checkpoint", async () => {
    const sessionID = `selection-complement-${Date.now()}`
    const messages = [
        message(sessionID, "user-1", "user", "request", 1),
        message(sessionID, "assistant-1", "assistant", "finished result one", 2),
        message(sessionID, "assistant-2", "assistant", "finished result two", 3),
        message(sessionID, "user-2", "user", "continue", 4),
    ]
    const { state, compress } = setup(messages)
    state.nudges.pendingCompression = {
        candidates: ["A002", "A003"],
        cacheBoundary: "A003",
    }

    const result = await compress.execute(
        {
            keep: ["A003"],
            confirmedFacts: ["Result one is complete."],
            nextSteps: ["Continue from result two."],
        },
        toolContext(sessionID, "compress-1", "call-1"),
    )

    assert.match(result, /into B001; kept 1/)
    assert.equal(state.nudges.pendingCompression, undefined)
    const block = state.prune.messages.blocksById.get(1)
    assert.equal(block?.ref, "B001")
    assert.deepEqual(block?.directMessageIds, ["assistant-1"])
    assert.equal(state.prune.messages.byMessageId.has("assistant-2"), false)
    assert.match(block?.summary ?? "", /Result one is complete/)
})

test("compresses every message in a tool activity atomically", async () => {
    const sessionID = `selection-tool-activity-${Date.now()}`
    const call = message(sessionID, "assistant-call", "assistant", "calling tool", 2)
    call.parts.push({
        type: "tool",
        tool: "bash",
        callID: "tool-call-1",
        state: { status: "running", input: { command: "pwd" } },
    } as WithParts["parts"][number])
    const result = message(sessionID, "tool-result", "user", "tool result", 3)
    result.parts.push({
        type: "tool",
        tool: "bash",
        callID: "tool-call-1",
        state: { status: "completed", input: { command: "pwd" }, output: "/workspace" },
    } as WithParts["parts"][number])
    const messages = [
        message(sessionID, "user-1", "user", "request", 1),
        call,
        result,
        message(sessionID, "user-2", "user", "continue", 4),
    ]
    const { state, compress } = setup(messages)
    state.nudges.pendingCompression = { candidates: ["A002"], cacheBoundary: "A002" }

    await compress.execute(
        { keep: [], confirmedFacts: ["The tool activity completed."], nextSteps: [] },
        toolContext(sessionID, "compress-1", "compress-call-1"),
    )

    assert.deepEqual(state.prune.messages.blocksById.get(1)?.directMessageIds, [
        "assistant-call",
        "tool-result",
    ])
})

test("rejects a tool activity when one mapped member is missing", async () => {
    const sessionID = `selection-stale-tool-activity-${Date.now()}`
    const call = message(sessionID, "assistant-call", "assistant", "calling tool", 2)
    call.parts.push({
        type: "tool",
        tool: "bash",
        callID: "tool-call-1",
        state: { status: "running", input: { command: "pwd" } },
    } as WithParts["parts"][number])
    const result = message(sessionID, "tool-result", "user", "tool result", 3)
    result.parts.push({
        type: "tool",
        tool: "bash",
        callID: "tool-call-1",
        state: { status: "completed", input: { command: "pwd" }, output: "/workspace" },
    } as WithParts["parts"][number])
    const messages = [
        message(sessionID, "user-1", "user", "request", 1),
        call,
        result,
        message(sessionID, "user-2", "user", "continue", 4),
    ]
    const { state, compress } = setup(messages)
    assignMessageRefs(state, messages)
    messages.splice(2, 1)
    state.nudges.pendingCompression = { candidates: ["A002"], cacheBoundary: "A002" }

    await assert.rejects(
        compress.execute(
            { keep: [], confirmedFacts: ["The tool call is complete."], nextSteps: [] },
            toolContext(sessionID, "compress-1", "compress-call-1"),
        ),
        /Pending block A002 is stale/,
    )
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.deepEqual(state.nudges.pendingCompression?.candidates, ["A002"])
})

test("keeping every candidate is a valid no-op and resets the growth baseline", async () => {
    const sessionID = `selection-keep-all-${Date.now()}`
    const messages = [
        message(sessionID, "user-1", "user", "request", 1),
        message(sessionID, "assistant-1", "assistant", "result", 2),
        message(sessionID, "user-2", "user", "continue", 3),
    ]
    const { state, compress } = setup(messages)
    state.nudges.pendingCompression = { candidates: ["A002"], cacheBoundary: "A002" }

    const result = await compress.execute(
        { keep: ["A002"], confirmedFacts: [], nextSteps: [] },
        toolContext(sessionID, "compress-1", "call-1"),
    )
    assert.match(result, /Kept every candidate block/)
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.nudges.pendingCompression, undefined)
    assert.equal(typeof state.nudges.lastPerMessageNudgeTokens, "number")
})

test("keep-all restores pending state when persistence fails", async () => {
    const sessionID = `selection-keep-all-save-failure-${Date.now()}`
    const messages = [
        message(sessionID, "user-1", "user", "request", 1),
        message(sessionID, "assistant-1", "assistant", "result", 2),
        message(sessionID, "user-2", "user", "continue", 3),
    ]
    const { state, compress } = setup(messages)
    state.nudges.pendingCompression = { candidates: ["A002"], cacheBoundary: "A002" }
    state.nudges.lastPerMessageNudgeTokens = 100_000
    const previousDataHome = process.env.XDG_DATA_HOME
    const invalidDataHome = join(dataHome, `not-a-directory-${sessionID}`)
    writeFileSync(invalidDataHome, "")
    process.env.XDG_DATA_HOME = invalidDataHome

    try {
        await assert.rejects(
            compress.execute(
                { keep: ["A002"], confirmedFacts: [], nextSteps: [] },
                toolContext(sessionID, "compress-1", "call-1"),
            ),
        )
    } finally {
        process.env.XDG_DATA_HOME = previousDataHome
    }

    assert.deepEqual(state.nudges.pendingCompression?.candidates, ["A002"])
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)
})

test("notification failure after persistence does not roll back the committed checkpoint", async () => {
    const sessionID = `selection-notification-failure-${Date.now()}`
    const messages = [
        message(sessionID, "user-1", "user", "request", 1),
        message(sessionID, "assistant-1", "assistant", "result", 2),
        message(sessionID, "user-2", "user", "continue", 3),
    ]
    const pluginConfig = config()
    pluginConfig.pruneNotification = "minimal"
    const { state, compress } = setup(messages, pluginConfig)
    state.nudges.pendingCompression = { candidates: ["A002"], cacheBoundary: "A002" }

    const result = await compress.execute(
        { keep: [], confirmedFacts: ["Result complete."], nextSteps: [] },
        toolContext(sessionID, "compress-1", "call-1"),
    )

    assert.match(result, /into B001/)
    assert.equal(state.prune.messages.blocksById.get(1)?.active, true)
    assert.equal(state.nudges.pendingCompression, undefined)
})

test("unknown or duplicate keep refs are rejected without clearing pending state", async () => {
    const sessionID = `selection-invalid-${Date.now()}`
    const messages = [
        message(sessionID, "user-1", "user", "request", 1),
        message(sessionID, "assistant-1", "assistant", "result", 2),
    ]
    const { state, compress } = setup(messages)
    state.nudges.pendingCompression = { candidates: ["A002"], cacheBoundary: "A002" }

    await assert.rejects(
        compress.execute(
            { keep: ["A999"], confirmedFacts: [], nextSteps: [] },
            toolContext(sessionID, "compress-1", "call-1"),
        ),
        /outside the pending candidate set/,
    )
    assert.deepEqual(state.nudges.pendingCompression?.candidates, ["A002"])

    await assert.rejects(
        compress.execute(
            { keep: ["A002", "A002"], confirmedFacts: [], nextSteps: [] },
            toolContext(sessionID, "compress-2", "call-2"),
        ),
        /duplicate block IDs/,
    )
    assert.deepEqual(state.nudges.pendingCompression?.candidates, ["A002"])
})

test("compressing an active B checkpoint creates C", async () => {
    const sessionID = `selection-generation-${Date.now()}`
    const messages = [
        message(sessionID, "user-1", "user", "request", 1),
        message(sessionID, "assistant-1", "assistant", "old result", 2),
        message(sessionID, "assistant-2", "assistant", "new result", 3),
        message(sessionID, "user-2", "user", "continue", 4),
    ]
    const { state, compress } = setup(messages)
    state.nudges.pendingCompression = { candidates: ["A002"], cacheBoundary: "A002" }
    await compress.execute(
        { keep: [], confirmedFacts: ["Old result complete."], nextSteps: [] },
        toolContext(sessionID, "compress-1", "call-1"),
    )

    state.nudges.pendingCompression = {
        candidates: ["B001", "A003"],
        cacheBoundary: "A003",
    }
    const result = await compress.execute(
        {
            keep: [],
            confirmedFacts: ["Both results are complete."],
            nextSteps: ["Finish verification."],
        },
        toolContext(sessionID, "compress-2", "call-2"),
    )

    assert.match(result, /into C002/)
    assert.equal(state.prune.messages.blocksById.get(1)?.active, false)
    assert.equal(state.prune.messages.blocksById.get(2)?.ref, "C002")
    assert.deepEqual(state.prune.messages.blocksById.get(2)?.consumedBlockIds, [1])
})

test("growth cycle requests compression again after a checkpoint resets the baseline", async () => {
    const baseTime = Date.now() - 10_000
    const sessionID = `selection-growth-cycle-${Date.now()}`
    const messages = [
        message(sessionID, "user-1", "user", "initial request", baseTime + 1),
        message(sessionID, "assistant-1", "assistant", "finished result", baseTime + 2, 100_000),
        message(sessionID, "user-2", "user", "continue", baseTime + 3),
    ]
    const pluginConfig = config()
    Object.assign(pluginConfig.compress, {
        summaryBuffer: false,
        maxContextLimit: 900_000,
        minContextLimit: 0,
        nudgeGrowthTokens: 2_000,
        minNudgeContextPercent: 0,
        minNudgeGrowthRatio: 0,
        minNudgeGrowthFloor: 100,
        lastSegmentSoftBlock: true,
        preserveRecentMessages: 1,
        preserveRecentTokens: 0,
    })
    const { state, compress } = setup(messages, pluginConfig)
    state.modelContextLimit = 1_000_000
    assignMessageRefs(state, messages)

    const firstTurn = structuredClone(messages)
    injectCompressNudges(state, pluginConfig, new Logger(false), firstTurn, {} as RuntimePrompts)
    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)

    messages.push(
        message(sessionID, "assistant-2", "assistant", "recent result", baseTime + 4, 103_000),
    )
    assignMessageRefs(state, messages)
    const growthTurn = structuredClone(messages)
    injectCompressNudges(state, pluginConfig, new Logger(false), growthTurn, {} as RuntimePrompts)
    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.deepEqual(state.nudges.pendingCompression?.candidates, ["A002"])
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000)

    await compress.execute(
        {
            keep: [],
            confirmedFacts: ["The initial result is complete."],
            nextSteps: ["Continue with the recent result."],
        },
        toolContext(sessionID, "compress-message-1", "compress-call-1"),
    )
    assert.equal(state.nudges.pendingCompression, undefined)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 103_000)
    assert.equal(state.prune.messages.blocksById.get(1)?.ref, "B001")

    const afterCompression = Date.now() + 1
    messages.push(
        {
            info: {
                id: "compress-message-1",
                sessionID,
                role: "assistant",
                time: { created: afterCompression - 1 },
            },
            parts: [
                {
                    type: "tool",
                    tool: "compress",
                    callID: "compress-call-1",
                    state: {
                        status: "completed",
                        input: {
                            keep: [],
                            confirmedFacts: ["The initial result is complete."],
                            nextSteps: ["Continue with the recent result."],
                        },
                        output: "Created checkpoint B001",
                    },
                },
            ],
        } as WithParts,
        message(sessionID, "user-3", "user", "next task", afterCompression),
        message(
            sessionID,
            "assistant-3",
            "assistant",
            "small continuation",
            afterCompression + 1,
            104_000,
        ),
        message(sessionID, "user-4", "user", "continue again", afterCompression + 2),
    )
    assignMessageRefs(state, messages)
    const belowGrowth = structuredClone(messages)
    injectCompressNudges(state, pluginConfig, new Logger(false), belowGrowth, {} as RuntimePrompts)
    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 103_000)
    assert.equal(state.nudges.pendingCompression, undefined)

    messages.push(
        message(
            sessionID,
            "assistant-4",
            "assistant",
            "more completed work",
            afterCompression + 3,
            106_000,
        ),
    )
    assignMessageRefs(state, messages)
    const secondGrowth = structuredClone(messages)
    injectCompressNudges(state, pluginConfig, new Logger(false), secondGrowth, {} as RuntimePrompts)
    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 103_000)
    assert.ok(state.nudges.pendingCompression?.candidates.includes("B001"))
})
