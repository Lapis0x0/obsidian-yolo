import type { TAbstractFile } from 'obsidian'

const DEBOUNCE_MS = 100

export class PromptSourceWatcher {
  private revision = 0
  private pendingInternalWrites = new Map<string, number>()
  private listeners = new Set<() => void>()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private watchedPaths = new Set<string>()

  buildVaultHandlers(): {
    create: (file: TAbstractFile) => void
    modify: (file: TAbstractFile) => void
    delete: (file: TAbstractFile) => void
    rename: (file: TAbstractFile, oldPath: string) => void
  } {
    const handle = (path: string | undefined): void => {
      if (!path || !this.isWatchedPath(path)) return
      if ((this.pendingInternalWrites.get(path) ?? 0) > 0) return
      this.markExternalChange()
    }

    return {
      create: (file) => handle(file.path),
      modify: (file) => handle(file.path),
      delete: (file) => handle(file.path),
      rename: (file, oldPath) => {
        handle(oldPath)
        handle(file.path)
      },
    }
  }

  async withInternalWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
    this.markInternalWriteStart(path)
    try {
      return await task()
    } finally {
      await Promise.resolve()
      this.markInternalWriteEnd(path)
    }
  }

  markInternalWriteStart(path: string): void {
    this.pendingInternalWrites.set(
      path,
      (this.pendingInternalWrites.get(path) ?? 0) + 1,
    )
  }

  markInternalWriteEnd(path: string): void {
    const next = (this.pendingInternalWrites.get(path) ?? 0) - 1
    if (next <= 0) {
      this.pendingInternalWrites.delete(path)
    } else {
      this.pendingInternalWrites.set(path, next)
    }
  }

  markExternalChange(): void {
    this.revision += 1
    this.scheduleListenerNotification()
  }

  getRevision(): number {
    return this.revision
  }

  onExternalChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setWatchedPaths(paths: Set<string>): void {
    this.watchedPaths = new Set(paths)
  }

  isWatchedPath(path: string): boolean {
    return this.watchedPaths.has(path)
  }

  private scheduleListenerNotification(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      for (const listener of this.listeners) {
        listener()
      }
    }, DEBOUNCE_MS)
  }
}
