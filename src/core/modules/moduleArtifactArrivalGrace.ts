import { type DataAdapter, normalizePath } from 'obsidian'

import { assertModuleId, assertModulePathSegment } from './moduleStore'

export const MODULE_ARTIFACT_ARRIVAL_GRACE_MS = 20_000
export const MODULE_ARTIFACT_ARRIVAL_POLL_MS = 1_000
export const MODULE_ARTIFACT_ARRIVAL_QUIET_MS = 3_000

export type ModuleArtifactArrivalGraceOptions = Readonly<{
  adapter: Pick<DataAdapter, 'list' | 'stat'>
  pluginDir: string
  graceMs?: number
  pollMs?: number
  quietMs?: number
}>

/** Gives synchronized immutable artifacts a bounded, background-only chance to arrive. */
export class ModuleArtifactArrivalGrace {
  private readonly graceMs: number
  private readonly pluginDir: string
  private readonly pollMs: number
  private readonly quietMs: number

  constructor(private readonly options: ModuleArtifactArrivalGraceOptions) {
    if (
      !options ||
      typeof options.adapter?.list !== 'function' ||
      typeof options.adapter?.stat !== 'function' ||
      typeof options.pluginDir !== 'string' ||
      !options.pluginDir.trim()
    ) {
      throw new TypeError('Module artifact arrival grace options are invalid')
    }
    this.pluginDir = normalizePath(options.pluginDir)
    this.graceMs = duration(
      options.graceMs,
      MODULE_ARTIFACT_ARRIVAL_GRACE_MS,
      'grace',
    )
    this.pollMs = duration(
      options.pollMs,
      MODULE_ARTIFACT_ARRIVAL_POLL_MS,
      'poll',
    )
    this.quietMs = duration(
      options.quietMs,
      MODULE_ARTIFACT_ARRIVAL_QUIET_MS,
      'quiet',
    )
    if (this.pollMs <= 0 || this.quietMs > this.graceMs) {
      throw new Error('Module artifact arrival timing is invalid')
    }
  }

  waitForArtifact(
    moduleId: string,
    version: string,
    isReady: () => Promise<boolean>,
    signal: AbortSignal,
  ): Promise<boolean> {
    assertModuleId(moduleId, 'Module id')
    assertModulePathSegment(version, 'Module version')
    if (
      typeof isReady !== 'function' ||
      !signal ||
      typeof signal.addEventListener !== 'function'
    ) {
      throw new TypeError('Module artifact arrival wait input is invalid')
    }
    if (signal.aborted) return Promise.resolve(false)

    const root = normalizePath(
      `${this.pluginDir}/modules/${moduleId}/${version}`,
    )
    return new Promise<boolean>((resolve) => {
      let settled = false
      let inspecting = false
      let inspectAgain = false
      let finalInspectionRequested = false
      let fingerprint: string | undefined
      let lastVerifiedFingerprint: string | undefined
      let stableSince = Date.now()
      let pollTimer: ReturnType<typeof setTimeout> | undefined
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined

      const cleanup = (): void => {
        if (pollTimer !== undefined) clearTimeout(pollTimer)
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
        signal.removeEventListener('abort', onAbort)
      }
      const settle = (ready: boolean): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(ready)
      }
      const verify = async (): Promise<boolean> => {
        try {
          return await isReady()
        } catch {
          // Missing or partially synchronized files are expected during grace.
          return false
        }
      }
      const schedulePoll = (): void => {
        if (settled || pollTimer !== undefined) return
        pollTimer = setTimeout(() => {
          pollTimer = undefined
          void inspect()
        }, this.pollMs)
      }
      const inspect = async (final = false): Promise<void> => {
        if (settled) return
        if (inspecting) {
          inspectAgain = true
          finalInspectionRequested ||= final
          return
        }
        inspecting = true
        let nextFingerprint: string
        try {
          nextFingerprint = await fingerprintVersionTree(
            this.options.adapter,
            root,
          )
        } catch {
          nextFingerprint = 'unreadable'
        }
        const now = Date.now()
        if (nextFingerprint !== fingerprint) {
          fingerprint = nextFingerprint
          stableSince = now
        }
        const shouldVerify =
          final ||
          (nextFingerprint !== 'missing' &&
            now - stableSince >= this.quietMs &&
            lastVerifiedFingerprint !== nextFingerprint)
        let ready = false
        if (shouldVerify) {
          lastVerifiedFingerprint = nextFingerprint
          ready = await verify()
        }
        inspecting = false

        if (settled) return
        if (signal.aborted) {
          settle(false)
          return
        }
        if (ready) {
          settle(true)
          return
        }
        if (inspectAgain) {
          inspectAgain = false
          const nextFinal = final || finalInspectionRequested
          finalInspectionRequested = false
          void inspect(nextFinal)
          return
        }
        if (final || finalInspectionRequested) {
          settle(false)
          return
        }
        schedulePoll()
      }
      const onAbort = (): void => settle(false)

      signal.addEventListener('abort', onAbort, { once: true })
      deadlineTimer = setTimeout(() => {
        deadlineTimer = undefined
        if (pollTimer !== undefined) {
          clearTimeout(pollTimer)
          pollTimer = undefined
        }
        void inspect(true)
      }, this.graceMs)
      void (async () => {
        if (await verify()) {
          settle(true)
          return
        }
        if (!settled) void inspect()
      })()
    })
  }
}

async function fingerprintVersionTree(
  adapter: Pick<DataAdapter, 'list' | 'stat'>,
  root: string,
): Promise<string> {
  const rootStat = await adapter.stat(root)
  if (rootStat === null) return 'missing'
  if (rootStat.type !== 'folder') {
    return `root:file:${rootStat.size}:${rootStat.mtime}`
  }

  const pending = [root]
  const entries: string[] = []
  while (pending.length > 0) {
    const folder = pending.pop()!
    const listing = await adapter.list(folder)
    for (const path of listing.files) {
      const stat = await adapter.stat(path)
      entries.push(
        `${relativePath(root, path)}:file:${stat?.size ?? -1}:${stat?.mtime ?? -1}`,
      )
    }
    for (const path of listing.folders) {
      const stat = await adapter.stat(path)
      entries.push(`${relativePath(root, path)}:folder:${stat?.mtime ?? -1}`)
      pending.push(path)
    }
  }
  return entries.sort().join('\n')
}

function relativePath(root: string, path: string): string {
  const normalized = normalizePath(path)
  const prefix = `${root}/`
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : path
}

function duration(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new TypeError(`Module artifact arrival ${label} period is invalid`)
  }
  return resolved
}
