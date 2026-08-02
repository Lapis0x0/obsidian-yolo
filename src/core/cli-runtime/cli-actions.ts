import type { ChatRuntimeActionResult, ChatRuntimeActions } from './actions'
import type { CliRuntime, CliSessionRef, ConversationRef } from './types'

export type CliRuntimeResolver = (
  conversation: CliSessionRef,
) => CliRuntime | undefined

const HANDLED = { kind: 'handled' } as const
const STALE = { kind: 'stale' } as const

const toActionResult = (handled: boolean): ChatRuntimeActionResult =>
  handled ? HANDLED : STALE

const getCliRuntime = (
  conversation: ConversationRef,
  resolveRuntime: CliRuntimeResolver,
): CliRuntime => {
  if (conversation.runtimeId === 'yolo') {
    throw new Error('CLI runtime actions cannot handle YOLO conversations.')
  }
  const runtime = resolveRuntime(conversation)
  if (!runtime || runtime.runtimeId !== conversation.runtimeId) {
    throw new Error(`${conversation.runtimeId} CLI runtime is not available.`)
  }
  return runtime
}

export const createCliChatRuntimeActions = (
  resolveRuntime: CliRuntimeResolver,
): ChatRuntimeActions => ({
  async cancelRun(conversation) {
    await getCliRuntime(conversation, resolveRuntime).cancel()
  },

  async approveTool(action) {
    const handled = await getCliRuntime(
      action.conversation,
      resolveRuntime,
    ).respondApproval({
      requestId: action.toolCallId,
      decision: action.allowForConversation
        ? 'approve_for_session'
        : 'approve_once',
    })
    return toActionResult(handled)
  },

  async rejectTool(action) {
    const handled = await getCliRuntime(
      action.conversation,
      resolveRuntime,
    ).respondApproval({ requestId: action.toolCallId, decision: 'reject' })
    return toActionResult(handled)
  },

  async abortTool(action) {
    await getCliRuntime(action.conversation, resolveRuntime).cancel()
    return HANDLED
  },

  async answerQuestion(action) {
    const handled = await getCliRuntime(
      action.conversation,
      resolveRuntime,
    ).respondQuestion({
      requestId: action.toolCallId,
      answer: action.payload,
    })
    return toActionResult(handled)
  },

  async cancelQuestion(action) {
    const runtime = getCliRuntime(action.conversation, resolveRuntime)
    const handled = await runtime.respondQuestion({
      requestId: action.toolCallId,
      answer: null,
    })
    if (!handled) return STALE
    await runtime.cancel()
    return HANDLED
  },

  async readSubagent(ref) {
    const runtime = getCliRuntime(ref.parentSessionRef, resolveRuntime)
    if (!runtime.readSubagent) return []
    return await runtime.readSubagent(ref)
  },

  async watchSubagent(ref, listener) {
    const runtime = getCliRuntime(ref.parentSessionRef, resolveRuntime)
    if (!runtime.watchSubagent) {
      listener((await runtime.readSubagent?.(ref)) ?? [])
      return () => undefined
    }
    return await runtime.watchSubagent(ref, listener)
  },
})
