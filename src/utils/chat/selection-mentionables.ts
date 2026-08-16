import type { ChatMessage } from '../../types/chat'
import type {
  Mentionable,
  MentionableAssistantQuote,
  MentionableBlock,
  MentionableBlockData,
} from '../../types/mentionable'

import {
  getBlockContentHash,
  getBlockMentionableCountInfo,
  getMentionableKey,
  serializeMentionable,
} from './mentionable'

export const normalizeSelectionSource = (
  source: MentionableBlockData['source'],
): 'selection-sync' | 'selection-pinned' => {
  return source === 'selection-pinned' ? 'selection-pinned' : 'selection-sync'
}

export const createSelectionBlockMentionable = (
  selectedBlock: MentionableBlockData,
): MentionableBlock => {
  const { count, unit } = getBlockMentionableCountInfo(selectedBlock.content)
  const source = normalizeSelectionSource(selectedBlock.source)
  return {
    type: 'block',
    ...selectedBlock,
    source,
    contentHash:
      selectedBlock.contentHash ?? getBlockContentHash(selectedBlock.content),
    contentCount: selectedBlock.contentCount ?? count,
    contentUnit: selectedBlock.contentUnit ?? unit,
  }
}

export const createAssistantQuoteMentionable = ({
  id,
  annotationNumber,
  conversationId,
  messageId,
  content,
  comment,
  selector,
}: {
  id?: string
  annotationNumber?: number
  conversationId: string
  messageId: string
  content: string
  comment?: string
  selector?: MentionableAssistantQuote['selector']
}): MentionableAssistantQuote => {
  const trimmedContent = content.trim()
  const { count, unit } = getBlockMentionableCountInfo(trimmedContent)
  return {
    type: 'assistant-quote',
    id,
    annotationNumber,
    conversationId,
    messageId,
    content: trimmedContent,
    comment,
    selector,
    contentHash: getBlockContentHash(trimmedContent),
    contentCount: count,
    contentUnit: unit,
  }
}

/**
 * Highest `annotationNumber` currently reserved in `mentionables`, across
 * every mentionable kind that participates in the shared annotation pool
 * (assistant-quote and PDF-quote blocks — see docs/plans/2026-08-16-pdf-
 * annotation-quotes.md, architecture decision A). The number pool is shared
 * so a fresh annotation — of either kind — can never collide with an
 * existing "批注N" in the same input.
 */
export const getMaxAssistantQuoteNumber = (
  mentionables: readonly Mentionable[],
): number => {
  const quotes = mentionables.filter(
    (mentionable): mentionable is MentionableAssistantQuote =>
      mentionable.type === 'assistant-quote',
  )
  const numberedMentionables: Array<
    MentionableAssistantQuote | MentionableBlock
  > = [
    ...quotes,
    ...mentionables.filter(
      (mentionable): mentionable is MentionableBlock =>
        mentionable.type === 'block' &&
        mentionable.annotationNumber !== undefined,
    ),
  ]
  const highestAnnotationNumber = numberedMentionables.reduce(
    (highest, item) => Math.max(highest, item.annotationNumber ?? 0),
    0,
  )
  // Legacy safety net: quotes persisted before annotationNumber existed have
  // no number at all — reserve at least one slot per quote so a freshly
  // numbered one can't collide with an unlabeled legacy quote.
  return Math.max(highestAnnotationNumber, quotes.length)
}

export const addOrUpdateMentionable = (
  mentionables: Mentionable[],
  mentionable: Mentionable,
): Mentionable[] => {
  const mentionableKey = getMentionableKey(serializeMentionable(mentionable))
  const existingIndex = mentionables.findIndex(
    (item) => getMentionableKey(serializeMentionable(item)) === mentionableKey,
  )
  if (existingIndex < 0) return [...mentionables, mentionable]
  if (mentionable.type !== 'assistant-quote' || !mentionable.id) {
    return mentionables
  }
  const next = [...mentionables]
  next[existingIndex] = mentionable
  return next
}

export const isSyncSelectionSource = (
  source: MentionableBlock['source'],
): boolean => {
  return source === 'selection' || source === 'selection-sync'
}

export const isSyncSelectionMentionable = (
  mentionable: Mentionable,
): boolean => {
  if (mentionable.type === 'block') {
    return isSyncSelectionSource(mentionable.source)
  }
  return (
    mentionable.type === 'web-selection' &&
    mentionable.source === 'web-selection-sync'
  )
}

export const isSelectionBlockMentionable = (
  mentionable: Mentionable,
): mentionable is MentionableBlock => {
  return (
    mentionable.type === 'block' &&
    (mentionable.source === 'selection' ||
      mentionable.source === 'selection-sync' ||
      mentionable.source === 'selection-pinned')
  )
}

export const collectSelectionHighlightIds = (
  mentionables: Mentionable[],
): string[] => {
  const ids = new Set<string>()
  for (const mentionable of mentionables) {
    if (!isSelectionBlockMentionable(mentionable)) continue
    if (mentionable.highlightId) ids.add(mentionable.highlightId)
  }
  return Array.from(ids)
}

export const collectSelectionHighlightIdsFromMessages = (
  messages: ChatMessage[],
): string[] => {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const id of collectSelectionHighlightIds(message.mentionables)) {
      ids.add(id)
    }
  }
  return Array.from(ids)
}

export const collectRemovedSelectionHighlightIds = (
  previousMentionables: Mentionable[],
  nextMentionables: Mentionable[],
): string[] => {
  const nextIds = new Set(collectSelectionHighlightIds(nextMentionables))
  return collectSelectionHighlightIds(previousMentionables).filter(
    (id) => !nextIds.has(id),
  )
}

export const collectSelectionHighlightIdsByMentionableKey = (
  mentionables: Mentionable[],
  mentionableKey: string,
): string[] => {
  return collectSelectionHighlightIds(
    mentionables.filter(
      (mentionable) =>
        getMentionableKey(serializeMentionable(mentionable)) === mentionableKey,
    ),
  )
}
