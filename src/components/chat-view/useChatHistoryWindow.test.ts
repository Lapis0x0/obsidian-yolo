import type { ChatUserMessage } from '../../types/chat'

import {
  type GroupedChatMessage,
  type HistoryWindowIntent,
  LATEST_WINDOW_INTENT,
  createChatHistoryWindowSelector,
  getEarlierIntent,
  getNavigationStartTurnIndex,
  getNewerIntent,
  getViewportFillIntent,
  resolveWindow,
} from './useChatHistoryWindow'

describe('getNavigationStartTurnIndex', () => {
  it('keeps real earlier turns when navigating to the latest turn', () => {
    expect(getNavigationStartTurnIndex(23, 24)).toBe(18)
  })

  it('centers the target turn when there is history on both sides', () => {
    expect(getNavigationStartTurnIndex(12, 24)).toBe(9)
  })

  it('clamps the window at the beginning', () => {
    expect(getNavigationStartTurnIndex(1, 24)).toBe(0)
  })
})

describe('resolveWindow', () => {
  it('follows the live edge for a latest window', () => {
    expect(resolveWindow(LATEST_WINDOW_INTENT, 24)).toEqual({
      startTurnIndex: 18,
      endTurnIndex: 23,
    })
    expect(resolveWindow(LATEST_WINDOW_INTENT, 25)).toEqual({
      startTurnIndex: 19,
      endTurnIndex: 24,
    })
  })

  it('uses all available turns until the latest window is full', () => {
    expect(resolveWindow(LATEST_WINDOW_INTENT, 4)).toEqual({
      startTurnIndex: 0,
      endTurnIndex: 3,
    })
  })

  it('keeps an expanded latest window at twelve turns as new turns arrive', () => {
    const intent: HistoryWindowIntent = { mode: 'latest', turns: 12 }

    expect(resolveWindow(intent, 24)).toEqual({
      startTurnIndex: 12,
      endTurnIndex: 23,
    })
    expect(resolveWindow(intent, 25)).toEqual({
      startTurnIndex: 13,
      endTurnIndex: 24,
    })
  })

  it('does not move an anchored window when turns are appended', () => {
    const intent: HistoryWindowIntent = {
      mode: 'anchored',
      startTurnIndex: 6,
      turns: 12,
    }

    expect(resolveWindow(intent, 24)).toEqual({
      startTurnIndex: 6,
      endTurnIndex: 17,
    })
    expect(resolveWindow(intent, 25)).toEqual({
      startTurnIndex: 6,
      endTurnIndex: 17,
    })
  })

  it('clamps an anchored window that outlived the turns it pointed at', () => {
    expect(
      resolveWindow({ mode: 'anchored', startTurnIndex: 18, turns: 12 }, 4),
    ).toEqual({ startTurnIndex: 3, endTurnIndex: 3 })
  })

  it('reports an empty window when there are no turns', () => {
    expect(resolveWindow(LATEST_WINDOW_INTENT, 0)).toEqual({
      startTurnIndex: 0,
      endTurnIndex: -1,
    })
  })
})

describe('history window paging', () => {
  it('expands the latest window before detaching it from the live edge', () => {
    const expanded = getEarlierIntent(LATEST_WINDOW_INTENT, 24)

    expect(expanded).toEqual({ mode: 'latest', turns: 12 })
    expect(resolveWindow(expanded, 24)).toEqual({
      startTurnIndex: 12,
      endTurnIndex: 23,
    })
  })

  it('keeps six overlapping turns when paging repeatedly', () => {
    const expanded = getEarlierIntent(LATEST_WINDOW_INTENT, 24)
    const anchored = getEarlierIntent(expanded, 24)

    expect(anchored).toEqual({
      mode: 'anchored',
      startTurnIndex: 6,
      turns: 12,
    })
    expect(resolveWindow(anchored, 24)).toEqual({
      startTurnIndex: 6,
      endTurnIndex: 17,
    })
    expect(resolveWindow(getNewerIntent(anchored, 24), 24)).toEqual({
      startTurnIndex: 12,
      endTurnIndex: 23,
    })
  })

  it('returns to following the live edge once paging reaches it', () => {
    const anchored: HistoryWindowIntent = {
      mode: 'anchored',
      startTurnIndex: 6,
      turns: 12,
    }

    expect(getNewerIntent(anchored, 24)).toEqual({ mode: 'latest', turns: 12 })
  })

  it('stays anchored while newer turns remain out of the window', () => {
    const anchored: HistoryWindowIntent = {
      mode: 'anchored',
      startTurnIndex: 0,
      turns: 12,
    }

    expect(getNewerIntent(anchored, 30)).toEqual({
      mode: 'anchored',
      startTurnIndex: 6,
      turns: 12,
    })
  })

  it('expands a jumped-to window before sliding it in either direction', () => {
    // `jumpToUserMessage` centers a six-turn window, which is exactly the case
    // a slide-only rule breaks: sliding six turns out of a six-turn window
    // leaves nothing in common with what the reader was looking at.
    const jumped: HistoryWindowIntent = {
      mode: 'anchored',
      startTurnIndex: getNavigationStartTurnIndex(12, 24),
      turns: 6,
    }
    expect(resolveWindow(jumped, 24)).toEqual({
      startTurnIndex: 9,
      endTurnIndex: 14,
    })

    // Earlier grows the earlier edge and pins the newer one.
    expect(resolveWindow(getEarlierIntent(jumped, 24), 24)).toEqual({
      startTurnIndex: 3,
      endTurnIndex: 14,
    })
    // Newer grows the newer edge and pins the earlier one.
    expect(resolveWindow(getNewerIntent(jumped, 24), 24)).toEqual({
      startTurnIndex: 9,
      endTurnIndex: 20,
    })
  })

  it('slides by half a window once it has grown to the cap', () => {
    const grown = getEarlierIntent(
      { mode: 'anchored', startTurnIndex: 9, turns: 6 },
      24,
    )

    expect(resolveWindow(getEarlierIntent(grown, 24), 24)).toEqual({
      startTurnIndex: 0,
      endTurnIndex: 11,
    })
  })

  it('keeps the same intent reference when there is nothing more to load', () => {
    const atOldest: HistoryWindowIntent = {
      mode: 'anchored',
      startTurnIndex: 0,
      turns: 12,
    }

    expect(getEarlierIntent(atOldest, 24)).toBe(atOldest)
    expect(getEarlierIntent(LATEST_WINDOW_INTENT, 4)).toBe(LATEST_WINDOW_INTENT)
    expect(getNewerIntent(LATEST_WINDOW_INTENT, 24)).toBe(LATEST_WINDOW_INTENT)
  })
})

describe('adjacent windows always overlap', () => {
  const TOTAL_TURNS = 24

  const expectOverlap = (
    previous: HistoryWindowIntent,
    next: HistoryWindowIntent,
  ) => {
    const before = resolveWindow(previous, TOTAL_TURNS)
    const after = resolveWindow(next, TOTAL_TURNS)

    expect(after.startTurnIndex).toBeLessThanOrEqual(before.endTurnIndex)
    expect(after.endTurnIndex).toBeGreaterThanOrEqual(before.startTurnIndex)
  }

  const everyReachableIntent: HistoryWindowIntent[] = [
    ...[6, 12, 18].map(
      (turns): HistoryWindowIntent => ({ mode: 'latest', turns }),
    ),
    ...Array.from({ length: TOTAL_TURNS }, (_unused, startTurnIndex) =>
      [6, 12].map(
        (turns): HistoryWindowIntent => ({
          mode: 'anchored',
          startTurnIndex,
          turns,
        }),
      ),
    ).flat(),
  ]

  it.each(everyReachableIntent)(
    'holds for both paging directions out of %j',
    (intent) => {
      expectOverlap(intent, getEarlierIntent(intent, TOTAL_TURNS))
      expectOverlap(intent, getNewerIntent(intent, TOTAL_TURNS))
      expectOverlap(intent, getViewportFillIntent(intent, TOTAL_TURNS))
    },
  )

  it('holds along a full walk to the oldest turn and back', () => {
    let intent: HistoryWindowIntent = {
      mode: 'anchored',
      startTurnIndex: getNavigationStartTurnIndex(12, TOTAL_TURNS),
      turns: 6,
    }
    const visited: HistoryWindowIntent[] = [intent]

    for (let step = 0; step < 10; step += 1) {
      const earlier = getEarlierIntent(intent, TOTAL_TURNS)
      expectOverlap(intent, earlier)
      intent = earlier
      visited.push(intent)
    }
    expect(resolveWindow(intent, TOTAL_TURNS).startTurnIndex).toBe(0)

    for (let step = 0; step < 10; step += 1) {
      const newer = getNewerIntent(intent, TOTAL_TURNS)
      expectOverlap(intent, newer)
      intent = newer
      visited.push(intent)
    }
    expect(intent).toEqual({ mode: 'latest', turns: 12 })
    expect(visited.length).toBe(21)
  })
})

describe('getViewportFillIntent', () => {
  it('keeps following the live edge while growing a latest window', () => {
    const grown = getViewportFillIntent(LATEST_WINDOW_INTENT, 24)

    expect(grown).toEqual({ mode: 'latest', turns: 12 })
    expect(resolveWindow(grown, 24)).toEqual({
      startTurnIndex: 12,
      endTurnIndex: 23,
    })
  })

  it('grows past the twelve-turn paging cap rather than sliding the window', () => {
    let intent = getViewportFillIntent(LATEST_WINDOW_INTENT, 24)
    intent = getViewportFillIntent(intent, 24)

    expect(intent).toEqual({ mode: 'latest', turns: 18 })
    expect(resolveWindow(intent, 24)).toEqual({
      startTurnIndex: 6,
      endTurnIndex: 23,
    })
  })

  it('holds an anchored window newer edge in place while growing it', () => {
    const grown = getViewportFillIntent(
      { mode: 'anchored', startTurnIndex: 6, turns: 12 },
      24,
    )

    expect(grown).toEqual({
      mode: 'anchored',
      startTurnIndex: 0,
      turns: 18,
    })
    expect(resolveWindow(grown, 24)).toEqual({
      startTurnIndex: 0,
      endTurnIndex: 17,
    })
  })

  it('stops once the whole conversation is in the window', () => {
    let intent: HistoryWindowIntent = LATEST_WINDOW_INTENT
    for (let step = 0; step < 10; step += 1) {
      intent = getViewportFillIntent(intent, 24)
    }

    expect(resolveWindow(intent, 24)).toEqual({
      startTurnIndex: 0,
      endTurnIndex: 23,
    })
    expect(getViewportFillIntent(intent, 24)).toBe(intent)
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
