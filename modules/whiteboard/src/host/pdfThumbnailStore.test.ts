import { PdfThumbnailStore } from './pdfThumbnailStore'

type PrivateScope = YoloModuleHostApiV1['privateStorage']['deviceLocal']

/** Just enough of device-local private storage: blobs by key, a folder
 * being every key under it. */
function fakeStorage() {
  const blobs = new Map<string, string | ArrayBuffer>()
  const under = (prefix: string) =>
    [...blobs.keys()].filter((key) => key.startsWith(`${prefix}/`))
  const storage = {
    readText: async (key: string) => {
      const value = blobs.get(key)
      return typeof value === 'string' ? value : null
    },
    readBinary: async (key: string) => {
      const value = blobs.get(key)
      return value instanceof ArrayBuffer ? value : null
    },
    readJson: async (key: string) => {
      const value = blobs.get(key)
      return typeof value === 'string' ? (JSON.parse(value) as unknown) : null
    },
    writeText: async (key: string, value: string) => {
      blobs.set(key, value)
    },
    writeBinary: async (key: string, value: ArrayBuffer) => {
      blobs.set(key, value)
    },
    writeJson: async (key: string, value: unknown) => {
      blobs.set(key, JSON.stringify(value))
    },
    listEntries: async (prefix: string) => ({
      files: [],
      folders: [
        ...new Set(
          under(prefix).map((key) => key.split('/').slice(0, 2).join('/')),
        ),
      ].filter((folder) => blobs.has(folder) || under(folder).length > 0),
    }),
    remove: async (key: string) => {
      blobs.delete(key)
      for (const child of under(key)) blobs.delete(child)
    },
  }
  return { blobs, storage: storage as unknown as PrivateScope }
}

const bytes = (length: number) => new ArrayBuffer(length)

/** Lets every queued write and the index flush land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  jest.advanceTimersByTime(2000)
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('PdfThumbnailStore', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const reportError = jest.fn()

  it('gives back the pages written, to a later store too', async () => {
    const { storage } = fakeStorage()
    const store = new PdfThumbnailStore(storage, reportError)
    store.write('a.pdf', 1, 3, bytes(10))
    store.write('a.pdf', 1, 7, bytes(10))
    await settle()

    const later = new PdfThumbnailStore(storage, reportError)
    expect([...(await later.pages('a.pdf', 1))].sort()).toEqual([3, 7])
    expect((await later.read('a.pdf', 1, 7))?.byteLength).toBe(10)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('lets go of an older version of a file', async () => {
    const { blobs, storage } = fakeStorage()
    const store = new PdfThumbnailStore(storage, reportError)
    store.write('a.pdf', 1, 1, bytes(10))
    await settle()
    const oldKeys = [...blobs.keys()].filter((key) => key.endsWith('/1'))

    expect((await store.pages('a.pdf', 2)).size).toBe(0)
    await settle()
    for (const key of oldKeys) expect(blobs.has(key)).toBe(false)
    // An asker holding the old version gets nothing either.
    store.write('a.pdf', 2, 1, bytes(10))
    await settle()
    expect((await store.pages('a.pdf', 1)).size).toBe(0)
    expect((await store.pages('a.pdf', 2)).size).toBe(1)
  })

  it('removes the files used longest ago past the budget, whole', async () => {
    const { storage } = fakeStorage()
    const store = new PdfThumbnailStore(storage, reportError, 35)
    jest.setSystemTime(1000)
    store.write('old.pdf', 1, 1, bytes(10))
    store.write('old.pdf', 1, 2, bytes(10))
    await settle()
    jest.setSystemTime(2000)
    store.write('used.pdf', 1, 1, bytes(10))
    await settle()
    // Used again: now newer than old.pdf.
    jest.setSystemTime(3000)
    await store.pages('old.pdf', 1)
    jest.setSystemTime(4000)
    store.write('new.pdf', 1, 1, bytes(10))
    await settle()

    const later = new PdfThumbnailStore(storage, reportError, 35)
    expect((await later.pages('used.pdf', 1)).size).toBe(0)
    expect((await later.pages('old.pdf', 1)).size).toBe(2)
    expect((await later.pages('new.pdf', 1)).size).toBe(1)
  })

  it('sweeps away folders its index does not name', async () => {
    const { blobs, storage } = fakeStorage()
    blobs.set('pdf-thumbnails/stray/1', bytes(10))
    const store = new PdfThumbnailStore(storage, reportError)
    store.write('a.pdf', 1, 1, bytes(10))
    await settle()
    expect(blobs.has('pdf-thumbnails/stray/1')).toBe(false)
    // The folder the first write made is not a stray.
    expect((await store.read('a.pdf', 1, 1))?.byteLength).toBe(10)
  })
})
