// 外部 CLI 流式事件总线
// runner 往里 push，前端 hook 订阅后续事件并通过 getSnapshot 补齐历史

/** snapshot 中 stdout/stderr 字段的最大字符数（超出时从前端截断） */
const SNAPSHOT_MAX_CHARS = 1 * 1024 * 1024 // 1MB chars
const SNAPSHOT_TRUNCATION_MARKER = '... [front truncated] ...\n'

export type ExternalCliStatus = 'starting' | 'running' | 'done'

export type ExternalCliEvent =
  | { type: 'stdout'; toolCallId: string; chunk: string; ts: number }
  | { type: 'stderr'; toolCallId: string; chunk: string; ts: number }
  | { type: 'status'; toolCallId: string; status: ExternalCliStatus }

export type ExternalCliSnapshot = {
  stdout: string
  stderr: string
  status: ExternalCliStatus
}

type Subscriber = (event: ExternalCliEvent) => void

/**
 * 将 snapshot 字符串限制在 SNAPSHOT_MAX_CHARS 以内。
 * 超出时从前端截断并插入 marker，防止 snapshot 无限增长。
 * JS string 已是有效 UTF-16，无需 UTF-8 边界处理。
 */
function cappedSnapshotString(s: string): string {
  if (s.length <= SNAPSHOT_MAX_CHARS) return s
  return SNAPSHOT_TRUNCATION_MARKER + s.slice(s.length - SNAPSHOT_MAX_CHARS)
}

export class ExternalCliStreamBus {
  private readonly snapshots = new Map<string, ExternalCliSnapshot>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()

  /** 订阅指定 toolCallId 的后续事件，返回取消订阅函数 */
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

  /** runner 推送事件；同时更新内存快照 */
  push(event: ExternalCliEvent): void {
    const { toolCallId } = event
    const snap = this.snapshots.get(toolCallId) ?? {
      stdout: '',
      stderr: '',
      status: 'starting' as const,
    }

    if (event.type === 'stdout') {
      const combined = snap.stdout + event.chunk
      this.snapshots.set(toolCallId, {
        ...snap,
        stdout: cappedSnapshotString(combined),
      })
    } else if (event.type === 'stderr') {
      const combined = snap.stderr + event.chunk
      this.snapshots.set(toolCallId, {
        ...snap,
        stderr: cappedSnapshotString(combined),
      })
    } else if (event.type === 'status') {
      this.snapshots.set(toolCallId, { ...snap, status: event.status })
    }

    const subs = this.subscribers.get(toolCallId)
    if (subs) {
      for (const fn of subs) {
        fn(event)
      }
    }
  }

  /**
   * 获取当前快照（供 late subscriber 补齐历史）。
   * 返回 null 表示该 toolCallId 从未注册过（即历史会话，走静态渲染路径）。
   */
  getSnapshot(toolCallId: string): ExternalCliSnapshot | null {
    return this.snapshots.get(toolCallId) ?? null
  }

  /** 进程结束后清理内存快照（可选调用，避免长期占用） */
  clearSnapshot(toolCallId: string): void {
    this.snapshots.delete(toolCallId)
    this.subscribers.delete(toolCallId)
  }
}

// 单例：整个 plugin 生命周期内唯一
export const externalCliStreamBus = new ExternalCliStreamBus()
