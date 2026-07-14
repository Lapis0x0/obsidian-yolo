export type ChatQuickAccessEntry =
  | { type: 'skill'; name: string }
  | { type: 'snippet'; id: string }

export const DEFAULT_CHAT_QUICK_ACCESS_ENTRIES: ChatQuickAccessEntry[] = [
  { type: 'skill', name: 'skill-creator' },
  { type: 'skill', name: 'snippet-creator' },
  { type: 'snippet', id: 'translate' },
  { type: 'snippet', id: 'review' },
]

export function getChatQuickAccessEntryKey(
  entry: ChatQuickAccessEntry,
): string {
  return entry.type === 'skill'
    ? `skill:${entry.name}`
    : `snippet:${entry.id}`
}
