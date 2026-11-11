import { ARRANGE_EASE } from './canvas/motions'
import { ARRANGE_ANIMATION_EASING } from './constants'
import {
  type Tween,
  arrived,
  cubicBezier,
  liftedPose,
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
    expect(samePose(a, { ...a, rotate: 0.1 })).toBe(false)
    expect(samePose(a, { ...a, lift: 1 })).toBe(false)
  })

  it('tweens a turn and a lift back to rest', () => {
    const at = poseAt(
      tween({
        from: { x: 0, y: 0, w: 10, h: 10, opacity: 1, rotate: 0.2, lift: 1 },
        to: { x: 0, y: 0, w: 10, h: 10, opacity: 1 },
      }),
      1100,
    )
    expect(at.rotate).toBeCloseTo(0.1)
    expect(at.lift).toBeCloseTo(0.5)
  })
})

describe('liftedPose', () => {
  const lift = { centre: { x: 50, y: 25 }, scale: 1.1, rotate: 0 }

  it('grows what is carried about its middle, as one', () => {
    const card = { x: 0, y: 0, w: 100, h: 50 }
    const lifted = liftedPose(card, card, lift, 1)
    expect(lifted.x).toBeCloseTo(-5)
    expect(lifted.y).toBeCloseTo(-2.5)
    expect(lifted.w).toBeCloseTo(110)
    expect(lifted.h).toBeCloseTo(55)
    expect(lifted.lift).toBe(1)
    // A card beside it, carried with it, moves out from the same middle.
    const beside = { x: 100, y: 0, w: 100, h: 50 }
    const shown = liftedPose(beside, beside, lift, 1)
    expect(shown.x).toBeCloseTo(105)
  })

  it('goes where the drag has it', () => {
    const home = { x: 0, y: 0 }
    const live = { x: 300, y: 40, w: 100, h: 50 }
    const shown = liftedPose(home, live, lift, 1)
    expect(shown.x).toBeCloseTo(295)
    expect(shown.y).toBeCloseTo(37.5)
  })

  it('turns one card about its own centre', () => {
    const card = { x: 0, y: 0, w: 100, h: 50 }
    const shown = liftedPose(card, card, { ...lift, rotate: 0.3 }, 1)
    expect(shown.rotate).toBeCloseTo(0.3)
    expect(shown.x + shown.w / 2).toBeCloseTo(50)
    expect(shown.y + shown.h / 2).toBeCloseTo(25)
  })

  it('is where it was, not picked up at all', () => {
    const card = { x: 0, y: 0, w: 100, h: 50 }
    expect(liftedPose(card, card, { ...lift, rotate: 0.3 }, 0)).toEqual({
      ...card,
      opacity: 1,
      lift: 0,
    })
  })
})
