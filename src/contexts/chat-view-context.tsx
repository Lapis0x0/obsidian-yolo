import React from 'react'
import type { Component } from '../runtime/react-compat'

export type ChatViewLike = Component

const ChatViewContext = React.createContext<ChatViewLike | undefined>(undefined)

export const ChatViewProvider = ({
  children,
  chatView,
}: {
  children: React.ReactNode
  chatView: ChatViewLike
}) => {
  return (
    <ChatViewContext.Provider value={chatView}>
      {children}
    </ChatViewContext.Provider>
  )
}

export const useChatView = () => {
  const chatView = React.useContext(ChatViewContext)
  if (!chatView) {
    throw new Error('useChatView must be used within a ChatViewProvider')
  }
  return chatView
}
