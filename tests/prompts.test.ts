import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createSystemPromptHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { PromptStore, type PromptKey } from "../lib/prompts/store"
import { SessionStateRegistry } from "../lib/state"

const promptFiles: Record<PromptKey, string> = {
    system: "Global system prompt",
    "compress-range": "Global compress description",
    "context-limit-nudge": "Global context limit prompt",
    "subagent-extension": "Global subagent extension",
    "decompress-extension": "Global decompress extension",
    "protected-tools": "Protected tools: {{toolList}}",
    "compression-request": "Global request {{candidates}} {{cacheBoundary}}",
}

function createPromptFixture(): { promptsDir: string; cleanup: () => void } {
    const rootDir = mkdtempSync(join(tmpdir(), "opencode-acp-prompts-"))
    const promptsDir = join(rootDir, ".config", "opencode", "acm", "prompts")
    mkdirSync(promptsDir, { recursive: true })
    for (const [key, content] of Object.entries(promptFiles)) {
        writeFileSync(join(promptsDir, `${key}.md`), `${content}\n`, "utf-8")
    }
    return {
        promptsDir,
        cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
    }
}

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "info",
        allowSubAgents: true,
        pruneNotification: "off",
        pruneNotificationType: "toast",
        commands: { enabled: true, protectedTools: [] },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: true,
            summaryBuffer: true,
            maxContextLimit: "55%",
            minContextLimit: "45%",
            minNudgeContextPercent: 5,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20_000,
            minCompressRange: 5_000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5_000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2_000,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: Number.MAX_SAFE_INTEGER,
            maxOldGenSummaryLength: 3_000,
            majorGcThresholdPercent: "100%",
            batchCleanup: {
                lowThreshold: "55%",
                highThreshold: "75%",
                forceThreshold: "90%",
            },
        },
        qualityGate: { enabled: false, algorithm: "rouge-recall-v1", algorithms: {} },
        messageFilters: { enabled: true, filters: {} },
    }
}

test("loads every runtime prompt from the global ACM prompt directory", () => {
    const fixture = createPromptFixture()
    try {
        const prompts = new PromptStore(new Logger(false), fixture.promptsDir).getRuntimePrompts()

        assert.match(prompts.system, /Global system prompt/)
        assert.equal(prompts.compressRange, promptFiles["compress-range"])
        assert.match(prompts.contextLimitNudge, /Global context limit prompt/)
        assert.equal(prompts.subagentExtension, promptFiles["subagent-extension"])
        assert.equal(prompts.decompressExtension, promptFiles["decompress-extension"])
        assert.equal(prompts.protectedToolsExtension, promptFiles["protected-tools"])
        assert.equal(prompts.compressionRequest, promptFiles["compression-request"])
    } finally {
        fixture.cleanup()
    }
})

test("reload reads prompt edits from the same global directory", () => {
    const fixture = createPromptFixture()
    try {
        const store = new PromptStore(new Logger(false), fixture.promptsDir)
        writeFileSync(
            join(fixture.promptsDir, "compression-request.md"),
            "Reloaded request {{candidates}} {{cacheBoundary}}\n",
            "utf-8",
        )

        store.reload()

        assert.match(store.getRuntimePrompts().compressionRequest, /Reloaded request/)
    } finally {
        fixture.cleanup()
    }
})

test("missing global prompt fails instead of falling back to a bundled copy", () => {
    const fixture = createPromptFixture()
    try {
        rmSync(join(fixture.promptsDir, "compression-request.md"))
        assert.throws(
            () => new PromptStore(new Logger(false), fixture.promptsDir),
            /ACP prompt file is required.*compression-request\.md/,
        )
    } finally {
        fixture.cleanup()
    }
})

test("global system prompt reaches the final system transform payload", async () => {
    const fixture = createPromptFixture()
    try {
        const logger = new Logger(false)
        const registry = new SessionStateRegistry(logger)
        const sessionId = "system-prompt-session"
        const client = { session: { get: async () => ({ data: { parentID: null } }) } }
        const config = buildConfig()
        await registry.getOrCreate(client, sessionId, [], config)
        const handler = createSystemPromptHandler(
            registry,
            logger,
            config,
            new PromptStore(logger, fixture.promptsDir),
        )
        const output = { system: ["Base system"] }

        await handler(
            {
                sessionID: sessionId,
                model: { id: "model", providerID: "provider", limit: { context: 200_000 } },
            },
            output,
        )

        assert.match(output.system[0], /^Base system/)
        assert.match(output.system[0], /Global system prompt/)
    } finally {
        fixture.cleanup()
    }
})
