import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import type { PromptStore } from "../prompts/store"
import type { CompressionBlock, CompressionMode, SessionState, WithParts } from "../state"
import type { SessionStateRegistry } from "../state"

export interface ToolContext {
    client: any
    state: SessionState
    logger: Logger
    config: PluginConfig
    prompts: PromptStore
}

export interface ToolFactoryContext {
    client: any
    registry: SessionStateRegistry
    logger: Logger
    config: PluginConfig
    prompts: PromptStore
}

// [FIX #33] Resolve the caller's per-session state at tool-call time and build a
// ToolContext bound to it. A compress tool can only run after messages.transform
// initialized the session, so the state is guaranteed present.
export function resolveToolContext(factoryCtx: ToolFactoryContext, sessionID: string): ToolContext {
    const state = factoryCtx.registry.get(sessionID)
    if (!state) {
        throw new Error(
            `ACP: session ${sessionID} has no initialized state. ` +
                "messages.transform must run before a compress tool call.",
        )
    }
    return {
        client: factoryCtx.client,
        state,
        logger: factoryCtx.logger,
        config: factoryCtx.config,
        prompts: factoryCtx.prompts,
    }
}

export interface CompressSelectionToolArgs {
    /** Candidate blocks that must remain verbatim. Omitted candidates are compressed. */
    keep: string[]
    /** Durable facts confirmed by the consumed blocks. */
    confirmedFacts: string[]
    /** Concrete unfinished work that must survive compression. */
    nextSteps: string[]
}

export interface BoundaryReference {
    kind: "message" | "compressed-block"
    rawIndex: number
    messageId?: string
    blockId?: number
    anchorMessageId?: string
}

export interface SearchContext {
    rawMessages: WithParts[]
    rawMessagesById: Map<string, WithParts>
    rawIndexById: Map<string, number>
    summaryByBlockId: Map<number, CompressionBlock>
}

export interface SelectionResolution {
    startReference: BoundaryReference
    endReference: BoundaryReference
    messageIds: string[]
    messageTokenById: Map<string, number>
    toolIds: string[]
    requiredBlockIds: number[]
}

export interface AppliedCompressionResult {
    compressedTokens: number
    messageIds: string[]
    newlyCompressedMessageIds: string[]
    newlyCompressedToolIds: string[]
}

export interface CompressionStateInput {
    topic: string
    batchTopic: string | undefined
    startId: string
    endId: string
    mode: CompressionMode
    runId: number
    compressMessageId: string
    compressCallId?: string
    summaryTokens: number
}
