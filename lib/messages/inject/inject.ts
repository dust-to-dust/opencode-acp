import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import type { RuntimePrompts } from "../../prompts/store"
import {
    formatBlockRef,
    formatMessageIdTag,
    formatTokenSize,
    classifyMessageType,
} from "../../message-ids"
import type { CompressionPriorityMap } from "../priority"
import { compressPermission } from "../../compress-permission"
import { countMessageCharacters } from "../../token-utils"
import {
    isIgnoredUserMessage,
    isProtectedUserMessage,
    messageHasCompressAttempt,
    isSyntheticMessage,
} from "../query"
import { saveSessionState } from "../../state/persistence"
import {
    appendToTextPart,
    appendToLastTextPart,
    appendToAllToolParts,
    createSyntheticTextPart,
    hasContent,
} from "../utils"
import {
    computeProtectedRefs,
    computeShouldNudge,
    getModelInfo,
    isContextOverLimits,
    DEFAULT_NUDGE_GROWTH_TOKENS,
    DEFAULT_MIN_NUDGE_CONTEXT_PERCENT,
    resolveMinNudgeContextPercent,
    resolveMinNudgeFloorTokens,
    applyCompressOverrides,
} from "./utils"
import { messageContainsProtectedTool } from "../../compress/protected-content"

/** Stable seed for a fallback text part on the ACP dynamic guidance target. */
const ACP_SUFFIX_SEED = "acp-dynamic-guidance"

/**
 * Resolve the current turn's user message as the dynamic guidance target.
 * OpenCode only forwards messages backed by session history, so a new synthetic
 * message added by the transform hook is not guaranteed to reach the provider.
 * Mutating the latest user message keeps older cacheable history unchanged.
 */
function createSuffixMessage(messages: WithParts[]): WithParts | null {
    const target = messages.findLast((message) => message.info.role === "user")
    if (!target) return null
    if (!target.parts.some((part) => part.type === "text")) {
        target.parts.push(createSyntheticTextPart(target, "", ACP_SUFFIX_SEED))
    }
    return target
}

export const injectCompressNudges = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
    prompts: RuntimePrompts,
    _compressionPriorities?: CompressionPriorityMap,
    debugNotify?: (text: string) => void,
    _preCompressTokens?: number,
): void => {
    if (compressPermission(state, config) === "deny") {
        return
    }

    const { providerId, modelId } = getModelInfo(messages)
    config = applyCompressOverrides(config, providerId, modelId)
    const { overMaxLimit, overMinLimit, currentTokens, modelContextLimit } = isContextOverLimits(
        config,
        state,
        providerId,
        modelId,
        messages,
    )
    const nudgeGrowthTokens = config.compress?.nudgeGrowthTokens ?? DEFAULT_NUDGE_GROWTH_TOKENS
    const growthFloor = Math.max(
        config.compress.minNudgeGrowthFloor,
        config.compress.minNudgeGrowthRatio * nudgeGrowthTokens,
    )
    const emergencyThreshold = resolveEmergencyThreshold(config, modelContextLimit)
    const emergencyOverride =
        emergencyThreshold !== undefined &&
        currentTokens !== undefined &&
        currentTokens >= emergencyThreshold
    let stateChanged = false
    const protectedRefs = computeProtectedRefs(messages, state, config.compress)
    const candidateResult = buildCompressionCandidates(state, config, messages, protectedRefs)

    if (state.nudges.pendingCompression) {
        const pending = state.nudges.pendingCompression
        const available = new Set(candidateResult.refs)
        const pendingIsCurrent =
            pending.candidates.length > 0 &&
            new Set(pending.candidates).size === pending.candidates.length &&
            pending.candidates.every((ref) => available.has(ref))

        if (pendingIsCurrent) {
            const suffixMessage = createSuffixMessage(messages)
            if (suffixMessage) {
                appendToLastTextPart(
                    suffixMessage,
                    renderCompressionRequest(prompts, pending.candidates, pending.cacheBoundary),
                )
                finishSuffix(messages, suffixMessage, debugNotify)
            }
            state.nudges.shouldInjectThisTurn = true
            return
        }

        state.nudges.pendingCompression = undefined
        state.nudges.shouldInjectThisTurn = false
        stateChanged = true
    }

    if (
        currentTokens !== undefined &&
        state.nudges.lastPerMessageNudgeTokens !== undefined &&
        currentTokens < state.nudges.lastPerMessageNudgeTokens - nudgeGrowthTokens
    ) {
        state.nudges.lastPerMessageNudgeTokens = currentTokens
        state.nudges.lastNudgeShownTokens = undefined
        stateChanged = true
    }

    if (state.nudges.lastPerMessageNudgeTokens === undefined && currentTokens !== undefined) {
        state.nudges.lastPerMessageNudgeTokens = currentTokens
        state.nudges.shouldInjectThisTurn = false
        saveSessionState(state, logger).catch(() => {})
        return
    }

    const growthReference = state.nudges.lastPerMessageNudgeTokens

    const decision = computeShouldNudge({
        currentTokens,
        modelContextLimit,
        overMinLimit,
        overMaxLimit,
        lastNudgeTokens: growthReference,
        minNudgeContextPercent:
            resolveMinNudgeContextPercent(config, providerId, modelId) ??
            DEFAULT_MIN_NUDGE_CONTEXT_PERCENT,
        nudgeGrowthTokens,
    })

    const growthSinceBaseline =
        currentTokens !== undefined && growthReference !== undefined
            ? currentTokens - growthReference
            : undefined
    const minNudgeFloorTokens = resolveMinNudgeFloorTokens(
        config,
        modelContextLimit,
        providerId,
        modelId,
    )
    const overMinNudgeFloor =
        minNudgeFloorTokens === undefined ||
        currentTokens === undefined ||
        currentTokens >= minNudgeFloorTokens
    const nudgeAllowed =
        emergencyOverride ||
        (decision.shouldNudge &&
            (overMaxLimit || overMinNudgeFloor) &&
            growthSinceBaseline !== undefined &&
            growthSinceBaseline >= growthFloor)

    const meetsMinimum =
        config.compress.minCompressRange <= 0 ||
        candidateResult.characters >= config.compress.minCompressRange

    if (nudgeAllowed && candidateResult.refs.length > 0 && meetsMinimum) {
        const pending = {
            candidates: candidateResult.refs,
            cacheBoundary: candidateResult.refs[candidateResult.refs.length - 1],
            createdAtTokens: currentTokens,
        }
        state.nudges.pendingCompression = pending
        state.nudges.lastNudgeShownTokens = currentTokens
        state.nudges.shouldInjectThisTurn = true
        stateChanged = true

        const suffixMessage = createSuffixMessage(messages)
        if (suffixMessage) {
            appendToLastTextPart(
                suffixMessage,
                renderCompressionRequest(prompts, pending.candidates, pending.cacheBoundary),
            )
            finishSuffix(messages, suffixMessage, debugNotify)
        }
        logger.info("Compression selection requested", {
            session: state.sessionId,
            trigger: emergencyOverride ? "emergency" : "growth",
            candidates: pending.candidates.length,
            cacheBoundary: pending.cacheBoundary,
            currentTokens,
        })
    } else {
        state.nudges.shouldInjectThisTurn = false
    }

    if (stateChanged || nudgeAllowed) {
        saveSessionState(state, logger).catch(() => {})
    }
}

export function buildCompressionCandidates(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    protectedRefs: Set<string>,
): { refs: string[]; characters: number } {
    const firstUserId = messages.find(
        (message) => message.info.role === "user" && !isIgnoredUserMessage(message),
    )?.info.id
    const lastUserId = messages.findLast(
        (message) => message.info.role === "user" && !isIgnoredUserMessage(message),
    )?.info.id
    const groupedActivities = new Map<
        string,
        { ref: string; time: number; characters: number; visible: boolean; blocked: boolean }
    >()

    for (const message of messages) {
        const ref = state.messageIds.byRawId.get(message.info.id)
        if (!ref) continue

        const entry = groupedActivities.get(ref) ?? {
            ref,
            time: message.info.time.created,
            characters: 0,
            visible: false,
            blocked: false,
        }
        entry.time = Math.min(entry.time, message.info.time.created)
        entry.characters += countMessageCharacters(message)
        const isCompressed =
            (state.prune.messages.byMessageId.get(message.info.id)?.activeBlockIds.length ?? 0) > 0
        const isBlocked =
            isSyntheticMessage(message) ||
            isIgnoredUserMessage(message) ||
            message.info.id === firstUserId ||
            message.info.id === lastUserId ||
            messageHasCompressAttempt(message) ||
            isProtectedUserMessage(config, message) ||
            protectedRefs.has(ref) ||
            isCompressed ||
            messageContainsProtectedTool(
                message,
                config.compress.protectedTools,
                config.protectedFilePatterns,
            )
        entry.visible ||= !isCompressed
        entry.blocked ||= isBlocked
        groupedActivities.set(ref, entry)
    }

    const visibleMessageIds = new Set(messages.map((message) => message.info.id))
    for (const [rawId, ref] of state.messageIds.byRawId) {
        if (!visibleMessageIds.has(rawId)) {
            const entry = groupedActivities.get(ref)
            if (entry) entry.blocked = true
        }
    }

    const entries = Array.from(groupedActivities.values()).filter(
        (entry) => entry.visible && !entry.blocked && entry.characters > 0,
    )

    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (
            !block?.active ||
            !block.compressMessageId ||
            !visibleMessageIds.has(block.compressMessageId)
        ) {
            continue
        }
        const ref = block.ref ?? formatBlockRef(block.blockId, block.tier ?? 1)
        if (protectedRefs.has(ref)) continue
        entries.push({
            ref,
            time: block.createdAt,
            characters: block.summary.length,
            visible: true,
            blocked: false,
        })
    }

    entries.sort((left, right) => left.time - right.time || left.ref.localeCompare(right.ref))
    return {
        refs: entries.map((entry) => entry.ref),
        characters: entries.reduce((total, entry) => total + entry.characters, 0),
    }
}

/*
    const lines: string[] = []
    for (let index = 0; index < candidates.length; index += 30) {
        lines.push(candidates.slice(index, index + 30).join(", "))
    }
    return `\n<dcp-system-reminder>\nACP compression is required before continuing.\nEligible blocks (oldest first):\n${lines.join("\n")}\nCache boundary: ${cacheBoundary}. Content after this boundary and unlisted blocks are not eligible.\nCall \`compress\` now.\n</dcp-system-reminder>`
*/

function finishSuffix(
    messages: WithParts[],
    suffixMessage: WithParts,
    debugNotify?: (text: string) => void,
): void {
    if (!hasContent(suffixMessage)) {
        const index = messages.lastIndexOf(suffixMessage)
        if (index !== -1) messages.splice(index, 1)
        return
    }
    appendToLastTextPart(suffixMessage, "\n")
    if (!debugNotify) return
    const text = suffixMessage.parts
        .filter((part) => part.type === "text")
        .map((part) => (part as { text?: string }).text ?? "")
        .join("\n")
        .trim()
    if (text) debugNotify(text)
}

function renderCompressionRequest(
    prompts: RuntimePrompts,
    candidates: string[],
    cacheBoundary: string,
): string {
    const lines: string[] = []
    for (let index = 0; index < candidates.length; index += 30) {
        lines.push(candidates.slice(index, index + 30).join(", "))
    }
    return prompts.compressionRequest
        .replace("{{candidates}}", lines.join("\n"))
        .replace("{{cacheBoundary}}", cacheBoundary)
}

function resolveEmergencyThreshold(
    config: PluginConfig,
    modelContextLimit: number | undefined,
): number | undefined {
    const threshold = config.compress?.emergencyThresholdPercent
    if (threshold === undefined || modelContextLimit === undefined) return undefined
    if (typeof threshold === "number") return threshold
    if (!threshold.endsWith("%")) return undefined
    const parsedPercent = parseFloat(threshold.slice(0, -1))
    if (isNaN(parsedPercent)) return undefined
    const clampedPercent = Math.max(0, Math.min(100, Math.round(parsedPercent)))
    return Math.round((clampedPercent / 100) * modelContextLimit)
}

export interface VisibleSegment {
    startRef: string
    endRef: string
    count: number
    tokens: number
    hasTool: boolean
}

function refNumber(ref: string): number {
    const n = parseInt(ref.slice(1), 10)
    return Number.isNaN(n) ? -1 : n
}

/**
 * Build disjoint visible-id segments from the surviving messages.
 *
 * Each segment is a maximal run of contiguous refs (e.g. A3-A7).
 * Holes between segments correspond to messages already consumed by a
 * compression block — those refs are NOT safe to target. Surfacing the
 * segments (instead of a single `first–last` span) stops the model from
 * picking a ref that lives inside a compressed hole.
 */
export function buildVisibleSegments(state: SessionState, messages: WithParts[]): VisibleSegment[] {
    const refInfo = new Map<string, { tokens: number; hasTool: boolean }>()
    for (const msg of messages) {
        const ref = state.messageIds.byRawId.get(msg.info.id)
        if (!ref) continue
        let tokens = 0
        let hasTool = false
        for (const part of msg.parts || []) {
            if (part.type === "text" && typeof (part as any).text === "string") {
                tokens += Math.round(((part as any).text as string).length / 4)
            } else if (part.type !== "text" && part.type !== "reasoning") {
                tokens += Math.round(JSON.stringify(part).length / 4)
                hasTool = true
            }
        }
        refInfo.set(ref, { tokens, hasTool })
    }
    if (refInfo.size === 0) return []

    const refs = Array.from(refInfo.keys()).sort((a, b) => refNumber(a) - refNumber(b))
    const segments: VisibleSegment[] = []
    let cur: VisibleSegment | null = null
    let prevNum = -2
    for (const ref of refs) {
        const num = refNumber(ref)
        const info = refInfo.get(ref)!
        if (cur && num === prevNum + 1) {
            cur.endRef = ref
            cur.count++
            cur.tokens += info.tokens
            if (info.hasTool) cur.hasTool = true
        } else {
            if (cur) segments.push(cur)
            cur = {
                startRef: ref,
                endRef: ref,
                count: 1,
                tokens: info.tokens,
                hasTool: info.hasTool,
            }
        }
        prevNum = num
    }
    if (cur) segments.push(cur)
    return segments
}

function formatSegment(seg: VisibleSegment): string {
    return seg.startRef === seg.endRef ? seg.startRef : `${seg.startRef}–${seg.endRef}`
}

export function formatVisibleGuidance(segments: VisibleSegment[], maxSegs: number): string {
    if (segments.length === 0) return ""
    const totalMsgs = segments.reduce((s, seg) => s + seg.count, 0)
    const totalSegs = segments.length
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

    if (totalSegs <= maxSegs) {
        return `[Visible: ${segments.map(formatSegment).join(", ")} (${totalMsgs} msg${totalMsgs === 1 ? "" : "s"}, ${totalSegs} segment${totalSegs === 1 ? "" : "s"})]`
    }
    // Keep the largest tool-bearing/high-token segments, drop the smallest,
    // but preserve ascending ref order for what gets shown.
    const keepSet = new Set(
        [...segments]
            .sort((a, b) => {
                if (a.hasTool !== b.hasTool) return a.hasTool ? -1 : 1
                return b.tokens - a.tokens
            })
            .slice(0, maxSegs),
    )
    const shown = segments.filter((s) => keepSet.has(s))
    const omitted = segments.filter((s) => !keepSet.has(s))
    const omittedTokens = omitted.reduce((sum, s) => sum + s.tokens, 0)
    const omittedMsgs = omitted.reduce((sum, s) => sum + s.count, 0)
    return `[Visible (top ${shown.length} of ${totalSegs} segments, ${totalMsgs} msgs): ${shown.map(formatSegment).join(", ")} | +${omitted.length} smaller segment${omitted.length === 1 ? "" : "s"} (~${fmt(omittedTokens)} tokens, ${omittedMsgs} msg${omittedMsgs === 1 ? "" : "s"}) omitted]`
}

function injectVisibleIdRange(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    target: WithParts | null,
): void {
    if (!target) return
    const segments = buildVisibleSegments(state, messages)
    if (segments.length === 0) return
    const maxSegs = config.compress.maxVisibleSegments
    const rangeTag = "\n\n" + formatVisibleGuidance(segments, maxSegs)

    for (const part of target.parts) {
        if (part.type === "text") {
            appendToTextPart(part, rangeTag)
            return
        }
    }
    target.parts.push(createSyntheticTextPart(target, rangeTag))
}

export const injectMessageIds = (
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    compressionPriorities?: CompressionPriorityMap,
): void => {
    if (compressPermission(state, config) === "deny") {
        return
    }

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        let messageRef = state.messageIds.byRawId.get(message.info.id)
        if (messageHasCompressAttempt(message)) {
            const callIds = new Set(
                message.parts.flatMap((part) =>
                    part.type === "tool" && part.tool === "compress" ? [part.callID] : [],
                ),
            )
            const block = [...state.prune.messages.activeBlockIds]
                .map((blockId) => state.prune.messages.blocksById.get(blockId))
                .find(
                    (candidate) =>
                        candidate?.active &&
                        candidate.compressMessageId === message.info.id &&
                        candidate.compressCallId !== undefined &&
                        callIds.has(candidate.compressCallId),
                )
            messageRef =
                block?.ref ?? (block ? formatBlockRef(block.blockId, block.tier ?? 1) : undefined)
        }
        if (!messageRef) {
            continue
        }

        const isBlockedMessage = isProtectedUserMessage(config, message)
        const priority = undefined
        const msgType = classifyMessageType(message.parts)
        const msgTokens = Math.round(countMessageCharacters(message) / 4)
        const tag = formatMessageIdTag(isBlockedMessage ? "BLOCKED" : messageRef, {
            priority: priority ?? undefined,
            type: msgType,
            tokens: formatTokenSize(msgTokens),
        })

        if (message.info.role === "user") {
            let injected = false
            for (const part of message.parts) {
                if (part.type === "text") {
                    injected = appendToTextPart(part, tag) || injected
                }
            }

            if (injected) {
                continue
            }

            message.parts.push(createSyntheticTextPart(message, tag))
            continue
        }

        if (message.info.role !== "assistant") {
            continue
        }

        if (!hasContent(message)) {
            continue
        }

        if (appendToAllToolParts(message, tag)) {
            continue
        }

        if (appendToLastTextPart(message, tag)) {
            continue
        }

        const syntheticPart = createSyntheticTextPart(message, tag)
        const firstToolIndex = message.parts.findIndex((p) => p.type === "tool")
        if (firstToolIndex === -1) {
            message.parts.push(syntheticPart)
        } else {
            message.parts.splice(firstToolIndex, 0, syntheticPart)
        }
    }
}
