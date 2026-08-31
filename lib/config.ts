import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import * as jsoncParser from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"
import { VALID_CONFIG_KEYS, getInvalidConfigKeys, validateConfigTypes } from "./config-validation"
import type { LogLevel } from "./logger"

type Permission = "ask" | "allow" | "deny"

export interface CompressConfig {
    permission: Permission
    showCompression: boolean
    summaryBuffer: boolean
    maxContextLimit: number | `${number}%`
    minContextLimit: number | `${number}%`
    modelMaxLimits?: Record<string, number | `${number}%`>
    modelMinLimits?: Record<string, number | `${number}%`>
    nudgeFrequency: number
    minNudgeContextPercent: number
    nudgeGrowthTokens: number
    toolOutputNudgeThreshold?: number
    iterationNudgeThreshold: number
    nudgeForce: "strong" | "soft"
    protectedTools: string[]
    protectTags: boolean
    protectUserMessages: boolean
    maxSummaryLengthHard: number
    minCompressRange: number
    minNudgeGrowthRatio: number
    minNudgeGrowthFloor: number
    emergencyThresholdPercent: number | `${number}%`
    maxVisibleSegments: number
    keepEmbedMaxChars: number
    lastSegmentSoftBlock: boolean
    preserveRecentMessages: number
    preserveRecentTokens: number
    preserveLastUserMessage: boolean
}

export interface Commands {
    enabled: boolean
    protectedTools: string[]
}

export interface ExperimentalConfig {
    customPrompts: boolean
}

export interface BatchCleanupConfig {
    lowThreshold: number | `${number}%`
    highThreshold: number | `${number}%`
    forceThreshold: number | `${number}%`
}

export interface GCConfig {
    algorithm: "truncate"
    promotionThreshold: number
    maxBlockAge: number
    maxOldGenSummaryLength: number
    majorGcThresholdPercent: number | `${number}%`
    batchCleanup: BatchCleanupConfig
}

export interface QualityGateAlgorithmConfigs {
    [gateName: string]: unknown
}

export interface QualityGateConfig {
    enabled: boolean
    algorithm: string
    algorithms: QualityGateAlgorithmConfigs
}

export interface MessageFiltersConfig {
    enabled: boolean
    filters: Record<string, { enabled: boolean }>
}

export interface PluginConfig {
    enabled: boolean
    autoUpdate: boolean
    debug: boolean
    /** Log verbosity when `debug` is false; `debug: true` forces full debug logging. Default: "info". */
    logLevel: LogLevel
    allowSubAgents: boolean
    pruneNotification: "off" | "minimal" | "detailed"
    pruneNotificationType: "chat" | "toast"
    commands: Commands
    experimental: ExperimentalConfig
    protectedFilePatterns: string[]
    compress: CompressConfig
    gc: GCConfig
    qualityGate: QualityGateConfig
    messageFilters: MessageFiltersConfig
}

type CompressOverride = Partial<CompressConfig>

/**
 * Tools that are ALWAYS protected from compression, regardless of user config.
 * "compress" must never be compressed away — its `summary` parameter is the
 * sole record of compressed conversation. Losing it causes irreversible data
 * loss. Even if a user explicitly sets `compress.protectedTools: []`, these
 * tools are force-appended after the override.
 */
const FORCE_COMPRESS_PROTECTED: readonly string[] = ["compress"]

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "../config/acp.jsonc")

export {
    VALID_CONFIG_KEYS,
    getInvalidConfigKeys,
    validateConfigTypes,
    type ValidationError,
} from "./config-validation"

function showConfigWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, any>,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: "ACP: config warning",
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

export function mergeCompress(
    base: PluginConfig["compress"],
    override?: CompressOverride,
): PluginConfig["compress"] {
    if (!override) {
        return base
    }

    return {
        permission: override.permission ?? base.permission,
        showCompression: override.showCompression ?? base.showCompression,
        summaryBuffer: override.summaryBuffer ?? base.summaryBuffer,
        maxContextLimit: override.maxContextLimit ?? base.maxContextLimit,
        minContextLimit: override.minContextLimit ?? base.minContextLimit,
        modelMaxLimits: override.modelMaxLimits ?? base.modelMaxLimits,
        modelMinLimits: override.modelMinLimits ?? base.modelMinLimits,
        nudgeFrequency: override.nudgeFrequency ?? base.nudgeFrequency,
        minNudgeContextPercent: override.minNudgeContextPercent ?? base.minNudgeContextPercent,
        nudgeGrowthTokens: override.nudgeGrowthTokens ?? base.nudgeGrowthTokens,
        toolOutputNudgeThreshold: override.toolOutputNudgeThreshold,
        iterationNudgeThreshold: override.iterationNudgeThreshold ?? base.iterationNudgeThreshold,
        nudgeForce: override.nudgeForce ?? base.nudgeForce,
        protectedTools: Array.isArray(override.protectedTools)
            ? [...new Set([...override.protectedTools, ...FORCE_COMPRESS_PROTECTED])]
            : base.protectedTools,
        protectTags: override.protectTags ?? base.protectTags,
        protectUserMessages: override.protectUserMessages ?? base.protectUserMessages,
        maxSummaryLengthHard: override.maxSummaryLengthHard ?? base.maxSummaryLengthHard,
        minCompressRange: override.minCompressRange ?? base.minCompressRange,
        minNudgeGrowthRatio: override.minNudgeGrowthRatio ?? base.minNudgeGrowthRatio,
        minNudgeGrowthFloor: override.minNudgeGrowthFloor ?? base.minNudgeGrowthFloor,
        emergencyThresholdPercent:
            override.emergencyThresholdPercent ?? base.emergencyThresholdPercent,
        maxVisibleSegments: override.maxVisibleSegments ?? base.maxVisibleSegments,
        keepEmbedMaxChars: override.keepEmbedMaxChars ?? base.keepEmbedMaxChars,
        lastSegmentSoftBlock: override.lastSegmentSoftBlock ?? base.lastSegmentSoftBlock,
        preserveRecentMessages: override.preserveRecentMessages ?? base.preserveRecentMessages,
        preserveRecentTokens: override.preserveRecentTokens ?? base.preserveRecentTokens,
        preserveLastUserMessage: override.preserveLastUserMessage ?? base.preserveLastUserMessage,
    }
}

function readPackageConfig(): PluginConfig {
    let fileContent: string
    try {
        fileContent = readFileSync(CONFIG_PATH, "utf-8")
    } catch (error) {
        throw new Error(
            `ACP config file is required at ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
        )
    }

    let data: unknown
    data = jsoncParser.parse(fileContent, undefined, { allowTrailingComma: true })

    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error(`ACP config file must contain an object: ${CONFIG_PATH}`)
    }

    return data as PluginConfig
}

export function getBundledConfig(): PluginConfig {
    return readPackageConfig()
}

export function getConfig(ctx: PluginInput): PluginConfig {
    const configData = readPackageConfig() as Record<string, any>
    showConfigWarnings(ctx, CONFIG_PATH, configData)
    return configData as PluginConfig
}
