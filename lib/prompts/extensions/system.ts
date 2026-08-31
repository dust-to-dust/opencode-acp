import { readBundledPrompt } from "../store"

export function buildProtectedToolsExtension(protectedTools: string[], template?: string): string {
    if (protectedTools.length === 0) {
        return ""
    }

    const toolList = protectedTools.map((tool) => `\`${tool}\``).join(", ")
    return (template ?? readBundledPrompt("protected-tools.md")).replace(
        /\{\{toolList\}\}/g,
        toolList,
    )
}
