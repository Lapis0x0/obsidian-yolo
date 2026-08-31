import type { KnowledgeBase } from '../../settings/schema/setting.types'

/**
 * Model-facing catalog of the configured knowledge bases (name + description),
 * appended to every search surface that accepts a `knowledgeBase` name —
 * the MCP `search` tool, `bash`'s `search --kb`, and `js_eval`'s
 * `$db.search(…, knowledgeBase)`. One text so the three stay in lockstep.
 */
export function describeKnowledgeBaseCatalog(
  knowledgeBases: readonly KnowledgeBase[],
): string {
  if (knowledgeBases.length === 0) {
    return 'No knowledge bases are configured — semantic (rag/hybrid) search falls back to keyword search.'
  }
  const lines = knowledgeBases.map((kb) => {
    const description = kb.description.trim()
    return `- ${kb.name}${description ? ` - ${description}` : ''}`
  })
  return `Available knowledge bases (pass the name to restrict semantic search to one; omit to merge top results across all):\n${lines.join('\n')}`
}
