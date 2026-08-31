import { KnowledgeBase } from '../../settings/schema/setting.types'

import { RAGEngine } from './ragEngine'

/**
 * The single dependency-injection surface every retrieval consumer (the
 * `vault_search` MCP tool, `bash search`, `$db.search`, and the native agent
 * tool context) uses to reach knowledge bases, replacing the old
 * single-knowledge-base `getRagEngine: () => Promise<RAGEngine>` shape. See
 * `main.ts`'s `getRagAccess()` for the concrete instance, backed by
 * `RagCoordinator`.
 */
export type RagKnowledgeAccess = {
  /** Every knowledge base currently configured, in settings order. Empty
   * when the vault has none yet. */
  listKnowledgeBases(): KnowledgeBase[]
  /** Lazily opens (or reuses) the `RAGEngine` for one knowledge base. */
  getRagEngine(kbId: string): Promise<RAGEngine>
}

/** Case-insensitive, trim-compared name lookup — `KnowledgeBase.name` is
 * unique under this comparison (enforced by the settings UI). */
export function findKnowledgeBaseByName(
  knowledgeBases: readonly KnowledgeBase[],
  name: string,
): KnowledgeBase | undefined {
  const target = name.trim().toLowerCase()
  return knowledgeBases.find((kb) => kb.name.trim().toLowerCase() === target)
}
