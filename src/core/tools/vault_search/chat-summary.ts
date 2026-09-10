import { truncateText } from '../chat-summary-support'

/**
 * Chat-surface summary for `vault_search`: what was searched for, followed
 * by whatever narrowed it.
 *
 * The query carries the meaning of the call, so it leads and is the only
 * part truncated. `path` and `knowledgeBase` are appended when present
 * because they change what the result set could possibly contain — a search
 * that found nothing reads very differently once the header shows it was
 * confined to one folder or one knowledge base.
 */
export const getVaultSearchChatSummary = ({
  argumentsObject,
}: {
  argumentsObject: Record<string, unknown> | null
}): string | undefined => {
  const query =
    typeof argumentsObject?.query === 'string' ? argumentsObject.query : ''
  if (query.trim().length === 0) {
    return undefined
  }

  const scopes = (['path', 'knowledgeBase'] as const)
    .map((key) => {
      const value = argumentsObject?.[key]
      return typeof value === 'string' ? value.trim() : ''
    })
    .filter((value) => value.length > 0)

  return [truncateText(query, 60), ...scopes].join(' | ')
}
