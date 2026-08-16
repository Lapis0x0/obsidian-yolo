import { TFile, TFolder } from 'obsidian'

export type MentionableFile = {
  type: 'file'
  file: TFile
}
export type MentionableFolder = {
  type: 'folder'
  folder: TFolder
}
/**
 * A directory outside the vault, referenced by absolute filesystem path.
 *
 * Vault folders resolve to a `TFolder` and have their contents read into the
 * prompt; a directory outside the vault has no such reader, so the path itself
 * is the context — the agent reaches it through the terminal / read tools.
 */
export type MentionableLocalFolder = {
  type: 'local-folder'
  path: string
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
  pageNumber?: number // 1-indexed; present when selection originates from a PDF view
  source?: 'selection' | 'selection-sync' | 'selection-pinned'
  highlightId?: string // runtime-only; links this mention to its visual highlight; not persisted
  contentFormat?: 'markdown-table'
  contentHash?: string
  contentCount?: number
  contentUnit?: 'characters' | 'words' | 'wordsCharacters'
  tableRowCount?: number
  tableColumnCount?: number
  // PDF multi-quote annotation (see docs/plans/2026-08-16-pdf-annotation-quotes.md).
  // Both are set together by the chat side when a PDF selection is turned into
  // a numbered annotation via the PDF "quote" button; plain (non-annotated)
  // blocks — including the existing add-to-sidebar path — never set these.
  comment?: string
  annotationNumber?: number
}
export type MentionableBlock = MentionableBlockData & {
  type: 'block'
}
export type MentionableAssistantQuote = {
  type: 'assistant-quote'
  id?: string
  annotationNumber?: number
  conversationId: string
  messageId: string
  content: string
  comment?: string
  selector?: {
    start: number
    end: number
    exact: string
    prefix?: string
    suffix?: string
  }
  contentHash?: string
  contentCount?: number
  contentUnit?: 'characters' | 'words' | 'wordsCharacters'
}
export type MentionableUrl = {
  type: 'url'
  url: string
}
export type MentionableWebSelection = {
  type: 'web-selection'
  content: string
  url: string
  title: string
  pageId?: string
  source?: 'web-selection-sync' | 'web-selection-pinned'
  contentHash?: string
  contentCount?: number
  contentUnit?: 'characters' | 'words' | 'wordsCharacters'
}
export type MentionableImage = {
  type: 'image'
  name: string
  mimeType: string
  data: string // base64 data URL
}
export type MentionablePDF = {
  type: 'pdf'
  name: string
  // Base64-encoded original PDF bytes. Canonical source-of-truth for native PDF
  // adapters (Gemini / Anthropic). Optional only for legacy mentionables
  // serialized before native PDF support — those carry text in `data` instead.
  rawData?: string
  // Legacy field: pre-extracted plain text (pages joined). For new uploads this
  // stays undefined until something needs the text fallback. Kept as `data`
  // (rather than renamed) so old chat history deserializes unchanged.
  data?: string
  pageCount?: number
}
export type MentionableOffice = {
  type: 'office'
  name: string
  kind: 'docx' | 'pptx' | 'xlsx'
  rawData: string
  extractedText: string
}
export type TextAttachmentKind =
  | 'txt'
  | 'md'
  | 'csv'
  | 'tsv'
  | 'json'
  | 'yaml'
  | 'yml'
  | 'xml'
  | 'log'
export type MentionableTextAttachment = {
  type: 'text-attachment'
  name: string
  kind: TextAttachmentKind
  content: string
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
  | MentionableLocalFolder
  | MentionableBlock
  | MentionableAssistantQuote
  | MentionableUrl
  | MentionableWebSelection
  | MentionableImage
  | MentionablePDF
  | MentionableOffice
  | MentionableTextAttachment
  | MentionableModel
export type SerializedMentionableFile = {
  type: 'file'
  file: string
}
export type SerializedMentionableFolder = {
  type: 'folder'
  folder: string
}
export type SerializedMentionableLocalFolder = MentionableLocalFolder
export type SerializedMentionableBlock = {
  type: 'block'
  content?: string
  file: string
  startLine: number
  endLine: number
  pageNumber?: number
  source?: 'selection' | 'selection-sync' | 'selection-pinned'
  contentFormat?: 'markdown-table'
  contentHash?: string
  contentCount?: number
  contentUnit?: 'characters' | 'words' | 'wordsCharacters'
  tableRowCount?: number
  tableColumnCount?: number
  comment?: string
  annotationNumber?: number
}
export type SerializedMentionableAssistantQuote = {
  type: 'assistant-quote'
  id?: string
  annotationNumber?: number
  conversationId: string
  messageId: string
  content?: string
  comment?: string
  selector?: {
    start: number
    end: number
    exact: string
    prefix?: string
    suffix?: string
  }
  contentHash?: string
  contentCount?: number
  contentUnit?: 'characters' | 'words' | 'wordsCharacters'
}
export type SerializedMentionableUrl = MentionableUrl
export type SerializedMentionableWebSelection = MentionableWebSelection
export type SerializedMentionableImage = MentionableImage
export type SerializedMentionablePDF = MentionablePDF
export type SerializedMentionableOffice = MentionableOffice
export type SerializedMentionableTextAttachment = MentionableTextAttachment
export type SerializedMentionableModel = MentionableModel
export type SerializedMentionable =
  | SerializedMentionableFile
  | SerializedMentionableFolder
  | SerializedMentionableLocalFolder
  | SerializedMentionableBlock
  | SerializedMentionableAssistantQuote
  | SerializedMentionableUrl
  | SerializedMentionableWebSelection
  | SerializedMentionableImage
  | SerializedMentionablePDF
  | SerializedMentionableOffice
  | SerializedMentionableTextAttachment
  | SerializedMentionableModel
