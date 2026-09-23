import type {
  PdfEngineComponentApi,
  PdfEngineDocument,
  RuntimeComponentLease,
} from '../../core/runtime-components/contracts'

import { PdfDocumentCache } from './pdfDocumentCache'

function setup(
  options: { readFile?: (path: string) => Promise<Uint8Array> } = {},
) {
  const documents: { path: string; destroyed: boolean }[] = []
  let leases = 0
  let reads = 0
  const api = {
    openDocument: async (bytes: Uint8Array): Promise<PdfEngineDocument> => {
      const record = {
        path: new TextDecoder().decode(bytes),
        destroyed: false,
      }
      documents.push(record)
      return {
        pageCount: 3,
        getPage: () => Promise.reject(new Error('not used')),
        destroy: async () => {
          record.destroyed = true
        },
      }
    },
  } as unknown as PdfEngineComponentApi
  const cache = new PdfDocumentCache({
    readFile:
      options.readFile ??
      (async (path) => {
        reads += 1
        return new TextEncoder().encode(path)
      }),
    acquireEngine: async () => {
      leases += 1
      let released = false
      const lease: RuntimeComponentLease<'pdf-engine'> = {
        api,
        release: () => {
          if (released) return
          released = true
          leases -= 1
        },
      }
      return lease
    },
  })
  return {
    cache,
    documents,
    leases: () => leases,
    reads: () => reads,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('PdfDocumentCache', () => {
  it('shares one document per path and destroys it with the last handle', async () => {
    const { cache, documents, leases } = setup()
    const [first, second] = await Promise.all([
      cache.open('a.pdf'),
      cache.open('a.pdf'),
    ])
    expect(documents).toHaveLength(1)
    expect(first.pageCount).toBe(3)
    expect(leases()).toBe(1)

    first.release()
    first.release()
    await settle()
    expect(documents[0].destroyed).toBe(false)

    second.release()
    await settle()
    expect(documents[0].destroyed).toBe(true)
    expect(leases()).toBe(0)
    await expect(second.getPage(1)).rejects.toThrow('released')
  })

  it('opens a fresh document after the last one was released', async () => {
    const { cache, documents } = setup()
    ;(await cache.open('a.pdf')).release()
    await settle()
    await cache.open('a.pdf')
    expect(documents).toHaveLength(2)
  })

  it('retires a changed file: old handles go stale, new opens reread', async () => {
    const { cache, documents, reads } = setup()
    const old = await cache.open('a.pdf')
    const stale = jest.fn()
    old.subscribe(stale)

    cache.invalidate('a.pdf')
    expect(stale).toHaveBeenCalledTimes(1)
    expect(old.isStale()).toBe(true)

    const fresh = await cache.open('a.pdf')
    expect(fresh.isStale()).toBe(false)
    expect(reads()).toBe(2)
    expect(documents[0].destroyed).toBe(false)

    old.release()
    await settle()
    expect(documents[0].destroyed).toBe(true)
    expect(documents[1].destroyed).toBe(false)
    cache.invalidate('a.pdf')
    expect(stale).toHaveBeenCalledTimes(1)
  })

  it('tells a late subscriber that the document is already stale', async () => {
    const { cache } = setup()
    const handle = await cache.open('a.pdf')
    cache.invalidate('a.pdf')
    const listener = jest.fn()
    handle.subscribe(listener)
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not hand out a document retired while it was loading', async () => {
    let calls = 0
    let cache: PdfDocumentCache | null = null
    const harness = setup({
      readFile: async (path) => {
        calls += 1
        if (calls === 1) cache?.invalidate(path)
        return new TextEncoder().encode(path)
      },
    })
    cache = harness.cache
    const handle = await harness.cache.open('a.pdf')
    expect(handle.isStale()).toBe(false)
    expect(harness.documents).toHaveLength(2)
    await settle()
    expect(harness.documents[0].destroyed).toBe(true)
  })

  it('releases the engine when opening fails, and retries next time', async () => {
    let fail = true
    const harness = setup({
      readFile: async (path) => {
        if (fail) throw new Error('unreadable')
        return new TextEncoder().encode(path)
      },
    })
    await expect(harness.cache.open('a.pdf')).rejects.toThrow('unreadable')
    expect(harness.leases()).toBe(0)
    fail = false
    await expect(harness.cache.open('a.pdf')).resolves.toBeDefined()
  })

  it('closeAll destroys every document regardless of holders', async () => {
    const { cache, documents, leases } = setup()
    const a = await cache.open('a.pdf')
    await cache.open('b.pdf')
    const stale = jest.fn()
    a.subscribe(stale)

    await cache.closeAll()
    expect(documents.every((document) => document.destroyed)).toBe(true)
    expect(leases()).toBe(0)
    expect(stale).toHaveBeenCalledTimes(1)
    await expect(a.getPage(1)).rejects.toThrow('turned off')
    a.release()
    expect(leases()).toBe(0)
  })
})
