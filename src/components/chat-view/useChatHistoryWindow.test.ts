import type { ChatUserMessage } from '../../types/chat'

import {
  type GroupedChatMessage,
  createChatHistoryWindowSelector,
  getEarlierWindow,
  getHistoryWindowForRender,
  getNavigationWindowForTurn,
  getNewerWindow,
  getWindowAfterTurnCountChange,
} from './useChatHistoryWindow'

describe('getNavigationWindowForTurn', () => {
  it('keeps real earlier turns when navigating to the latest turn', () => {
    expect(getNavigationWindowForTurn(23, 24)).toEqual({
      startTurnIndex: 18,
      endTurnIndex: 23,
    })
  })

  it('centers the target turn when there is history on both sides', () => {
    expect(getNavigationWindowForTurn(12, 24)).toEqual({
      startTurnIndex: 9,
      endTurnIndex: 14,
    })
  })

  it('clamps the window at the beginning', () => {
    expect(getNavigationWindowForTurn(1, 24)).toEqual({
      startTurnIndex: 0,
      endTurnIndex: 5,
    })
  })
})

describe('history window movement', () => {
  it('uses all available turns until the initial window is full', () => {
    expect(
      getWindowAfterTurnCountChange(
        { startTurnIndex: 0, endTurnIndex: 2 },
        3,
        4,
      ),
    ).toEqual({ startTurnIndex: 0, endTurnIndex: 3 })
  })

  it('slides a six-turn latest window when a new turn is added', () => {
    expect(
      getWindowAfterTurnCountChange(
        { startTurnIndex: 18, endTurnIndex: 23 },
        24,
        25,
      ),
    ).toEqual({ startTurnIndex: 19, endTurnIndex: 24 })
  })

  it('preserves an expanded latest window without exceeding twelve turns', () => {
    expect(
      getWindowAfterTurnCountChange(
        { startTurnIndex: 12, endTurnIndex: 23 },
        24,
        25,
      ),
    ).toEqual({ startTurnIndex: 13, endTurnIndex: 24 })
  })

  it('does not move a window that is browsing older turns', () => {
    expect(
      getWindowAfterTurnCountChange(
        { startTurnIndex: 6, endTurnIndex: 17 },
        24,
        25,
      ),
    ).toEqual({ startTurnIndex: 6, endTurnIndex: 17 })
  })

  it('keeps six overlapping turns when paging repeatedly', () => {
    const latestWindow = { startTurnIndex: 18, endTurnIndex: 23 }
    const firstEarlierWindow = getEarlierWindow(latestWindow, 24)
    const secondEarlierWindow = getEarlierWindow(firstEarlierWindow, 24)

    expect(firstEarlierWindow).toEqual({
      startTurnIndex: 12,
      endTurnIndex: 23,
    })
    expect(secondEarlierWindow).toEqual({
      startTurnIndex: 6,
      endTurnIndex: 17,
    })
    expect(getNewerWindow(secondEarlierWindow, 24)).toEqual({
      startTurnIndex: 12,
      endTurnIndex: 23,
    })
  })
})

describe('getHistoryWindowForRender', () => {
  it('includes a newly appended turn before the synchronization effect runs', () => {
    expect(
      getHistoryWindowForRender({
        currentWindow: { startTurnIndex: 18, endTurnIndex: 23 },
        conversationId: 'conversation-1',
        previousConversationId: 'conversation-1',
        previousTotalTurns: 24,
        totalTurns: 25,
      }),
    ).toEqual({ startTurnIndex: 19, endTurnIndex: 24 })
  })

  it('keeps the newer-message boundary when browsing older turns', () => {
    expect(
      getHistoryWindowForRender({
        currentWindow: { startTurnIndex: 6, endTurnIndex: 17 },
        conversationId: 'conversation-1',
        previousConversationId: 'conversation-1',
        previousTotalTurns: 24,
        totalTurns: 25,
      }),
    ).toEqual({ startTurnIndex: 6, endTurnIndex: 17 })
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
