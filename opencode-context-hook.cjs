#!/usr/bin/env node
/**
 * OpenCode 真实上下文捕获工具。
 * 规则：install 仅部署且默认关闭；enable/disable 显式控制捕获；查看命令只读取结果。
 */
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")

const sourcePlugin = path.join(__dirname, "config", "context-capture.ts")
const sourceConfig = path.join(__dirname, "config", "context-capture.json")
const opencodeDir = path.join(os.homedir(), ".config", "opencode")
const targetPlugin = path.join(opencodeDir, "plugins", "context-capture.ts")
const targetConfig = path.join(opencodeDir, "context-capture.json")

function expandHome(value) {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2))
  }
  return path.isAbsolute(value) ? value : path.resolve(opencodeDir, value)
}

async function config() {
  return JSON.parse(await fs.readFile(targetConfig, "utf8"))
}

async function dumpDir() {
  return expandHome((await config()).dumpDir)
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function install() {
  await fs.mkdir(path.dirname(targetPlugin), { recursive: true })
  await fs.copyFile(sourcePlugin, targetPlugin)
  if (!(await exists(targetConfig))) await fs.copyFile(sourceConfig, targetConfig)
  console.log(`plugin: ${targetPlugin}`)
  console.log(`config: ${targetConfig}`)
  console.log("已部署，捕获默认关闭。完全退出并重启 OpenCode 后加载插件。")
}

async function setEnabled(enabled) {
  if (!(await exists(targetConfig))) await fs.copyFile(sourceConfig, targetConfig)
  const current = await config()
  current.enabled = enabled
  await fs.writeFile(targetConfig, `${JSON.stringify(current, null, 2)}\n`, "utf8")
  console.log(`capture: ${enabled ? "enabled" : "disabled"}`)
}

async function latestPath() {
  return path.join(await dumpDir(), "latest.json")
}

async function status() {
  const latest = await latestPath()
  console.log(`plugin: ${(await exists(targetPlugin)) ? "installed" : "missing"} (${targetPlugin})`)
  console.log(`config: ${(await exists(targetConfig)) ? "installed" : "missing"} (${targetConfig})`)
  console.log(`capture: ${(await config()).enabled ? "enabled" : "disabled"}`)
  console.log(`latest: ${(await exists(latest)) ? latest : "尚未捕获"}`)
}

async function list(limitText) {
  const root = await dumpDir()
  const limit = Math.max(1, Number.parseInt(limitText || "20", 10) || 20)
  const sessions = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const directory = path.join(root, session.name)
    for (const name of await fs.readdir(directory)) {
      if (name.startsWith("request_") && name.endsWith(".json")) files.push(path.join(directory, name))
    }
  }
  for (const file of files.sort().reverse().slice(0, limit)) console.log(file)
}

async function readCapture(file) {
  const target = file ? path.resolve(file) : await latestPath()
  return { target, text: await fs.readFile(target, "utf8") }
}

async function show(file, bodyOnly) {
  const capture = await readCapture(file)
  if (!bodyOnly) {
    process.stdout.write(capture.text)
    return
  }
  const parsed = JSON.parse(capture.text)
  process.stdout.write(parsed.request.rawBody)
}

function help() {
  console.log(`用法：
  node opencode-context-hook.cjs install       部署全局 OpenCode 插件
  node opencode-context-hook.cjs enable        手动启用后续请求捕获
  node opencode-context-hook.cjs disable       立即停止后续请求捕获
  node opencode-context-hook.cjs status        查看部署和最近捕获状态
  node opencode-context-hook.cjs list [数量]   列出历史请求
  node opencode-context-hook.cjs show [文件]   查看完整捕获 JSON
  node opencode-context-hook.cjs body [文件]   输出实际发送的原始 HTTP body`)
}

async function main() {
  const [command, argument] = process.argv.slice(2)
  if (command === "install") return install()
  if (command === "enable") return setEnabled(true)
  if (command === "disable") return setEnabled(false)
  if (command === "status") return status()
  if (command === "list") return list(argument)
  if (command === "show") return show(argument, false)
  if (command === "body") return show(argument, true)
  help()
  if (command && command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
