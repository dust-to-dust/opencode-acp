import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import * as jsoncParser from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"
import { getInvalidConfigKeys, validateConfigTypes, VALID_CONFIG_KEYS } from "./config-validation"
import type { LogLevel } from "./logger"

type Permission = "ask" | "allow" | "deny"
type Limit = number | `${number}%`

export interface CompressConfig {
    permission: Permission
    showCompression: boolean
    summaryBuffer: boolean
    maxContextLimit: Limit
    /** @deprecated Still honored for turn/iteration reminder nudges. */
    minContextLimit: Limit
    modelMaxLimits?: Record<string, Limit>
    /** @deprecated Still honored alongside `minContextLimit`. */
    modelMinLimits?: Record<string, Limit>
    /** Nested per-provider / per-model overrides, resolved field-by-field. */
    providers?: Record<string, CompressProviderOverrides>
    nudgeFrequency: number
    minNudgeContextPercent: number
    nudgeGrowthTokens?: number
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
    emergencyThresholdPercent: Limit
    maxVisibleSegments: number
    keepEmbedMaxChars: number
    lastSegmentSoftBlock?: boolean
    /** Protect the last N visible messages from compression (default: 20). */
    preserveRecentMessages?: number
    /** Protect the last ~N tokens of visible messages (default: 20000). */
    preserveRecentTokens?: number
    /** Always protect the most recent user message (default: true). */
    preserveLastUserMessage?: boolean
}

export type CompressOverridableConfig = Omit<
    CompressConfig,
    "permission" | "minContextLimit" | "modelMaxLimits" | "modelMinLimits" | "providers"
>

export type CompressModelOverrides = Partial<CompressOverridableConfig>

export interface CompressProviderOverrides extends CompressModelOverrides {
    models?: Record<string, CompressModelOverrides>
}

export interface Commands {
    enabled: boolean
    protectedTools: string[]
}

export interface ExperimentalConfig {
    customPrompts: boolean
}

export interface BatchCleanupConfig {
    lowThreshold: Limit
    highThreshold: Limit
    forceThreshold: Limit
}

export interface GCConfig {
    algorithm: "truncate"
    promotionThreshold: number
    maxBlockAge: number
    maxOldGenSummaryLength: number
    majorGcThresholdPercent: Limit
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
type CommandsOverride = Partial<Commands>
type ExperimentalOverride = Partial<ExperimentalConfig> & { allowSubAgents?: boolean }
type GCOverride = Partial<Omit<GCConfig, "batchCleanup">> & {
    batchCleanup?: Partial<BatchCleanupConfig>
}
type QualityGateOverride = Partial<Omit<QualityGateConfig, "algorithms">> & {
    algorithms?: QualityGateAlgorithmConfigs
}
type MessageFiltersOverride = Partial<Omit<MessageFiltersConfig, "filters">> & {
    filters?: Record<string, { enabled?: boolean }>
}

interface ConfigLayer extends Record<string, unknown> {
    enabled?: boolean
    autoUpdate?: boolean
    debug?: boolean
    logLevel?: LogLevel
    allowSubAgents?: boolean
    pruneNotification?: PluginConfig["pruneNotification"]
    pruneNotificationType?: PluginConfig["pruneNotificationType"]
    commands?: CommandsOverride
    experimental?: ExperimentalOverride
    protectedFilePatterns?: string[]
    compress?: CompressOverride
    gc?: GCOverride
    qualityGate?: QualityGateOverride
    messageFilters?: MessageFiltersOverride
}

const FORCE_COMPRESS_PROTECTED: readonly string[] = ["compress"]
const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "../config/acp.jsonc")

export {
    VALID_CONFIG_KEYS,
    getInvalidConfigKeys,
    validateConfigTypes,
    type ValidationError,
} from "./config-validation"

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNumberOrPercent(value: unknown): value is Limit {
    return (
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && /^\d+(?:\.\d+)?%$/.test(value))
    )
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function isPermission(value: unknown): value is Permission {
    return value === "ask" || value === "allow" || value === "deny"
}

function isLogLevel(value: unknown): value is LogLevel {
    return (
        value === "debug" ||
        value === "info" ||
        value === "warn" ||
        value === "error" ||
        value === "silent"
    )
}

function isRecordOf<T>(
    value: unknown,
    predicate: (entry: unknown) => entry is T,
): value is Record<string, T> {
    return isRecord(value) && Object.values(value).every(predicate)
}

function isModelLimits(value: unknown): value is Record<string, Limit> {
    return isRecordOf(value, isNumberOrPercent)
}

function isProviderOverrides(value: unknown): value is Record<string, CompressProviderOverrides> {
    return isRecord(value) && validateConfigTypes({ compress: { providers: value } }).length === 0
}

function isCommands(value: unknown): value is Commands {
    return (
        isRecord(value) && typeof value.enabled === "boolean" && isStringArray(value.protectedTools)
    )
}

function isCompress(value: unknown): value is CompressConfig {
    if (!isRecord(value)) return false

    const required =
        isPermission(value.permission) &&
        typeof value.showCompression === "boolean" &&
        typeof value.summaryBuffer === "boolean" &&
        isNumberOrPercent(value.maxContextLimit) &&
        isNumberOrPercent(value.minContextLimit) &&
        typeof value.nudgeFrequency === "number" &&
        typeof value.minNudgeContextPercent === "number" &&
        (value.nudgeGrowthTokens === undefined || typeof value.nudgeGrowthTokens === "number") &&
        typeof value.iterationNudgeThreshold === "number" &&
        (value.nudgeForce === "strong" || value.nudgeForce === "soft") &&
        isStringArray(value.protectedTools) &&
        typeof value.protectTags === "boolean" &&
        typeof value.protectUserMessages === "boolean" &&
        typeof value.maxSummaryLengthHard === "number" &&
        typeof value.minCompressRange === "number" &&
        typeof value.minNudgeGrowthRatio === "number" &&
        typeof value.minNudgeGrowthFloor === "number" &&
        isNumberOrPercent(value.emergencyThresholdPercent) &&
        typeof value.maxVisibleSegments === "number" &&
        typeof value.keepEmbedMaxChars === "number" &&
        (value.lastSegmentSoftBlock === undefined ||
            typeof value.lastSegmentSoftBlock === "boolean") &&
        (value.preserveRecentMessages === undefined ||
            typeof value.preserveRecentMessages === "number") &&
        (value.preserveRecentTokens === undefined ||
            typeof value.preserveRecentTokens === "number") &&
        (value.preserveLastUserMessage === undefined ||
            typeof value.preserveLastUserMessage === "boolean")
    if (!required) return false

    return (
        (value.modelMaxLimits === undefined || isModelLimits(value.modelMaxLimits)) &&
        (value.modelMinLimits === undefined || isModelLimits(value.modelMinLimits)) &&
        (value.providers === undefined || isProviderOverrides(value.providers)) &&
        (value.toolOutputNudgeThreshold === undefined ||
            typeof value.toolOutputNudgeThreshold === "number")
    )
}

function isGC(value: unknown): value is GCConfig {
    if (
        !isRecord(value) ||
        value.algorithm !== "truncate" ||
        typeof value.promotionThreshold !== "number"
    ) {
        return false
    }
    const batch = value.batchCleanup
    return (
        typeof value.maxBlockAge === "number" &&
        typeof value.maxOldGenSummaryLength === "number" &&
        isNumberOrPercent(value.majorGcThresholdPercent) &&
        isRecord(batch) &&
        isNumberOrPercent(batch.lowThreshold) &&
        isNumberOrPercent(batch.highThreshold) &&
        isNumberOrPercent(batch.forceThreshold)
    )
}

function isQualityGate(value: unknown): value is QualityGateConfig {
    return (
        isRecord(value) &&
        typeof value.enabled === "boolean" &&
        typeof value.algorithm === "string" &&
        isRecord(value.algorithms)
    )
}

function isMessageFilters(value: unknown): value is MessageFiltersConfig {
    return (
        isRecord(value) &&
        typeof value.enabled === "boolean" &&
        isRecordOf(
            value.filters,
            (entry): entry is { enabled: boolean } =>
                isRecord(entry) && typeof entry.enabled === "boolean",
        )
    )
}

function isPluginConfig(value: unknown): value is PluginConfig {
    if (!isRecord(value)) return false
    const experimental = value.experimental
    return (
        typeof value.enabled === "boolean" &&
        typeof value.autoUpdate === "boolean" &&
        typeof value.debug === "boolean" &&
        isLogLevel(value.logLevel) &&
        typeof value.allowSubAgents === "boolean" &&
        (value.pruneNotification === "off" ||
            value.pruneNotification === "minimal" ||
            value.pruneNotification === "detailed") &&
        (value.pruneNotificationType === "chat" || value.pruneNotificationType === "toast") &&
        isCommands(value.commands) &&
        isRecord(experimental) &&
        typeof experimental.customPrompts === "boolean" &&
        isStringArray(value.protectedFilePatterns) &&
        isCompress(value.compress) &&
        isGC(value.gc) &&
        isQualityGate(value.qualityGate) &&
        isMessageFilters(value.messageFilters)
    )
}

function readProperty<T>(
    object: Record<string, unknown>,
    key: string,
    predicate: (value: unknown) => value is T,
): T | undefined {
    const value = object[key]
    return predicate(value) ? value : undefined
}

function assignIfDefined<T extends object, K extends keyof T>(
    target: T,
    key: K,
    value: T[K] | undefined,
): void {
    if (value !== undefined) target[key] = value
}

function parseModelOverrides(value: unknown): CompressModelOverrides | undefined {
    if (!isRecord(value)) return undefined
    const result: CompressModelOverrides = {}
    assignIfDefined(
        result,
        "showCompression",
        readProperty(value, "showCompression", (v): v is boolean => typeof v === "boolean"),
    )
    assignIfDefined(
        result,
        "summaryBuffer",
        readProperty(value, "summaryBuffer", (v): v is boolean => typeof v === "boolean"),
    )
    assignIfDefined(
        result,
        "maxContextLimit",
        readProperty(value, "maxContextLimit", isNumberOrPercent),
    )
    assignIfDefined(
        result,
        "nudgeFrequency",
        readProperty(value, "nudgeFrequency", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "minNudgeContextPercent",
        readProperty(value, "minNudgeContextPercent", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "nudgeGrowthTokens",
        readProperty(value, "nudgeGrowthTokens", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "toolOutputNudgeThreshold",
        readProperty(value, "toolOutputNudgeThreshold", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "iterationNudgeThreshold",
        readProperty(value, "iterationNudgeThreshold", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "nudgeForce",
        readProperty(
            value,
            "nudgeForce",
            (v): v is "strong" | "soft" => v === "strong" || v === "soft",
        ),
    )
    assignIfDefined(result, "protectedTools", readProperty(value, "protectedTools", isStringArray))
    assignIfDefined(
        result,
        "protectTags",
        readProperty(value, "protectTags", (v): v is boolean => typeof v === "boolean"),
    )
    assignIfDefined(
        result,
        "protectUserMessages",
        readProperty(value, "protectUserMessages", (v): v is boolean => typeof v === "boolean"),
    )
    assignIfDefined(
        result,
        "maxSummaryLengthHard",
        readProperty(value, "maxSummaryLengthHard", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "minCompressRange",
        readProperty(value, "minCompressRange", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "minNudgeGrowthRatio",
        readProperty(value, "minNudgeGrowthRatio", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "minNudgeGrowthFloor",
        readProperty(value, "minNudgeGrowthFloor", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "emergencyThresholdPercent",
        readProperty(value, "emergencyThresholdPercent", isNumberOrPercent),
    )
    assignIfDefined(
        result,
        "maxVisibleSegments",
        readProperty(value, "maxVisibleSegments", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "keepEmbedMaxChars",
        readProperty(value, "keepEmbedMaxChars", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "lastSegmentSoftBlock",
        readProperty(value, "lastSegmentSoftBlock", (v): v is boolean => typeof v === "boolean"),
    )
    assignIfDefined(
        result,
        "preserveRecentMessages",
        readProperty(value, "preserveRecentMessages", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "preserveRecentTokens",
        readProperty(value, "preserveRecentTokens", (v): v is number => typeof v === "number"),
    )
    assignIfDefined(
        result,
        "preserveLastUserMessage",
        readProperty(value, "preserveLastUserMessage", (v): v is boolean => typeof v === "boolean"),
    )
    return result
}

function parseProviders(value: unknown): Record<string, CompressProviderOverrides> | undefined {
    if (!isRecord(value)) return undefined
    const providers: Record<string, CompressProviderOverrides> = {}
    for (const [providerId, rawProvider] of Object.entries(value)) {
        const providerFields = parseModelOverrides(rawProvider)
        if (providerFields === undefined) continue
        const provider: CompressProviderOverrides = { ...providerFields }
        if (isRecord(rawProvider) && isRecord(rawProvider.models)) {
            const models: Record<string, CompressModelOverrides> = {}
            for (const [modelId, rawModel] of Object.entries(rawProvider.models)) {
                const model = parseModelOverrides(rawModel)
                if (model !== undefined) models[modelId] = model
            }
            provider.models = models
        }
        providers[providerId] = provider
    }
    return providers
}

function parseLimitMap(value: unknown): Record<string, Limit> | undefined {
    return isModelLimits(value) ? value : undefined
}

function parseCompress(value: unknown): CompressOverride | undefined {
    if (!isRecord(value)) return undefined
    const result: CompressOverride = {}
    assignIfDefined(result, "permission", readProperty(value, "permission", isPermission))
    assignIfDefined(
        result,
        "showCompression",
        readProperty(value, "showCompression", (v): v is boolean => typeof v === "boolean"),
    )
    assignIfDefined(
        result,
        "summaryBuffer",
        readProperty(value, "summaryBuffer", (v): v is boolean => typeof v === "boolean"),
    )
    assignIfDefined(
        result,
        "maxContextLimit",
        readProperty(value, "maxContextLimit", isNumberOrPercent),
    )
    assignIfDefined(
        result,
        "minContextLimit",
        readProperty(value, "minContextLimit", isNumberOrPercent),
    )
    assignIfDefined(result, "modelMaxLimits", parseLimitMap(value.modelMaxLimits))
    assignIfDefined(result, "modelMinLimits", parseLimitMap(value.modelMinLimits))
    assignIfDefined(result, "providers", parseProviders(value.providers))
    const parsed = parseModelOverrides(value)
    if (parsed !== undefined) {
        Object.assign(result, parsed)
    }
    return result
}

function parseConfigLayer(value: Record<string, unknown>): ConfigLayer {
    const layer: ConfigLayer = {}
    assignIfDefined(
        layer,
        "enabled",
        readProperty(value, "enabled", (v): v is boolean => typeof v === "boolean"),
    )
    assignIfDefined(
        layer,
        "autoUpdate",
        readProperty(value, "autoUpdate", (v): v is boolean => typeof v === "boolean"),
    )
    assignIfDefined(
        layer,
        "debug",
        readProperty(value, "debug", (v): v is boolean => typeof v === "boolean"),
    )
    assignIfDefined(layer, "logLevel", readProperty(value, "logLevel", isLogLevel))
    assignIfDefined(
        layer,
        "allowSubAgents",
        readProperty(value, "allowSubAgents", (v): v is boolean => typeof v === "boolean"),
    )
    assignIfDefined(
        layer,
        "pruneNotification",
        readProperty(
            value,
            "pruneNotification",
            (v): v is PluginConfig["pruneNotification"] =>
                v === "off" || v === "minimal" || v === "detailed",
        ),
    )
    assignIfDefined(
        layer,
        "pruneNotificationType",
        readProperty(
            value,
            "pruneNotificationType",
            (v): v is PluginConfig["pruneNotificationType"] => v === "chat" || v === "toast",
        ),
    )

    if (isRecord(value.commands)) {
        const commands: CommandsOverride = {}
        assignIfDefined(
            commands,
            "enabled",
            readProperty(value.commands, "enabled", (v): v is boolean => typeof v === "boolean"),
        )
        assignIfDefined(
            commands,
            "protectedTools",
            readProperty(value.commands, "protectedTools", isStringArray),
        )
        layer.commands = commands
    }
    if (isRecord(value.experimental)) {
        const experimental: ExperimentalOverride = {}
        assignIfDefined(
            experimental,
            "allowSubAgents",
            readProperty(
                value.experimental,
                "allowSubAgents",
                (v): v is boolean => typeof v === "boolean",
            ),
        )
        assignIfDefined(
            experimental,
            "customPrompts",
            readProperty(
                value.experimental,
                "customPrompts",
                (v): v is boolean => typeof v === "boolean",
            ),
        )
        layer.experimental = experimental
    }
    assignIfDefined(
        layer,
        "protectedFilePatterns",
        readProperty(value, "protectedFilePatterns", isStringArray),
    )
    assignIfDefined(layer, "compress", parseCompress(value.compress))

    if (isRecord(value.gc)) {
        const gc: GCOverride = {}
        assignIfDefined(
            gc,
            "algorithm",
            readProperty(value.gc, "algorithm", (v): v is "truncate" => v === "truncate"),
        )
        assignIfDefined(
            gc,
            "promotionThreshold",
            readProperty(value.gc, "promotionThreshold", (v): v is number => typeof v === "number"),
        )
        assignIfDefined(
            gc,
            "maxBlockAge",
            readProperty(value.gc, "maxBlockAge", (v): v is number => typeof v === "number"),
        )
        assignIfDefined(
            gc,
            "maxOldGenSummaryLength",
            readProperty(
                value.gc,
                "maxOldGenSummaryLength",
                (v): v is number => typeof v === "number",
            ),
        )
        assignIfDefined(
            gc,
            "majorGcThresholdPercent",
            readProperty(value.gc, "majorGcThresholdPercent", isNumberOrPercent),
        )
        if (isRecord(value.gc.batchCleanup)) {
            const batch: Partial<BatchCleanupConfig> = {}
            assignIfDefined(
                batch,
                "lowThreshold",
                readProperty(value.gc.batchCleanup, "lowThreshold", isNumberOrPercent),
            )
            assignIfDefined(
                batch,
                "highThreshold",
                readProperty(value.gc.batchCleanup, "highThreshold", isNumberOrPercent),
            )
            assignIfDefined(
                batch,
                "forceThreshold",
                readProperty(value.gc.batchCleanup, "forceThreshold", isNumberOrPercent),
            )
            gc.batchCleanup = batch
        }
        layer.gc = gc
    }

    if (isRecord(value.qualityGate)) {
        const qualityGate: QualityGateOverride = {}
        assignIfDefined(
            qualityGate,
            "enabled",
            readProperty(value.qualityGate, "enabled", (v): v is boolean => typeof v === "boolean"),
        )
        assignIfDefined(
            qualityGate,
            "algorithm",
            readProperty(value.qualityGate, "algorithm", (v): v is string => typeof v === "string"),
        )
        assignIfDefined(
            qualityGate,
            "algorithms",
            readProperty(value.qualityGate, "algorithms", isRecord),
        )
        layer.qualityGate = qualityGate
    }

    if (isRecord(value.messageFilters)) {
        const messageFilters: MessageFiltersOverride = {}
        assignIfDefined(
            messageFilters,
            "enabled",
            readProperty(
                value.messageFilters,
                "enabled",
                (v): v is boolean => typeof v === "boolean",
            ),
        )
        if (isRecord(value.messageFilters.filters)) {
            const filters: Record<string, { enabled?: boolean }> = {}
            for (const [name, rawFilter] of Object.entries(value.messageFilters.filters)) {
                if (isRecord(rawFilter)) {
                    filters[name] = {
                        ...(typeof rawFilter.enabled === "boolean"
                            ? { enabled: rawFilter.enabled }
                            : {}),
                    }
                }
            }
            messageFilters.filters = filters
        }
        layer.messageFilters = messageFilters
    }

    return layer
}

function showConfigWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, unknown>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)
    if (invalidKeys.length === 0 && typeErrors.length === 0) return

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []
    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }
    if (typeErrors.length > 0) {
        for (const error of typeErrors.slice(0, 2)) {
            messages.push(`${error.key}: expected ${error.expected}, got ${error.actual}`)
        }
        if (typeErrors.length > 2) messages.push(`(+${typeErrors.length - 2} more type errors)`)
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: `ACP: ${configType} warning`,
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

function stripUndefined<T extends object>(value: T): Partial<T> {
    const result: Partial<T> = {}
    for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) Object.assign(result, { [key]: entry })
    }
    return result
}

function mergeModelOverrides(
    base: Record<string, CompressModelOverrides> | undefined,
    override: Record<string, CompressModelOverrides> | undefined,
): Record<string, CompressModelOverrides> | undefined {
    if (base === undefined) return override
    if (override === undefined) return base
    const merged: Record<string, CompressModelOverrides> = { ...base }
    for (const [modelId, model] of Object.entries(override)) {
        merged[modelId] = { ...base[modelId], ...stripUndefined(model) }
    }
    return merged
}

function mergeProviderOverrides(
    base: Record<string, CompressProviderOverrides> | undefined,
    override: Record<string, CompressProviderOverrides> | undefined,
): Record<string, CompressProviderOverrides> | undefined {
    if (base === undefined) return override
    if (override === undefined) return base
    const merged: Record<string, CompressProviderOverrides> = { ...base }
    for (const [providerId, provider] of Object.entries(override)) {
        const baseProvider = base[providerId]
        const mergedModels = mergeModelOverrides(baseProvider?.models, provider.models)
        merged[providerId] = {
            ...baseProvider,
            ...stripUndefined(provider),
            ...(mergedModels !== undefined ? { models: mergedModels } : {}),
        }
    }
    return merged
}

export function mergeCompress(base: CompressConfig, override?: CompressOverride): CompressConfig {
    if (!override) return base
    return {
        permission: override.permission ?? base.permission,
        showCompression: override.showCompression ?? base.showCompression,
        summaryBuffer: override.summaryBuffer ?? base.summaryBuffer,
        maxContextLimit: override.maxContextLimit ?? base.maxContextLimit,
        minContextLimit: override.minContextLimit ?? base.minContextLimit,
        modelMaxLimits: override.modelMaxLimits ?? base.modelMaxLimits,
        modelMinLimits: override.modelMinLimits ?? base.modelMinLimits,
        providers: mergeProviderOverrides(base.providers, override.providers),
        nudgeFrequency: override.nudgeFrequency ?? base.nudgeFrequency,
        minNudgeContextPercent: override.minNudgeContextPercent ?? base.minNudgeContextPercent,
        nudgeGrowthTokens: override.nudgeGrowthTokens ?? base.nudgeGrowthTokens,
        toolOutputNudgeThreshold:
            override.toolOutputNudgeThreshold ?? base.toolOutputNudgeThreshold,
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

function mergeCommands(base: Commands, override?: CommandsOverride): Commands {
    if (!override) return base
    return {
        enabled: override.enabled ?? base.enabled,
        protectedTools: [...new Set([...base.protectedTools, ...(override.protectedTools ?? [])])],
    }
}

function mergeExperimental(
    base: ExperimentalConfig,
    override?: ExperimentalOverride,
): ExperimentalConfig {
    if (!override) return base
    return { customPrompts: override.customPrompts ?? base.customPrompts }
}

function cloneValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(cloneValue)
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]),
        )
    }
    return value
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
    const cloned: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) cloned[key] = cloneValue(entry)
    return cloned
}

export function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: {
            enabled: config.commands.enabled,
            protectedTools: [...config.commands.protectedTools],
        },
        experimental: { ...config.experimental },
        protectedFilePatterns: [...config.protectedFilePatterns],
        compress: {
            ...config.compress,
            modelMaxLimits: config.compress.modelMaxLimits
                ? { ...config.compress.modelMaxLimits }
                : undefined,
            modelMinLimits: config.compress.modelMinLimits
                ? { ...config.compress.modelMinLimits }
                : undefined,
            providers: config.compress.providers
                ? Object.fromEntries(
                      Object.entries(config.compress.providers).map(([providerId, provider]) => [
                          providerId,
                          {
                              ...provider,
                              ...(provider.protectedTools
                                  ? { protectedTools: [...provider.protectedTools] }
                                  : {}),
                              ...(provider.models
                                  ? {
                                        models: Object.fromEntries(
                                            Object.entries(provider.models).map(
                                                ([modelId, model]) => [
                                                    modelId,
                                                    {
                                                        ...model,
                                                        ...(model.protectedTools
                                                            ? {
                                                                  protectedTools: [
                                                                      ...model.protectedTools,
                                                                  ],
                                                              }
                                                            : {}),
                                                    },
                                                ],
                                            ),
                                        ),
                                    }
                                  : {}),
                          },
                      ]),
                  )
                : undefined,
            protectedTools: [...config.compress.protectedTools],
        },
        gc: { ...config.gc, batchCleanup: { ...config.gc.batchCleanup } },
        qualityGate: {
            ...config.qualityGate,
            algorithms: cloneRecord(config.qualityGate.algorithms),
        },
        messageFilters: {
            ...config.messageFilters,
            filters: Object.fromEntries(
                Object.entries(config.messageFilters.filters).map(([name, filter]) => [
                    name,
                    { ...filter },
                ]),
            ),
        },
    }
}

function mergeGC(base: GCConfig, override?: GCOverride): GCConfig {
    if (!override) return base
    return {
        ...base,
        ...override,
        batchCleanup: { ...base.batchCleanup, ...(override.batchCleanup ?? {}) },
    }
}

function mergeUnknownRecords(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(override)) {
        merged[key] =
            isRecord(merged[key]) && isRecord(value)
                ? mergeUnknownRecords(merged[key], value)
                : value
    }
    return merged
}

function mergeQualityGate(
    base: QualityGateConfig,
    override?: QualityGateOverride,
): QualityGateConfig {
    if (!override) return base
    return {
        enabled: override.enabled ?? base.enabled,
        algorithm: override.algorithm ?? base.algorithm,
        algorithms: mergeUnknownRecords(base.algorithms, override.algorithms ?? {}),
    }
}

function mergeMessageFilters(
    base: MessageFiltersConfig,
    override?: MessageFiltersOverride,
): MessageFiltersConfig {
    if (!override) return base
    const filters = { ...base.filters }
    for (const [name, filter] of Object.entries(override.filters ?? {})) {
        filters[name] = {
            ...filters[name],
            ...filter,
            enabled: filter.enabled ?? filters[name]?.enabled ?? true,
        }
    }
    return { enabled: override.enabled ?? base.enabled, filters }
}

function mergeLayer(config: PluginConfig, data: ConfigLayer): PluginConfig {
    return {
        enabled: data.enabled ?? config.enabled,
        autoUpdate: data.autoUpdate ?? config.autoUpdate,
        debug: data.debug ?? config.debug,
        logLevel: data.logLevel ?? config.logLevel,
        allowSubAgents:
            data.allowSubAgents ?? data.experimental?.allowSubAgents ?? config.allowSubAgents,
        pruneNotification: data.pruneNotification ?? config.pruneNotification,
        pruneNotificationType: data.pruneNotificationType ?? config.pruneNotificationType,
        commands: mergeCommands(config.commands, data.commands),
        experimental: mergeExperimental(config.experimental, data.experimental),
        protectedFilePatterns: [
            ...new Set([...config.protectedFilePatterns, ...(data.protectedFilePatterns ?? [])]),
        ],
        compress: mergeCompress(config.compress, data.compress),
        gc: mergeGC(config.gc, data.gc),
        qualityGate: mergeQualityGate(config.qualityGate, data.qualityGate),
        messageFilters: mergeMessageFilters(config.messageFilters, data.messageFilters),
    }
}

function parseJsonc(fileContent: string, configPath: string): unknown {
    const errors: ParseError[] = []
    const parsed = jsoncParser.parse(fileContent, errors, { allowTrailingComma: true })
    if (errors.length > 0) {
        const first = errors[0]
        throw new Error(`Invalid JSONC at offset ${first.offset} (error ${first.error})`)
    }
    if (parsed === undefined || parsed === null) {
        throw new Error(`Config file is empty or invalid: ${configPath}`)
    }
    return parsed
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
    try {
        data = parseJsonc(fileContent, CONFIG_PATH)
    } catch (error) {
        throw new Error(
            `ACP config file is invalid at ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
    if (!isPluginConfig(data)) {
        throw new Error(
            `ACP config file must contain a complete valid PluginConfig: ${CONFIG_PATH}`,
        )
    }
    return data
}

export function getBundledConfig(): PluginConfig {
    return readPackageConfig()
}

interface ConfigLoadResult {
    data: ConfigLayer | null
    rawData: Record<string, unknown> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent: string
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        return { data: null, rawData: null }
    }

    try {
        const parsed = parseJsonc(fileContent, configPath)
        if (!isRecord(parsed)) {
            return { data: null, rawData: null, parseError: "Config file must contain an object" }
        }
        return { data: parseConfigLayer(parsed), rawData: parsed }
    } catch (error) {
        return {
            data: null,
            rawData: null,
            parseError: error instanceof Error ? error.message : "Failed to parse config",
        }
    }
}

function selectConfigFile(directory: string): string | null {
    const jsoncPath = join(directory, "acp.jsonc")
    const jsonPath = join(directory, "acp.json")
    return existsSync(jsoncPath) ? jsoncPath : existsSync(jsonPath) ? jsonPath : null
}

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (true) {
        const candidate = join(current, ".opencode")
        try {
            if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
        } catch {}
        const parent = dirname(current)
        if (parent === current) return null
        current = parent
    }
}

function getConfigPaths(ctx: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
    globalDir: string
} {
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
    const globalDir = join(configHome, "opencode")
    const global = selectConfigFile(globalDir)
    const configDir = process.env.OPENCODE_CONFIG_DIR
        ? selectConfigFile(process.env.OPENCODE_CONFIG_DIR)
        : null
    const opencodeDir = findOpencodeDir(ctx.directory)
    const project = opencodeDir ? selectConfigFile(opencodeDir) : null
    return { global, configDir, project, globalDir }
}

function createDefaultConfig(globalDir: string): void {
    if (!existsSync(globalDir)) mkdirSync(globalDir, { recursive: true })
    const globalPath = join(globalDir, "acp.jsonc")
    if (!existsSync(globalPath)) {
        writeFileSync(
            globalPath,
            `{
  "$schema": "https://raw.githubusercontent.com/ranxianglei/opencode-acp/master/dcp.schema.json"
}
`,
            "utf-8",
        )
    }
}

function scheduleParseWarning(ctx: PluginInput, title: string, message: string): void {
    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: { title, message, variant: "warning", duration: 7000 },
            })
        } catch {}
    }, 7000)
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(getBundledConfig())
    const configPaths = getConfigPaths(ctx)

    if (!configPaths.global) createDefaultConfig(configPaths.globalDir)

    const layers: Array<{ path: string | null; name: string; isProject: boolean }> = [
        { path: configPaths.global, name: "config", isProject: false },
        { path: configPaths.configDir, name: "configDir config", isProject: true },
        { path: configPaths.project, name: "project config", isProject: true },
    ]

    for (const layer of layers) {
        if (!layer.path) continue
        const result = loadConfigFile(layer.path)
        if (result.parseError) {
            scheduleParseWarning(
                ctx,
                `ACP: Invalid ${layer.name}`,
                `${layer.path}\n${result.parseError}\nUsing previous/default values`,
            )
            continue
        }
        if (!result.data || !result.rawData) continue
        showConfigWarnings(ctx, layer.path, result.rawData, layer.isProject)
        config = mergeLayer(config, result.data)
    }

    return deepCloneConfig(config)
}
