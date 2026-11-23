import type {
  AssistantToolMessageGroup,
  ChatUserMessage,
} from '../../types/chat'

/**
 * Where a turn stands. Only the latest turn can still be going; every earlier
 * one has settled.
 */
export type TimelineTurnRunState = 'streaming' | 'waiting-approval' | 'settled'

/** A turn of the conversation, shared by every message in it. */
export type TurnFacts = {
  /** The turn's assistant-side messages, in order. */
  messages: AssistantToolMessageGroup
  /** Last message of the turn's last rendered group: where its footer goes. */
  endMessageId: string | undefined
  runState: TimelineTurnRunState
}

/** The turn as one rendered slice of it sees it. */
export type TimelineTurn = {
  /** This slice ends the turn, so it carries the turn's footer. */
  isEnd: boolean
  messages: AssistantToolMessageGroup
  runState: TimelineTurnRunState
}

export const getLatestTurnRunState = (summary: {
  isActive: boolean
  isWaitingApproval: boolean
}): TimelineTurnRunState =>
  summary.isWaitingApproval
    ? 'waiting-approval'
    : summary.isActive
      ? 'streaming'
      : 'settled'

// A group holding nothing but a background result is not rendered: the result
// shows on the tool card it answers.
const isResultOnlyGroup = (group: AssistantToolMessageGroup): boolean =>
  group.length === 1 &&
  (group[0].role === 'subagent_result' ||
    group[0].role === 'terminal_command_result')

const sameMessages = (
  a: AssistantToolMessageGroup,
  b: AssistantToolMessageGroup,
): boolean =>
  a.length === b.length && a.every((message, index) => message === b[index])

/**
 * The turns of a whole conversation, keyed by the id of every assistant-side
 * message in them. Built from all of the conversation, not the rendered
 * window, so the latest turn is always the conversation's latest.
 *
 * A turn runs from a user message that opens one to the next. A message handed
 * to the agent mid-turn (`deliveredMidTurn`) steers the turn under way rather
 * than opening one; a boundary left where a user message was deleted
 * (`turnBoundaryMessageIds`) keeps two turns apart though no user message is
 * left between them.
 *
 * `previous` is the last result: a turn whose content is unchanged keeps its
 * object, so slices of untouched turns keep their props by reference.
 */
export const buildTurnFacts = ({
  groupedChatMessages,
  turnBoundaryMessageIds = [],
  latestTurnRunState,
  previous,
}: {
  groupedChatMessages: readonly (ChatUserMessage | AssistantToolMessageGroup)[]
  turnBoundaryMessageIds?: readonly string[]
  latestTurnRunState: TimelineTurnRunState
  previous?: ReadonlyMap<string, TurnFacts>
}): Map<string, TurnFacts> => {
  const boundaryIds = new Set(turnBoundaryMessageIds)
  const turns: {
    messages: AssistantToolMessageGroup
    endMessageId?: string
  }[] = []
  let current: (typeof turns)[number] | null = null
  const openTurn = () => {
    current = { messages: [] }
    turns.push(current)
    return current
  }

  for (const item of groupedChatMessages) {
    if (!Array.isArray(item)) {
      if (!item.deliveredMidTurn) {
        openTurn()
      }
      continue
    }
    const turn: (typeof turns)[number] =
      current === null || boundaryIds.has(item[0]?.id ?? '')
        ? openTurn()
        : current
    turn.messages.push(...item)
    if (!isResultOnlyGroup(item)) {
      turn.endMessageId = item.at(-1)?.id
    }
  }

  const latestTurn = turns.at(-1)
  const result = new Map<string, TurnFacts>()
  for (const turn of turns) {
    const runState = turn === latestTurn ? latestTurnRunState : 'settled'
    const firstId = turn.messages[0]?.id
    const reused = firstId === undefined ? undefined : previous?.get(firstId)
    const facts: TurnFacts =
      reused &&
      reused.endMessageId === turn.endMessageId &&
      reused.runState === runState &&
      sameMessages(reused.messages, turn.messages)
        ? reused
        : { messages: turn.messages, endMessageId: turn.endMessageId, runState }
    for (const message of turn.messages) {
      result.set(message.id, facts)
    }
  }
  return result
}

/**
 * The turn a rendered slice belongs to. `previous` is this slice's last
 * result, reused while nothing about it changed.
 */
export const getSliceTurn = (
  facts: TurnFacts | undefined,
  sliceMessageIds: readonly string[],
  previous?: TimelineTurn,
): TimelineTurn | undefined => {
  if (!facts) {
    return undefined
  }
  const isEnd =
    facts.endMessageId !== undefined &&
    sliceMessageIds.includes(facts.endMessageId)
  if (
    previous &&
    previous.isEnd === isEnd &&
    previous.messages === facts.messages &&
    previous.runState === facts.runState
  ) {
    return previous
  }
  return { isEnd, messages: facts.messages, runState: facts.runState }
}
