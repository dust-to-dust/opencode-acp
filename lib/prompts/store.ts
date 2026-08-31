import { readFileSync } from "fs"
import { basename, dirname, join } from "path"
import { fileURLToPath } from "url"
import type { Logger } from "../logger"

export type PromptKey =
    "system" | "compress-range" | "context-limit-nudge" | "turn-nudge" | "iteration-nudge"

export interface RuntimePrompts {
    system: string
    compressRange: string
    contextLimitNudge: string
    turnNudge: string
    iterationNudge: string
    subagentExtension: string
    decompressExtension: string
    protectedToolsExtension: string
    rangeFormatExtension: string
    messageFormatExtension: string
    compressionPhilosophy: string
    howToCompressRules: string
    tier2DistillRules: string
    tier3CondenseRules: string
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = join(
    moduleDir,
    basename(moduleDir) === "prompts" ? "../../config/prompts" : "../config/prompts",
)

const PROMPT_FILES = {
    system: "system.md",
    compressRange: "compress-range.md",
    contextLimitNudge: "context-limit-nudge.md",
    turnNudge: "turn-nudge.md",
    iterationNudge: "iteration-nudge.md",
    subagentExtension: "subagent-extension.md",
    decompressExtension: "decompress-extension.md",
    protectedToolsExtension: "protected-tools.md",
    rangeFormatExtension: "range-format.md",
    messageFormatExtension: "message-format.md",
    compressionPhilosophy: "compression-philosophy.md",
    howToCompressRules: "how-to-compress.md",
    tier2DistillRules: "tier2-distill.md",
    tier3CondenseRules: "tier3-condense.md",
} as const

export const PROMPT_KEYS: PromptKey[] = [
    "system",
    "compress-range",
    "context-limit-nudge",
    "turn-nudge",
    "iteration-nudge",
]

export function readBundledPrompt(fileName: string): string {
    const filePath = join(PROMPTS_DIR, fileName)
    let content: string
    try {
        content = readFileSync(filePath, "utf-8")
    } catch (error) {
        throw new Error(
            `ACP prompt file is required at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
    }

    const prompt = content.trim()
    if (!prompt) {
        throw new Error(`ACP prompt file is empty: ${filePath}`)
    }
    return prompt
}

function loadRuntimePrompts(): RuntimePrompts {
    return Object.fromEntries(
        Object.entries(PROMPT_FILES).map(([field, fileName]) => [
            field,
            readBundledPrompt(fileName),
        ]),
    ) as unknown as RuntimePrompts
}

export class PromptStore {
    private runtimePrompts: RuntimePrompts

    constructor(_logger: Logger) {
        this.runtimePrompts = loadRuntimePrompts()
    }

    getRuntimePrompts(): RuntimePrompts {
        return { ...this.runtimePrompts }
    }

    reload(): void {
        this.runtimePrompts = loadRuntimePrompts()
    }
}
