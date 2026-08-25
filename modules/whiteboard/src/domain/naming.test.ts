import { generateBoardFileName } from './naming'

describe('generateBoardFileName', () => {
  it('returns the plain name when nothing collides', () => {
    expect(generateBoardFileName('Whiteboard', new Set())).toBe(
      'Whiteboard.yoloboard',
    )
  })

  it('appends " 1" on a single collision', () => {
    const existing = new Set(['Whiteboard.yoloboard'])
    expect(generateBoardFileName('Whiteboard', existing)).toBe(
      'Whiteboard 1.yoloboard',
    )
  })

  it('finds the first free numeric suffix across multiple collisions', () => {
    const existing = new Set([
      'Whiteboard.yoloboard',
      'Whiteboard 1.yoloboard',
      'Whiteboard 2.yoloboard',
    ])
    expect(generateBoardFileName('Whiteboard', existing)).toBe(
      'Whiteboard 3.yoloboard',
    )
  })

  it('leaves a gap unfilled — picks the first free suffix scanning upward, not the smallest overall', () => {
    const existing = new Set(['Whiteboard.yoloboard', 'Whiteboard 2.yoloboard'])
    expect(generateBoardFileName('Whiteboard', existing)).toBe(
      'Whiteboard 1.yoloboard',
    )
  })

  it('works for a non-Latin base name', () => {
    const existing = new Set(['白板.yoloboard'])
    expect(generateBoardFileName('白板', existing)).toBe('白板 1.yoloboard')
  })
})
