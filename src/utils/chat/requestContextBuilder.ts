import type { App, TFile, TFolder } from 'obsidian'
import { Notice, htmlToMarkdown, requestUrl } from 'obsidian'

import { editorStateToPlainText } from '../../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import type { QueryProgressState } from '../../components/chat-view/QueryProgress'
import {
  buildCompactionResumeMessage,
  buildCompactionSummaryMessage,
} from '../../core/agent/compaction'
import { getMemoryPromptContext } from '../../core/memory/memoryManager'
import type { RAGEngine } from '../../core/rag/ragEngine'
import {
  getLiteSkillDocument,
  listLiteSkillEntries,
} from '../../core/skills/liteSkills'
import {
  isSkillEnabledForAssistant,
  resolveAssistantSkillPolicy,
} from '../../core/skills/skillPolicy'
import { readPromptSnapshotEntries } from '../../database/json/chat/promptSnapshotStore'
import type { SelectEmbedding } from '../../database/schema'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type {
  ChatAssistantMessage,
  ChatConversationCompactionLike,
  ChatMessage,
  ChatSelectedSkill,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import { getLatestChatConversationCompaction } from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { ContentPart, RequestMessage } from '../../types/llm/request'
import type {
  MentionableAssistantQuote,
  MentionableBlock,
  MentionableFile,
  MentionableFolder,
  MentionableImage,
  MentionableUrl,
  MentionableVault,
} from '../../types/mentionable'
import type { ToolCallRequest } from '../../types/tool-call.types'
import {
  createCompleteToolCallArguments,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { getNestedFiles, readTFileContent } from '../obsidian'
import { resolvePromptVariables } from '../prompt/promptVariables'

import { getLatestValidCurrentFileMentionable } from './currentFileMentionable'
import {
  filterEmptyAssistantMessages,
  filterRequestMessagesByToolBoundary,
} from './tool-boundary'
import {
  collectContextPrunedToolCallIds,
  filterContextPrunedAssistantToolCalls,
  filterContextPrunedToolCalls,
} from './tool-context-pruning'
import { YoutubeTranscript, isYoutubeUrl } from './youtube-transcript'

export type CurrentFileContextMode = 'full' | 'summary'

type RequestContextBuilderOptions = {
  includeSkills?: boolean
}

type MarkdownAtxHeading = {
  level: number
  line: number
  text: string
}

type MentionedFileProperty = {
  key: string
  value: string
}

type MentionedFileContextEntry = {
  file: TFile
  source: 'file' | 'current-file' | 'folder'
}

const MAX_MENTIONED_FILE_OUTLINES = 10

type MentionContextMode = 'light' | 'full'

export function extractMarkdownAtxHeadings(
  content: string,
): MarkdownAtxHeading[] {
  const headings: MarkdownAtxHeading[] = []
  const lines = content.split('\n')
  let activeFenceMarker: '```' | '~~~' | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmedLine = line.trim()

    if (activeFenceMarker) {
      if (trimmedLine.startsWith(activeFenceMarker)) {
        activeFenceMarker = null
      }
      continue
    }

    if (trimmedLine.startsWith('```')) {
      activeFenceMarker = '```'
      continue
    }

    if (trimmedLine.startsWith('~~~')) {
      activeFenceMarker = '~~~'
      continue
    }

    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(trimmedLine)
    if (!match) {
      continue
    }

    const marker = match[1]
    const text = match[2]?.trim()
    if (!marker || !text) {
      continue
    }

    headings.push({
      level: marker.length,
      line: index + 1,
      text,
    })
  }

  return headings
}

function formatMentionedFilePropertyValue(value: unknown): string | null {
  if (value === null) {
    return 'null'
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value)
  }

  if (Array.isArray(value) || typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return null
    }
  }

  return null
}

function getMentionedFileProperties(
  frontmatter: Record<string, unknown> | null | undefined,
): MentionedFileProperty[] {
  if (!frontmatter) {
    return []
  }

  return Object.entries(frontmatter)
    .filter(([key]) => key !== 'position')
    .map(([key, value]) => {
      const formattedValue = formatMentionedFilePropertyValue(value)
      if (!formattedValue) {
        return null
      }

      return {
        key,
        value: formattedValue,
      }
    })
    .filter((property): property is MentionedFileProperty => property !== null)
}

export class RequestContextBuilder {
  private getRagEngine: () => Promise<RAGEngine>
  private app: App
  private settings: SmartComposerSettings
  private MAX_CONTEXT_MESSAGES = 32
  private includeSkills: boolean

  constructor(
    getRagEngine: () => Promise<RAGEngine>,
    app: App,
    settings: SmartComposerSettings,
    options?: RequestContextBuilderOptions,
  ) {
    this.getRagEngine = getRagEngine
    this.app = app
    this.settings = settings
    this.includeSkills = options?.includeSkills ?? true
  }

  public isModelRequestContextLoggingEnabled(): boolean {
    return this.settings.debug?.logModelRequestContext ?? false
  }

  private getMentionContextMode(): MentionContextMode {
    return this.settings.chatOptions?.mentionContextMode ?? 'light'
  }

  public async generateRequestMessages({
    messages,
    hasTools = false,
    hasMemoryTools = false,
    maxContextOverride,
    model: _model,
    conversationId,
    compaction,
    currentFileContextMode = 'full',
    currentFileOverride,
  }: {
    messages: ChatMessage[]
    hasTools?: boolean
    hasMemoryTools?: boolean
    maxContextOverride?: number
    model: ChatModel
    conversationId: string
    compaction?: ChatConversationCompactionLike | null
    currentFileContextMode?: CurrentFileContextMode
    currentFileOverride?: TFile | null
  }): Promise<RequestMessage[]> {
    if (messages.length === 0) {
      throw new Error('No messages provided')
    }

    const compiledMessages = [...messages]

    // Only compile the latest user message when needed.
    // Historical messages without promptContent should be replayed from
    // lightweight snapshots/fallbacks to avoid expensive full-history rebuilds.
    let lastUserMessageIndex = -1
    for (let i = compiledMessages.length - 1; i >= 0; --i) {
      if (compiledMessages[i].role === 'user') {
        lastUserMessageIndex = i
        break
      }
    }
    if (lastUserMessageIndex === -1) {
      throw new Error('No user messages found')
    }

    const lastUserMessage = compiledMessages[
      lastUserMessageIndex
    ] as ChatUserMessage
    if (!lastUserMessage.promptContent) {
      const { promptContent, similaritySearchResults } =
        await this.compileUserMessagePrompt({
          message: lastUserMessage,
        })
      compiledMessages[lastUserMessageIndex] = {
        ...lastUserMessage,
        promptContent,
        similaritySearchResults,
      }
    }

    const effectiveLastUserMessage = compiledMessages[
      lastUserMessageIndex
    ] as ChatUserMessage

    const snapshotEntries = await readPromptSnapshotEntries({
      app: this.app,
      conversationId,
      settings: this.settings,
    })

    const maxContext = Math.max(
      0,
      maxContextOverride ?? this.MAX_CONTEXT_MESSAGES,
    )
    const contextStartIndex = Math.max(0, compiledMessages.length - maxContext)

    for (let i = contextStartIndex; i < compiledMessages.length; i += 1) {
      if (i === lastUserMessageIndex) {
        continue
      }

      const message = compiledMessages[i]
      if (message?.role !== 'user' || message.promptContent) {
        continue
      }

      const snapshotHash = message.snapshotRef?.hash
      if (snapshotHash && snapshotEntries[snapshotHash]) {
        continue
      }

      if (!this.requiresSnapshotRebuild(message)) {
        continue
      }

      const { promptContent, similaritySearchResults } =
        await this.compileUserMessagePrompt({
          message,
        })
      compiledMessages[i] = {
        ...message,
        promptContent,
        snapshotRef: undefined,
        similaritySearchResults,
      }
    }

    const shouldUseRAG =
      effectiveLastUserMessage.similaritySearchResults !== undefined

    const systemMessage = await this.getSystemMessage(
      shouldUseRAG,
      hasTools,
      hasMemoryTools,
    )

    const currentFile = currentFileOverride ?? null
    const currentFileMessage =
      currentFile && this.settings.chatOptions.includeCurrentFileContent
        ? await this.getCurrentFileMessage(currentFile, currentFileContextMode)
        : undefined

    const requestMessages: RequestMessage[] = [
      ...(systemMessage ? [systemMessage] : []),
      ...(await this.getChatHistoryMessages({
        messages: compiledMessages,
        maxContextOverride: maxContext,
        snapshotEntries,
        compaction,
      })),
      ...(currentFileMessage ? [currentFileMessage] : []),
    ]

    return requestMessages
  }

  private async getChatHistoryMessages({
    messages,
    maxContextOverride,
    snapshotEntries,
    compaction,
  }: {
    messages: ChatMessage[]
    maxContextOverride?: number
    snapshotEntries: Record<string, string | ContentPart[]>
    compaction?: ChatConversationCompactionLike | null
  }): Promise<RequestMessage[]> {
    // Determine max context messages with priority:
    // 1) explicit override from conversation settings
    // 2) class default (32)
    const maxContext = Math.max(
      0,
      maxContextOverride ?? this.MAX_CONTEXT_MESSAGES,
    )

    // Get the last N messages and parse them into request messages
    const requestMessages: RequestMessage[] = []
    const contextMessages = messages.slice(-maxContext)
    const prunedToolCallIds = collectContextPrunedToolCallIds(messages)

    const latestCompaction = getLatestChatConversationCompaction(compaction)

    if (latestCompaction) {
      const anchorIndex = messages.findIndex(
        (message) => message.id === latestCompaction.anchorMessageId,
      )

      if (anchorIndex !== -1) {
        requestMessages.push(buildCompactionSummaryMessage(latestCompaction))
        const retainedStartIndex = latestCompaction.triggerToolCallId
          ? anchorIndex > 0 && messages[anchorIndex - 1]?.role === 'assistant'
            ? anchorIndex - 1
            : anchorIndex
          : anchorIndex + 1
        const compactContextStartIndex = Math.max(
          messages.length - contextMessages.length,
          retainedStartIndex,
        )
        const compactContextMessages = messages.slice(compactContextStartIndex)

        for (const message of compactContextMessages) {
          if (message.role === 'user') {
            requestMessages.push({
              role: 'user',
              content: await this.getUserMessageContent({
                message,
                snapshotEntries,
              }),
            })
            continue
          }

          if (message.role === 'assistant') {
            requestMessages.push(
              ...this.parseAssistantMessage({ message, prunedToolCallIds }),
            )
            continue
          }

          requestMessages.push(
            ...this.parseToolMessage({ message, prunedToolCallIds }),
          )
        }

        if (
          !compactContextMessages.some((message) => message.role === 'user')
        ) {
          requestMessages.push(buildCompactionResumeMessage())
        }

        return filterRequestMessagesByToolBoundary(
          filterEmptyAssistantMessages(requestMessages),
        )
      }
    }

    for (const message of contextMessages) {
      if (message.role === 'user') {
        requestMessages.push({
          role: 'user',
          content: await this.getUserMessageContent({
            message,
            snapshotEntries,
          }),
        })
        continue
      }

      if (message.role === 'assistant') {
        requestMessages.push(
          ...this.parseAssistantMessage({ message, prunedToolCallIds }),
        )
        continue
      }

      requestMessages.push(
        ...this.parseToolMessage({ message, prunedToolCallIds }),
      )
    }

    return filterRequestMessagesByToolBoundary(
      filterEmptyAssistantMessages(requestMessages),
    )
  }

  private async getUserMessageContent({
    message,
    snapshotEntries,
  }: {
    message: ChatUserMessage
    snapshotEntries: Record<string, string | ContentPart[]>
  }): Promise<string | ContentPart[]> {
    if (message.promptContent) {
      return message.promptContent
    }

    if (message.snapshotRef?.hash) {
      const snapshotContent = snapshotEntries[message.snapshotRef.hash]
      if (snapshotContent) {
        return snapshotContent
      }
    }

    const query = message.content
      ? editorStateToPlainText(message.content, {
          ignoreMentionableTypes: ['model'],
        })
      : ''
    const imageParts = message.mentionables
      .filter((m): m is MentionableImage => m.type === 'image')
      .map(
        (mentionable): ContentPart => ({
          type: 'image_url',
          image_url: {
            url: mentionable.data,
          },
        }),
      )

    const blocks = message.mentionables.filter(
      (m): m is MentionableBlock => m.type === 'block',
    )
    const assistantQuotes = message.mentionables.filter(
      (m): m is MentionableAssistantQuote => m.type === 'assistant-quote',
    )
    const blockPrompt = blocks
      .map(({ file, content }) => {
        return `\`\`\`${file.path}\n${content}\n\`\`\`\n`
      })
      .join('')
    const assistantQuotePrompt = this.buildAssistantQuotePrompt(assistantQuotes)

    const ragPrompt = message.similaritySearchResults
      ? `## Potentially Relevant Snippets from the current vault
${message.similaritySearchResults
  .map(({ path, content, metadata }) => {
    const numberedContent = this.addLineNumbersToContent({
      content,
      startLine: metadata.startLine,
    })
    return `\`\`\`${path}\n${numberedContent}\n\`\`\`\n`
  })
  .join('')}\n`
      : ''

    const selectedSkillsPrompt = await this.buildSelectedSkillsPrompt(
      message.selectedSkills,
    )
    const textContent = `${ragPrompt}${blockPrompt}${assistantQuotePrompt}${selectedSkillsPrompt}\n\n${query}\n\n`
    if (imageParts.length === 0) {
      return textContent
    }

    return [
      ...imageParts,
      {
        type: 'text',
        text: textContent,
      },
    ]
  }

  private requiresSnapshotRebuild(message: ChatUserMessage): boolean {
    return (
      (message.selectedSkills?.length ?? 0) > 0 ||
      message.mentionables.some(
        (mentionable) =>
          mentionable.type === 'file' ||
          mentionable.type === 'folder' ||
          mentionable.type === 'url' ||
          mentionable.type === 'assistant-quote' ||
          mentionable.type === 'current-file' ||
          mentionable.type === 'vault',
      )
    )
  }

  private async buildSelectedSkillsPrompt(
    selectedSkills?: ChatSelectedSkill[],
  ): Promise<string> {
    if (!selectedSkills || selectedSkills.length === 0) {
      return ''
    }

    const loadedSkills = await Promise.all(
      selectedSkills.map(async (skill) => {
        const document = await getLiteSkillDocument({
          app: this.app,
          id: skill.id,
          name: skill.name,
          settings: this.settings,
        })

        if (document) {
          return document
        }

        return {
          entry: skill,
          content: '',
        }
      }),
    )

    const validSkills = loadedSkills.filter(
      (skill) => skill.content.trim().length > 0,
    )
    if (validSkills.length === 0) {
      return ''
    }

    return `<user_selected_skills>\n${validSkills
      .map(
        (skill) =>
          `<skill id="${skill.entry.id}" name="${skill.entry.name}" path="${skill.entry.path}">\n${skill.content}\n</skill>`,
      )
      .join('\n\n')}\n</user_selected_skills>\n`
  }

  private parseAssistantMessage({
    message,
    prunedToolCallIds,
  }: {
    message: ChatAssistantMessage
    prunedToolCallIds?: ReadonlySet<string>
  }): RequestMessage[] {
    let citationContent: string | null = null
    if (message.annotations && message.annotations.length > 0) {
      citationContent = `Citations:
${message.annotations
  .filter((annotation) => annotation.type === 'url_citation')
  .map((annotation, index) => {
    const { url, title } = annotation.url_citation
    return `[${index + 1}] ${title ? `${title}: ` : ''}${url}`
  })
  .join('\n')}`
    }

    return [
      {
        role: 'assistant',
        content: [
          message.content,
          ...(citationContent ? [citationContent] : []),
        ].join('\n'),
        reasoning: message.reasoning,
        providerMetadata: message.metadata?.providerMetadata,
        tool_calls: filterContextPrunedAssistantToolCalls(
          message.toolCallRequests
            ?.map((toolCall) => this.normalizeToolCallRequest(toolCall))
            .filter((toolCall): toolCall is NonNullable<typeof toolCall> =>
              Boolean(toolCall),
            ) ?? undefined,
          prunedToolCallIds ?? new Set<string>(),
        ),
      },
    ]
  }

  private normalizeToolCallRequest(
    toolCall: ToolCallRequest,
  ): ToolCallRequest | null {
    const callId =
      typeof toolCall.id === 'string' ? toolCall.id.trim() : toolCall.id
    const name =
      typeof toolCall.name === 'string' ? toolCall.name.trim() : toolCall.name
    if (!callId || !name) {
      return null
    }

    const args = getToolCallArgumentsObject(toolCall.arguments)
    if (!args) {
      return {
        ...toolCall,
        id: callId,
        name,
        arguments: createCompleteToolCallArguments({ value: {} }),
      }
    }

    return {
      ...toolCall,
      id: callId,
      name,
      arguments: createCompleteToolCallArguments({ value: args }),
    }
  }

  private parseToolMessage({
    message,
    prunedToolCallIds,
  }: {
    message: ChatToolMessage
    prunedToolCallIds?: ReadonlySet<string>
  }): RequestMessage[] {
    return filterContextPrunedToolCalls(
      message.toolCalls,
      prunedToolCallIds ?? new Set<string>(),
    ).flatMap((toolCall): RequestMessage[] => {
      switch (toolCall.response.status) {
        case ToolCallResponseStatus.PendingApproval:
        case ToolCallResponseStatus.Running:
          // Skip incomplete tool calls to avoid confusing the next planning step.
          return []
        case ToolCallResponseStatus.Aborted:
          return [
            {
              role: 'tool',
              tool_call: toolCall.request,
              content: `Tool call ${toolCall.request.id} is aborted`,
            },
          ]
        case ToolCallResponseStatus.Rejected:
          return [
            {
              role: 'tool',
              tool_call: toolCall.request,
              content: `Tool call ${toolCall.request.id} is rejected`,
            },
          ]
        case ToolCallResponseStatus.Success:
          return [
            {
              role: 'tool',
              tool_call: toolCall.request,
              content: toolCall.response.data.text,
            },
          ]
        case ToolCallResponseStatus.Error:
          return [
            {
              role: 'tool',
              tool_call: toolCall.request,
              content: `Error: ${toolCall.response.error}`,
            },
          ]
        default:
          return []
      }
    })
  }

  public async compileUserMessagePrompt({
    message,
    useVaultSearch,
    onQueryProgressChange,
  }: {
    message: ChatUserMessage
    useVaultSearch?: boolean
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void
  }): Promise<{
    promptContent: ChatUserMessage['promptContent']
    shouldUseRAG: boolean
    similaritySearchResults?: (Omit<SelectEmbedding, 'embedding'> & {
      similarity: number
    })[]
  }> {
    try {
      if (
        !message.content &&
        message.mentionables.length === 0 &&
        (message.selectedSkills?.length ?? 0) === 0
      ) {
        return {
          promptContent: '',
          shouldUseRAG: false,
        }
      }
      const query = message.content
        ? editorStateToPlainText(message.content, {
            ignoreMentionableTypes: ['model'],
          })
        : ''
      let similaritySearchResults:
        | (Omit<SelectEmbedding, 'embedding'> & {
            similarity: number
          })[]
        | undefined

      const mentionablesRequireVaultSearch = message.mentionables.some(
        (m): m is MentionableVault => m.type === 'vault',
      )
      const shouldSearchEntireVault =
        Boolean(useVaultSearch) || mentionablesRequireVaultSearch

      onQueryProgressChange?.({
        type: 'reading-mentionables',
      })
      const shouldUseRAG = shouldSearchEntireVault

      let filePrompt: string
      if (shouldUseRAG) {
        similaritySearchResults = await (
          await this.getRagEngine()
        ).processQuery({
          query,
          onQueryProgressChange: onQueryProgressChange,
        }) // TODO: Add similarity boosting for mentioned files or folders
        filePrompt = `## Potentially Relevant Snippets from the current vault
${similaritySearchResults
  .map(({ path, content, metadata }) => {
    const newContent = this.addLineNumbersToContent({
      content,
      startLine: metadata.startLine,
    })
    return `\`\`\`${path}\n${newContent}\n\`\`\`\n`
  })
  .join('')}\n`
      } else {
        const files = message.mentionables
          .filter((m): m is MentionableFile => m.type === 'file')
          .map((m) => this.app.vault.getFileByPath(m.file.path))
          .filter((file): file is TFile => Boolean(file))
        const folders = message.mentionables
          .filter((m): m is MentionableFolder => m.type === 'folder')
          .map((m) => this.app.vault.getFolderByPath(m.folder.path))
          .filter((folder): folder is TFolder => Boolean(folder))
        const latestCurrentFile = getLatestValidCurrentFileMentionable(
          message.mentionables,
        )
        const currentFiles = latestCurrentFile ? [latestCurrentFile] : []

        filePrompt = await this.buildMentionedFilePrompt({
          files,
          folders,
          currentFiles,
        })
      }

      const blocks = message.mentionables.filter(
        (m): m is MentionableBlock => m.type === 'block',
      )
      const assistantQuotes = message.mentionables.filter(
        (m): m is MentionableAssistantQuote => m.type === 'assistant-quote',
      )
      const blockPrompt = blocks
        .map(({ file, content }) => {
          return `\`\`\`${file.path}\n${content}\n\`\`\`\n`
        })
        .join('')
      const assistantQuotePrompt =
        this.buildAssistantQuotePrompt(assistantQuotes)

      const urls = message.mentionables.filter(
        (m): m is MentionableUrl => m.type === 'url',
      )

      const urlPrompt =
        urls.length > 0
          ? `## Potentially Relevant Websearch Results
${(
  await Promise.all(
    urls.map(
      async ({ url }) => `\`\`\`
Website URL: ${url}
Website Content:
${await this.getWebsiteContent(url)}
\`\`\``,
    ),
  )
).join('\n')}
`
          : ''

      const imageDataUrls = message.mentionables
        .filter((m): m is MentionableImage => m.type === 'image')
        .map(({ data }) => data)
      const selectedSkillsPrompt = await this.buildSelectedSkillsPrompt(
        message.selectedSkills,
      )

      // Reset query progress
      onQueryProgressChange?.({
        type: 'idle',
      })

      return {
        promptContent: [
          ...imageDataUrls.map(
            (data): ContentPart => ({
              type: 'image_url',
              image_url: {
                url: data,
              },
            }),
          ),
          {
            type: 'text',
            text: `${filePrompt}${blockPrompt}${assistantQuotePrompt}${urlPrompt}${selectedSkillsPrompt}\n\n${query}\n\n`,
          },
        ],
        shouldUseRAG,
        similaritySearchResults: similaritySearchResults,
      }
    } catch (error) {
      console.error('Failed to compile user message', error)
      onQueryProgressChange?.({
        type: 'idle',
      })
      throw error
    }
  }

  private buildAssistantQuotePrompt(
    quotes: MentionableAssistantQuote[],
  ): string {
    if (quotes.length === 0) {
      return ''
    }

    return `## Referenced assistant reply snippets
${quotes
  .map(
    ({ conversationId, messageId, content }) =>
      `<assistant_quote conversationId="${conversationId}" messageId="${messageId}">\n${content}\n</assistant_quote>`,
  )
  .join('\n\n')}\n\n`
  }

  private async getSystemMessage(
    shouldUseRAG: boolean,
    hasTools = false,
    hasMemoryTools = false,
  ): Promise<RequestMessage> {
    // When both RAG and tools are available, prioritize based on context
    const useRAGPrompt = shouldUseRAG && !hasTools

    // Build user custom instructions section (priority: placed first)
    const customInstructionsSection =
      await this.buildCustomInstructionsSection(hasMemoryTools)

    // Build base behavior section
    const baseBehaviorSection = useRAGPrompt
      ? this.buildRAGBehaviorSection(hasTools)
      : this.buildDefaultBehaviorSection(hasTools)

    // Combine all sections: user instructions first, then base behavior
    const sections = [customInstructionsSection, baseBehaviorSection].filter(
      Boolean,
    )

    return {
      role: 'system',
      content: sections.join('\n\n'),
    }
  }

  private async buildCustomInstructionsSection(
    hasMemoryTools: boolean,
  ): Promise<string | null> {
    // Get custom system prompt
    const customInstruction = resolvePromptVariables(
      this.settings.systemPrompt,
    ).trim()

    // Get currently selected assistant
    const currentAssistantId = this.settings.currentAssistantId
    const assistants = this.settings.assistants || []
    // Only use assistant if explicitly selected (currentAssistantId is not undefined)
    const currentAssistant = currentAssistantId
      ? assistants.find((a) => a.id === currentAssistantId)
      : null

    // Build prompt content
    const parts: string[] = []

    // Add assistant's system prompt (if available) - this is the primary instruction
    if (currentAssistant?.systemPrompt) {
      const resolvedAssistantSystemPrompt = resolvePromptVariables(
        currentAssistant.systemPrompt,
      ).trim()
      if (resolvedAssistantSystemPrompt) {
        parts.push(`<assistant_instructions name="${currentAssistant.name}">
${resolvedAssistantSystemPrompt}
</assistant_instructions>`)
      }
    }

    const memoryContext = await getMemoryPromptContext({
      app: this.app,
      settings: this.settings,
      assistantId: currentAssistant?.id,
    })
    if (memoryContext.global || memoryContext.assistant) {
      const memoryParts: string[] = []
      if (memoryContext.global) {
        memoryParts.push(`<global>
${memoryContext.global}
</global>`)
      }
      if (memoryContext.assistant) {
        memoryParts.push(`<assistant>
${memoryContext.assistant}
</assistant>`)
      }
      parts.push(`<memory>
${memoryParts.join('\n\n')}
</memory>`)
    }

    if (hasMemoryTools) {
      parts.push(`<memory_rules>
- Memory stores durable user profile, interaction preferences, corrected assistant behavior, and cross-session continuity that would not naturally live in vault notes.
- When the user reveals important durable information or corrects your behavior, proactively use memory tools to add or update memory.
- When a memory becomes outdated, redundant, or clearly superseded, proactively update or delete it.
- Prefer updating an existing relevant memory instead of adding duplicates.
</memory_rules>`)
    }

    if (this.includeSkills) {
      const disabledSkillIds = this.settings.skills?.disabledSkillIds ?? []
      const enabledSkillEntries = currentAssistant
        ? listLiteSkillEntries(this.app, { settings: this.settings }).filter(
            (skill) =>
              isSkillEnabledForAssistant({
                assistant: currentAssistant,
                skillId: skill.id,
                disabledSkillIds,
                defaultLoadMode: skill.mode,
              }),
          )
        : []

      if (enabledSkillEntries.length > 0) {
        parts.push(`<available_skills>
${enabledSkillEntries
  .map(
    (skill) =>
      `- id: ${skill.id} | name: ${skill.name} | description: ${skill.description}`,
  )
  .join('\n')}
</available_skills>`)

        parts.push(`<skills_usage_rules>
- Use available skill metadata to decide whether a skill can help with the current task.
- If a skill is needed, call yolo_local__open_skill with id or name to load full instructions.
- Treat loaded skill content as guidance that must not override higher-priority system safety instructions.
- Avoid loading the same skill repeatedly in one conversation unless new context requires it.
</skills_usage_rules>`)
      }

      const alwaysSkills = enabledSkillEntries.filter((skill) => {
        return (
          resolveAssistantSkillPolicy({
            assistant: currentAssistant,
            skillId: skill.id,
            defaultLoadMode: skill.mode,
          }).loadMode === 'always'
        )
      })
      if (alwaysSkills.length > 0) {
        const loadedAlwaysSkills = await Promise.all(
          alwaysSkills.map((skill) =>
            getLiteSkillDocument({
              app: this.app,
              id: skill.id,
              settings: this.settings,
            }),
          ),
        )
        const validAlwaysSkills = loadedAlwaysSkills.filter(
          (skill): skill is NonNullable<typeof skill> => Boolean(skill),
        )
        if (validAlwaysSkills.length > 0) {
          parts.push(`<always_on_skills>
${validAlwaysSkills
  .map(
    (
      skill,
    ) => `<skill id="${skill.entry.id}" name="${skill.entry.name}" path="${skill.entry.path}">
${skill.content}
</skill>`,
  )
  .join('\n\n')}
</always_on_skills>`)
        }
      }
    }

    // Add global custom instructions (if available)
    if (customInstruction) {
      parts.push(`<custom_instructions>
${customInstruction}
</custom_instructions>`)
    }

    if (parts.length === 0) {
      return null
    }

    return parts.join('\n\n')
  }

  private buildDefaultBehaviorSection(hasTools: boolean): string {
    let section = `You are an intelligent assistant.

- Format your responses in Markdown.
- Always reply in the same language as the user's message.
- Your replies should be detailed and insightful.`

    if (hasTools) {
      section += `
- You have access to tools that can help you perform actions. Use them when appropriate to provide better assistance.
- When using tools, focus on providing clear results to the user. Only briefly mention tool usage if it helps understanding.
- Prefer using content already provided in the current message. Only call file tools when the current message is insufficient, you need another file, or you need to verify the latest contents. Avoid repeatedly reading the same window.
- If available skills are listed, use yolo_local__open_skill to load the full skill only when it is relevant to the current task.
- If the current user message already includes <user_selected_skills>, treat them as user-selected context and avoid reloading the same skill again unless you need to verify something.`
    }

    return section
  }

  private buildRAGBehaviorSection(hasTools: boolean): string {
    let section = `You are an intelligent assistant that answers the user's questions using their vault content whenever it is available.

- Do not fabricate facts—if the provided context is insufficient, say so.
- Format your responses in Markdown.
- Always reply in the same language as the user's message.
- Your replies should be detailed and insightful.`

    if (hasTools) {
      section += `
- You can use tools, but consult the provided markdown first. Only call tools when the vault content cannot answer the question.
- When using tools, briefly state why they are needed and focus on summarizing the results for the user.
- Prefer using content already provided in the current message. Only call file tools when the current message is insufficient, you need another file, or you need to verify the latest contents. Avoid repeatedly reading the same window.
- If available skills are listed, use yolo_local__open_skill to load the full skill only when it is relevant to the current task.
- If the current user message already includes <user_selected_skills>, treat them as user-selected context and avoid reloading the same skill again unless you need to verify something.`
    }

    return section
  }

  private async buildMentionedPathsPrompt({
    files,
    folders,
    currentFiles,
  }: {
    files: TFile[]
    folders: TFolder[]
    currentFiles: TFile[]
  }): Promise<string> {
    const folderPathSet = new Set(folders.map((folder) => folder.path))
    const unifiedFiles = this.collectMentionedFiles({
      files,
      folders,
      currentFiles,
    })

    if (unifiedFiles.length === 0 && folderPathSet.size === 0) {
      return ''
    }

    const outlinedFilePaths = new Set(
      unifiedFiles
        .filter(({ file }) => file.extension === 'md')
        .slice(0, MAX_MENTIONED_FILE_OUTLINES)
        .map(({ file }) => file.path),
    )
    const fileLines = await Promise.all(
      unifiedFiles.map(async ({ file }) => {
        const frontmatter =
          file.extension === 'md'
            ? this.app.metadataCache.getFileCache(file)?.frontmatter
            : null
        const properties = getMentionedFileProperties(frontmatter)
        const propertyLines =
          properties.length > 0
            ? [
                '  - Properties:',
                ...properties.map(
                  ({ key, value }) => `    - \`${key}\`: \`${value}\``,
                ),
              ]
            : []

        if (!outlinedFilePaths.has(file.path)) {
          return [`- \`${file.path}\``, ...propertyLines].join('\n')
        }

        try {
          const content = await readTFileContent(file, this.app.vault)
          const headings = extractMarkdownAtxHeadings(content)
          if (headings.length === 0) {
            return [`- \`${file.path}\``, ...propertyLines].join('\n')
          }

          return [
            `- \`${file.path}\``,
            ...propertyLines,
            ...headings.map(
              (heading) =>
                `  - L${heading.line} ${'#'.repeat(heading.level)} ${heading.text}`,
            ),
          ].join('\n')
        } catch (error) {
          console.warn(
            '[YOLO] Failed to read mentioned file outline',
            file.path,
            error,
          )
          return [`- \`${file.path}\``, ...propertyLines].join('\n')
        }
      }),
    )

    const markdownFileCount = unifiedFiles.filter(
      ({ file }) => file.extension === 'md',
    ).length
    const omittedOutlineCount = Math.max(
      0,
      markdownFileCount - outlinedFilePaths.size,
    )

    const sections = [
      `## Mentioned Vault Files (outline only)
${fileLines.join('\n')}`,
    ]

    if (folderPathSet.size > 0) {
      sections.push(`## Mentioned Vault Folders
${[...folderPathSet].map((path) => `- \`${path}\``).join('\n')}`)
    }

    if (omittedOutlineCount > 0) {
      sections.push(
        `Additional mentioned markdown files omitted from outline due to limit: ${omittedOutlineCount}`,
      )
    }

    sections.push(
      'This section provides only paths and outlines. Use file tools only if you need the full contents or a specific line range.',
    )

    return `${sections.join('\n\n')}\n`
  }

  private async buildMentionedFilePrompt({
    files,
    folders,
    currentFiles,
  }: {
    files: TFile[]
    folders: TFolder[]
    currentFiles: TFile[]
  }): Promise<string> {
    const mentionContextMode = this.getMentionContextMode()

    if (mentionContextMode === 'light') {
      return this.buildMentionedPathsPrompt({
        files,
        folders,
        currentFiles,
      })
    }

    const folderPrompt = await this.buildMentionedPathsPrompt({
      files: [],
      folders,
      currentFiles: [],
    })
    const fullFilePrompt = await this.buildFullMentionedFilesPrompt({
      files,
      currentFiles,
    })

    return `${folderPrompt}${fullFilePrompt}`
  }

  private async buildFullMentionedFilesPrompt({
    files,
    currentFiles,
  }: {
    files: TFile[]
    currentFiles: TFile[]
  }): Promise<string> {
    const uniqueFiles = this.collectMentionedFiles({
      files,
      folders: [],
      currentFiles,
    }).map(({ file }) => file)

    if (uniqueFiles.length === 0) {
      return ''
    }

    const fileEntries = await Promise.all(
      uniqueFiles.map(async (file) => {
        try {
          const content = await readTFileContent(file, this.app.vault)
          return { file, content }
        } catch (error) {
          console.warn('[YOLO] Failed to read mentioned file', file.path, error)
          return null
        }
      }),
    )
    const readableFileEntries = fileEntries.filter(
      (entry): entry is { file: TFile; content: string } => entry !== null,
    )

    return readableFileEntries
      .map(({ file, content }, index) => {
        const numberedContent = this.addLineNumbersToContent({
          content,
          startLine: 1,
        })
        const prefix =
          index === 0
            ? '## Mentioned Vault Files (full content already provided below)\nUse this provided content first. Only call file tools if you need another file or want to verify the latest contents.\n\n'
            : ''
        return `${prefix}\`\`\`${file.path}\n${numberedContent}\n\`\`\`\n`
      })
      .join('')
  }

  private collectMentionedFiles({
    files,
    folders,
    currentFiles,
  }: {
    files: TFile[]
    folders: TFolder[]
    currentFiles: TFile[]
  }): MentionedFileContextEntry[] {
    const collected: MentionedFileContextEntry[] = []
    const seenPaths = new Set<string>()

    const pushFile = (
      file: TFile,
      source: MentionedFileContextEntry['source'],
    ): void => {
      if (!file.path || seenPaths.has(file.path)) {
        return
      }
      seenPaths.add(file.path)
      collected.push({ file, source })
    }

    for (const file of files) {
      pushFile(file, 'file')
    }

    for (const file of currentFiles) {
      pushFile(file, 'current-file')
    }

    for (const folder of folders) {
      for (const file of getNestedFiles(folder, this.app.vault)) {
        pushFile(file, 'folder')
      }
    }

    return collected
  }

  private async getCurrentFileMessage(
    currentFile: TFile,
    currentFileContextMode: CurrentFileContextMode,
  ): Promise<RequestMessage> {
    if (currentFileContextMode === 'summary') {
      return this.getCurrentFileSummaryMessage(currentFile)
    }
    const fileContent = await readTFileContent(currentFile, this.app.vault)
    return {
      role: 'user',
      content: `# Inputs
## Current File
Here is the file I'm looking at.
\`\`\`${currentFile.path}
${fileContent}
\`\`\`\n\n`,
    }
  }

  private async getCurrentFileSummaryMessage(
    currentFile: TFile,
  ): Promise<RequestMessage> {
    return {
      role: 'user',
      content: `# Inputs
## Current File (summary)
Path: ${currentFile.path}
Title: ${currentFile.name}
\n\n`,
    }
  }

  private addLineNumbersToContent({
    content,
    startLine,
  }: {
    content: string
    startLine: number
  }): string {
    const lines = content.split('\n')
    const linesWithNumbers = lines.map((line, index) => {
      return `${startLine + index}|${line}`
    })
    return linesWithNumbers.join('\n')
  }

  /**
   * TODO: Improve markdown conversion logic
   * - filter visually hidden elements
   * ...
   */
  private async getWebsiteContent(url: string): Promise<string> {
    if (isYoutubeUrl(url)) {
      try {
        // TODO: pass language based on user preferences
        const { title, transcript } =
          await YoutubeTranscript.fetchTranscriptAndMetadata(url)

        return `Title: ${title}
Video Transcript:
${transcript.map((t) => `${t.offset}: ${t.text}`).join('\n')}`
      } catch (error) {
        console.error('Error fetching YouTube transcript', error)
      }
    }

    try {
      const response = await requestUrl({ url })
      return htmlToMarkdown(response.text)
    } catch (error) {
      const status =
        error instanceof Error ? error.message : String(error)
      console.warn(`Failed to fetch URL: ${url}`, error)
      new Notice(`URL fetch failed (${status}): ${url}`, 6000)
      return `[Failed to fetch content from this URL: ${status}]`
    }
  }
}
