import type { NotificationChannel } from '../../settings/schema/setting.types'

export type NotificationOptionsLike = {
  enabled?: boolean
  channel?: NotificationChannel
  notifyOnApprovalRequired?: boolean
  notifyOnTaskCompleted?: boolean
}

export type NotificationEvent =
  | {
      type: 'approval_required'
      dedupeKey: string
      title: string
      body?: string
    }
  | {
      type: 'task_completed'
      dedupeKey: string
      title: string
      body?: string
    }

type NotificationChannelNotifier = {
  notify: (event: NotificationEvent) => Promise<void>
}

type NotificationServiceOptions = {
  getOptions: () => NotificationOptionsLike
  soundNotifier?: NotificationChannelNotifier
  systemNotifier?: NotificationChannelNotifier
}

const createBrowserSoundNotifier = (): NotificationChannelNotifier => {
  let audioContext: AudioContext | null = null

  const getAudioContext = (): AudioContext | null => {
    if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') {
      return null
    }
    if (!audioContext) {
      audioContext = new window.AudioContext()
    }
    return audioContext
  }

  const playTone = async ({
    frequency,
    durationMs,
    startOffsetMs,
    gainValue,
  }: {
    frequency: number
    durationMs: number
    startOffsetMs: number
    gainValue: number
  }) => {
    const context = getAudioContext()
    if (!context) {
      return
    }

    if (context.state === 'suspended') {
      await context.resume()
    }

    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const startAt = context.currentTime + startOffsetMs / 1000
    const endAt = startAt + durationMs / 1000

    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency, startAt)
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(gainValue, startAt + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt)

    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(startAt)
    oscillator.stop(endAt)
  }

  return {
    notify: async (event) => {
      try {
        if (event.type === 'approval_required') {
          await Promise.all([
            playTone({
              frequency: 880,
              durationMs: 120,
              startOffsetMs: 0,
              gainValue: 0.11,
            }),
            playTone({
              frequency: 1174,
              durationMs: 160,
              startOffsetMs: 140,
              gainValue: 0.095,
            }),
          ])
          return
        }

        await playTone({
          frequency: 740,
          durationMs: 240,
          startOffsetMs: 0,
          gainValue: 0.09,
        })
      } catch {
        // Ignore notification playback failures to avoid affecting chat flow.
      }
    },
  }
}

const createBrowserSystemNotifier = (): NotificationChannelNotifier => {
  return {
    notify: async (event) => {
      try {
        if (typeof Notification === 'undefined') {
          return
        }
        if (Notification.permission !== 'granted') {
          return
        }
        new Notification(event.title, event.body ? { body: event.body } : {})
      } catch {
        // Ignore notification delivery failures to avoid affecting chat flow.
      }
    },
  }
}

export class NotificationService {
  private readonly soundNotifier: NotificationChannelNotifier
  private readonly systemNotifier: NotificationChannelNotifier
  private readonly seenApprovalKeys = new Set<string>()
  private readonly seenTaskCompletionKeys = new Set<string>()

  constructor(options: NotificationServiceOptions) {
    this.getOptions = options.getOptions
    this.soundNotifier = options.soundNotifier ?? createBrowserSoundNotifier()
    this.systemNotifier = options.systemNotifier ?? createBrowserSystemNotifier()
  }

  private readonly getOptions: () => NotificationOptionsLike

  markApprovalKeysAsSeen(keys: Iterable<string>): void {
    for (const key of keys) {
      if (key.trim().length > 0) {
        this.seenApprovalKeys.add(key)
      }
    }
  }

  async notify(event: NotificationEvent): Promise<void> {
    if (!this.shouldNotifyEvent(event.type)) {
      return
    }

    if (this.hasSeenEvent(event)) {
      return
    }
    this.markEventSeen(event)

    const channel = this.getOptions().channel ?? 'sound'
    const notifiers: NotificationChannelNotifier[] = []
    if (channel === 'sound' || channel === 'both') {
      notifiers.push(this.soundNotifier)
    }
    if (channel === 'system' || channel === 'both') {
      notifiers.push(this.systemNotifier)
    }

    await Promise.allSettled(notifiers.map((notifier) => notifier.notify(event)))
  }

  private shouldNotifyEvent(type: NotificationEvent['type']): boolean {
    const options = this.getOptions()
    if (!options.enabled) {
      return false
    }

    if (type === 'approval_required') {
      return options.notifyOnApprovalRequired ?? true
    }

    return options.notifyOnTaskCompleted ?? true
  }

  private hasSeenEvent(event: NotificationEvent): boolean {
    if (event.type === 'approval_required') {
      return this.seenApprovalKeys.has(event.dedupeKey)
    }
    return this.seenTaskCompletionKeys.has(event.dedupeKey)
  }

  private markEventSeen(event: NotificationEvent): void {
    if (event.type === 'approval_required') {
      this.seenApprovalKeys.add(event.dedupeKey)
      return
    }
    this.seenTaskCompletionKeys.add(event.dedupeKey)
  }
}
