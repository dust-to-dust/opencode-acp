import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { Logger } from "../logger"

export type PromptKey =
    | "system"
    | "compress-range"
    | "context-limit-nudge"
    | "subagent-extension"
    | "decompress-extension"
    | "protected-tools"
    | "compression-request"

export interface RuntimePrompts {
    system: string
    compressRange: string
    contextLimitNudge: string
    subagentExtension: string
    decompressExtension: string
    protectedToolsExtension: string
    compressionRequest: string
}

interface PromptDefinition {
    key: PromptKey
    fileName: `${PromptKey}.md`
    runtimeField: keyof RuntimePrompts
    wrapAsSystemReminder: boolean
}

const PROMPT_DEFINITIONS: readonly PromptDefinition[] = [
    {
        key: "system",
        fileName: "system.md",
        runtimeField: "system",
        wrapAsSystemReminder: true,
    },
    {
        key: "compress-range",
        fileName: "compress-range.md",
        runtimeField: "compressRange",
        wrapAsSystemReminder: false,
    },
    {
        key: "context-limit-nudge",
        fileName: "context-limit-nudge.md",
        runtimeField: "contextLimitNudge",
        wrapAsSystemReminder: true,
    },
    {
        key: "subagent-extension",
        fileName: "subagent-extension.md",
        runtimeField: "subagentExtension",
        wrapAsSystemReminder: false,
    },
    {
        key: "decompress-extension",
        fileName: "decompress-extension.md",
        runtimeField: "decompressExtension",
        wrapAsSystemReminder: false,
    },
    {
        key: "protected-tools",
        fileName: "protected-tools.md",
        runtimeField: "protectedToolsExtension",
        wrapAsSystemReminder: false,
    },
    {
        key: "compression-request",
        fileName: "compression-request.md",
        runtimeField: "compressionRequest",
        wrapAsSystemReminder: false,
    },
]

export const PROMPT_KEYS: PromptKey[] = PROMPT_DEFINITIONS.map(({ key }) => key)

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g
const LEGACY_INLINE_COMMENT_LINE_REGEX = /^[ \t]*\/\/.*?\/\/[ \t]*$/gm
const SYSTEM_SUBAGENT_SECTION_REGEX = /<subagent>[\s\S]*?<\/subagent>/gi
const PROMPT_WRAPPER_REGEX =
    /^\s*<(dcp-system-reminder|system-reminder)>\s*([\s\S]*?)\s*<\/\1>\s*$/i
const PROMPT_WRAPPER_MARKER_REGEX = /<\/?(?:dcp-system-reminder|system-reminder)>/i

export function resolveGlobalPromptsDir(): string {
    return join(homedir(), ".config", "opencode", "acm", "prompts")
}

function readGlobalPrompt(promptsDir: string, definition: PromptDefinition): string {
    const filePath = join(promptsDir, definition.fileName)
    let content: string
    try {
        content = readFileSync(filePath, "utf-8")
    } catch (error) {
        throw new Error(
            `ACP prompt file is required at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
    }

    const prompt = toPromptText(definition, content)
    if (!prompt) {
        throw new Error(`ACP prompt file is empty or invalid: ${filePath}`)
    }
    return definition.wrapAsSystemReminder ? wrapSystemReminder(prompt) : prompt
}

function toPromptText(definition: PromptDefinition, content: string): string {
    let normalized = content
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .replace(HTML_COMMENT_REGEX, "")
        .replace(LEGACY_INLINE_COMMENT_LINE_REGEX, "")
        .trim()
    const wrapped = normalized.match(PROMPT_WRAPPER_REGEX)
    if (wrapped) {
        normalized = wrapped[2].trim()
    } else if (PROMPT_WRAPPER_MARKER_REGEX.test(normalized)) {
        return ""
    }

    if (definition.key === "system") {
        normalized = normalized.replace(SYSTEM_SUBAGENT_SECTION_REGEX, "").trim()
    }
    return normalized
}

function wrapSystemReminder(content: string): string {
    return `<dcp-system-reminder>\n${content}\n</dcp-system-reminder>`
}

function loadRuntimePrompts(promptsDir: string): RuntimePrompts {
    const prompts = {} as RuntimePrompts
    for (const definition of PROMPT_DEFINITIONS) {
        prompts[definition.runtimeField] = readGlobalPrompt(promptsDir, definition)
    }
    return prompts
}

export class PromptStore {
    private runtimePrompts: RuntimePrompts

    constructor(_logger: Logger, private readonly promptsDir = resolveGlobalPromptsDir()) {
        this.runtimePrompts = loadRuntimePrompts(this.promptsDir)
    }

    getRuntimePrompts(): RuntimePrompts {
        return { ...this.runtimePrompts }
    }

    reload(): void {
        this.runtimePrompts = loadRuntimePrompts(this.promptsDir)
    }
}
