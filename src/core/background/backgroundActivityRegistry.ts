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
      type: 'open-learning-view'
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

export type BackgroundActivitySubscriber = (
  activities: Map<string, BackgroundActivity>,
) => void

export class BackgroundActivityRegistry {
  private readonly activities = new Map<string, BackgroundActivity>()
  private readonly subscribers = new Set<BackgroundActivitySubscriber>()

  subscribe(subscriber: BackgroundActivitySubscriber): () => void {
    this.subscribers.add(subscriber)
    subscriber(new Map(this.activities))
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  upsert(activity: BackgroundActivity): void {
    this.activities.set(activity.id, activity)
    this.emit()
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
    const snapshot = new Map(this.activities)
    for (const subscriber of this.subscribers) {
      subscriber(snapshot)
    }
  }
}
