/** 会话初始化遇到不兼容状态时告警并按会话禁用，不得重建或覆盖旧状态。 */
import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import {
    applyPendingCompressionDurations,
    type CompressionTimingState,
    type PendingCompressionDuration,
} from "../compress/timing"
import {
    IncompatibleSessionStateError,
    SESSION_STATE_SCHEMA_VERSION,
    loadSessionState,
    saveSessionState,
} from "./persistence"
import { createModelLimitCatalog } from "./model-limits"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
    createPruneMessagesState,
    loadPruneMessagesState,
} from "./utils"

/**
 * Per-turn state update (compaction detection + turn count). Extracted from the
 * old `checkSession`; session-switch + init now live in SessionStateRegistry.
 */
export async function updatePerTurnState(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): Promise<void> {
    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        resetOnCompaction(state)
        logger.info("Detected compaction - reset stale state", {
            timestamp: lastCompactionTimestamp,
        })

        saveSessionState(state, logger).catch((error) => {
            logger.warn("Failed to persist state reset after compaction", {
                error: error instanceof Error ? error.message : String(error),
            })
        })
    }

    state.currentTurn = countTurns(state, messages)
}

// Soft cap on held sessions — guards a long-lived plugin process (daemon mode)
// from unbounded growth. Evicted sessions reload from persisted JSON on next
// access; modelContextLimit and all persisted fields survive eviction.
const REGISTRY_SOFT_CAP = 32

// [FIX #33] Per-session state. Replaces the single shared SessionState singleton
// whose resetSessionState-on-switch wiped modelContextLimit (set only by
// system.transform, which fires AFTER messages.transform) and flipped
// isSubAgent across interleaved sessions. Each session now keeps its
// own state for its lifetime — no reset-on-switch.
//
// compressionTiming is SHARED (hoisted here) rather than per-session: the `event`
// hook carries no sessionID, and a per-session map would let the event hook
// delete start entries in the wrong session (leaving the owning session
// dangling). One shared map = correct record/consume; the apply step
// iterates all sessions and only the owner matches (applied > 0).
export class SessionStateRegistry {
    private readonly states = new Map<string, SessionState>()
    readonly compressionTiming: CompressionTimingState = {
        startsByCallId: new Map<string, number>(),
        pendingByCallId: new Map<string, PendingCompressionDuration>(),
    }

    // [FIX #312] Model-limit catalog (full rationale in ./model-limits.ts):
    // lets the messages hook reconcile state.modelContextLimit against the
    // model named on the request's user message instead of waiting one turn
    // for the system hook. Shared implementation — the test registry stub
    // composes the same factory.
    private readonly catalog = createModelLimitCatalog()

    constructor(private readonly logger: Logger) {}

    recordModelLimit(
        providerId: string | undefined,
        modelId: string | undefined,
        limit: number | undefined,
    ): void {
        this.catalog.record(providerId, modelId, limit)
    }

    resolveModelLimit(
        providerId: string | undefined,
        modelId: string | undefined,
    ): number | undefined {
        return this.catalog.resolve(providerId, modelId)
    }

    /**
     * Best-effort one-time seed from the host's provider catalog
     * (`client.config.providers()` → GET /config/providers). Never throws;
     * returns the number of model-limit entries recorded.
     */
    hydrateModelLimitsFromClient(client: unknown): Promise<number> {
        return this.catalog.hydrateFromClient(client)
    }

    get(sessionId: string): SessionState | undefined {
        return this.states.get(sessionId)
    }

    all(): SessionState[] {
        return Array.from(this.states.values())
    }

    get size(): number {
        return this.states.size
    }

    // Idempotent: ensureSessionInitialized returns immediately once
    // state.sessionId === sessionId (assigned synchronously before any await),
    // so repeat calls for the same session never re-reset.
    async getOrCreate(
        client: any,
        sessionId: string,
        messages: WithParts[],
        config?: PluginConfig,
    ): Promise<SessionState> {
        let state = this.states.get(sessionId)
        if (!state) {
            state = createSessionState()
            // Assign shared compressionTiming BEFORE ensureSessionInitialized so
            // its init-time applyPendingCompressionDurations reads the shared map.
            state.compressionTiming = this.compressionTiming
            this.states.set(sessionId, state)
            this.enforceSoftCap()
        }
        try {
            await ensureSessionInitialized(client, state, sessionId, this.logger, messages, config)
        } catch (err: any) {
            this.logger.error("Failed to initialize session state", {
                error: err.message,
            })
        }
        return state
    }

    private enforceSoftCap(): void {
        if (this.states.size <= REGISTRY_SOFT_CAP) return
        const oldest = this.states.keys().next().value
        if (oldest !== undefined) {
            this.states.delete(oldest as string)
            this.logger.info("SessionStateRegistry evicted session (soft cap)", {
                sessionId: oldest,
                remaining: this.states.size,
            })
        }
    }
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        isSubAgent: false,
        disabledReason: undefined,
        compressPermission: undefined,
        prune: {
            messages: createPruneMessagesState(),
        },
        nudges: {
            lastPerMessageNudgeTokens: undefined,
            lastCompressibleNudgeTokens: undefined,
            lastNudgeShownTokens: undefined,
            lastToolOutputNudgeTokens: undefined,
            lastTier2NudgeTokens: undefined,
            lastTier3NudgeTokens: undefined,
            shouldInjectThisTurn: undefined,
            pendingSystemNudge: undefined,
            compressBaselineSet: false,
            lastProcessedCompressMessageId: undefined,
            pendingCompression: undefined,
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        compressionTiming: {
            startsByCallId: new Map<string, number>(),
            pendingByCallId: new Map(),
        },
        toolParameters: new Map<string, ToolParameterEntry>(),
        toolIdList: [],
        messageIds: {
            byRawId: new Map<string, string>(),
            byRef: new Map<string, string>(),
            nextRef: 1,
        },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        modelProviderID: undefined,
        modelID: undefined,
        systemPromptTokens: undefined,
        qualityGateRetryPending: false,
    }
}

export function resetSessionState(state: SessionState): void {
    state.sessionId = null
    state.isSubAgent = false
    state.disabledReason = undefined
    state.compressPermission = undefined
    state.prune = {
        messages: createPruneMessagesState(),
    }
    state.nudges = {
        lastPerMessageNudgeTokens: undefined,
        lastCompressibleNudgeTokens: undefined,
        lastNudgeShownTokens: undefined,
        lastToolOutputNudgeTokens: undefined,
        lastTier2NudgeTokens: undefined,
        lastTier3NudgeTokens: undefined,
        shouldInjectThisTurn: undefined,
        pendingSystemNudge: undefined,
        compressBaselineSet: false,
        lastProcessedCompressMessageId: undefined,
        pendingCompression: undefined,
    }
    state.stats = {
        pruneTokenCounter: 0,
        totalPruneTokens: 0,
    }
    state.toolParameters.clear()
    state.toolIdList = []
    state.messageIds = {
        byRawId: new Map<string, string>(),
        byRef: new Map<string, string>(),
        nextRef: 1,
    }
    state.lastCompaction = 0
    state.currentTurn = 0
    state.modelContextLimit = undefined
    state.modelProviderID = undefined
    state.modelID = undefined
    state.systemPromptTokens = undefined
    state.qualityGateRetryPending = false
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    _config?: PluginConfig,
): Promise<void> {
    if (state.sessionId === sessionId) {
        return
    }

    resetSessionState(state)
    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)

    let persisted
    try {
        persisted = await loadSessionState(sessionId, logger)
    } catch (error) {
        if (!(error instanceof IncompatibleSessionStateError)) {
            throw error
        }

        state.disabledReason = error.message
        state.compressPermission = "deny"
        logger.warn("ACP disabled for incompatible session", {
            sessionId,
            actualSchemaVersion: error.actualSchemaVersion,
            expectedSchemaVersion: SESSION_STATE_SCHEMA_VERSION,
        })
        try {
            await client?.tui?.showToast?.({
                body: {
                    title: "ACP disabled for this session",
                    message:
                        `${error.message} Start a new session to use ACP, or reopen this ` +
                        "session with an ACP version that supports its state.",
                    variant: "warning",
                    duration: 10000,
                },
            })
        } catch (notificationError) {
            logger.warn("Failed to show incompatible session warning", {
                sessionId,
                error:
                    notificationError instanceof Error
                        ? notificationError.message
                        : String(notificationError),
            })
        }
        return
    }
    if (persisted === null) {
        // State schemas are intentionally not migrated or replayed. A session
        // without current state starts a fresh A-generation context graph.
        return
    }

    state.prune.messages = loadPruneMessagesState(persisted.prune.messages)
    state.nudges.lastPerMessageNudgeTokens = persisted.nudges.lastPerMessageNudgeTokens
    state.nudges.lastCompressibleNudgeTokens = persisted.nudges.lastCompressibleNudgeTokens
    state.nudges.lastNudgeShownTokens = persisted.nudges.lastNudgeShownTokens
    state.nudges.lastToolOutputNudgeTokens = persisted.nudges.lastToolOutputNudgeTokens
    state.nudges.lastTier2NudgeTokens =
        persisted.nudges.lastTier2NudgeTokens ?? persisted.nudges.lastTierNudgeTokens
    state.nudges.lastTier3NudgeTokens = persisted.nudges.lastTier3NudgeTokens
    state.nudges.compressBaselineSet = persisted.nudges.compressBaselineSet ?? false
    state.nudges.pendingCompression = persisted.nudges.pendingCompression
    state.stats = {
        pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
    }

    const persistedAny = persisted as any
    if (persistedAny._persistedMessageIds) {
        state.messageIds = {
            byRawId: new Map(Object.entries(persistedAny._persistedMessageIds.byRawId || {})),
            byRef: new Map(Object.entries(persistedAny._persistedMessageIds.byRef || {})),
            nextRef: persistedAny._persistedMessageIds.nextRef || 1,
        }
        // [FIX Bug 29] Auto-cleanup stale synthetic message refs from persistence
        for (const [rawId, ref] of state.messageIds.byRawId) {
            if (rawId.startsWith("msg_dcp_summary_") || rawId.startsWith("msg_dcp_text_")) {
                state.messageIds.byRawId.delete(rawId)
                state.messageIds.byRef.delete(ref)
            }
        }
    }
    if (persistedAny._persistedLastCompaction !== undefined) {
        state.lastCompaction = Math.max(state.lastCompaction, persistedAny._persistedLastCompaction)
    }
    if (typeof persisted.modelContextLimit === "number" && persisted.modelContextLimit > 0) {
        state.modelContextLimit = persisted.modelContextLimit
        // Restore the identity pair together with the limit (persisted as a
        // pair in saveSessionState) so the messages-hook staleness check
        // survives restarts. Invalid/absent limit → fresh undefined pair.
        state.modelProviderID = persisted.modelProviderID
        state.modelID = persisted.modelID
    }

    const applied = applyPendingCompressionDurations(state)
    if (applied > 0) {
        await saveSessionState(state, logger)
    }
    // [FIX Bug 1] Always save after initialization to persist messageIds + lastCompaction
    await saveSessionState(state, logger)
}
