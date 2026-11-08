import { TypesetCards, type TypesetCardsDeps } from './typesetCards'

describe('TypesetCards turn', () => {
  it('wakes the scheduler once the board is ready for a picture it refused', () => {
    const frames: (() => void)[] = []
    const win = {
      requestAnimationFrame: (f: () => void) => frames.push(f),
      cancelAnimationFrame: () => undefined,
    }
    let ready = false
    const cards = new TypesetCards({
      doc: { defaultView: win } as unknown as Document,
      ready: () => ready,
    } as unknown as TypesetCardsDeps)
    const wake = jest.fn()
    const want = { source: 'card', group: 'b', key: 'n1' } as const
    expect(
      cards.turn.begin({ ...want, width: 100, distance: 0, stamp: 's' }, wake),
    ).toBe(false)
    frames.shift()?.()
    expect(wake).not.toHaveBeenCalled()
    ready = true
    frames.shift()?.()
    expect(wake).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(0)
  })

  it('stops looking once nothing is wanted of it', () => {
    const frames: (() => void)[] = []
    const cancelled: number[] = []
    const win = {
      requestAnimationFrame: (f: () => void) => frames.push(f),
      cancelAnimationFrame: (id: number) => cancelled.push(id),
    }
    const cards = new TypesetCards({
      doc: { defaultView: win } as unknown as Document,
      ready: () => false,
    } as unknown as TypesetCardsDeps)
    const wake = jest.fn()
    cards.turn.begin(
      {
        source: 'card',
        group: 'b',
        key: 'n1',
        width: 100,
        distance: 0,
        stamp: 's',
      },
      wake,
    )
    cards.turn.withdraw()
    expect(cancelled).toHaveLength(1)
    frames.shift()?.()
    expect(wake).not.toHaveBeenCalled()
  })
})
