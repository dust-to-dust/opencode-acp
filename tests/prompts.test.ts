import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"

test("prompt store reads the bundled system prompt", () => {
    const prompts = new PromptStore(new Logger(false)).getRuntimePrompts()

    assert.match(prompts.system, /context-constrained environment/i)
    assert.match(prompts.system, /COMPRESSION SUMMARIES IN CONTEXT/)
})

test("prompt store exposes the bundled range-mode compress prompt", () => {
    const prompts = new PromptStore(new Logger(false)).getRuntimePrompts()

    assert.match(prompts.compressRange, /Collapse a range in the conversation/i)
    assert.match(prompts.compressRange, /COMPRESSED BLOCK PLACEHOLDERS/)
    assert.match(prompts.compressRange, /BATCHING/)
    assert.match(prompts.compressRange, /content` array/)
})
