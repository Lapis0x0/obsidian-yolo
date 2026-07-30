import { type ReactNode, createContext, useContext, useMemo } from 'react'

import type {
  ChatRuntimeActions,
  ConversationRef,
} from '../../core/cli-runtime'

type ChatRuntimeActionsContextValue = {
  actions: ChatRuntimeActions
  conversation: ConversationRef
  resolveConversationScope: (scopeId: string) => ConversationRef
}

const ChatRuntimeActionsContext =
  createContext<ChatRuntimeActionsContextValue | null>(null)

export function ChatRuntimeActionsProvider({
  actions,
  conversation,
  resolveConversationScope = () => conversation,
  children,
}: Omit<ChatRuntimeActionsContextValue, 'resolveConversationScope'> & {
  resolveConversationScope?: ChatRuntimeActionsContextValue['resolveConversationScope']
  children: ReactNode
}) {
  const value = useMemo(
    () => ({ actions, conversation, resolveConversationScope }),
    [actions, conversation, resolveConversationScope],
  )

  return (
    <ChatRuntimeActionsContext.Provider value={value}>
      {children}
    </ChatRuntimeActionsContext.Provider>
  )
}

export function useChatRuntimeActions(
  scopeId?: string,
): Pick<ChatRuntimeActionsContextValue, 'actions' | 'conversation'> {
  const value = useContext(ChatRuntimeActionsContext)
  const scopedConversation = useMemo(
    () =>
      value && scopeId
        ? value.resolveConversationScope(scopeId)
        : value?.conversation,
    [scopeId, value],
  )
  if (!value || !scopedConversation) {
    throw new Error(
      'Pending chat actions must be rendered inside ChatRuntimeActionsProvider',
    )
  }
  return { actions: value.actions, conversation: scopedConversation }
}
