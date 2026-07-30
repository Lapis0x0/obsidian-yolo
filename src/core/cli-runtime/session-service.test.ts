import type {
  CliRuntime,
  CliRuntimeEventListener,
  CliSessionMetadata,
} from './types'
import type {
  CliSessionIndexEntry,
  CliSessionIndexStore,
} from './session-index'
import { getCliSessionIndexKey } from './session-index'
import { CliSessionService } from './session-service'

class MemoryIndex implements CliSessionIndexStore {
  entries = new Map<string, CliSessionIndexEntry>()
  async list(): Promise<CliSessionIndexEntry[]> {
    return [...this.entries.values()]
  }
  async get(ref: Parameters<CliSessionIndexStore['get']>[0]) {
    return this.entries.get(getCliSessionIndexKey(ref)) ?? null
  }
  async upsert(entry: CliSessionIndexEntry): Promise<void> {
    this.entries.set(getCliSessionIndexKey(entry), entry)
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
  sendTurn: async () => undefined,
  cancel: async () => undefined,
  respondApproval: async () => undefined,
  respondQuestion: async () => undefined,
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
        { title: 'Codex', isPinned: true, assistantId: 'assistant-1' },
        { title: 'Claude', isPinned: false },
      ],
      errors: {},
    })
  })

  it('keeps one provider failure isolated from the other provider list', async () => {
    const service = new CliSessionService({
      runtimes: [
        runtime({ runtimeId: 'claude-code', listError: new Error('missing claude') }),
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
})
