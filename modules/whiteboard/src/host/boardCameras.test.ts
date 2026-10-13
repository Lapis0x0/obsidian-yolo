import { BoardCameras } from './boardCameras'

type PrivateScope = YoloModuleHostApiV1['privateStorage']['deviceLocal']

function fakeStorage(initial: unknown = null) {
  let kept: unknown = initial
  const storage = {
    readJson: async () => kept,
    writeJson: async (_key: string, value: unknown) => {
      kept = JSON.parse(JSON.stringify(value)) as unknown
    },
  } as unknown as PrivateScope
  return { storage, kept: () => kept }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('BoardCameras', () => {
  const reportError = jest.fn()

  it('knows nothing until it has read what the device keeps', async () => {
    const { storage } = fakeStorage({
      'a.yoloboard': { x: 1, y: 2, scale: 0.5 },
    })
    const cameras = new BoardCameras(storage, reportError)
    const loaded = jest.fn()
    cameras.whenLoaded(loaded)
    expect(cameras.get('a.yoloboard')).toBeUndefined()

    cameras.load()
    await settle()
    expect(loaded).toHaveBeenCalledTimes(1)
    expect(cameras.get('a.yoloboard')).toEqual({ x: 1, y: 2, scale: 0.5 })
    expect(cameras.get('b.yoloboard')).toBeNull()
  })

  it('writes nothing over what is kept before it has read it', async () => {
    const { storage, kept } = fakeStorage({
      'a.yoloboard': { x: 1, y: 2, scale: 0.5 },
    })
    const cameras = new BoardCameras(storage, reportError)
    cameras.set('b.yoloboard', { x: 3, y: 3, scale: 1 })
    await settle()
    expect(Object.keys(kept() as object)).toEqual(['a.yoloboard'])
    expect(cameras.get('b.yoloboard')).toBeUndefined()
    cameras.load()
    await settle()
    expect(Object.keys(kept() as object).sort()).toEqual([
      'a.yoloboard',
      'b.yoloboard',
    ])
  })

  it('keeps a camera for the next time, newest over what was read', async () => {
    const { storage, kept } = fakeStorage({
      'a.yoloboard': { x: 1, y: 2, scale: 0.5 },
    })
    const cameras = new BoardCameras(storage, reportError)
    cameras.set('a.yoloboard', { x: 9, y: 9, scale: 1 })
    cameras.load()
    await settle()
    expect(cameras.get('a.yoloboard')).toEqual({ x: 9, y: 9, scale: 1 })

    const later = new BoardCameras(fakeStorage(kept()).storage, reportError)
    later.load()
    await settle()
    expect(later.get('a.yoloboard')).toEqual({ x: 9, y: 9, scale: 1 })
  })

  it('remembers the boards looked at most recently', async () => {
    const { storage, kept } = fakeStorage()
    const cameras = new BoardCameras(storage, reportError)
    cameras.load()
    await settle()
    for (let i = 0; i < 205; i++) {
      cameras.set(`${i}.yoloboard`, { x: i, y: 0, scale: 1 })
    }
    cameras.set('0.yoloboard', { x: 0, y: 0, scale: 1 })
    // Each set is written in turn.
    for (let i = 0; i < 100; i++) await settle()
    const stored = kept() as Record<string, unknown>
    expect(Object.keys(stored)).toHaveLength(200)
    expect(stored['0.yoloboard']).toBeDefined()
    expect(stored['5.yoloboard']).toBeUndefined()
    expect(stored['6.yoloboard']).toBeDefined()
  })

  it('ignores what it cannot read as a camera', async () => {
    const { storage } = fakeStorage({
      'a.yoloboard': { x: 1, y: 2, scale: 0 },
      'b.yoloboard': 'nope',
    })
    const cameras = new BoardCameras(storage, reportError)
    cameras.load()
    await settle()
    expect(cameras.get('a.yoloboard')).toBeNull()
    expect(cameras.get('b.yoloboard')).toBeNull()
  })
})
