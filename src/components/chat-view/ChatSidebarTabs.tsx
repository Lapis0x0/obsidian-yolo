import React, { useMemo, useState } from 'react'

import type { ChatLeafPlacement } from '../../features/chat/chatLeafSessionManager'

import Chat, { ChatProps, ChatRef } from './Chat'

type ChatSidebarTabsProps = {
  chatRef: React.RefObject<ChatRef>
  placement: ChatLeafPlacement
  initialChatProps?: ChatProps
  onConversationContextChange?: ChatProps['onConversationContextChange']
  onRuntimeSnapshotChange?: ChatProps['onRuntimeSnapshotChange']
}

const ChatSidebarTabs: React.FC<ChatSidebarTabsProps> = ({
  chatRef,
  placement,
  initialChatProps,
  onConversationContextChange,
  onRuntimeSnapshotChange,
}) => {
  const [activeTab, setActiveTab] = useState<'chat' | 'composer'>('chat')

  // Keep the initial props stable even if parent clears them after render
  const chatProps = useMemo(() => initialChatProps, [initialChatProps])

  return (
    <div className="yolo-sidebar-root">
      <div className="yolo-sidebar-panels">
        <div className="yolo-sidebar-pane is-active" aria-hidden={false}>
          <Chat
            ref={chatRef}
            {...(chatProps ?? {})}
            placement={placement}
            onConversationContextChange={onConversationContextChange}
            onRuntimeSnapshotChange={onRuntimeSnapshotChange}
            activeView={activeTab}
            onChangeView={(view) => setActiveTab(view)}
          />
        </div>
      </div>
    </div>
  )
}

export default ChatSidebarTabs
