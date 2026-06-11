// 通用实时任务流事件总线。
// producer 按 toolCallId 推 stdout/stderr/status，UI 订阅同一 id 的快照。

/** snapshot 中 stdout/stderr 字段的最大字符数（超出时从前端截断） */
const SNAPSHOT_MAX_CHARS = 1 * 1024 * 1024 // 1MB chars
const SNAPSHOT_TRUNCATION_MARKER = '... [front truncated] ...\n'

export type LiveTaskStatus = 'starting' | 'running' | 'done'

export type LiveTaskStreamEvent =
  | { type: 'stdout'; toolCallId: string; chunk: string; ts: number }
  | { type: 'stderr'; toolCallId: string; chunk: string; ts: number }
  | { type: 'status'; toolCallId: string; status: LiveTaskStatus }

export type LiveTaskStreamSnapshot = {
  stdout: string
  stderr: string
  status: LiveTaskStatus
}

type Subscriber = (event: LiveTaskStreamEvent) => void

function cappedSnapshotString(s: string): string {
  if (s.length <= SNAPSHOT_MAX_CHARS) return s
  return SNAPSHOT_TRUNCATION_MARKER + s.slice(s.length - SNAPSHOT_MAX_CHARS)
}

export class LiveTaskStreamBus {
  private readonly snapshots = new Map<string, LiveTaskStreamSnapshot>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()

  subscribe(toolCallId: string, fn: Subscriber): () => void {
    let subs = this.subscribers.get(toolCallId)
    if (!subs) {
      subs = new Set()
      this.subscribers.set(toolCallId, subs)
    }
    subs.add(fn)
    return () => {
      subs?.delete(fn)
      if (subs?.size === 0) {
        this.subscribers.delete(toolCallId)
      }
    }
  }

  push(event: LiveTaskStreamEvent): void {
    const { toolCallId } = event
    const snap = this.snapshots.get(toolCallId) ?? {
      stdout: '',
      stderr: '',
      status: 'starting' as const,
    }

    if (event.type === 'stdout') {
      this.snapshots.set(toolCallId, {
        ...snap,
        stdout: cappedSnapshotString(snap.stdout + event.chunk),
      })
    } else if (event.type === 'stderr') {
      this.snapshots.set(toolCallId, {
        ...snap,
        stderr: cappedSnapshotString(snap.stderr + event.chunk),
      })
    } else {
      this.snapshots.set(toolCallId, { ...snap, status: event.status })
    }

    const subs = this.subscribers.get(toolCallId)
    if (subs) {
      for (const fn of subs) {
        fn(event)
      }
    }
  }

  getSnapshot(toolCallId: string): LiveTaskStreamSnapshot | null {
    return this.snapshots.get(toolCallId) ?? null
  }

  clearSnapshot(toolCallId: string): void {
    this.snapshots.delete(toolCallId)
    this.subscribers.delete(toolCallId)
  }
}

export const liveTaskStreamBus = new LiveTaskStreamBus()
