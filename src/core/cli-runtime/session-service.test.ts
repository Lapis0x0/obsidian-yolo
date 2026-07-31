import type {
  CliSessionIndexEntry,
  CliSessionIndexStore,
} from './session-index'
import { getCliSessionIndexKey } from './session-index'
import { CliSessionService } from './session-service'
import type {
  CliRuntime,
  CliRuntimeEventListener,
  CliSessionMetadata,
} from './types'

class MemoryIndex implements CliSessionIndexStore {
  entries = new Map<string, CliSessionIndexEntry>()
  private writeTail: Promise<void> = Promise.resolve()
  async list(): Promise<CliSessionIndexEntry[]> {
    return [...this.entries.values()]
  }
  async get(ref: Parameters<CliSessionIndexStore['get']>[0]) {
    return this.entries.get(getCliSessionIndexKey(ref)) ?? null
  }
  async upsert(entry: CliSessionIndexEntry): Promise<void> {
    this.entries.set(getCliSessionIndexKey(entry), entry)
  }
  update(
    ref: Parameters<CliSessionIndexStore['update']>[0],
    mutator: Parameters<CliSessionIndexStore['update']>[1],
  ): Promise<CliSessionIndexEntry> {
    const operation = this.writeTail.then(async () => {
      const key = getCliSessionIndexKey(ref)
      await Promise.resolve()
      const next = mutator(this.entries.get(key) ?? null)
      this.entries.set(key, next)
      return next
    })
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }
  async remove(ref: Parameters<CliSessionIndexStore['remove']>[0]) {
    return this.entries.delete(getCliSessionIndexKey(ref))
  }
}

const runtime = ({
  runtimeId,
  sessions,
  listError,
}: {
  runtimeId: 'claude-code' | 'codex'
  sessions?: CliSessionMetadata[]
  listError?: Error
}): CliRuntime => ({
  runtimeId,
  listSessions: async () => {
    if (listError) throw listError
    return sessions ?? []
  },
  openSession: async (ref) => ({ ref, messages: [] }),
  ensureReady: async () => undefined,
  getConfiguration: async () => ({
    models: [],
    modelId: null,
    reasoningEffort: null,
  }),
  updateConfiguration: async () => ({
    models: [],
    modelId: null,
    reasoningEffort: null,
  }),
  sendTurn: async () => undefined,
  cancel: async () => undefined,
  respondApproval: async () => false,
  respondQuestion: async () => false,
  subscribe: (_listener: CliRuntimeEventListener) => () => undefined,
  dispose: async () => undefined,
})

describe('CliSessionService', () => {
  it('merges provider sessions with access overlays and sorts pinned first', async () => {
    const index = new MemoryIndex()
    await index.upsert({
      runtimeId: 'codex',
      nativeSessionId: 'codex-1',
      assistantId: 'assistant-1',
      isPinned: true,
      pinnedAt: 100,
    })
    const service = new CliSessionService({
      runtimes: [
        runtime({
          runtimeId: 'claude-code',
          sessions: [
            {
              ref: { runtimeId: 'claude-code', nativeSessionId: 'claude-1' },
              title: 'Claude',
              updatedAt: 200,
            },
          ],
        }),
        runtime({
          runtimeId: 'codex',
          sessions: [
            {
              ref: { runtimeId: 'codex', nativeSessionId: 'codex-1' },
              title: 'Codex',
              updatedAt: 100,
            },
          ],
        }),
      ],
      indexStore: index,
    })

    await expect(service.listSessions()).resolves.toMatchObject({
      sessions: [
        {
          title: 'Codex',
          isPinned: true,
          hasOverlay: true,
          assistantId: 'assistant-1',
        },
        { title: 'Claude', isPinned: false, hasOverlay: false },
      ],
      errors: {},
    })
  })

  it('keeps one provider failure isolated from the other provider list', async () => {
    const service = new CliSessionService({
      runtimes: [
        runtime({
          runtimeId: 'claude-code',
          listError: new Error('missing claude'),
        }),
        runtime({
          runtimeId: 'codex',
          sessions: [
            {
              ref: { runtimeId: 'codex', nativeSessionId: 'codex-1' },
              title: 'Codex',
              updatedAt: 1,
            },
          ],
        }),
      ],
      indexStore: new MemoryIndex(),
    })

    await expect(service.listSessions()).resolves.toMatchObject({
      sessions: [{ title: 'Codex' }],
      errors: { 'claude-code': 'missing claude' },
    })
  })

  it('creates an overlay only when an external session is first opened', async () => {
    const index = new MemoryIndex()
    const ref = {
      runtimeId: 'codex' as const,
      nativeSessionId: 'codex-1',
      sessionPathHint: '/session.jsonl',
    }
    const service = new CliSessionService({
      runtimes: [runtime({ runtimeId: 'codex' })],
      indexStore: index,
    })

    await service.openSession(ref, {
      assistantId: 'assistant-1',
      openedAt: 123,
    })
    await expect(index.get(ref)).resolves.toMatchObject({
      assistantId: 'assistant-1',
      lastOpenedAt: 123,
      sessionPathHint: '/session.jsonl',
    })
  })

  it('records an existing hydration without reading the native transcript again', async () => {
    const index = new MemoryIndex()
    const ref = {
      runtimeId: 'claude-code' as const,
      nativeSessionId: 'claude-1',
      sessionPathHint: '/native/claude-1.jsonl',
    }
    const nativeRuntime = runtime({ runtimeId: 'claude-code' })
    const openSession = jest.spyOn(nativeRuntime, 'openSession')
    const service = new CliSessionService({
      runtimes: [nativeRuntime],
      indexStore: index,
    })

    await service.recordOpenedSession(
      { ref, messages: [] },
      { assistantId: 'assistant-1', openedAt: 321 },
    )

    expect(openSession).not.toHaveBeenCalled()
    await expect(index.get(ref)).resolves.toMatchObject({
      assistantId: 'assistant-1',
      lastOpenedAt: 321,
      sessionPathHint: '/native/claude-1.jsonl',
    })
  })

  it('changes pin and assistant overlay without touching runtime history', async () => {
    const index = new MemoryIndex()
    const ref = { runtimeId: 'claude-code' as const, nativeSessionId: 'c-1' }
    const service = new CliSessionService({
      runtimes: [runtime({ runtimeId: 'claude-code' })],
      indexStore: index,
    })
    await service.setAssistantBinding(ref, 'assistant-2')
    await service.setPinned(ref, true, 456)

    await expect(index.get(ref)).resolves.toMatchObject({
      assistantId: 'assistant-2',
      isPinned: true,
      pinnedAt: 456,
    })
    await expect(service.removeOverlay(ref)).resolves.toBe(true)
  })

  it('preserves independently updated overlay fields under concurrency', async () => {
    const index = new MemoryIndex()
    const ref = {
      runtimeId: 'codex' as const,
      nativeSessionId: 'thread-concurrent',
      sessionPathHint: '/vault/thread-concurrent.jsonl',
    }
    const service = new CliSessionService({
      runtimes: [runtime({ runtimeId: 'codex' })],
      indexStore: index,
    })

    await Promise.all([
      service.recordOpenedSession({ ref, messages: [] }, { openedAt: 100 }),
      service.setAssistantBinding(ref, 'assistant-concurrent'),
      service.setPinned(ref, true, 200),
    ])

    await expect(index.get(ref)).resolves.toEqual({
      runtimeId: 'codex',
      nativeSessionId: 'thread-concurrent',
      sessionPathHint: '/vault/thread-concurrent.jsonl',
      assistantId: 'assistant-concurrent',
      lastOpenedAt: 100,
      isPinned: true,
      pinnedAt: 200,
    })
  })
})
