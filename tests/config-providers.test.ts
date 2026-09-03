import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
    deepCloneConfig,
    getConfig,
    getBundledConfig,
    mergeCompress,
    type CompressConfig,
    type PluginConfig,
} from "../lib/config"
import { getInvalidConfigKeys, validateConfigTypes } from "../lib/config-validation"
import {
    applyCompressOverrides,
    resolveCompressOverrides,
    resolveContextTokenLimit,
} from "../lib/messages/inject/utils"

const base: CompressConfig = {
    permission: "allow",
    showCompression: true,
    summaryBuffer: true,
    maxContextLimit: "55%",
    minContextLimit: "45%",
    minNudgeContextPercent: 15,
    nudgeGrowthTokens: 50_000,
    toolOutputNudgeThreshold: 20_000,
    nudgeForce: "soft",
    protectedTools: [],
    protectTags: false,
    protectUserMessages: false,
    maxSummaryLengthHard: 20000,
    minCompressRange: 2000,
    emergencyThresholdPercent: "98%",
    maxVisibleSegments: 50,
    keepEmbedMaxChars: 2000,
    lastSegmentSoftBlock: true,
    preserveRecentMessages: 5,
    preserveRecentTokens: 5000,
    preserveLastUserMessage: true,
}

test("bundled config is the source of semantic defaults", () => {
    const bundled = getBundledConfig()

    assert.equal(bundled.compress.minNudgeContextPercent, 5)
    assert.equal(bundled.compress.nudgeGrowthTokens, 50_000)
    assert.equal(bundled.compress.protectedTools.includes("compress"), true)
})

test("mergeCompress inherits omitted optional nudge fields", () => {
    const merged = mergeCompress(base, { minNudgeContextPercent: 10 })

    assert.equal(merged.nudgeGrowthTokens, 50_000)
    assert.equal(merged.toolOutputNudgeThreshold, 20_000)
})

test("mergeCompress preserves explicit false and zero values", () => {
    const merged = mergeCompress(base, {
        showCompression: false,
        protectTags: true,
        minNudgeContextPercent: 0,
        toolOutputNudgeThreshold: 0,
        preserveRecentMessages: 0,
    })

    assert.equal(merged.showCompression, false)
    assert.equal(merged.protectTags, true)
    assert.equal(merged.minNudgeContextPercent, 0)
    assert.equal(merged.toolOutputNudgeThreshold, 0)
    assert.equal(merged.preserveRecentMessages, 0)
})

test("getConfig layers ACM global and nearest project overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "acp-config-"))
    const globalHome = join(root, "global-home")
    const globalDir = join(globalHome, ".config", "opencode", "acm")
    const configDir = join(root, "config-dir")
    const xdgConfigHome = join(root, "xdg-config-home")
    const projectRoot = join(root, "project")
    const projectDirectory = join(projectRoot, "src")
    const projectConfigDir = join(projectRoot, ".opencode")
    mkdirSync(globalDir, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    mkdirSync(join(xdgConfigHome, "opencode"), { recursive: true })
    mkdirSync(projectDirectory, { recursive: true })
    mkdirSync(projectConfigDir, { recursive: true })

    writeFileSync(
        join(globalDir, "acp.jsonc"),
        JSON.stringify({
            compress: {
                showCompression: false,
                minNudgeContextPercent: 0,
                nudgeGrowthTokens: 100,
                providers: {
                    anthropic: {
                        models: { model: { minNudgeContextPercent: 9 } },
                    },
                },
            },
            gc: { batchCleanup: { lowThreshold: "60%" } },
            qualityGate: { algorithms: { custom: { one: 1 } } },
            messageFilters: { filters: { "omo-context": { enabled: false } } },
        }),
        "utf8",
    )
    writeFileSync(
        join(configDir, "acp.json"),
        JSON.stringify({
            compress: {
                nudgeGrowthTokens: 200,
                providers: {
                    anthropic: {
                        minNudgeContextPercent: 7,
                        models: { model: { nudgeGrowthTokens: 300 } },
                    },
                },
            },
            gc: { batchCleanup: { highThreshold: "80%" } },
            qualityGate: { algorithms: { custom: { two: 2 } } },
            messageFilters: { filters: { custom: { enabled: false } } },
        }),
        "utf8",
    )
    writeFileSync(
        join(xdgConfigHome, "opencode", "acp.jsonc"),
        JSON.stringify({ compress: { nudgeGrowthTokens: 400 } }),
        "utf8",
    )
    writeFileSync(
        join(projectConfigDir, "acp.jsonc"),
        JSON.stringify({
            compress: {
                providers: {
                    anthropic: { models: { model: { nudgeForce: "strong" } } },
                },
            },
            gc: { batchCleanup: { forceThreshold: "95%" } },
            qualityGate: { algorithms: { custom: { one: 3 } } },
        }),
        "utf8",
    )

    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const previousConfigHome = process.env.XDG_CONFIG_HOME
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.HOME = globalHome
    process.env.USERPROFILE = globalHome
    process.env.XDG_CONFIG_HOME = xdgConfigHome
    process.env.OPENCODE_CONFIG_DIR = configDir
    try {
        const config = getConfig({ directory: projectDirectory } as Parameters<typeof getConfig>[0])

        assert.equal(config.compress.showCompression, false)
        assert.equal(config.compress.minNudgeContextPercent, 0)
        assert.equal(config.compress.nudgeGrowthTokens, 100)
        assert.deepEqual(config.compress.providers?.anthropic, {
            models: {
                model: {
                    minNudgeContextPercent: 9,
                    nudgeForce: "strong",
                },
            },
        })
        assert.deepEqual(config.gc.batchCleanup, {
            lowThreshold: "60%",
            highThreshold: "75%",
            forceThreshold: "95%",
        })
        assert.deepEqual(config.qualityGate.algorithms.custom, { one: 3 })
        assert.equal(config.messageFilters.filters["omo-context"].enabled, false)
        assert.equal("custom" in config.messageFilters.filters, false)
    } finally {
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
        if (previousUserProfile === undefined) delete process.env.USERPROFILE
        else process.env.USERPROFILE = previousUserProfile
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousConfigHome
        if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
        rmSync(root, { recursive: true, force: true })
    }
})

// ── mergeCompress: nested providers deep-merge across config layers ──

test("providers: override layer wins when base has no providers", () => {
    const merged = mergeCompress(base, {
        providers: {
            anthropic: { models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } } },
        },
    })
    assert.deepEqual(merged.providers, {
        anthropic: { models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } } },
    })
})

test("providers: base layer preserved when override has no providers", () => {
    const baseWithProviders = {
        ...base,
        providers: { openai: { minNudgeContextPercent: 8 } },
    }
    const merged = mergeCompress(baseWithProviders, {})
    assert.deepEqual(merged.providers, { openai: { minNudgeContextPercent: 8 } })
})

test("providers: per-provider and per-model deep merge — project layer adds without wiping", () => {
    // Simulates the three-layer flow: global layer first, project layer second.
    const afterGlobal = mergeCompress(base, {
        providers: {
            anthropic: {
                minNudgeContextPercent: 8,
                models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } },
            },
        },
    })
    const afterProject = mergeCompress(afterGlobal, {
        providers: {
            openai: { minNudgeContextPercent: 6 }, // NEW provider — must not wipe anthropic
            anthropic: {
                minNudgeContextPercent: 9, // narrow the provider-level floor
                models: {
                    "claude-haiku-4-5": { minNudgeContextPercent: 4 }, // NEW model
                },
            },
        },
    })
    assert.deepEqual(afterProject.providers, {
        anthropic: {
            minNudgeContextPercent: 9,
            models: {
                "claude-sonnet-4-6": { minNudgeContextPercent: 10 }, // inherited
                "claude-haiku-4-5": { minNudgeContextPercent: 4 }, // added
            },
        },
        openai: { minNudgeContextPercent: 6 },
    })
})

test("providers: a higher layer cannot clear a provider/model it leaves unset", () => {
    const baseWithProviders = {
        ...base,
        providers: {
            anthropic: {
                minNudgeContextPercent: 8,
                models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } },
            },
        },
    }
    const merged = mergeCompress(baseWithProviders, {
        providers: { anthropic: { models: {} } },
    })
    // models: {} carries no explicit model → base models survive; the provider
    // level was not set in the override either → 8 survives.
    assert.deepEqual(merged.providers, {
        anthropic: {
            minNudgeContextPercent: 8,
            models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } },
        },
    })
})

test("providers: deepCloneConfig isolates the nested maps", () => {
    const config: PluginConfig = {
        enabled: true,
        autoUpdate: true,
        debug: false,
        logLevel: "info",
        allowSubAgents: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        protectedFilePatterns: [],
        compress: {
            ...base,
            providers: {
                anthropic: {
                    protectedTools: ["provider-tool"],
                    minNudgeContextPercent: 8,
                    models: {
                        "claude-sonnet-4-6": {
                            minNudgeContextPercent: 10,
                            protectedTools: ["model-tool"],
                        },
                    },
                },
            },
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: {
            enabled: false,
            algorithm: "rouge-recall-v1",
            algorithms: {},
        },
        messageFilters: {
            enabled: false,
            filters: {},
        },
    }
    const clone = deepCloneConfig(config)
    // Mutate every nested level of the clone.
    clone.compress.providers!.anthropic.minNudgeContextPercent = 99
    clone.compress.providers!.anthropic.models!["claude-sonnet-4-6"]!.minNudgeContextPercent = 99
    clone.compress.providers!.openai = { minNudgeContextPercent: 99 }
    clone.compress.providers!.anthropic.protectedTools!.push("clone-provider-tool")
    clone.compress.providers!.anthropic.models!["claude-sonnet-4-6"]!.protectedTools!.push(
        "clone-model-tool",
    )
    // The original is untouched.
    assert.equal(config.compress.providers!.anthropic.minNudgeContextPercent, 8)
    assert.equal(
        config.compress.providers!.anthropic.models!["claude-sonnet-4-6"]!.minNudgeContextPercent,
        10,
    )
    assert.deepEqual(config.compress.providers!.anthropic.protectedTools, ["provider-tool"])
    assert.deepEqual(
        config.compress.providers!.anthropic.models!["claude-sonnet-4-6"]!.protectedTools,
        ["model-tool"],
    )
    assert.equal(config.compress.providers.openai, undefined)
})

// ── validation: structure + typo safety ──

test("providers: valid nested config passes validation and key walking", () => {
    const userConfig = {
        compress: {
            providers: {
                anthropic: {
                    minNudgeContextPercent: 8,
                    models: { "claude-sonnet-4-6": { minNudgeContextPercent: 10 } },
                },
            },
        },
    }
    assert.deepEqual(getInvalidConfigKeys(userConfig), [])
    const errors = validateConfigTypes(userConfig)
    assert.deepEqual(errors, [])
})

test("providers: rejects non-object providers / provider / models entries", () => {
    assert.deepEqual(
        validateConfigTypes({ compress: { providers: "nope" } }).map((e) => e.key),
        ["compress.providers"],
    )
    assert.deepEqual(
        validateConfigTypes({ compress: { providers: { anthropic: 5 } } }).map((e) => e.key),
        ["compress.providers.anthropic"],
    )
    assert.deepEqual(
        validateConfigTypes({ compress: { providers: { anthropic: { models: 5 } } } }).map(
            (e) => e.key,
        ),
        ["compress.providers.anthropic.models"],
    )
    assert.deepEqual(
        validateConfigTypes({
            compress: { providers: { anthropic: { models: { "claude-x": 5 } } } },
        }).map((e) => e.key),
        ["compress.providers.anthropic.models.claude-x"],
    )
})

test("providers: rejects out-of-range / non-number percent values", () => {
    const keys = (providers: unknown) =>
        validateConfigTypes({ compress: { providers } }).map((e) => e.key)
    assert.deepEqual(keys({ anthropic: { minNudgeContextPercent: -1 } }), [
        "compress.providers.anthropic.minNudgeContextPercent",
    ])
    assert.deepEqual(keys({ anthropic: { minNudgeContextPercent: 101 } }), [
        "compress.providers.anthropic.minNudgeContextPercent",
    ])
    assert.deepEqual(keys({ anthropic: { minNudgeContextPercent: "30%" } }), [
        "compress.providers.anthropic.minNudgeContextPercent",
    ])
    assert.deepEqual(keys({ anthropic: { models: { m: { minNudgeContextPercent: 150 } } } }), [
        "compress.providers.anthropic.models.m.minNudgeContextPercent",
    ])
    // Boundary values are valid: 0 disables the floor, 100 clamps at the window.
    assert.deepEqual(keys({ anthropic: { models: { m: { minNudgeContextPercent: 0 } } } }), [])
    assert.deepEqual(keys({ anthropic: { models: { m: { minNudgeContextPercent: 100 } } } }), [])
})

test("providers: unknown fields are rejected (typo safety)", () => {
    assert.deepEqual(
        validateConfigTypes({
            compress: { providers: { anthropic: { minNudgeContextPecent: 10 } } },
        }).map((e) => e.key),
        ["compress.providers.anthropic.minNudgeContextPecent"],
    )
    assert.deepEqual(
        validateConfigTypes({
            compress: { providers: { anthropic: { models: { m: { floor: 10 } } } } },
        }).map((e) => e.key),
        ["compress.providers.anthropic.models.m.floor"],
    )
})

// ── all-field cascade: resolveCompressOverrides / applyCompressOverrides ──

const pluginConfig = (compress: CompressConfig) =>
    ({ compress }) as Parameters<typeof resolveCompressOverrides>[0]

test("all-field cascade: provider fields apply to every field, model fields win per field", () => {
    const config = pluginConfig({
        ...base,
        providers: {
            anthropic: {
                minNudgeContextPercent: 8,
                nudgeForce: "strong",
                models: {
                    "claude-sonnet-4-6": { summaryBuffer: false },
                },
            },
        },
    })
    // Model level: model wins on summaryBuffer, inherits provider on the rest.
    assert.deepEqual(resolveCompressOverrides(config, "anthropic", "claude-sonnet-4-6"), {
        minNudgeContextPercent: 8,
        nudgeForce: "strong",
        summaryBuffer: false,
    })
    // Sibling model: provider fields only.
    assert.deepEqual(resolveCompressOverrides(config, "anthropic", "claude-haiku-4-5"), {
        minNudgeContextPercent: 8,
        nudgeForce: "strong",
    })
    // Unknown provider / no provider id: no overrides at all.
    assert.deepEqual(resolveCompressOverrides(config, "openai", "gpt-5"), {})
    assert.deepEqual(resolveCompressOverrides(config, undefined, "claude-sonnet-4-6"), {})
})

test("all-field cascade: applyCompressOverrides is identity when nothing applies", () => {
    const config = pluginConfig({
        ...base,
        providers: { anthropic: { minNudgeContextPercent: 8 } },
    })
    // Unknown provider → same reference, zero allocation.
    assert.equal(applyCompressOverrides(config, "openai", "gpt-5"), config)
    assert.equal(applyCompressOverrides(config, undefined), config)
})

test("all-field cascade: applyCompressOverrides swaps fields but never maxContextLimit", () => {
    const config = pluginConfig({
        ...base,
        maxContextLimit: "55%",
        providers: {
            anthropic: {
                maxContextLimit: "30%", // must NOT be blanket-applied (explicit path below)
                protectedTools: ["skill", "task"],
                models: { "claude-sonnet-4-6": { nudgeGrowthTokens: 10000 } },
            },
        },
    })
    const applied = applyCompressOverrides(config, "anthropic", "claude-sonnet-4-6")
    assert.notEqual(applied, config)
    assert.deepEqual(applied.compress.protectedTools, ["skill", "task"])
    assert.equal(applied.compress.nudgeGrowthTokens, 10000)
    // maxContextLimit is excluded from the blanket swap — it flows through
    // resolveContextTokenLimit's explicit precedence chain instead.
    assert.equal(applied.compress.maxContextLimit, "55%")
    // The input config is never mutated.
    assert.equal(config.compress.nudgeGrowthTokens, 50_000)
})

test("all-field cascade: nested maxContextLimit beats the flat modelMaxLimits map", () => {
    const config = pluginConfig({
        ...base,
        maxContextLimit: "55%",
        modelMaxLimits: {
            "anthropic/claude-sonnet-4-6": 400000,
            "anthropic/claude-haiku-4-5": 300000,
        },
        providers: {
            anthropic: {
                models: { "claude-sonnet-4-6": { maxContextLimit: 250000 } },
            },
        },
    })
    const state = { modelContextLimit: 1000000 } as Parameters<typeof resolveContextTokenLimit>[1]
    assert.equal(
        resolveContextTokenLimit(config, state, "anthropic", "claude-sonnet-4-6", "max"),
        250000,
    )
    // A sibling model still uses the flat map; an unknown model uses the global.
    assert.equal(
        resolveContextTokenLimit(config, state, "anthropic", "claude-haiku-4-5", "max"),
        300000,
    )
    assert.equal(resolveContextTokenLimit(config, state, "openai", "gpt-5", "max"), 550000)
})

// ── validation: multi-field override values ──

test("providers: multi-field validation accepts every overridable field type", () => {
    const userConfig = {
        compress: {
            providers: {
                anthropic: {
                    showCompression: true,
                    summaryBuffer: false,
                    protectTags: true,
                    protectUserMessages: false,
                    lastSegmentSoftBlock: false,
                    preserveLastUserMessage: false,
                    maxContextLimit: "60%",
                    emergencyThresholdPercent: "95%",
                    minNudgeContextPercent: 7,
                    toolOutputNudgeThreshold: 8000,
                    nudgeGrowthTokens: 40000,
                    minNudgeGrowthRatio: 0.5,
                    minNudgeGrowthFloor: 6000,
                    nudgeForce: "strong",
                    protectedTools: ["skill", "mcp_*"],
                    maxSummaryLengthHard: 15000,
                    minCompressRange: 1000,
                    maxVisibleSegments: 40,
                    keepEmbedMaxChars: 3000,
                    preserveRecentMessages: 30,
                    preserveRecentTokens: 25000,
                    models: {
                        "claude-sonnet-4-6": { nudgeForce: "soft" },
                    },
                },
            },
        },
    }
    assert.deepEqual(getInvalidConfigKeys(userConfig), [])
    assert.deepEqual(validateConfigTypes(userConfig), [])
})

test("providers: multi-field validation rejects wrong-typed values at both levels", () => {
    const keys = (providers: unknown) =>
        validateConfigTypes({ compress: { providers } }).map((e) => e.key)
    // Provider level.
    assert.deepEqual(keys({ anthropic: { nudgeForce: "hard" } }), [
        "compress.providers.anthropic.nudgeForce",
    ])
    assert.deepEqual(keys({ anthropic: { protectedTools: "skill" } }), [
        "compress.providers.anthropic.protectedTools",
    ])
    assert.deepEqual(keys({ anthropic: { protectedTools: ["ok", 5] } }), [
        "compress.providers.anthropic.protectedTools",
    ])
    assert.deepEqual(keys({ anthropic: { nudgeGrowthTokens: -1 } }), [
        "compress.providers.anthropic.nudgeGrowthTokens",
    ])
    assert.deepEqual(keys({ anthropic: { showCompression: "yes" } }), [
        "compress.providers.anthropic.showCompression",
    ])
    assert.deepEqual(keys({ anthropic: { maxContextLimit: "abc" } }), [
        "compress.providers.anthropic.maxContextLimit",
    ])
    // Model level.
    assert.deepEqual(keys({ anthropic: { models: { m: { nudgeForce: "HARD" } } } }), [
        "compress.providers.anthropic.models.m.nudgeForce",
    ])
    assert.deepEqual(keys({ anthropic: { models: { m: { summaryBuffer: 1 } } } }), [
        "compress.providers.anthropic.models.m.summaryBuffer",
    ])
    // Structural fields stay non-overridable.
    assert.deepEqual(keys({ anthropic: { permission: "ask" } }), [
        "compress.providers.anthropic.permission",
    ])
    assert.deepEqual(keys({ anthropic: { models: { m: { providers: {} } } } }), [
        "compress.providers.anthropic.models.m.providers",
    ])
})
