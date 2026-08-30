#!/usr/bin/env node

import { existsSync, readFileSync } from "fs"

interface VerifyExpectations {
    blockCount?: number
    maxBlockCount?: number
    minBlockCount?: number
    nudgeBaselineSet?: boolean
    nudgeBaselineMin?: number
    pendingCompressionSet?: boolean
    activeBlockCount?: number
    compressedCount?: number
    minCompressedCount?: number
    maxCompressedCount?: number
    maxCompressCallsVisible?: number
    maxNudgeCount?: number
}

interface VerifyScenario {
    verify: VerifyExpectations
}

interface RequestObservation {
    turn: number
    inputTokens: number
    messageCount: number
    compressCallCount: number
    nudgeDetected: boolean
    isChild: boolean
    isAuxiliary: boolean
}

const statePath = process.argv[2]
const scenarioPath = process.argv[3]
const observationsPath = process.env.OBSERVATIONS ?? "/tmp/acp-e2e-observations.json"

if (!statePath || !scenarioPath) {
    process.stderr.write("Usage: verify.ts <state-file> <scenario-file>\n")
    process.exit(2)
}

function readJson(path: string): any {
    try {
        return JSON.parse(readFileSync(path, "utf-8"))
    } catch (e) {
        console.error(`FAIL: cannot read ${path}: ${(e as Error).message}`)
        process.exit(1)
    }
}

function readObservations(): RequestObservation[] {
    if (!existsSync(observationsPath)) return []
    try {
        const data = JSON.parse(readFileSync(observationsPath, "utf-8"))
        return Array.isArray(data?.requests) ? data.requests : []
    } catch {
        return []
    }
}

const state = readJson(statePath)
const scenario = readJson(scenarioPath) as VerifyScenario
const expect = scenario.verify
const observations = readObservations()

let passed = 0
let failed = 0

function assert(name: string, condition: boolean, detail?: string) {
    if (condition) {
        console.log(`  \u2713 ${name}`)
        passed++
    } else {
        console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`)
        failed++
    }
}

function countBlocks(s: any): number {
    return Object.keys(s?.prune?.messages?.blocksById ?? {}).length
}

function getBlocks(s: any): any[] {
    return Object.values(s?.prune?.messages?.blocksById ?? {})
}

function countActiveBlocks(s: any): number {
    return getBlocks(s).filter((b: any) => b?.active !== false).length
}

const actualBlockCount = countBlocks(state)
const actualActiveBlocks = countActiveBlocks(state)

const parentObs = observations.filter((o) => !o.isChild && !o.isAuxiliary)
const maxCompressCalls =
    parentObs.length > 0 ? Math.max(...parentObs.map((o) => o.compressCallCount)) : 0
const nudgeCount = parentObs.filter((o) => o.nudgeDetected).length

const usesObsAssertions =
    expect.maxCompressCallsVisible !== undefined || expect.maxNudgeCount !== undefined
if (usesObsAssertions && parentObs.length === 0) {
    assert(
        "observations recorded (non-empty)",
        false,
        "no real-turn observations — observation-based assertions are vacuous",
    )
}

console.log(`\nVerifying: ${scenarioPath}`)
console.log(`  state file: ${statePath}`)
console.log(`  blocks: ${actualBlockCount} (active: ${actualActiveBlocks})`)
if (observations.length > 0) {
    console.log(`  observations: ${observations.length} requests`)
    console.log(`    maxCompressCallsVisible: ${maxCompressCalls}`)
    console.log(`    nudgeDetections: ${nudgeCount}`)
}
console.log()

if (expect.blockCount !== undefined) {
    assert(
        `blockCount === ${expect.blockCount}`,
        actualBlockCount === expect.blockCount,
        `got ${actualBlockCount}`,
    )
}

if (expect.minBlockCount !== undefined) {
    assert(
        `blockCount >= ${expect.minBlockCount}`,
        actualBlockCount >= expect.minBlockCount,
        `got ${actualBlockCount}`,
    )
}

if (expect.maxBlockCount !== undefined) {
    assert(
        `blockCount <= ${expect.maxBlockCount}`,
        actualBlockCount <= expect.maxBlockCount,
        `got ${actualBlockCount}`,
    )
}

if (expect.activeBlockCount !== undefined) {
    assert(
        `activeBlockCount === ${expect.activeBlockCount}`,
        actualActiveBlocks === expect.activeBlockCount,
        `got ${actualActiveBlocks}`,
    )
}

const nudgeBaseline = state?.nudges?.lastPerMessageNudgeTokens

if (expect.nudgeBaselineSet !== undefined) {
    const isSet = nudgeBaseline !== null && nudgeBaseline !== undefined
    assert(
        `nudgeBaselineSet === ${expect.nudgeBaselineSet}`,
        isSet === expect.nudgeBaselineSet,
        `got ${nudgeBaseline ?? "null"}`,
    )
}

if (expect.nudgeBaselineMin !== undefined) {
    assert(
        `lastPerMessageNudgeTokens >= ${expect.nudgeBaselineMin}`,
        typeof nudgeBaseline === "number" && nudgeBaseline >= expect.nudgeBaselineMin,
        `got ${nudgeBaseline ?? "null"}`,
    )
}

if (expect.pendingCompressionSet !== undefined) {
    const isSet =
        state?.nudges?.pendingCompression !== null &&
        state?.nudges?.pendingCompression !== undefined
    assert(
        `pendingCompressionSet === ${expect.pendingCompressionSet}`,
        isSet === expect.pendingCompressionSet,
        `got ${isSet}`,
    )
}

function getCompressedMessageIds(s: any): string[] {
    return Object.keys(s?.prune?.messages?.byMessageId ?? {})
}

const compressedIds = getCompressedMessageIds(state)

if (expect.compressedCount !== undefined) {
    assert(
        `compressedCount === ${expect.compressedCount}`,
        compressedIds.length === expect.compressedCount,
        `got ${compressedIds.length} compressed message IDs`,
    )
}

if (expect.minCompressedCount !== undefined) {
    assert(
        `compressedCount >= ${expect.minCompressedCount}`,
        compressedIds.length >= expect.minCompressedCount,
        `got ${compressedIds.length} compressed message IDs`,
    )
}

if (expect.maxCompressedCount !== undefined) {
    assert(
        `compressedCount <= ${expect.maxCompressedCount}`,
        compressedIds.length <= expect.maxCompressedCount,
        `got ${compressedIds.length} compressed message IDs`,
    )
}

if (expect.maxCompressCallsVisible !== undefined) {
    assert(
        `maxCompressCallsVisible <= ${expect.maxCompressCallsVisible}`,
        maxCompressCalls <= expect.maxCompressCallsVisible,
        `got max ${maxCompressCalls} compress calls visible in a single request`,
    )
}

if (expect.maxNudgeCount !== undefined) {
    assert(
        `nudgeCount <= ${expect.maxNudgeCount}`,
        nudgeCount <= expect.maxNudgeCount,
        `got ${nudgeCount} nudge detections across ${parentObs.length} requests`,
    )
}

console.log()
if (failed > 0) {
    console.error(`FAIL: ${failed} assertion(s) failed, ${passed} passed`)
    process.exit(1)
}
console.log(`PASS: ${passed} assertion(s) passed`)
