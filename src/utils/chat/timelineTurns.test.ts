import type {
  AssistantToolMessageGroup,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'

import { buildTurnFacts, getSliceTurn } from './timelineTurns'

const user = (id: string, deliveredMidTurn = false): ChatUserMessage =>
  ({
    role: 'user',
    id,
    ...(deliveredMidTurn ? { deliveredMidTurn: true } : {}),
  }) as unknown as ChatUserMessage
const assistant = (id: string): AssistantToolMessageGroup[number] =>
  ({ role: 'assistant', id, content: id }) as unknown as ChatMessage &
    AssistantToolMessageGroup[number]
const result = (id: string): AssistantToolMessageGroup[number] =>
  ({ role: 'terminal_command_result', id }) as unknown as ChatMessage &
    AssistantToolMessageGroup[number]

describe('buildTurnFacts', () => {
  it('keeps a message handed over mid-turn inside the turn it steers', () => {
    const facts = buildTurnFacts({
      groupedChatMessages: [
        user('u1'),
        [assistant('a1')],
        user('s1', true),
        [assistant('a2')],
      ],
      latestTurnRunState: 'settled',
    })

    expect(facts.get('a1')).toBe(facts.get('a2'))
    expect(facts.get('a2')?.endMessageId).toBe('a2')
    expect(facts.get('a1')?.messages.map((m) => m.id)).toEqual(['a1', 'a2'])
  })

  it('opens a turn where a deleted user message left a boundary', () => {
    const facts = buildTurnFacts({
      groupedChatMessages: [user('u1'), [assistant('a1')], [assistant('b1')]],
      turnBoundaryMessageIds: ['b1'],
      latestTurnRunState: 'settled',
    })

    expect(facts.get('a1')).not.toBe(facts.get('b1'))
    expect(facts.get('a1')?.endMessageId).toBe('a1')
  })

  it('carries a turn on across a background result and ends it after', () => {
    const facts = buildTurnFacts({
      groupedChatMessages: [
        user('u1'),
        [assistant('a1')],
        [result('r1'), assistant('b1')],
      ],
      latestTurnRunState: 'streaming',
    })

    expect(facts.get('a1')).toBe(facts.get('b1'))
    expect(facts.get('a1')?.endMessageId).toBe('b1')
  })

  it('does not end a turn on a result nothing renders', () => {
    const facts = buildTurnFacts({
      groupedChatMessages: [user('u1'), [assistant('a1')], [result('r1')]],
      latestTurnRunState: 'settled',
    })

    expect(facts.get('a1')?.endMessageId).toBe('a1')
  })

  it('lets only the latest turn be running', () => {
    const facts = buildTurnFacts({
      groupedChatMessages: [
        user('u1'),
        [assistant('a1')],
        user('u2'),
        [assistant('a2')],
      ],
      latestTurnRunState: 'streaming',
    })

    expect(facts.get('a1')?.runState).toBe('settled')
    expect(facts.get('a2')?.runState).toBe('streaming')
  })

  it('settles the previous turn as soon as a new one opens', () => {
    const facts = buildTurnFacts({
      groupedChatMessages: [user('u1'), [assistant('a1')], user('u2')],
      latestTurnRunState: 'streaming',
    })

    expect(facts.get('a1')?.runState).toBe('settled')
  })

  it('keeps an unchanged turn by reference', () => {
    const a1 = assistant('a1')
    const a2 = assistant('a2')
    const first = buildTurnFacts({
      groupedChatMessages: [user('u1'), [a1], user('u2'), [a2]],
      latestTurnRunState: 'streaming',
    })
    const second = buildTurnFacts({
      groupedChatMessages: [
        user('u1'),
        [a1],
        user('u2'),
        [a2, assistant('a3')],
      ],
      latestTurnRunState: 'streaming',
      previous: first,
    })

    expect(second.get('a1')).toBe(first.get('a1'))
    expect(second.get('a2')).not.toBe(first.get('a2'))
  })
})

describe('getSliceTurn', () => {
  const facts = buildTurnFacts({
    groupedChatMessages: [user('u1'), [assistant('a1'), assistant('a2')]],
    latestTurnRunState: 'settled',
  }).get('a1')

  it('ends the turn on the slice holding its last message', () => {
    // A compaction divider cut the group into two slices.
    expect(getSliceTurn(facts, ['a1'])?.isEnd).toBe(false)
    expect(getSliceTurn(facts, ['a2'])?.isEnd).toBe(true)
  })

  it('reuses the slice turn while nothing about it changed', () => {
    const first = getSliceTurn(facts, ['a2'])
    expect(getSliceTurn(facts, ['a2'], first)).toBe(first)
  })
})
