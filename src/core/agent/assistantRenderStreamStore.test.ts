import {
  AssistantRenderStreamStore,
  type AssistantRenderStreamValue,
} from './assistantRenderStreamStore'

const CONVERSATION_ID = 'conv-1'
const MESSAGE_ID = 'assistant-1'

const publish = (
  store: AssistantRenderStreamStore,
  content: string,
  reasoning = '',
  messageId = MESSAGE_ID,
) =>
  store.publish({
    conversationId: CONVERSATION_ID,
    messageId,
    content,
    reasoning,
  })

describe('AssistantRenderStreamStore', () => {
  it('每次 publish 都送达订阅者，取消订阅后不再收到', () => {
    const store = new AssistantRenderStreamStore()
    const received: AssistantRenderStreamValue[] = []
    const unsubscribe = store.subscribeAssistantRenderStream(
      CONVERSATION_ID,
      MESSAGE_ID,
      (value) => received.push(value),
    )

    publish(store, 'a')
    publish(store, 'ab')
    unsubscribe()
    publish(store, 'abc')

    expect(received.map((value) => value.content)).toEqual(['a', 'ab'])
    expect(
      store.getAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID)?.content,
    ).toBe('abc')
  })

  it('订阅可以早于第一个 delta，不会丢掉第一段流', () => {
    const store = new AssistantRenderStreamStore()
    const received: string[] = []
    store.subscribeAssistantRenderStream(
      CONVERSATION_ID,
      MESSAGE_ID,
      (value) => {
        received.push(value.content)
      },
    )

    // 挂载时还没有值。
    expect(
      store.getAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID),
    ).toBeUndefined()

    publish(store, 'first')
    expect(received).toEqual(['first'])
  })

  it('内容与思考都没变时不重复通知', () => {
    const store = new AssistantRenderStreamStore()
    const listener = jest.fn()
    store.subscribeAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID, listener)

    publish(store, 'a', 'r')
    publish(store, 'a', 'r')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('多个订阅者拿到同一份值对象', () => {
    const store = new AssistantRenderStreamStore()
    const first: AssistantRenderStreamValue[] = []
    const second: AssistantRenderStreamValue[] = []
    store.subscribeAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID, (value) =>
      first.push(value),
    )
    store.subscribeAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID, (value) =>
      second.push(value),
    )

    publish(store, 'shared')

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]).toBe(second[0])
    expect(first[0]).toBe(
      store.getAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID),
    )
  })

  it('值对象每次整体替换，不原地修改', () => {
    const store = new AssistantRenderStreamStore()
    publish(store, 'a')
    const first = store.getAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID)
    publish(store, 'ab')
    const second = store.getAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID)

    expect(first?.content).toBe('a')
    expect(second?.content).toBe('ab')
    expect(first).not.toBe(second)
  })

  it('同一 messageId 上重跑时用 revision 隔离生成世代', () => {
    const store = new AssistantRenderStreamStore()
    const revisions: number[] = []
    store.subscribeAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID, (value) =>
      revisions.push(value.revision),
    )

    publish(store, 'first run')
    store.markTerminal(CONVERSATION_ID, MESSAGE_ID)

    // retry：同一条消息，新的一轮生成。内容是重写而不是追加。
    publish(store, 'r')
    publish(store, 're')

    expect(revisions).toEqual([1, 1, 2, 2])
    expect(
      store.getAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID),
    ).toMatchObject({ content: 're', revision: 2, phase: 'streaming' })
  })

  it('terminal 条目要等订阅数归零才回收', () => {
    const store = new AssistantRenderStreamStore()
    const phases: string[] = []
    const unsubscribeA = store.subscribeAssistantRenderStream(
      CONVERSATION_ID,
      MESSAGE_ID,
      (value) => phases.push(value.phase),
    )
    const unsubscribeB = store.subscribeAssistantRenderStream(
      CONVERSATION_ID,
      MESSAGE_ID,
      () => undefined,
    )

    publish(store, 'done')
    store.markTerminal(CONVERSATION_ID, MESSAGE_ID)

    expect(phases).toEqual(['streaming', 'terminal'])
    // 还有订阅者：终态值必须留着，后挂载的窗口也要能读到。
    expect(
      store.getAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID),
    ).toMatchObject({ content: 'done', phase: 'terminal' })

    unsubscribeA()
    expect(store.size()).toBe(1)
    unsubscribeB()
    expect(store.size()).toBe(0)
    expect(
      store.getAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID),
    ).toBeUndefined()
  })

  it('hasUnsettledStream 只对"已产生值且未定格"的条目为真', () => {
    const store = new AssistantRenderStreamStore()
    expect(store.hasUnsettledStream(CONVERSATION_ID, MESSAGE_ID)).toBe(false)

    // 只有订阅锚点、还没有值：不能被当成一条活的流，否则生产者会给静态消息
    // 凭空写出一条流。
    const unsubscribe = store.subscribeAssistantRenderStream(
      CONVERSATION_ID,
      MESSAGE_ID,
      () => undefined,
    )
    expect(store.hasUnsettledStream(CONVERSATION_ID, MESSAGE_ID)).toBe(false)

    publish(store, 'a')
    expect(store.hasUnsettledStream(CONVERSATION_ID, MESSAGE_ID)).toBe(true)

    store.markTerminal(CONVERSATION_ID, MESSAGE_ID)
    expect(store.hasUnsettledStream(CONVERSATION_ID, MESSAGE_ID)).toBe(false)

    unsubscribe()
  })

  it('定格前写入的最终值就是 terminal 值', () => {
    const store = new AssistantRenderStreamStore()
    const received: AssistantRenderStreamValue[] = []
    store.subscribeAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID, (value) =>
      received.push(value),
    )

    publish(store, 'abc', 'raw  reasoning\n\n')
    // provider 的最终结果与最后一个 delta 不同：先写值，再定格。
    publish(store, 'abc final', 'normalized reasoning')
    store.markTerminal(CONVERSATION_ID, MESSAGE_ID)

    expect(received.at(-1)).toMatchObject({
      content: 'abc final',
      reasoning: 'normalized reasoning',
      phase: 'terminal',
      // 同一世代内写最终值不会被当成重跑。
      revision: 1,
    })
  })

  it('没有订阅者的 terminal 条目立即回收', () => {
    const store = new AssistantRenderStreamStore()
    publish(store, 'done')
    expect(store.size()).toBe(1)
    store.markTerminal(CONVERSATION_ID, MESSAGE_ID)
    expect(store.size()).toBe(0)
  })

  it('markTerminalExcept 只保留仍在生成的消息', () => {
    const store = new AssistantRenderStreamStore()
    publish(store, 'a', '', 'assistant-a')
    publish(store, 'b', '', 'assistant-b')
    store.publish({
      conversationId: 'conv-other',
      messageId: 'assistant-a',
      content: 'other',
      reasoning: '',
    })

    store.markTerminalExcept(CONVERSATION_ID, new Set(['assistant-b']))

    expect(
      store.getAssistantRenderStream(CONVERSATION_ID, 'assistant-a'),
    ).toBeUndefined()
    expect(
      store.getAssistantRenderStream(CONVERSATION_ID, 'assistant-b'),
    ).toMatchObject({ content: 'b', phase: 'streaming' })
    // 其它会话不受影响。
    expect(
      store.getAssistantRenderStream('conv-other', 'assistant-a'),
    ).toMatchObject({ content: 'other' })
  })

  it('dropConversation 无视订阅者清空该会话的条目', () => {
    const store = new AssistantRenderStreamStore()
    store.subscribeAssistantRenderStream(
      CONVERSATION_ID,
      MESSAGE_ID,
      () => undefined,
    )
    publish(store, 'a')
    store.publish({
      conversationId: 'conv-other',
      messageId: MESSAGE_ID,
      content: 'keep',
      reasoning: '',
    })

    store.dropConversation(CONVERSATION_ID)

    expect(
      store.getAssistantRenderStream(CONVERSATION_ID, MESSAGE_ID),
    ).toBeUndefined()
    expect(
      store.getAssistantRenderStream('conv-other', MESSAGE_ID),
    ).toBeDefined()
  })
})
