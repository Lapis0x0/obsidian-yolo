import { UseMutationResult, useMutation } from '@tanstack/react-query'
import { Notice } from 'obsidian'
import { useCallback, useMemo, useRef } from 'react'

import { useApp } from '../../contexts/app-context'
import { useMcp } from '../../contexts/mcp-context'
import { useSettings } from '../../contexts/settings-context'
import { NativeAgentRuntime } from '../../core/agent/native-runtime'
import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMBaseUrlNotSetException,
  LLMModelNotFoundException,
} from '../../core/llm/exception'
import { getChatModelClient } from '../../core/llm/manager'
import { ChatMessage } from '../../types/chat'
import { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import { PromptGenerator } from '../../utils/chat/promptGenerator'
import { ResponseGenerator } from '../../utils/chat/responseGenerator'
import { ErrorModal } from '../modals/ErrorModal'

import { ChatMode } from './chat-input/ChatModeSelect'
import { ReasoningLevel } from './chat-input/ReasoningSelect'

type UseChatStreamManagerParams = {
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  autoScrollToBottom: () => void
  promptGenerator: PromptGenerator
  conversationOverrides?: ConversationOverrideSettings
  modelId: string
  chatMode: ChatMode
}

export type UseChatStreamManager = {
  abortActiveStreams: () => void
  submitChatMutation: UseMutationResult<
    void,
    Error,
    {
      chatMessages: ChatMessage[]
      conversationId: string
      reasoningLevel?: ReasoningLevel
    }
  >
}

export function useChatStreamManager({
  setChatMessages,
  autoScrollToBottom,
  promptGenerator,
  conversationOverrides,
  modelId,
  chatMode,
}: UseChatStreamManagerParams): UseChatStreamManager {
  const app = useApp()
  const { settings } = useSettings()
  const { getMcpManager } = useMcp()

  const activeStreamAbortControllersRef = useRef<AbortController[]>([])

  const abortActiveStreams = useCallback(() => {
    for (const abortController of activeStreamAbortControllersRef.current) {
      abortController.abort()
    }
    activeStreamAbortControllersRef.current = []
  }, [])

  const { providerClient, model } = useMemo(() => {
    try {
      return getChatModelClient({
        settings,
        modelId: modelId,
      })
    } catch (error) {
      if (error instanceof LLMModelNotFoundException) {
        if (settings.chatModels.length === 0) {
          throw error
        }
        // Fallback to the first chat model if the selected chat model is not found
        const firstChatModel = settings.chatModels[0]
        // Do NOT write back to global settings here; just use fallback locally
        return getChatModelClient({ settings, modelId: firstChatModel.id })
      }
      throw error
    }
  }, [settings, modelId])

  const submitChatMutation = useMutation({
    mutationFn: async ({
      chatMessages,
      conversationId,
      reasoningLevel,
    }: {
      chatMessages: ChatMessage[]
      conversationId: string
      reasoningLevel?: ReasoningLevel
    }) => {
      const lastMessage = chatMessages.at(-1)
      if (!lastMessage) {
        // chatMessages is empty
        return
      }

      abortActiveStreams()
      const abortController = new AbortController()
      activeStreamAbortControllersRef.current.push(abortController)

      let unsubscribeRunner: (() => void) | undefined

      try {
        const mcpManager = await getMcpManager()
        const onRunnerMessages = (responseMessages: ChatMessage[]) => {
          setChatMessages((prevChatMessages) => {
            const lastMessageIndex = prevChatMessages.findIndex(
              (message) => message.id === lastMessage.id,
            )
            if (lastMessageIndex === -1) {
              // The last message no longer exists in the chat history.
              // This likely means a new message was submitted while this stream was running.
              // Abort this stream and keep the current chat history.
              abortController.abort()
              return prevChatMessages
            }
            return [
              ...prevChatMessages.slice(0, lastMessageIndex + 1),
              ...responseMessages,
            ]
          })
          autoScrollToBottom()
        }

        if (chatMode === 'agent') {
          const agentRuntime = new NativeAgentRuntime({
            enableTools: true,
            maxAutoIterations: Math.max(
              8,
              settings.chatOptions.maxAutoIterations,
            ),
            includeBuiltinTools: true,
          })
          unsubscribeRunner = agentRuntime.subscribe(onRunnerMessages)
          await agentRuntime.run({
            providerClient,
            model,
            messages: chatMessages,
            conversationId,
            promptGenerator,
            mcpManager,
            abortSignal: abortController.signal,
            reasoningLevel,
            requestParams: {
              stream: conversationOverrides?.stream ?? true,
              temperature: conversationOverrides?.temperature ?? undefined,
              top_p: conversationOverrides?.top_p ?? undefined,
            },
            maxContextOverride:
              conversationOverrides?.maxContextMessages ?? undefined,
            geminiTools: {
              useWebSearch: conversationOverrides?.useWebSearch ?? false,
              useUrlContext: conversationOverrides?.useUrlContext ?? false,
            },
          })
        } else {
          const responseGenerator = new ResponseGenerator({
            providerClient,
            model,
            messages: chatMessages,
            conversationId,
            enableTools: settings.chatOptions.enableTools,
            maxAutoIterations: settings.chatOptions.maxAutoIterations,
            includeBuiltinTools: false,
            promptGenerator,
            mcpManager,
            abortSignal: abortController.signal,
            reasoningLevel,
            requestParams: {
              stream: conversationOverrides?.stream ?? true,
              temperature: conversationOverrides?.temperature ?? undefined,
              top_p: conversationOverrides?.top_p ?? undefined,
            },
            maxContextOverride:
              conversationOverrides?.maxContextMessages ?? undefined,
            geminiTools: {
              useWebSearch: conversationOverrides?.useWebSearch ?? false,
              useUrlContext: conversationOverrides?.useUrlContext ?? false,
            },
          })

          unsubscribeRunner = responseGenerator.subscribe(onRunnerMessages)
          await responseGenerator.run()
        }
      } catch (error) {
        // Ignore AbortError
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        throw error
      } finally {
        if (unsubscribeRunner) {
          unsubscribeRunner()
        }
        activeStreamAbortControllersRef.current =
          activeStreamAbortControllersRef.current.filter(
            (controller) => controller !== abortController,
          )
      }
    },
    onError: (error) => {
      if (
        error instanceof LLMAPIKeyNotSetException ||
        error instanceof LLMAPIKeyInvalidException ||
        error instanceof LLMBaseUrlNotSetException
      ) {
        new ErrorModal(app, 'Error', error.message, error.rawError?.message, {
          showSettingsButton: true,
        }).open()
      } else {
        new Notice(error.message)
        console.error('Failed to generate response', error)
      }
    },
  })

  return {
    abortActiveStreams,
    submitChatMutation,
  }
}
