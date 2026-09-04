/**
 * OpenCode 最终请求捕获插件。
 * 规则：默认关闭，仅在手动启用时于 fetch 网络边界记录 LLM JSON 请求；认证信息始终脱敏。
 */
import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

type CaptureConfig = {
  enabled: boolean
  dumpDir: string
  maxArchives: number
}

type JsonRecord = Record<string, unknown>

const PATCH_MARK = Symbol.for("opencode.context-capture.fetch.v1")
const CONFIG_PATH = join(homedir(), ".config", "opencode", "context-capture.json")
const DEFAULT_CONFIG: CaptureConfig = {
  enabled: false,
  dumpDir: "~/.local/share/opencode/context-dumps",
  maxArchives: 100,
}
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i

type PatchedFetch = typeof globalThis.fetch & { [PATCH_MARK]?: true }

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

function resolveHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(dirname(CONFIG_PATH), path)
}

async function loadConfig(): Promise<CaptureConfig> {
  try {
    const parsed = asRecord(JSON.parse(await readFile(CONFIG_PATH, "utf8")))
    return {
      enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled,
      dumpDir:
        typeof parsed?.dumpDir === "string" && parsed.dumpDir.trim()
          ? parsed.dumpDir
          : DEFAULT_CONFIG.dumpDir,
      maxArchives:
        typeof parsed?.maxArchives === "number" && Number.isFinite(parsed.maxArchives)
          ? Math.max(0, Math.floor(parsed.maxArchives))
          : DEFAULT_CONFIG.maxArchives,
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

function isLlmPayload(body: JsonRecord): boolean {
  return Boolean(
    body.model &&
      (body.input || body.messages || body.contents || body.prompt || body.instructions || body.tools),
  )
}

function safeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()].map(([key, value]) => [key, SECRET_HEADER.test(key) ? "[REDACTED]" : value]),
  )
}

function sessionID(request: Request, body: JsonRecord): string {
  const value =
    request.headers.get("session-id") ??
    request.headers.get("x-session-id") ??
    request.headers.get("x-opencode-session") ??
    (typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined)
  return value?.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown-session"
}

async function pruneArchives(directory: string, maxArchives: number): Promise<void> {
  if (maxArchives <= 0) return
  const files = (await readdir(directory))
    .filter((name) => /^request_.*\.json$/.test(name))
    .sort()
  await Promise.all(files.slice(0, Math.max(0, files.length - maxArchives)).map((name) => rm(join(directory, name))))
}

const ContextCapturePlugin: Plugin = async () => {
  let sequence = 0
  let writes = Promise.resolve()
  const currentFetch = globalThis.fetch as PatchedFetch
  if (currentFetch[PATCH_MARK]) return {}

  const upstreamFetch = currentFetch.bind(globalThis)
  const capture = async (input: RequestInfo | URL, init?: RequestInit): Promise<void> => {
    const config = await loadConfig()
    if (!config.enabled) return
    const dumpDir = resolveHome(config.dumpDir)

    let request: Request
    let rawBody: string
    try {
      request = new Request(input, init)
      if (!request.body || request.method === "GET" || request.method === "HEAD") return
      rawBody = await request.clone().text()
    } catch {
      return
    }

    let body: JsonRecord | undefined
    try {
      body = asRecord(JSON.parse(rawBody))
    } catch {
      return
    }
    if (!body || !isLlmPayload(body)) return

    const capturedAt = new Date()
    const id = `${capturedAt.toISOString().replace(/[-:.TZ]/g, "")}_${process.pid}_${String(++sequence).padStart(4, "0")}`
    const session = sessionID(request, body)
    const snapshot = {
      schemaVersion: 2,
      capturedAt: capturedAt.toISOString(),
      source: "globalThis.fetch network boundary",
      request: {
        url: request.url,
        method: request.method,
        headers: safeHeaders(request.headers),
        rawBody,
        body,
      },
    }

    writes = writes.then(async () => {
      const sessionDir = join(dumpDir, session)
      await mkdir(sessionDir, { recursive: true })
      const archive = join(sessionDir, `request_${id}.json`)
      const json = JSON.stringify(snapshot, null, 2)
      await writeFile(archive, json, "utf8")

      for (const latest of [join(sessionDir, "latest.json"), join(dumpDir, "latest.json")]) {
        const temporary = `${latest}.${process.pid}.tmp`
        await writeFile(temporary, json, "utf8")
        await rename(temporary, latest)
      }
      await pruneArchives(sessionDir, config.maxArchives)
    })
    await writes
  }

  const patchedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const capturePromise = capture(input, init).catch((error: unknown) => {
      console.warn(`[context-capture] ${String(error)}`)
    })
    try {
      return await upstreamFetch(input, init)
    } finally {
      await capturePromise
    }
  }) as PatchedFetch

  Object.defineProperty(patchedFetch, PATCH_MARK, { value: true })
  globalThis.fetch = patchedFetch
  return {}
}

export default ContextCapturePlugin
