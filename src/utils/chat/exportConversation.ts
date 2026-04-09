import type { App } from 'obsidian'
import { TFolder, normalizePath } from 'obsidian'

import { editorStateToPlainText } from '../../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import type { ChatManager } from '../../database/json/chat/ChatManager'
import { readPromptSnapshotEntries } from '../../database/json/chat/promptSnapshotStore'
import type { ChatConversation } from '../../database/json/chat/types'
import {
  type SerializedChatAssistantMessage,
  type SerializedChatMessage,
  type SerializedChatToolMessage,
  type SerializedChatUserMessage,
  normalizeChatConversationCompactionState,
} from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import type { SerializedMentionable } from '../../types/mentionable'
import {
  type ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsText,
} from '../../types/tool-call.types'

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

type SerializedAssistantToolMessageGroup = Array<
  SerializedChatAssistantMessage | SerializedChatToolMessage
>

export type ConversationToMarkdownOptions = {
  snapshotEntries: Record<string, string | ContentPart[]>
  exportedAtIso: string
  /** When true (default), only include the active branch per user turn. */
  filterBranches?: boolean
}

const WINDOWS_FORBIDDEN_FILENAME_CHARS = /[<>:"/\\|?*]/g

function stripControlAndInvalidFileChars(input: string): string {
  return [...input]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0
      if (code < 32) {
        return '_'
      }
      return ch
    })
    .join('')
    .replace(WINDOWS_FORBIDDEN_FILENAME_CHARS, '_')
}

export function sanitizeExportFileBaseName(raw: string): string {
  const trimmed = raw.trim() || 'chat'
  const withoutInvalid = stripControlAndInvalidFileChars(trimmed).replace(
    /\s+/g,
    ' ',
  )
  const collapsed = withoutInvalid.replace(/\.+$/g, '').trim()
  return collapsed.length > 0 ? collapsed : 'chat'
}

function formatDateYmd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function buildExportFileBaseName(title: string, date: Date): string {
  return `${sanitizeExportFileBaseName(title)} - ${formatDateYmd(date)}`
}

function yamlDoubleQuotedString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')}"`
}

function promptContentToPlainText(
  promptContent: string | ContentPart[] | null | undefined,
): string {
  if (!promptContent) return ''
  if (typeof promptContent === 'string') return promptContent
  return promptContent
    .map((part) => (part.type === 'text' ? part.text : '[image]'))
    .join('')
}

function resolveUserPromptPlainText(
  message: SerializedChatUserMessage,
  snapshotEntries: Record<string, string | ContentPart[]>,
): string {
  if (message.promptContent) {
    return promptContentToPlainText(message.promptContent)
  }
  const hash = message.snapshotRef?.hash
  if (hash && snapshotEntries[hash]) {
    return promptContentToPlainText(snapshotEntries[hash])
  }
  return ''
}

function mentionablesToMarkdownLines(
  mentionables: SerializedMentionable[],
): string[] {
  const lines: string[] = []
  for (const m of mentionables) {
    switch (m.type) {
      case 'file':
        lines.push(`[[${m.file}]]`)
        break
      case 'folder':
        lines.push(`Folder: \`${m.folder}\``)
        break
      case 'current-file':
        if (m.file) {
          lines.push(`Current file: [[${m.file}]]`)
        } else {
          lines.push('Current file: (none)')
        }
        break
      case 'block':
        lines.push(`Block in \`${m.file}\` (lines ${m.startLine}–${m.endLine})`)
        break
      case 'vault':
        lines.push('Vault')
        break
      case 'url':
        lines.push(`<${m.url}>`)
        break
      case 'assistant-quote':
        lines.push('Assistant quote')
        break
      case 'image':
        lines.push(`Image: ${m.name}`)
        break
      case 'model':
        lines.push(`Model: ${m.name}`)
        break
      default:
        break
    }
  }
  return lines
}

function groupSerializedAssistantAndToolMessages(
  messages: SerializedChatMessage[],
): (SerializedChatUserMessage | SerializedAssistantToolMessageGroup)[] {
  return messages.reduce(
    (
      acc: (SerializedChatUserMessage | SerializedAssistantToolMessageGroup)[],
      message,
    ) => {
      if (message.role === 'user') {
        acc.push(message)
      } else {
        const lastItem = acc[acc.length - 1]
        if (
          Array.isArray(lastItem) &&
          (message.role === 'assistant' || message.role === 'tool')
        ) {
          lastItem.push(message)
        } else {
          acc.push([message])
        }
      }
      return acc
    },
    [],
  )
}

function getSerializedSourceUserMessageIdForGroup(
  messages: SerializedAssistantToolMessageGroup,
): string | null {
  for (const message of messages) {
    const sourceUserMessageId = message.metadata?.sourceUserMessageId
    if (sourceUserMessageId) {
      return sourceUserMessageId
    }
  }
  return null
}

function getDisplayedSerializedAssistantToolGroup(
  messages: SerializedAssistantToolMessageGroup,
  activeBranchKey?: string | null,
): SerializedAssistantToolMessageGroup {
  const isBranchCompleted = (
    branchMessages: SerializedAssistantToolMessageGroup,
  ) => {
    const latestMessage = branchMessages.at(-1)
    if (latestMessage?.metadata?.branchWaitingApproval) {
      return false
    }
    if (latestMessage?.metadata?.branchRunStatus) {
      return latestMessage.metadata.branchRunStatus === 'completed'
    }
    return branchMessages.some(
      (message) =>
        message.role === 'assistant' &&
        message.metadata?.generationState === 'completed',
    )
  }

  const branchGroups = new Map<string, SerializedAssistantToolMessageGroup>()
  messages.forEach((message) => {
    const branchId = message.metadata?.branchId
    if (!branchId) {
      return
    }
    const existing = branchGroups.get(branchId)
    if (existing) {
      existing.push(message)
      return
    }
    branchGroups.set(branchId, [message])
  })

  const groupedBranches = Array.from(branchGroups.values())
  if (groupedBranches.length <= 1) {
    return messages
  }

  const resolvedActiveBranchKey =
    activeBranchKey ??
    groupedBranches.find((branchMessages) =>
      isBranchCompleted(branchMessages),
    )?.[0]?.metadata?.branchId ??
    groupedBranches[0]?.[0]?.metadata?.branchId ??
    null

  return (
    groupedBranches.find(
      (branchMessages) =>
        branchMessages[0]?.metadata?.branchId === resolvedActiveBranchKey,
    ) ??
    groupedBranches[0] ??
    messages
  )
}

function flattenSerializedForExport(
  grouped: (SerializedChatUserMessage | SerializedAssistantToolMessageGroup)[],
  activeBranchByUserMessageId: Record<string, string> | undefined,
): SerializedChatMessage[] {
  const flat: SerializedChatMessage[] = []
  const branchMap = activeBranchByUserMessageId ?? {}

  for (const item of grouped) {
    if (!Array.isArray(item)) {
      flat.push(item)
      continue
    }
    const sourceUserId = getSerializedSourceUserMessageIdForGroup(item)
    const activeKey =
      sourceUserId && branchMap[sourceUserId]
        ? branchMap[sourceUserId]
        : undefined
    flat.push(...getDisplayedSerializedAssistantToolGroup(item, activeKey))
  }

  return flat
}

function toolResponseToMarkdownSnippet(response: ToolCallResponse): string {
  if (response.status === ToolCallResponseStatus.Success) {
    return response.data.text
  }
  if (response.status === ToolCallResponseStatus.Error) {
    return `Error: ${response.error}`
  }
  if (response.status === ToolCallResponseStatus.Aborted) {
    return '(aborted)'
  }
  if (
    response.status === ToolCallResponseStatus.PendingApproval ||
    response.status === ToolCallResponseStatus.Rejected ||
    response.status === ToolCallResponseStatus.Running
  ) {
    return `(${response.status})`
  }
  return ''
}

function appendAssistantMessageToLines(
  message: SerializedChatAssistantMessage,
  lines: string[],
): void {
  lines.push('## Assistant', '')
  if (message.reasoning?.trim()) {
    lines.push(
      '> [!note]- Thinking',
      ...message.reasoning.split('\n').map((line) => `> ${line}`),
      '',
    )
  }
  if (message.content?.trim()) {
    lines.push(message.content.trim(), '')
  }
}

const MENTIONED_VAULT_FILES_HEADING = '## Mentioned Vault Files (outline only)'
const MENTIONED_VAULT_FILES_EXPLANATION =
  'This section provides only paths and outlines. Use file tools only if you need the full contents or a specific line range.'

function extractMentionedVaultFilesSection(body: string): {
  bodyWithoutMentionedSection: string
  mentionedSection: string | null
} {
  const trimmedBody = body.trim()
  if (!trimmedBody.startsWith(MENTIONED_VAULT_FILES_HEADING)) {
    return {
      bodyWithoutMentionedSection: body,
      mentionedSection: null,
    }
  }

  const explanationIndex = trimmedBody.indexOf(
    MENTIONED_VAULT_FILES_EXPLANATION,
  )
  if (explanationIndex === -1) {
    return {
      bodyWithoutMentionedSection: body,
      mentionedSection: null,
    }
  }

  const sectionEnd = explanationIndex + MENTIONED_VAULT_FILES_EXPLANATION.length
  const mentionedSection = trimmedBody.slice(0, sectionEnd).trim()
  const remainingBody = trimmedBody.slice(sectionEnd).trim()

  return {
    bodyWithoutMentionedSection: remainingBody,
    mentionedSection,
  }
}

function appendMentionedVaultFilesCalloutToLines(
  mentionedSection: string,
  lines: string[],
): void {
  const normalizedLines = mentionedSection
    .split('\n')
    .filter((line, index, allLines) => {
      if (index === 0 && line.trim() === MENTIONED_VAULT_FILES_HEADING) {
        return false
      }

      const previousLine = allLines[index - 1]
      return !(
        line.trim() === '' &&
        typeof previousLine === 'string' &&
        previousLine.trim() === ''
      )
    })

  if (normalizedLines.length === 0) {
    return
  }

  lines.push(
    '> [!info]- Mentioned vault files',
    ...normalizedLines.map((line) => (line.length > 0 ? `> ${line}` : '>')),
    '',
  )
}

function appendToolMessageToLines(
  message: SerializedChatToolMessage,
  lines: string[],
): void {
  for (const pair of message.toolCalls) {
    const { request, response } = pair
    const argsText =
      getToolCallArgumentsText(request.arguments) ?? '(no arguments)'
    const resultText = toolResponseToMarkdownSnippet(response)
    lines.push(
      `> [!example]- Tool: ${request.name}`,
      '> ',
      '> **Arguments:**',
      '> ```json',
      ...argsText.split('\n').map((line) => `> ${line}`),
      '> ```',
      '> ',
      '> **Result:**',
      '> ```',
      ...resultText.split('\n').map((line) => `> ${line}`),
      '> ```',
      '',
    )
  }
}

function appendCompactionSummaryToLines(
  summary: string,
  lines: string[],
): void {
  const trimmedSummary = summary.trim()
  if (!trimmedSummary) {
    return
  }

  lines.push('## Context summary', '', trimmedSummary, '', '---', '')
}

function appendAnchoredCompactionSummariesToLines(
  messageId: string,
  compactionByAnchorMessageId: Map<string, string[]>,
  lines: string[],
): void {
  const anchoredSummaries = compactionByAnchorMessageId.get(messageId)
  if (!anchoredSummaries) {
    return
  }

  anchoredSummaries.forEach((summary) => {
    appendCompactionSummaryToLines(summary, lines)
  })
}

/**
 * Converts a stored conversation into Markdown suitable for saving as a vault note.
 */
export function conversationToMarkdown(
  conversation: ChatConversation,
  options: ConversationToMarkdownOptions,
): string {
  const { snapshotEntries, exportedAtIso, filterBranches = true } = options

  const lines: string[] = []
  const title = conversation.title?.trim() || 'Chat'
  const id = conversation.id

  lines.push(
    '---',
    `title: ${yamlDoubleQuotedString(title)}`,
    'exported_from: YOLO',
    `exported_at: ${exportedAtIso}`,
    `conversation_id: ${id}`,
    '---',
  )

  let messageSequence = conversation.messages
  if (filterBranches) {
    const grouped = groupSerializedAssistantAndToolMessages(
      conversation.messages,
    )
    messageSequence = flattenSerializedForExport(
      grouped,
      conversation.activeBranchByUserMessageId,
    )
  }

  const compactionByAnchorMessageId = new Map<string, string[]>()
  normalizeChatConversationCompactionState(conversation.compaction).forEach(
    (entry) => {
      const summary = entry.summary.trim()
      if (!summary) {
        return
      }

      const existing = compactionByAnchorMessageId.get(entry.anchorMessageId)
      if (existing) {
        existing.push(summary)
      } else {
        compactionByAnchorMessageId.set(entry.anchorMessageId, [summary])
      }
    },
  )

  for (const message of messageSequence) {
    if (message.role === 'user') {
      const user = message
      const editorText = editorStateToPlainText(user.content)
      const promptText = resolveUserPromptPlainText(user, snapshotEntries)
      const body =
        promptText.trim().length > 0 ? promptText.trim() : editorText.trim()
      const { bodyWithoutMentionedSection, mentionedSection } =
        extractMentionedVaultFilesSection(body)

      lines.push('## User', '')
      if (mentionedSection) {
        appendMentionedVaultFilesCalloutToLines(mentionedSection, lines)
      }
      if (bodyWithoutMentionedSection) {
        lines.push(bodyWithoutMentionedSection, '')
      }
      if (user.mentionables?.length) {
        const refs = mentionablesToMarkdownLines(user.mentionables)
        if (refs.length) {
          lines.push('**Referenced:**', ...refs.map((r) => `- ${r}`), '')
        }
      }
      if (user.selectedSkills?.length) {
        lines.push(
          '**Skills:**',
          ...user.selectedSkills.map((s) => `- ${s.name} (\`${s.path}\`)`),
          '',
        )
      }
      appendAnchoredCompactionSummariesToLines(
        message.id,
        compactionByAnchorMessageId,
        lines,
      )
      continue
    }

    if (message.role === 'assistant') {
      appendAssistantMessageToLines(message, lines)
      appendAnchoredCompactionSummariesToLines(
        message.id,
        compactionByAnchorMessageId,
        lines,
      )
      continue
    }

    if (message.role === 'tool') {
      appendToolMessageToLines(message, lines)
    }
    appendAnchoredCompactionSummariesToLines(
      message.id,
      compactionByAnchorMessageId,
      lines,
    )
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

async function ensureDirectoryPathExists(
  app: App,
  path: string,
): Promise<void> {
  const segments = normalizePath(path)
    .split('/')
    .filter((segment) => segment.length > 0)

  let currentPath = ''
  for (const segment of segments) {
    currentPath = currentPath.length > 0 ? `${currentPath}/${segment}` : segment
    const existing = app.vault.getAbstractFileByPath(currentPath)
    if (!existing) {
      await app.vault.createFolder(currentPath)
      continue
    }
    if (!(existing instanceof TFolder)) {
      throw new Error(`Path exists and is not a folder: ${currentPath}`)
    }
  }
}

async function resolveUniqueMarkdownPath(
  app: App,
  folderPath: string,
  baseName: string,
): Promise<string> {
  const sanitizedBase = sanitizeExportFileBaseName(baseName)
  let candidate = normalizePath(`${folderPath}/${sanitizedBase}.md`)
  let index = 2
  while (app.vault.getAbstractFileByPath(candidate)) {
    candidate = normalizePath(`${folderPath}/${sanitizedBase} (${index}).md`)
    index += 1
  }
  return candidate
}

export type ExportChatConversationParams = {
  app: App
  chatManager: ChatManager
  conversationId: string
  settings?: YoloSettingsLike | null
}

export function getChatExportFolderPath(
  settings?: YoloSettingsLike | null,
): string {
  const baseDir = settings?.yolo?.baseDir?.trim() || 'YOLO'
  return normalizePath(`${baseDir.replace(/^\/+/, '')}/Exports`)
}

/**
 * Loads the conversation, resolves prompt snapshots, writes a Markdown file under the vault.
 */
export async function exportChatConversationToVault(
  params: ExportChatConversationParams,
): Promise<{ path: string }> {
  const { app, chatManager, conversationId, settings } = params
  const folderPath = getChatExportFolderPath(settings)

  const conversation = await chatManager.findById(conversationId)
  if (!conversation) {
    throw new Error('Conversation not found')
  }

  const snapshotEntries = await readPromptSnapshotEntries({
    app,
    conversationId,
    settings,
  })

  const markdown = conversationToMarkdown(conversation, {
    snapshotEntries,
    exportedAtIso: new Date().toISOString(),
  })

  await ensureDirectoryPathExists(app, folderPath)

  const baseName = buildExportFileBaseName(conversation.title, new Date())
  const filePath = await resolveUniqueMarkdownPath(app, folderPath, baseName)

  await app.vault.create(filePath, markdown)

  return { path: filePath }
}
