import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
    replaceBlockIdsWithBlocked,
    stripHallucinationsFromString,
    stripStaleMessageRefs,
} from "../lib/messages/utils"

const DCP_MESSAGE_TAG = `${"dcp"}-message-id`
const ACP_MESSAGE_TAG = `${"acp"}-message-id`

function tag(name: string, value: string, attributes = ""): string {
    const suffix = attributes ? ` ${attributes}` : ""
    return `<${name}${suffix}>${value}</${name}>`
}

describe("replaceBlockIdsWithBlocked", () => {
    test("replaces checkpoint refs and preserves tag attributes", () => {
        const input = tag(DCP_MESSAGE_TAG, "B1", 'tokens="10"')
        assert.equal(
            replaceBlockIdsWithBlocked(input),
            tag(DCP_MESSAGE_TAG, "BLOCKED", 'tokens="10"'),
        )
    })

    test("supports checkpoint generations beyond Z", () => {
        const input = `${tag(ACP_MESSAGE_TAG, "C2")} ${tag(DCP_MESSAGE_TAG, "AA123")}`
        const expected = `${tag(ACP_MESSAGE_TAG, "BLOCKED")} ${tag(DCP_MESSAGE_TAG, "BLOCKED")}`
        assert.equal(replaceBlockIdsWithBlocked(input), expected)
    })

    test("does not touch A-generation activity refs", () => {
        const input = tag(DCP_MESSAGE_TAG, "A45")
        assert.equal(replaceBlockIdsWithBlocked(input), input)
    })

    test("preserves surrounding text", () => {
        const input = `Before ${tag(DCP_MESSAGE_TAG, "B999")} After`
        assert.equal(
            replaceBlockIdsWithBlocked(input),
            `Before ${tag(DCP_MESSAGE_TAG, "BLOCKED")} After`,
        )
    })
})

describe("stripStaleMessageRefs", () => {
    test("strips A activity tags with or without attributes", () => {
        const input = `Text ${tag(DCP_MESSAGE_TAG, "A1", 'tokens="5"')} more ${tag(ACP_MESSAGE_TAG, "A2")}`
        assert.equal(stripStaleMessageRefs(input), "Text  more ")
    })

    test("preserves checkpoint tags", () => {
        const input = `${tag(DCP_MESSAGE_TAG, "B1")} ${tag(ACP_MESSAGE_TAG, "AA2")}`
        assert.equal(stripStaleMessageRefs(input), input)
    })

    test("does not leave an opening tag fragment", () => {
        const input = `Before ${tag(DCP_MESSAGE_TAG, "A3", 'type="tool"')} After`
        const result = stripStaleMessageRefs(input)
        assert.equal(result, "Before  After")
        assert.equal(result.includes(DCP_MESSAGE_TAG), false)
    })
})

describe("stripHallucinationsFromString", () => {
    test("removes paired dcp and acp tags with their content", () => {
        const dcpTag = `${"dcp"}-summary`
        const acpTag = `${"acp"}-note`
        const input = `alpha${tag(dcpTag, "secret")}middle${tag(acpTag, "hidden")}omega`
        assert.equal(stripHallucinationsFromString(input), "alphamiddleomega")
    })

    test("removes message ID tags with attributes", () => {
        const input = `before${tag(DCP_MESSAGE_TAG, "A97", 'tokens="12"')}after`
        assert.equal(stripHallucinationsFromString(input), "beforeafter")
    })

    test("removes orphan tags while preserving surrounding text", () => {
        const tagName = `${"dcp"}-orphan`
        const input = `before <${tagName}>middle</${tagName}> after <${tagName}>tail`
        assert.equal(stripHallucinationsFromString(input), "before  after tail")
    })

    test("does not affect unrelated XML tags", () => {
        const input = "<details>content</details>"
        assert.equal(stripHallucinationsFromString(input), input)
    })
})
