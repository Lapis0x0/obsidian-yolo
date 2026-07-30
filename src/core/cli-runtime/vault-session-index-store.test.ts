import type { App } from 'obsidian'

import { createCliSessionIndexEntry } from './session-index'
import { VaultCliSessionIndexStore } from './vault-session-index-store'

const createMemoryApp = () => {
  const files = new Map<string, string>()
  const directories = new Set<string>()
  const adapter = {
    exists: jest.fn(async (path: string) =>
      files.has(path) || directories.has(path),
    ),
    mkdir: jest.fn(async (path: string) => {
      directories.add(path)
    }),
    read: jest.fn(async (path: string) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`Missing file: ${path}`)
      return value
    }),
    write: jest.fn(async (path: string, content: string) => {
      files.set(path, content)
    }),
  }
  const app = { vault: { adapter } } as unknown as App
  return { app, adapter, files }
}

describe('VaultCliSessionIndexStore', () => {
  it('upserts overlays by runtime/native identity and preserves path as a hint', async () => {
    const { app, files } = createMemoryApp()
    const store = new VaultCliSessionIndexStore(app)
    await store.upsert(
      createCliSessionIndexEntry({
        runtimeId: 'codex',
        nativeSessionId: 'thread-1',
        sessionPathHint: '/old/thread.jsonl',
        assistantId: 'assistant-1',
        lastOpenedAt: 10,
      }),
    )
    await store.upsert(
      createCliSessionIndexEntry({
        runtimeId: 'codex',
        nativeSessionId: 'thread-1',
        sessionPathHint: '/new/thread.jsonl',
        assistantId: 'assistant-1',
        lastOpenedAt: 20,
      }),
    )

    await expect(
      store.get({ runtimeId: 'codex', nativeSessionId: 'thread-1' }),
    ).resolves.toMatchObject({
      nativeSessionId: 'thread-1',
      sessionPathHint: '/new/thread.jsonl',
      lastOpenedAt: 20,
    })
    expect(files.size).toBe(1)
  })

  it('serializes concurrent writes without losing sessions', async () => {
    const { app } = createMemoryApp()
    const store = new VaultCliSessionIndexStore(app)
    await Promise.all([
      store.upsert(
        createCliSessionIndexEntry({
          runtimeId: 'claude-code',
          nativeSessionId: 'session-1',
        }),
      ),
      store.upsert(
        createCliSessionIndexEntry({
          runtimeId: 'codex',
          nativeSessionId: 'thread-1',
        }),
      ),
    ])

    await expect(store.list()).resolves.toHaveLength(2)
  })

  it('removes only the overlay and never touches a native transcript', async () => {
    const { app, adapter } = createMemoryApp()
    const store = new VaultCliSessionIndexStore(app)
    const ref = { runtimeId: 'codex' as const, nativeSessionId: 'thread-1' }
    await store.upsert(createCliSessionIndexEntry(ref))

    await expect(store.remove(ref)).resolves.toBe(true)
    await expect(store.get(ref)).resolves.toBeNull()
    expect(adapter.write).toHaveBeenCalled()
    expect((adapter as { remove?: unknown }).remove).toBeUndefined()
  })

  it('rejects corrupt persisted data instead of replacing user state', async () => {
    const { app, files } = createMemoryApp()
    files.set('YOLO/.yolo_json_db/cli_session_index.json', '{broken')
    const store = new VaultCliSessionIndexStore(app)

    await expect(store.list()).rejects.toThrow(/Failed to parse/)
  })
})
