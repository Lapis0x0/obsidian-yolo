import { App, TFile, htmlToMarkdown, requestUrl } from 'obsidian'

import { editorStateToPlainText } from '../../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import { QueryProgressState } from '../../components/chat-view/QueryProgress'
import { RAGEngine } from '../../core/rag/ragEngine'
import { SelectEmbedding } from '../../database/schema'
import { SmartComposerSettings } from '../../settings/schema/setting.types'
import {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { ContentPart, RequestMessage } from '../../types/llm/request'
import {
  MentionableBlock,
  MentionableFile,
  MentionableFolder,
  MentionableImage,
  MentionableUrl,
  MentionableVault,
} from '../../types/mentionable'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { tokenCount } from '../llm/token'
import {
  getNestedFiles,
  readMultipleTFiles,
  readTFileContent,
} from '../obsidian'

import { YoutubeTranscript, isYoutubeUrl } from './youtube-transcript'

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
  }: {
    messages: ChatMessage[]
    hasTools?: boolean
    maxContextOverride?: number
    model: ChatModel
  }): Promise<RequestMessage[]> {
    if (messages.length === 0) {
      throw new Error('No messages provided')
    }

    // Ensure all user messages have prompt content
    // Compile if: no promptContent OR has mentionables that need to be processed
    const compiledMessages = await Promise.all(
      messages.map(async (message) => {
        if (
          message.role === 'user' &&
          (!message.promptContent || message.mentionables.length > 0)
        ) {
          const { promptContent, similaritySearchResults } =
            await this.compileUserMessagePrompt({
              message,
            })
          return {
            ...message,
            promptContent,
            similaritySearchResults,
          }
        }
        return message
      }),
    )

    // find last user message
    let lastUserMessage: ChatUserMessage | undefined = undefined
    for (let i = compiledMessages.length - 1; i >= 0; --i) {
      if (compiledMessages[i].role === 'user') {
        lastUserMessage = compiledMessages[i] as ChatUserMessage
        break
      }
    }
    if (!lastUserMessage) {
      throw new Error('No user messages found')
    }
    const shouldUseRAG = lastUserMessage.similaritySearchResults !== undefined

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
      : this.getSystemMessage(shouldUseRAG, hasTools)

    const currentFile = lastUserMessage.mentionables.find(
      (m) => m.type === 'current-file',
    )?.file
    const currentFileMessage =
      currentFile && this.settings.chatOptions.includeCurrentFileContent
        ? await this.getCurrentFileMessage(currentFile)
        : undefined

    const requestMessages: RequestMessage[] = [
      ...baseModelSpecialPromptMessage,
      ...(systemMessage ? [systemMessage] : []),
      ...(currentFileMessage ? [currentFileMessage] : []),
      ...this.getChatHistoryMessages({
        messages: compiledMessages,
        maxContextOverride,
      }),
      ...(shouldUseRAG && !isBaseModel
        ? [this.getRagInstructionMessage()]
        : []),
    ]

    return requestMessages
  }

  private getChatHistoryMessages({
    messages,
    maxContextOverride,
  }: {
    messages: ChatMessage[]
    maxContextOverride?: number
  }): RequestMessage[] {
    // Determine max context messages with priority:
    // 1) explicit override from conversation settings
    // 2) global settings.chatOptions.maxContextMessages
    // 3) class default (32)
    const maxContext = Math.max(
      0,
      maxContextOverride ??
        this.settings?.chatOptions?.maxContextMessages ??
        this.MAX_CONTEXT_MESSAGES,
    )

    // Get the last N messages and parse them into request messages
    const requestMessages: RequestMessage[] = messages
      .slice(-maxContext)
      .flatMap((message): RequestMessage[] => {
        if (message.role === 'user') {
          // We assume that all user messages have been compiled
          return [
            {
              role: 'user',
              content: message.promptContent ?? '',
            },
          ]
        } else if (message.role === 'assistant') {
          return this.parseAssistantMessage({ message })
        } else {
          // message.role === 'tool'
          const toolMessages = this.parseToolMessage({ message })
          console.debug(
            '[DEBUG] After parseToolMessage - generated tool messages:',
            {
              inputChatToolMessageId: message.id,
              inputToolCallsCount: message.toolCalls.length,
              outputToolMessagesCount: toolMessages.length,
              toolCallIds: (
                toolMessages.filter(
                  (tm) => (tm as any).role === 'tool',
                ) as any[]
              ).map((tm) => tm.tool_call.id),
            },
          )
          return toolMessages
        }
      })

    console.debug('[DEBUG] Total requestMessages after flatMap:', {
      totalCount: requestMessages.length,
      toolMessagesCount: requestMessages.filter((m) => m.role === 'tool')
        .length,
      messageRoles: requestMessages.map((m) => m.role),
    })

    // TODO: Also verify that tool messages appear right after their corresponding assistant tool calls
    const filteredRequestMessages: RequestMessage[] = requestMessages
      .map((msg) => {
        switch (msg.role) {
          case 'user':
            return msg
          case 'assistant': {
            // Filter out tool calls that don't have a corresponding tool message
            const filteredToolCalls = msg.tool_calls?.filter((t) =>
              requestMessages.some(
                (rm) => rm.role === 'tool' && rm.tool_call.id === t.id,
              ),
            )
            return {
              ...msg,
              tool_calls:
                filteredToolCalls && filteredToolCalls.length > 0
                  ? filteredToolCalls
                  : undefined,
            }
          }
          case 'tool': {
            // Filter out tool messages that don't have a corresponding assistant message
            const assistantMessage = requestMessages.find(
              (rm) =>
                rm.role === 'assistant' &&
                rm.tool_calls?.some((t) => t.id === msg.tool_call.id),
            )
            if (!assistantMessage) {
              return null
            } else {
              return msg
            }
          }
          default:
            return msg
        }
      })
      .filter((m) => m !== null)

    console.debug('[DEBUG] After filtering requestMessages:', {
      totalCount: filteredRequestMessages.length,
      toolMessagesCount: filteredRequestMessages.filter(
        (m) => m.role === 'tool',
      ).length,
      toolCallIds: filteredRequestMessages
        .filter((m) => m.role === 'tool')
        .map((m) => (m.role === 'tool' ? m.tool_call.id : null)),
    })

    return filteredRequestMessages
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
  .map((annotation, index) => {
    if (annotation.type === 'url_citation') {
      const { url, title } = annotation.url_citation
      return `[${index + 1}] ${title ? `${title}: ` : ''}${url}`
    }
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
        tool_calls: message.toolCallRequests,
      },
    ]
  }

  private parseToolMessage({
    message,
  }: {
    message: ChatToolMessage
  }): RequestMessage[] {
    const result = message.toolCalls.map((toolCall) => {
      switch (toolCall.response.status) {
        case ToolCallResponseStatus.PendingApproval:
        case ToolCallResponseStatus.Running:
        case ToolCallResponseStatus.Rejected:
        case ToolCallResponseStatus.Aborted:
          return {
            role: 'tool' as const,
            tool_call: toolCall.request,
            content: `Tool call ${toolCall.request.id} is ${toolCall.response.status}`,
          }
        case ToolCallResponseStatus.Success:
          return {
            role: 'tool' as const,
            tool_call: toolCall.request,
            content: toolCall.response.data.text,
          }
        case ToolCallResponseStatus.Error:
          return {
            role: 'tool' as const,
            tool_call: toolCall.request,
            content: `Error: ${toolCall.response.error}`,
          }
      }
    })
    console.debug('[DEBUG] parseToolMessage:', {
      inputToolCallsCount: message.toolCalls.length,
      outputRequestMessagesCount: result.length,
      toolCallIds: message.toolCalls.map((tc) => tc.request.id),
      resultToolCallIds: result.map((r) => r.tool_call.id),
    })
    return result
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
      let similaritySearchResults = undefined

      const mentionablesRequireVaultSearch = message.mentionables.some(
        (m): m is MentionableVault => m.type === 'vault',
      )
      const shouldSearchEntireVault =
        Boolean(useVaultSearch) || mentionablesRequireVaultSearch

      onQueryProgressChange?.({
        type: 'reading-mentionables',
      })
      const files = message.mentionables
        .filter((m): m is MentionableFile => m.type === 'file')
        .map((m) => m.file)
      const folders = message.mentionables
        .filter((m): m is MentionableFolder => m.type === 'folder')
        .map((m) => m.folder)
      const nestedFiles = folders.flatMap((folder) =>
        getNestedFiles(folder, this.app.vault),
      )
      const allFiles = [...files, ...nestedFiles]
      const fileContents = await readMultipleTFiles(allFiles, this.app.vault)

      // Count tokens incrementally to avoid long processing times on large content sets
      const exceedsTokenThreshold = async () => {
        let accTokenCount = 0
        for (const content of fileContents) {
          const count = await tokenCount(content)
          accTokenCount += count
          if (accTokenCount > this.settings.ragOptions.thresholdTokens) {
            return true
          }
        }
        return false
      }
      const shouldUseRAG =
        shouldSearchEntireVault || (await exceedsTokenThreshold())

      let filePrompt: string
      if (shouldUseRAG) {
        similaritySearchResults = shouldSearchEntireVault
          ? await (
              await this.getRagEngine()
            ).processQuery({
              query,
              onQueryProgressChange: onQueryProgressChange,
            }) // TODO: Add similarity boosting for mentioned files or folders
          : await (
              await this.getRagEngine()
            ).processQuery({
              query,
              scope: {
                files: files.map((f) => f.path),
                folders: folders.map((f) => f.path),
              },
              onQueryProgressChange: onQueryProgressChange,
            })
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
        filePrompt = allFiles
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

  private getSystemMessage(
    shouldUseRAG: boolean,
    hasTools = false,
  ): RequestMessage {
    // When both RAG and tools are available, prioritize based on context
    const useRAGPrompt = shouldUseRAG && !hasTools

    // Build user custom instructions section (priority: placed first)
    const customInstructionsSection = this.buildCustomInstructionsSection()

    // Build base behavior section
    const baseBehaviorSection = useRAGPrompt
      ? this.buildRAGBehaviorSection(hasTools)
      : this.buildDefaultBehaviorSection(hasTools)

    // Build output format section
    const outputFormatSection = useRAGPrompt
      ? this.buildRAGOutputFormatSection()
      : this.buildDefaultOutputFormatSection()

    // Combine all sections: user instructions first, then base behavior, then output format
    const sections = [
      customInstructionsSection,
      baseBehaviorSection,
      outputFormatSection,
    ].filter(Boolean)

    return {
      role: 'system',
      content: sections.join('\n\n'),
    }
  }

  private buildCustomInstructionsSection(): string | null {
    // Get custom system prompt
    const customInstruction = this.settings.systemPrompt.trim()

    // Get currently selected assistant
    const currentAssistantId = this.settings.currentAssistantId
    const assistants = this.settings.assistants || []
    // Only use assistant if explicitly selected (currentAssistantId is not undefined)
    const currentAssistant = currentAssistantId
      ? assistants.find((a) => a.id === currentAssistantId)
      : null

    // If there's no custom prompt and no selected assistant, return null
    if (!customInstruction && !currentAssistant) {
      return null
    }

    // Build prompt content
    const parts: string[] = []

    // Add assistant's system prompt (if available) - this is the primary instruction
    if (currentAssistant?.systemPrompt) {
      parts.push(`<assistant_instructions name="${currentAssistant.name}">
${currentAssistant.systemPrompt}
</assistant_instructions>`)
    }

    // Add global custom instructions (if available)
    if (customInstruction) {
      parts.push(`<custom_instructions>
${customInstruction}
</custom_instructions>`)
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
- When using tools, focus on providing clear results to the user. Only briefly mention tool usage if it helps understanding.`
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
- When using tools, briefly state why they are needed and focus on summarizing the results for the user.`
    }

    return section
  }

  private buildDefaultOutputFormatSection(): string {
    return `## Output Format

- When you output a new Markdown block (for new content), wrap it in <smtcmp_block> tags. Example:
<smtcmp_block language="markdown">
{{ content }}
</smtcmp_block>

- When you output Markdown for an existing file, add filename and language attributes to <smtcmp_block>. Restate the relevant section or heading so the user knows which part of the file you are editing. Example:
<smtcmp_block filename="path/to/file.md" language="markdown">
## Section Title
{{ content }}
</smtcmp_block>

- When the user asks for edits to their Markdown file, output a simplified Markdown block that focuses only on the changed parts. Use comments to skip unchanged content. Wrap it with <smtcmp_block> and include filename and language. Example:
<smtcmp_block filename="path/to/file.md" language="markdown">
<!-- ... existing content ... -->
{{ edit_1 }}
<!-- ... existing content ... -->
{{ edit_2 }}
<!-- ... existing content ... -->
</smtcmp_block>

- The user has full access to the file, so show only the modified parts unless they explicitly ask for the full file. You may briefly explain what you changed when helpful.`
  }

  private buildRAGOutputFormatSection(): string {
    return `## Output Format

- When referencing markdown blocks in your answer:
  a. Never include line numbers in the output.
  b. Wrap user-facing markdown with <smtcmp_block language="...">...</smtcmp_block>.
  c. Add the filename attribute when the block corresponds to an existing file.
  d. If the user gives you a markdown block, output an empty placeholder with filename, language, startLine, and endLine attributes (e.g. <smtcmp_block filename="path/to/file.md" language="markdown" startLine="2" endLine="30"></smtcmp_block>) and keep commentary outside the block.

- When you output new Markdown content, wrap it in <smtcmp_block language="markdown">...</smtcmp_block>.
- When editing an existing file, include filename and language on the block, restate the relevant heading, and show only the changed sections using <!-- ... --> comments for skipped content. The user already has full access to the file.`
  }

  private async getCurrentFileMessage(
    currentFile: TFile,
  ): Promise<RequestMessage> {
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

  private getRagInstructionMessage(): RequestMessage {
    return {
      role: 'user',
      content: `If you need to reference any of the markdown blocks I gave you, add the startLine and endLine attributes to the <smtcmp_block> tags without any content inside. For example:
<smtcmp_block filename="path/to/file.md" language="markdown" startLine="200" endLine="310"></smtcmp_block>

When writing out new markdown blocks, remember not to include "line_number|" at the beginning of each line.`,
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
