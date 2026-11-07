// DEBUG(p4): checks what the typesetter lays out against what the browser
// does, card by card. Each card is built the way the board builds one
// (../canvas/cardContent.ts) on a stage that is laid out but never seen, and
// every character it shows is found there and in the typesetter's runs: a
// character on another line, or more than a pixel away, is a difference.
//
// Reached from the console through the scene's canvas while the GPU scene
// is developed; it goes when the switch does.

import { type BoardNode, isPlainText } from '../../domain/fileFormat'
import { contentClip } from '../../typeset/tokens'
import {
  clippedCardMarkdown,
  createCardBody,
  createNodeElement,
  renderClippedMarkdown,
} from '../canvas/cardContent'
import type { TypesetStyle } from '../pictures/typesetStyle'
import type { TypesetClient } from '../typesetting/typesetClient'
import { RUN_FIELDS } from '../typesetting/typesetProtocol'

import type { DrawnText } from './passages'

const STAGE_CLASS = 'yolo-whiteboard-typeset-sample'
const FULL_WIDTH_MARKS = new Set(
  Array.from('，。、；：）」』】》〉〕〗｝（「『【《〈〔〖｛“”‘’·・'),
)
/** How far a character may be from where the browser puts it, px. */
const TOLERANCE = 1.5
/** How far apart two baselines may be: drawn text a fraction of a pixel
 * off moves when a card goes from one to the other. */
const BASELINE_TOLERANCE = 0.25

export type TypesetCheckDeps = Readonly<{
  host: YoloModuleHostApiV1
  root: HTMLElement
  sourcePath: string
  nodes: readonly BoardNode[]
  drawnText: (id: string) => DrawnText | null
  drawable: (id: string) => boolean
  typesetter: TypesetClient
  style: TypesetStyle
}>

const SHOW_CLASS = 'yolo-whiteboard-typeset-show'

/** Shows a card as the browser lays it out beside what the typesetter
 * draws of it, at `scale`, over the board's top-left corner; again with no
 * card, takes it down. */
export async function showTypeset(
  deps: TypesetCheckDeps,
  id: string | null,
  scale = 1,
): Promise<boolean> {
  const doc = deps.root.ownerDocument
  deps.root.querySelector(`.${SHOW_CLASS}`)?.remove()
  const node = deps.nodes.find((n) => n.id === id)
  const tokens = deps.style.tokens
  const hash = deps.style.hash
  if (!node || !tokens || hash === null) return false
  const markdown = await markdownOf(deps.host, node)
  if (markdown === null) return false
  const clipped = clippedCardMarkdown(node, markdown)
  const show = doc.createElement('div')
  show.className = SHOW_CLASS
  Object.assign(show.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    zIndex: '1000',
    display: 'flex',
    gap: `${16 * scale}px`,
    padding: `${16 * scale}px`,
    background: 'var(--yolo-whiteboard-board-background)',
  })
  const holder = doc.createElement('div')
  Object.assign(holder.style, {
    position: 'relative',
    width: `${node.w * scale}px`,
    height: `${node.h * scale}px`,
  })
  const card = createNodeElement(doc, { ...node, x: 0, y: 0 })
  Object.assign(card.style, { left: '0', top: '0', transformOrigin: '0 0' })
  card.style.setProperty('scale', String(scale))
  const body = createCardBody(doc)
  card.appendChild(body)
  holder.appendChild(card)
  const canvas = doc.createElement('canvas')
  const dpr = doc.defaultView?.devicePixelRatio ?? 1
  canvas.width = Math.round(node.w * scale * dpr)
  canvas.height = Math.round(node.h * scale * dpr)
  Object.assign(canvas.style, {
    width: `${node.w * scale}px`,
    height: `${node.h * scale}px`,
  })
  show.append(holder, canvas)
  deps.root.appendChild(show)
  const render = renderClippedMarkdown(
    deps.host,
    body,
    clipped,
    deps.sourcePath,
  )
  await render.rendered
  const picture = await deps.typesetter.picture(
    { tokens, hash },
    {
      id: node.id,
      markdown: clipped,
      w: node.w,
      h: node.h,
      plain: node.type === 'text' && node.plain === true,
      color: null,
    },
    scale * dpr,
    24,
  )
  canvas.getContext('2d')?.drawImage(picture, 0, 0)
  picture.close()
  return true
}

type Placed = { ch: string; x: number; y: number; runStart: boolean }

export type TypesetDifference = Readonly<{
  id: string
  drawable: boolean
  /** What the card holds that a difference may come from. */
  kinds: readonly string[]
  /** `text`: the characters differ; `line`: a character is on another
   * line; `place`: on its line, but somewhere else. */
  problem: 'text' | 'line' | 'place'
  /** Where it starts: the character, and both places. */
  at: number
  context: string
  dom: Readonly<{ x: number; y: number }> | null
  typeset: Readonly<{ x: number; y: number }> | null
}>

export async function checkTypeset(
  deps: TypesetCheckDeps,
  ids?: readonly string[],
): Promise<{ checked: number; differences: TypesetDifference[] }> {
  const wanted = ids ? new Set(ids) : null
  const nodes = deps.nodes.filter(
    (node) =>
      (!wanted || wanted.has(node.id)) && deps.drawnText(node.id) !== null,
  )
  const differences: TypesetDifference[] = []
  const doc = deps.root.ownerDocument
  const stage = doc.createElement('div')
  stage.className = STAGE_CLASS
  deps.root.appendChild(stage)
  try {
    for (const node of nodes) {
      const drawn = deps.drawnText(node.id)
      const markdown = await markdownOf(deps.host, node)
      if (!drawn || markdown === null) continue
      const card = createNodeElement(doc, node)
      const body = createCardBody(doc)
      card.appendChild(body)
      stage.appendChild(card)
      const render = renderClippedMarkdown(
        deps.host,
        body,
        clippedCardMarkdown(node, markdown),
        deps.sourcePath,
      )
      try {
        await render.rendered
        const tokens = deps.style.tokens
        const clip = tokens
          ? contentClip(tokens, isPlainText(node))
          : { left: 0, right: 0 }
        const found = compare(
          domPlaces(card, node),
          typesetPlaces(drawn, clip.left, node.w - clip.right, node.h - 1),
        )
        if (found) {
          differences.push({
            id: node.id,
            drawable: deps.drawable(node.id),
            kinds: kindsOf(body),
            ...found,
          })
        }
      } finally {
        render.renderer.unload()
        card.remove()
      }
    }
  } finally {
    stage.remove()
  }
  return { checked: nodes.length, differences }
}

async function markdownOf(
  host: YoloModuleHostApiV1,
  node: BoardNode,
): Promise<string | null> {
  if (node.type === 'text') return node.text
  if (node.type !== 'file') return null
  try {
    return await host.vault.readText(node.file)
  } catch {
    return null
  }
}

/** Every character the card shows, where the browser put it: what the
 * card, or a box inside it that clips (a table's section), cuts off is not
 * shown. */
function domPlaces(card: HTMLElement, node: BoardNode): Placed[] {
  const origin = card.getBoundingClientRect()
  const doc = card.ownerDocument
  const win = doc.defaultView
  const walker = doc.createTreeWalker(card, NodeFilter.SHOW_TEXT)
  const range = doc.createRange()
  const out: Placed[] = []
  // A character's box is its font's, whatever line it is on: its baseline
  // is that far below the box's top, found once per font on a mark that
  // sits on the baseline.
  const drops = new Map<string, number>()
  const dropOf = (el: Element): number => {
    const font = win?.getComputedStyle(el).font ?? ''
    const known = drops.get(font)
    if (known !== undefined) return known
    const probe = doc.createElement('div')
    Object.assign(probe.style, {
      position: 'absolute',
      visibility: 'hidden',
      whiteSpace: 'pre',
      font,
    })
    const mark = doc.createElement('span')
    Object.assign(mark.style, {
      display: 'inline-block',
      width: '0',
      height: '0',
    })
    probe.append(mark, 'x')
    card.appendChild(probe)
    const glyph = doc.createRange()
    glyph.setStart(probe.lastChild as Text, 0)
    glyph.setEnd(probe.lastChild as Text, 1)
    const drop =
      mark.getBoundingClientRect().top - glyph.getBoundingClientRect().top
    probe.remove()
    drops.set(font, drop)
    return drop
  }
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const value = text.nodeValue ?? ''
    let clipLeft = 0
    let clipRight = node.w
    let clipBottom = node.h
    for (
      let el = text.parentElement;
      el && el !== card && win;
      el = el.parentElement
    ) {
      const style = win.getComputedStyle(el)
      const box = el.getBoundingClientRect()
      if (style.overflowX !== 'visible') {
        clipLeft = Math.max(clipLeft, box.left - origin.left)
        clipRight = Math.min(clipRight, box.right - origin.left)
      }
      if (style.overflowY !== 'visible') {
        clipBottom = Math.min(clipBottom, box.bottom - origin.top)
      }
    }
    const drop = text.parentElement ? dropOf(text.parentElement) : 0
    let i = 0
    for (const ch of value) {
      const at = i
      i += ch.length
      if (/\s/.test(ch)) continue
      range.setStart(text, at)
      range.setEnd(text, i)
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      const x = rect.left - origin.left
      // Shown when its baseline is: the same test for the typesetter's.
      const y = rect.top - origin.top + drop
      if (x < clipLeft - TOLERANCE || x >= clipRight || y >= clipBottom) {
        continue
      }
      out.push({ ch, x, y, runStart: false })
    }
  }
  return out
}

/** Every character the typesetter drew, where it put it: a run's first at
 * its left edge, the rest only on its line. */
function typesetPlaces(
  drawn: DrawnText,
  clipLeft: number,
  clipRight: number,
  clipBottom: number,
): Placed[] {
  const out: Placed[] = []
  const { runs, shown } = drawn
  for (let r = 0; r + RUN_FIELDS <= runs.length; r += RUN_FIELDS) {
    const [start, end, left, , right, , baseline] = runs.subarray(
      r,
      r + RUN_FIELDS,
    )
    // Where each character starts, near enough to tell whether the clip
    // cuts it off: the run's width shared out evenly.
    const chars = Array.from(shown.slice(start, end))
    const each = (right - left) / Math.max(1, chars.length)
    // Its left edge is its first character's only when that is not a
    // space.
    let first = true
    chars.forEach((ch, i) => {
      const x = left + each * i
      if (
        /\s/.test(ch) ||
        x < clipLeft - TOLERANCE ||
        x >= clipRight ||
        baseline >= clipBottom
      ) {
        first = false
        return
      }
      out.push({ ch, x: left, y: baseline, runStart: first })
      first = false
    })
  }
  return out
}

function compare(
  dom: readonly Placed[],
  typeset: readonly Placed[],
): Omit<TypesetDifference, 'id' | 'drawable' | 'kinds'> | null {
  const context = (i: number) =>
    dom
      .slice(Math.max(0, i - 8), i + 8)
      .map((p) => p.ch)
      .join('')
  const n = Math.min(dom.length, typeset.length)
  for (let i = 0; i < n; i += 1) {
    if (dom[i].ch !== typeset[i].ch) {
      return {
        problem: 'text',
        at: i,
        context: `${context(i)} ≠ ${typeset
          .slice(Math.max(0, i - 8), i + 8)
          .map((p) => p.ch)
          .join('')}`,
        dom: dom[i],
        typeset: typeset[i],
      }
    }
  }
  if (dom.length !== typeset.length) {
    return {
      problem: 'text',
      at: n,
      context: `${dom.length} shown, ${typeset.length} drawn`,
      dom: dom[n] ?? null,
      typeset: typeset[n] ?? null,
    }
  }
  // Lines: where each begins, in both.
  for (let i = 1; i < n; i += 1) {
    const domBreak = dom[i].y > dom[i - 1].y + TOLERANCE
    const typesetBreak = typeset[i].y > typeset[i - 1].y + TOLERANCE
    if (domBreak !== typesetBreak) {
      // The line it ends, in each.
      const line = (places: readonly Placed[]) => {
        let from = i - 1
        while (from > 0 && places[from - 1].y >= places[i - 1].y - TOLERANCE) {
          from -= 1
        }
        let to = i
        while (to < n && places[to].y <= places[i - 1].y + TOLERANCE) to += 1
        return places
          .slice(from, to)
          .map((p) => p.ch)
          .join('')
      }
      return {
        problem: 'line',
        at: i,
        context: `${line(dom)} | ${line(typeset)}`,
        dom: dom[i],
        typeset: typeset[i],
      }
    }
  }
  // Where a line and a run start: baselines, the browser's and the
  // typesetter's.
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(dom[i].y - typeset[i].y) > BASELINE_TOLERANCE) {
      return {
        problem: 'place',
        at: i,
        context: context(i),
        dom: dom[i],
        typeset: typeset[i],
      }
    }
    // After a full-width mark that gave up half its em, the browser and the
    // typesetter take that half from different sides of the pair: the ink
    // lands in the same place, the boxes do not.
    const afterMark = i > 0 && FULL_WIDTH_MARKS.has(dom[i - 1].ch)
    if (
      typeset[i].runStart &&
      !afterMark &&
      Math.abs(dom[i].x - typeset[i].x) > TOLERANCE
    ) {
      return {
        problem: 'place',
        at: i,
        context: context(i),
        dom: dom[i],
        typeset: typeset[i],
      }
    }
  }
  return null
}

function kindsOf(body: HTMLElement): string[] {
  const kinds: Array<[string, string]> = [
    ['table', 'table'],
    ['list', 'ul, ol'],
    ['task', 'input[type=checkbox]'],
    ['quote', 'blockquote'],
    ['callout', '.callout'],
    ['code', 'pre'],
    ['heading', 'h1, h2, h3, h4, h5, h6'],
    ['image', 'img'],
    ['rule', 'hr'],
    ['math', '.math'],
    ['embed', '.internal-embed:not(.image-embed)'],
  ]
  return kinds
    .filter(([, selector]) => body.querySelector(selector) !== null)
    .map(([kind]) => kind)
}
