import type { DrawOp } from './layout'
import { paint } from './paint'

const context = () => {
  const calls: string[] = []
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push(
        `${name}(${args.map((a) => (typeof a === 'number' ? String(a) : 'img')).join(',')})`,
      )
  const ctx = new Proxy(
    {},
    {
      get: (_target, key: string) =>
        ['drawImage', 'fillRect'].includes(key) ? record(key) : () => undefined,
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

const image: DrawOp = {
  op: 'image',
  x: 1,
  y: 2,
  w: 30,
  h: 20,
  target: 'a.png',
  radius: 0,
  color: '#eee',
}

const options = {
  scale: 1,
  width: 100,
  height: 100,
  fade: 0,
  clip: { left: 0, right: 0 },
}

describe('paint', () => {
  test('an image there is a bitmap of is drawn where it is laid out', () => {
    const { ctx, calls } = context()
    const bitmap = {} as CanvasImageSource
    paint(ctx, [image], { ...options, images: { 'a.png': bitmap } })
    expect(calls).toEqual(['drawImage(img,1,2,30,20)'])
  })

  test('one there is none of keeps its place', () => {
    const { ctx, calls } = context()
    paint(ctx, [image], options)
    expect(calls).toEqual(['fillRect(1,2,30,20)'])
  })
})
