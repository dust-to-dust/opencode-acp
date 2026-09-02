import { readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const testsDirectory = fileURLToPath(new URL("../tests/", import.meta.url))

function findTestFiles(directory) {
    const files = []

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)

        if (entry.isDirectory()) {
            files.push(...findTestFiles(path))
        } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
            files.push(path)
        }
    }

    return files
}

const testFiles = findTestFiles(testsDirectory).sort()

if (testFiles.length === 0) {
    console.error(`No test files found under ${testsDirectory}`)
    process.exit(1)
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
    stdio: "inherit"
})

if (result.error) {
    throw result.error
}

process.exit(result.status ?? 1)
