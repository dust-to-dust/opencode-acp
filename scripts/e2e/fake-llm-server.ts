#!/usr/bin/env bun
/**
 * Fake OpenAI-compatible LLM server for ACP scheduler E2E tests.
 *
 * The server grows a real OpenCode conversation until ACP appends its fixed-tail
 * compression request. It then submits the new keep/facts/steps selection call.
 */

import { existsSync, readFileSync, writeFileSync } from "fs"

const PORT = parseInt(process.env.PORT ?? "8400", 10)
const HOST = process.env.HOST ?? "127.0.0.1"
const SCENARIO_PATH = process.env.SCENARIO
const TURN_COUNTER = process.env.TURN_COUNTER ?? "/tmp/acp-e2e-turn-counter"
const OBSERVATIONS_FILE = process.env.OBSERVATIONS ?? "/tmp/acp-e2e-observations.json"

if (!SCENARIO_PATH) {
    process.stderr.write("[fake-llm] FATAL: SCENARIO env var not set\n")
    process.exit(1)
}

interface ScenarioStep {
    respond: "nudge-compress" | "autonomous-nudge"
    summary?: string
    growthText?: string
    maxCompressCount?: number
}

interface Scenario {
    name: string
    description: string
    turns: ScenarioStep[]
}

export interface RequestObservation {
    turn: number
    inputTokens: number
    messageCount: number
    compressCallCount: number
    nudgeDetected: boolean
    lastUserTextTail: string
    isChild: boolean
    isAuxiliary: boolean
}

export interface Observations {
    requests: RequestObservation[]
}

const scenario: Scenario = JSON.parse(readFileSync(SCENARIO_PATH, "utf-8"))
const observations: Observations = { requests: [] }
let totalCompressionsEmitted = 0

process.stderr.write(`[fake-llm] scenario: ${scenario.name} (${scenario.turns.length} turns)\n`)

const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    fetch(req) {
        const url = new URL(req.url)
        if (req.method === "GET" && url.pathname === "/v1/models") {
            return jsonResponse({
                object: "list",
                data: [
                    {
                        id: "fake-model",
                        object: "model",
                        created: 1_700_000_000_000,
                        owned_by: "acp-e2e",
                    },
                ],
            })
        }
        if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
            return handleChatCompletion(req)
        }
        return jsonResponse({ error: `not found: ${req.method} ${url.pathname}` }, 404)
    },
})

function log(message: string): void {
    const timestamp = new Date().toISOString().slice(11, 23)
    process.stderr.write(`[fake-llm ${timestamp}] ${message}\n`)
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
    })
}

async function handleChatCompletion(req: Request): Promise<Response> {
    let body: any
    try {
        body = await req.json()
    } catch (error) {
        return jsonResponse({ error: `invalid JSON: ${(error as Error).message}` }, 400)
    }

    const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
    const tools: any[] = Array.isArray(body?.tools) ? body.tools : []
    const isStream = body?.stream === true
    const model = typeof body?.model === "string" ? body.model : "fake-model"
    const isChild = Boolean(req.headers.get("x-parent-session-id"))
    const lastMessage = messages[messages.length - 1]
    const lastRole = lastMessage?.role
    const inputTokens = computeInputTokens(messages)
    const pendingCandidates = parsePendingCandidates(messages)

    recordObservation({
        turn: readTurnCounter(),
        inputTokens,
        messageCount: messages.length,
        compressCallCount: countCompressCalls(messages),
        nudgeDetected: pendingCandidates.length > 0,
        lastUserTextTail: findLastUserText(messages).slice(-2000),
        isChild,
        isAuxiliary: tools.length === 0,
    })

    log(
        `body: stream=${isStream} msgs=${messages.length} lastRole=${lastRole} ` +
            `tools=${tools.length} inputTok=${inputTokens}`,
    )

    if (tools.length === 0) {
        return textResponse(model, "Session summary.", isStream, inputTokens)
    }

    if (lastRole === "tool" || lastRole === "function") {
        const currentStep = scenario.turns[readTurnCounter() - 1]
        if (currentStep?.respond === "autonomous-nudge") {
            return handleAutonomousStep(model, messages, currentStep, isStream, inputTokens)
        }
        if (currentStep?.respond === "nudge-compress") {
            return textResponse(model, "Compression complete.", isStream, inputTokens)
        }
        return textResponse(model, "Continuing.", isStream, inputTokens)
    }

    if (lastRole === "user") {
        const previousStep = scenario.turns[readTurnCounter() - 1]
        if (previousStep?.respond === "autonomous-nudge" && pendingCandidates.length > 0) {
            return handleAutonomousStep(model, messages, previousStep, isStream, inputTokens)
        }
    }

    const turnIndex = incrementTurnCounter()
    const step = scenario.turns[turnIndex]
    if (!step) {
        return textResponse(model, "Done.", isStream, inputTokens)
    }

    log(`turn ${turnIndex + 1}: respond=${step.respond}`)
    if (step.respond === "nudge-compress") {
        return handleNudgeStep(model, messages, step, isStream, inputTokens)
    }
    return handleAutonomousStep(model, messages, step, isStream, inputTokens)
}

function handleNudgeStep(
    model: string,
    messages: any[],
    step: ScenarioStep,
    isStream: boolean,
    inputTokens: number,
): Response {
    const candidates = parsePendingCandidates(messages)
    if (candidates.length === 0) {
        const growth = step.growthText ?? "Continuing implementation work to grow the context."
        log(`nudge-compress: no request, emitting ${growth.length} growth chars`)
        return textResponse(model, growth, isStream, inputTokens)
    }

    log(`nudge-compress: selecting from ${candidates.join(", ")}`)
    return selectionResponse(model, step, isStream, inputTokens)
}

function handleAutonomousStep(
    model: string,
    messages: any[],
    step: ScenarioStep,
    isStream: boolean,
    inputTokens: number,
): Response {
    const maxCompressions = step.maxCompressCount ?? 2
    if (totalCompressionsEmitted >= maxCompressions) {
        return textResponse(model, "Task complete.", isStream, inputTokens)
    }

    const candidates = parsePendingCandidates(messages)
    if (candidates.length > 0) {
        log(`autonomous-nudge: selecting from ${candidates.join(", ")}`)
        return selectionResponse(model, step, isStream, inputTokens)
    }

    const growth =
        step.growthText ??
        "Autonomous implementation work continues across architecture, testing, and validation."
    log("autonomous-nudge: emitting growth tool call")
    return toolUseResponse(
        model,
        "bash",
        {
            command: `echo '${growth.replace(/'/g, "'\\''")}'`,
            description: "Generate autonomous work output",
        },
        isStream,
        inputTokens,
    )
}

function selectionResponse(
    model: string,
    step: ScenarioStep,
    isStream: boolean,
    inputTokens: number,
): Response {
    totalCompressionsEmitted++
    return toolUseResponse(
        model,
        "compress",
        {
            keep: [],
            confirmedFacts: [
                step.summary ??
                    "Completed work and durable decisions from the eligible activities are preserved.",
            ],
            nextSteps: [],
        },
        isStream,
        inputTokens,
    )
}

function parsePendingCandidates(messages: any[]): string[] {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (message?.role !== "user") continue
        const text = extractMessageText(message).replace(/\r\n?/g, "\n")
        if (!text.includes("[ACP compression required]")) continue
        const match = text.match(/Eligible blocks \(oldest first\):\n([\s\S]*?)\nCache boundary:/)
        if (!match) return []
        return match[1]
            .split(/[\s,]+/)
            .map((ref) => ref.trim())
            .filter((ref) => /^(?:A|[B-Z]|[A-Z]{2,})\d{3,}$/.test(ref))
    }
    return []
}

function extractMessageText(message: any): string {
    const parts: string[] = []
    if (typeof message?.content === "string") {
        parts.push(message.content)
    } else if (Array.isArray(message?.content)) {
        for (const part of message.content) {
            if (typeof part === "string") parts.push(part)
            else if (typeof part?.text === "string") parts.push(part.text)
            else if (typeof part?.content === "string") parts.push(part.content)
        }
    }
    if (Array.isArray(message?.tool_calls)) {
        for (const call of message.tool_calls) {
            if (call?.function?.arguments) parts.push(String(call.function.arguments))
        }
    }
    return parts.join("")
}

function findLastUserText(messages: any[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === "user") return extractMessageText(messages[index])
    }
    return ""
}

function countCompressCalls(messages: any[]): number {
    let count = 0
    for (const message of messages) {
        if (!Array.isArray(message?.tool_calls)) continue
        for (const call of message.tool_calls) {
            if (call?.function?.name === "compress") count++
        }
    }
    return count
}

function computeInputTokens(messages: any[]): number {
    const inputText = messages.map((message) => extractMessageText(message)).join("")
    return Math.max(1, Math.ceil(inputText.length / 4))
}

function recordObservation(observation: RequestObservation): void {
    observations.requests.push(observation)
    try {
        writeFileSync(OBSERVATIONS_FILE, JSON.stringify(observations, null, 2))
    } catch {
        // Verification treats a missing observation file as no request-history constraints.
    }
}

function readTurnCounter(): number {
    if (!existsSync(TURN_COUNTER)) return 0
    return parseInt(readFileSync(TURN_COUNTER, "utf-8").trim(), 10) || 0
}

function incrementTurnCounter(): number {
    const current = readTurnCounter()
    writeFileSync(TURN_COUNTER, String(current + 1))
    return current
}

function textResponse(
    model: string,
    text: string,
    isStream: boolean,
    inputTokens: number,
): Response {
    const outputTokens = Math.max(1, Math.ceil(text.length / 4))
    const usage = usageFor(inputTokens, outputTokens)
    if (!isStream) {
        return jsonResponse({
            id: `chatcmpl-fake-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: text },
                    finish_reason: "stop",
                },
            ],
            usage,
        })
    }
    return sseStream(model, [{ type: "text", content: text }], usage)
}

function toolUseResponse(
    model: string,
    toolName: string,
    args: Record<string, unknown>,
    isStream: boolean,
    inputTokens: number,
): Response {
    const argsJson = JSON.stringify(args)
    const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
    const usage = usageFor(inputTokens, Math.max(1, Math.ceil(argsJson.length / 4)))
    if (!isStream) {
        return jsonResponse({
            id: `chatcmpl-fake-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: callId,
                                type: "function",
                                function: { name: toolName, arguments: argsJson },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
            usage,
        })
    }
    return sseStream(model, [{ type: "tool_use", toolName, callId, args: argsJson }], usage)
}

function usageFor(inputTokens: number, outputTokens: number): Record<string, number> {
    return {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
    }
}

type StreamChunk =
    | { type: "text"; content: string }
    | { type: "tool_use"; toolName: string; callId: string; args: string }

function sseStream(model: string, chunks: StreamChunk[], usage: Record<string, number>): Response {
    const id = `chatcmpl-fake-${crypto.randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const encoder = new TextEncoder()
    const readable = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                if (chunk.type === "tool_use") {
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [
                                    {
                                        index: 0,
                                        delta: {
                                            role: "assistant",
                                            content: null,
                                            tool_calls: [
                                                {
                                                    index: 0,
                                                    id: chunk.callId,
                                                    type: "function",
                                                    function: {
                                                        name: chunk.toolName,
                                                        arguments: "",
                                                    },
                                                },
                                            ],
                                        },
                                        finish_reason: null,
                                    },
                                ],
                            }),
                        ),
                    )
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [
                                    {
                                        index: 0,
                                        delta: {
                                            tool_calls: [
                                                {
                                                    index: 0,
                                                    function: { arguments: chunk.args },
                                                },
                                            ],
                                        },
                                        finish_reason: null,
                                    },
                                ],
                            }),
                        ),
                    )
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                                usage,
                            }),
                        ),
                    )
                    continue
                }

                controller.enqueue(
                    encoder.encode(
                        sseLine({
                            id,
                            object: "chat.completion.chunk",
                            created,
                            model,
                            choices: [
                                {
                                    index: 0,
                                    delta: { role: "assistant", content: chunk.content },
                                    finish_reason: null,
                                },
                            ],
                        }),
                    ),
                )
                controller.enqueue(
                    encoder.encode(
                        sseLine({
                            id,
                            object: "chat.completion.chunk",
                            created,
                            model,
                            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                            usage,
                        }),
                    ),
                )
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
        },
    })

    return new Response(readable, {
        headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
        },
    })
}

function sseLine(value: unknown): string {
    return `data: ${JSON.stringify(value)}\n\n`
}

process.stderr.write(
    `[fake-llm] listening on http://${HOST}:${server.port}\n` +
        `[fake-llm] scenario: ${SCENARIO_PATH}\n` +
        `[fake-llm] ready (pid ${process.pid})\n`,
)
