import assert from "node:assert/strict"
import test from "node:test"
import { evaluatePreCommitQuality } from "../lib/compress/quality-gate"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import type { WithParts } from "../lib/state"

function buildConfig(qualityGateEnabled: boolean): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        allowSubAgents: true,
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            minNudgeContextPercent: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20000,
            minCompressRange: 0,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: qualityGateEnabled
            ? {
                  enabled: true,
                  algorithm: "rouge-recall-v1",
                  algorithms: {
                      "rouge-recall-v1": {
                          layer1MinChars: 200,
                          layer1MinRetentionPct: 5.0,
                          layer2MaxRougeF1: 0.05,
                          layer2MaxTop20Recall: 0.2,
                      },
                  },
              }
            : { enabled: false, algorithm: "rouge-recall-v1" },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return { id, messageID, sessionID, type: "text" as const, text }
}

function buildLargeMessages(sessionID: string): WithParts[] {
    const messages: WithParts[] = []
    for (let i = 0; i < 5; i++) {
        const msgId = `msg-large-${i}`
        messages.push({
            info: {
                id: msgId,
                role: i % 2 === 0 ? "user" : "assistant",
                sessionID,
                time: { created: i + 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    msgId,
                    sessionID,
                    `part-${i}`,
                    `This is a detailed message about authentication system design. ` +
                        `The file path is lib/auth.ts at line ${i * 10}. ` +
                        `We found a critical bug where the token refresh logic was broken. ` +
                        `The fix involved adding a retry mechanism with exponential backoff. ` +
                        `Key decision: use JWT over session cookies for stateless architecture.`,
                ),
            ],
        })
    }
    return messages
}

function buildTokenMap(messageIds: string[], tokensPerMessage: number): Map<string, number> {
    const map = new Map<string, number>()
    for (const id of messageIds) map.set(id, tokensPerMessage)
    return map
}

const logger = new Logger(false)

test("evaluatePreCommitQuality returns null when quality gate disabled", () => {
    const config = buildConfig(false)
    const result = evaluatePreCommitQuality(
        [],
        ["msg-1"],
        buildTokenMap(["msg-1"], 100),
        "short",
        config,
        logger,
    )
    assert.equal(result, null)
})

test("evaluatePreCommitQuality rejects summary with extremely low retention (L1)", () => {
    const sessionID = "ses-test-l1"
    const rawMessages = buildLargeMessages(sessionID)
    const messageIds = rawMessages.map((m) => m.info.id)
    const messageTokenById = buildTokenMap(messageIds, 300)

    const result = evaluatePreCommitQuality(
        rawMessages,
        messageIds,
        messageTokenById,
        "Too short.",
        buildConfig(true),
        logger,
    )

    assert.ok(result, "should return a result")
    assert.equal(result!.passed, false)
    assert.equal(result!.layer, "L1-length")
})

test("evaluatePreCommitQuality passes summary with adequate retention and keyword overlap", () => {
    const sessionID = "ses-test-pass"
    const rawMessages = buildLargeMessages(sessionID)
    const messageIds = rawMessages.map((m) => m.info.id)
    const messageTokenById = buildTokenMap(messageIds, 50)

    const goodSummary =
        `Authentication system design analysis. ` +
        `File: lib/auth.ts. Found critical bug in token refresh logic. ` +
        `Fix: retry mechanism with exponential backoff. ` +
        `Decision: JWT over session cookies for stateless architecture. ` +
        `Key details preserved for downstream work.`

    const result = evaluatePreCommitQuality(
        rawMessages,
        messageIds,
        messageTokenById,
        goodSummary,
        buildConfig(true),
        logger,
    )

    assert.ok(result, "should return a result")
    assert.equal(result!.passed, true)
})

test("evaluatePreCommitQuality returns null for empty messageIds", () => {
    const result = evaluatePreCommitQuality(
        buildLargeMessages("ses"),
        [],
        new Map(),
        "summary",
        buildConfig(true),
        logger,
    )
    assert.equal(result, null)
})

test("evaluatePreCommitQuality returns null when no chunks can be extracted", () => {
    const result = evaluatePreCommitQuality(
        [],
        ["msg-nonexistent"],
        buildTokenMap(["msg-nonexistent"], 100),
        "summary",
        buildConfig(true),
        logger,
    )
    assert.equal(result, null)
})
