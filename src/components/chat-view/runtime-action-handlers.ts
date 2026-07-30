import type {
  ChatRuntimeActions,
  ChatRuntimeQuestionActionResult,
  ConversationRef,
} from '../../core/cli-runtime'
import type { ChatMessage } from '../../types/chat'

type RuntimeToolActionTarget = {
  actions: ChatRuntimeActions
  conversation: ConversationRef
  toolCallId: string
}

export async function handleRuntimeToolApproval({
  actions,
  conversation,
  toolCallId,
  allowForConversation = false,
  recover,
  onStale,
}: RuntimeToolActionTarget & {
  allowForConversation?: boolean
  recover?: () => Promise<boolean>
  onStale?: () => void
}): Promise<void> {
  const result = await actions.approveTool({
    conversation,
    toolCallId,
    allowForConversation,
  })
  if (result.kind === 'handled') return

  const recovered = (await recover?.()) ?? false
  if (!recovered) onStale?.()
}

export async function handleRuntimeToolRejection({
  actions,
  conversation,
  toolCallId,
  onStale,
}: RuntimeToolActionTarget & { onStale?: () => void }): Promise<void> {
  const result = await actions.rejectTool({ conversation, toolCallId })
  if (result.kind === 'stale') onStale?.()
}

export async function handleRuntimeToolAbort({
  actions,
  conversation,
  toolCallId,
  onStale,
}: RuntimeToolActionTarget & { onStale?: () => void }): Promise<void> {
  const result = await actions.abortTool({ conversation, toolCallId })
  if (result.kind === 'stale') onStale?.()
}

export function handleRuntimeQuestionResult({
  result,
  onRecovery,
  onStale,
}: {
  result: ChatRuntimeQuestionActionResult
  onRecovery: (resolvedMessages: ChatMessage[]) => void
  onStale: () => void
}): void {
  if (result.kind === 'needs_recovery') {
    onRecovery(result.resolvedMessages)
  } else if (result.kind === 'stale') {
    onStale()
  }
}
