/** 压缩执行前完成候选、摘要与实际收益校验，失败不改变 pending 状态。 */
import { tool } from "@opencode-ai/plugin"
import { countAllMessageTokens, countTokens, getCurrentTokenUsage } from "../token-utils"
import { formatBlockRef, parseBlockRef, parseMessageRef } from "../message-ids"
import { saveSessionState } from "../state/persistence"
import type { WithParts } from "../state"
import {
    finalizeSession,
    prepareSession,
    restoreCompressionState,
    snapshotCompressionState,
    type NotificationEntry,
} from "./pipeline"
import {
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import {
    type CompressSelectionToolArgs,
    type SelectionResolution,
    type ToolContext,
    type ToolFactoryContext,
    resolveToolContext,
} from "./types"
import { buildCompressionCandidates } from "../messages/inject/inject"
import {
    applyCompressOverrides,
    computeProtectedRefs,
    getModelInfo,
} from "../messages/inject/utils"

function buildSchema() {
    return {
        keep: tool.schema
            .array(tool.schema.string())
            .describe(
                "Required. Exact eligible block IDs to retain verbatim. Every eligible block omitted from keep is compressed. Use [] to compress all eligible blocks.",
            ),
        confirmedFacts: tool.schema
            .array(tool.schema.string())
            .describe(
                "Required. Durable facts, decisions, constraints, and results extracted from eligible blocks omitted from keep. Use [] only when no such facts must survive.",
            ),
        nextSteps: tool.schema
            .array(tool.schema.string())
            .describe(
                "Required. Concrete unfinished work extracted from eligible blocks omitted from keep. Use [] when none remains.",
            ),
    }
}

function renderCheckpointSummary(confirmedFacts: string[], nextSteps: string[]): string {
    const sections: string[] = []
    if (confirmedFacts.length > 0) {
        sections.push(
            `Confirmed facts:\n${confirmedFacts.map((fact) => `- ${fact.trim()}`).join("\n")}`,
        )
    }
    if (nextSteps.length > 0) {
        sections.push(`Next steps:\n${nextSteps.map((step) => `- ${step.trim()}`).join("\n")}`)
    }
    return sections.join("\n\n")
}

function toolIdsForMessages(messages: WithParts[]): string[] {
    const ids = new Set<string>()
    for (const message of messages) {
        for (const part of message.parts ?? []) {
            if (part.type === "tool" && typeof part.callID === "string") {
                ids.add(part.callID)
            }
        }
    }
    return [...ids]
}

function getCompressibleTokens(ctx: ToolContext, rawMessages: WithParts[]): number {
    const { providerId, modelId } = getModelInfo(rawMessages)
    const config = applyCompressOverrides(ctx.config, providerId, modelId)
    const protectedRefs = computeProtectedRefs(rawMessages, ctx.state, config.compress)
    return buildCompressionCandidates(ctx.state, config, rawMessages, protectedRefs).tokens
}

function buildSelection(
    input: CompressSelectionToolArgs,
    candidates: string[],
    rawMessages: WithParts[],
    state: ReturnType<typeof resolveToolContext>["state"],
): {
    droppedRefs: string[]
    consumedBlockIds: number[]
    selection: SelectionResolution
    anchorMessageId: string
} {
    const normalizedKeep = input.keep.map((ref) => ref.trim().toUpperCase())
    if (new Set(normalizedKeep).size !== normalizedKeep.length) {
        throw new Error("keep contains duplicate block IDs.")
    }

    const candidateSet = new Set(candidates)
    const unknown = normalizedKeep.filter((ref) => !candidateSet.has(ref))
    if (unknown.length > 0) {
        throw new Error(
            `keep contains blocks outside the pending candidate set: ${unknown.join(", ")}. Use only the IDs in the current ACP compression request.`,
        )
    }

    const keepSet = new Set(normalizedKeep)
    const droppedRefs = candidates.filter((ref) => !keepSet.has(ref))
    const rawById = new Map(rawMessages.map((message) => [message.info.id, message]))
    const rawIndexById = new Map(rawMessages.map((message, index) => [message.info.id, index]))
    const directMessageIds: string[] = []
    const consumedBlockIds: number[] = []

    for (const ref of droppedRefs) {
        if (parseMessageRef(ref) !== null) {
            const rawIds = Array.from(state.messageIds.byRawId.entries())
                .filter(([, messageRef]) => messageRef === ref)
                .map(([rawId]) => rawId)
            if (rawIds.length === 0 || rawIds.some((rawId) => !rawById.has(rawId))) {
                throw new Error(
                    `Pending block ${ref} is stale. Wait for ACP to issue a fresh request.`,
                )
            }
            for (const rawId of rawIds) {
                if ((state.prune.messages.byMessageId.get(rawId)?.activeBlockIds.length ?? 0) > 0) {
                    throw new Error(
                        `Pending block ${ref} is already compressed. Wait for a fresh request.`,
                    )
                }
                directMessageIds.push(rawId)
            }
            continue
        }

        const blockId = parseBlockRef(ref)
        const block = blockId === null ? undefined : state.prune.messages.blocksById.get(blockId)
        const expectedRef = block
            ? (block.ref ?? formatBlockRef(block.blockId, block.tier ?? 1))
            : undefined
        if (!block || !block.active || expectedRef !== ref) {
            throw new Error(
                `Pending checkpoint ${ref} is stale. Wait for ACP to issue a fresh request.`,
            )
        }
        consumedBlockIds.push(block.blockId)
    }

    const directMessages = directMessageIds
        .map((id) => rawById.get(id))
        .filter((message): message is WithParts => message !== undefined)
    const messageTokenById = new Map(
        directMessages.map((message) => [message.info.id, countAllMessageTokens(message)]),
    )
    const firstRawId = directMessageIds[0]
    const lastRawId = directMessageIds[directMessageIds.length - 1]
    const firstBlock = state.prune.messages.blocksById.get(consumedBlockIds[0] ?? -1)
    const lastBlock = state.prune.messages.blocksById.get(
        consumedBlockIds[consumedBlockIds.length - 1] ?? -1,
    )
    const startReference = firstRawId
        ? ({
              kind: "message",
              rawIndex: rawIndexById.get(firstRawId) ?? 0,
              messageId: firstRawId,
          } as const)
        : ({
              kind: "compressed-block",
              rawIndex: rawIndexById.get(firstBlock?.compressMessageId ?? "") ?? 0,
              blockId: firstBlock?.blockId,
              anchorMessageId: firstBlock?.anchorMessageId,
          } as const)
    const endReference = lastRawId
        ? ({
              kind: "message",
              rawIndex: rawIndexById.get(lastRawId) ?? 0,
              messageId: lastRawId,
          } as const)
        : ({
              kind: "compressed-block",
              rawIndex: rawIndexById.get(lastBlock?.compressMessageId ?? "") ?? 0,
              blockId: lastBlock?.blockId,
              anchorMessageId: lastBlock?.anchorMessageId,
          } as const)
    const inheritedAnchor = lastBlock?.anchorMessageId ?? firstBlock?.anchorMessageId
    const anchorMessageId = lastRawId ?? inheritedAnchor ?? directMessageIds[0]
    if (!anchorMessageId && droppedRefs.length > 0) {
        throw new Error("The pending candidate set no longer resolves to conversation content.")
    }

    return {
        droppedRefs,
        consumedBlockIds,
        anchorMessageId: anchorMessageId ?? "",
        selection: {
            startReference,
            endReference,
            messageIds: directMessageIds,
            messageTokenById,
            toolIds: toolIdsForMessages(directMessages),
            requiredBlockIds: consumedBlockIds,
        },
    }
}

export function createCompressRangeTool(factoryCtx: ToolFactoryContext): ReturnType<typeof tool> {
    factoryCtx.prompts.reload()
    const runtimePrompts = factoryCtx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressRange,
        args: buildSchema(),
        async execute(args, toolCtx) {
            const ctx = resolveToolContext(factoryCtx, toolCtx.sessionID)
            const input = args as CompressSelectionToolArgs
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            if (ctx.logger.level === "debug") {
                ctx.logger.debug(
                    `[ACP Debug] Compress tool call:${JSON.stringify({
                        type: "tool",
                        tool: "compress",
                        callID: callId,
                        messageID: toolCtx.messageID,
                        sessionID: toolCtx.sessionID,
                        state: { input },
                    })}`,
                )
            }

            const pending = ctx.state.nudges.pendingCompression
            if (!pending) {
                throw new Error(
                    "ACP has no pending compression request. Continue the task until ACP asks for compression.",
                )
            }

            const { rawMessages } = await prepareSession(ctx, toolCtx, "Select context blocks")
            const candidates = [...pending.candidates]
            const plan = buildSelection(input, candidates, rawMessages, ctx.state)

            if (plan.droppedRefs.length === 0) {
                throw new Error(
                    "Compression is required. keep must omit at least one eligible block.",
                )
            }

            const facts = input.confirmedFacts.map((fact) => fact.trim()).filter(Boolean)
            const steps = input.nextSteps.map((step) => step.trim()).filter(Boolean)
            const summary = renderCheckpointSummary(facts, steps)
            if (!summary) {
                throw new Error(
                    "confirmedFacts and nextSteps cannot both be empty when blocks are compressed.",
                )
            }
            if (summary.length > ctx.config.compress.maxSummaryLengthHard) {
                throw new Error(
                    `Checkpoint too long (${summary.length} chars, max ${ctx.config.compress.maxSummaryLengthHard}). Keep more source blocks or retain fewer durable facts.`,
                )
            }

            const snapshot = snapshotCompressionState(ctx.state)
            const runId = allocateRunId(ctx.state)
            const blockId = allocateBlockId(ctx.state)
            const outputTier =
                1 +
                Math.max(
                    0,
                    ...plan.consumedBlockIds.map(
                        (id) => ctx.state.prune.messages.blocksById.get(id)?.tier ?? 1,
                    ),
                )
            const storedSummary = wrapCompressedSummary(blockId, outputTier, summary)
            const summaryTokens = countTokens(storedSummary)
            const selectedSourceTokens =
                [...plan.selection.messageTokenById.values()].reduce(
                    (total, tokens) => total + tokens,
                    0,
                ) +
                plan.consumedBlockIds.reduce(
                    (total, id) =>
                        total +
                        (ctx.state.prune.messages.blocksById.get(id)?.effectiveCompressedTokens ??
                            ctx.state.prune.messages.blocksById.get(id)?.compressedTokens ??
                            0),
                    0,
                )
            const fixedOverheadTokens = countTokens("Confirmed facts:\n\nNext steps:")
            if (selectedSourceTokens - summaryTokens - fixedOverheadTokens <= 0) {
                throw new Error(
                    "Compression would not reduce context size; keep more source blocks or provide a shorter summary.",
                )
            }
            const notifications: NotificationEntry[] = []

            try {
                const applied = applyCompressionState(
                    ctx.state,
                    {
                        topic: "Context checkpoint",
                        batchTopic: undefined,
                        startId: plan.droppedRefs[0],
                        endId: plan.droppedRefs[plan.droppedRefs.length - 1],
                        mode: "range",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    plan.selection,
                    plan.anchorMessageId,
                    blockId,
                    storedSummary,
                    plan.consumedBlockIds,
                    ctx.config.gc,
                )

                ctx.state.nudges.pendingCompression = undefined
                ctx.state.nudges.lastNudgeShownTokens = undefined
                ctx.state.nudges.lastCompressibleNudgeTokens = getCompressibleTokens(
                    ctx,
                    rawMessages,
                )
                ctx.state.nudges.lastPerMessageNudgeTokens = getCurrentTokenUsage(
                    ctx.state,
                    rawMessages,
                )
                ctx.state.nudges.shouldInjectThisTurn = false
                ctx.state.nudges.compressBaselineSet = true
                notifications.push({ blockId, runId, summary, summaryTokens })
                await finalizeSession(ctx, toolCtx, rawMessages, notifications, undefined)

                const ref = formatBlockRef(blockId, outputTier)
                return `Compressed ${plan.droppedRefs.length} block(s) into ${ref}; kept ${input.keep.length}. Continue the task using the retained blocks and checkpoint.`
            } catch (error) {
                restoreCompressionState(ctx.state, snapshot)
                throw error
            }
        },
    })
}
