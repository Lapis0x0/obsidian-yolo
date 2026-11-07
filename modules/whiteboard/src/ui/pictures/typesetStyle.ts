// How a card looks, read off a card (../../typeset/tokens.ts): the host
// renders a fixed sample into a card built the way the board builds one
// (../canvas/cardContent.ts), on a stage that is laid out but never seen, and
// the typesetter's numbers — type, colours, insets, where a bullet sits — are
// read off what came out. So what the typesetter draws follows the
// stylesheet (styles/cards/content.css) and whatever a theme still adds on
// top of it, with no second copy of either to keep in step.
//
// Read again whenever the look may have changed: a stylesheet added,
// removed or edited in the document's head or the board's own, the body's
// classes or style (light and dark, the theme's own classes, the font size).
// The tokens' hash is in every typeset picture's stamp
// (./typesetCards.ts), so pictures made in another look are made again.
//
// Popout safety: everything is the board's own document's and window's.

import { hashText } from '../../domain/hash'
import type {
  BorderSide,
  CellBorders,
  TableAlign,
  TextStyle,
  TypesetTokens,
} from '../../typeset/tokens'
import {
  createCardBody,
  createNodeElement,
  renderClippedMarkdown,
} from '../canvas/cardContent'

import type { IdleSlices } from './idle'

const STAGE_CLASS = 'yolo-whiteboard-typeset-sample'
const SCROLLBAR_PROBE_CLASS = 'yolo-whiteboard-scrollbar-probe'

/** The callout types Obsidian colours apart. */
const CALLOUT_TYPES = [
  'note',
  'abstract',
  'info',
  'todo',
  'tip',
  'success',
  'question',
  'warning',
  'failure',
  'danger',
  'bug',
  'example',
  'quote',
] as const

const SAMPLE = [
  '# H',
  '## H',
  '### H',
  '#### H',
  '##### H',
  '###### H',
  '',
  'Body **bold** `code` [link](https://example.com) #tag ==mark==',
  '',
  '- bullet',
  '',
  '1. one',
  '',
  '- [ ] todo',
  '- [x] done',
  '',
  '> quote',
  '',
  ...CALLOUT_TYPES.flatMap((type) => [`> [!${type}] T`, '> c', '']),
  '```',
  'code',
  '```',
  '',
  '| h | h |',
  '| - | - |',
  '| c | c |',
  '| c | c |',
  '',
  '---',
].join('\n')

export type TypesetStyleDeps = Readonly<{
  host: YoloModuleHostApiV1
  /** The board's root element: the sample is built inside it, under the
   * rules the board's own cards are. */
  root: HTMLElement
  /** The board's own stylesheet. */
  boardStyle: HTMLStyleElement
  slices: IdleSlices
  /** What links in the sample resolve against. */
  sourcePath: () => string
  /** The tokens changed (or were first known). */
  onChange: () => void
  reportError: (stage: string, error: unknown) => void
}>

export class TypesetStyle {
  private current: Readonly<{ tokens: TypesetTokens; hash: string }> | null =
    null
  private readonly observers: MutationObserver[] = []
  /** Watches the scrollbar's width (`SCROLLBAR_PROBE_CLASS`). */
  private probe: Readonly<{
    el: HTMLElement
    observer: ResizeObserver
  }> | null = null
  private refreshing = false
  private again = false
  private destroyed = false

  constructor(private readonly deps: TypesetStyleDeps) {
    const doc = deps.root.ownerDocument
    const win = doc.defaultView
    if (win) {
      const changed = () => this.refresh()
      // Only what touches a stylesheet: the head also holds the window's
      // title, which changes with every file opened.
      const head = new win.MutationObserver((records) => {
        if (records.some(touchesStyles)) this.refresh()
      })
      head.observe(doc.head, {
        childList: true,
        subtree: true,
        characterData: true,
      })
      const body = new win.MutationObserver(changed)
      body.observe(doc.body, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      })
      const own = new win.MutationObserver(changed)
      own.observe(deps.boardStyle, {
        childList: true,
        characterData: true,
        subtree: true,
      })
      this.observers.push(head, body, own)
      // A card's lines wrap short of the gutter its preview keeps for a
      // scrollbar, and how wide that is changes with no stylesheet changing:
      // the system shows scrollbars over content or beside it, and switches
      // when a mouse comes and goes. A box that keeps the same gutter
      // narrows or widens with it.
      const el = doc.createElement('div')
      el.className = SCROLLBAR_PROBE_CLASS
      deps.root.appendChild(el)
      let width: number | null = null
      const observer = new win.ResizeObserver(() => {
        const next = el.clientWidth
        if (width !== null && next !== width) this.refresh()
        width = next
      })
      observer.observe(el)
      this.probe = { el, observer }
    }
    this.refresh()
  }

  /** The tokens; null until first read. */
  get tokens(): TypesetTokens | null {
    return this.current?.tokens ?? null
  }

  /** Names the tokens, in every typeset picture's stamp; null until read. */
  get hash(): string | null {
    return this.current?.hash ?? null
  }

  destroy(): void {
    this.destroyed = true
    for (const observer of this.observers) observer.disconnect()
    this.observers.length = 0
    this.probe?.observer.disconnect()
    this.probe?.el.remove()
    this.probe = null
  }

  private refresh(): void {
    if (this.destroyed) return
    if (this.refreshing) {
      this.again = true
      return
    }
    this.refreshing = true
    void (async () => {
      do {
        this.again = false
        if (!(await this.deps.slices.next())) return
        // The board's own stylesheet arrives a moment after the board: a
        // read before it would be of no card's look. Its arrival comes back
        // here.
        if (!this.deps.boardStyle.textContent) return
        const tokens = await this.read()
        if (!tokens || this.destroyed) return
        const hash = hashText(JSON.stringify(tokens))
        if (hash === this.current?.hash) continue
        this.current = { tokens, hash }
        this.deps.onChange()
      } while (this.again && !this.destroyed)
    })()
      .catch((error: unknown) => this.deps.reportError('typeset style', error))
      .finally(() => {
        this.refreshing = false
      })
  }

  /** Builds the sample, reads it, takes it down. */
  private async read(): Promise<TypesetTokens | null> {
    const { host, root } = this.deps
    const doc = root.ownerDocument
    const stage = doc.createElement('div')
    stage.className = STAGE_CLASS
    const card = createNodeElement(doc, {
      id: 'typeset-sample',
      type: 'text',
      text: '',
      x: 0,
      y: 0,
      w: 400,
      h: 4000,
      extra: {},
    })
    const plain = createNodeElement(doc, {
      id: 'typeset-sample-plain',
      type: 'text',
      text: '',
      plain: true,
      x: 0,
      y: 0,
      w: 400,
      h: 200,
      extra: {},
    })
    const body = createCardBody(doc)
    const plainBody = createCardBody(doc)
    card.appendChild(body)
    plain.appendChild(plainBody)
    stage.append(card, plain)
    root.appendChild(stage)
    const sourcePath = this.deps.sourcePath()
    const renders = [
      renderClippedMarkdown(host, body, SAMPLE, sourcePath),
      renderClippedMarkdown(host, plainBody, 'Body', sourcePath),
    ]
    try {
      await Promise.all(renders.map((r) => r.rendered))
      if (this.destroyed) return null
      return measureSample(card, plain)
    } finally {
      for (const r of renders) r.renderer.unload()
      stage.remove()
    }
  }
}

function touchesStyles(record: MutationRecord): boolean {
  const isStyle = (node: Node): boolean =>
    node.nodeName === 'STYLE' || node.nodeName === 'LINK'
  if (record.type === 'characterData') {
    return record.target.parentNode?.nodeName === 'STYLE'
  }
  if (isStyle(record.target)) return true
  return (
    Array.from(record.addedNodes).some(isStyle) ||
    Array.from(record.removedNodes).some(isStyle)
  )
}

/** Whether a computed colour paints nothing. */
const isClear = (color: string): boolean =>
  color === 'transparent' || /,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color)

const px = (value: string): number => {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/** How much wider an external link is than its text: whatever a theme
 * adds after it — an icon as a background and padding, or a pseudo-element
 * with a margin. */
function linkIconWidth(link: Element | null): number {
  const text = link?.firstChild
  if (!link || !text) return 0
  const range = link.ownerDocument.createRange()
  range.selectNodeContents(text)
  const extra =
    link.getBoundingClientRect().width - range.getBoundingClientRect().width
  return Math.max(0, extra)
}

/** An emoji's advance in `el`'s em, as the browser lays it out there. */
function emojiEm(el: Element | null, size: number): number {
  if (!el || size <= 0) return 1
  const probe = el.ownerDocument.createElement('span')
  probe.textContent = '✅✅'
  el.prepend(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  return width > 0 ? width / 2 / size : 1
}

/** Where `el`'s first line of text starts. */
function textStart(el: Element): DOMRect | null {
  const doc = el.ownerDocument
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue
    const range = doc.createRange()
    range.selectNodeContents(node)
    const rect = range.getClientRects()[0]
    if (rect) return rect
  }
  return null
}

export function measureSample(
  card: HTMLElement,
  plainCard: HTMLElement,
): TypesetTokens | null {
  const doc = card.ownerDocument
  const win = doc.defaultView
  const view = card.querySelector<HTMLElement>('.markdown-preview-view')
  if (!win || !view) return null
  const cs = (el: Element, pseudo?: string) => win.getComputedStyle(el, pseudo)
  const q = <T extends Element = HTMLElement>(selector: string): T | null =>
    view.querySelector<T>(selector)
  /** A colour a custom property resolves to, as `color` computes it. */
  const resolve = (expr: string): string => {
    const probe = doc.createElement('span')
    probe.style.color = expr
    view.appendChild(probe)
    const color = cs(probe).color
    probe.remove()
    return color
  }
  /** An embedded image's frame, as the theme draws one: on an image put
   * where an embed puts it, for the sample has no image of its own. */
  const imageFrame = (): TypesetTokens['image'] => {
    const p = doc.createElement('p')
    const embed = doc.createElement('span')
    embed.className = 'internal-embed media-embed image-embed is-loaded'
    const img = doc.createElement('img')
    embed.appendChild(img)
    p.appendChild(embed)
    ;(view.querySelector('.markdown-preview-sizer') ?? view).appendChild(p)
    const style = cs(img)
    const frame = {
      border: {
        width: style.borderTopStyle === 'none' ? 0 : px(style.borderTopWidth),
        color: style.borderTopColor,
      },
      radius: px(style.borderTopLeftRadius),
    }
    p.remove()
    return frame
  }
  const textStyle = (el: Element | null, fallback?: TextStyle): TextStyle => {
    if (!el) {
      if (fallback) return fallback
      throw new Error('typeset sample: missing element')
    }
    const style = cs(el)
    const size = px(style.fontSize)
    const lineHeight =
      style.lineHeight === 'normal' ? size * 1.2 : px(style.lineHeight)
    return {
      family: style.fontFamily,
      size,
      weight: Number.parseInt(style.fontWeight, 10) || 400,
      italic: style.fontStyle === 'italic',
      color: style.color,
      lineHeight,
      baseline: baselineOf(el, style),
    }
  }
  /** Where `el`'s first line has its baseline, below its content's top: a
   * mark of no size put at its start sits on it. */
  const baselineOf = (el: Element, style: CSSStyleDeclaration): number => {
    const mark = doc.createElement('span')
    Object.assign(mark.style, {
      display: 'inline-block',
      width: '0',
      height: '0',
    })
    el.insertBefore(mark, el.firstChild)
    const top =
      el.getBoundingClientRect().top +
      px(style.borderTopWidth) +
      px(style.paddingTop)
    const baseline = mark.getBoundingClientRect().top - top
    mark.remove()
    return baseline
  }

  /** From a card's edge to its content: border and padding, and the gutter
   * the preview keeps for a scrollbar (`scrollbar-gutter`), which the text
   * wraps short of. */
  const insetOf = (outer: HTMLElement, preview: HTMLElement) => {
    const outerBox = outer.getBoundingClientRect()
    const box = preview.getBoundingClientRect()
    const style = cs(preview)
    return {
      top: box.top + px(style.paddingTop) - outerBox.top,
      left: box.left + px(style.paddingLeft) - outerBox.left,
      right:
        outerBox.right -
        (box.left + preview.clientWidth - px(style.paddingRight)),
      bottom: outerBox.bottom - box.bottom,
    }
  }
  const inset = insetOf(card, view)
  const plainView = plainCard.querySelector<HTMLElement>(
    '.markdown-preview-view',
  )
  const plainInset = plainView ? insetOf(plainCard, plainView) : inset
  const contentLeft =
    view.getBoundingClientRect().left + px(cs(view).paddingLeft)
  // Where lines end: short of the scrollbar's gutter too (`insetOf`).
  const contentRight = card.getBoundingClientRect().right - inset.right

  const p = q('.el-p p')
  const body = textStyle(p)
  const headings = [1, 2, 3, 4, 5, 6].map((n) =>
    textStyle(q(`h${n}`), body),
  ) as unknown as TypesetTokens['headings']

  const pill = (el: HTMLElement | null) => {
    const style = el ? cs(el) : null
    return {
      color: style?.color ?? body.color,
      background: style?.backgroundColor ?? 'transparent',
      scale: style ? px(style.fontSize) / body.size : 1,
      family:
        style && style.fontFamily !== body.family ? style.fontFamily : null,
      padX: style ? px(style.paddingLeft) : 0,
      radius: style ? px(style.borderTopLeftRadius) : 0,
    }
  }

  // Lists: the bullet item's text is where every item's text is measured
  // from.
  const bulletItem = q('.el-ul > ul:not(.contains-task-list) > li')
  const bulletText = bulletItem ? textStart(bulletItem) : null
  const bulletX = bulletText?.left ?? contentLeft + 24
  const marker = bulletItem ? cs(bulletItem, '::marker') : null
  const markerSize = marker ? px(marker.fontSize) : body.size
  const numberItem = q('.el-ol > ol > li')
  const measure = doc.createElement('canvas').getContext('2d')
  let space = body.size * 0.25
  if (measure) {
    measure.font = `${body.weight} ${body.size}px ${body.family}`
    space = measure.measureText(' ').width
  }

  const box = q<HTMLInputElement>('input.task-list-item-checkbox:not(:checked)')
  const checked = q<HTMLInputElement>('input.task-list-item-checkbox:checked')
  const taskItem = q('li.task-list-item:not(.is-checked)')
  const doneItem = q('li.task-list-item.is-checked')
  const taskText = taskItem ? textStart(taskItem) : null
  const boxRect = box?.getBoundingClientRect()

  const quote = q('.el-blockquote blockquote')
  const quoteText = quote ? textStart(quote) : null

  const callout = q('.callout[data-callout="note"]')
  const calloutTitle = callout?.querySelector('.callout-title') ?? null
  const calloutBody = callout?.querySelector('.callout-content p') ?? null
  const calloutTitleText =
    callout?.querySelector('.callout-title-inner') ?? null
  const types: Record<string, { color: string; background: string }> = {}
  for (const type of CALLOUT_TYPES) {
    const el = q(`.callout[data-callout="${type}"]`)
    const title = el?.querySelector('.callout-title')
    if (!el || !title) continue
    types[type] = {
      color: cs(title).color,
      background: cs(el).backgroundColor,
    }
  }

  const pre = q('.el-pre:not(.mod-frontmatter) pre')
  const code = pre?.querySelector('code') ?? null
  const codeStyle = code ? textStyle(code) : body
  const mark = q('mark')
  const table = q('.el-table table')
  const th = q('th')
  const td = q('td')
  const bodyRows = table ? Array.from(table.querySelectorAll('tbody > tr')) : []
  /** What a row's first cell is filled with: its own fill, or its row's,
   * or the table's. */
  const fillOf = (row: Element | null | undefined): string => {
    const cell = row?.firstElementChild
    for (const el of [cell, row, table]) {
      if (!el) continue
      const color = cs(el).backgroundColor
      if (!isClear(color)) return color
    }
    return 'transparent'
  }
  const sideOf = (
    style: CSSStyleDeclaration,
    side: 'Top' | 'Right' | 'Bottom' | 'Left',
  ): BorderSide => ({
    width:
      style.getPropertyValue(`border-${side.toLowerCase()}-style`) === 'none'
        ? 0
        : px(style.getPropertyValue(`border-${side.toLowerCase()}-width`)),
    color: style.getPropertyValue(`border-${side.toLowerCase()}-color`),
  })
  const bordersOf = (el: Element | null | undefined): CellBorders => {
    const none = { width: 0, color: 'transparent' }
    if (!el) return [none, none, none, none]
    const style = cs(el)
    return [
      sideOf(style, 'Top'),
      sideOf(style, 'Right'),
      sideOf(style, 'Bottom'),
      sideOf(style, 'Left'),
    ]
  }
  const alignOf = (el: Element | null): TableAlign => {
    const align = el ? cs(el).textAlign : 'start'
    return align === 'center'
      ? 'center'
      : align === 'right' || align === 'end'
        ? 'right'
        : 'left'
  }
  const cellMinWidth = (el: Element | null): number => {
    if (!el) return 0
    const style = cs(el)
    const min = px(style.minWidth)
    if (style.boxSizing === 'border-box') return min
    return (
      min +
      px(style.paddingLeft) +
      px(style.paddingRight) +
      px(style.borderLeftWidth) +
      px(style.borderRightWidth)
    )
  }
  const hr = q('hr')

  return {
    inset,
    plainInset,
    body,
    headings,
    boldWeight: Number.parseInt(cs(q('strong') ?? view).fontWeight, 10) || 700,
    linkColor: cs(q('a.external-link') ?? view).color,
    linkIcon: linkIconWidth(q('a.external-link')),
    highlight: {
      background: cs(q('mark') ?? view).backgroundColor,
      padX: mark ? px(cs(mark).paddingLeft) : 0,
      padY: mark ? px(cs(mark).paddingTop) : 0,
      radius: mark ? px(cs(mark).borderTopLeftRadius) : 2,
    },
    muted: resolve('var(--text-muted)'),
    code: pill(q('.el-p p > code')),
    tag: pill(q('a.tag')),
    list: {
      indent: bulletX - contentLeft,
      // Chrome's disc: a third of the marker's em across, its centre a
      // little under three quarters of an em before the text (measured off
      // the pixels).
      bulletX: -0.717 * markerSize,
      bulletRadius: markerSize / 6,
      bulletColor: marker?.color ?? body.color,
      numberRight: -space,
      numberColor: numberItem ? cs(numberItem, '::marker').color : body.color,
      padY: bulletItem ? px(cs(bulletItem).paddingTop) : 0,
    },
    task: {
      boxX: boxRect ? boxRect.left - bulletX : -24,
      size: boxRect?.width ?? 15,
      radius: box ? px(cs(box).borderTopLeftRadius) : 4,
      border: box ? cs(box).borderTopColor : body.color,
      borderWidth: box ? px(cs(box).borderTopWidth) : 1,
      checked:
        checked && !isClear(cs(checked).backgroundColor)
          ? cs(checked).backgroundColor
          : null,
      mark:
        checked && !isClear(cs(checked).backgroundColor)
          ? resolve('var(--checkbox-marker-color)')
          : box
            ? cs(box).borderTopColor
            : body.color,
      textX: taskText ? taskText.left - bulletX : 0,
      doneColor: doneItem ? cs(doneItem).color : body.color,
      doneStrike: doneItem
        ? cs(doneItem).textDecorationLine.includes('line-through')
        : false,
    },
    quote: {
      left: quote ? quote.getBoundingClientRect().left - contentLeft : 0,
      right: quote ? contentRight - quote.getBoundingClientRect().right : 0,
      barWidth: quote ? px(cs(quote).borderLeftWidth) : 0,
      barColor: quote ? cs(quote).borderLeftColor : body.color,
      indent:
        quote && quoteText
          ? quoteText.left - quote.getBoundingClientRect().left
          : 24,
      color: textStyle(quote?.querySelector('p') ?? quote, body).color,
    },
    callout: {
      radius: callout ? px(cs(callout).borderTopLeftRadius) : 8,
      padX:
        callout && calloutTitle
          ? calloutTitle.getBoundingClientRect().left -
            callout.getBoundingClientRect().left
          : 12,
      padY:
        callout && calloutTitle
          ? calloutTitle.getBoundingClientRect().top -
            callout.getBoundingClientRect().top
          : 12,
      padBottom:
        callout && calloutBody
          ? callout.getBoundingClientRect().bottom -
            calloutBody.getBoundingClientRect().bottom
          : 12,
      titleGap:
        calloutTitle && calloutBody
          ? Math.max(
              0,
              calloutBody.getBoundingClientRect().top -
                calloutTitle.getBoundingClientRect().bottom,
            )
          : 0,
      title: calloutTitleText
        ? textStyle(calloutTitleText, body)
        : { ...body, weight: 600 },
      titleIndent:
        calloutTitle && calloutTitleText
          ? calloutTitleText.getBoundingClientRect().left -
            calloutTitle.getBoundingClientRect().left
          : body.size * 1.5,
      icon:
        callout?.querySelector('.callout-icon svg')?.getBoundingClientRect()
          .width || body.size,
      types,
    },
    codeBlock: {
      family: codeStyle.family,
      size: codeStyle.size,
      lineHeight: codeStyle.lineHeight,
      baseline: codeStyle.baseline,
      color: codeStyle.color,
      background: pre ? cs(pre).backgroundColor : 'transparent',
      radius: pre ? px(cs(pre).borderTopLeftRadius) : 0,
      padX:
        pre && code
          ? code.getBoundingClientRect().left - pre.getBoundingClientRect().left
          : 16,
      padY:
        (pre ? px(cs(pre).paddingTop) : 0) +
        (code ? px(cs(code).paddingTop) : 0),
      wrap: code ? cs(code).whiteSpace.includes('wrap') : true,
    },
    table: {
      frame: table
        ? sideOf(cs(table), 'Top')
        : { width: 0, color: 'transparent' },
      collapse: table ? cs(table).borderCollapse === 'collapse' : true,
      spacing: table ? px(cs(table).borderSpacing) : 0,
      borders: {
        header: {
          first: bordersOf(th?.parentElement?.firstElementChild),
          last: bordersOf(th?.parentElement?.lastElementChild),
        },
        body: {
          first: bordersOf(bodyRows[0]?.firstElementChild),
          last: bordersOf(bodyRows[0]?.lastElementChild),
        },
      },
      padX: th ? px(cs(th).paddingLeft) : 8,
      padY: th ? px(cs(th).paddingTop) : 4,
      marginY: table ? px(cs(table).marginTop) : 0,
      header: textStyle(th, body),
      cell: textStyle(td, body),
      headerAlign: alignOf(th),
      align: alignOf(td),
      headerMinWidth: cellMinWidth(th),
      minWidth: cellMinWidth(td),
      headerBackground: fillOf(th?.parentElement),
      rowBackgrounds: [fillOf(bodyRows[0]), fillOf(bodyRows[1])],
    },
    rule: {
      color: hr ? cs(hr).borderTopColor : body.color,
      thickness: hr ? px(cs(hr).borderTopWidth) : 1,
    },
    embed: pre ? cs(pre).backgroundColor : 'transparent',
    image: imageFrame(),
    emoji: emojiEm(p, body.size),
  }
}
