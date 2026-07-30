import type {
  CliRuntime,
  CliRuntimeId,
  CliSessionHydration,
  CliSessionMetadata,
  CliSessionRef,
} from './types'
import {
  createCliSessionIndexEntry,
  type CliSessionIndexEntry,
  type CliSessionIndexStore,
  getCliSessionIndexKey,
} from './session-index'

export type CliSessionListItem = CliSessionMetadata & {
  assistantId?: string
  lastOpenedAt?: number
  isPinned: boolean
  pinnedAt?: number
}

export type CliSessionDiscoveryResult = {
  sessions: CliSessionListItem[]
  errors: Partial<Record<CliRuntimeId, string>>
}

export type OpenCliSessionOptions = {
  assistantId?: string
  openedAt?: number
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const mergeOverlay = (
  metadata: CliSessionMetadata,
  overlay: CliSessionIndexEntry | undefined,
): CliSessionListItem => ({
  ...metadata,
  ...(overlay?.assistantId ? { assistantId: overlay.assistantId } : {}),
  ...(overlay?.lastOpenedAt !== undefined
    ? { lastOpenedAt: overlay.lastOpenedAt }
    : {}),
  isPinned: overlay?.isPinned === true,
  ...(overlay?.pinnedAt !== undefined ? { pinnedAt: overlay.pinnedAt } : {}),
})

const compareSessions = (
  left: CliSessionListItem,
  right: CliSessionListItem,
): number => {
  if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1
  if (left.isPinned && right.isPinned) {
    const pinOrder = (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0)
    if (pinOrder !== 0) return pinOrder
  }
  return right.updatedAt - left.updatedAt
}

export class CliSessionService {
  private readonly runtimes: ReadonlyMap<CliRuntimeId, CliRuntime>

  constructor({
    runtimes,
    indexStore,
  }: {
    runtimes: Iterable<CliRuntime>
    indexStore: CliSessionIndexStore
  }) {
    this.runtimes = new Map(
      [...runtimes].map((runtime) => [runtime.runtimeId, runtime]),
    )
    this.indexStore = indexStore
  }

  private readonly indexStore: CliSessionIndexStore

  async listSessions(): Promise<CliSessionDiscoveryResult> {
    const overlays = new Map(
      (await this.indexStore.list()).map((entry) => [
        getCliSessionIndexKey(entry),
        entry,
      ]),
    )
    const errors: Partial<Record<CliRuntimeId, string>> = {}
    const results = await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        try {
          return await runtime.listSessions()
        } catch (error) {
          errors[runtime.runtimeId] = errorMessage(error)
          return []
        }
      }),
    )

    const sessions = results
      .flat()
      .map((metadata) =>
        mergeOverlay(
          metadata,
          overlays.get(getCliSessionIndexKey(metadata.ref)),
        ),
      )
      .sort(compareSessions)
    return { sessions, errors }
  }

  async openSession(
    ref: CliSessionRef,
    options: OpenCliSessionOptions = {},
  ): Promise<CliSessionHydration> {
    const runtime = this.getRuntime(ref.runtimeId)
    const [hydration, existing] = await Promise.all([
      runtime.openSession(ref),
      this.indexStore.get(ref),
    ])
    await this.indexStore.upsert(
      createCliSessionIndexEntry({
        runtimeId: ref.runtimeId,
        nativeSessionId: ref.nativeSessionId,
        ...(hydration.ref.sessionPathHint
          ? { sessionPathHint: hydration.ref.sessionPathHint }
          : existing?.sessionPathHint
            ? { sessionPathHint: existing.sessionPathHint }
            : {}),
        ...(existing?.assistantId
          ? { assistantId: existing.assistantId }
          : options.assistantId
            ? { assistantId: options.assistantId }
            : {}),
        lastOpenedAt: options.openedAt ?? Date.now(),
        ...(existing?.isPinned !== undefined
          ? { isPinned: existing.isPinned }
          : {}),
        ...(existing?.pinnedAt !== undefined
          ? { pinnedAt: existing.pinnedAt }
          : {}),
      }),
    )
    return hydration
  }

  async setAssistantBinding(
    ref: CliSessionRef,
    assistantId: string | undefined,
  ): Promise<void> {
    const existing = await this.indexStore.get(ref)
    await this.indexStore.upsert(
      createCliSessionIndexEntry({
        runtimeId: ref.runtimeId,
        nativeSessionId: ref.nativeSessionId,
        ...(ref.sessionPathHint ?? existing?.sessionPathHint
          ? { sessionPathHint: ref.sessionPathHint ?? existing?.sessionPathHint }
          : {}),
        ...(assistantId ? { assistantId } : {}),
        ...(existing?.lastOpenedAt !== undefined
          ? { lastOpenedAt: existing.lastOpenedAt }
          : {}),
        ...(existing?.isPinned !== undefined
          ? { isPinned: existing.isPinned }
          : {}),
        ...(existing?.pinnedAt !== undefined
          ? { pinnedAt: existing.pinnedAt }
          : {}),
      }),
    )
  }

  async setPinned(
    ref: CliSessionRef,
    pinned: boolean,
    pinnedAt = Date.now(),
  ): Promise<void> {
    const existing = await this.indexStore.get(ref)
    await this.indexStore.upsert(
      createCliSessionIndexEntry({
        runtimeId: ref.runtimeId,
        nativeSessionId: ref.nativeSessionId,
        ...(ref.sessionPathHint ?? existing?.sessionPathHint
          ? { sessionPathHint: ref.sessionPathHint ?? existing?.sessionPathHint }
          : {}),
        ...(existing?.assistantId ? { assistantId: existing.assistantId } : {}),
        ...(existing?.lastOpenedAt !== undefined
          ? { lastOpenedAt: existing.lastOpenedAt }
          : {}),
        isPinned: pinned,
        ...(pinned ? { pinnedAt } : {}),
      }),
    )
  }

  removeOverlay(ref: CliSessionRef): Promise<boolean> {
    return this.indexStore.remove(ref)
  }

  private getRuntime(runtimeId: CliRuntimeId): CliRuntime {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) throw new Error(`${runtimeId} CLI runtime is unavailable.`)
    return runtime
  }
}
