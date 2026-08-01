import type { App } from 'obsidian'

import type {
  CliSessionIndexEntry,
  CliSessionIndexStore,
} from './session-index'
import { getCliSessionIndexKey } from './session-index'
import { CliSessionService } from './session-service'

const app = {} as App

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

  async update(
    ref: Parameters<CliSessionIndexStore['update']>[0],
    mutator: Parameters<CliSessionIndexStore['update']>[1],
  ): Promise<CliSessionIndexEntry> {
    const next = mutator(await this.get(ref))
    await this.upsert(next)
    return next
  }

  async remove(ref: Parameters<CliSessionIndexStore['remove']>[0]) {
    return this.entries.delete(getCliSessionIndexKey(ref))
  }
}

describe('CliSessionService', () => {
  it('records only the known native reference and YOLO display metadata', async () => {
    const index = new MemoryIndex()
    const service = new CliSessionService({ app, indexStore: index })
    const ref = {
      runtimeId: 'claude-code' as const,
      nativeSessionId: 'session-1',
      sessionPathHint: '/native/session-1.jsonl',
    }

    await service.recordOpenedSession({ ref, messages: [] })
    await service.rememberConfiguration(ref, {
      modelId: 'sonnet',
      reasoningEffort: 'high',
    })

    await expect(index.get(ref)).resolves.toEqual({
      runtimeId: 'claude-code',
      nativeSessionId: 'session-1',
      sessionPathHint: '/native/session-1.jsonl',
      modelId: 'sonnet',
      reasoningEffort: 'high',
    })
  })

  it('restores YOLO-authored display content without storing the transcript', async () => {
    const index = new MemoryIndex()
    const service = new CliSessionService({ app, indexStore: index })
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }
    const transport = '<current_time>now</current_time>\n\n在吗'
    const content = {
      root: { children: [], type: 'root', version: 1 },
    } as never

    await service.recordUserDisplay(ref, transport, {
      role: 'user',
      id: 'local-user',
      content,
      promptContent: null,
      mentionables: [],
    })

    await expect(
      service.restoreUserDisplays(ref, [
        {
          role: 'user',
          id: 'native-user',
          content: null,
          promptContent: transport,
          mentionables: [],
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'native-user',
        content,
        promptContent: null,
      }),
    ])
  })

  it('removes only YOLO metadata for a deleted history record', async () => {
    const index = new MemoryIndex()
    const service = new CliSessionService({ app, indexStore: index })
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }
    await index.upsert(ref)

    await expect(service.removeOverlay(ref)).resolves.toBe(true)
    await expect(index.get(ref)).resolves.toBeNull()
  })
})
