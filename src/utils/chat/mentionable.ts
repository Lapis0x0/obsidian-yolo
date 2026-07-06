import { App } from 'obsidian'

import type {
  Mentionable,
  MentionableTextAttachment,
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
        pageNumber: mentionable.pageNumber,
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
    case 'web-selection':
      return {
        type: 'web-selection',
        content: mentionable.content,
        url: mentionable.url,
        title: mentionable.title,
        pageId: mentionable.pageId,
        source: mentionable.source,
        contentHash:
          mentionable.contentHash ?? getBlockContentHash(mentionable.content),
        contentCount: mentionable.contentCount,
        contentUnit: mentionable.contentUnit,
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
        // rawData (base64 of original bytes) is the source-of-truth for new
        // uploads; legacy mentionables only have `data` (extracted text).
        // Persist whichever is present so reload/replay reproduces faithfully.
        rawData: mentionable.rawData,
        data: mentionable.data,
        pageCount: mentionable.pageCount,
      }
    case 'office':
      return {
        type: 'office',
        name: mentionable.name,
        kind: mentionable.kind,
        rawData: mentionable.rawData,
        extractedText: mentionable.extractedText,
      }
    case 'text-attachment':
      return {
        type: 'text-attachment',
        name: mentionable.name,
        kind: mentionable.kind,
        content: mentionable.content,
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
          pageNumber: mentionable.pageNumber,
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
      case 'web-selection': {
        if (
          typeof mentionable.content !== 'string' ||
          typeof mentionable.url !== 'string' ||
          typeof mentionable.title !== 'string'
        ) {
          return null
        }
        return {
          type: 'web-selection',
          content: mentionable.content,
          url: mentionable.url,
          title: mentionable.title,
          pageId: mentionable.pageId,
          source: mentionable.source,
          contentHash:
            mentionable.contentHash ?? getBlockContentHash(mentionable.content),
          contentCount: mentionable.contentCount,
          contentUnit: mentionable.contentUnit,
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
        const rawData =
          typeof mentionable.rawData === 'string' ? mentionable.rawData : null
        const data =
          typeof mentionable.data === 'string' ? mentionable.data : null
        // Need at least one of: rawData (native path) or data (legacy text fallback).
        if (!rawData && !data) {
          return null
        }
        return {
          type: 'pdf',
          name: mentionable.name,
          ...(rawData ? { rawData } : {}),
          ...(data ? { data } : {}),
          pageCount: mentionable.pageCount,
        }
      }
      case 'office': {
        if (
          typeof mentionable.name !== 'string' ||
          (mentionable.kind !== 'docx' &&
            mentionable.kind !== 'pptx' &&
            mentionable.kind !== 'xlsx') ||
          typeof mentionable.rawData !== 'string' ||
          typeof mentionable.extractedText !== 'string'
        ) {
          return null
        }
        return {
          type: 'office',
          name: mentionable.name,
          kind: mentionable.kind,
          rawData: mentionable.rawData,
          extractedText: mentionable.extractedText,
        }
      }
      case 'text-attachment': {
        const allowedKinds: ReadonlyArray<MentionableTextAttachment['kind']> = [
          'txt',
          'md',
          'csv',
          'tsv',
          'json',
          'yaml',
          'yml',
          'xml',
          'log',
        ]
        if (
          typeof mentionable.name !== 'string' ||
          typeof mentionable.kind !== 'string' ||
          !allowedKinds.includes(mentionable.kind) ||
          typeof mentionable.content !== 'string'
        ) {
          return null
        }
        return {
          type: 'text-attachment',
          name: mentionable.name,
          kind: mentionable.kind,
          content: mentionable.content,
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
    case 'block': {
      const pageTag =
        mentionable.pageNumber !== undefined
          ? `:p${mentionable.pageNumber}`
          : ''
      return `block:${mentionable.file}:${mentionable.startLine}:${mentionable.endLine}${pageTag}:${mentionable.contentHash ?? (typeof mentionable.content === 'string' ? getBlockContentHash(mentionable.content) : 'nohash')}`
    }
    case 'assistant-quote':
      return `assistant-quote:${mentionable.conversationId}:${mentionable.messageId}:${mentionable.contentHash ?? (typeof mentionable.content === 'string' ? getBlockContentHash(mentionable.content) : 'nohash')}`
    case 'url':
      return `url:${mentionable.url}`
    case 'web-selection':
      return `web-selection:${mentionable.url}:${mentionable.contentHash ?? getBlockContentHash(mentionable.content)}`
    case 'image':
      return `image:${mentionable.name}:${mentionable.data.length}:${mentionable.data.slice(-32)}`
    case 'pdf': {
      // Identity is keyed by whichever payload is present: rawData (new
      // uploads) or the legacy `data` text (mentionables serialized before
      // native PDF support). Both are persistent enough to dedupe with.
      const payload = mentionable.rawData ?? mentionable.data ?? ''
      return `pdf:${mentionable.name}:${payload.length}:${payload.slice(-32)}`
    }
    case 'office':
      return `office:${mentionable.name}:${mentionable.kind}:${mentionable.rawData.length}:${mentionable.rawData.slice(-32)}`
    case 'text-attachment':
      return `text-attachment:${mentionable.name}:${mentionable.kind}:${mentionable.content.length}:${getBlockContentHash(mentionable.content)}`
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

export type MentionableUnitLabels = Partial<
  Record<MentionableBlockUnit, string>
>

function resolveUnitLabel(
  unit: MentionableBlockUnit,
  unitLabels?: MentionableUnitLabels,
): string {
  return unitLabels?.[unit] ?? unit
}

export function getMentionableName(
  mentionable: Mentionable,
  options?: {
    unitLabels?: MentionableUnitLabels
    currentFileLabel?: string
  },
): string {
  switch (mentionable.type) {
    case 'file':
      return mentionable.file.name
    case 'folder':
      return mentionable.folder.name
    case 'block': {
      const info = getBlockMentionableCountInfo(mentionable.content)
      const count = mentionable.contentCount ?? info.count
      const unit = mentionable.contentUnit ?? info.unit
      const unitLabel = resolveUnitLabel(unit, options?.unitLabels)
      return `${mentionable.file.name} (${count} ${unitLabel})`
    }
    case 'assistant-quote': {
      const info = getBlockMentionableCountInfo(mentionable.content)
      const count = mentionable.contentCount ?? info.count
      const unit = mentionable.contentUnit ?? info.unit
      const unitLabel = resolveUnitLabel(unit, options?.unitLabels)
      return `Assistant quote (${count} ${unitLabel})`
    }
    case 'url':
      return mentionable.url
    case 'web-selection': {
      const info = getBlockMentionableCountInfo(mentionable.content)
      const count = mentionable.contentCount ?? info.count
      const unit = mentionable.contentUnit ?? info.unit
      const unitLabel = resolveUnitLabel(unit, options?.unitLabels)
      return `${mentionable.title || mentionable.url} (${count} ${unitLabel})`
    }
    case 'image':
      return mentionable.name
    case 'pdf':
      return mentionable.name
    case 'office':
      return mentionable.name
    case 'text-attachment':
      return mentionable.name
    case 'model':
      return mentionable.name
  }
}
