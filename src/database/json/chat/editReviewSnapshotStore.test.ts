import { App } from 'obsidian'

import {
  clearAllEditReviewSnapshotStores,
  deleteEditReviewSnapshotStore,
  readEditReviewSnapshot,
  upsertEditReviewSnapshot,
} from './editReviewSnapshotStore'

class MockAdapter {
  private readonly files = new Map<string, string>()
  private readonly folders = new Set<string>()

  constructor(
    private readonly hooks?: {
      onWrite?: (path: string) => Promise<void>
    },
  ) {}

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async mkdir(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      this.folders.add(current)
    }
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path)
    if (value === undefined) {
      throw new Error(`Missing file: ${path}`)
    }
    return value
  }

  async write(path: string, content: string): Promise<void> {
    await this.hooks?.onWrite?.(path)
    this.files.set(path, content)
    await this.mkdir(path.split('/').slice(0, -1).join('/'))
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`
    return {
      files: [...this.files.keys()].filter((filePath) =>
        filePath.startsWith(prefix),
      ),
      folders: [...this.folders].filter(
        (folderPath) => folderPath !== path && folderPath.startsWith(prefix),
      ),
    }
  }
}

describe('editReviewSnapshotStore', () => {
  const createApp = (hooks?: ConstructorParameters<typeof MockAdapter>[0]) => {
    const adapter = new MockAdapter(hooks)
    return {
      app: {
        vault: {
          adapter,
        },
      } as unknown as App,
      adapter,
    }
  }

  it('preserves the first beforeContent across repeated upserts', async () => {
    const { app } = createApp()

    await upsertEditReviewSnapshot({
      app,
      conversationId: 'conv-1',
      roundId: 'round-1',
      filePath: 'note.md',
      beforeContent: 'hello',
      afterContent: ['hello', 'world'].join('\n'),
    })
    await upsertEditReviewSnapshot({
      app,
      conversationId: 'conv-1',
      roundId: 'round-1',
      filePath: 'note.md',
      beforeContent: ['hello', 'world'].join('\n'),
      afterContent: ['hello', 'world!'].join('\n'),
    })

    await expect(
      readEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'note.md',
      }),
    ).resolves.toMatchObject({
      beforeContent: 'hello',
      afterContent: ['hello', 'world!'].join('\n'),
      addedLines: 1,
      removedLines: 0,
    })
  })

  it('serializes concurrent writes for the same conversation store', async () => {
    const { app } = createApp()

    await Promise.all([
      upsertEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'a.md',
        beforeContent: 'a',
        afterContent: 'aa',
      }),
      upsertEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'b.md',
        beforeContent: 'b',
        afterContent: 'bb',
      }),
    ])

    await expect(
      readEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'a.md',
      }),
    ).resolves.not.toBeNull()
    await expect(
      readEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'b.md',
      }),
    ).resolves.not.toBeNull()
  })

  it('clears all persisted edit review stores', async () => {
    const { app } = createApp()

    await upsertEditReviewSnapshot({
      app,
      conversationId: 'conv-1',
      roundId: 'round-1',
      filePath: 'note.md',
      beforeContent: 'hello',
      afterContent: 'world',
    })

    await clearAllEditReviewSnapshotStores(app)

    await expect(
      readEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'note.md',
      }),
    ).resolves.toBeNull()
  })

  it('waits for pending conversation writes before deleting a store', async () => {
    let releaseWrite: () => void = () => {}
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const { app } = createApp({
      onWrite: async (path) => {
        if (path.endsWith('conv-1.json')) {
          await writeBlocked
        }
      },
    })

    const pendingWrite = upsertEditReviewSnapshot({
      app,
      conversationId: 'conv-1',
      roundId: 'round-1',
      filePath: 'note.md',
      beforeContent: 'before',
      afterContent: 'after',
    })
    const pendingDelete = deleteEditReviewSnapshotStore(app, 'conv-1')

    releaseWrite()
    await Promise.all([pendingWrite, pendingDelete])

    await expect(
      readEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'note.md',
      }),
    ).resolves.toBeNull()
  })

  it('waits for pending writes before clearing all stores', async () => {
    let releaseWrite: () => void = () => {}
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const { app } = createApp({
      onWrite: async (path) => {
        if (path.endsWith('conv-1.json')) {
          await writeBlocked
        }
      },
    })

    const pendingWrite = upsertEditReviewSnapshot({
      app,
      conversationId: 'conv-1',
      roundId: 'round-1',
      filePath: 'note.md',
      beforeContent: 'before',
      afterContent: 'after',
    })
    const pendingClear = clearAllEditReviewSnapshotStores(app)

    releaseWrite()
    await Promise.all([pendingWrite, pendingClear])

    await expect(
      readEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'note.md',
      }),
    ).resolves.toBeNull()
  })
})
