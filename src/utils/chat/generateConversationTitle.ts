import { editorStateToPlainText } from '../../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import { DEFAULT_CHAT_TITLE_PROMPT } from '../../constants'
import { isRequestErrorNonRetryable } from '../../core/ai/requestRetry'
import { executeSingleTurn } from '../../core/ai/single-turn'
import {
  createLLMDebugTrace,
  isLLMDebugCaptureEnabled,
  registerLLMDebugTraceForTurn,
  updateLLMDebugTrace,
} from '../../core/llm/debugCapture'
import { getChatModelClient } from '../../core/llm/manager'
import type { AutoPromotedTransportMode } from '../../core/llm/requestTransport'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type {
  ChatMessage,
  ChatSelectedSkill,
  ChatUserMessage,
} from '../../types/chat'

export const AUTO_TITLE_TIMEOUT_MS = 10000
export const AUTO_TITLE_MAX_RETRIES = 2
export const AUTO_TITLE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000

const formatSelectedSkillsForTitleInput = (
  selectedSkills: ChatSelectedSkill[],
): string => {
  const skillNames = selectedSkills
    .map((skill) => skill.name.trim())
    .filter((name) => name.length > 0)

  if (skillNames.length === 0) {
    return '[User selected only skills without text.]'
  }

  return `[User selected skills: ${skillNames.join(', ')}]`
}

const extractTextFromPromptContent = (
  promptContent: ChatUserMessage['promptContent'],
): string => {
  if (!promptContent) return ''
  if (typeof promptContent === 'string') return promptContent.trim()
  return promptContent
    .filter((part) => part.type === 'text')
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

export const buildConversationTitleInput = (
  firstUserMessage: ChatUserMessage,
): string | null => {
  const userText = firstUserMessage.content
    ? editorStateToPlainText(firstUserMessage.content)
    : ''
  const normalizedUserText = userText.trim()
  const userMentionables = firstUserMessage.mentionables ?? []
  const userSelectedSkills = firstUserMessage.selectedSkills ?? []
  // Reuse the same expanded prompt that gets sent to the chat model so
  // the title model sees referenced files / URLs / blocks / quotes
  // without re-running compilation or doing extra I/O here.
  const compiledText = extractTextFromPromptContent(
    firstUserMessage.promptContent,
  )
  const hasUserSignal =
    normalizedUserText.length > 0 ||
    compiledText.length > 0 ||
    userMentionables.length > 0 ||
    userSelectedSkills.length > 0

  if (!hasUserSignal) return null

  const userContext =
    compiledText.length > 0
      ? compiledText
      : normalizedUserText.length > 0
        ? normalizedUserText
        : userSelectedSkills.length > 0
          ? formatSelectedSkillsForTitleInput(userSelectedSkills)
          : '[User shared only attachments/mentions without text.]'

  return `User first message:\n${userContext}`
}

export type GenerateConversationTitleParams = {
  settings: YoloSettings
  language: string
  messages: ChatMessage[]
  onAutoPromoteTransportMode?: (
    providerId: string,
    mode: AutoPromotedTransportMode,
  ) => void
  debug?: {
    conversationId: string
    sourceUserMessageId: string
  }
}

export type GenerateConversationTitleResult =
  | { ok: true; title: string }
  | {
      ok: false
      reason: 'no_user_signal' | 'llm_generation_failed'
      error?: unknown
    }

export const generateConversationTitleText = async ({
  settings,
  language,
  messages,
  onAutoPromoteTransportMode,
  debug,
}: GenerateConversationTitleParams): Promise<GenerateConversationTitleResult> => {
  const firstUserMessage = messages.find((message) => message.role === 'user')
  if (!firstUserMessage) {
    return { ok: false, reason: 'no_user_signal' }
  }

  const titleInput = buildConversationTitleInput(firstUserMessage)
  if (!titleInput) {
    return { ok: false, reason: 'no_user_signal' }
  }

  let lastGenerationError: unknown = null

  const attemptGenerateTitle = async (
    retryCount: number = 0,
  ): Promise<string | null> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AUTO_TITLE_TIMEOUT_MS)

    try {
      const { providerClient, model } = getChatModelClient({
        settings,
        modelId: settings.chatTitleModelId,
        onAutoPromoteTransportMode,
      })

      const defaultTitlePrompt =
        DEFAULT_CHAT_TITLE_PROMPT[
          language as keyof typeof DEFAULT_CHAT_TITLE_PROMPT
        ] ?? DEFAULT_CHAT_TITLE_PROMPT.en
      const customizedPrompt = (
        settings.chatOptions.chatTitlePrompt ?? ''
      ).trim()
      const systemPrompt =
        customizedPrompt.length > 0 ? customizedPrompt : defaultTitlePrompt
      const debugTrace = isLLMDebugCaptureEnabled()
        ? createLLMDebugTrace({
            model,
            requestKind: 'title-generation',
          })
        : null
      if (debugTrace && debug) {
        registerLLMDebugTraceForTurn({
          conversationId: debug.conversationId,
          sourceUserMessageId: debug.sourceUserMessageId,
          traceId: debugTrace.id,
        })
      }

      const startedAt = Date.now()
      let response: Awaited<ReturnType<typeof executeSingleTurn>>
      try {
        response = await executeSingleTurn({
          providerClient,
          model,
          request: {
            model: model.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: titleInput },
            ],
          },
          deliveryMode: 'buffered',
          purpose: 'lightweight',
          reasoningPolicy: 'omit',
          signal: controller.signal,
          debugTraceId: debugTrace?.id,
        })
      } catch (error) {
        updateLLMDebugTrace(debugTrace?.id, {
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          generationState: controller.signal.aborted ? 'aborted' : 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      updateLLMDebugTrace(debugTrace?.id, {
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        generationState: 'completed',
        usage: response.usage,
        hasToolCalls: response.toolCalls.length > 0,
        toolCallNames: response.toolCalls.map((toolCall) => toolCall.name),
      })

      const nextTitle = (response.content || '')
        .trim()
        .replace(/^["']+|["']+$/g, '')
      return nextTitle || null
    } catch (error) {
      lastGenerationError = error
      if (
        retryCount < AUTO_TITLE_MAX_RETRIES &&
        !isRequestErrorNonRetryable(error)
      ) {
        const backoffMs = 300 * (retryCount + 1)
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
        return attemptGenerateTitle(retryCount + 1)
      }
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  const generatedTitle = await attemptGenerateTitle()
  if (!generatedTitle) {
    return {
      ok: false,
      reason: 'llm_generation_failed',
      error: lastGenerationError,
    }
  }
  return { ok: true, title: generatedTitle }
}
