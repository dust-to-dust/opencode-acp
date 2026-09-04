import "./test-env"
/**
 * Tests for the real SessionStateRegistry (not the test stub).
 *
 * Covers the acceptance criteria from devlog/2026-07-24_per-session-state/REQ.md:
 *   - getOrCreate idempotency
 *   - per-session isolation of modelContextLimit (the #33 fix)
 *   - shared compressionTiming across sessions
 *   - soft-cap eviction + reload from persisted JSON
 */

import assert from "node:assert/strict"
import test, { beforeEach, afterEach } from "node:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
    SessionStateRegistry,
    createSessionState,
    saveSessionState,
    type WithParts,
} from "../lib/state"
import { resolveToolContext } from "../lib/compress/types"
import { Logger } from "../lib/logger"

function makeClient(): any {
    return { session: { get: async () => ({ data: { parentID: null } }) } }
}

const MESSAGES: WithParts[] = []
const MANUAL_MODE = false

let tempDir: string
let prevData: string | undefined
let prevConfig: string | undefined

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "acp-registry-"))
    prevData = process.env.XDG_DATA_HOME
    prevConfig = process.env.XDG_CONFIG_HOME
    process.env.XDG_DATA_HOME = tempDir
    process.env.XDG_CONFIG_HOME = tempDir
})

afterEach(() => {
    if (prevData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevData
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevConfig
    rmSync(tempDir, { recursive: true, force: true })
})

test("getOrCreate is idempotent: same sessionId returns the same state without re-init", async () => {
    const registry = new SessionStateRegistry(new Logger(false))
    const first = await registry.getOrCreate(makeClient(), "session-1", MESSAGES, MANUAL_MODE)
    assert.equal(first.sessionId, "session-1")
    first.modelContextLimit = 200000

    const second = await registry.getOrCreate(makeClient(), "session-1", MESSAGES, MANUAL_MODE)
    assert.equal(second, first)
    assert.equal(second.modelContextLimit, 200000)
    assert.equal(registry.size, 1)
})

test("per-session isolation: modelContextLimit set on session A survives session B init", async () => {
    const registry = new SessionStateRegistry(new Logger(false))
    const a = await registry.getOrCreate(makeClient(), "session-A", MESSAGES, MANUAL_MODE)
    a.modelContextLimit = 200000

    const b = await registry.getOrCreate(makeClient(), "session-B", MESSAGES, MANUAL_MODE)

    assert.notEqual(a, b)
    assert.equal(a.modelContextLimit, 200000)
    assert.equal(b.modelContextLimit, undefined)
    assert.equal(registry.size, 2)
})

test("compressionTiming is the same shared object across all sessions", async () => {
    const registry = new SessionStateRegistry(new Logger(false))
    const a = await registry.getOrCreate(makeClient(), "session-A", MESSAGES, MANUAL_MODE)
    const b = await registry.getOrCreate(makeClient(), "session-B", MESSAGES, MANUAL_MODE)

    assert.equal(a.compressionTiming, registry.compressionTiming)
    assert.equal(b.compressionTiming, registry.compressionTiming)

    a.compressionTiming.startsByCallId.set("message-1:call-1", 100)
    assert.equal(b.compressionTiming.startsByCallId.get("message-1:call-1"), 100)
})

test("soft-cap eviction drops the oldest session; reload restores persisted modelContextLimit", async () => {
    const logger = new Logger(false)
    const registry = new SessionStateRegistry(logger)

    const first = await registry.getOrCreate(makeClient(), "session-0", MESSAGES, MANUAL_MODE)
    first.modelContextLimit = 200000
    await saveSessionState(first, logger)

    for (let i = 1; i <= 32; i++) {
        await registry.getOrCreate(makeClient(), `session-${i}`, MESSAGES, MANUAL_MODE)
    }

    assert.equal(registry.get("session-0"), undefined)
    assert.equal(registry.size, 32)

    const reloaded = await registry.getOrCreate(makeClient(), "session-0", MESSAGES, MANUAL_MODE)
    assert.equal(reloaded.modelContextLimit, 200000)
})

test("incompatible persisted state warns once and disables only that session", async () => {
    const storageDir = join(tempDir, "opencode", "storage", "plugin", "acp")
    const stateFile = join(storageDir, "old-session.json")
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(stateFile, JSON.stringify({ schemaVersion: 2 }), "utf-8")
    const toasts: any[] = []
    const client = {
        session: { get: async () => ({ data: { parentID: null } }) },
        tui: {
            showToast: async (toast: any) => {
                toasts.push(toast)
            },
        },
    }
    const registry = new SessionStateRegistry(new Logger(false))

    const disabled = await registry.getOrCreate(client, "old-session", MESSAGES)
    const compatible = await registry.getOrCreate(client, "new-session", MESSAGES)
    await registry.getOrCreate(client, "old-session", MESSAGES)

    assert.match(disabled.disabledReason ?? "", /schema 2/)
    assert.equal(disabled.compressPermission, "deny")
    assert.equal(compatible.disabledReason, undefined)
    assert.equal(toasts.length, 1)
    assert.equal(toasts[0].body.variant, "warning")
    assert.match(toasts[0].body.message, /Start a new session/)
    assert.equal(JSON.parse(readFileSync(stateFile, "utf-8")).schemaVersion, 2)
})

test("ACP tools reject a self-disabled session", () => {
    const state = createSessionState()
    state.sessionId = "old-session"
    state.disabledReason = "incompatible state"

    assert.throws(
        () =>
            resolveToolContext(
                {
                    registry: { get: () => state } as any,
                } as any,
                "old-session",
            ),
        /ACP is disabled for this session: incompatible state/,
    )
})
