import type { ChatManager } from '../../database/json/chat/ChatManager'
import type { ChatMessage } from '../../types/chat'
import type {
  ProviderSession,
  ProviderSessionAccessor,
} from '../../types/provider-session.types'

/**
 * Turn identity for providers that keep a native session.
 *
 * A turn is identified by the user message that started it, not by the
 * assistant message it produces — the assistant message id is minted inside
 * the runtime and changes on every retry, while the user message id is stable
 * across regenerating and editing. That stability is the whole point: a
 * regenerated turn keeps its `turnId` and so still finds its parent's anchor,
 * which is what lets the provider fork the native transcript at the right
 * place instead of starting over.
 */
export const resolveTurnIdentity = (
  messages: ChatMessage[],
): { turnId?: string; parentTurnId?: string } => {
  const userMessageIds = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.id)
  return {
    turnId: userMessageIds.at(-1),
    parentTurnId: userMessageIds.at(-2),
  }
}

/**
 * Reads and records a conversation's `ProviderSession`.
 *
 * The read is memoised for the turn: a provider may consult it more than once,
 * and the conversation file will not change underneath a single turn. The
 * write does not block the stream — see `ProviderSessionAccessor.write`.
 */
export const createProviderSessionAccessor = ({
  chatManager,
  conversationId,
  turnId,
  parentTurnId,
}: {
  chatManager: ChatManager
  conversationId: string
  turnId: string
  parentTurnId?: string
}): ProviderSessionAccessor => {
  let cached: ProviderSession | undefined
  let loaded = false

  return {
    turnId,
    parentTurnId,
    async read() {
      if (!loaded) {
        const conversation = await chatManager.findById(conversationId)
        cached = conversation?.providerSession
        loaded = true
      }
      return cached
    },
    write(next) {
      cached = next
      loaded = true
      void chatManager
        .updateChat(
          conversationId,
          { providerSession: next },
          // The pointer is bookkeeping, not content — touching `updatedAt`
          // would reorder the conversation list on every turn boundary.
          { touchUpdatedAt: false },
        )
        .catch((error: unknown) => {
          console.error(
            '[YOLO] Failed to persist the provider session pointer:',
            error,
          )
        })
    },
  }
}
