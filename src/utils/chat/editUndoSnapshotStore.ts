type EditUndoSnapshot = {
  toolCallId: string
  path: string
  beforeContent: string
  afterContent: string
  appliedAt: number
}

class EditUndoSnapshotStore {
  private readonly snapshots = new Map<string, EditUndoSnapshot>()

  private buildKey(toolCallId: string, path: string) {
    return `${toolCallId}::${path}`
  }

  set(snapshot: EditUndoSnapshot) {
    this.snapshots.set(
      this.buildKey(snapshot.toolCallId, snapshot.path),
      snapshot,
    )
  }

  get(toolCallId: string, path: string): EditUndoSnapshot | undefined {
    return this.snapshots.get(this.buildKey(toolCallId, path))
  }

  delete(toolCallId: string, path: string) {
    this.snapshots.delete(this.buildKey(toolCallId, path))
  }

  clear() {
    this.snapshots.clear()
  }
}

export const editUndoSnapshotStore = new EditUndoSnapshotStore()

export type { EditUndoSnapshot }
