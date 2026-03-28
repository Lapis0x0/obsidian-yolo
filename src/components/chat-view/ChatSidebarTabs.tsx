import React, { useMemo, useState } from 'react'

import type { ChatLeafPlacement } from '../../features/chat/chatLeafSessionManager'

import Chat, { ChatProps, ChatRef } from './Chat'

type ChatSidebarTabsProps = {
  chatRef: React.RefObject<ChatRef>
  placement: ChatLeafPlacement
  initialChatProps?: ChatProps
  onConversationContextChange?: ChatProps['onConversationContextChange']
}

const ChatSidebarTabs: React.FC<ChatSidebarTabsProps> = ({
  chatRef,
  placement,
  initialChatProps,
  onConversationContextChange,
}) => {
  const [activeTab, setActiveTab] = useState<'chat' | 'composer'>('chat')

  // Keep the initial props stable even if parent clears them after render
  const chatProps = useMemo(() => initialChatProps, [initialChatProps])

  return (
    <div className="smtcmp-sidebar-root">
      <div className="smtcmp-sidebar-panels">
        <div className="smtcmp-sidebar-pane is-active" aria-hidden={false}>
          <Chat
            ref={chatRef}
            {...(chatProps ?? {})}
            placement={placement}
            onConversationContextChange={onConversationContextChange}
            activeView={activeTab}
            onChangeView={(view) => setActiveTab(view)}
          />
        </div>
      </div>
    </div>
  )
}

export default ChatSidebarTabs
