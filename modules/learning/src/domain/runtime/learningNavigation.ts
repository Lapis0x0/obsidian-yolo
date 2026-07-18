export type LearningNavigationTarget =
  | { type: 'home' }
  | {
      type: 'project'
      projectId: string
      tab: '卡片'
      cardMode: '学习' | '浏览'
    }

export type LearningNavigationHandler = (
  target: LearningNavigationTarget,
) => void

export type LearningNavigationPort = {
  setHandler(handler: LearningNavigationHandler | null): void
  queue(target: LearningNavigationTarget): void
  flush(): void
  dispose(): void
}

/** Keeps only the latest target until the view registers a handler. */
export class LearningNavigation implements LearningNavigationPort {
  private handler: LearningNavigationHandler | null = null
  private pending: LearningNavigationTarget | null = null
  private disposed = false

  setHandler(handler: LearningNavigationHandler | null): void {
    if (this.disposed) return
    this.handler = handler
    this.flush()
  }

  queue(target: LearningNavigationTarget): void {
    if (!this.disposed) this.pending = target
  }

  flush(): void {
    if (this.disposed || !this.handler || !this.pending) return
    const target = this.pending
    this.pending = null
    this.handler(target)
  }

  dispose(): void {
    this.disposed = true
    this.handler = null
    this.pending = null
  }
}
