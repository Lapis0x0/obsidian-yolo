import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  ChatRuntimeActions,
  ConversationRef,
} from '../../core/cli-runtime'

import {
  ChatRuntimeActionsProvider,
  useChatRuntimeActions,
} from './chat-runtime-actions-context'

const actions: ChatRuntimeActions = {
  cancelRun: async () => {},
  approveTool: async () => ({ kind: 'handled' }),
  rejectTool: async () => ({ kind: 'handled' }),
  abortTool: async () => ({ kind: 'handled' }),
  answerQuestion: async () => ({ kind: 'handled' }),
  cancelQuestion: async () => ({ kind: 'handled' }),
}

describe('ChatRuntimeActionsProvider', () => {
  it('resolves a timeline item action against its owning conversation scope', () => {
    const mainConversation = {
      runtimeId: 'yolo',
      conversationId: 'conversation-main',
    } as const
    const resolveConversationScope = jest.fn(
      (conversationId: string): ConversationRef => ({
        runtimeId: 'yolo',
        conversationId,
      }),
    )
    let capturedConversation: ConversationRef | undefined

    function Probe() {
      capturedConversation = useChatRuntimeActions(
        'conversation-branch',
      ).conversation
      return null
    }

    renderToStaticMarkup(
      <ChatRuntimeActionsProvider
        actions={actions}
        conversation={mainConversation}
        resolveConversationScope={resolveConversationScope}
      >
        <Probe />
      </ChatRuntimeActionsProvider>,
    )

    expect(resolveConversationScope).toHaveBeenCalledWith('conversation-branch')
    expect(capturedConversation).toEqual({
      runtimeId: 'yolo',
      conversationId: 'conversation-branch',
    })
  })

  it('fails fast when a pending action is rendered outside the timeline boundary', () => {
    function Probe() {
      useChatRuntimeActions()
      return null
    }

    expect(() => renderToStaticMarkup(<Probe />)).toThrow(
      'Pending chat actions must be rendered inside ChatRuntimeActionsProvider',
    )
  })
})
