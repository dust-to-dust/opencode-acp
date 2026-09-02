import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"

interface PromptFixture {
    configHome: string
    configDir: string
    workspaceDir: string
    globalOverridesDir: string
    configOverridesDir: string
    projectOverridesDir: string
    cleanup: () => void
}

function createFixture(): PromptFixture {
    const rootDir = mkdtempSync(join(tmpdir(), "opencode-acp-prompts-"))
    const configHome = join(rootDir, "config")
    const configDir = join(rootDir, "config-dir")
    const workspaceDir = join(rootDir, "workspace", "nested")
    const globalOverridesDir = join(
        configHome,
        ".config",
        "opencode",
        "acm",
        "prompts",
    )
    const configOverridesDir = join(configDir, "prompts")
    const projectOverridesDir = join(rootDir, "workspace", ".opencode", "prompts")
    mkdirSync(workspaceDir, { recursive: true })

    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const previousConfigHome = process.env.XDG_CONFIG_HOME
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.HOME = configHome
    process.env.USERPROFILE = configHome
    process.env.XDG_CONFIG_HOME = configHome
    process.env.OPENCODE_CONFIG_DIR = configDir

    return {
        configHome,
        configDir,
        workspaceDir,
        globalOverridesDir,
        configOverridesDir,
        projectOverridesDir,
        cleanup() {
            if (previousHome === undefined) {
                delete process.env.HOME
            } else {
                process.env.HOME = previousHome
            }
            if (previousUserProfile === undefined) {
                delete process.env.USERPROFILE
            } else {
                process.env.USERPROFILE = previousUserProfile
            }
            if (previousConfigHome === undefined) {
                delete process.env.XDG_CONFIG_HOME
            } else {
                process.env.XDG_CONFIG_HOME = previousConfigHome
            }
            if (previousConfigDir === undefined) {
                delete process.env.OPENCODE_CONFIG_DIR
            } else {
                process.env.OPENCODE_CONFIG_DIR = previousConfigDir
            }
            rmSync(rootDir, { recursive: true, force: true })
        },
    }
}

function writePrompt(directory: string, fileName: string, content: string): void {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, fileName), content, "utf-8")
}

test("bundled prompts are semantic, file-backed, and complete", () => {
    const prompts = new PromptStore(new Logger(false)).getRuntimePrompts()

    assert.match(prompts.system, /immutable activity blocks and checkpoints/i)
    assert.match(prompts.system, /HOW TO SELECT/)
    assert.match(prompts.compressRange, /Select which eligible context blocks remain verbatim/i)
    assert.doesNotMatch(prompts.compressRange, /Collapse a range in the conversation/i)
    assert.doesNotMatch(prompts.compressRange, /<{7}|={7}|>{7}/)
    assert.match(prompts.protectedToolsExtension, /\{\{toolList\}\}/)
    assert.match(prompts.compressionRequest, /\{\{candidates\}\}/)
    assert.match(prompts.compressionRequest, /\{\{cacheBoundary\}\}/)

    for (const value of Object.values(prompts)) {
        assert.ok(value.trim())
    }
})

test("custom prompts can be disabled without reading overrides", () => {
    const fixture = createFixture()
    try {
        writePrompt(fixture.projectOverridesDir, "system.md", "Project override")

        const prompts = new PromptStore(
            new Logger(false),
            fixture.workspaceDir,
            false,
        ).getRuntimePrompts()

        assert.match(prompts.system, /immutable activity blocks and checkpoints/i)
        assert.doesNotMatch(prompts.system, /Project override/)
        assert.equal(
            existsSync(
                join(
                    fixture.configHome,
                    ".config",
                    "opencode",
                    "acm",
                    "prompts",
                ),
            ),
            false,
        )
    } finally {
        fixture.cleanup()
    }
})

test("custom prompts use project, then ACM global precedence", () => {
    const fixture = createFixture()
    try {
        writePrompt(fixture.globalOverridesDir, "system.md", "Global override")
        writePrompt(fixture.configOverridesDir, "system.md", "Config override")
        writePrompt(fixture.projectOverridesDir, "system.md", "Project override")

        const prompts = new PromptStore(
            new Logger(false),
            fixture.workspaceDir,
            true,
        ).getRuntimePrompts()

        assert.match(prompts.system, /Project override/)
        assert.match(prompts.system, /^<dcp-system-reminder>/)
        assert.doesNotMatch(prompts.system, /Config override/)
        assert.doesNotMatch(prompts.system, /Global override/)
    } finally {
        fixture.cleanup()
    }
})

test("empty and malformed overrides fall back to the next valid layer", () => {
    const fixture = createFixture()
    try {
        writePrompt(fixture.globalOverridesDir, "system.md", "Global fallback")
        writePrompt(fixture.configOverridesDir, "system.md", "Config fallback")
        writePrompt(fixture.projectOverridesDir, "system.md", "<dcp-system-reminder>broken")

        const store = new PromptStore(new Logger(false), fixture.workspaceDir, true)
        assert.match(store.getRuntimePrompts().system, /Global fallback/)

        writePrompt(fixture.projectOverridesDir, "system.md", "   \n")
        store.reload()
        assert.match(store.getRuntimePrompts().system, /Global fallback/)
    } finally {
        fixture.cleanup()
    }
})

test("reload applies normalized overrides and preserves a single wrapper", () => {
    const fixture = createFixture()
    try {
        const store = new PromptStore(new Logger(false), fixture.workspaceDir, true)
        writePrompt(
            fixture.globalOverridesDir,
            "system.md",
            "\uFEFF<!-- copied comment -->\n<dcp-system-reminder>\nReloaded system\n</dcp-system-reminder>\n",
        )

        store.reload()
        const system = store.getRuntimePrompts().system
        assert.match(system, /Reloaded system/)
        assert.equal((system.match(/<dcp-system-reminder>/g) ?? []).length, 1)
        assert.equal((system.match(/<\/dcp-system-reminder>/g) ?? []).length, 1)
        assert.doesNotMatch(system, /copied comment/)
    } finally {
        fixture.cleanup()
    }
})
