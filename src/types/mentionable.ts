import { TFile, TFolder } from 'obsidian'

export type MentionableFile = {
  type: 'file'
  file: TFile
}
export type MentionableFolder = {
  type: 'folder'
  folder: TFolder
}

export type CurrentFileViewState =
  | {
      kind: 'markdown-edit'
      visibleStartLine: number // 1-indexed
      visibleEndLine: number // 1-indexed, inclusive
      cursorLine: number // 1-indexed
      totalLines: number
    }
  | {
      kind: 'pdf'
      currentPage: number // 1-indexed
      totalPages: number
    }
  | {
      kind: 'other'
      totalLines?: number
    }

export type MentionableBlockData = {
  content: string
  file: TFile
  startLine: number
  endLine: number
  source?: 'selection' | 'selection-sync' | 'selection-pinned'
  contentHash?: string
  contentCount?: number
  contentUnit?: 'characters' | 'words' | 'wordsCharacters'
}
export type MentionableBlock = MentionableBlockData & {
  type: 'block'
}
export type MentionableAssistantQuote = {
  type: 'assistant-quote'
  conversationId: string
  messageId: string
  content: string
  contentHash?: string
  contentCount?: number
  contentUnit?: 'characters' | 'words' | 'wordsCharacters'
}
export type MentionableUrl = {
  type: 'url'
  url: string
}
export type MentionableImage = {
  type: 'image'
  name: string
  mimeType: string
  data: string // base64
}
export type MentionablePDF = {
  type: 'pdf'
  name: string
  data: string // extracted plain text (pages joined)
  pageCount?: number
  truncated?: boolean
}
export type MentionableModel = {
  type: 'model'
  modelId: string
  name: string
  providerId?: string
}
export type Mentionable =
  | MentionableFile
  | MentionableFolder
  | MentionableBlock
  | MentionableAssistantQuote
  | MentionableUrl
  | MentionableImage
  | MentionablePDF
  | MentionableModel
export type SerializedMentionableFile = {
  type: 'file'
  file: string
}
export type SerializedMentionableFolder = {
  type: 'folder'
  folder: string
}
export type SerializedMentionableBlock = {
  type: 'block'
  content?: string
  file: string
  startLine: number
  endLine: number
  source?: 'selection' | 'selection-sync' | 'selection-pinned'
  contentHash?: string
  contentCount?: number
  contentUnit?: 'characters' | 'words' | 'wordsCharacters'
}
export type SerializedMentionableAssistantQuote = {
  type: 'assistant-quote'
  conversationId: string
  messageId: string
  content?: string
  contentHash?: string
  contentCount?: number
  contentUnit?: 'characters' | 'words' | 'wordsCharacters'
}
export type SerializedMentionableUrl = MentionableUrl
export type SerializedMentionableImage = MentionableImage
export type SerializedMentionablePDF = MentionablePDF
export type SerializedMentionableModel = MentionableModel
export type SerializedMentionable =
  | SerializedMentionableFile
  | SerializedMentionableFolder
  | SerializedMentionableBlock
  | SerializedMentionableAssistantQuote
  | SerializedMentionableUrl
  | SerializedMentionableImage
  | SerializedMentionablePDF
  | SerializedMentionableModel
