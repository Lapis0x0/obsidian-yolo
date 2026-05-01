import { App } from 'obsidian'

import type {
  Mentionable,
  SerializedMentionable,
} from '../../types/mentionable'

export function getBlockContentHash(content: string): string {
  let hash = 2166136261
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export const serializeMentionable = (
  mentionable: Mentionable,
): SerializedMentionable => {
  switch (mentionable.type) {
    case 'file':
      return {
        type: 'file',
        file: mentionable.file.path,
      }
    case 'folder':
      return {
        type: 'folder',
        folder: mentionable.folder.path,
      }
    case 'block':
      return {
        type: 'block',
        content: mentionable.content,
        file: mentionable.file.path,
        startLine: mentionable.startLine,
        endLine: mentionable.endLine,
        source: mentionable.source,
        contentHash:
          mentionable.contentHash ?? getBlockContentHash(mentionable.content),
        contentCount: mentionable.contentCount,
        contentUnit: mentionable.contentUnit,
      }
    case 'assistant-quote':
      return {
        type: 'assistant-quote',
        conversationId: mentionable.conversationId,
        messageId: mentionable.messageId,
        content: mentionable.content,
        contentHash:
          mentionable.contentHash ?? getBlockContentHash(mentionable.content),
        contentCount: mentionable.contentCount,
        contentUnit: mentionable.contentUnit,
      }
    case 'url':
      return {
        type: 'url',
        url: mentionable.url,
      }
    case 'image':
      return {
        type: 'image',
        name: mentionable.name,
        mimeType: mentionable.mimeType,
        data: mentionable.data,
      }
    case 'pdf':
      return {
        type: 'pdf',
        name: mentionable.name,
        data: mentionable.data,
        pageCount: mentionable.pageCount,
        truncated: mentionable.truncated,
      }
    case 'model':
      return {
        type: 'model',
        modelId: mentionable.modelId,
        name: mentionable.name,
        providerId: mentionable.providerId,
      }
  }
}

export const deserializeMentionable = (
  mentionable: SerializedMentionable,
  app: App,
): Mentionable | null => {
  try {
    switch (mentionable.type) {
      default:
        // Unknown/legacy types persisted in old conversations (e.g. 'vault'
        // from the removed Vault similarity search feature, or 'current-file'
        // from the removed focus-sync badge path) are silently dropped so
        // they disappear on next save.
        return null
      case 'file': {
        const filePath =
          typeof mentionable.file === 'string' ? mentionable.file : null
        if (!filePath) {
          return null
        }
        const file = app.vault.getFileByPath(filePath)
        if (!file) {
          return null
        }
        return {
          type: 'file',
          file: file,
        }
      }
      case 'folder': {
        const folderPath =
          typeof mentionable.folder === 'string' ? mentionable.folder : null
        if (!folderPath) {
          return null
        }
        const folder = app.vault.getFolderByPath(folderPath)
        if (!folder) {
          return null
        }
        return {
          type: 'folder',
          folder: folder,
        }
      }
      case 'block': {
        const filePath =
          typeof mentionable.file === 'string' ? mentionable.file : null
        if (!filePath) {
          return null
        }
        if (typeof mentionable.content !== 'string') {
          // Lightweight inline block token can be pasted across contexts.
          // Without original content, it cannot be used as a runnable mentionable.
          return null
        }
        const file = app.vault.getFileByPath(filePath)
        if (!file) {
          return null
        }
        return {
          type: 'block',
          content: mentionable.content,
          file: file,
          startLine: mentionable.startLine,
          endLine: mentionable.endLine,
          source: mentionable.source,
          contentHash:
            mentionable.contentHash ?? getBlockContentHash(mentionable.content),
          contentCount: mentionable.contentCount,
          contentUnit: mentionable.contentUnit,
        }
      }
      case 'assistant-quote': {
        if (typeof mentionable.content !== 'string') {
          return null
        }
        return {
          type: 'assistant-quote',
          conversationId: mentionable.conversationId,
          messageId: mentionable.messageId,
          content: mentionable.content,
          contentHash:
            mentionable.contentHash ?? getBlockContentHash(mentionable.content),
          contentCount: mentionable.contentCount,
          contentUnit: mentionable.contentUnit,
        }
      }
      case 'url': {
        return {
          type: 'url',
          url: mentionable.url,
        }
      }
      case 'image': {
        return {
          type: 'image',
          name: mentionable.name,
          mimeType: mentionable.mimeType,
          data: mentionable.data,
        }
      }
      case 'pdf': {
        if (typeof mentionable.data !== 'string') {
          return null
        }
        return {
          type: 'pdf',
          name: mentionable.name,
          data: mentionable.data,
          pageCount: mentionable.pageCount,
          truncated: mentionable.truncated,
        }
      }
      case 'model': {
        return {
          type: 'model',
          modelId: mentionable.modelId,
          name: mentionable.name,
          providerId: mentionable.providerId,
        }
      }
    }
  } catch (e) {
    console.error('Error deserializing mentionable', e)
    return null
  }
}

export function getMentionableKey(mentionable: SerializedMentionable): string {
  switch (mentionable.type) {
    case 'file':
      return `file:${mentionable.file}`
    case 'folder':
      return `folder:${mentionable.folder}`
    case 'block':
      return `block:${mentionable.file}:${mentionable.startLine}:${mentionable.endLine}:${mentionable.contentHash ?? (typeof mentionable.content === 'string' ? getBlockContentHash(mentionable.content) : 'nohash')}`
    case 'assistant-quote':
      return `assistant-quote:${mentionable.conversationId}:${mentionable.messageId}:${mentionable.contentHash ?? (typeof mentionable.content === 'string' ? getBlockContentHash(mentionable.content) : 'nohash')}`
    case 'url':
      return `url:${mentionable.url}`
    case 'image':
      return `image:${mentionable.name}:${mentionable.data.length}:${mentionable.data.slice(-32)}`
    case 'pdf':
      return `pdf:${mentionable.name}:${mentionable.data.length}:${mentionable.data.slice(-32)}`
    case 'model':
      return `model:${mentionable.modelId}`
  }
}

export type MentionableBlockUnit = 'characters' | 'words' | 'wordsCharacters'

export function getBlockMentionableCountInfo(
  content: string | null | undefined,
): {
  count: number
  unit: MentionableBlockUnit
} {
  const rawContent = content ?? ''
  const trimmedContent = rawContent.trim()
  const hasCjk = /[\u3400-\u9fff]/.test(rawContent)
  const hasNonCjkWord = /[A-Za-z0-9]/.test(rawContent)
  const fallbackWordCount = (text: string) => {
    const SegmenterCtor = (
      Intl as typeof Intl & {
        Segmenter?: new (
          locales?: string | string[],
          options?: { granularity: 'word' | 'sentence' | 'grapheme' },
        ) => {
          segment: (
            input: string,
          ) => Iterable<{ isWordLike?: boolean; segment: string }>
        }
      }
    ).Segmenter
    if (SegmenterCtor) {
      const segmenter = new SegmenterCtor(undefined, { granularity: 'word' })
      let total = 0
      for (const segment of segmenter.segment(text)) {
        if (segment.isWordLike) {
          const segmentHasCjk = /[\u3400-\u9fff]/.test(segment.segment)
          if (segmentHasCjk) {
            total += Array.from(
              segment.segment.replace(/[^\u3400-\u9fff]/g, ''),
            ).length
          } else {
            total += 1
          }
        }
      }
      return total
    }
    const matches = text.match(/[\p{L}\p{N}]+/gu)
    if (!matches) return 0
    return matches.reduce((sum, match) => {
      if (/[\u3400-\u9fff]/.test(match)) {
        return sum + Array.from(match.replace(/[^\u3400-\u9fff]/g, '')).length
      }
      return sum + 1
    }, 0)
  }
  const count =
    trimmedContent.length === 0 ? 0 : fallbackWordCount(trimmedContent)
  const unit: MentionableBlockUnit = hasCjk
    ? hasNonCjkWord
      ? 'wordsCharacters'
      : 'characters'
    : 'words'
  return { count, unit }
}

export function getMentionableName(
  mentionable: Mentionable,
  options?: {
    unitLabel?: string
    currentFileLabel?: string
  },
): string {
  switch (mentionable.type) {
    case 'file':
      return mentionable.file.name
    case 'folder':
      return mentionable.folder.name
    case 'block': {
      const count =
        mentionable.contentCount ??
        getBlockMentionableCountInfo(mentionable.content).count
      const unitLabel = options?.unitLabel ?? 'chars'
      return `${mentionable.file.name} (${count} ${unitLabel})`
    }
    case 'assistant-quote': {
      const count =
        mentionable.contentCount ??
        getBlockMentionableCountInfo(mentionable.content).count
      const unitLabel = options?.unitLabel ?? 'chars'
      return `Assistant quote (${count} ${unitLabel})`
    }
    case 'url':
      return mentionable.url
    case 'image':
      return mentionable.name
    case 'pdf':
      return mentionable.name
    case 'model':
      return mentionable.name
  }
}
