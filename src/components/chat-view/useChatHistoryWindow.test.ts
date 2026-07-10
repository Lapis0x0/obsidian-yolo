import type { ChatUserMessage } from '../../types/chat'

import {
  type GroupedChatMessage,
  createChatHistoryWindowSelector,
  getNavigationWindowForTurn,
} from './useChatHistoryWindow'

describe('getNavigationWindowForTurn', () => {
  it('keeps real earlier turns when navigating to the latest turn', () => {
    expect(getNavigationWindowForTurn(23, 24)).toEqual({
      startTurnIndex: 14,
      endTurnIndex: 23,
    })
  })

  it('centers the target turn when there is history on both sides', () => {
    expect(getNavigationWindowForTurn(12, 24)).toEqual({
      startTurnIndex: 7,
      endTurnIndex: 16,
    })
  })

  it('clamps the window at the beginning', () => {
    expect(getNavigationWindowForTurn(1, 24)).toEqual({
      startTurnIndex: 0,
      endTurnIndex: 9,
    })
  })
})

describe('createChatHistoryWindowSelector', () => {
  const messages = [
    { id: 'first' } as ChatUserMessage,
    { id: 'second' } as ChatUserMessage,
    { id: 'third' } as ChatUserMessage,
  ] satisfies GroupedChatMessage[]

  it('keeps the window reference stable when messages and bounds are unchanged', () => {
    const selectWindow = createChatHistoryWindowSelector()
    const firstResult = selectWindow(messages, 1, 2)

    expect(selectWindow(messages, 1, 2)).toBe(firstResult)
  })

  it('returns a new window when messages or bounds change', () => {
    const selectWindow = createChatHistoryWindowSelector()
    const firstResult = selectWindow(messages, 1, 2)

    expect(selectWindow(messages, 0, 2)).not.toBe(firstResult)
    expect(selectWindow([...messages], 0, 2)).not.toBe(firstResult)
  })
})
