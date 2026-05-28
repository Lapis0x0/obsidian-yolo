import type { App, TFile, TFolder } from 'obsidian'
import { Notice } from 'obsidian'

import { editorStateToPlainText } from '../../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import type { QueryProgressState } from '../../components/chat-view/QueryProgress'
import {
  buildCompactionResumeMessage,
  buildCompactionSummaryMessage,
} from '../../core/agent/compaction'
import { getMemoryPromptContext } from '../../core/memory/memoryManager'
import { getProjectInstructionsSection } from '../../core/project-instructions'
import {
  getLiteSkillDocument,
  listLiteSkillEntries,
} from '../../core/skills/liteSkills'
import {
  isSkillEnabledForAssistant,
  resolveAssistantSkillPolicy,
} from '../../core/skills/skillPolicy'
import { scrapeUrlGeneric } from '../../core/web-search'
import { readPromptSnapshotEntries } from '../../database/json/chat/promptSnapshotStore'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type {
  ChatAssistantMessage,
  ChatConversationCompactionLike,
  ChatExternalAgentResultMessage,
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
  MentionablePDF,
  MentionableUrl,
} from '../../types/mentionable'
import type { ToolCallRequest } from '../../types/tool-call.types'
import {
  createCompleteToolCallArguments,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { collectWikilinkPaths } from '../llm/annotate-wikilinks'
import { isImageTFile, tFileToImageDataUrl } from '../llm/image'
import {
  chatModelSupportsPdf,
  chatModelSupportsVision,
} from '../llm/model-modalities'
import { getNestedFiles, readTFileContent } from '../obsidian'
import {
  PDF_INDEX_MAX_BYTES,
  PDF_INDEX_MAX_PAGES,
  extractPdfText,
  extractPdfTextFromBase64,
} from '../pdf/extractPdfText'
import { resolvePromptVariables } from '../prompt/promptVariables'

import {
  type ContextualInjection,
  appendContextualInjectionsToLastUserMessage,
} from './contextual-injections'
import { serializeExternalAgentResultToUserMessage } from './externalAgentResultSerializer'
import {
  filterEmptyAssistantMessages,
  filterRequestMessagesByToolBoundary,
} from './tool-boundary'

/** Regex matching the `<user_selected_skills>...</user_selected_skills>` block
 * produced by `buildSelectedSkillsPrompt`. Used by the breakdown estimator to
 * avoid double-counting selected-skill text in the conversation bucket. */
const USER_SELECTED_SKILLS_BLOCK_RE =
  /<user_selected_skills>[\s\S]*?<\/user_selected_skills>\n?/g

const stripUserSelectedSkillsFromString = (text: string): string =>
  text.replace(USER_SELECTED_SKILLS_BLOCK_RE, '')

/** Stable signature for the `<previously-loaded-tools>` compaction disclosure
 * message. The disclosure is built by `buildCompactionDisclosureInjection` and
 * always starts with this exact tag — used by section assembly to attribute it
 * to the Tools bucket without depending on object identity (which can be
 * broken by downstream message-transforming passes). */
const COMPACTION_DISCLOSURE_PREFIX = '<previously-loaded-tools>'

const messageStartsWith = (
  message: RequestMessage,
  prefix: string,
): boolean => {
  if (typeof message.content === 'string') {
    return message.content.startsWith(prefix)
  }
  if (Array.isArray(message.content) && message.content.length > 0) {
    const head = message.content[0]
    if (head.type === 'text') return head.text.startsWith(prefix)
  }
  return false
}

/** Pull every `<user_selected_skills>...</user_selected_skills>` block out of a
 * RequestMessage. Returns the extracted block texts (joined with `\n\n` is
 * exactly what they contributed to the original message). The regex is global
 * so multiple blocks in one message are all captured. */
const extractUserSelectedSkillsFromMessage = (
  message: RequestMessage,
): string[] => {
  const matches: string[] = []
  const collectFromText = (text: string): void => {
    const re = new RegExp(USER_SELECTED_SKILLS_BLOCK_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      // Trim trailing newline that the regex captures so each extracted block
      // is the bare XML — token count parity comes from emitting them in a
      // dedicated section, not from preserving the separator.
      matches.push(m[0].replace(/\n$/, ''))
    }
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') collectFromText(part.text)
    }
  } else if (typeof message.content === 'string') {
    collectFromText(message.content)
  }
  return matches
}

/**
 * Return a structurally-cloned `RequestMessage` with any
 * `<user_selected_skills>` blocks removed from its text content. Used only by
 * the breakdown estimator — the LLM request still carries the original block.
 */
const stripUserSelectedSkillsFromMessage = (
  message: RequestMessage,
): RequestMessage => {
  // Only user messages can carry `ContentPart[]`; other roles are string-only.
  if (message.role === 'user' && Array.isArray(message.content)) {
    let mutated = false
    const nextParts: ContentPart[] = message.content.map((part) => {
      if (part.type === 'text') {
        const next = stripUserSelectedSkillsFromString(part.text)
        if (next !== part.text) {
          mutated = true
          return { ...part, text: next }
        }
      }
      return part
    })
    if (!mutated) return message
    return { ...message, content: nextParts }
  }
  if (typeof message.content === 'string') {
    const next = stripUserSelectedSkillsFromString(message.content)
    if (next === message.content) return message
    return { ...message, content: next }
  }
  return message
}

type RequestContextBuilderOptions = {
  includeSkills?: boolean
}

/**
 * A semantic slice of the upcoming LLM request. Used by the UI to break down
 * prompt-token usage by bucket without leaking string-concat order from the
 * builder. The conversation/system content reaching the model is always
 * derived from these sections, so any new prompt piece is automatically
 * reflected in the breakdown.
 */
export type PromptSectionBucket =
  | 'system'
  | 'tools'
  | 'rules'
  | 'skills'
  | 'memory'
  | 'conversation'
  | 'reasoning'

export type PromptSection = {
  bucket: PromptSectionBucket
  id: string
  /** String for system-prompt fragments / tool entries; structured value for
   * request messages so token estimation sees the same JSON the LLM will. */
  content: unknown
}

/** Internal: ordered system-prompt-side sections produced by the builder.
 * Their string content joined with `\n\n` is the system message content. */
type SystemPromptSections = PromptSection[]

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
  source: 'file' | 'folder'
}

const MAX_MENTIONED_FILE_OUTLINES = 10

/**
 * Strip image_url content parts from messages when the target model does not
 * support vision input. Each removed image part is replaced with a placeholder
 * text part so message structure remains valid. String-content messages are
 * left untouched.
 */
export function stripUnsupportedImages(
  messages: RequestMessage[],
  chatModel: ChatModel | null | undefined,
): RequestMessage[] {
  if (chatModelSupportsVision(chatModel)) {
    return messages
  }

  return messages.map((message) => {
    // Only user messages can carry ContentPart[] content — other roles use string.
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      return message
    }

    const stripped: ContentPart[] = message.content.flatMap((part) => {
      if (part.type === 'image_url') {
        return [{ type: 'text' as const, text: '[图片已省略：模型不支持视觉]' }]
      }
      return [part]
    })

    return { ...message, content: stripped }
  })
}

/**
 * Render the canonical `## Attached PDFs` text block for a single PDF. Used
 * both for legacy text-only mentionables (their persisted `data`) and for the
 * non-native-model fallback path (`prepareDocumentsForModel`). One template,
 * one place to evolve.
 */
function renderAttachedPdfBlock({
  name,
  text,
  pageCount,
  truncated,
}: {
  name: string
  text: string
  pageCount?: number
  /** Set when the fallback extractor itself had to truncate (FALLBACK_MAX_PAGES). */
  truncated?: boolean
}): string {
  const meta =
    pageCount !== undefined
      ? ` (${pageCount} pages${truncated ? ', truncated' : ''})`
      : truncated
        ? ' (truncated)'
        : ''
  return `## Attached PDFs\n### ${name}${meta}\n\n${text}\n\n`
}

/**
 * Convert `document` content parts to plain text for models that don't
 * advertise the `pdf` modality. Native-PDF-capable models leave document parts
 * untouched. This is the modality gate — adapters never have to handle a
 * document part for a non-pdf model.
 *
 * Text extraction goes through the shared `pdfTextCacheStore` keyed by content
 * hash: the upload site already wrote pages there during `fileToMentionablePDF`,
 * so the common case is a pure cache hit (no pdfjs invocation per turn). Cache
 * miss (e.g. legacy mentionable, or upload-time write failure) falls back to a
 * fresh extraction and writes the result for next time.
 */
export async function prepareDocumentsForModel(
  messages: RequestMessage[],
  chatModel: ChatModel | null | undefined,
  context: { app: App; settings: YoloSettings },
): Promise<RequestMessage[]> {
  if (chatModelSupportsPdf(chatModel)) {
    return messages
  }

  const next: RequestMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      next.push(message)
      continue
    }

    const transformed: ContentPart[] = []
    for (const part of message.content) {
      if (part.type !== 'document') {
        transformed.push(part)
        continue
      }
      try {
        const { pages } = await extractPdfTextFromBase64(
          context.app,
          part.data,
          {
            settings: context.settings,
            sourceLabel: `upload:${part.name}`,
          },
        )
        const text = pages
          .map(({ page, text }) => `--- Page ${page} ---\n${text}`)
          .join('\n\n')
        transformed.push({
          type: 'text',
          text: renderAttachedPdfBlock({
            name: part.name,
            text,
            pageCount: part.pageCount ?? pages.length,
          }),
        })
      } catch (error) {
        console.warn(
          '[YOLO] Failed to extract PDF text for non-native model, dropping document part',
          part.name,
          error,
        )
        transformed.push({
          type: 'text',
          text: `[PDF "${part.name}" 无法解析为文本，已忽略]`,
        })
      }
    }

    next.push({ ...message, content: transformed })
  }

  return next
}

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
  private app: App
  private settings: YoloSettings
  private includeSkills: boolean

  constructor(
    app: App,
    settings: YoloSettings,
    options?: RequestContextBuilderOptions,
  ) {
    this.app = app
    this.settings = settings
    this.includeSkills = options?.includeSkills ?? true
  }

  private getMentionContextMode(): MentionContextMode {
    return this.settings.chatOptions?.mentionContextMode ?? 'light'
  }

  /**
   * Resolve the assistant referenced by `settings.currentAssistantId`.
   * Returns null when no assistant is selected or the selected id is not found,
   * so callers can treat both cases as "no assistant".
   */
  private getCurrentAssistant() {
    const currentAssistantId = this.settings.currentAssistantId
    if (!currentAssistantId) return null
    const assistants = this.settings.assistants ?? []
    return assistants.find((a) => a.id === currentAssistantId) ?? null
  }

  public async generateRequestMessages(args: {
    messages: ChatMessage[]
    hasTools?: boolean
    hasMemoryTools?: boolean
    model: ChatModel
    conversationId: string
    compaction?: ChatConversationCompactionLike | null
    contextualInjections?: ContextualInjection[]
  }): Promise<RequestMessage[]> {
    const { requestMessages } = await this.assembleRequest(args)
    return requestMessages
  }

  /**
   * Shared pipeline for `generateRequestMessages` and
   * `generateRequestSections`. Compiles the user message, reads snapshots,
   * builds the system prompt, runs contextual injections, and strips/preps
   * documents for the target model — all in one pass so the two public APIs
   * never duplicate I/O (memory files / project instructions / skill docs).
   */
  private async assembleRequest({
    messages,
    hasTools = false,
    hasMemoryTools = false,
    model: _model,
    conversationId,
    compaction,
    contextualInjections,
  }: {
    messages: ChatMessage[]
    hasTools?: boolean
    hasMemoryTools?: boolean
    model: ChatModel
    conversationId: string
    compaction?: ChatConversationCompactionLike | null
    contextualInjections?: ContextualInjection[]
  }): Promise<{
    requestMessages: RequestMessage[]
    systemSections: SystemPromptSections
  }> {
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
      const { promptContent } = await this.compileUserMessagePrompt({
        message: lastUserMessage,
      })
      compiledMessages[lastUserMessageIndex] = {
        ...lastUserMessage,
        promptContent,
      }
    }

    const snapshotEntries = await readPromptSnapshotEntries({
      app: this.app,
      conversationId,
      settings: this.settings,
    })

    for (let i = 0; i < compiledMessages.length; i += 1) {
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

      const { promptContent } = await this.compileUserMessagePrompt({
        message,
      })
      compiledMessages[i] = {
        ...message,
        promptContent,
        snapshotRef: undefined,
      }
    }

    const systemSections = await this.buildSystemPromptSections(
      hasTools,
      hasMemoryTools,
    )
    const systemContent = systemSections
      .map((section) =>
        typeof section.content === 'string' ? section.content : '',
      )
      .filter((text) => text.length > 0)
      .join('\n\n')
    const systemMessage: RequestMessage = {
      role: 'system',
      content: systemContent,
    }

    const compactionDisclosureMessage =
      this.buildCompactionDisclosureInjection(compaction)

    const baseRequestMessages: RequestMessage[] = [
      systemMessage,
      ...(compactionDisclosureMessage ? [compactionDisclosureMessage] : []),
      ...(await this.getChatHistoryMessages({
        messages: compiledMessages,
        snapshotEntries,
        compaction,
      })),
    ]

    const withInjections = await appendContextualInjectionsToLastUserMessage(
      baseRequestMessages,
      contextualInjections ?? [],
      { app: this.app, settings: this.settings },
    )

    const requestMessages = await prepareDocumentsForModel(
      stripUnsupportedImages(withInjections, _model),
      _model,
      { app: this.app, settings: this.settings },
    )

    return {
      requestMessages,
      systemSections,
    }
  }

  /**
   * Generate the breakdown of the upcoming LLM request into typed sections.
   * Shares the full assembly pipeline with `generateRequestMessages` — there
   * is no redundant memory / project-instructions / skill I/O.
   *
   * `requestTools` should be the same value that will be sent in the request
   * (post `selectAllowedTools` filtering); each entry becomes a `tools`
   * section so the UI can attribute its tokens correctly.
   */
  public async generateRequestSections(args: {
    messages: ChatMessage[]
    hasTools?: boolean
    hasMemoryTools?: boolean
    model: ChatModel
    conversationId: string
    compaction?: ChatConversationCompactionLike | null
    contextualInjections?: ContextualInjection[]
    requestTools?: unknown[] | undefined
  }): Promise<PromptSection[]> {
    const { requestMessages, systemSections } = await this.assembleRequest(args)

    const sections: PromptSection[] = []
    sections.push(...systemSections)

    // Tools — emit one section per tool so the UI can sum them and the cache
    // key reflects each tool individually (toggling one tool changes hash).
    if (args.requestTools && args.requestTools.length > 0) {
      for (let i = 0; i < args.requestTools.length; i += 1) {
        const tool = args.requestTools[i]
        const toolName =
          tool &&
          typeof tool === 'object' &&
          'function' in tool &&
          tool.function &&
          typeof tool.function === 'object' &&
          'name' in tool.function &&
          typeof (tool.function as { name?: unknown }).name === 'string'
            ? (tool.function as { name: string }).name
            : `tool-${i}`
        sections.push({
          bucket: 'tools',
          id: `tools.${toolName}`,
          content: tool,
        })
      }
    }

    // Walk request messages. Three carve-outs:
    //   1. Skip the system message (already emitted via systemSections).
    //   2. Detect the `<previously-loaded-tools>` compaction disclosure by
    //      content prefix (not identity — downstream passes may rebuild
    //      the message object) and emit it under the Tools bucket.
    //   3. Pull every `<user_selected_skills>` block out via regex and emit
    //      each one as a separate Skills section; strip them from the message
    //      so the same text isn't double-counted under Conversation. Extracting
    //      from the actually-built messages covers historical user messages
    //      too and avoids a redundant `buildSelectedSkillsPrompt` call.
    for (let i = 0; i < requestMessages.length; i += 1) {
      const msg = requestMessages[i]
      if (msg.role === 'system') continue

      if (messageStartsWith(msg, COMPACTION_DISCLOSURE_PREFIX)) {
        sections.push({
          bucket: 'tools',
          id: 'tools.compaction-disclosure',
          content: msg,
        })
        continue
      }

      // Only user messages can carry a `<user_selected_skills>` block — the
      // generator (`buildSelectedSkillsPrompt`) only emits it into user
      // content. Skipping other roles prevents assistant / tool messages that
      // happen to mention the tag literally from being mis-attributed.
      const skillsBlocks =
        msg.role === 'user' ? extractUserSelectedSkillsFromMessage(msg) : []
      for (let s = 0; s < skillsBlocks.length; s += 1) {
        sections.push({
          bucket: 'skills',
          id: `skills.user-selected.${i}.${s}`,
          content: skillsBlocks[s],
        })
      }

      const stripped =
        skillsBlocks.length > 0 ? stripUserSelectedSkillsFromMessage(msg) : msg

      // Carve out assistant reasoning (chain-of-thought) into its own bucket so
      // the popover can show how much of the context is spent on prior-turn
      // thinking. Reasoning is already a separate field on RequestMessage, so
      // stripping it from the conversation section preserves the total token
      // count (split ≈ original).
      let conversationContent: RequestMessage = stripped
      if (
        stripped.role === 'assistant' &&
        typeof stripped.reasoning === 'string' &&
        stripped.reasoning.length > 0
      ) {
        sections.push({
          bucket: 'reasoning',
          id: `reasoning.${i}`,
          content: { reasoning: stripped.reasoning },
        })
        const { reasoning: _reasoning, ...rest } = stripped
        conversationContent = rest
      }

      sections.push({
        bucket: 'conversation',
        id: `conversation.${i}.${msg.role}`,
        content: conversationContent,
      })
    }

    return sections
  }

  private async getChatHistoryMessages({
    messages,
    snapshotEntries,
    compaction,
  }: {
    messages: ChatMessage[]
    snapshotEntries: Record<string, string | ContentPart[]>
    compaction?: ChatConversationCompactionLike | null
  }): Promise<RequestMessage[]> {
    const requestMessages: RequestMessage[] = []

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
        const compactContextMessages = messages.slice(retainedStartIndex)

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
              ...this.parseAssistantMessage({ message }),
            )
            continue
          }

          if (message.role === 'external_agent_result') {
            requestMessages.push(this.parseExternalAgentResultMessage(message))
            continue
          }

          requestMessages.push(
            ...this.parseToolMessage({ message }),
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

    for (const message of messages) {
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
          ...this.parseAssistantMessage({ message }),
        )
        continue
      }

      if (message.role === 'external_agent_result') {
        requestMessages.push(this.parseExternalAgentResultMessage(message))
        continue
      }

      requestMessages.push(
        ...this.parseToolMessage({ message }),
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
    const pdfs = message.mentionables.filter(
      (m): m is MentionablePDF => m.type === 'pdf',
    )
    const blockPrompt = blocks
      .map(({ file, content, startLine, pageNumber }) => {
        const pageTag = pageNumber !== undefined ? ` (page ${pageNumber})` : ''
        const header = `${file.path}${pageTag}`
        if (pageNumber !== undefined) {
          // PDF block: skip line numbering (startLine/endLine are 0)
          return `\`\`\`${header}\n${content}\n\`\`\`\n`
        }
        const numberedContent = this.addLineNumbersToContent({
          content,
          startLine,
        })
        return `\`\`\`${header}\n${numberedContent}\n\`\`\`\n`
      })
      .join('')
    const assistantQuotePrompt = this.buildAssistantQuotePrompt(assistantQuotes)
    const {
      documentParts: pdfDocumentParts,
      legacyText: legacyPdfFallbackText,
    } = this.buildPdfAttachments(pdfs)

    const selectedSkillsPrompt = await this.buildSelectedSkillsPrompt(
      message.selectedSkills,
    )
    const textContent = `${blockPrompt}${assistantQuotePrompt}${legacyPdfFallbackText}${selectedSkillsPrompt}\n\n${query}\n\n`
    if (imageParts.length === 0 && pdfDocumentParts.length === 0) {
      return textContent
    }

    return [
      ...imageParts,
      ...pdfDocumentParts,
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
          mentionable.type === 'assistant-quote',
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
        reasoning: message.reasoning,
        providerMetadata: message.metadata?.providerMetadata,
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

  private parseExternalAgentResultMessage(
    message: ChatExternalAgentResultMessage,
  ): RequestMessage {
    return serializeExternalAgentResultToUserMessage(message)
  }

  private parseToolMessage({
    message,
  }: {
    message: ChatToolMessage
  }): RequestMessage[] {
    const toolMessages: RequestMessage[] = []
    const collectedContentParts: ContentPart[] = []

    for (const toolCall of message.toolCalls) {
      switch (toolCall.response.status) {
        case ToolCallResponseStatus.PendingApproval:
        case ToolCallResponseStatus.Running:
        case ToolCallResponseStatus.AwaitingUserInput:
          // Skip incomplete tool calls to avoid confusing the next planning step.
          break
        case ToolCallResponseStatus.Aborted:
          toolMessages.push({
            role: 'tool',
            tool_call: toolCall.request,
            content: `Tool call ${toolCall.request.id} was cancelled by the user.`,
          })
          break
        case ToolCallResponseStatus.Rejected:
          toolMessages.push({
            role: 'tool',
            tool_call: toolCall.request,
            content: `Tool call ${toolCall.request.id} is rejected`,
          })
          break
        case ToolCallResponseStatus.Success: {
          toolMessages.push({
            role: 'tool',
            tool_call: toolCall.request,
            content: toolCall.response.data.text,
          })
          // Collect hoistable parts (image_url and document) for a follow-up
          // user message after all tool messages, so the message sequence stays valid.
          const parts = toolCall.response.data.contentParts
          if (parts) {
            const hoistableParts = parts.filter(
              (p) => p.type === 'image_url' || p.type === 'document',
            )
            if (hoistableParts.length > 0) {
              const hasImage = hoistableParts.some(
                (p) => p.type === 'image_url',
              )
              const hasDoc = hoistableParts.some((p) => p.type === 'document')
              const headerLabel =
                hasImage && hasDoc
                  ? `Attachments from tool call: ${toolCall.request.name}`
                  : hasDoc
                    ? `PDF attachments from tool call: ${toolCall.request.name}`
                    : `Images from tool call: ${toolCall.request.name}`
              collectedContentParts.push(
                { type: 'text', text: `[${headerLabel}]` },
                ...hoistableParts,
              )
            }
          }
          break
        }
        case ToolCallResponseStatus.Error:
          toolMessages.push({
            role: 'tool',
            tool_call: toolCall.request,
            content: `Error: ${toolCall.response.error}`,
          })
          break
      }
    }

    // Append a single user message with all collected attachments after the
    // tool block, preserving the required tool → user message ordering.
    if (collectedContentParts.length > 0) {
      toolMessages.push({
        role: 'user',
        content: collectedContentParts,
      })
    }

    return toolMessages
  }

  public async compileUserMessagePrompt({
    message,
    onQueryProgressChange,
  }: {
    message: ChatUserMessage
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void
  }): Promise<{
    promptContent: ChatUserMessage['promptContent']
  }> {
    try {
      if (
        !message.content &&
        message.mentionables.length === 0 &&
        (message.selectedSkills?.length ?? 0) === 0
      ) {
        return {
          promptContent: '',
        }
      }
      const query = message.content
        ? editorStateToPlainText(message.content, {
            ignoreMentionableTypes: ['model'],
          })
        : ''

      onQueryProgressChange?.({
        type: 'reading-mentionables',
      })

      const allMentionedFiles = message.mentionables
        .filter((m): m is MentionableFile => m.type === 'file')
        .map((m) => this.app.vault.getFileByPath(m.file.path))
        .filter((file): file is TFile => Boolean(file))
      const mentionedImageFiles = allMentionedFiles.filter(isImageTFile)
      const files = allMentionedFiles.filter((f) => !isImageTFile(f))
      const folders = message.mentionables
        .filter((m): m is MentionableFolder => m.type === 'folder')
        .map((m) => this.app.vault.getFolderByPath(m.folder.path))
        .filter((folder): folder is TFolder => Boolean(folder))

      const filePrompt = await this.buildMentionedFilePrompt({
        files,
        folders,
      })

      const blocks = message.mentionables.filter(
        (m): m is MentionableBlock => m.type === 'block',
      )
      const assistantQuotes = message.mentionables.filter(
        (m): m is MentionableAssistantQuote => m.type === 'assistant-quote',
      )
      const pdfs = message.mentionables.filter(
        (m): m is MentionablePDF => m.type === 'pdf',
      )
      const blockPrompt = blocks
        .map(({ file, content, startLine, pageNumber }) => {
          const pageTag =
            pageNumber !== undefined ? ` (page ${pageNumber})` : ''
          const header = `${file.path}${pageTag}`
          if (pageNumber !== undefined) {
            // PDF block: skip line numbering (startLine/endLine are 0)
            return `\`\`\`${header}\n${content}\n\`\`\`\n`
          }
          const numberedContent = this.addLineNumbersToContent({
            content,
            startLine,
          })
          return `\`\`\`${header}\n${numberedContent}\n\`\`\`\n`
        })
        .join('')
      const assistantQuotePrompt =
        this.buildAssistantQuotePrompt(assistantQuotes)
      const {
        documentParts: pdfDocumentParts,
        legacyText: legacyPdfFallbackText,
      } = this.buildPdfAttachments(pdfs)

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

      const inlineImageDataUrls = message.mentionables
        .filter((m): m is MentionableImage => m.type === 'image')
        .map(({ data }) => data)
      const vaultImageDataUrls = (
        await Promise.all(
          mentionedImageFiles.map(async (file) => {
            try {
              return await tFileToImageDataUrl(this.app, file, {
                cache: { enabled: true, settings: this.settings },
              })
            } catch (error) {
              console.warn(
                '[YOLO] Failed to read mentioned image file',
                file.path,
                error,
              )
              return null
            }
          }),
        )
      ).filter((url): url is string => url !== null)
      const imageDataUrls = [...inlineImageDataUrls, ...vaultImageDataUrls]
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
          ...pdfDocumentParts,
          {
            type: 'text',
            text: `${filePrompt}${blockPrompt}${assistantQuotePrompt}${legacyPdfFallbackText}${urlPrompt}${selectedSkillsPrompt}\n\n${query}\n\n`,
          },
        ],
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

  /**
   * Single entry that turns PDF mentionables into request payload pieces:
   *   • `documentParts`: native `document` content parts for new uploads that
   *     carry raw bytes. Pass-through for adapters that advertise the `pdf`
   *     modality; `prepareDocumentsForModel` converts to text otherwise.
   *   • `legacyText`: a `## Attached PDFs` block for legacy mentionables that
   *     only have the pre-extracted `data` text (serialized before native PDF
   *     support landed). Empty string when there are no legacy items.
   */
  private buildPdfAttachments(pdfs: MentionablePDF[]): {
    documentParts: ContentPart[]
    legacyText: string
  } {
    const documentParts: ContentPart[] = []
    const legacyBlocks: string[] = []

    for (const pdf of pdfs) {
      if (pdf.rawData) {
        documentParts.push({
          type: 'document',
          mediaType: 'application/pdf',
          name: pdf.name,
          data: pdf.rawData,
          pageCount: pdf.pageCount,
        })
      } else if (pdf.data) {
        legacyBlocks.push(
          renderAttachedPdfBlock({
            name: pdf.name,
            text: pdf.data,
            pageCount: pdf.pageCount,
          }),
        )
      }
    }

    return {
      documentParts,
      // Already includes the `## Attached PDFs` header per block; join into one.
      legacyText: legacyBlocks.join(''),
    }
  }

  /**
   * After compaction, the original `load_tool_schemas` results are gone. Re-inject
   * full schemas for on-demand tools that were already disclosed so the model
   * can keep calling them without redundant `load_tool_schemas` round-trips. Schemas
   * over the per-tool budget are intentionally not persisted by compaction;
   * the prompt tells the model to fall back to `load_tool_schemas` for those.
   *
   * Returned as a `user` message so it sticks to the request prefix without
   * polluting the system prompt. It is built deterministically from the
   * compaction payload, so this entry remains cache-stable across turns.
   */
  private buildCompactionDisclosureInjection(
    compaction?: ChatConversationCompactionLike | null,
  ): RequestMessage | null {
    const latest = getLatestChatConversationCompaction(compaction)
    const schemas = latest?.loadedDeferredToolSchemas
    if (!schemas || schemas.length === 0) {
      return null
    }

    const entries = schemas
      .map((schema) => {
        const description = (schema.description ?? '').trim()
        let parameters: string
        try {
          parameters = JSON.stringify(schema.parameters, null, 2)
        } catch {
          parameters = '{}'
        }
        return `- ${schema.name}:\n  description: ${description}\n  parameters:\n${parameters
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n')}`
      })
      .join('\n\n')

    return {
      role: 'user',
      content: `<previously-loaded-tools>
The following on-demand tools were already disclosed by yolo_local__load_tool_schemas earlier in this conversation. Their stubs remain registered in the tools list. You may call them directly using the schemas below without calling yolo_local__load_tool_schemas again.

If you need an on-demand tool that is NOT listed here (for example because its schema was too large to persist across compaction), call yolo_local__load_tool_schemas with {"servers":["<server-name>"]} — where "<server-name>" is the prefix before "__" in the stub tool name — to re-disclose all on-demand tools under that MCP server.

${entries}
</previously-loaded-tools>`,
    }
  }

  /**
   * Build the ordered list of system-prompt-side sections. The order is the
   * same as the legacy string-concat order in `getSystemMessage`, so joining
   * the string contents with `\n\n` reproduces the original system prompt
   * byte-for-byte. Buckets are assigned per the breakdown spec.
   */
  private async buildSystemPromptSections(
    hasTools: boolean,
    hasMemoryTools: boolean,
  ): Promise<SystemPromptSections> {
    const sections: SystemPromptSections = []
    const currentAssistant = this.getCurrentAssistant()

    // Custom-instructions block — split into sub-sections so that memory /
    // skills / system text can be counted independently. Order MUST match the
    // legacy parts[] order in `buildCustomInstructionsSection`.
    const customInstructionSubsections =
      await this.buildCustomInstructionsSubsections(hasMemoryTools)
    sections.push(...customInstructionSubsections)

    const baseBehaviorContent = this.buildDefaultBehaviorSection(hasTools)
    if (baseBehaviorContent) {
      sections.push({
        bucket: 'system',
        id: 'system.base-behavior',
        content: baseBehaviorContent,
      })
    }

    const projectInstructionsContent = await getProjectInstructionsSection(
      this.app,
      currentAssistant?.enableProjectInstructions === true,
      currentAssistant?.workspaceScope,
    )
    if (projectInstructionsContent) {
      sections.push({
        bucket: 'rules',
        id: 'rules.project-instructions',
        content: projectInstructionsContent,
      })
    }

    return sections
  }

  /**
   * Ordered breakdown of the legacy `customInstructionsSection`. The string
   * contents joined with `\n\n` reproduce the original block exactly; each
   * entry is tagged with the bucket the UI should attribute its tokens to.
   *
   * IMPORTANT: this is the single source of truth for memory / skills / global
   * custom-instructions / assistant-instructions prompt assembly. Both
   * `getSystemMessage` and `generateRequestSections` consume it — do NOT add a
   * second path that re-reads memory files or skill entries.
   */
  private async buildCustomInstructionsSubsections(
    hasMemoryTools: boolean,
  ): Promise<SystemPromptSections> {
    const sections: SystemPromptSections = []
    const currentAssistant = this.getCurrentAssistant()

    // Custom system prompt (global)
    const customInstruction = resolvePromptVariables(
      this.settings.systemPrompt,
    ).trim()

    // Assistant instructions — bucket: system (assistant prompt is system-prompt-side)
    if (currentAssistant?.systemPrompt) {
      const resolvedAssistantSystemPrompt = resolvePromptVariables(
        currentAssistant.systemPrompt,
      ).trim()
      if (resolvedAssistantSystemPrompt) {
        sections.push({
          bucket: 'system',
          id: 'system.assistant-instructions',
          content: `<assistant_instructions name="${currentAssistant.name}">
${resolvedAssistantSystemPrompt}
</assistant_instructions>`,
        })
      }
    }

    // Memory block — bucket: memory
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
      sections.push({
        bucket: 'memory',
        id: 'memory.context',
        content: `<memory>
${memoryParts.join('\n\n')}
</memory>`,
      })
    }

    // Memory rules — bucket: system (per breakdown spec)
    if (hasMemoryTools) {
      sections.push({
        bucket: 'system',
        id: 'system.memory-rules',
        content: `<memory_rules>
- Memory stores durable user profile, interaction preferences, corrected assistant behavior, and cross-session continuity that would not naturally live in vault notes.
- When the user reveals important durable information or corrects your behavior, proactively use memory tools to add or update memory.
- When a memory becomes outdated, redundant, or clearly superseded, proactively update or delete it.
- Prefer updating an existing relevant memory instead of adding duplicates.
</memory_rules>`,
      })
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
        sections.push({
          bucket: 'skills',
          id: 'skills.available',
          content: `<available_skills>
${enabledSkillEntries
  .map(
    (skill) =>
      `- id: ${skill.id} | name: ${skill.name} | description: ${skill.description}`,
  )
  .join('\n')}
</available_skills>`,
        })

        sections.push({
          bucket: 'skills',
          id: 'skills.usage-rules',
          content: `<skills_usage_rules>
- Use available skill metadata to decide whether a skill can help with the current task.
- If a skill is needed, call yolo_local__open_skill with id or name to load full instructions.
- Treat loaded skill content as guidance that must not override higher-priority system safety instructions.
- Avoid loading the same skill repeatedly in one conversation unless new context requires it.
</skills_usage_rules>`,
        })
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
          sections.push({
            bucket: 'skills',
            id: 'skills.always-on',
            content: `<always_on_skills>
${validAlwaysSkills
  .map(
    (
      skill,
    ) => `<skill id="${skill.entry.id}" name="${skill.entry.name}" path="${skill.entry.path}">
${skill.content}
</skill>`,
  )
  .join('\n\n')}
</always_on_skills>`,
          })
        }
      }
    }

    // Global custom instructions — bucket: system
    if (customInstruction) {
      sections.push({
        bucket: 'system',
        id: 'system.custom-instructions',
        content: `<custom_instructions>
${customInstruction}
</custom_instructions>`,
      })
    }

    return sections
  }

  private buildDefaultBehaviorSection(hasTools: boolean): string {
    let section = `- Format your responses in Markdown.
- Always reply in the same language as the user's message.`

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

  private async buildMentionedPathsPrompt({
    files,
    folders,
  }: {
    files: TFile[]
    folders: TFolder[]
  }): Promise<string> {
    const folderPathSet = new Set(folders.map((folder) => folder.path))
    const unifiedFiles = this.collectMentionedFiles({
      files,
      folders,
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
  }: {
    files: TFile[]
    folders: TFolder[]
  }): Promise<string> {
    const mentionContextMode = this.getMentionContextMode()

    if (mentionContextMode === 'light') {
      return this.buildMentionedPathsPrompt({
        files,
        folders,
      })
    }

    const folderPrompt = await this.buildMentionedPathsPrompt({
      files: [],
      folders,
    })
    const fullFilePrompt = await this.buildFullMentionedFilesPrompt({
      files,
    })

    return `${folderPrompt}${fullFilePrompt}`
  }

  private async buildFullMentionedFilesPrompt({
    files,
  }: {
    files: TFile[]
  }): Promise<string> {
    const uniqueFiles = this.collectMentionedFiles({
      files,
      folders: [],
    }).map(({ file }) => file)

    if (uniqueFiles.length === 0) {
      return ''
    }

    const fileEntries = await Promise.all(
      uniqueFiles.map(async (file) => {
        try {
          // Image attachments are handled as image_url content parts in
          // compileUserMessagePrompt; never inline their binary as text.
          if (isImageTFile(file)) {
            return null
          }
          const ext = file.extension?.toLowerCase() ?? ''
          let rawContent: string
          if (ext === 'pdf') {
            const { pages } = await extractPdfText(this.app, file, {
              maxBinaryBytes: PDF_INDEX_MAX_BYTES,
              maxPages: PDF_INDEX_MAX_PAGES,
              settings: this.settings,
            })
            rawContent = pages
              .map((p) => `<page ${p.page}>\n${p.text}\n</page ${p.page}>`)
              .join('\n')
          } else {
            rawContent = await readTFileContent(file, this.app.vault)
          }
          return { file, content: rawContent }
        } catch (error) {
          console.warn('[YOLO] Failed to read mentioned file', file.path, error)
          return null
        }
      }),
    )
    const readableFileEntries = fileEntries.filter(
      (entry): entry is { file: TFile; content: string } => entry !== null,
    )

    if (readableFileEntries.length === 0) {
      return ''
    }

    const entriesWithMeta = readableFileEntries.map(({ file, content }) => {
      const numberedContent =
        content.length === 0
          ? ''
          : this.addLineNumbersToContent({ content, startLine: 1 })
      const lineCount = content.length === 0 ? 0 : content.split('\n').length
      return { file, content, numberedContent, lineCount }
    })

    const fileListLines = entriesWithMeta
      .map(({ file, lineCount }) => `- \`${file.path}\` (${lineCount} lines)`)
      .join('\n')
    const header =
      '## Mentioned Vault Files (full content already provided below)\n' +
      'The following files are fully attached in this message:\n' +
      `${fileListLines}\n\n` +
      'The content below is the latest version of these files at this turn. ' +
      'Do NOT call any file-reading tool (e.g. read_file) to re-read them — use the content provided here directly. ' +
      'Only call file tools if you need a file that is NOT in the list above.\n\n'

    const body = entriesWithMeta
      .map(({ file, content, numberedContent, lineCount }) => {
        const wikilinks =
          file.path.endsWith('.md') && content.length > 0
            ? collectWikilinkPaths(this.app, content, file.path)
            : []
        const wikilinksBlock =
          wikilinks.length > 0
            ? `<wikilinks file="${file.path}">\n${wikilinks
                .map((w) => `${w.link} -> ${w.path}`)
                .join('\n')}\n</wikilinks>\n`
            : ''
        return (
          `### \`${file.path}\` (full content, ${lineCount} lines)\n` +
          `\`\`\`${file.path}\n${numberedContent}\n\`\`\`\n${wikilinksBlock}`
        )
      })
      .join('')

    return `${header}${body}`
  }

  private collectMentionedFiles({
    files,
    folders,
  }: {
    files: TFile[]
    folders: TFolder[]
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

    for (const folder of folders) {
      for (const file of getNestedFiles(folder, this.app.vault)) {
        pushFile(file, 'folder')
      }
    }

    return collected
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

  private async getWebsiteContent(url: string): Promise<string> {
    try {
      const { content } = await scrapeUrlGeneric(url)
      return content
    } catch (error) {
      const status = error instanceof Error ? error.message : String(error)
      console.warn(`Failed to fetch URL: ${url}`, error)
      new Notice(`URL fetch failed (${status}): ${url}`, 6000)
      return `[Failed to fetch content from this URL: ${status}]`
    }
  }
}
