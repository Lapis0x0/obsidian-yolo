import { useCallback, useMemo, useRef, useState } from 'react'

import type {
  AssistantToolMessageGroup,
  ChatUserMessage,
} from '../../types/chat'

const INITIAL_WINDOW_TURNS = 6
/**
 * How far a full window slides per page. Also the number of turns adjacent to
 * the loaded edge that a slide is guaranteed to keep, which is what lets the
 * timeline pick a scroll anchor that will still exist after the change.
 */
export const PAGE_TURNS = 6
const MAX_WINDOW_TURNS = 12

export type GroupedChatMessage = ChatUserMessage | AssistantToolMessageGroup

type TurnRange = {
  startIndex: number
  endIndex: number
}

export type ChatHistoryWindow = {
  startTurnIndex: number
  endTurnIndex: number
}

/**
 * What the reader asked to look at, stated independently of how many turns
 * currently exist. `latest` follows the live edge, so an appended turn moves
 * the window for free; `anchored` stays put while new turns arrive.
 *
 * `startTurnIndex` names a *position in the turn list*, not the identity of a
 * particular turn. Deleting, editing or branching an earlier turn shifts every
 * later position, and an anchored window deliberately keeps looking at the
 * same slot rather than following whichever turn used to occupy it.
 */
export type HistoryWindowIntent =
  | { mode: 'latest'; turns: number }
  | { mode: 'anchored'; startTurnIndex: number; turns: number }

export const LATEST_WINDOW_INTENT: HistoryWindowIntent = {
  mode: 'latest',
  turns: INITIAL_WINDOW_TURNS,
}

type UserMessageTurnIndex = {
  messageId: string
  turnIndex: number
}

export function createChatHistoryWindowSelector() {
  let previousMessages: GroupedChatMessage[] | null = null
  let previousStartIndex = -1
  let previousEndIndex = -1
  let previousResult: GroupedChatMessage[] = []

  return (
    groupedChatMessages: GroupedChatMessage[],
    startIndex: number,
    endIndex: number,
  ): GroupedChatMessage[] => {
    if (
      previousMessages === groupedChatMessages &&
      previousStartIndex === startIndex &&
      previousEndIndex === endIndex
    ) {
      return previousResult
    }

    previousMessages = groupedChatMessages
    previousStartIndex = startIndex
    previousEndIndex = endIndex
    previousResult =
      startIndex >= 0 && endIndex >= 0
        ? groupedChatMessages.slice(startIndex, endIndex + 1)
        : []
    return previousResult
  }
}

function buildTurnRanges(
  groupedChatMessages: GroupedChatMessage[],
): TurnRange[] {
  if (groupedChatMessages.length === 0) {
    return []
  }

  const ranges: TurnRange[] = []
  let currentStartIndex = 0
  let hasUserTurn = false

  groupedChatMessages.forEach((messageOrGroup, index) => {
    if (Array.isArray(messageOrGroup)) {
      return
    }

    if (hasUserTurn) {
      ranges.push({
        startIndex: currentStartIndex,
        endIndex: index - 1,
      })
    } else if (index > 0) {
      ranges.push({
        startIndex: 0,
        endIndex: index - 1,
      })
    }

    currentStartIndex = index
    hasUserTurn = true
  })

  ranges.push({
    startIndex: hasUserTurn ? currentStartIndex : 0,
    endIndex: groupedChatMessages.length - 1,
  })

  return ranges
}

function buildUserMessageTurnIndices(
  groupedChatMessages: GroupedChatMessage[],
): UserMessageTurnIndex[] {
  const indices: UserMessageTurnIndex[] = []

  groupedChatMessages.forEach((messageOrGroup) => {
    if (Array.isArray(messageOrGroup)) {
      return
    }

    indices.push({
      messageId: messageOrGroup.id,
      turnIndex: indices.length,
    })
  })

  return indices
}

/**
 * The only place an intent becomes concrete turn bounds. Pure in
 * (intent, totalTurns), which is what lets the window be read during render
 * without any "fix up the stale indices" bookkeeping.
 */
export function resolveWindow(
  intent: HistoryWindowIntent,
  totalTurns: number,
): ChatHistoryWindow {
  if (totalTurns === 0) {
    return {
      startTurnIndex: 0,
      endTurnIndex: -1,
    }
  }

  if (intent.mode === 'latest') {
    return {
      startTurnIndex: Math.max(0, totalTurns - intent.turns),
      endTurnIndex: totalTurns - 1,
    }
  }

  const startTurnIndex = Math.min(
    Math.max(intent.startTurnIndex, 0),
    totalTurns - 1,
  )
  return {
    startTurnIndex,
    endTurnIndex: Math.min(totalTurns - 1, startTurnIndex + intent.turns - 1),
  }
}

/**
 * Paging invariant: **adjacent windows always overlap.**
 *
 * `resolveWindow(getEarlierIntent(i, n), n)` and `resolveWindow(getNewerIntent(i, n), n)`
 * always share at least one turn with `resolveWindow(i, n)`. Everything the
 * timeline does across a window change depends on it: the anchor snapshot
 * taken before the change is looked up by id in the new window, and a window
 * with no turn in common cannot contain it — the whole list would unmount and
 * remount at an arbitrary scroll position.
 *
 * Both directions therefore *grow* the window until it reaches
 * `MAX_WINDOW_TURNS` and only then slide it by `PAGE_TURNS`. Growing overlaps
 * trivially (the new window contains the old one); sliding overlaps because
 * `PAGE_TURNS < MAX_WINDOW_TURNS`, leaving six shared turns. A window that
 * starts smaller than the cap — which is what `jumpToUserMessage` produces —
 * is exactly the case a slide-only rule would break, because sliding six turns
 * out of a six-turn window shares nothing.
 */

/**
 * Returns the same intent reference when there is nothing earlier to show, so
 * a redundant call cannot invalidate the rendered window.
 *
 * Growing here moves the earlier edge back and leaves the newer edge exactly
 * where it is.
 */
export function getEarlierIntent(
  intent: HistoryWindowIntent,
  totalTurns: number,
): HistoryWindowIntent {
  const currentStartTurnIndex = resolveWindow(intent, totalTurns).startTurnIndex
  if (totalTurns === 0 || currentStartTurnIndex === 0) {
    return intent
  }

  if (intent.turns < MAX_WINDOW_TURNS) {
    const growth = Math.min(PAGE_TURNS, MAX_WINDOW_TURNS - intent.turns)
    // A `latest` window is pinned to the live edge, so growing its turn count
    // already moves only its earlier edge.
    if (intent.mode === 'latest') {
      return { mode: 'latest', turns: intent.turns + growth }
    }

    // Keeping `startTurnIndex + turns` constant is what pins the newer edge.
    const shift = Math.min(growth, currentStartTurnIndex)
    return {
      mode: 'anchored',
      startTurnIndex: currentStartTurnIndex - shift,
      turns: intent.turns + shift,
    }
  }

  return {
    mode: 'anchored',
    startTurnIndex: Math.max(0, currentStartTurnIndex - PAGE_TURNS),
    turns: intent.turns,
  }
}

/**
 * Returns the same intent reference when the window already follows the live
 * edge, so `loadNewer` at the bottom lets React bail out of the re-render.
 *
 * Growing here moves the newer edge forward and leaves the earlier edge
 * exactly where it is.
 */
export function getNewerIntent(
  intent: HistoryWindowIntent,
  totalTurns: number,
): HistoryWindowIntent {
  if (intent.mode === 'latest') {
    return intent
  }

  const currentStartTurnIndex = resolveWindow(intent, totalTurns).startTurnIndex
  const isGrowing = intent.turns < MAX_WINDOW_TURNS
  const turns = isGrowing
    ? Math.min(MAX_WINDOW_TURNS, intent.turns + PAGE_TURNS)
    : intent.turns
  const nextStartTurnIndex = isGrowing
    ? currentStartTurnIndex
    : currentStartTurnIndex + PAGE_TURNS

  // Touching the live edge means the reader is following new turns again, so
  // the window goes back to expressing that instead of a frozen position. The
  // resulting `latest` window starts no later than the anchored one it
  // replaces, so it still contains every turn they had in common.
  if (nextStartTurnIndex + turns >= totalTurns) {
    return {
      mode: 'latest',
      turns,
    }
  }

  return {
    mode: 'anchored',
    startTurnIndex: nextStartTurnIndex,
    turns,
  }
}

/**
 * Grows the window's earlier edge while leaving its newer edge exactly where
 * it is. This exists only to fill a viewport the window is too short for, so
 * it must never move what the reader is already looking at: unlike
 * `getEarlierIntent` it never converts `latest` into `anchored` and never
 * slides turns off the live edge, so a reader following new turns keeps
 * following them.
 *
 * This deliberately ignores MAX_WINDOW_TURNS. That cap exists to bound how
 * much DOM the timeline holds, and the only caller has already measured that
 * the rendered window is shorter than a single viewport — a DOM provably
 * smaller than one screenful is not what the cap protects against. Enforcing
 * the cap here would instead strand the reader in a window with no scroll
 * range, which neither paging direction can then move.
 *
 * Terminates: every call strictly lowers the window start, and the caller
 * stops as soon as the start reaches 0 (`hasEarlierMessages` turns false).
 */
export function getViewportFillIntent(
  intent: HistoryWindowIntent,
  totalTurns: number,
): HistoryWindowIntent {
  const currentStartTurnIndex = resolveWindow(intent, totalTurns).startTurnIndex
  if (totalTurns === 0 || currentStartTurnIndex === 0) {
    return intent
  }

  const nextStartTurnIndex = Math.max(0, currentStartTurnIndex - PAGE_TURNS)
  const grownTurns = intent.turns + (currentStartTurnIndex - nextStartTurnIndex)
  return intent.mode === 'latest'
    ? { mode: 'latest', turns: grownTurns }
    : {
        mode: 'anchored',
        startTurnIndex: nextStartTurnIndex,
        turns: grownTurns,
      }
}

export function getNavigationStartTurnIndex(
  targetTurnIndex: number,
  totalTurns: number,
): number {
  if (totalTurns === 0) {
    return 0
  }

  const safeTargetTurnIndex = Math.min(
    Math.max(targetTurnIndex, 0),
    totalTurns - 1,
  )
  const maxStartTurnIndex = Math.max(0, totalTurns - INITIAL_WINDOW_TURNS)
  const centeredStartTurnIndex =
    safeTargetTurnIndex - Math.floor(INITIAL_WINDOW_TURNS / 2)
  return Math.max(0, Math.min(centeredStartTurnIndex, maxStartTurnIndex))
}

export function useChatHistoryWindow({
  conversationId,
  groupedChatMessages,
}: {
  conversationId: string
  groupedChatMessages: GroupedChatMessage[]
}) {
  const turnRanges = useMemo(
    () => buildTurnRanges(groupedChatMessages),
    [groupedChatMessages],
  )
  const userMessageTurnIndices = useMemo(
    () => buildUserMessageTurnIndices(groupedChatMessages),
    [groupedChatMessages],
  )
  const totalTurns = turnRanges.length
  const [intent, setIntent] =
    useState<HistoryWindowIntent>(LATEST_WINDOW_INTENT)
  const [windowNavigationKey, setWindowNavigationKey] = useState(0)
  const [windowNavigationTargetMessageId, setWindowNavigationTargetMessageId] =
    useState<string | null>(null)
  const [renderedConversationId, setRenderedConversationId] =
    useState(conversationId)
  const windowSelectorRef = useRef(createChatHistoryWindowSelector())

  // The surfaces do not remount this hook per conversation, so switching
  // conversations is a prop change that has to reset state. Adjusting state
  // during render (React re-renders before committing) keeps that reset pure:
  // unlike an effect it cannot be observed half-applied, and unlike a ref read
  // during render it does not depend on whether an effect has run yet.
  if (renderedConversationId !== conversationId) {
    setRenderedConversationId(conversationId)
    setIntent(LATEST_WINDOW_INTENT)
    setWindowNavigationTargetMessageId(null)
  }

  const loadEarlier = useCallback(() => {
    setIntent((currentIntent) => getEarlierIntent(currentIntent, totalTurns))
  }, [totalTurns])

  const loadNewer = useCallback(() => {
    setIntent((currentIntent) => getNewerIntent(currentIntent, totalTurns))
  }, [totalTurns])

  const growWindowToFillViewport = useCallback(() => {
    setIntent((currentIntent) =>
      getViewportFillIntent(currentIntent, totalTurns),
    )
  }, [totalTurns])

  const resetToLatest = useCallback(() => {
    setIntent(LATEST_WINDOW_INTENT)
    setWindowNavigationTargetMessageId(null)
  }, [])

  const jumpToUserMessage = useCallback(
    (messageId: string) => {
      const target = userMessageTurnIndices.find(
        (entry) => entry.messageId === messageId,
      )
      if (!target) {
        return false
      }

      // Stays anchored even when the target is the newest turn: the caller has
      // already stopped auto-follow, so the reader asked to look at this
      // message, not to resume following the live edge.
      setIntent({
        mode: 'anchored',
        startTurnIndex: getNavigationStartTurnIndex(
          target.turnIndex,
          totalTurns,
        ),
        turns: INITIAL_WINDOW_TURNS,
      })
      setWindowNavigationTargetMessageId(messageId)
      setWindowNavigationKey((currentKey) => currentKey + 1)
      return true
    },
    [totalTurns, userMessageTurnIndices],
  )

  const window = useMemo(
    () => resolveWindow(intent, totalTurns),
    [intent, totalTurns],
  )
  const startRange = turnRanges[window.startTurnIndex]
  const endRange = turnRanges[window.endTurnIndex]
  const startMessageIndex = startRange?.startIndex ?? -1
  const endMessageIndex = endRange?.endIndex ?? -1
  const windowedGroupedChatMessages = windowSelectorRef.current(
    groupedChatMessages,
    startMessageIndex,
    endMessageIndex,
  )

  return {
    windowedGroupedChatMessages,
    /**
     * Identity of the turn range currently rendered. Changes exactly when
     * paging, navigation or a reset moves an edge, and — unlike the timeline
     * items, which are rebuilt for every streaming token, revision and edit —
     * never for anything else. That is what makes it usable as the
     * acknowledgement that a requested page has actually landed.
     *
     * Includes the conversation because this hook is not remounted per
     * conversation (see the reset-during-render above) and neither is the
     * timeline's paging gate, which stays busy until this key moves past the
     * one it paged for. Turn indices alone repeat across conversations, so a
     * switch into a conversation whose initial range equals the range just
     * paged to would satisfy that gate on arrival and refuse every further
     * history load.
     */
    historyWindowKey: `${conversationId}:${window.startTurnIndex}-${window.endTurnIndex}`,
    hasEarlierMessages: window.startTurnIndex > 0,
    hasNewerMessages: totalTurns > 0 && window.endTurnIndex < totalTurns - 1,
    loadEarlier,
    loadNewer,
    growWindowToFillViewport,
    resetToLatest,
    jumpToUserMessage,
    windowNavigationKey,
    windowNavigationTargetMessageId,
  }
}
