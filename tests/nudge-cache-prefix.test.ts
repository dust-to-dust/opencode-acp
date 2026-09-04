import assert from "node:assert/strict"
import test from "node:test"
import { appendEphemeralCompressionNudge } from "../lib/messages/utils"
import type { WithParts } from "../lib/state"

function user(id: string, text: string): WithParts {
    return {
        info: {
            id,
            sessionID: "cache-prefix-session",
            role: "user",
            agent: "build",
            model: { providerID: "test", modelID: "model" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                sessionID: "cache-prefix-session",
                messageID: id,
                type: "text",
                text,
            },
        ],
    }
}

test("ephemeral compression nudge changes only the final message suffix", () => {
    const history = [user("u1", "original request")]
    const withoutNudge = structuredClone(history)
    const withNudge = structuredClone(history)
    const nudge = "[ACP COMPRESSION REQUIRED]\nEligible blocks: A1\nCache boundary: A1"

    appendEphemeralCompressionNudge(withNudge, nudge)

    assert.deepEqual(withNudge.slice(0, -1), withoutNudge)
    assert.equal(withNudge.at(-1)?.info.role, "user")
    assert.equal((withNudge.at(-1) as any).__acpEphemeralCompressionNudge, true)
    assert.equal((withNudge.at(-1) as any).info.ignored, undefined)
    assert.match((withNudge.at(-1)!.parts[0] as any).text, /A1/)
    assert.equal(
        JSON.stringify({ messages: withoutNudge }),
        JSON.stringify({ messages: withNudge.slice(0, -1) }),
    )
})

test("ephemeral compression nudge is deterministic and idempotent", () => {
    const messages = [user("u1", "original request")]
    const first = appendEphemeralCompressionNudge(messages, "nudge A")!
    const firstSnapshot = structuredClone(first)
    const second = appendEphemeralCompressionNudge(messages, "nudge A")!

    assert.equal(messages.length, 2)
    assert.deepEqual(second, firstSnapshot)
    assert.equal(messages.at(-1), second)
    assert.equal(appendEphemeralCompressionNudge(messages, "   "), undefined)
    assert.equal(messages.length, 2)
})
