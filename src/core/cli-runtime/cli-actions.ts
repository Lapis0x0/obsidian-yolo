import type { ToolCallResponse } from '../../types/tool-call.types'

import type { ChatRuntimeActionResult, ChatRuntimeActions } from './actions'
import type { CliRuntime, CliSessionRef, ConversationRef } from './types'

/**
 * The runtime plus the one host capability these actions need beyond it:
 * publishing a settled card into the conversation the runtime belongs to.
 * Kept structural so this module stays independent of the controller.
 */
export type CliActionTarget = {
  runtime: CliRuntime
  settleToolCard: (toolCallId: string, response: ToolCallResponse) => void
}

export type CliRuntimeResolver = (
  conversation: CliSessionRef,
) => CliActionTarget | undefined

const HANDLED = { kind: 'handled' } as const
const STALE = { kind: 'stale' } as const

const getCliTarget = (
  conversation: ConversationRef,
  resolveRuntime: CliRuntimeResolver,
): CliActionTarget => {
  if (conversation.runtimeId === 'yolo') {
    throw new Error('CLI runtime actions cannot handle YOLO conversations.')
  }
  const target = resolveRuntime(conversation)
  if (!target || target.runtime.runtimeId !== conversation.runtimeId) {
    throw new Error(`${conversation.runtimeId} CLI runtime is not available.`)
  }
  return target
}

const getCliRuntime = (
  conversation: ConversationRef,
  resolveRuntime: CliRuntimeResolver,
): CliRuntime => getCliTarget(conversation, resolveRuntime).runtime

/**
 * Answering settles the card here, in the host, for every runtime at once —
 * see `CliRuntime.respondApproval` for why this is not the adapter's job.
 */
const settleAnswered = (
  target: CliActionTarget,
  toolCallId: string,
  settled: ToolCallResponse | null,
): ChatRuntimeActionResult => {
  if (!settled) return STALE
  target.settleToolCard(toolCallId, settled)
  return HANDLED
}

export const createCliChatRuntimeActions = (
  resolveRuntime: CliRuntimeResolver,
): ChatRuntimeActions => ({
  async cancelRun(conversation) {
    await getCliRuntime(conversation, resolveRuntime).cancel()
  },

  async approveTool(action) {
    const target = getCliTarget(action.conversation, resolveRuntime)
    const settled = await target.runtime.respondApproval({
      requestId: action.toolCallId,
      decision: action.allowForConversation
        ? 'approve_for_session'
        : 'approve_once',
    })
    return settleAnswered(target, action.toolCallId, settled)
  },

  async rejectTool(action) {
    const target = getCliTarget(action.conversation, resolveRuntime)
    const settled = await target.runtime.respondApproval({
      requestId: action.toolCallId,
      decision: 'reject',
    })
    return settleAnswered(target, action.toolCallId, settled)
  },

  async abortTool(action) {
    await getCliRuntime(action.conversation, resolveRuntime).cancel()
    return HANDLED
  },

  async answerQuestion(action) {
    const target = getCliTarget(action.conversation, resolveRuntime)
    const settled = await target.runtime.respondQuestion({
      requestId: action.toolCallId,
      answer: action.payload,
    })
    return settleAnswered(target, action.toolCallId, settled)
  },

  async cancelQuestion(action) {
    const target = getCliTarget(action.conversation, resolveRuntime)
    const settled = await target.runtime.respondQuestion({
      requestId: action.toolCallId,
      answer: null,
    })
    if (!settled) return STALE
    target.settleToolCard(action.toolCallId, settled)
    await target.runtime.cancel()
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
