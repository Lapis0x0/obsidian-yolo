/**
 * 生成中的 assistant 渲染态是一条瞬时流，不是会话状态。
 *
 * 会话快照保存"已提交的语义状态"：消息边界、工具调用、annotations、
 * compaction、终止态。它每变化一次整棵聊天树就要重新求值一次，因此只应在语义
 * 边界上发布。而 provider 每个 token 带来的 content / reasoning 增量只是同一条
 * 消息的展示态，把它建模成"每 token 一份新的会话快照"必然导致每 token 一次
 * 全树 diff。
 *
 * 这个 store 就是被分离出来的那条流：按 `conversationId + messageId` 索引，由
 * AgentService 单例持有（popout 与主窗口的插件 JS 同一 realm，共享同一个
 * producer；每个窗口只拥有自己的播放器、DOM 与滚动控制器）。
 *
 * 不变量：
 * - 值对象永远整体替换，不原地修改；订阅者拿到的是同一个只读对象。
 * - `revision` 在一条订阅存续期间严格递增，用于区分同一 messageId 上的不同
 *   生成世代（retry / resume）：世代变化意味着内容是重写而非追加，消费者据此
 *   重置播放缓冲。它不是全局世代号——条目在订阅数归零后会被回收，之后同 key
 *   重建会从 1 重新计数。这对订阅者不构成歧义：回收的前提就是当时没有任何
 *   订阅者，任何观察过 revision N 的订阅者都还挂着，它的条目不会被回收。跨
 *   订阅生命周期的比较本来就无意义（中间的值全都错过了，必须重新同步）。
 * - terminal 条目在订阅数归零后才回收：终态值必须能被后挂载的订阅者读到。
 *
 * 生命周期由 AgentService 的发布事务驱动，顺序是「写入最终值 → 发布结构快照
 * → 定格（`markTerminalExcept`）」。因此 `publish` 与 `markTerminal*` 分属两个
 * 阶段，不要把它们重新合并成一次调用。
 */

export type AssistantRenderStreamPhase = 'streaming' | 'terminal'

export type AssistantRenderStreamValue = Readonly<{
  conversationId: string
  messageId: string
  revision: number
  content: string
  reasoning: string
  phase: AssistantRenderStreamPhase
}>

export type AssistantRenderStreamListener = (
  value: AssistantRenderStreamValue,
) => void

/** UI 侧只需要这两个能力；AgentService 结构上满足它。 */
export type AssistantRenderStreamAccess = {
  getAssistantRenderStream(
    conversationId: string,
    messageId: string,
  ): AssistantRenderStreamValue | undefined
  subscribeAssistantRenderStream(
    conversationId: string,
    messageId: string,
    listener: AssistantRenderStreamListener,
  ): () => void
}

type StreamEntry = {
  conversationId: string
  messageId: string
  /** null 表示条目只是订阅锚点：叶子已挂载，但第一个 delta 还没到。 */
  value: AssistantRenderStreamValue | null
  revision: number
  listeners: Set<AssistantRenderStreamListener>
}

const streamKey = (conversationId: string, messageId: string): string =>
  `${conversationId}::${messageId}`

export class AssistantRenderStreamStore implements AssistantRenderStreamAccess {
  private readonly entries = new Map<string, StreamEntry>()

  getAssistantRenderStream(
    conversationId: string,
    messageId: string,
  ): AssistantRenderStreamValue | undefined {
    return (
      this.entries.get(streamKey(conversationId, messageId))?.value ?? undefined
    )
  }

  subscribeAssistantRenderStream(
    conversationId: string,
    messageId: string,
    listener: AssistantRenderStreamListener,
  ): () => void {
    const key = streamKey(conversationId, messageId)
    // 订阅可能早于第一个 delta（结构快照先挂出 shell）。先建立锚点，第一个
    // publish 才产生值，避免"叶子已挂载但没有订阅者"的丢流窗口。
    const entry = this.entries.get(key) ?? {
      conversationId,
      messageId,
      value: null,
      revision: 0,
      listeners: new Set<AssistantRenderStreamListener>(),
    }
    entry.listeners.add(listener)
    this.entries.set(key, entry)

    return () => {
      const current = this.entries.get(key)
      if (!current) {
        return
      }
      current.listeners.delete(listener)
      this.recycleIfSettled(key, current)
    }
  }

  /**
   * 写入一个生成中的展示态。内容与上一次完全相同时不通知订阅者。
   *
   * 对一个已经 terminal 的 key 再次 publish，表示同一 messageId 上开始了新的
   * 生成世代（retry / resume / 续写）：`revision` 递增，消费者据此判定重写。
   */
  publish({
    conversationId,
    messageId,
    content,
    reasoning,
  }: {
    conversationId: string
    messageId: string
    content: string
    reasoning: string
  }): void {
    const key = streamKey(conversationId, messageId)
    const entry = this.entries.get(key) ?? {
      conversationId,
      messageId,
      value: null,
      revision: 0,
      listeners: new Set<AssistantRenderStreamListener>(),
    }
    this.entries.set(key, entry)

    const previous = entry.value
    const startsNewGeneration =
      previous === null || previous.phase === 'terminal'
    if (
      !startsNewGeneration &&
      previous.content === content &&
      previous.reasoning === reasoning
    ) {
      return
    }

    if (startsNewGeneration) {
      entry.revision += 1
    }
    entry.value = {
      conversationId,
      messageId,
      revision: entry.revision,
      content,
      reasoning,
      phase: 'streaming',
    }
    this.notify(entry)
  }

  /**
   * 该 key 上是否有一条还没定格的流：已经产生过值，且仍处于 streaming。
   *
   * 生产者据此判断「这条已经收尾的消息还欠一次最终值写入」，同时避免为历史
   * 消息或已回收的世代凭空拉起一条新流（那会让叶子把静态消息当成生成中）。
   */
  hasUnsettledStream(conversationId: string, messageId: string): boolean {
    const value = this.entries.get(streamKey(conversationId, messageId))?.value
    return value !== null && value !== undefined && value.phase === 'streaming'
  }

  /** 该消息不再流动：值定格为最后一次 publish 的内容。 */
  markTerminal(conversationId: string, messageId: string): void {
    const key = streamKey(conversationId, messageId)
    const entry = this.entries.get(key)
    if (!entry) {
      return
    }
    this.settle(key, entry)
  }

  /**
   * 把该会话中不在 `streamingMessageIds` 里的条目全部标记为 terminal。
   * 中断、完成、error、消息被替换/删除、分支切换都走这一条路径，避免在各个
   * 生命周期分支里散落调用。
   */
  markTerminalExcept(
    conversationId: string,
    streamingMessageIds: ReadonlySet<string>,
  ): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.conversationId !== conversationId) {
        continue
      }
      if (streamingMessageIds.has(entry.messageId)) {
        continue
      }
      this.settle(key, entry)
    }
  }

  /** 会话被丢弃：无论是否还有订阅者都清空，订阅者会随视图一起卸载。 */
  dropConversation(conversationId: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.conversationId === conversationId) {
        this.entries.delete(key)
      }
    }
  }

  /** 仅供测试与诊断：当前保留的条目数。 */
  size(): number {
    return this.entries.size
  }

  private settle(key: string, entry: StreamEntry): void {
    if (entry.value && entry.value.phase === 'streaming') {
      entry.value = { ...entry.value, phase: 'terminal' }
      this.notify(entry)
    }
    this.recycleIfSettled(key, entry)
  }

  private notify(entry: StreamEntry): void {
    const value = entry.value
    if (!value) {
      return
    }
    for (const listener of [...entry.listeners]) {
      listener(value)
    }
  }

  private recycleIfSettled(key: string, entry: StreamEntry): void {
    if (entry.listeners.size > 0) {
      return
    }
    if (entry.value === null || entry.value.phase === 'terminal') {
      this.entries.delete(key)
    }
  }
}
