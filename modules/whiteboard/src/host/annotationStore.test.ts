import {
  type PdfAnnotation,
  serializeAnnotationFile,
} from '../domain/pdfAnnotations'

import { AnnotationStores } from './annotationStore'

type Listener = Parameters<YoloModuleHostApiV1['vault']['subscribe']>[1]

/** Just enough of the Host API for the store: an in-memory vault that
 * emits the events Obsidian would, and a lock that runs in order. */
function fakeHost(files: Record<string, string> = {}) {
  const data = new Map(Object.entries(files))
  const listeners = new Set<Listener>()
  const entry = (path: string) => ({
    kind: 'file' as const,
    path,
    name: path.split('/').pop() ?? path,
    ctime: 0,
    mtime: 0,
  })
  const emit = (event: Parameters<Listener>[0]) => {
    for (const listener of listeners) void listener(event)
  }
  let chain: Promise<unknown> = Promise.resolve()
  const vault = {
    getEntry: (path: string) => (data.has(path) ? entry(path) : null),
    readText: async (path: string) => {
      const text = data.get(path)
      if (text === undefined) throw new Error('missing')
      return text
    },
    writeText: async (path: string, text: string) => {
      data.set(path, text)
      emit({ type: 'modify', entry: entry(path) })
      return { path, mtime: 1 }
    },
    createText: async (path: string, text: string) => {
      data.set(path, text)
      emit({ type: 'create', entry: entry(path) })
      return { path, mtime: 1 }
    },
    renamePath: async (from: string, to: string) => {
      const text = data.get(from)
      if (text === undefined) throw new Error('missing')
      data.delete(from)
      data.set(to, text)
      emit({ type: 'rename', entry: entry(to), oldPath: from })
    },
    trashPath: async (path: string) => data.delete(path),
    subscribe: (_scope: string, listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const host = {
    vault,
    paths: {
      runExclusive: <T>(_ns: string, op: () => T | PromiseLike<T>) => {
        const next = chain.then(op)
        chain = next.catch(() => undefined)
        return next
      },
    },
  } as unknown as YoloModuleHostApiV1
  return { host, data, emit, entry }
}

const area = (id: string, color = 'yellow'): PdfAnnotation => ({
  id,
  type: 'area',
  color,
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
  anchor: { page: 1, rect: [0, 0, 10, 10] },
})

describe('AnnotationStores', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }))
  afterEach(() => jest.useRealTimers())

  const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
      jest.runOnlyPendingTimers()
      await Promise.resolve()
      await Promise.resolve()
    }
  }

  it('shares one store per PDF and writes edits after they pause', async () => {
    const { host, data } = fakeHost()
    const stores = new AnnotationStores(host, jest.fn())
    const a = stores.acquire('p.pdf')
    const b = stores.acquire('p.pdf')
    expect(a.store).toBe(b.store)
    await settle()
    const seen = jest.fn()
    b.store.subscribe(seen)
    expect(a.store.add([area('x')])).toBe(true)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(data.has('p.pdf.annotations.json')).toBe(false)
    await settle()
    expect(JSON.parse(data.get('p.pdf.annotations.json') ?? '')).toMatchObject({
      version: 1,
      annotations: [{ id: 'x' }],
    })
  })

  it('ignores its own writes coming back but reloads anyone else’s', async () => {
    const { host, data, emit, entry } = fakeHost()
    const stores = new AnnotationStores(host, jest.fn())
    const { store } = stores.acquire('p.pdf')
    await settle()
    store.add([area('x')])
    await settle()
    // Our write came back as a modify event: history survives it.
    expect(store.canUndo()).toBe(true)

    data.set('p.pdf.annotations.json', serializeAnnotationFile([area('y')]))
    emit({ type: 'modify', entry: entry('p.pdf.annotations.json') })
    await settle()
    expect(store.getAll().map((a) => a.id)).toEqual(['y'])
    expect(store.canUndo()).toBe(false)
  })

  it('undoes and redoes, writing each step', async () => {
    const { host, data } = fakeHost()
    const stores = new AnnotationStores(host, jest.fn())
    const { store } = stores.acquire('p.pdf')
    await settle()
    store.add([area('x')])
    store.update('x', { color: 'blue', comment: 'note' })
    expect(store.get('x')).toMatchObject({ color: 'blue', comment: 'note' })
    store.undo()
    expect(store.get('x')?.color).toBe('yellow')
    store.redo()
    await settle()
    expect(data.get('p.pdf.annotations.json')).toContain('"blue"')
  })

  it('moves the file with its PDF and keeps the store under the new path', async () => {
    const { host, data, emit, entry } = fakeHost({
      'a.pdf.annotations.json': serializeAnnotationFile([area('x')]),
    })
    const stores = new AnnotationStores(host, jest.fn())
    const lease = stores.acquire('a.pdf')
    await settle()
    emit({ type: 'rename', entry: entry('b.pdf'), oldPath: 'a.pdf' })
    await settle()
    await settle()
    expect(data.has('a.pdf.annotations.json')).toBe(false)
    expect(data.has('b.pdf.annotations.json')).toBe(true)
    expect(stores.acquire('b.pdf').store).toBe(lease.store)
    expect(lease.store.filePath).toBe('b.pdf.annotations.json')
  })

  it('trashes the file with its PDF', async () => {
    const { host, data, emit, entry } = fakeHost({
      'a.pdf.annotations.json': serializeAnnotationFile([area('x')]),
    })
    const stores = new AnnotationStores(host, jest.fn())
    const { store } = stores.acquire('a.pdf')
    await settle()
    emit({ type: 'delete', entry: entry('a.pdf') })
    await settle()
    await settle()
    expect(data.has('a.pdf.annotations.json')).toBe(false)
    expect(store.getAll()).toEqual([])
    expect(store.writable).toBe(false)
  })

  it('never writes over a file a newer version wrote', async () => {
    const newer = JSON.stringify({ version: 9, annotations: [area('x')] })
    const { host, data } = fakeHost({ 'a.pdf.annotations.json': newer })
    const stores = new AnnotationStores(host, jest.fn())
    const { store } = stores.acquire('a.pdf')
    await settle()
    expect(store.getAll().map((a) => a.id)).toEqual(['x'])
    expect(store.add([area('y')])).toBe(false)
    await settle()
    expect(data.get('a.pdf.annotations.json')).toBe(newer)
  })
})
