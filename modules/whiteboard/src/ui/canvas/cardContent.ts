// What a card is and shows of its markdown, built one way whether the card is
// on the board (./cardRenderer.ts) or off it, having its picture taken
// (../pictures/cardStage.ts): the same element with the same classes, the
// same slice of its source, the same one-pass render. A picture of a card
// built any other way would be a picture of some other card.

import { type BoardNode, isPlainText } from '../../domain/fileFormat'
import { PLAIN_TEXT_AUTO_CLASS } from '../constants'
import { cardMarkdownWindow } from '../lod'
import { applyColorToElement } from '../selectionToolbar'

/** The host's one-pass Markdown renderer. Named through the Host API rather
 * than imported: the module SDK exports no alias for it. */
export type CardMarkdownRenderer = ReturnType<
  YoloModuleHostApiV1['ui']['createMarkdownRenderer']
>

export const CARD_CLASS = 'yolo-whiteboard-card'
/** A text node drawn as bare text (fileFormat.ts's `plain`): a card without
 * the frame, whose box is its content's. */
export const PLAIN_TEXT_CLASS = 'yolo-whiteboard-text'
export const GROUP_CLASS = 'yolo-whiteboard-group'
export const CARD_BODY_CLASS = 'yolo-whiteboard-card-body'

/** Obsidian's own preview wrapper chain, rebuilt around a one-pass render.
 * Same classes as `createMarkdownContentView` produces, so every rule that
 * styles a card's content — Obsidian's element styling keyed off
 * `markdown-rendered`, and style.css's inset and card-scale type — applies to
 * both without a second set of selectors to keep in step. */
const PREVIEW_VIEW_CLASS = 'markdown-preview-view markdown-rendered'
const PREVIEW_SIZER_CLASS = 'markdown-preview-sizer markdown-preview-section'

/** On a node behind a portal that shows its board at another scale
 * (domain/portals.ts): styles/cards/portal.css. */
const SCALED_CLASS = 'yolo-whiteboard-node-scaled'

/** A node's element as every one starts: what it is — a group, a card, bare
 * text — its size and its colour. Where it stands, what it is titled and
 * what state it is in are the board's to add. `scale` is what it is drawn
 * at (`scaleNodeElement`): `node` is where it is seen, so its own size is
 * that over the scale. */
export function createNodeElement(
  doc: Document,
  node: BoardNode,
  scale = 1,
): HTMLElement {
  const el = doc.createElement('div')
  el.className = node.type === 'group' ? GROUP_CLASS : CARD_CLASS
  if (isPlainText(node)) {
    el.classList.add(PLAIN_TEXT_CLASS)
    el.classList.toggle(PLAIN_TEXT_AUTO_CLASS, node.autoWidth === true)
  }
  el.style.width = `${node.w / scale}px`
  el.style.height = `${node.h / scale}px`
  scaleNodeElement(el, scale)
  // JSON Canvas's `color`: a preset or a hex, both resolved to the one
  // custom property style.css paints from.
  applyColorToElement(el, node.color)
  return el
}

/**
 * Draws a node's element at `scale` from its top-left corner: a card behind
 * a portal at another scale is laid out at its own size — what it holds
 * wraps and measures as on its own board — and drawn at the portal's. The
 * CSS `scale` property, not `transform`, which animations and the arrange
 * motion write; a drag moves the card with `translate` (dragGestures.ts).
 */
export function scaleNodeElement(el: HTMLElement, scale: number): void {
  el.classList.toggle(SCALED_CLASS, scale !== 1)
  if (scale === 1) el.style.removeProperty('scale')
  else el.style.setProperty('scale', String(scale))
}

/** The scale a node's element is drawn at (`scaleNodeElement`). */
export function nodeElementScale(el: HTMLElement): number {
  const scale = Number.parseFloat(el.style.getPropertyValue('scale'))
  return scale > 0 ? scale : 1
}

/** What a card holds its content in. */
export function createCardBody(doc: Document): HTMLElement {
  const body = doc.createElement('div')
  body.className = CARD_BODY_CLASS
  return body
}

/** What a card that does not scroll shows of `markdown`: all of it for bare
 * text, which is as tall as what it holds; otherwise as much as its height
 * shows from where it starts (`cardMarkdownWindow`). */
export function clippedCardMarkdown(
  node: BoardNode | undefined,
  markdown: string,
): string {
  if (isPlainText(node)) return markdown
  const startLine =
    node && (node.type === 'text' || node.type === 'file')
      ? (node.startLine ?? 0)
      : 0
  return cardMarkdownWindow(markdown, node?.h ?? 0, startLine)
}

/**
 * Renders `markdown` once into `bodyEl`, inside the wrapper Obsidian's own
 * reading view is styled by. `rendered` resolves once the render is done
 * and the links that lead nowhere are marked, and rejects as the render
 * does — `unload()` rejects whatever is in flight. Throws when the host has
 * no renderer to give.
 */
export function renderClippedMarkdown(
  host: YoloModuleHostApiV1,
  bodyEl: HTMLElement,
  markdown: string,
  sourcePath: string,
): Readonly<{ renderer: CardMarkdownRenderer; rendered: Promise<void> }> {
  const doc = bodyEl.ownerDocument
  const view = doc.createElement('div')
  view.className = PREVIEW_VIEW_CLASS
  const sizer = doc.createElement('div')
  sizer.className = PREVIEW_SIZER_CLASS
  view.appendChild(sizer)
  bodyEl.appendChild(view)
  // In sections, as the scrollable preview mounts them: each block's element
  // says how many blank lines follow it in the source, which is what a card
  // spaces its blocks by (styles/cards/content.css).
  const renderer = host.ui.createMarkdownRenderer({ sections: true })
  const rendered = renderer
    .render(markdown, sizer, sourcePath)
    .then(() => markUnresolvedLinks(host, sizer, sourcePath))
  return { renderer, rendered }
}

/**
 * Colours the links that lead nowhere.
 *
 * `MarkdownRenderer.render` produces a view's *markup* but not a view's
 * knowledge: it writes every wiki link as a resolved one, because whether a
 * link resolves is a question about the vault and the one-pass renderer was
 * never given the vault to ask. A card showing a broken link exactly as it
 * shows a working one is telling the reader something false about their
 * notes. What `is-unresolved` then looks like is the theme's business —
 * dimmed, recoloured, or both.
 *
 * Only the one-pass render needs it — the focused card's windowed preview is
 * a real view and does this itself. Costs one query over a card's worth of
 * links and an index lookup each; no layout is read, so it can run straight
 * after the render rather than waiting for a frame.
 */
function markUnresolvedLinks(
  host: YoloModuleHostApiV1,
  root: HTMLElement,
  sourcePath: string,
): void {
  const links = root.querySelectorAll<HTMLElement>('a.internal-link')
  for (const link of Array.from(links)) {
    const linktext = link.getAttribute('data-href') ?? link.textContent
    if (!linktext) continue
    try {
      if (host.vault.resolveLink(linktext, sourcePath)) continue
    } catch {
      // The vault answers for as long as the module is active; if it has
      // stopped, this card is on its way out and its colours do not matter.
      return
    }
    link.classList.add('is-unresolved')
  }
}
