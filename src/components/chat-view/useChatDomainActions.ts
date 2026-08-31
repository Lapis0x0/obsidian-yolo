import { EditorView } from '@codemirror/view'
import { useMutation } from '@tanstack/react-query'
import { Notice, TFile, TFolder, normalizePath } from 'obsidian'
import { Dispatch, MutableRefObject, SetStateAction, useCallback } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import { materializeTextEditPlan } from '../../core/edits/textEditEngine'
import { parseTextEditPlan } from '../../core/edits/textEditPlan'
import { captureLLMDebugOperation } from '../../core/llm/debugCapture'
import { readEditReviewSnapshot } from '../../database/json/chat/editReviewSnapshotStore'
import { selectionHighlightController } from '../../features/editor/selection-highlight/selectionHighlightController'
import type { useChatHistory } from '../../hooks/useChatHistory'
import type { useChatManager } from '../../hooks/useJsonManagers'
import type { ApplyViewState } from '../../types/apply-view.types'
import type { Assistant } from '../../types/assistant.types'
import type {
  ChatConversationCompactionState,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type { ReasoningLevel } from '../../types/reasoning'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import {
  type GroupEditSummary,
  deriveToolEditUndoStatus,
  updateToolMessageEditSummary,
} from '../../utils/chat/editSummary'
import { exportChatConversationToVault } from '../../utils/chat/exportConversation'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import {
  findDebugTraceIdForToolCall,
  updateToolCallResponseInMessages,
} from '../../utils/chat/tool-result-index'
import { readTFileContent } from '../../utils/obsidian'

import {
  type ChatMode,
  isAgentChatMode,
  isModuleChatMode,
} from './chat-input/ChatModeSelect'
import { invalidateChatRuntimeNavigation } from './cliChatIntegration'
import { isDelegateSubagentToolName } from './messageNavigatorUtils'
import type { QueryProgressState } from './QueryProgress'
import type { useChatStreamManager } from './useChatStreamManager'
import { serializeActiveBranchByUserMessageId } from './useYoloChatSession'

const ensureDirectoryPathExists = async (
  app: ReturnType<typeof useApp>,
  path: string,
): Promise<void> => {
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

const offsetToSelectionPosition = (content: string, offset: number) => {
  const clampedOffset = Math.max(0, Math.min(offset, content.length))
  const before = content.slice(0, clampedOffset)
  const lines = before.split('\n')

  return {
    line: Math.max(0, lines.length - 1),
    ch: lines.at(-1)?.length ?? 0,
  }
}

const getInlineSelectionRange = (
  originalContent: string,
  operationResults: ReturnType<
    typeof materializeTextEditPlan
  >['operationResults'],
): ApplyViewState['selectionRange'] | undefined => {
  const changedRanges = operationResults
    .map((result) => (result.changed ? result.matchedRange : undefined))
    .filter((range): range is NonNullable<typeof range> => Boolean(range))

  if (changedRanges.length === 0) {
    return undefined
  }

  const start = Math.min(...changedRanges.map((range) => range.start))
  const end = Math.max(...changedRanges.map((range) => range.end))

  return {
    from: offsetToSelectionPosition(originalContent, start),
    to: offsetToSelectionPosition(originalContent, end),
  }
}

const waitForEditorContentSync = async (
  view: EditorView,
  expectedContent: string,
  timeoutMs = 400,
): Promise<boolean> => {
  if (view.state.doc.toString() === expectedContent) {
    return true
  }

  const startedAt = Date.now()

  return await new Promise((resolve) => {
    const check = () => {
      if (!view.dom.isConnected) {
        resolve(false)
        return
      }

      if (view.state.doc.toString() === expectedContent) {
        resolve(true)
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false)
        return
      }

      window.setTimeout(check, 16)
    }

    window.setTimeout(check, 16)
  })
}

const getLatestUserSelectedModelIds = (
  messages: ChatMessage[],
): string[] | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') {
      continue
    }
    return message.selectedModelIds?.length
      ? message.selectedModelIds
      : undefined
  }

  return undefined
}

export type UseChatDomainActionsParams = {
  // Session-owned state (raw, shared with useYoloChatSession)
  chatMessages: ChatMessage[]
  chatMessagesStateRef: MutableRefObject<ChatMessage[]>
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>
  currentConversationId: string
  conversationOverrides: ConversationOverrideSettings | null
  conversationModelId: string
  chatMode: ChatMode
  yoloEnabled: boolean
  effectiveCompactionState: ChatConversationCompactionState
  setCompactionState: Dispatch<SetStateAction<ChatConversationCompactionState>>
  assistantGroupBoundaryMessageIds: string[]
  activeBranchByUserMessageIdRef: MutableRefObject<Map<string, string>>
  messageModelMap: Map<string, string>
  reasoningLevel: ReasoningLevel
  conversationReasoningLevelRef: MutableRefObject<Map<string, ReasoningLevel>>
  selectedAssistant: Assistant | null
  setQueryProgress: Dispatch<SetStateAction<QueryProgressState>>
  setUndoingEditSummaryTarget: Dispatch<SetStateAction<string | null>>
  activeApplyRequestKey: string | null
  setActiveApplyRequestKey: Dispatch<SetStateAction<string | null>>
  applyAbortControllerRef: MutableRefObject<AbortController | null>
  forceScrollToBottom: () => void
  runtimeNavigationGenerationRef: MutableRefObject<number>
  getEditorViewForFile: (file: TFile) => EditorView | null

  // Session-hook outputs
  persistConversationImmediately: (
    messages: ChatMessage[],
    assistantGroupBoundaryIdsOverride?: readonly string[],
  ) => Promise<boolean>
  normalizeAssistantGroupBoundaryMessageIds: (
    messages: ChatMessage[],
    sourceIds: readonly string[],
  ) => string[]
  serializeMessageModelMap: (
    messages: ChatMessage[],
    sourceMap?: Map<string, string>,
  ) => Record<string, string> | undefined

  // Chat history (single instance owned by Chat.tsx)
  createOrUpdateConversation: ReturnType<
    typeof useChatHistory
  >['createOrUpdateConversation']
  generateConversationTitle: ReturnType<
    typeof useChatHistory
  >['generateConversationTitle']

  // Stream manager (single instance owned by Chat.tsx)
  submitChatMutation: ReturnType<
    typeof useChatStreamManager
  >['submitChatMutation']
  abortConversationRun: ReturnType<
    typeof useChatStreamManager
  >['abortConversationRun']

  // Shared, memoized across renders — must stay a single instance (also fed
  // to useChatStreamManager)
  requestContextBuilder: RequestContextBuilder

  // Export
  chatManager: ReturnType<typeof useChatManager>

  // Preference helper owned by Chat.tsx (unmoved)
  normalizeReasoningLevel: (value?: string) => ReasoningLevel | null
}

/**
 * 会话领域动作：消息提交/重试/继续、apply 应用、编辑摘要撤销、待批准工具调用
 * 恢复、手动压缩上下文、工具消息更新、导出对话。全部依赖 useYoloChatSession
 * 的返回值与 useChatStreamManager/useChatHistory 的既有实例，不重造持久化
 * 或运行时编排逻辑。
 */
export function useChatDomainActions({
  chatMessages,
  chatMessagesStateRef,
  setChatMessages,
  currentConversationId,
  conversationOverrides,
  conversationModelId,
  chatMode,
  yoloEnabled,
  effectiveCompactionState,
  setCompactionState,
  assistantGroupBoundaryMessageIds,
  activeBranchByUserMessageIdRef,
  messageModelMap,
  reasoningLevel,
  conversationReasoningLevelRef,
  selectedAssistant,
  setQueryProgress,
  setUndoingEditSummaryTarget,
  activeApplyRequestKey,
  setActiveApplyRequestKey,
  applyAbortControllerRef,
  forceScrollToBottom,
  runtimeNavigationGenerationRef,
  getEditorViewForFile,
  persistConversationImmediately,
  normalizeAssistantGroupBoundaryMessageIds,
  serializeMessageModelMap,
  createOrUpdateConversation,
  generateConversationTitle,
  submitChatMutation,
  abortConversationRun,
  requestContextBuilder,
  chatManager,
  normalizeReasoningLevel,
}: UseChatDomainActionsParams) {
  const app = useApp()
  const plugin = usePlugin()
  const agentService = plugin.getAgentService()
  const { settings } = useSettings()
  const { t } = useLanguage()
  const { getMcpManager } = useMcp()

  const resolveReasoningLevelForMessages = useCallback(
    (messages: ChatMessage[]) => {
      const lastUserMessage = [...messages]
        .reverse()
        .find((message): message is ChatUserMessage => message.role === 'user')
      const storedLevel = normalizeReasoningLevel(
        lastUserMessage?.reasoningLevel,
      )
      return storedLevel ?? reasoningLevel
    },
    [normalizeReasoningLevel, reasoningLevel],
  )

  const handleRecoverPendingToolCall = useCallback(
    async ({
      conversationId,
      toolMessageId,
      request,
      allowForConversation = false,
    }: {
      conversationId: string
      toolMessageId: string
      request: ToolCallRequest
      allowForConversation?: boolean
    }): Promise<boolean> => {
      if (conversationId !== currentConversationId) {
        return false
      }

      const sourceMessages = chatMessagesStateRef.current
      const toolMessageIndex = sourceMessages.findIndex(
        (message) => message.role === 'tool' && message.id === toolMessageId,
      )
      if (toolMessageIndex === -1) {
        return false
      }

      const toolMessage = sourceMessages[toolMessageIndex]
      if (toolMessage.role !== 'tool') {
        return false
      }

      const targetToolCall = toolMessage.toolCalls.find(
        (toolCall) => toolCall.request.id === request.id,
      )
      if (
        !targetToolCall ||
        targetToolCall.response.status !==
          ToolCallResponseStatus.PendingApproval
      ) {
        return false
      }

      const applyMessages = (nextMessages: ChatMessage[]) => {
        setChatMessages(nextMessages)
        chatMessagesStateRef.current = nextMessages
        plugin
          .getAgentService()
          .replaceConversationMessages(
            conversationId,
            nextMessages,
            effectiveCompactionState,
            { persistState: true },
          )
      }

      const runningMessages = updateToolCallResponseInMessages({
        messages: sourceMessages,
        toolMessageId,
        toolCallId: request.id,
        response: { status: ToolCallResponseStatus.Running },
      })
      applyMessages(runningMessages)

      const foregroundToolAbortController = new AbortController()
      let unregisterForegroundToolAborter: (() => void) | null = null
      try {
        const mcpManager = await getMcpManager()
        const args = getToolCallArgumentsObject(request.arguments)
        unregisterForegroundToolAborter = plugin
          .getAgentService()
          .registerForegroundToolAborter({
            conversationId,
            toolCallId: request.id,
            abort: () => {
              foregroundToolAbortController.abort()
              mcpManager.abortToolCall(request.id)
            },
          })

        if (allowForConversation) {
          if (request.metadata?.approvalPolicy === 'always-require-user') {
            // See `AgentService.approveToolCall`'s matching guard: module
            // chat mode tools declared `requiresApproval: true` are an
            // unconditional per-call confirmation gate and must never be
            // added to the conversation's "always allow" list, even from
            // this recovery path.
            console.warn(
              '[YOLO] Ignoring allowForConversation: tool call approval policy is always-require-user',
              {
                conversationId,
                toolCallId: request.id,
                toolName: request.name,
              },
            )
          } else {
            mcpManager.allowToolForConversation(
              request.name,
              conversationId,
              args,
            )
          }
        }

        if (foregroundToolAbortController.signal.aborted) {
          return true
        }

        const result = await captureLLMDebugOperation({
          traceId: findDebugTraceIdForToolCall(runningMessages, request.id),
          transportMode: 'mcp',
          url: `mcp://${request.name}`,
          method: 'callTool',
          requestBody: {
            name: request.name,
            args,
            id: request.id,
            conversationId,
            roundId: toolMessageId,
            chatModelId:
              toolMessage.metadata?.branchModelId ?? conversationModelId,
          },
          responseContentType: 'application/json',
          run: () =>
            mcpManager.callTool({
              name: request.name,
              args,
              id: request.id,
              signal: foregroundToolAbortController.signal,
              conversationId,
              conversationMessages: runningMessages,
              roundId: toolMessageId,
              // Pass the model that produced this tool call (recorded as
              // branchModelId on the tool message when the LLM turn ran), not
              // the current conversation model. The user may have switched
              // models before approving it, so capability-gated resolution must
              // match the schema used when the call was emitted.
              chatModelId:
                toolMessage.metadata?.branchModelId ?? conversationModelId,
              workspaceScope: isAgentChatMode(chatMode)
                ? selectedAssistant?.workspaceScope
                : undefined,
              subagentParentContext: isDelegateSubagentToolName(request.name)
                ? plugin
                    .getAgentService()
                    .getPendingApprovalSubagentParentContext(conversationId)
                : undefined,
              // This recovery path also bypasses `AgentToolGateway` and has
              // no live `bashReadOnly` option to read — use the persisted
              // snapshot fixed at tool-call creation time instead. See
              // `ToolCallRequest.metadata.executionConstraints`.
              bashReadOnly:
                request.metadata?.executionConstraints?.bashReadOnly,
            }),
          getResponseBody: (response) => response,
        })

        if (foregroundToolAbortController.signal.aborted) {
          return true
        }

        const resolvedMessages = updateToolCallResponseInMessages({
          messages: chatMessagesStateRef.current,
          toolMessageId,
          toolCallId: request.id,
          response: result,
        })
        applyMessages(resolvedMessages)
        await persistConversationImmediately(resolvedMessages)

        const latestToolMessage = resolvedMessages.find(
          (message) => message.role === 'tool' && message.id === toolMessageId,
        )
        if (
          toolMessageIndex === resolvedMessages.length - 1 &&
          latestToolMessage?.role === 'tool' &&
          latestToolMessage.toolCalls.every((toolCall) =>
            [
              ToolCallResponseStatus.Success,
              ToolCallResponseStatus.Error,
            ].includes(toolCall.response.status),
          )
        ) {
          submitChatMutation.mutate({
            chatMessages: resolvedMessages,
            conversationId,
            reasoningLevel: resolveReasoningLevelForMessages(resolvedMessages),
            modelIds: getLatestUserSelectedModelIds(resolvedMessages),
          })
        }

        return true
      } catch (error) {
        if (foregroundToolAbortController.signal.aborted) {
          return true
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Tool call failed'
        const failedMessages = updateToolCallResponseInMessages({
          messages: chatMessagesStateRef.current,
          toolMessageId,
          toolCallId: request.id,
          response: {
            status: ToolCallResponseStatus.Error,
            error: errorMessage,
          },
        })
        applyMessages(failedMessages)
        await persistConversationImmediately(failedMessages)
        console.error('[YOLO] Failed to recover pending tool call', {
          conversationId,
          toolCallId: request.id,
          error,
        })
        return true
      } finally {
        unregisterForegroundToolAborter?.()
      }
    },
    [
      currentConversationId,
      effectiveCompactionState,
      getMcpManager,
      persistConversationImmediately,
      plugin,
      resolveReasoningLevelForMessages,
      submitChatMutation,
      chatMessagesStateRef,
      setChatMessages,
      conversationModelId,
      chatMode,
      selectedAssistant,
    ],
  )

  const handleUserMessageSubmit = useCallback(
    async ({
      inputChatMessages,
      requestChatMessages,
      retryBranchTarget,
      persistedMessageModelMap,
    }: {
      inputChatMessages: ChatMessage[]
      requestChatMessages?: ChatMessage[]
      retryBranchTarget?: {
        branchId: string
        sourceUserMessageId: string
        branchModelId?: string
        branchLabel?: string
      }
      persistedMessageModelMap?: Map<string, string>
    }) => {
      invalidateChatRuntimeNavigation(runtimeNavigationGenerationRef)
      abortConversationRun(currentConversationId)
      setQueryProgress({
        type: 'idle',
      })

      const compactionForSubmit = effectiveCompactionState

      // Update the chat history to show the new user message
      setChatMessages(inputChatMessages)
      requestAnimationFrame(() => {
        forceScrollToBottom()
      })

      const effectiveRequestChatMessages =
        requestChatMessages ?? inputChatMessages
      const lastMessage = effectiveRequestChatMessages.at(-1)
      if (lastMessage?.role !== 'user') {
        throw new Error('Last message is not a user message')
      }

      // Compile only the user message that is actually being submitted (new,
      // retried, or edited). Historical prompt bodies are restored by
      // RequestContextBuilder's snapshot path; rebuilding every null persisted
      // prompt here repeatedly re-read old attachments and skills.
      const { promptContent } =
        await requestContextBuilder.compileUserMessagePrompt({
          message: lastMessage,
          onQueryProgressChange: setQueryProgress,
          scope: isModuleChatMode(chatMode)
            ? { moduleChatModeId: chatMode }
            : undefined,
        })
      const compiledRequestMessages = effectiveRequestChatMessages.map(
        (message) =>
          message.role === 'user' && message.id === lastMessage.id
            ? { ...message, promptContent }
            : message,
      )

      const compiledUserMessagesById = new Map(
        compiledRequestMessages
          .filter(
            (message): message is ChatUserMessage => message.role === 'user',
          )
          .map((message) => [message.id, message]),
      )

      const compiledInputMessages = inputChatMessages.map((message) => {
        if (message.role !== 'user') {
          return message
        }

        const compiledUserMessage = compiledUserMessagesById.get(message.id)
        return compiledUserMessage
          ? {
              ...message,
              promptContent: compiledUserMessage.promptContent,
            }
          : message
      })

      const persistedMessages = compiledInputMessages.map((message) => {
        if (message.role !== 'user') {
          return message
        }
        if (!message.promptContent) {
          return message
        }
        return {
          ...message,
          promptContent: null,
        }
      })

      setChatMessages(persistedMessages)
      plugin
        .getAgentService()
        .replaceConversationMessages(
          currentConversationId,
          persistedMessages,
          compactionForSubmit,
        )
      setCompactionState(compactionForSubmit)
      void createOrUpdateConversation(
        currentConversationId,
        compiledInputMessages,
        {
          ...(conversationOverrides ?? {}),
          chatMode,
          agentYoloEnabled: yoloEnabled,
        },
        conversationModelId,
        serializeMessageModelMap(
          compiledInputMessages,
          persistedMessageModelMap ?? messageModelMap,
        ),
        serializeActiveBranchByUserMessageId(
          compiledInputMessages,
          activeBranchByUserMessageIdRef.current,
        ),
        conversationReasoningLevelRef.current.get(currentConversationId) ??
          reasoningLevel,
        compactionForSubmit,
        normalizeAssistantGroupBoundaryMessageIds(
          compiledInputMessages,
          assistantGroupBoundaryMessageIds,
        ),
      )
      void generateConversationTitle(
        currentConversationId,
        compiledInputMessages,
      )
      const requestReasoningLevel = resolveReasoningLevelForMessages(
        compiledRequestMessages,
      )
      const requestModelIds =
        lastMessage.selectedModelIds && lastMessage.selectedModelIds.length > 0
          ? lastMessage.selectedModelIds
          : undefined
      submitChatMutation.mutate({
        chatMessages: compiledInputMessages,
        requestMessages: compiledRequestMessages,
        conversationId: currentConversationId,
        reasoningLevel: requestReasoningLevel,
        modelIds: requestModelIds,
        branchTarget: retryBranchTarget,
        compactionOverride: compactionForSubmit,
      })
    },
    [
      submitChatMutation,
      currentConversationId,
      conversationModelId,
      conversationOverrides,
      requestContextBuilder,
      abortConversationRun,
      activeBranchByUserMessageIdRef,
      forceScrollToBottom,
      assistantGroupBoundaryMessageIds,
      createOrUpdateConversation,
      effectiveCompactionState,
      generateConversationTitle,
      chatMode,
      yoloEnabled,
      messageModelMap,
      normalizeAssistantGroupBoundaryMessageIds,
      reasoningLevel,
      resolveReasoningLevelForMessages,
      serializeMessageModelMap,
      plugin,
      setChatMessages,
      setQueryProgress,
      setCompactionState,
      conversationReasoningLevelRef,
    ],
  )

  const applyMutation = useMutation({
    mutationFn: async ({
      blockToApply,
      targetFilePath,
      abortSignal,
    }: {
      blockToApply: string
      targetFilePath?: string
      abortSignal?: AbortSignal
    }) => {
      if (abortSignal?.aborted) {
        throw new DOMException('Apply aborted', 'AbortError')
      }

      const targetFile = targetFilePath
        ? app.vault.getFileByPath(targetFilePath)
        : app.workspace.getActiveFile()
      if (!targetFile) {
        throw new Error(
          'No file is currently open to apply changes. Please open a file and try again.',
        )
      }
      const targetFileContent = await readTFileContent(targetFile, app.vault)
      const plan = parseTextEditPlan(blockToApply, {
        requireDocumentType: true,
      })

      if (!plan) {
        throw new Error('当前内容不包含可应用的编辑计划。')
      }

      const materialized = materializeTextEditPlan({
        content: targetFileContent,
        plan,
      })

      if (materialized.errors.length > 0) {
        console.warn('[Chat Apply] Some planned edits failed during apply.', {
          filePath: targetFile.path,
          errors: materialized.errors,
        })
      }

      if (materialized.appliedCount === 0) {
        console.error('[Chat Apply] Edit plan did not produce changes.', {
          filePath: targetFile.path,
          operationCount: materialized.totalOperations,
          errors: materialized.errors,
        })
        throw new Error('当前编辑计划未匹配到可修改内容，请重新生成。')
      }

      const selectionRange = getInlineSelectionRange(
        targetFileContent,
        materialized.operationResults,
      )

      if (settings.chatOptions.chatApplyMode === 'direct-apply') {
        await app.vault.modify(targetFile, materialized.newContent)

        if (materialized.errors.length > 0) {
          const partialMessage = t(
            'quickAsk.editPartialSuccess',
            '已应用 {appliedCount}/{totalEdits} 个编辑，详情请查看控制台',
          )
            .replace('{appliedCount}', String(materialized.appliedCount))
            .replace('{totalEdits}', String(materialized.totalOperations))
          new Notice(partialMessage)
        }

        const updatedRanges = materialized.operationResults
          .map((result) => result.newRange)
          .filter((range): range is NonNullable<typeof range> => Boolean(range))
        const editorView = getEditorViewForFile(targetFile)
        if (editorView && updatedRanges.length > 0) {
          const isEditorSynced = await waitForEditorContentSync(
            editorView,
            materialized.newContent,
          )

          if (isEditorSynced) {
            selectionHighlightController.highlightRanges(
              editorView,
              updatedRanges.map((range) => ({
                from: range.start,
                to: range.end,
                visual: 'updated' as const,
              })),
              1050,
            )
          }
        }
        return
      }

      await plugin.openApplyReview({
        file: targetFile,
        originalContent: targetFileContent,
        newContent: materialized.newContent,
        reviewEdits: materialized.reviewEdits,
        reviewMode: selectionRange ? 'selection-focus' : 'full',
        selectionRange,
      } satisfies ApplyViewState)
    },
    onError: (error) => {
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        (error instanceof Error && /abort/i.test(error.message))
      ) {
        return
      }
      if (error instanceof Error) {
        new Notice(error.message)
        console.error('Failed to apply changes', error)
        return
      }
      new Notice('Failed to apply changes')
      console.error('Failed to apply changes', error)
    },
    onSettled: () => {
      applyAbortControllerRef.current = null
      setActiveApplyRequestKey(null)
    },
  })

  const handleApply = useCallback(
    (
      blockToApply: string,
      applyRequestKey: string,
      targetFilePath?: string,
    ) => {
      if (applyMutation.isPending) {
        if (activeApplyRequestKey === applyRequestKey) {
          applyAbortControllerRef.current?.abort()
          applyAbortControllerRef.current = null
          setActiveApplyRequestKey(null)
        }
        return
      }

      const abortController = new AbortController()
      applyAbortControllerRef.current = abortController
      setActiveApplyRequestKey(applyRequestKey)
      applyMutation.mutate({
        blockToApply,
        targetFilePath,
        abortSignal: abortController.signal,
      })
    },
    [
      activeApplyRequestKey,
      applyMutation,
      applyAbortControllerRef,
      setActiveApplyRequestKey,
    ],
  )

  const handleUndoEditSummary = useCallback(
    async (summary: GroupEditSummary) => {
      if (!currentConversationId) {
        return
      }

      const summaryKey = summary.entries
        .map((entry) => entry.toolCallId)
        .join(':')
      const targetKey =
        summary.files.length === 1
          ? `${summaryKey}::${summary.files[0]?.path ?? 'all'}`
          : `${summaryKey}::all`
      setUndoingEditSummaryTarget(targetKey)

      try {
        const undoStateByPath = new Map<string, 'applied' | 'unavailable'>()

        for (const fileGroup of summary.files) {
          const [firstSnapshot, latestSnapshot] = await Promise.all([
            readEditReviewSnapshot({
              app,
              conversationId: currentConversationId,
              roundId: fileGroup.firstRoundId,
              filePath: fileGroup.path,
              settings,
            }),
            readEditReviewSnapshot({
              app,
              conversationId: currentConversationId,
              roundId: fileGroup.latestRoundId,
              filePath: fileGroup.path,
              settings,
            }),
          ])

          if (!firstSnapshot || !latestSnapshot) {
            undoStateByPath.set(fileGroup.path, 'unavailable')
            continue
          }

          const targetFile = app.vault.getAbstractFileByPath(fileGroup.path)
          const currentFile = targetFile instanceof TFile ? targetFile : null

          if (latestSnapshot.afterExists) {
            if (!currentFile) {
              undoStateByPath.set(fileGroup.path, 'unavailable')
              continue
            }

            const currentContent = await app.vault.read(currentFile)
            if (currentContent !== latestSnapshot.afterContent) {
              undoStateByPath.set(fileGroup.path, 'unavailable')
              continue
            }
          } else if (targetFile) {
            undoStateByPath.set(fileGroup.path, 'unavailable')
            continue
          }

          undoStateByPath.set(fileGroup.path, 'applied')

          if (!firstSnapshot.beforeExists) {
            if (currentFile) {
              await app.fileManager.trashFile(currentFile)
            }
            continue
          }

          if (currentFile) {
            const currentContent = await app.vault.read(currentFile)
            if (currentContent !== firstSnapshot.beforeContent) {
              await app.vault.modify(currentFile, firstSnapshot.beforeContent)
            }
            continue
          }

          const parentPath = fileGroup.path.split('/').slice(0, -1).join('/')
          if (parentPath.length > 0) {
            await ensureDirectoryPathExists(app, parentPath)
          }
          await app.vault.create(fileGroup.path, firstSnapshot.beforeContent)
        }

        const appliedCount = summary.files.filter(
          (file) => undoStateByPath.get(file.path) === 'applied',
        ).length
        const unavailableCount = summary.files.length - appliedCount

        const updatedMessages = chatMessages.map((message) => {
          if (message.role !== 'tool') {
            return message
          }

          let nextToolMessage = message
          summary.entries.forEach((entry) => {
            if (entry.toolMessageId !== message.id) {
              return
            }

            const nextFiles = entry.summary.files.map((file) => {
              const nextStatus =
                undoStateByPath.get(file.path) ?? file.undoStatus

              return {
                ...file,
                undoStatus: nextStatus,
              }
            })

            nextToolMessage = updateToolMessageEditSummary({
              toolMessage: nextToolMessage,
              toolCallId: entry.toolCallId,
              editSummary: {
                ...entry.summary,
                files: nextFiles,
                undoStatus: deriveToolEditUndoStatus(nextFiles),
              },
            })
          })

          return nextToolMessage
        })

        setChatMessages(updatedMessages)
        agentService.replaceConversationMessages(
          currentConversationId,
          updatedMessages,
        )
        await persistConversationImmediately(updatedMessages)

        if (appliedCount > 0 && unavailableCount === 0) {
          new Notice(
            t(
              'chat.editSummary.undoSuccess',
              '已撤销本轮 assistant 的文件修改。',
            ),
          )
        } else if (appliedCount > 0) {
          new Notice(
            t(
              'chat.editSummary.undoPartial',
              '部分文件已撤销，另一些文件因后续变更未覆盖。',
            ),
          )
        } else {
          new Notice(
            t(
              'chat.editSummary.undoUnavailable',
              '文件内容已变化，无法安全撤销本轮修改。',
            ),
          )
        }
      } catch (error) {
        new Notice(t('chat.editSummary.undoFailed', '撤销失败，请稍后重试。'))
        console.error('Failed to undo assistant edit summary', error)
      } finally {
        setUndoingEditSummaryTarget(null)
      }
    },
    [
      app,
      agentService,
      chatMessages,
      currentConversationId,
      persistConversationImmediately,
      settings,
      t,
      setChatMessages,
      setUndoingEditSummaryTarget,
    ],
  )

  const handleOpenEditSummaryFile = useCallback(
    async ({
      path,
      firstRoundId,
      latestRoundId,
    }: GroupEditSummary['files'][number]) => {
      const targetEntry = app.vault.getAbstractFileByPath(path)
      const targetFile = targetEntry instanceof TFile ? targetEntry : null

      if (!currentConversationId) {
        if (!targetFile) {
          new Notice(
            t('chat.editSummary.fileMissing', '文件不存在或已被移动。'),
          )
          return
        }
        const leaf = app.workspace.getLeaf(false)
        void leaf.openFile(targetFile)
        return
      }

      const [firstSnapshot, latestSnapshot] = await Promise.all([
        readEditReviewSnapshot({
          app,
          conversationId: currentConversationId,
          roundId: firstRoundId,
          filePath: path,
          settings,
        }),
        readEditReviewSnapshot({
          app,
          conversationId: currentConversationId,
          roundId: latestRoundId,
          filePath: path,
          settings,
        }),
      ])

      if (firstSnapshot && latestSnapshot) {
        if (!latestSnapshot.afterExists) {
          new Notice(
            t(
              'chat.editSummary.fileDeleted',
              '文件已被删除，可使用撤销进行恢复。',
            ),
          )
          return
        }

        if (!targetFile) {
          new Notice(
            t('chat.editSummary.fileMissing', '文件不存在或已被移动。'),
          )
          return
        }

        const currentContent = await app.vault.read(targetFile)
        if (currentContent !== latestSnapshot.afterContent) {
          const leaf = app.workspace.getLeaf(false)
          await leaf.openFile(targetFile)
          new Notice(
            t(
              'chat.editSummary.undoUnavailable',
              '文件内容已变化，无法安全撤销本轮修改。',
            ),
          )
          return
        }

        await plugin.openApplyReview({
          file: targetFile,
          originalContent: firstSnapshot.beforeContent,
          newContent: latestSnapshot.afterContent,
          viewMode: 'applied-review',
          reviewMode: 'full',
        })
        return
      }

      if (!targetFile) {
        new Notice(t('chat.editSummary.fileMissing', '文件不存在或已被移动。'))
        return
      }

      const leaf = app.workspace.getLeaf(false)
      await leaf.openFile(targetFile)
    },
    [app, app.vault, app.workspace, currentConversationId, plugin, settings, t],
  )

  const updateToolMessageInChatHistory = useCallback(
    (
      update:
        | ChatToolMessage
        | ((currentToolMessage: ChatToolMessage) => ChatToolMessage),
      targetToolMessageId?: string,
    ): boolean => {
      const targetId =
        typeof update === 'function' ? targetToolMessageId : update.id
      if (!targetId) {
        return false
      }

      const sourceMessages = chatMessagesStateRef.current
      const toolMessageIndex = sourceMessages.findIndex(
        (message) => message.id === targetId,
      )
      const currentToolMessage = sourceMessages[toolMessageIndex]
      if (toolMessageIndex === -1 || currentToolMessage?.role !== 'tool') {
        return false
      }

      const nextToolMessage =
        typeof update === 'function' ? update(currentToolMessage) : update
      if (nextToolMessage === currentToolMessage) {
        return true
      }

      const updatedMessages = sourceMessages.map((message) =>
        message.id === targetId ? nextToolMessage : message,
      )
      chatMessagesStateRef.current = updatedMessages
      setChatMessages(updatedMessages)
      agentService.replaceConversationMessages(
        currentConversationId,
        updatedMessages,
      )

      const shouldResume =
        toolMessageIndex === sourceMessages.length - 1 &&
        nextToolMessage.toolCalls.every((toolCall) =>
          [
            ToolCallResponseStatus.Success,
            ToolCallResponseStatus.Error,
          ].includes(toolCall.response.status),
        )

      if (shouldResume) {
        submitChatMutation.mutate({
          chatMessages: updatedMessages,
          conversationId: currentConversationId,
          reasoningLevel: resolveReasoningLevelForMessages(updatedMessages),
          modelIds: getLatestUserSelectedModelIds(updatedMessages),
        })
        requestAnimationFrame(() => {
          forceScrollToBottom()
        })
      }

      return true
    },
    [
      agentService,
      currentConversationId,
      forceScrollToBottom,
      resolveReasoningLevelForMessages,
      submitChatMutation,
      chatMessagesStateRef,
      setChatMessages,
    ],
  )

  const handleToolMessageUpdate = useCallback(
    (toolMessage: ChatToolMessage) => {
      // Normal Chat rendering uses handleToolCallResponseUpdate so unchanged
      // sibling tool cards can stay memoized. This remains as the legacy whole
      // message fallback for ToolMessage hosts that still call onMessageUpdate.
      const didFindToolMessage = updateToolMessageInChatHistory(toolMessage)
      if (didFindToolMessage) {
        return
      }

      // The tool message no longer exists in the chat history.
      // This likely means a new message was submitted while this stream was running.
      // Abort the tool calls and keep the current chat history.
      void (async () => {
        const mcpManager = await getMcpManager()
        toolMessage.toolCalls.forEach((toolCall) => {
          mcpManager.abortToolCall(toolCall.request.id)
        })
      })()
    },
    [getMcpManager, updateToolMessageInChatHistory],
  )

  const handleToolCallResponseUpdate = useCallback(
    (toolMessageId: string, toolCallId: string, response: ToolCallResponse) => {
      let shouldAbortMissingToolCall = false
      const didFindToolMessage = updateToolMessageInChatHistory(
        (currentToolMessage) => {
          if (currentToolMessage.id !== toolMessageId) {
            return currentToolMessage
          }
          let didUpdate = false
          let didChange = false
          const nextToolCalls = currentToolMessage.toolCalls.map((toolCall) => {
            if (toolCall.request.id !== toolCallId) {
              return toolCall
            }
            didUpdate = true
            if (toolCall.response === response) {
              return toolCall
            }
            didChange = true
            return { ...toolCall, response }
          })

          if (!didUpdate) {
            shouldAbortMissingToolCall = true
            return currentToolMessage
          }
          if (!didChange) {
            return currentToolMessage
          }

          return { ...currentToolMessage, toolCalls: nextToolCalls }
        },
        toolMessageId,
      )

      if (!didFindToolMessage || shouldAbortMissingToolCall) {
        void (async () => {
          const mcpManager = await getMcpManager()
          mcpManager.abortToolCall(toolCallId)
        })()
      }
    },
    [getMcpManager, updateToolMessageInChatHistory],
  )

  const handleExportChatToVault = useCallback(
    (conversationId: string) => {
      void (async () => {
        try {
          const { path } = await exportChatConversationToVault({
            app,
            chatManager,
            conversationId,
            settings,
          })
          new Notice(
            t('sidebar.chat.exportSuccess', 'Exported chat to {path}').replace(
              '{path}',
              path,
            ),
          )
        } catch (error) {
          console.error('Failed to export conversation', error)
          new Notice(
            t('sidebar.chat.exportError', 'Could not export conversation'),
          )
        }
      })()
    },
    [app, chatManager, settings, t],
  )

  return {
    resolveReasoningLevelForMessages,
    handleRecoverPendingToolCall,
    handleUserMessageSubmit,
    applyMutation,
    handleApply,
    handleUndoEditSummary,
    handleOpenEditSummaryFile,
    handleToolMessageUpdate,
    handleToolCallResponseUpdate,
    handleExportChatToVault,
  }
}
