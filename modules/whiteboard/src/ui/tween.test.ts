import { ARRANGE_EASE } from './canvas/motions'
import { ARRANGE_ANIMATION_EASING } from './constants'
import {
  type Tween,
  arrived,
  cubicBezier,
  poseAt,
  poseOf,
  samePose,
  scaledAboutCentre,
} from './tween'

const tween = (overrides: Partial<Tween> = {}): Tween => ({
  from: { x: 0, y: 0, w: 100, h: 50, opacity: 1 },
  to: { x: 200, y: 100, w: 50, h: 25, opacity: 0 },
  start: 1000,
  delay: 0,
  duration: 200,
  ease: cubicBezier(0, 0, 1, 1),
  ...overrides,
})

describe('cubicBezier', () => {
  it('is the curve the arrangement plays in CSS', () => {
    expect(ARRANGE_EASE.css).toBe(ARRANGE_ANIMATION_EASING)
  })

  it('runs from 0 to 1 and holds there outside', () => {
    const ease = cubicBezier(0.22, 1, 0.36, 1)
    expect(ease.at(-1)).toBe(0)
    expect(ease.at(0)).toBe(0)
    expect(ease.at(1)).toBe(1)
    expect(ease.at(2)).toBe(1)
  })

  it('is the straight line for a linear curve, and fast out of the start for an ease-out', () => {
    expect(cubicBezier(0, 0, 1, 1).at(0.3)).toBeCloseTo(0.3, 4)
    const out = cubicBezier(0.22, 1, 0.36, 1)
    expect(out.at(0.25)).toBeGreaterThan(0.6)
    // Never back: it rises the whole way.
    let last = 0
    for (let t = 0.05; t <= 1; t += 0.05) {
      expect(out.at(t)).toBeGreaterThanOrEqual(last)
      last = out.at(t)
    }
  })
})

describe('poseAt', () => {
  it('is the start before it moves, through its delay, and the end after', () => {
    const t = tween({ delay: 50 })
    expect(poseAt(t, 900)).toEqual(t.from)
    expect(poseAt(t, 1040)).toEqual(t.from)
    expect(poseAt(t, 1300)).toEqual(t.to)
    expect(arrived(t, 1249)).toBe(false)
    expect(arrived(t, 1250)).toBe(true)
  })

  it('mixes every part of the pose by the curve', () => {
    expect(poseAt(tween(), 1100)).toEqual({
      x: 100,
      y: 50,
      w: 75,
      h: 37.5,
      opacity: 0.5,
    })
  })

  it('is at the end at once with no duration', () => {
    const t = tween({ duration: 0 })
    expect(poseAt(t, 1000)).toEqual(t.to)
  })
})

describe('poses', () => {
  it('shows a rectangle whole', () => {
    expect(poseOf({ x: 1, y: 2, w: 3, h: 4 })).toEqual({
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      opacity: 1,
    })
  })

  it('scales a card about its centre', () => {
    expect(scaledAboutCentre({ x: 0, y: 0, w: 100, h: 50 }, 0.5, 0)).toEqual({
      x: 25,
      y: 12.5,
      w: 50,
      h: 25,
      opacity: 0,
    })
  })

  it('takes poses a hundredth apart for the same', () => {
    const a = { x: 0, y: 0, w: 10, h: 10, opacity: 1 }
    expect(samePose(a, { ...a, x: 0.005 })).toBe(true)
    expect(samePose(a, { ...a, x: 0.5 })).toBe(false)
  })
})
