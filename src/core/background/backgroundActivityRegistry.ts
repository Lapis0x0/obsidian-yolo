export type BackgroundActivityStatus =
  | 'running'
  | 'waiting'
  | 'failed'
  | 'reminder'

export type BackgroundActivityAction =
  | {
      type: 'open-agent-conversation'
      conversationId: string
    }
  | {
      type: 'open-knowledge-settings'
    }
  | {
      type: 'callback'
      run(): void
    }

export type BackgroundActivity = {
  id: string
  kind: string
  title: string
  detail?: string
  summary?: string
  icon?: string
  status: BackgroundActivityStatus
  updatedAt: number
  action?: BackgroundActivityAction
}

export type BackgroundActivitySink = {
  upsert(activity: BackgroundActivity): void
  remove(id: string): void
}

export type BackgroundActivityBatchSink = BackgroundActivitySink & {
  upsertAll(activities: Iterable<BackgroundActivity>): void
}

export type BackgroundActivitySubscriber = (
  activities: ReadonlyMap<string, BackgroundActivity>,
) => void

export class BackgroundActivityRegistry {
  private readonly activities = new Map<string, BackgroundActivity>()
  private readonly subscribers = new Set<BackgroundActivitySubscriber>()

  subscribe(subscriber: BackgroundActivitySubscriber): () => void {
    this.subscribers.add(subscriber)
    this.notifySubscriber(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  upsert(activity: BackgroundActivity): void {
    this.activities.set(activity.id, activity)
    this.emit()
  }

  upsertAll(activities: Iterable<BackgroundActivity>): void {
    let changed = false
    for (const activity of activities) {
      this.activities.set(activity.id, activity)
      changed = true
    }
    if (changed) this.emit()
  }

  remove(id: string): void {
    if (!this.activities.delete(id)) {
      return
    }
    this.emit()
  }

  clear(): void {
    if (this.activities.size === 0) {
      return
    }
    this.activities.clear()
    this.emit()
  }

  private emit(): void {
    for (const subscriber of this.subscribers) {
      this.notifySubscriber(subscriber)
    }
  }

  private notifySubscriber(subscriber: BackgroundActivitySubscriber): void {
    try {
      subscriber(new Map(this.activities))
    } catch (error) {
      console.error('[YOLO] Background activity subscriber failed', error)
    }
  }
}
