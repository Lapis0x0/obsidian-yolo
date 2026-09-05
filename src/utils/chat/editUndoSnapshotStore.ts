type EditUndoSnapshot = {
  conversationId?: string
  toolCallId: string
  path: string
  beforeContent: string
  afterContent: string
  beforeExists: boolean
  afterExists: boolean
  appliedAt: number
}

/**
 * 单次会话内的编辑快照缓存，供 `collectGroupEditSummary` 在渲染路径上**同步**
 * 重算一组文件的累计增删行数（持久化的 `editSummary` 只记得每次编辑各自的
 * 数字）。撤销与评审本身走的是 IndexedDB 里的评审快照，不依赖这里。
 *
 * 上限按两侧内容的字符数累计。它存的是每次编辑的前后全文，一轮长跑就能攒下
 * 几百份；没有上限时这块内存只会随会话单调增长，而它服务的只是卡片上的
 * `+N/-M`——淘汰后 `collectGroupEditSummary` 自然退回持久化的逐次数字。
 */
const MAX_TOTAL_CONTENT_CHARS = 16 * 1024 * 1024

class EditUndoSnapshotStore {
  /** 插入顺序即淘汰顺序：Map 的迭代顺序就是「最旧的在最前」。 */
  private readonly snapshots = new Map<string, EditUndoSnapshot>()
  private totalContentChars = 0

  private buildKey(toolCallId: string, path: string) {
    return `${toolCallId}::${path}`
  }

  private sizeOf(snapshot: EditUndoSnapshot) {
    return snapshot.beforeContent.length + snapshot.afterContent.length
  }

  set(snapshot: EditUndoSnapshot) {
    const key = this.buildKey(snapshot.toolCallId, snapshot.path)
    const replaced = this.snapshots.get(key)
    if (replaced) {
      this.totalContentChars -= this.sizeOf(replaced)
      this.snapshots.delete(key)
    }
    this.snapshots.set(key, snapshot)
    this.totalContentChars += this.sizeOf(snapshot)
    this.evictUntilWithinLimit()
  }

  get(toolCallId: string, path: string): EditUndoSnapshot | undefined {
    return this.snapshots.get(this.buildKey(toolCallId, path))
  }

  delete(toolCallId: string, path: string) {
    this.deleteKey(this.buildKey(toolCallId, path))
  }

  /** 会话被删除后，它的快照再也没有渲染路径会读到。 */
  deleteConversation(conversationId: string) {
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.conversationId === conversationId) {
        this.deleteKey(key)
      }
    }
  }

  clear() {
    this.snapshots.clear()
    this.totalContentChars = 0
  }

  private deleteKey(key: string) {
    const snapshot = this.snapshots.get(key)
    if (!snapshot) {
      return
    }
    this.totalContentChars -= this.sizeOf(snapshot)
    this.snapshots.delete(key)
  }

  /**
   * 最新写入的那一条永远留下——它对应的正是用户此刻正在看的那次编辑，即便它
   * 自己就超过了上限。
   */
  private evictUntilWithinLimit() {
    while (this.totalContentChars > MAX_TOTAL_CONTENT_CHARS) {
      const oldest = this.snapshots.keys().next()
      if (oldest.done || this.snapshots.size <= 1) {
        return
      }
      this.deleteKey(oldest.value)
    }
  }
}

export const editUndoSnapshotStore = new EditUndoSnapshotStore()

export type { EditUndoSnapshot }
export { MAX_TOTAL_CONTENT_CHARS as MAX_EDIT_UNDO_SNAPSHOT_TOTAL_CHARS }
