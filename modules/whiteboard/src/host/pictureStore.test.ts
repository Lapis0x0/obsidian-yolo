import { PictureStore, type StoredPicture } from './pictureStore'

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
    // As the host's: a document of more than ten thousand values is refused.
    writeJson: async (key: string, value: unknown) => {
      const text = JSON.stringify(value)
      if ((text.match(/[,{[]/g) ?? []).length > 10_000) {
        throw new Error('Module private storage JSON exceeds the node limit')
      }
      blobs.set(key, text)
    },
    listEntries: async (prefix: string) => {
      const depth = prefix.split('/').length + 1
      return {
        files: [],
        folders: [
          ...new Set(
            under(prefix)
              .filter((key) => key.split('/').length > depth)
              .map((key) => key.split('/').slice(0, depth).join('/')),
          ),
        ],
      }
    },
    removeFile: async (key: string) => blobs.delete(key),
    remove: async (key: string) => {
      blobs.delete(key)
      for (const child of under(key)) blobs.delete(child)
    },
  }
  return { blobs, storage: storage as unknown as PrivateScope }
}

const bytes = (length: number) => new ArrayBuffer(length)
const geometry = { width: 595, height: 842, transform: [1, 0, 0, -1, 0, 842] }
const page = (stamp = '', meta: unknown = geometry): StoredPicture => ({
  width: 160,
  height: 226,
  stamp,
  meta,
})

/** Lets every queued write and the index flush land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  jest.advanceTimersByTime(2000)
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe('PictureStore', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const reportError = jest.fn()
  const pdfStore = (storage: PrivateScope, budget?: number) =>
    new PictureStore(storage, 'pdf-thumbnails', 'pdf', reportError, budget)

  it('gives back the pictures written, to a later store too', async () => {
    const { storage } = fakeStorage()
    const store = pdfStore(storage)
    store.write('a.pdf', 1, '3', bytes(10), page())
    store.write('a.pdf', 1, '7', bytes(10), page())
    await settle()

    const later = pdfStore(storage)
    const entries = await later.entries('a.pdf', 1)
    expect([...entries.keys()].sort()).toEqual(['3', '7'])
    expect(entries.get('7')).toEqual(page())
    expect((await later.read('a.pdf', 1, '7'))?.byteLength).toBe(10)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('lists a group of thousands of pictures', async () => {
    const { storage } = fakeStorage()
    const store = new PictureStore(storage, 'cards', 'card', reportError)
    // Past what ten thousand values list: five each, and the object.
    for (let i = 0; i < 2000; i++) {
      store.write('big.yoloboard', 0, `n${i}`, bytes(1), page('s', null))
    }
    for (let i = 0; i < 400; i++) await settle()

    const later = new PictureStore(storage, 'cards', 'card', reportError)
    expect((await later.entries('big.yoloboard', 0)).size).toBe(2000)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('lets go of an older version of a group', async () => {
    const { blobs, storage } = fakeStorage()
    const store = pdfStore(storage)
    store.write('a.pdf', 1, '1', bytes(10), page())
    await settle()
    const oldKeys = [...blobs.keys()].filter(
      (key) => !key.endsWith('index.json'),
    )

    expect((await store.entries('a.pdf', 2)).size).toBe(0)
    await settle()
    for (const key of oldKeys) expect(blobs.has(key)).toBe(false)
    // An asker holding the old version gets nothing either.
    store.write('a.pdf', 2, '1', bytes(10), page())
    await settle()
    expect((await store.entries('a.pdf', 1)).size).toBe(0)
    expect((await store.entries('a.pdf', 2)).size).toBe(1)
  })

  it('writes a picture over the one kept under its key', async () => {
    const { storage } = fakeStorage()
    const store = new PictureStore(storage, 'cards', 'card', reportError)
    store.write('b.yoloboard', 0, 'n1', bytes(10), page('old', null))
    await settle()
    store.write('b.yoloboard', 0, 'n1', bytes(25), page('new', null))
    await settle()

    const later = new PictureStore(storage, 'cards', 'card', reportError)
    const entries = await later.entries('b.yoloboard', 0)
    expect(entries.get('n1')?.stamp).toBe('new')
    expect((await later.read('b.yoloboard', 0, 'n1'))?.byteLength).toBe(25)
  })

  it('keeps only the pictures it is told to', async () => {
    const { storage } = fakeStorage()
    const store = new PictureStore(storage, 'cards', 'card', reportError)
    for (const id of ['n1', 'n2', 'n3']) {
      store.write('b.yoloboard', 0, id, bytes(10), page('s', null))
    }
    await settle()
    store.keep('b.yoloboard', 0, new Set(['n2']))
    await settle()

    const later = new PictureStore(storage, 'cards', 'card', reportError)
    expect([...(await later.entries('b.yoloboard', 0)).keys()]).toEqual(['n2'])
    expect(await later.read('b.yoloboard', 0, 'n1')).toBeNull()
  })

  it('removes the groups used longest ago past the budget, whole', async () => {
    const { storage } = fakeStorage()
    const store = pdfStore(storage, 35)
    jest.setSystemTime(1000)
    store.write('old.pdf', 1, '1', bytes(10), page())
    store.write('old.pdf', 1, '2', bytes(10), page())
    await settle()
    jest.setSystemTime(2000)
    store.write('used.pdf', 1, '1', bytes(10), page())
    await settle()
    // Used again: now newer than old.pdf.
    jest.setSystemTime(3000)
    await store.entries('old.pdf', 1)
    jest.setSystemTime(4000)
    store.write('new.pdf', 1, '1', bytes(10), page())
    await settle()

    const later = pdfStore(storage, 35)
    expect((await later.entries('used.pdf', 1)).size).toBe(0)
    expect((await later.entries('old.pdf', 1)).size).toBe(2)
    expect((await later.entries('new.pdf', 1)).size).toBe(1)
  })

  it('sweeps away folders its index does not name', async () => {
    const { blobs, storage } = fakeStorage()
    blobs.set('pdf-thumbnails/stray/1', bytes(10))
    const store = pdfStore(storage)
    store.write('a.pdf', 1, '1', bytes(10), page())
    await settle()
    expect(blobs.has('pdf-thumbnails/stray/1')).toBe(false)
    // The folder the first write made is not a stray.
    expect((await store.read('a.pdf', 1, '1'))?.byteLength).toBe(10)
  })

  it('lets go of what an older version of the store wrote', async () => {
    const { blobs, storage } = fakeStorage()
    // The shape PDF thumbnails were kept in before this store.
    blobs.set(
      'pdf-thumbnails/index.json',
      JSON.stringify({
        version: 2,
        files: { 'a.pdf': { dir: 'abc', mtime: 1, bytes: 10, usedAt: 1 } },
      }),
    )
    blobs.set('pdf-thumbnails/abc/1', bytes(10))
    blobs.set('pdf-thumbnails/abc/pages.json', JSON.stringify({ 1: geometry }))
    const store = pdfStore(storage)
    expect((await store.entries('a.pdf', 1)).size).toBe(0)
    await settle()
    expect(blobs.has('pdf-thumbnails/abc/1')).toBe(false)
  })

  it('keeps each kind of picture apart', async () => {
    const { storage } = fakeStorage()
    const pdf = pdfStore(storage)
    const images = new PictureStore(
      storage,
      'image-thumbnails',
      'image',
      reportError,
    )
    pdf.write('a.pdf', 1, '1', bytes(10), page())
    images.write('b.png', 1, '', bytes(10), page('', null))
    await settle()
    expect((await pdfStore(storage).entries('a.pdf', 1)).size).toBe(1)
    expect(
      (
        await new PictureStore(
          storage,
          'image-thumbnails',
          'image',
          reportError,
        ).entries('b.png', 1)
      ).size,
    ).toBe(1)
  })
})
