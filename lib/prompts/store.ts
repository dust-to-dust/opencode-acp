import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { basename, dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import type { Logger } from "../logger"

export type PromptKey =
    | "system"
    | "compress-range"
    | "context-limit-nudge"
    | "turn-nudge"
    | "iteration-nudge"

export interface RuntimePrompts {
    system: string
    compressRange: string
    contextLimitNudge: string
    turnNudge: string
    iterationNudge: string
    subagentExtension: string
    decompressExtension: string
    protectedToolsExtension: string
    compressionRequest: string
    howToCompressRules: string
}

type EditablePromptField =
    | "system"
    | "compressRange"
    | "contextLimitNudge"
    | "turnNudge"
    | "iterationNudge"

interface PromptDefinition {
    key: PromptKey
    fileName: string
    runtimeField: EditablePromptField
}

interface PromptPaths {
    globalDir: string
    projectDir: string | null
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = join(
    moduleDir,
    basename(moduleDir) === "prompts" ? "../../config/prompts" : "../config/prompts",
)

const PROMPT_DEFINITIONS: PromptDefinition[] = [
    { key: "system", fileName: "system.md", runtimeField: "system" },
    { key: "compress-range", fileName: "compress-range.md", runtimeField: "compressRange" },
    {
        key: "context-limit-nudge",
        fileName: "context-limit-nudge.md",
        runtimeField: "contextLimitNudge",
    },
    { key: "turn-nudge", fileName: "turn-nudge.md", runtimeField: "turnNudge" },
    {
        key: "iteration-nudge",
        fileName: "iteration-nudge.md",
        runtimeField: "iterationNudge",
    },
]

const FIXED_PROMPT_FILES = {
    subagentExtension: "subagent-extension.md",
    decompressExtension: "decompress-extension.md",
    protectedToolsExtension: "protected-tools.md",
    compressionRequest: "compression-request.md",
    howToCompressRules: "how-to-compress.md",
} as const

export const PROMPT_KEYS: PromptKey[] = PROMPT_DEFINITIONS.map(({ key }) => key)

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g
const LEGACY_INLINE_COMMENT_LINE_REGEX = /^[ \t]*\/\/.*?\/\/[ \t]*$/gm
const SYSTEM_SUBAGENT_SECTION_REGEX = /<subagent>[\s\S]*?<\/subagent>/gi
const PROMPT_WRAPPER_REGEX =
    /^\s*<(dcp-system-reminder|system-reminder)>\s*([\s\S]*?)\s*<\/\1>\s*$/i
const PROMPT_WRAPPER_MARKER_REGEX = /<\/?(?:dcp-system-reminder|system-reminder)>/i

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

    const prompt = content.replace(/^\uFEFF/, "").trim()
    if (!prompt) {
        throw new Error(`ACP prompt file is empty: ${filePath}`)
    }
    return prompt
}

function createBundledRuntimePrompts(): RuntimePrompts {
    const system = readBundledPrompt("system.md")
    const compressRange = readBundledPrompt("compress-range.md")
    const contextLimitNudge = readBundledPrompt("context-limit-nudge.md")
    const turnNudge = readBundledPrompt("turn-nudge.md")
    const iterationNudge = readBundledPrompt("iteration-nudge.md")

    return {
        system: wrapRuntimePromptContent("system", system),
        compressRange,
        contextLimitNudge: wrapRuntimePromptContent("context-limit-nudge", contextLimitNudge),
        turnNudge: wrapRuntimePromptContent("turn-nudge", turnNudge),
        iterationNudge: wrapRuntimePromptContent("iteration-nudge", iterationNudge),
        subagentExtension: readBundledPrompt(FIXED_PROMPT_FILES.subagentExtension),
        decompressExtension: readBundledPrompt(FIXED_PROMPT_FILES.decompressExtension),
        protectedToolsExtension: readBundledPrompt(FIXED_PROMPT_FILES.protectedToolsExtension),
        compressionRequest: readBundledPrompt(FIXED_PROMPT_FILES.compressionRequest),
        howToCompressRules: readBundledPrompt(FIXED_PROMPT_FILES.howToCompressRules),
    }
}

function resolvePromptPaths(workingDirectory: string): PromptPaths {
    const globalRoot = join(homedir(), ".config", "opencode", "acm", "prompts")
    const projectRoot = findOpencodeDir(workingDirectory)

    return {
        globalDir: globalRoot,
        projectDir: projectRoot ? join(projectRoot, "prompts") : null,
    }
}

function findOpencodeDir(startDirectory: string): string | null {
    let current = resolve(startDirectory)
    while (true) {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate)) {
            return candidate
        }

        const parent = dirname(current)
        if (parent === current) {
            return null
        }
        current = parent
    }
}

function readFileIfExists(filePath: string): string | null {
    if (!existsSync(filePath)) {
        return null
    }

    try {
        return readFileSync(filePath, "utf-8")
    } catch {
        return null
    }
}

function stripPromptComments(content: string): string {
    return content
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .replace(HTML_COMMENT_REGEX, "")
        .replace(LEGACY_INLINE_COMMENT_LINE_REGEX, "")
        .trim()
}

function toEditablePromptText(definition: PromptDefinition, content: string): string {
    let normalized = stripPromptComments(content)
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

function wrapRuntimePromptContent(definition: PromptKey | string, content: string): string {
    const normalized = content.trim()
    if (!normalized) {
        return ""
    }
    if (definition === "compress-range") {
        return normalized
    }
    return `<dcp-system-reminder>\n${normalized}\n</dcp-system-reminder>`
}

function buildDefaultPromptFileContent(content: string): string {
    return `${content.trim()}\n`
}

function buildDefaultsReadmeContent(): string {
    const lines = [
        "# ACP Prompts",
        "",
        "This directory stores the five customizable ACP prompts.",
        "Edit a prompt here for a global customization, or add the same file under a project .opencode/prompts directory.",
        "",
        "Override precedence (highest first):",
        "1. `.opencode/prompts/` (project)",
        "2. `~/.config/opencode/acm/prompts/` (global)",
        "",
    ]

    for (const definition of PROMPT_DEFINITIONS) {
        lines.push(`- \`${definition.fileName}\``)
    }

    return `${lines.join("\n")}\n`
}

function getOverrideCandidates(paths: PromptPaths, fileName: string): string[] {
    const candidates: string[] = []
    if (paths.projectDir) {
        candidates.push(join(paths.projectDir, fileName))
    }
    candidates.push(join(paths.globalDir, fileName))
    return candidates
}

export class PromptStore {
    private readonly logger: Logger
    private readonly paths: PromptPaths
    private readonly customPromptsEnabled: boolean
    private runtimePrompts: RuntimePrompts

    constructor(logger: Logger, workingDirectory = process.cwd(), customPromptsEnabled = false) {
        this.logger = logger
        this.paths = resolvePromptPaths(workingDirectory)
        this.customPromptsEnabled = customPromptsEnabled
        this.runtimePrompts = createBundledRuntimePrompts()

        if (customPromptsEnabled) {
            this.ensureDefaultFiles()
        }
        this.reload()
    }

    getRuntimePrompts(): RuntimePrompts {
        return { ...this.runtimePrompts }
    }

    reload(): void {
        const nextPrompts = createBundledRuntimePrompts()
        if (this.customPromptsEnabled) {
            for (const definition of PROMPT_DEFINITIONS) {
                const bundled = readBundledPrompt(definition.fileName)
                let effective = wrapRuntimePromptContent(
                    definition.key,
                    toEditablePromptText(definition, bundled),
                )

                for (const overridePath of getOverrideCandidates(this.paths, definition.fileName)) {
                    const rawOverride = readFileIfExists(overridePath)
                    if (rawOverride === null) {
                        continue
                    }

                    const editableOverride = toEditablePromptText(definition, rawOverride)
                    if (!editableOverride) {
                        this.logger.warn("Prompt override is empty or invalid after normalization", {
                            key: definition.key,
                            path: overridePath,
                        })
                        continue
                    }

                    const runtimeOverride = wrapRuntimePromptContent(
                        definition.key,
                        editableOverride,
                    )
                    if (!runtimeOverride) {
                        this.logger.warn("Prompt override could not be wrapped for runtime", {
                            key: definition.key,
                            path: overridePath,
                        })
                        continue
                    }

                    effective = runtimeOverride
                    break
                }

                nextPrompts[definition.runtimeField] = effective
            }
        }

        this.runtimePrompts = nextPrompts
    }

    private ensureDefaultFiles(): void {
        try {
            mkdirSync(this.paths.globalDir, { recursive: true })
        } catch {
            this.logger.warn("Failed to initialize prompt directories", {
                globalDir: this.paths.globalDir,
            })
            return
        }

        for (const definition of PROMPT_DEFINITIONS) {
            const content = buildDefaultPromptFileContent(
                toEditablePromptText(definition, readBundledPrompt(definition.fileName)),
            )
            const filePath = join(this.paths.globalDir, definition.fileName)
            try {
                if (readFileIfExists(filePath) === null) {
                    writeFileSync(filePath, content, "utf-8")
                }
            } catch {
                this.logger.warn("Failed to write default prompt file", {
                    key: definition.key,
                    path: filePath,
                })
            }
        }

        const readmePath = join(this.paths.globalDir, "README.md")
        const readmeContent = buildDefaultsReadmeContent()
        try {
            if (readFileIfExists(readmePath) !== readmeContent) {
                writeFileSync(readmePath, readmeContent, "utf-8")
            }
        } catch {
            this.logger.warn("Failed to write prompts README", { path: readmePath })
        }
    }
}
