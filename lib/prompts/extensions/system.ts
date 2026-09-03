export function buildProtectedToolsExtension(protectedTools: string[], template: string): string {
    if (protectedTools.length === 0) {
        return ""
    }

    const toolList = protectedTools.map((tool) => `\`${tool}\``).join(", ")
    return template.replace(/\{\{toolList\}\}/g, toolList)
}
