import type { PictureStore, StoredPicture } from '../../host/pictureStore'

import {
  type DrawnPicture,
  type PictureSource,
  Pictures,
  type WantedPicture,
  levelFor,
  resizedTo,
} from './pictures'

type FakeBitmap = { width: number; height: number; closed: boolean }

function fakeBitmap(width: number, height = width): ImageBitmap {
  const bitmap: FakeBitmap = { width, height, closed: false }
  return Object.assign(bitmap, {
    close: () => {
      bitmap.closed = true
    },
  }) as unknown as ImageBitmap
}

/** A canvas as far as the scheduler uses one: its size, and an encoding. */
function fakeCanvas(width: number, height: number): HTMLCanvasElement {
  return {
    width,
    height,
    toBlob: (done: (blob: Blob | null) => void) => done(new Blob(['x'])),
  } as unknown as HTMLCanvasElement
}

/** Everything a test needs around a `Pictures`: a store holding what it is
 * given, a source that makes 100-pixel pictures, and a board whose wanted
 * pictures, stillness and zoom the test sets. */
function setup(
  options: Readonly<{
    stored?: Record<string, StoredPicture>
    budgetBytes?: number
    concurrency?: number
  }> = {},
) {
  const stored = new Map(Object.entries(options.stored ?? {}))
  const writes: { key: string; picture: StoredPicture }[] = []
  const store = {
    entries: async () => new Map(stored),
    read: async (_group: string, _version: number, key: string) =>
      stored.has(key) ? new ArrayBuffer(4) : null,
    write: (
      _group: string,
      _version: number,
      key: string,
      _data: ArrayBuffer,
      picture: StoredPicture,
    ) => {
      writes.push({ key, picture })
      stored.set(key, picture)
    },
  } as unknown as PictureStore
  const drawn: string[] = []
  const state = {
    wanted: [] as WantedPicture[],
    idle: true,
    resolution: 1,
    turnOpen: true,
    wake: null as (() => void) | null,
    drawResult: null as (() => DrawnPicture | 'unavailable' | null) | null,
    /** The keys the source cannot make yet. */
    cannot: new Set<string>(),
    /** Every `onBusy`, in order. */
    busy: [] as boolean[],
    /** The version the source's group is of now. */
    version: 1 as number | null,
    /** While set, every draw waits for it. */
    gate: null as Promise<void> | null,
  }
  const source: PictureSource = {
    id: 'pdf',
    label: 'test',
    store,
    turn: {
      begin: (_next, wake) => {
        state.wake = wake
        return state.turnOpen
      },
      end: () => undefined,
      withdraw: () => undefined,
    },
    version: () => state.version,
    canDraw: (want) => !state.cannot.has(want.key),
    concurrency: options.concurrency,
    draw: async (want) => {
      drawn.push(want.key)
      if (state.gate) await state.gate
      return state.drawResult?.() ?? { canvas: fakeCanvas(100, 80), meta: null }
    },
  }
  // Time moves on between looks: a moving board is looked over only every
  // so often.
  let clock = 0
  const win = {
    performance: { now: () => (clock += 100) },
    createImageBitmap: async (
      from: { width?: number },
      resize?: ImageBitmapOptions,
    ) => fakeBitmap(resize?.resizeWidth ?? from.width ?? 100),
  }
  const pictures = new Pictures({
    doc: { defaultView: win } as unknown as Document,
    sources: [source],
    wanted: () => state.wanted,
    resolution: () => state.resolution,
    idle: () => state.idle,
    onChange: () => undefined,
    onBusy: (busy) => state.busy.push(busy),
    reportError: (stage, error) => {
      throw new Error(`${stage}: ${String(error)}`)
    },
    budgetBytes: options.budgetBytes,
  })
  return { pictures, state, drawn, writes, stored }
}

const want = (
  key: string,
  distance: number,
  extra: Partial<WantedPicture> = {},
): WantedPicture => ({
  source: 'pdf',
  group: 'a.pdf',
  key,
  width: 100,
  distance,
  stamp: '',
  ...extra,
})

const kept = (stamp = ''): StoredPicture => ({
  width: 100,
  height: 80,
  stamp,
  meta: null,
})

/** Lets every pending read, draw and decode land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Pumps until nothing more happens. */
async function run(pictures: Pictures): Promise<void> {
  for (let i = 0; i < 5; i++) {
    pictures.pump()
    await settle()
  }
}

describe('levels', () => {
  it('holds a picture at the smallest fraction that covers the screen', () => {
    expect(levelFor(30, 160)).toBe(0.25)
    expect(levelFor(41, 160)).toBe(0.5)
    expect(levelFor(120, 160)).toBe(1)
    expect(levelFor(500, 160)).toBe(1)
    // Whatever the picture's width: a card is as wide as it was made.
    expect(levelFor(60, 400)).toBe(0.25)
  })

  it('decodes a fraction at its width, and the whole as it is', () => {
    expect(resizedTo(0.25, 160)).toEqual({
      resizeWidth: 40,
      resizeQuality: 'medium',
    })
    expect(resizedTo(1, 160)).toBeUndefined()
  })
})

describe('Pictures', () => {
  const ref = (key: string) => ({ source: 'pdf' as const, group: 'a.pdf', key })

  it('reads kept pictures back at the level the screen shows them', async () => {
    const { pictures, state, drawn } = setup({
      stored: { '1': kept(), '2': kept() },
    })
    state.wanted = [want('1', 10), want('2', 20)]
    state.resolution = 0.3 // 30 device pixels: a quarter of 100 is not enough
    await run(pictures)

    expect(pictures.get(ref('1'))?.width).toBe(50)
    expect(pictures.get(ref('2'))?.width).toBe(50)
    expect(drawn).toEqual([])
  })

  it('makes what is not kept, nearest first, and keeps it', async () => {
    const { pictures, state, drawn, writes } = setup()
    state.wanted = [want('far', 50), want('near', 5)]
    await run(pictures)

    expect(drawn).toEqual(['near', 'far'])
    expect(writes.map((write) => write.key)).toEqual(['near', 'far'])
    expect(pictures.get(ref('near'))?.width).toBe(100)
  })

  it('makes nothing while the board moves', async () => {
    const { pictures, state, drawn } = setup()
    state.wanted = [want('1', 0)]
    state.idle = false
    await run(pictures)
    expect(drawn).toEqual([])

    state.idle = true
    await run(pictures)
    expect(drawn).toEqual(['1'])
  })

  it('makes as many at once as its source may, nearest first', async () => {
    const { pictures, state, drawn } = setup({ concurrency: 2 })
    let open: () => void = () => undefined
    state.gate = new Promise((resolve) => (open = resolve))
    state.wanted = [want('far', 30), want('near', 10), want('mid', 20)]
    await run(pictures)

    // Two under way, each once; the third waits for one of them.
    expect(drawn).toEqual(['near', 'mid'])

    state.gate = null
    open()
    await run(pictures)
    expect(drawn).toEqual(['near', 'mid', 'far'])
    expect(pictures.get(ref('far'))).not.toBeNull()
  })

  it('waits for its source to give it a turn', async () => {
    const { pictures, state, drawn } = setup()
    state.wanted = [want('1', 0)]
    state.turnOpen = false
    await run(pictures)
    expect(drawn).toEqual([])

    state.turnOpen = true
    state.wake?.()
    await settle()
    expect(drawn).toEqual(['1'])
  })

  it('passes over what its source cannot make yet, until told to look again', async () => {
    const { pictures, state, drawn } = setup()
    state.wanted = [want('near', 0), want('far', 50)]
    state.cannot.add('near')
    await run(pictures)
    expect(drawn).toEqual(['far'])

    // Nothing about the board changed: the scheduler has no reason to look.
    state.cannot.clear()
    await run(pictures)
    expect(drawn).toEqual(['far'])

    pictures.invalidate()
    await run(pictures)
    expect(drawn).toEqual(['far', 'near'])
  })

  it('shows no picture made from something else, and makes it again', async () => {
    const { pictures, state, drawn, writes } = setup({
      stored: { card: kept('old') },
    })
    // Kept, but of another version: not read back, made again.
    state.wanted = [want('card', 0, { stamp: 'new' })]
    await run(pictures)
    expect(drawn).toEqual(['card'])
    expect(writes.at(-1)?.picture.stamp).toBe('new')
    expect(pictures.get(ref('card'))).not.toBeNull()

    // The card changes: what is held of it is not it any more.
    state.wanted = [want('card', 0, { stamp: 'newer' })]
    state.turnOpen = false
    pictures.retain()
    pictures.pump()
    expect(pictures.get(ref('card'))).toBeNull()
    // The turn opens, and says so.
    state.turnOpen = true
    state.wake?.()
    await run(pictures)
    expect(drawn).toEqual(['card', 'card'])
    expect(writes.at(-1)?.picture.stamp).toBe('newer')
  })

  it('does not ask again for what could not be made until it changes', async () => {
    const { pictures, state, drawn } = setup()
    state.drawResult = () => 'unavailable'
    state.wanted = [want('9', 0, { stamp: 'a' })]
    await run(pictures)
    pictures.retain()
    await run(pictures)
    expect(drawn).toEqual(['9'])

    state.wanted = [want('9', 0, { stamp: 'b' })]
    pictures.retain()
    await run(pictures)
    expect(drawn).toEqual(['9', '9'])
  })

  it('brings a picture down a level once the board is still', async () => {
    const { pictures, state } = setup({ stored: { '1': kept() } })
    state.wanted = [want('1', 0)]
    await run(pictures)
    expect(pictures.get(ref('1'))?.width).toBe(100)

    state.resolution = 0.2
    state.idle = false
    await run(pictures)
    expect(pictures.get(ref('1'))?.width).toBe(100)

    state.idle = true
    await run(pictures)
    expect(pictures.get(ref('1'))?.width).toBe(25)
  })

  it('reads a picture up a level once the board is still', async () => {
    const { pictures, state } = setup({ stored: { '1': kept() } })
    state.wanted = [want('1', 0)]
    state.resolution = 0.2
    await run(pictures)
    expect(pictures.get(ref('1'))?.width).toBe(25)

    // Zoomed in, still moving: the small one stays up.
    state.resolution = 1
    state.idle = false
    await run(pictures)
    expect(pictures.get(ref('1'))?.width).toBe(25)

    state.idle = true
    await run(pictures)
    expect(pictures.get(ref('1'))?.width).toBe(100)
  })

  it('past its budget, lets go of the farthest for a nearer one', async () => {
    // Room for one 100×100 picture.
    const { pictures, state } = setup({
      stored: { far: kept(), near: kept() },
      budgetBytes: 100 * 100 * 4,
    })
    state.wanted = [want('far', 90)]
    await run(pictures)
    expect(pictures.get(ref('far'))).not.toBeNull()

    state.wanted = [want('far', 90), want('near', 10)]
    pictures.retain()
    await run(pictures)
    expect(pictures.get(ref('near'))).not.toBeNull()
    expect(pictures.get(ref('far'))).toBeNull()
  })

  it('treats a picture shown in several places as one, as near and as large as any of them', async () => {
    const { pictures, state, drawn } = setup({ concurrency: 2 })
    state.wanted = [want('1', 40, { width: 40 }), want('1', 0, { width: 100 })]
    state.resolution = 0.3 // 30 device pixels where it is largest
    await run(pictures)

    expect(drawn).toEqual(['1'])
    const held = pictures.get(ref('1'))
    expect(held?.width).toBe(50)
    await run(pictures)
    expect(pictures.get(ref('1'))).toBe(held)
  })

  it('past its budget, keeps a picture shown both near and far for the near one', async () => {
    // Room for two 100×100 pictures.
    const { pictures, state } = setup({
      stored: { shared: kept(), a: kept(), b: kept() },
      budgetBytes: 2 * 100 * 100 * 4,
    })
    state.wanted = [want('shared', 0), want('a', 50), want('shared', 100)]
    await run(pictures)
    const held = pictures.get(ref('shared'))
    expect(held).not.toBeNull()

    // Nearer than where it is shown far, farther than where it is shown near.
    state.wanted = [...state.wanted, want('b', 60)]
    pictures.retain()
    await run(pictures)
    expect(pictures.get(ref('shared'))).toBe(held)
    expect(pictures.get(ref('a'))).not.toBeNull()
    expect(pictures.get(ref('b'))).toBeNull()
  })

  it('past its budget, stops looking once it has done what it can', async () => {
    // Eight kept, and room for two: the first reads fill it past the budget,
    // and the rest wait to be nearer than something held.
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const { pictures, state } = setup({
      stored: Object.fromEntries(keys.map((key) => [key, kept()])),
      budgetBytes: 2 * 100 * 100 * 4,
    })
    const all = keys.map((key, i) => want(key, i * 10))
    let looks = 0
    state.wanted = {
      [Symbol.iterator]: () => {
        looks += 1
        return all[Symbol.iterator]()
      },
    } as unknown as WantedPicture[]
    await run(pictures)
    expect(pictures.get(ref('a'))).not.toBeNull()
    expect(pictures.get(ref('h'))).toBeNull()

    // A still board: nothing to look for, frame after frame.
    looks = 0
    await run(pictures)
    expect(looks).toBe(0)

    // The camera moves: what is nearest is asked again.
    all[7] = want('h', -5)
    pictures.invalidate()
    await run(pictures)
    expect(looks).toBeGreaterThan(0)
    expect(pictures.get(ref('h'))).not.toBeNull()
  })

  it('past its budget, still makes what is far and keeps it unheld', async () => {
    const { pictures, state, drawn, writes } = setup({
      stored: { near: kept() },
      budgetBytes: 100 * 100 * 4,
    })
    state.wanted = [want('near', 0)]
    await run(pictures)
    state.wanted = [want('near', 0), want('far', 90)]
    pictures.retain()
    await run(pictures)

    expect(drawn).toEqual(['far'])
    expect(writes.map((write) => write.key)).toEqual(['far'])
    expect(pictures.get(ref('near'))).not.toBeNull()
    expect(pictures.get(ref('far'))).toBeNull()
    // Kept on the device: nothing left to make.
    expect(state.busy.at(-1)).toBe(false)
  })

  it('says it is busy while there are pictures to make, moving or not', async () => {
    const { pictures, state } = setup()
    state.wanted = [want('1', 0), want('2', 5)]
    state.idle = false
    await run(pictures)
    expect(state.busy).toEqual([true])

    state.idle = true
    await run(pictures)
    expect(state.busy).toEqual([true, false])
  })

  it('is not busy reading kept pictures back', async () => {
    const { pictures, state } = setup({ stored: { '1': kept() } })
    state.wanted = [want('1', 0)]
    await run(pictures)
    expect(state.busy).toEqual([])
  })

  it('lets go of what is held of a file that changed', async () => {
    const { pictures, state } = setup({ stored: { '1': kept() } })
    state.wanted = [want('1', 0)]
    await run(pictures)
    const held = pictures.get(ref('1')) as unknown as FakeBitmap

    state.version = 2
    pictures.fileChanged('a.pdf')
    expect(pictures.get(ref('1'))).toBeNull()
    expect(held.closed).toBe(true)
  })

  it('keeps what is held of a file whose change is not its version', async () => {
    // A board's cards are named by the board's file, which saves its camera.
    const { pictures, state } = setup({ stored: { '1': kept() } })
    state.wanted = [want('1', 0)]
    await run(pictures)
    const held = pictures.get(ref('1'))

    pictures.fileChanged('a.pdf')
    expect(pictures.get(ref('1'))).toBe(held)
  })

  it('lets go of what is no longer wanted', async () => {
    const { pictures, state } = setup({ stored: { '1': kept(), '2': kept() } })
    state.wanted = [want('1', 0), want('2', 0)]
    await run(pictures)
    const held = pictures.get(ref('2')) as unknown as FakeBitmap

    state.wanted = [want('1', 0)]
    pictures.retain()
    expect(pictures.get(ref('2'))).toBeNull()
    expect(held.closed).toBe(true)
  })
})
