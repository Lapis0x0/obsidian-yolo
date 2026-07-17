jest.mock('obsidian', () => {
  class TFile {}
  class TFolder {}
  return {
    App: class {},
    TFile,
    TFolder,
    normalizePath: (path: string) => path,
  }
})

import { type App, TFile, TFolder } from 'obsidian'

import { ModuleLifecycleScope } from './lifecycleScope'
import {
  ObsidianModuleVaultCapabilityProvider,
  normalizeModuleVaultPath,
} from './moduleVault'

type VaultRef = {
  event: string
  listener: (...args: unknown[]) => void
}

const createFile = (path: string, ctime = 1, mtime = 2): TFile =>
  Object.assign(new TFile(), {
    path,
    name: path.split('/').at(-1) ?? '',
    stat: { ctime, mtime, size: 0 },
  })

const createFolder = (
  path: string,
  children: Array<TFile | TFolder>,
): TFolder =>
  Object.assign(new TFolder(), {
    path,
    name: path.split('/').at(-1) ?? '',
    children,
  })

function createApp(entries: Array<TFile | TFolder>) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const refs = new Set<VaultRef>()
  const binary = Uint8Array.from([1, 2, 3]).buffer
  const registerRef = (
    event: string,
    listener: (...args: unknown[]) => void,
  ): VaultRef => {
    const ref = { event, listener }
    refs.add(ref)
    return ref
  }
  const vault = {
    getAbstractFileByPath: jest.fn((path: string) => byPath.get(path) ?? null),
    getMarkdownFiles: jest.fn(() =>
      entries.filter((entry): entry is TFile => entry instanceof TFile),
    ),
    cachedRead: jest.fn(async (file: TFile) => `content:${file.path}`),
    readBinary: jest.fn(async () => binary),
    adapter: {
      exists: jest.fn(async (path: string) => byPath.has(path)),
    },
    on: jest.fn(registerRef),
    offref: jest.fn((ref: VaultRef) => {
      refs.delete(ref)
    }),
  }
  return {
    app: { vault } as unknown as App,
    binary,
    emit: (event: string, ...args: unknown[]) => {
      for (const ref of [...refs]) {
        if (ref.event === event) ref.listener(...args)
      }
    },
    refs,
    registerRef,
    vault,
  }
}

describe('normalizeModuleVaultPath', () => {
  it('normalizes vault-relative separators and supports an explicit root', () => {
    expect(normalizeModuleVaultPath('notes\\topic//card.md')).toBe(
      'notes/topic/card.md',
    )
    expect(normalizeModuleVaultPath('', true)).toBe('')
  })

  it.each(['/absolute.md', '../escape.md', 'notes/./file.md', 'bad\0path'])(
    'rejects unsafe path %s',
    (path) => {
      expect(() => normalizeModuleVaultPath(path)).toThrow()
    },
  )

  it('rejects empty and non-string file paths', () => {
    expect(() => normalizeModuleVaultPath('')).toThrow('must not be empty')
    expect(() => normalizeModuleVaultPath(42 as unknown as string)).toThrow(
      'must be a string',
    )
  })
})

describe('ObsidianModuleVaultCapabilityProvider', () => {
  it('returns immutable entry DTOs and copied file content', async () => {
    const file = createFile('notes/card.md', 10, 20)
    const folder = createFolder('notes', [file])
    const { app, binary, vault } = createApp([folder, file])
    const lifecycle = new ModuleLifecycleScope()
    const capability = new ObsidianModuleVaultCapabilityProvider(app).create(
      'notes',
      lifecycle,
    )

    const entry = capability.api.getEntry('notes/card.md')
    expect(entry).toEqual({
      kind: 'file',
      path: 'notes/card.md',
      name: 'card.md',
      ctime: 10,
      mtime: 20,
    })
    expect(Object.isFrozen(entry)).toBe(true)
    const children = capability.api.listChildren('notes')
    expect(children).toEqual([entry])
    expect(Object.isFrozen(children)).toBe(true)
    expect(capability.api.listMarkdownFiles()).toEqual([entry])
    await expect(capability.api.exists('notes/card.md')).resolves.toBe(true)
    await expect(capability.api.readText('notes/card.md')).resolves.toBe(
      'content:notes/card.md',
    )
    const readBinary = await capability.api.readBinary('notes/card.md')
    expect([...new Uint8Array(readBinary)]).toEqual([1, 2, 3])
    expect(readBinary).not.toBe(binary)
    expect(vault.cachedRead).toHaveBeenCalledWith(file)
    expect(vault.readBinary).toHaveBeenCalledWith(file)

    await expect(capability.api.readText('notes/missing.md')).rejects.toThrow(
      'file not found',
    )
    await expect(capability.api.exists('unindexed/secret.json')).resolves.toBe(
      false,
    )
    await expect(
      capability.api.readBinary('unindexed/secret.json'),
    ).rejects.toThrow('file not found')
    expect(vault.adapter.exists).not.toHaveBeenCalled()
    lifecycle.dispose()
    expect(() => capability.api.getEntry('notes')).toThrow('not active')
    await expect(capability.api.exists('notes')).rejects.toThrow('not active')
  })

  it('scopes events, gates activation, and unsubscribes with lifecycle', () => {
    const inside = createFile('notes/card.md')
    const outside = createFile('other/card.md')
    const renamedOutside = createFile('archive/card.md')
    const { app, emit, refs, vault } = createApp([
      inside,
      outside,
      renamedOutside,
    ])
    const lifecycle = new ModuleLifecycleScope()
    const capability = new ObsidianModuleVaultCapabilityProvider(app).create(
      'notes',
      lifecycle,
    )
    const listener = jest.fn()
    const unsubscribe = capability.api.subscribe('notes', listener)

    emit('create', inside)
    expect(listener).not.toHaveBeenCalled()
    capability.activate()
    emit('create', inside)
    emit('modify', outside)
    emit('rename', renamedOutside, 'notes/card.md')
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'create', entry: expect.any(Object) }),
    )
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: 'rename',
      entry: expect.objectContaining({ path: 'archive/card.md' }),
      oldPath: 'notes/card.md',
    })

    unsubscribe()
    unsubscribe()
    emit('delete', inside)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(refs.size).toBe(0)
    expect(vault.offref).toHaveBeenCalledTimes(4)

    const lateListener = jest.fn()
    capability.api.subscribe('', lateListener)
    expect(refs.size).toBe(4)
    lifecycle.dispose()
    expect(refs.size).toBe(0)
    emit('create', inside)
    expect(lateListener).not.toHaveBeenCalled()
  })

  it('reports an ancestor folder rename to a nested scope', () => {
    const renamedFolder = createFolder('archive', [])
    const { app, emit } = createApp([renamedFolder])
    const lifecycle = new ModuleLifecycleScope()
    const capability = new ObsidianModuleVaultCapabilityProvider(app).create(
      'notes',
      lifecycle,
    )
    const listener = jest.fn()
    capability.api.subscribe('projects/a', listener)
    capability.activate()

    emit('rename', renamedFolder, 'projects')

    expect(listener).toHaveBeenCalledWith({
      type: 'rename',
      entry: expect.objectContaining({ path: 'archive' }),
      oldPath: 'projects',
    })
    lifecycle.dispose()
  })

  it('isolates synchronous, asynchronous, and reporter failures', async () => {
    const file = createFile('notes/card.md')
    const { app, emit } = createApp([file])
    const reportListenerError = jest.fn(() => {
      throw new Error('reporter failed')
    })
    const lifecycle = new ModuleLifecycleScope()
    const capability = new ObsidianModuleVaultCapabilityProvider(app, {
      reportListenerError,
    }).create('notes', lifecycle)
    capability.api.subscribe('', () => {
      throw new Error('sync failed')
    })
    capability.api.subscribe('', () =>
      Promise.reject(new Error('async failed')),
    )
    capability.activate()

    expect(() => emit('modify', file)).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(reportListenerError).toHaveBeenCalledTimes(2)
    expect(reportListenerError).toHaveBeenCalledWith(
      'notes',
      expect.objectContaining({ message: 'sync failed' }),
    )
    expect(reportListenerError).toHaveBeenCalledWith(
      'notes',
      expect.objectContaining({ message: 'async failed' }),
    )
    lifecycle.dispose()
  })

  it('retries EventRef cleanup failures during lifecycle disposal', () => {
    const file = createFile('notes/card.md')
    const { app, refs, vault } = createApp([file])
    const lifecycle = new ModuleLifecycleScope()
    const capability = new ObsidianModuleVaultCapabilityProvider(app).create(
      'notes',
      lifecycle,
    )
    const unsubscribe = capability.api.subscribe('', jest.fn())
    vault.offref.mockImplementationOnce(() => {
      throw new Error('offref failed')
    })

    expect(() => unsubscribe()).toThrow('subscription cleanup')
    expect(refs.size).toBe(1)

    lifecycle.dispose()
    expect(refs.size).toBe(0)
    expect(vault.offref).toHaveBeenCalledTimes(5)
  })

  it('rolls back EventRefs when subscription registration fails', () => {
    const file = createFile('notes/card.md')
    const { app, refs, registerRef, vault } = createApp([file])
    const lifecycle = new ModuleLifecycleScope()
    const capability = new ObsidianModuleVaultCapabilityProvider(app).create(
      'notes',
      lifecycle,
    )
    vault.on.mockImplementationOnce(registerRef).mockImplementationOnce(() => {
      throw new Error('registration failed')
    })

    expect(() => capability.api.subscribe('', jest.fn())).toThrow(
      'registration failed',
    )
    expect(refs.size).toBe(0)
    expect(vault.offref).toHaveBeenCalledTimes(1)
    lifecycle.dispose()
  })
})
