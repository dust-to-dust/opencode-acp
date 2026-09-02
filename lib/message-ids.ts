import type { SessionState, WithParts } from "./state"
import { isIgnoredUserMessage, messageHasCompressAttempt } from "./messages/query"

// Model-facing references are deliberately not compatible with the old padded form.
const MESSAGE_REF_REGEX = /^a([1-9]\d*)$/
const BLOCK_REF_REGEX = /^((?:[b-z]|[a-z]{2,}))([1-9]\d*)$/
const MESSAGE_ID_TAG_NAME = "dcp-message-id"

const MESSAGE_REF_MIN_INDEX = 1
const MESSAGE_REF_MAX_INDEX = 99999

export type ParsedBoundaryId =
    | {
          kind: "message"
          ref: string
          index: number
      }
    | {
          kind: "compressed-block"
          ref: string
          blockId: number
      }

export function formatMessageRef(index: number): string {
    if (
        !Number.isInteger(index) ||
        index < MESSAGE_REF_MIN_INDEX ||
        index > MESSAGE_REF_MAX_INDEX
    ) {
        throw new Error(
            `Message ID index out of bounds: ${index}. Supported range is ${MESSAGE_REF_MIN_INDEX}-${MESSAGE_REF_MAX_INDEX}.`,
        )
    }
    return `A${index}`
}

export function formatBlockRef(blockId: number, tier = 1): string {
    if (!Number.isInteger(blockId) || blockId < 1) {
        throw new Error(`Invalid block ID: ${blockId}`)
    }
    if (!Number.isInteger(tier) || tier < 1) {
        throw new Error(`Invalid compression generation: ${tier}`)
    }
    return `${formatGenerationLabel(tier)}${blockId}`
}

/** A is raw activity (level 0), B is one compression, C is two, and so on. */
export function formatGenerationLabel(level: number): string {
    if (!Number.isInteger(level) || level < 0) {
        throw new Error(`Invalid context generation: ${level}`)
    }

    let value = level + 1
    let label = ""
    while (value > 0) {
        value--
        label = String.fromCharCode(65 + (value % 26)) + label
        value = Math.floor(value / 26)
    }
    return label
}

export function parseGenerationLabel(label: string): number | null {
    const normalized = label.trim().toUpperCase()
    if (!/^[A-Z]+$/.test(normalized)) return null

    let value = 0
    for (const char of normalized) {
        value = value * 26 + (char.charCodeAt(0) - 64)
    }
    return value - 1
}

export function parseMessageRef(ref: string): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(MESSAGE_REF_REGEX)
    if (!match) {
        return null
    }
    const index = Number.parseInt(match[1], 10)
    if (!Number.isInteger(index)) {
        return null
    }
    if (index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) {
        return null
    }
    return index
}

export function parseBlockRef(ref: string): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(BLOCK_REF_REGEX)
    if (!match) {
        return null
    }
    const generation = parseGenerationLabel(match[1])
    if (generation === null || generation < 1) {
        return null
    }
    const id = Number.parseInt(match[2], 10)
    return Number.isInteger(id) && id >= 1 ? id : null
}

export function parseBlockGeneration(ref: string): number | null {
    const match = ref.trim().toLowerCase().match(BLOCK_REF_REGEX)
    if (!match) return null
    const generation = parseGenerationLabel(match[1])
    return generation !== null && generation >= 1 ? generation : null
}

export function parseBoundaryId(id: string): ParsedBoundaryId | null {
    const normalized = id.trim().toLowerCase()
    const messageIndex = parseMessageRef(normalized)
    if (messageIndex !== null) {
        return {
            kind: "message",
            ref: formatMessageRef(messageIndex),
            index: messageIndex,
        }
    }

    const blockId = parseBlockRef(normalized)
    if (blockId !== null) {
        return {
            kind: "compressed-block",
            ref: formatBlockRef(blockId, parseBlockGeneration(normalized) ?? 1),
            blockId,
        }
    }

    return null
}

function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

export function formatMessageIdTag(
    ref: string,
    attributes?: Record<string, string | undefined>,
): string {
    const serializedAttributes = Object.entries(attributes || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => {
            if (name.trim().length === 0 || typeof value !== "string" || value.length === 0) {
                return ""
            }

            return ` ${name}="${escapeXmlAttribute(value)}"`
        })
        .join("")

    return `\n<${MESSAGE_ID_TAG_NAME}${serializedAttributes}>${ref}</${MESSAGE_ID_TAG_NAME}>`
}

export function formatTokenSize(tokens: number): string {
    if (tokens < 1000) return String(tokens)
    if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}K`
    return `${Math.round(tokens / 1000)}K`
}

export function classifyMessageType(parts: WithParts["parts"]): string {
    let hasTool = false
    let hasText = false
    let hasReasoning = false
    const toolNames: string[] = []

    for (const part of parts) {
        if (part.type === "tool") {
            hasTool = true
            if (typeof part.tool === "string" && !toolNames.includes(part.tool)) {
                toolNames.push(part.tool)
            }
        } else if (part.type === "text") {
            hasText = true
        } else if (part.type === "reasoning") {
            hasReasoning = true
        }
    }

    if (hasTool) {
        return toolNames.length > 0 ? `tool:${toolNames.join(",")}` : "tool"
    }
    if (hasReasoning && !hasText) return "reasoning"
    return "text"
}

export function assignMessageRefs(state: SessionState, messages: WithParts[]): number {
    let assigned = 0
    let skippedSubAgentPrompt = false

    const activityMessages: WithParts[] = []
    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        // Compression calls are checkpoint carriers. They receive the B/C/...
        // block ref created by that call, never a new raw A ref.
        if (messageHasCompressAttempt(message)) {
            continue
        }

        if (state.isSubAgent && !skippedSubAgentPrompt && message.info.role === "user") {
            skippedSubAgentPrompt = true
            continue
        }

        const rawMessageId = message.info.id
        if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
            continue
        }
        // [FIX Bug 29] Skip synthetic messages created by DCP
        if (
            rawMessageId.startsWith("msg_dcp_summary_") ||
            rawMessageId.startsWith("msg_dcp_text_")
        ) {
            continue
        }

        activityMessages.push(message)
    }

    const parent = new Map<string, string>()
    const firstMessageByCallId = new Map<string, string>()
    const find = (rawId: string): string => {
        const current = parent.get(rawId) ?? rawId
        if (current === rawId) return rawId
        const root = find(current)
        parent.set(rawId, root)
        return root
    }
    const union = (left: string, right: string): void => {
        const leftRoot = find(left)
        const rightRoot = find(right)
        if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot)
    }

    for (const message of activityMessages) {
        const rawId = message.info.id
        parent.set(rawId, rawId)
        for (const part of message.parts ?? []) {
            if (part.type !== "tool" || typeof part.callID !== "string" || !part.callID) continue
            const firstRawId = firstMessageByCallId.get(part.callID)
            if (firstRawId) union(firstRawId, rawId)
            else firstMessageByCallId.set(part.callID, rawId)
        }
    }

    const groups = new Map<string, WithParts[]>()
    for (const message of activityMessages) {
        const root = find(message.info.id)
        const group = groups.get(root) ?? []
        group.push(message)
        groups.set(root, group)
    }

    for (const group of groups.values()) {
        const ref =
            group
                .map((message) => state.messageIds.byRawId.get(message.info.id))
                .find((candidate): candidate is string => candidate !== undefined) ??
            allocateNextMessageRef(state)

        for (const message of group) {
            const rawMessageId = message.info.id
            const existingRef = state.messageIds.byRawId.get(rawMessageId)
            const stableRef = existingRef ?? ref

            if (existingRef === undefined) {
                assigned++
                state.messageIds.byRawId.set(rawMessageId, stableRef)
            }

            // A ref is an immutable identity. In particular, do not replace the
            // representative when a tool activity is reloaded after pruning.
            if (!state.messageIds.byRef.has(stableRef)) {
                state.messageIds.byRef.set(stableRef, rawMessageId)
            }
        }
    }

    return assigned
}

function allocateNextMessageRef(state: SessionState): string {
    let candidate = Number.isInteger(state.messageIds.nextRef)
        ? Math.max(MESSAGE_REF_MIN_INDEX, state.messageIds.nextRef)
        : MESSAGE_REF_MIN_INDEX

    while (candidate <= MESSAGE_REF_MAX_INDEX) {
        const ref = formatMessageRef(candidate)
        if (!state.messageIds.byRef.has(ref)) {
            state.messageIds.nextRef = candidate + 1
            return ref
        }
        candidate++
    }

    throw new Error(
        `Message ID capacity exceeded. Cannot allocate more than ${formatMessageRef(MESSAGE_REF_MAX_INDEX)} references in this session.`,
    )
}
