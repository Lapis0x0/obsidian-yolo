export type BackgroundActivityStatus = 'running' | 'waiting' | 'failed'

export type BackgroundActivityAction =
  | {
      type: 'open-agent-conversation'
      conversationId: string
    }
  | {
      type: 'open-knowledge-settings'
    }

export type BackgroundActivity = {
  id: string
  kind: 'agent' | 'rag-index'
  title: string
  detail?: string
  status: BackgroundActivityStatus
  updatedAt: number
  action?: BackgroundActivityAction
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
