import assert from "node:assert/strict"
import test from "node:test"
import { messageContainsProtectedTool } from "../lib/compress/protected-content"
import type { WithParts } from "../lib/state"

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function toolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    tool: string,
    output: string,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool,
        callID,
        state: {
            status: "completed" as const,
            input: { description: "demo" },
            output,
        },
    }
}

test("messageContainsProtectedTool detects skill tool output", () => {
    const msg: WithParts = {
        info: {
            id: "msg-1",
            role: "assistant",
            sessionID: "ses-1",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            textPart("msg-1", "ses-1", "p-1", "text before"),
            toolPart("msg-1", "ses-1", "call-1", "skill", "skill output"),
        ],
    }

    assert.equal(
        messageContainsProtectedTool(msg, ["task", "skill", "todowrite"]),
        true,
        "skill tool should be detected as protected",
    )
})

test("messageContainsProtectedTool returns false for non-protected tools", () => {
    const msg: WithParts = {
        info: {
            id: "msg-1",
            role: "assistant",
            sessionID: "ses-1",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [toolPart("msg-1", "ses-1", "call-1", "bash", "command output")],
    }

    assert.equal(
        messageContainsProtectedTool(msg, ["task", "skill", "todowrite"]),
        false,
        "bash tool should not be detected as protected",
    )
})

test("messageContainsProtectedTool returns false for plain text messages", () => {
    const msg: WithParts = {
        info: {
            id: "msg-1",
            role: "user",
            sessionID: "ses-1",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [textPart("msg-1", "ses-1", "p-1", "just a text message")],
    }

    assert.equal(
        messageContainsProtectedTool(msg, ["task", "skill"]),
        false,
        "text-only message should not be detected as protected",
    )
})

test("messageContainsProtectedTool detects protected file patterns", () => {
    const msg: WithParts = {
        info: {
            id: "msg-1",
            role: "assistant",
            sessionID: "ses-1",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: "call-write-1-part",
                messageID: "msg-1",
                sessionID: "ses-1",
                type: "tool" as const,
                tool: "write",
                callID: "call-write-1",
                state: {
                    status: "completed" as const,
                    input: { filePath: "/home/user/secrets/.env" },
                    output: "wrote file",
                },
            },
        ],
    }

    assert.equal(
        messageContainsProtectedTool(msg, [], ["/home/user/secrets/**"]),
        true,
        "write tool matching protected file pattern should be detected",
    )
})
