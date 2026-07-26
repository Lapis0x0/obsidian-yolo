import { Platform } from 'obsidian'

import { loadDesktopNodeModule } from '../../utils/platform/desktopNodeModule'

type BackgroundThrottlingTarget = {
  getBackgroundThrottling(): boolean
  setBackgroundThrottling(allowed: boolean): void
  isDestroyed?(): boolean
}

type ElectronRemote = {
  getCurrentWebContents(): BackgroundThrottlingTarget
}

type TargetLoader = () => Promise<BackgroundThrottlingTarget | null>

const NOOP_RELEASE = () => {}

const loadDesktopTarget: TargetLoader = async () => {
  if (!Platform.isDesktop) return null

  try {
    const remote =
      await loadDesktopNodeModule<ElectronRemote>('@electron/remote')
    return remote.getCurrentWebContents()
  } catch (error) {
    console.warn(
      '[YOLO] Unable to disable Electron background throttling for active tasks.',
      error,
    )
    return null
  }
}

/**
 * Keeps the renderer event loop active while YOLO owns background work.
 *
 * Each task owns one release callback. The first task temporarily disables
 * Electron's background throttling and the final release restores the host's
 * original value. UI visibility remains a separate concern: hidden views may
 * skip rendering while the underlying task continues to make progress.
 */
export class BackgroundExecutionController {
  private leaseCount = 0
  private target: BackgroundThrottlingTarget | null = null
  private originalAllowed: boolean | null = null
  private activationPromise: Promise<void> | null = null
  private targetUnavailable = false
  private disposed = false

  constructor(private readonly loadTarget: TargetLoader = loadDesktopTarget) {}

  async acquire(): Promise<() => void> {
    if (this.disposed) return NOOP_RELEASE

    this.leaseCount += 1
    await this.ensureActive()

    if (this.disposed) return NOOP_RELEASE

    let released = false
    return () => {
      if (released || this.disposed) return
      released = true
      this.leaseCount = Math.max(0, this.leaseCount - 1)
      if (this.leaseCount === 0) {
        this.restoreOriginalValue()
      }
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.leaseCount = 0
    this.restoreOriginalValue()
  }

  private async ensureActive(): Promise<void> {
    if (this.target || this.targetUnavailable) return
    if (this.activationPromise) {
      await this.activationPromise
      return
    }

    this.activationPromise = (async () => {
      try {
        const target = await this.loadTarget()
        if (!target) {
          this.targetUnavailable = true
          return
        }
        if (this.disposed || this.leaseCount === 0 || target.isDestroyed?.()) {
          return
        }

        this.target = target
        this.originalAllowed = target.getBackgroundThrottling()
        if (this.originalAllowed) {
          target.setBackgroundThrottling(false)
        }
      } catch (error) {
        this.target = null
        this.originalAllowed = null
        console.warn(
          '[YOLO] Unable to activate background execution protection.',
          error,
        )
      }
    })()

    try {
      await this.activationPromise
    } finally {
      this.activationPromise = null
    }
  }

  private restoreOriginalValue(): void {
    const target = this.target
    const originalAllowed = this.originalAllowed
    this.target = null
    this.originalAllowed = null

    if (!target || originalAllowed === null || target.isDestroyed?.()) {
      return
    }

    try {
      if (target.getBackgroundThrottling() !== originalAllowed) {
        target.setBackgroundThrottling(originalAllowed)
      }
    } catch (error) {
      console.warn(
        '[YOLO] Unable to restore Electron background throttling.',
        error,
      )
    }
  }
}

export const backgroundExecutionController = new BackgroundExecutionController()

export const acquireBackgroundExecution = (): Promise<() => void> =>
  backgroundExecutionController.acquire()

export const runWithBackgroundExecution = <T>(
  task: () => Promise<T>,
): Promise<T> => backgroundExecutionController.run(task)
