import {
  HOST_VAULT_WRITE_API_GAPS,
  createHostLearningVaultReadApi,
  createHostLearningVaultWriteApi,
} from './hostVaultAdapter'
import type { LearningVaultFileSnapshot } from './learningVaultWriteApi'

function createHostVault() {
  const initial = Object.freeze({ path: 'p/cards.md', content: 'before' })
  const created = Object.freeze({ path: 'p/new.md', content: 'created' })
  const updated = Object.freeze({ path: 'p/new.md', content: 'updated' })
  const replaceTextIfUnchanged = jest.fn(
    async (expected: { readonly path: string; readonly content: string }) => {
      if (expected === initial)
        return Object.freeze({ ...initial, content: 'after' })
      if (expected === created) return updated
      return null
    },
  )
  const revertOwnedCreatedTextIfUnchanged = jest.fn(
    async (
      createdReceipt: { readonly path: string; readonly content: string },
      expected: { readonly path: string; readonly content: string },
      fallbackContent: string,
    ) =>
      createdReceipt === created && expected === updated
        ? Object.freeze({ path: created.path, content: fallbackContent })
        : null,
  )
  const listeners: Array<
    (
      event: Parameters<YoloModuleHostApiV1['vault']['subscribe']>[1] extends (
        event: infer Event,
      ) => void | Promise<void>
        ? Event
        : never,
    ) => void | Promise<void>
  > = []
  const vault: YoloModuleHostApiV1['vault'] = {
    getEntry: (path) =>
      path === 'p'
        ? { kind: 'folder', path, name: 'p' }
        : { kind: 'file', path, name: 'cards.md', ctime: 1, mtime: 2 },
    listChildren: () => [
      {
        kind: 'file',
        path: 'p/cards.md',
        name: 'cards.md',
        ctime: 1,
        mtime: 2,
      },
    ],
    listMarkdownFiles: () => [],
    exists: async () => true,
    readText: async () => '',
    readBinary: async () => new ArrayBuffer(0),
    ensureFolder: async () => undefined,
    createFolder: async () => undefined,
    createText: async (path) => ({ path, mtime: 1 }),
    createBinary: async () => undefined,
    writeText: async (path) => ({ path, mtime: 2 }),
    renamePath: async () => undefined,
    trashPath: async () => true,
    readTextSnapshot: async () => initial,
    createTextIfAbsent: async () => created,
    replaceTextIfUnchanged,
    revertOwnedCreatedTextIfUnchanged,
    subscribe: (_scopePath, listener) => {
      listeners.push(listener)
      return () => undefined
    },
  }
  return {
    vault,
    initial,
    created,
    updated,
    listeners,
    replaceTextIfUnchanged,
    revertOwnedCreatedTextIfUnchanged,
  }
}

describe('hostVaultAdapter', () => {
  it('maps reads and filters subscribed event types', () => {
    const host = createHostVault()
    const api = createHostLearningVaultReadApi(host.vault)
    const created = jest.fn()
    const renamed = jest.fn()
    api.onCreate('p', created)
    api.onRename('p', renamed)

    void host.listeners[0]({
      type: 'create',
      entry: { kind: 'folder', path: 'p/new', name: 'new' },
    })
    void host.listeners[0]({
      type: 'modify',
      entry: { kind: 'folder', path: 'p/new', name: 'new' },
    })
    void host.listeners[1]({
      type: 'rename',
      entry: { kind: 'folder', path: 'p/new', name: 'new' },
      oldPath: 'p/old',
    })

    expect(created).toHaveBeenCalledTimes(1)
    expect(renamed).toHaveBeenCalledWith(
      { kind: 'folder', path: 'p/new', name: 'new' },
      'p/old',
    )
  })

  it('preserves opaque host snapshots across CAS operations', async () => {
    const host = createHostVault()
    const api = createHostLearningVaultWriteApi(host.vault)
    const snapshot = await api.readTextSnapshot('p/cards.md')
    expect(snapshot?.identity).toBe(host.initial)

    const changed = snapshot
      ? await api.replaceTextIfUnchanged(snapshot, 'after')
      : null
    expect(changed?.content).toBe('after')
    expect(host.replaceTextIfUnchanged).toHaveBeenCalledWith(
      host.initial,
      'after',
    )

    const forged: LearningVaultFileSnapshot = {
      path: host.initial.path,
      content: host.initial.content,
      identity: host.initial,
    }
    await expect(api.replaceTextIfUnchanged(forged, 'bad')).resolves.toBeNull()
  })

  it('preserves the host create receipt through update and rollback', async () => {
    const host = createHostVault()
    const firstApi = createHostLearningVaultWriteApi(host.vault)
    const secondApi = createHostLearningVaultWriteApi(host.vault)
    const created = await firstApi.createTextIfAbsent('p/new.md', 'created')
    const updated = created
      ? await secondApi.replaceTextIfUnchanged(created, 'updated')
      : null
    const reverted =
      created && updated
        ? await firstApi.revertOwnedCreatedTextIfUnchanged(
            created,
            updated,
            'shell',
          )
        : null

    expect(reverted?.content).toBe('shell')
    expect(host.revertOwnedCreatedTextIfUnchanged).toHaveBeenCalledWith(
      host.created,
      host.updated,
      'shell',
    )
  })

  it('documents host write operations that cannot preserve port semantics', () => {
    expect(HOST_VAULT_WRITE_API_GAPS).toEqual([
      'renamePath',
      'removeExactPath',
      'removeEmptyFolder',
      'removeTree',
    ])
  })
})
