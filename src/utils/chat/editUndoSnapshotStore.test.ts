import {
  MAX_EDIT_UNDO_SNAPSHOT_TOTAL_CHARS,
  editUndoSnapshotStore,
} from './editUndoSnapshotStore'

const setSnapshot = ({
  toolCallId,
  path,
  conversationId,
  chars = 1,
}: {
  toolCallId: string
  path: string
  conversationId?: string
  chars?: number
}) => {
  editUndoSnapshotStore.set({
    conversationId,
    toolCallId,
    path,
    beforeContent: 'b'.repeat(chars),
    afterContent: 'a'.repeat(chars),
    beforeExists: true,
    afterExists: true,
    appliedAt: Date.now(),
  })
}

describe('editUndoSnapshotStore', () => {
  beforeEach(() => {
    editUndoSnapshotStore.clear()
  })

  it('evicts the oldest snapshots once the total content exceeds the cap', () => {
    // 三份各占上限一半：写到第三份时前两份合计已经超上限，最旧的那份出局。
    const half = MAX_EDIT_UNDO_SNAPSHOT_TOTAL_CHARS / 4

    setSnapshot({ toolCallId: 'call-1', path: 'a.md', chars: half })
    setSnapshot({ toolCallId: 'call-2', path: 'b.md', chars: half })
    expect(editUndoSnapshotStore.get('call-1', 'a.md')).toBeDefined()

    setSnapshot({ toolCallId: 'call-3', path: 'c.md', chars: half })

    expect(editUndoSnapshotStore.get('call-1', 'a.md')).toBeUndefined()
    expect(editUndoSnapshotStore.get('call-2', 'b.md')).toBeDefined()
    expect(editUndoSnapshotStore.get('call-3', 'c.md')).toBeDefined()
  })

  it('keeps the newest snapshot even when it alone exceeds the cap', () => {
    setSnapshot({ toolCallId: 'call-1', path: 'a.md', chars: 10 })
    setSnapshot({
      toolCallId: 'call-2',
      path: 'huge.md',
      chars: MAX_EDIT_UNDO_SNAPSHOT_TOTAL_CHARS,
    })

    expect(editUndoSnapshotStore.get('call-1', 'a.md')).toBeUndefined()
    expect(editUndoSnapshotStore.get('call-2', 'huge.md')).toBeDefined()
  })

  it('replacing a snapshot does not double-count it against the cap', () => {
    const half = MAX_EDIT_UNDO_SNAPSHOT_TOTAL_CHARS / 4

    setSnapshot({ toolCallId: 'call-1', path: 'a.md', chars: half })
    setSnapshot({ toolCallId: 'call-1', path: 'a.md', chars: half })
    setSnapshot({ toolCallId: 'call-2', path: 'b.md', chars: half })

    expect(editUndoSnapshotStore.get('call-1', 'a.md')).toBeDefined()
    expect(editUndoSnapshotStore.get('call-2', 'b.md')).toBeDefined()
  })

  it('drops only the deleted conversation snapshots', () => {
    setSnapshot({ toolCallId: 'call-1', path: 'a.md', conversationId: 'c1' })
    setSnapshot({ toolCallId: 'call-2', path: 'b.md', conversationId: 'c2' })
    setSnapshot({ toolCallId: 'call-3', path: 'c.md' })

    editUndoSnapshotStore.deleteConversation('c1')

    expect(editUndoSnapshotStore.get('call-1', 'a.md')).toBeUndefined()
    expect(editUndoSnapshotStore.get('call-2', 'b.md')).toBeDefined()
    expect(editUndoSnapshotStore.get('call-3', 'c.md')).toBeDefined()
  })

  it('frees the deleted conversation budget rather than leaking it', () => {
    const half = MAX_EDIT_UNDO_SNAPSHOT_TOTAL_CHARS / 4

    setSnapshot({
      toolCallId: 'call-1',
      path: 'a.md',
      conversationId: 'c1',
      chars: half,
    })
    editUndoSnapshotStore.deleteConversation('c1')

    setSnapshot({ toolCallId: 'call-2', path: 'b.md', chars: half })
    setSnapshot({ toolCallId: 'call-3', path: 'c.md', chars: half })

    // 若删除没有把账扣回去，这两份加起来就会被当成超限，最旧的会被误淘汰。
    expect(editUndoSnapshotStore.get('call-2', 'b.md')).toBeDefined()
    expect(editUndoSnapshotStore.get('call-3', 'c.md')).toBeDefined()
  })
})
