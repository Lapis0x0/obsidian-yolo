// Installs IDBKeyRange (used by the compound-key range) as a global.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import {
  MAX_SNAPSHOT_CONTENT_CHARS,
  clearAllEditReviewSnapshotStores,
  deleteEditReviewSnapshotStore,
  readEditReviewSnapshot,
  readEditReviewSnapshots,
  upsertEditReviewSnapshot,
} from './editReviewSnapshotStore'

/**
 * Each test gets its own vault namespace (and so its own database) plus a
 * fresh fake IndexedDB, which is also what keeps the module-level connection
 * cache from carrying a dead handle between tests.
 */
let namespaceCounter = 0

const createApp = () => {
  namespaceCounter += 1
  const suffix = String(namespaceCounter).padStart(12, '0')
  const namespaceId = `00000000-0000-4000-8000-${suffix}`
  const store = new Map<string, string>([
    ['yolo-module-device-local-database-namespace', namespaceId],
  ])
  return {
    loadLocalStorage: (key: string) => store.get(key) ?? null,
    saveLocalStorage: (key: string, value: string) => {
      store.set(key, value)
    },
  }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

describe('editReviewSnapshotStore', () => {
  it('preserves the first beforeContent across repeated upserts in a round', async () => {
    const app = createApp()

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
      contentAvailable: true,
    })
  })

  it('keeps snapshots of the same file in different rounds apart', async () => {
    const app = createApp()

    await upsertEditReviewSnapshot({
      app,
      conversationId: 'conv-1',
      roundId: 'round-1',
      filePath: 'note.md',
      beforeContent: 'v1',
      afterContent: 'v2',
    })
    await upsertEditReviewSnapshot({
      app,
      conversationId: 'conv-1',
      roundId: 'round-2',
      filePath: 'note.md',
      beforeContent: 'v2',
      afterContent: 'v3',
    })

    await expect(
      readEditReviewSnapshots({
        app,
        conversationId: 'conv-1',
        keys: [
          { roundId: 'round-1', filePath: 'note.md' },
          { roundId: 'round-2', filePath: 'note.md' },
          { roundId: 'round-3', filePath: 'note.md' },
        ],
      }),
    ).resolves.toMatchObject([
      { beforeContent: 'v1', afterContent: 'v2' },
      { beforeContent: 'v2', afterContent: 'v3' },
      null,
    ])
  })

  it('deletes only the requested conversation', async () => {
    const app = createApp()

    for (const conversationId of ['conv-1', 'conv-2']) {
      await upsertEditReviewSnapshot({
        app,
        conversationId,
        roundId: 'round-1',
        filePath: 'note.md',
        beforeContent: 'before',
        afterContent: 'after',
      })
    }

    await deleteEditReviewSnapshotStore(app, 'conv-1')

    await expect(
      readEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'note.md',
      }),
    ).resolves.toBeNull()
    await expect(
      readEditReviewSnapshot({
        app,
        conversationId: 'conv-2',
        roundId: 'round-1',
        filePath: 'note.md',
      }),
    ).resolves.not.toBeNull()
  })

  it('clears every conversation', async () => {
    const app = createApp()

    await upsertEditReviewSnapshot({
      app,
      conversationId: 'conv-1',
      roundId: 'round-1',
      filePath: 'note.md',
      beforeContent: 'before',
      afterContent: 'after',
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

  it('serializes concurrent upserts of different files', async () => {
    const app = createApp()

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
      readEditReviewSnapshots({
        app,
        conversationId: 'conv-1',
        keys: [
          { roundId: 'round-1', filePath: 'a.md' },
          { roundId: 'round-1', filePath: 'b.md' },
        ],
      }),
    ).resolves.toMatchObject([{ afterContent: 'aa' }, { afterContent: 'bb' }])
  })

  it('keeps the first beforeContent when two upserts of the same file race', async () => {
    const app = createApp()

    await Promise.all([
      upsertEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'note.md',
        beforeContent: 'v1',
        afterContent: 'v2',
      }),
      upsertEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'note.md',
        beforeContent: 'v2',
        afterContent: 'v3',
      }),
    ])

    await expect(
      readEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'note.md',
      }),
    ).resolves.toMatchObject({ beforeContent: 'v1', afterContent: 'v3' })
  })

  it('drops the content but keeps the record when a side is over the size cap', async () => {
    const app = createApp()
    const huge = 'x'.repeat(MAX_SNAPSHOT_CONTENT_CHARS + 1)

    const snapshot = await upsertEditReviewSnapshot({
      app,
      conversationId: 'conv-1',
      roundId: 'round-1',
      filePath: 'huge.md',
      beforeContent: huge,
      afterContent: 'small',
    })

    expect(snapshot).toMatchObject({
      contentAvailable: false,
      beforeContent: '',
      afterContent: '',
    })

    await expect(
      readEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'huge.md',
      }),
    ).resolves.toMatchObject({ contentAvailable: false, beforeContent: '' })
  })

  it('still counts lines for oversized content that needs no diff', async () => {
    const app = createApp()
    // 行数走的仍是 `countFileChangeStats` 的既有规则：纯创建只数行，不 diff，
    // 所以卡片照样有 `+N`，只有评审因为没留正文而不可用。
    const huge = 'x\n'.repeat(MAX_SNAPSHOT_CONTENT_CHARS)

    await expect(
      upsertEditReviewSnapshot({
        app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'huge.md',
        beforeContent: '',
        afterContent: huge,
        beforeExists: false,
      }),
    ).resolves.toMatchObject({
      contentAvailable: false,
      lineStatsAvailable: true,
      addedLines: MAX_SNAPSHOT_CONTENT_CHARS + 1,
      removedLines: 0,
    })
  })

  it('stays content-unavailable for later edits in the same round', async () => {
    const app = createApp()
    const huge = 'x'.repeat(MAX_SNAPSHOT_CONTENT_CHARS + 1)

    await upsertEditReviewSnapshot({
      app,
      conversationId: 'conv-1',
      roundId: 'round-1',
      filePath: 'huge.md',
      beforeContent: huge,
      afterContent: 'small',
    })
    // 第二次编辑的 before 是小内容，但本轮真正的「改前」正文已经丢了，
    // 不能拿它冒充，行数也不能再算。
    const second = await upsertEditReviewSnapshot({
      app,
      conversationId: 'conv-1',
      roundId: 'round-1',
      filePath: 'huge.md',
      beforeContent: 'small',
      afterContent: 'smaller',
    })

    expect(second).toMatchObject({
      contentAvailable: false,
      beforeContent: '',
      afterContent: '',
      lineStatsAvailable: false,
    })
  })

  it('reads nothing when no keys are requested', async () => {
    const app = createApp()
    await expect(
      readEditReviewSnapshots({ app, conversationId: 'conv-1', keys: [] }),
    ).resolves.toEqual([])
  })
})
