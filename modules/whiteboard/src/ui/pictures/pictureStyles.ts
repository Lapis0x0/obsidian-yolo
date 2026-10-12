// The styles a card's picture of itself is shown with (./cardPictures.ts),
// and the style environment the picture is of.
//
// An SVG image sees none of the document's stylesheets: a picture has to
// carry its own. Carrying them all — a theme, Obsidian's own, every plugin's,
// 1.3 MB — cost each picture 37 ms on the main thread in one go. Cut down to
// what each card's copy matches, the cutting itself cost 20–55 ms a card.
// What works is one cut-down stylesheet shared by every picture on the board
// (about 30 KB): about 7 ms a picture, in two short steps, and the same
// pixels as the whole set.
//
// It is built once per style environment, from a pass over every rule
// spread across idle slices (./idle.ts), and grows as pictures show it
// classes, elements, ids and attributes it has not seen (./selectorNeeds.ts):
// a rule is in it once one of its selectors could match something a picture
// has shown.
// Keyframes and fonts are left out: a picture is still, and a font a theme
// brings with it falls back to the system's in a picture (an SVG image loads
// nothing) — accepted, rather than putting the font in every picture. The
// theme's variables, read off the board, go in as one rule on the picture's
// frame, as many of them as its rules use.
//
// The environment is what a picture's look depends on besides its card:
// the stylesheets, the body's classes (light or dark, the theme's own) and
// the variables set on the body itself (the font size). Its hash is part of
// every card picture's stamp, so a change to any of them — another theme, a
// snippet, a font size — makes every picture stale, and switching back makes
// the kept ones right again. Watched for: the body's classes and style, and
// the style elements in the document's head and the board's own.
//
// What the body says of the window rather than the look — focused, full
// screen, a drag — is left out of it (`WINDOW_STATE_CLASSES`). The
// variables the board resolves are not hashed: they follow from what is,
// and from those classes too — a drag sets `--no-tooltip`, a progress bar
// the titlebar's colours — so hashing them let the window's state back in.
// They are read once per environment, and every picture of it has them.
//
// Only the document's head and the board's own stylesheet count: a style
// element inside another view styles that view, and counting it would make
// every picture stale whenever such a view opened.
//
// MathJax's stylesheets (`isMathSheet`) are how a formula is drawn, not the
// look: Obsidian loads MathJax when a formula is first rendered, which then
// puts them in the head, and adds a rule to them for every glyph it meets —
// by `insertRule`, which changes neither their text nor the DOM. Counted,
// every picture went stale the first time a board drew a formula, each
// launch. Every rule in them styles only MathJax's own elements (measured),
// so they are no part of the environment; they are read afresh instead for
// each picture (`readMath`), glyphs met since included.
//
// A stylesheet is named by a hash of its text, which runs to most of a
// million characters for a theme: named once, a slice at a time, and the
// name kept until its element changes.
//
// Popout safety: everything is the board's own document's and window's.

import { TextHasher, hashText } from '../../domain/hash'

import type { IdleSlices } from './idle'
import { type SelectorNeeds, meets, selectorListNeeds } from './selectorNeeds'

/** How long one idle slice may spend going over rules or text. */
const SLICE_BUDGET_MS = 5
/** Characters of a stylesheet hashed between looks at the clock. */
const HASH_CHUNK = 32_768
/** The longest attribute value a selector is matched against by value. */
const MAX_MATCHED_VALUE = 200

/** The body's classes that are the window's state, not the look: a window
 * focused, full screen, maximized, popped out; a drag, a progress bar, the
 * mobile toolbar and navigation coming and going. The first ones are those
 * Obsidian itself keeps per window when it mirrors the main window's body
 * onto a popout's. A picture is taken without them, and its stamp leaves
 * them out: else every focus change made every picture stale, and each
 * card's one kept picture was taken again for each state in turn. */
const WINDOW_STATE_CLASSES: ReadonlySet<string> = new Set([
  'is-focused',
  'is-fullscreen',
  'is-maximized',
  'is-popout-window',
  'is-grabbing',
  'in-progress',
  'mod-toolbar-open',
  'is-hidden-nav',
  'is-screenshotting',
])
/** Likewise the custom properties Obsidian sets on the body and keeps per
 * window: the zoom, and the mobile keyboard's height. */
const WINDOW_STATE_VARS: ReadonlySet<string> = new Set([
  '--zoom-factor',
  '--keyboard-height',
])

/** The body's classes `className` without the window's state. */
export function lookClasses(className: string): string {
  return className
    .split(/\s+/)
    .filter((name) => name !== '' && !WINDOW_STATE_CLASSES.has(name))
    .join(' ')
}

/** The custom properties set on the body's own style, without the
 * window's state, as text. */
export function lookVars(style: CSSStyleDeclaration): string {
  let text = ''
  for (let i = 0; i < style.length; i += 1) {
    const name = style[i]
    if (!name.startsWith('--') || WINDOW_STATE_VARS.has(name)) continue
    text += `${name}:${style.getPropertyValue(name).trim()};`
  }
  return text
}

/** Whether a stylesheet's element is one of MathJax's. */
export function isMathSheet(owner: Node): boolean {
  return (owner as Partial<Element>).id?.startsWith('MJX-') === true
}

/** What a card picture is of, besides its card. */
export type StyleEnvironment = Readonly<{
  /** Names the environment, in every picture's stamp. */
  hash: string
  /** The body's classes but the window's state (`lookClasses`), which the
   * picture's frame wears. */
  bodyClass: string
  /** The custom properties the board resolves, by name. */
  vars: ReadonlyMap<string, string>
  /** The type and colour the board's text starts from. */
  font: Readonly<{
    family: string
    size: string
    lineHeight: string
    color: string
  }>
}>

/** A rule a picture may need, with what it needs. */
type Candidate = {
  readonly rule: CSSRule
  /** The grouping rules it sits in, outermost first (`@media …`). */
  readonly wrap: readonly string[]
  /** What each of its selectors needs; null when it is always kept. */
  readonly needs: readonly SelectorNeeds[] | null
  kept: boolean
  text: string | null
}

/** A stylesheet that counts, named by what it holds. */
type NamedSheet = Readonly<{ sheet: CSSStyleSheet; name: string }>

type Index = {
  readonly env: StyleEnvironment
  readonly candidates: Candidate[]
  /** What pictures have shown. */
  readonly classes: Set<string>
  readonly tags: Set<string>
  readonly ids: Set<string>
  readonly attributes: Set<string>
  /** Custom properties used by inline styles of what pictures showed. */
  readonly inlineVars: Set<string>
  /** MathJax's stylesheets as last read, in document order, each with how
   * many rules it had then (`readMath`). */
  math: readonly MathSheet[]
  css: string | null
}

type MathSheet = Readonly<{
  sheet: CSSStyleSheet
  size: number
  candidates: Candidate[]
}>

export type PictureStylesDeps = Readonly<{
  doc: Document
  /** The board's own stylesheet, which lives in the board's view rather
   * than the document's head. */
  boardStyle: HTMLStyleElement
  /** Where the theme's variables are read: the board's world layer. */
  varsFrom: HTMLElement
  slices: IdleSlices
  /** The environment changed (or was first known): every card picture's
   * stamp has. */
  onChange: () => void
  reportError: (stage: string, error: unknown) => void
}>

export class PictureStyles {
  private env: StyleEnvironment | null = null
  /** The stylesheets `env` is of. */
  private sheets: readonly NamedSheet[] = []
  /** Each style element's name for its text, until its text changes. */
  private readonly names = new WeakMap<Node, string>()
  private index: Promise<Index | null> | null = null
  /** A look at the environment is owed (`refresh`). */
  private refreshing = false
  private again = false
  private destroyed = false
  private readonly observers: MutationObserver[] = []

  constructor(private readonly deps: PictureStylesDeps) {
    const win = deps.doc.defaultView
    if (win) {
      const changed = () => this.refresh()
      // Only what touches a stylesheet: the head also holds the window's
      // title, which changes with every file opened.
      const head = new win.MutationObserver((records) => {
        let touched = false
        for (const record of records) {
          for (const node of stylesTouched(record)) {
            this.names.delete(node)
            touched = true
          }
        }
        if (touched) this.refresh()
      })
      head.observe(deps.doc.head, {
        childList: true,
        subtree: true,
        characterData: true,
      })
      const body = new win.MutationObserver(changed)
      body.observe(deps.doc.body, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      })
      const own = new win.MutationObserver(() => {
        this.names.delete(deps.boardStyle)
        this.refresh()
      })
      own.observe(deps.boardStyle, {
        childList: true,
        characterData: true,
        subtree: true,
      })
      this.observers.push(head, body, own)
    }
    this.refresh()
  }

  /** The environment; null until it is first known. */
  get environment(): StyleEnvironment | null {
    return this.env
  }

  /**
   * The stylesheet for a picture of `frame` — the copy, in the frame it is
   * shown in — kept up to date with what `frame` shows. Null when the
   * environment changed meanwhile, or this is destroyed: the picture would
   * be of another one.
   */
  async sheetFor(frame: Element): Promise<string | null> {
    const env = this.env
    if (!env) return null
    this.index ??= this.build(env)
    const index = await this.index
    if (!index || index.env !== this.env) return null
    this.learn(index, frame)
    this.readMath(index)
    index.css ??= this.compose(index)
    return index.css
  }

  destroy(): void {
    this.destroyed = true
    for (const observer of this.observers) observer.disconnect()
    this.observers.length = 0
  }

  /** Looks at the environment again, in an idle slice: on a change, the
   * stylesheet is built anew when next asked for. */
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
        // The board's own stylesheet arrives a moment after the board
        // (canvas.ts's `ensureDom`): what a picture made before it would
        // show is no card's look. Its arrival is a change, and comes back
        // here.
        if (!this.deps.boardStyle.textContent) return
        const sheets = await this.namedSheets()
        if (!sheets) return
        if (!(await this.deps.slices.next())) return
        const env = this.read(hashText(sheets.map((s) => s.name).join('\n')))
        if (env.hash === this.env?.hash) continue
        this.env = env
        this.sheets = sheets
        this.index = null
        this.deps.onChange()
      } while (this.again && !this.destroyed)
    })()
      .catch((error: unknown) => this.deps.reportError('picture styles', error))
      .finally(() => {
        this.refreshing = false
      })
  }

  /**
   * The stylesheets that count, each named by what it holds, in document
   * order: a sheet from a file by its address, any other by its text, hashed
   * in idle slices where it has not been yet. Null if this is destroyed on
   * the way.
   */
  private async namedSheets(): Promise<NamedSheet[] | null> {
    const doc = this.deps.doc
    const win = doc.defaultView
    if (!win) return null
    let until = win.performance.now() + SLICE_BUDGET_MS
    const seen = new Set<string>()
    const out: NamedSheet[] = []
    for (const sheet of Array.from(doc.styleSheets)) {
      const owner = sheet.ownerNode
      if (!owner || isMathSheet(owner)) continue
      if (owner !== this.deps.boardStyle && !doc.head.contains(owner)) continue
      let name =
        sheet.href !== null ? `href:${sheet.href}` : this.names.get(owner)
      if (name === undefined) {
        const text = owner.textContent ?? ''
        const hasher = new TextHasher()
        for (let at = 0; at < text.length; at += HASH_CHUNK) {
          if (win.performance.now() >= until) {
            if (!(await this.deps.slices.next())) return null
            until = win.performance.now() + SLICE_BUDGET_MS
          }
          hasher.update(text, at, Math.min(text.length, at + HASH_CHUNK))
        }
        name = hasher.digest()
        this.names.set(owner, name)
      }
      // The same stylesheet twice — the board's own, in two boards open
      // side by side — styles nothing twice.
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ sheet, name })
    }
    return out
  }

  private read(sheets: string): StyleEnvironment {
    const doc = this.deps.doc
    const win = doc.defaultView
    const vars = new Map<string, string>()
    const computed = win?.getComputedStyle(this.deps.varsFrom)
    if (computed) {
      for (let i = 0; i < computed.length; i += 1) {
        const name = computed[i]
        if (name.startsWith('--')) {
          vars.set(name, computed.getPropertyValue(name).trim())
        }
      }
    }
    const body = win?.getComputedStyle(doc.body)
    const font = {
      family: body?.fontFamily ?? 'sans-serif',
      size: body?.fontSize ?? '16px',
      lineHeight: body?.lineHeight ?? 'normal',
      color: body?.color ?? '#000',
    }
    const bodyClass = lookClasses(doc.body.className)
    const hash = hashText(
      `${bodyClass}\n${lookVars(doc.body.style)}\n${font.family}\n${font.size}\n${font.lineHeight}\n${font.color}`,
      sheets,
    )
    return { hash, bodyClass, vars, font }
  }

  /** Every rule a picture might need, gone over in idle slices. */
  private async build(env: StyleEnvironment): Promise<Index | null> {
    const index: Index = {
      env,
      candidates: [],
      classes: new Set(),
      tags: new Set(),
      ids: new Set(),
      attributes: new Set(),
      inlineVars: new Set(),
      math: [],
      css: null,
    }
    const win = this.deps.doc.defaultView
    if (!win) return null
    const pending = this.sheets.map(({ sheet }) => ({
      rules: rulesOf(sheet),
      wrap: [] as string[],
    }))
    // Depth first, in document order: the order the cascade reads them in.
    const stack: { rules: CSSRule[]; at: number; wrap: string[] }[] = []
    for (const sheet of pending.reverse()) {
      stack.push({ rules: sheet.rules, at: 0, wrap: sheet.wrap })
    }
    while (stack.length > 0) {
      if (!(await this.deps.slices.next())) return null
      if (env !== this.env) return null
      const until = win.performance.now() + SLICE_BUDGET_MS
      while (stack.length > 0 && win.performance.now() < until) {
        // A few rules between looks at the clock.
        for (let n = 0; n < 32 && stack.length > 0; n += 1) {
          const top = stack[stack.length - 1]
          if (top.at >= top.rules.length) {
            stack.pop()
            continue
          }
          const rule = top.rules[top.at]
          top.at += 1
          const nested = this.visit(rule, top.wrap, index.candidates)
          if (nested) stack.push(nested)
        }
      }
    }
    return index
  }

  /** Files `rule` among the candidates, or answers the rules it groups. */
  private visit(
    rule: CSSRule,
    wrap: string[],
    candidates: Candidate[],
  ): { rules: CSSRule[]; at: number; wrap: string[] } | null {
    // Read by constructor name rather than `instanceof`: the rules are the
    // board's window's, whose constructors a popout does not share.
    switch (rule.constructor.name) {
      case 'CSSStyleRule': {
        const needs = selectorListNeeds((rule as CSSStyleRule).selectorText)
        if (needs.length > 0) {
          candidates.push({ rule, wrap, needs, kept: false, text: null })
        }
        return null
      }
      case 'CSSMediaRule':
        return grouped(rule, [
          ...wrap,
          `@media ${(rule as CSSMediaRule).media.mediaText}`,
        ])
      case 'CSSSupportsRule':
        return grouped(rule, [
          ...wrap,
          `@supports ${(rule as CSSSupportsRule).conditionText}`,
        ])
      case 'CSSContainerRule':
        return grouped(rule, [
          ...wrap,
          `@container ${(rule as CSSConditionRule).conditionText}`,
        ])
      case 'CSSLayerBlockRule': {
        const name = (rule as CSSLayerBlockRule).name
        return grouped(rule, [...wrap, name ? `@layer ${name}` : '@layer'])
      }
      case 'CSSImportRule': {
        const sheet = (rule as CSSImportRule).styleSheet
        return sheet ? { rules: rulesOf(sheet), at: 0, wrap } : null
      }
      case 'CSSLayerStatementRule':
      case 'CSSNamespaceRule':
      case 'CSSPropertyRule':
      case 'CSSCounterStyleRule':
        candidates.push({ rule, wrap, needs: null, kept: true, text: null })
        return null
      default:
        // Keyframes, fonts, pages, and whatever a picture cannot use.
        return null
    }
  }

  /** Adds what `frame` shows to what pictures have shown, and keeps the
   * rules that now might match. */
  private learn(index: Index, frame: Element): void {
    let grew = false
    const add = (set: Set<string>, value: string): void => {
      if (set.has(value)) return
      set.add(value)
      grew = true
    }
    const visit = (el: Element): void => {
      for (const name of Array.from(el.classList)) add(index.classes, name)
      add(index.tags, el.localName.toLowerCase())
      if (el.id) add(index.ids, el.id)
      for (const attribute of Array.from(el.attributes)) {
        add(index.attributes, attribute.name)
        // By value too, for a selector that compares with `=` — but not
        // the long ones no selector names: an inlined image, a style.
        if (attribute.value.length <= MAX_MATCHED_VALUE) {
          add(index.attributes, `${attribute.name}=${attribute.value}`)
        }
      }
      const inline = el.getAttribute('style')
      if (inline?.includes('var(')) {
        for (const name of varsIn(inline)) {
          if (!index.inlineVars.has(name)) {
            index.inlineVars.add(name)
            index.css = null
          }
        }
      }
    }
    visit(frame)
    for (const el of Array.from(frame.querySelectorAll('*'))) visit(el)
    if (!grew) return
    for (const candidate of index.candidates) this.keepIfMet(index, candidate)
    for (const { candidates } of index.math) {
      for (const candidate of candidates) this.keepIfMet(index, candidate)
    }
  }

  private keepIfMet(index: Index, candidate: Candidate): void {
    if (candidate.kept || !candidate.needs) return
    if (candidate.needs.some((needs) => meets(needs, index))) {
      candidate.kept = true
      index.css = null
    }
  }

  /** MathJax's stylesheets as they are now: one that came, or has grown
   * since last read, is read again — a few hundred rules, at once. */
  private readMath(index: Index): void {
    const doc = this.deps.doc
    const math: MathSheet[] = []
    for (const sheet of Array.from(doc.styleSheets)) {
      const owner = sheet.ownerNode
      if (!owner || !isMathSheet(owner) || !doc.head.contains(owner)) continue
      const rules = rulesOf(sheet)
      const known = index.math.find((read) => read.sheet === sheet)
      if (known?.size === rules.length) {
        math.push(known)
        continue
      }
      const candidates: Candidate[] = []
      const walk = (list: CSSRule[], wrap: string[]): void => {
        for (const rule of list) {
          const nested = this.visit(rule, wrap, candidates)
          if (nested) walk(nested.rules, nested.wrap)
        }
      }
      walk(rules, [])
      for (const candidate of candidates) this.keepIfMet(index, candidate)
      math.push({ sheet, size: rules.length, candidates })
      index.css = null
    }
    if (math.length !== index.math.length) index.css = null
    index.math = math
  }

  /** The kept rules in cascade order, and the frame's rule with the
   * variables they use. */
  private compose(index: Index): string {
    const parts: string[] = []
    const candidates = [
      ...index.candidates,
      ...index.math.flatMap((read) => read.candidates),
    ]
    for (const candidate of candidates) {
      if (!candidate.kept) continue
      candidate.text ??= candidate.wrap.reduceRight(
        (inner, wrapper) => `${wrapper} { ${inner} }`,
        candidate.rule.cssText,
      )
      parts.push(candidate.text)
    }
    const rules = parts.join('\n')
    const { vars, font } = index.env
    // The variables the kept rules and the copies' own styles use, and
    // the ones those use in turn.
    const used = new Set([...varsIn(rules), ...index.inlineVars])
    const queue = [...used]
    while (queue.length > 0) {
      const value = vars.get(queue.pop() ?? '')
      if (!value?.includes('var(')) continue
      for (const name of varsIn(value)) {
        if (used.has(name)) continue
        used.add(name)
        queue.push(name)
      }
    }
    let frame = ''
    for (const name of used) {
      const value = vars.get(name)
      if (value !== undefined) frame += `${name}: ${value}; `
    }
    frame += `font-family: ${font.family}; font-size: ${font.size}; line-height: ${font.lineHeight}; color: ${font.color};`
    return `${rules}\n.${PICTURE_FRAME_CLASS} { ${frame} }`
  }
}

/** The element a card picture's copy is shown in (./cardPictures.ts). */
export const PICTURE_FRAME_CLASS = 'yolo-whiteboard-picture-frame'

function grouped(
  rule: CSSRule,
  wrap: string[],
): { rules: CSSRule[]; at: number; wrap: string[] } {
  return { rules: Array.from((rule as CSSGroupingRule).cssRules), at: 0, wrap }
}

function rulesOf(sheet: CSSStyleSheet): CSSRule[] {
  try {
    return Array.from(sheet.cssRules)
  } catch {
    // Another origin's stylesheet: not readable, and nothing of the
    // board's.
    return []
  }
}

/** The style elements a change in the head was to. */
function stylesTouched(record: MutationRecord): Node[] {
  const isStyle = (node: Node | null): node is Node =>
    node !== null && (node.nodeName === 'STYLE' || node.nodeName === 'LINK')
  if (record.type === 'characterData') {
    const parent = record.target.parentNode
    return isStyle(parent) ? [parent] : []
  }
  // A style element's text replaced, or a style element come or gone.
  if (isStyle(record.target)) return [record.target]
  return [
    ...Array.from(record.addedNodes).filter(isStyle),
    ...Array.from(record.removedNodes).filter(isStyle),
  ]
}

function varsIn(text: string): string[] {
  return Array.from(text.matchAll(/var\(\s*(--[\w-]+)/g), (match) => match[1])
}
