// The values the board is drawn with that have to be written twice: once in
// a stylesheet, for the DOM, and once in TypeScript, for the overview canvas,
// the GPU scene and the Web Animations — a stylesheet cannot read a constant,
// and a canvas cannot read a stylesheet. Written twice, they drift: the card
// a hand draws stops matching the one another hand draws beside it, or after
// it. These hold each pair together (modules/whiteboard/AGENTS.md).

/* eslint-disable import/no-nodejs-modules -- test reads the stylesheets the constants mirror */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
/* eslint-enable import/no-nodejs-modules */

import { ARRANGE_EASE } from './canvas/motions'
import {
  ARRANGE_ANIMATION_EASING,
  ARRANGE_ANIMATION_MS,
  CARD_RADIUS,
  GROUP_RADIUS,
  NODE_EXIT_MS,
  SHEET_RADIUS,
  TITLE_BLOCK_LINE_HEIGHT,
  TITLE_BLOCK_WORLD_FONT_PX,
  TITLE_BLOCK_WORLD_PADDING,
} from './constants'

const STYLES = join(__dirname, '..', 'styles')
const HOST_MOTION = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'src',
  'styles',
  'tokens',
  'motion.css',
)

/** The value `property` is given in the rule for exactly `selector`. */
function declared(file: string, selector: string, property: string): string {
  const css = readFileSync(file, 'utf8')
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) throw new Error(`${selector} is not in ${file}`)
  const block = css.slice(start, css.indexOf('\n}', start))
  const match = new RegExp(`^\\s*${property}:\\s*([^;]+);`, 'm').exec(block)
  if (!match) throw new Error(`${selector} sets no ${property} in ${file}`)
  return match[1].trim()
}

const px = (value: string): number => {
  if (value === '0') return 0
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value)
  if (!match) throw new Error(`${value} is not in px`)
  return Number(match[1])
}

describe('values written in both a stylesheet and TypeScript', () => {
  it("a card's corners", () => {
    const css = join(STYLES, 'cards', 'card.css')
    expect(px(declared(css, '.yolo-whiteboard-card', 'border-radius'))).toBe(
      CARD_RADIUS,
    )
  })

  it("a spread's sheet's corners", () => {
    const css = join(STYLES, 'cards', 'spread.css')
    expect(
      px(
        declared(
          css,
          '.yolo-whiteboard-card.yolo-whiteboard-spread-sheet',
          'border-radius',
        ),
      ),
    ).toBe(SHEET_RADIUS)
  })

  it("a group's corners, open and collapsed", () => {
    const css = join(STYLES, 'cards', 'group.css')
    expect(px(declared(css, '.yolo-whiteboard-group', 'border-radius'))).toBe(
      GROUP_RADIUS.open,
    )
    expect(
      px(
        declared(
          css,
          '.yolo-whiteboard-group.yolo-whiteboard-group-collapsed',
          'border-radius',
        ),
      ),
    ).toBe(GROUP_RADIUS.folded)
  })

  it("a card's title block", () => {
    const css = join(STYLES, 'cards', 'title.css')
    const selector = '.yolo-whiteboard-card-title-block'
    expect(px(declared(css, selector, 'font-size'))).toBe(
      TITLE_BLOCK_WORLD_FONT_PX,
    )
    expect(Number(declared(css, selector, 'line-height'))).toBe(
      TITLE_BLOCK_LINE_HEIGHT,
    )
    const [y, x] = declared(css, selector, 'padding').split(/\s+/).map(px)
    expect({ x, y }).toEqual(TITLE_BLOCK_WORLD_PADDING)
  })

  it("the host's motion tokens", () => {
    expect(
      ms(declared(HOST_MOTION, ':root', '--yolo-anim-duration-enter')),
    ).toBe(ARRANGE_ANIMATION_MS)
    expect(
      ms(declared(HOST_MOTION, ':root', '--yolo-anim-duration-exit')),
    ).toBe(NODE_EXIT_MS)
    expect(declared(HOST_MOTION, ':root', '--yolo-anim-ease-out')).toBe(
      ARRANGE_ANIMATION_EASING,
    )
  })

  it('the curve the motions sample and the one their Web Animations play', () => {
    expect(ARRANGE_EASE.css).toBe(ARRANGE_ANIMATION_EASING)
  })
})

function ms(value: string): number {
  const match = /^(\d+)ms$/.exec(value)
  if (!match) throw new Error(`${value} is not in ms`)
  return Number(match[1])
}
