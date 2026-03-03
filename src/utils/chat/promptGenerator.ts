import type { App, TFile, TFolder } from 'obsidian'
import { htmlToMarkdown, requestUrl } from 'obsidian'

import { editorStateToPlainText } from '../../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import type { QueryProgressState } from '../../components/chat-view/QueryProgress'
import type { RAGEngine } from '../../core/rag/ragEngine'
import {
  getLiteSkillDocument,
  listLiteSkillEntries,
} from '../../core/skills/liteSkills'
import {
  isSkillEnabledForAssistant,
  resolveAssistantSkillPolicy,
} from '../../core/skills/skillPolicy'
import type { SelectEmbedding } from '../../database/schema'
import { readPromptSnapshotEntries } from '../../database/json/chat/promptSnapshotStore'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { ContentPart, RequestMessage } from '../../types/llm/request'
import type {
  MentionableBlock,
  MentionableFile,
  MentionableFolder,
  MentionableImage,
  MentionableUrl,
  MentionableVault,
} from '../../types/mentionable'
import type { ToolCallRequest } from '../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { getNestedFiles, readTFileContent } from '../obsidian'

import { YoutubeTranscript, isYoutubeUrl } from './youtube-transcript'

export type CurrentFileContextMode = 'full' | 'summary'

export class PromptGenerator {
  private getRagEngine: () => Promise<RAGEngine>
  private app: App
  private settings: SmartComposerSettings
  private MAX_CONTEXT_MESSAGES = 32

  constructor(
    getRagEngine: () => Promise<RAGEngine>,
    app: App,
    settings: SmartComposerSettings,
  ) {
    this.getRagEngine = getRagEngine
    this.app = app
    this.settings = settings
  }

  public async generateRequestMessages({
    messages,
    hasTools = false,
    maxContextOverride,
    model,
    conversationId,
    currentFileContextMode = 'full',
    currentFileOverride,
  }: {
    messages: ChatMessage[]
    hasTools?: boolean
    maxContextOverride?: number
    model: ChatModel
    conversationId: string
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

    const isBaseModel = Boolean(model.isBaseModel)
    const baseModelSpecialPrompt = (
      this.settings.chatOptions.baseModelSpecialPrompt ?? ''
    ).trim()
    const baseModelSpecialPromptMessage =
      isBaseModel && baseModelSpecialPrompt.length > 0
        ? [{ role: 'user' as const, content: baseModelSpecialPrompt }]
        : []

    const systemMessage = isBaseModel
      ? null
      : await this.getSystemMessage(shouldUseRAG, hasTools)

    const currentFile = currentFileOverride ?? null
    const currentFileMessage =
      currentFile && this.settings.chatOptions.includeCurrentFileContent
        ? await this.getCurrentFileMessage(currentFile, currentFileContextMode)
        : undefined

    const requestMessages: RequestMessage[] = [
      ...baseModelSpecialPromptMessage,
      ...(systemMessage ? [systemMessage] : []),
      ...(await this.getChatHistoryMessages({
        messages: compiledMessages,
        maxContextOverride: maxContext,
        snapshotEntries,
      })),
      ...(currentFileMessage ? [currentFileMessage] : []),
    ]

    return requestMessages
  }

  private async getChatHistoryMessages({
    messages,
    maxContextOverride,
    snapshotEntries,
  }: {
    messages: ChatMessage[]
    maxContextOverride?: number
    snapshotEntries: Record<string, string | ContentPart[]>
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
        requestMessages.push(...this.parseAssistantMessage({ message }))
        continue
      }

      requestMessages.push(...this.parseToolMessage({ message }))
    }

    const filteredRequestMessages: RequestMessage[] = []
    let pendingToolCallIds = new Set<string>()

    for (const msg of requestMessages) {
      if (msg.role === 'assistant') {
        const normalizedToolCalls = msg.tool_calls?.filter((toolCall) => {
          return (
            typeof toolCall.id === 'string' && toolCall.id.trim().length > 0
          )
        })

        pendingToolCallIds = new Set(
          (normalizedToolCalls ?? []).map((toolCall) => toolCall.id),
        )

        filteredRequestMessages.push({
          ...msg,
          tool_calls:
            normalizedToolCalls && normalizedToolCalls.length > 0
              ? normalizedToolCalls
              : undefined,
        })
        continue
      }

      if (msg.role === 'tool') {
        const callId = msg.tool_call.id
        if (!pendingToolCallIds.has(callId)) {
          continue
        }
        pendingToolCallIds.delete(callId)
        filteredRequestMessages.push(msg)
        continue
      }

      pendingToolCallIds = new Set()
      filteredRequestMessages.push(msg)
    }

    return filteredRequestMessages
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

    const query = message.content ? editorStateToPlainText(message.content) : ''
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
    const blockPrompt = blocks
      .map(({ file, content }) => {
        return `\`\`\`${file.path}\n${content}\n\`\`\`\n`
      })
      .join('')

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

    const textContent = `${ragPrompt}${blockPrompt}\n\n${query}\n\n`
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
    return message.mentionables.some(
      (mentionable) =>
        mentionable.type === 'file' ||
        mentionable.type === 'folder' ||
        mentionable.type === 'url' ||
        mentionable.type === 'current-file' ||
        mentionable.type === 'vault',
    )
  }

  private parseAssistantMessage({
    message,
  }: {
    message: ChatAssistantMessage
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
        tool_calls:
          message.toolCallRequests
            ?.map((toolCall) => this.normalizeToolCallRequest(toolCall))
            .filter((toolCall): toolCall is NonNullable<typeof toolCall> =>
              Boolean(toolCall),
            ) ?? undefined,
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

    if (!toolCall.arguments || toolCall.arguments.trim().length === 0) {
      return {
        ...toolCall,
        id: callId,
        name,
        arguments: '{}',
      }
    }

    try {
      const parsed = JSON.parse(toolCall.arguments)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          ...toolCall,
          id: callId,
          name,
          arguments: JSON.stringify(parsed),
        }
      }
    } catch {
      // fall through
    }

    return {
      ...toolCall,
      id: callId,
      name,
      arguments: '{}',
    }
  }

  private parseToolMessage({
    message,
  }: {
    message: ChatToolMessage
  }): RequestMessage[] {
    return message.toolCalls.flatMap((toolCall): RequestMessage[] => {
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
      if (!message.content) {
        return {
          promptContent: '',
          shouldUseRAG: false,
        }
      }
      const query = editorStateToPlainText(message.content)
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
        const nestedFiles = folders.flatMap((folder) =>
          getNestedFiles(folder, this.app.vault),
        )
        const allFiles = [...files, ...nestedFiles]
        const fileEntries = await Promise.all(
          allFiles.map(async (file) => {
            try {
              const content = await readTFileContent(file, this.app.vault)
              return { file, content }
            } catch (error) {
              console.warn(
                '[Smart Composer] Failed to read mentioned file',
                file.path,
                error,
              )
              return null
            }
          }),
        )
        const readableFileEntries = fileEntries.filter(
          (entry): entry is { file: TFile; content: string } => entry !== null,
        )
        const readableFiles = readableFileEntries.map((entry) => entry.file)
        const fileContents = readableFileEntries.map((entry) => entry.content)

        filePrompt = readableFiles
          .map((file, index) => {
            return `\`\`\`${file.path}\n${fileContents[index]}\n\`\`\`\n`
          })
          .join('')
      }

      const blocks = message.mentionables.filter(
        (m): m is MentionableBlock => m.type === 'block',
      )
      const blockPrompt = blocks
        .map(({ file, content }) => {
          return `\`\`\`${file.path}\n${content}\n\`\`\`\n`
        })
        .join('')

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
            text: `${filePrompt}${blockPrompt}${urlPrompt}\n\n${query}\n\n`,
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

  private async getSystemMessage(
    shouldUseRAG: boolean,
    hasTools = false,
  ): Promise<RequestMessage> {
    // When both RAG and tools are available, prioritize based on context
    const useRAGPrompt = shouldUseRAG && !hasTools

    // Build user custom instructions section (priority: placed first)
    const customInstructionsSection =
      await this.buildCustomInstructionsSection()

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

  private async buildCustomInstructionsSection(): Promise<string | null> {
    // Get custom system prompt
    const customInstruction = this.settings.systemPrompt.trim()

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
      parts.push(`<assistant_instructions name="${currentAssistant.name}">
${currentAssistant.systemPrompt}
</assistant_instructions>`)
    }

    const disabledSkillIds = this.settings.skills?.disabledSkillIds ?? []
    const enabledSkillEntries = currentAssistant
      ? listLiteSkillEntries(this.app).filter((skill) =>
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
- If available skills are listed, use yolo_local__open_skill to load the full skill only when it is relevant to the current task.`
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
- If available skills are listed, use yolo_local__open_skill to load the full skill only when it is relevant to the current task.`
    }

    return section
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

    const response = await requestUrl({ url })
    return htmlToMarkdown(response.text)
  }
}
