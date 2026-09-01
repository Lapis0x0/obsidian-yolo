// The second place in the repository that reaches into Obsidian's internals
// (see obsidianMarkdownEditor.ts for the first, and for the house style this
// file follows).
//
// `MarkdownRenderer.render()` renders a whole document in one pass and hands
// back a flat tree. That is fine for a paragraph and wrong for a card that may
// hold a five-thousand-line note: everything is parsed, every image decoded,
// every post-processor run, all of it kept in the DOM. Obsidian does not do
// that anywhere it shows a document — its preview keeps only the sections
// inside a window around the scroll position mounted, faking the rest of the
// height with a spacer.
//
// That windowing lives in `MarkdownPreviewRenderer`, and every instance of the
// *exported* `MarkdownRenderer` class builds one internally. So the route here
// is not to reimplement it: subclass `MarkdownRenderer`, hand it a container,
// and feed it text. Obsidian's own Canvas text nodes are driven exactly this
// way — text pushed in through the renderer rather than read from a file — so
// this is a supported shape of its own component, not an invention.
//
// What is private: `MarkdownRenderer` is declared abstract with a two-argument
// `MarkdownRenderChild` constructor, while the real one takes
// `(app, containerEl, renderOnInsert)`; and the `renderer` it builds is not
// declared at all. Both are asserted at construction and reported by name when
// a future Obsidian changes shape — never quietly worked around.

import { type App, type Component, MarkdownRenderer, TFile } from 'obsidian'

import { getNodeWindow } from '../../utils/dom/window-context'

/**
 * The windowing renderer, as much of it as we drive.
 *
 * `set` replaces the text and queues a render; `onResize` re-measures the
 * viewport and re-picks the mounted window of sections. Nothing else here
 * needs to know how either works.
 *
 * `getScroll` and `applyScrollDelayed` are Obsidian's own pair, and they speak
 * in fractional source lines rather than pixels — the unit a Markdown view
 * uses to hold its source and preview panes together. The borrowed editor in
 * `obsidianMarkdownEditor.ts` answers in the same one.
 *
 * The *delayed* apply, not the plain one, because a scroll target only exists
 * once there are measured sections to find it among: a preview asked to go to
 * a line before its first render simply stays where it is. Obsidian's own
 * answer to that is this method — it tries, and on failure retries when the
 * render lands. Every scroll this file applies arrives on a preview that was
 * built a moment ago, so the plain one would be wrong every time. Its third
 * argument is called on both paths, and is the only way to know which one was
 * taken; the second is the highlight/centre options Obsidian passes for a
 * scroll that came from a search hit, and nothing here wants them.
 */
type ObsidianMarkdownPreviewRenderer = {
  set(text: string): void
  onResize(): void
  getScroll(): number
  applyScrollDelayed(line: number, options?: unknown, onDone?: () => void): void
}

/**
 * The exported `MarkdownRenderer`, described by what it really is at runtime
 * rather than by its abstract declaration. `file` is deliberately absent: it
 * is the one member the subclass below supplies, and declaring it here would
 * only force the subclass to widen it back.
 */
type ObsidianMarkdownRendererInstance = Component & {
  renderer: ObsidianMarkdownPreviewRenderer
}

type ObsidianMarkdownRendererClass = new (
  app: App,
  containerEl: HTMLElement,
  /**
   * Whether the first render is triggered by the preview element entering a
   * document. Always true here: a card is built before it is placed, so
   * insertion is the only moment at which the container has a size to render
   * against.
   */
  renderOnInsert: boolean,
) => ObsidianMarkdownRendererInstance

export type ObsidianMarkdownContentViewOptions = {
  container: HTMLElement
  /**
   * The vault path the content is written in the context of — what `[[links]]`
   * and embeds resolve against. Read back through `file` on every render, so
   * it must name the document the text *belongs to*: the note itself for a
   * card backed by a file, the board for text stored inside a board.
   */
  sourcePath: string
  value: string
}

export type ObsidianMarkdownContentViewHandle = {
  setValue(text: string): void
  getScrollLine(): number
  scrollToLine(line: number, onSettled?: () => void): void
  destroy(): void
}

class ObsidianMarkdownContentViewUnavailableError extends Error {
  constructor(step: string, cause?: unknown) {
    const detail =
      cause === undefined
        ? ''
        : ` (${cause instanceof Error ? cause.message : 'unknown error'})`
    super(
      `Obsidian's Markdown content view is unavailable: ${step}${detail}. This build of Obsidian no longer exposes the preview renderer the host borrows.`,
    )
    this.name = 'ObsidianMarkdownContentViewUnavailableError'
  }
}

/**
 * Confirms a freshly constructed instance still carries the windowing renderer
 * and the component lifecycle we drive it through. Checked per instance rather
 * than on the class: the renderer is built in the constructor, and the
 * lifecycle members come from further up the prototype chain.
 */
export function assertMarkdownRendererInstance(
  instance: unknown,
): asserts instance is ObsidianMarkdownRendererInstance {
  const value = instance as Partial<ObsidianMarkdownRendererInstance> | null
  if (!value || typeof value !== 'object') {
    throw new ObsidianMarkdownContentViewUnavailableError(
      'constructing the Markdown renderer produced no instance',
    )
  }
  for (const method of ['load', 'unload'] as const) {
    if (typeof value[method] !== 'function') {
      throw new ObsidianMarkdownContentViewUnavailableError(
        `the Markdown renderer is not a component (no ${method}())`,
      )
    }
  }
  const renderer = value.renderer
  if (!renderer || typeof renderer !== 'object') {
    throw new ObsidianMarkdownContentViewUnavailableError(
      'the Markdown renderer built no preview renderer',
    )
  }
  for (const method of [
    'set',
    'onResize',
    'getScroll',
    'applyScrollDelayed',
  ] as const) {
    if (typeof renderer[method] !== 'function') {
      throw new ObsidianMarkdownContentViewUnavailableError(
        `the preview renderer has no ${method}()`,
      )
    }
  }
}

type ContentViewContext = {
  app: App
  sourcePath: string
}

/**
 * Resolves the subclass, once per process.
 *
 * Lazily, because `class … extends` evaluates its base immediately: taken at
 * module scope this would demand `MarkdownRenderer` merely to import the
 * module UI capability. Cached because the answer cannot change while Obsidian
 * is running.
 */
let contentViewClass:
  | (new (
      app: App,
      containerEl: HTMLElement,
      context: ContentViewContext,
    ) => ObsidianMarkdownRendererInstance)
  | null = null

function resolveContentViewClass(): new (
  app: App,
  containerEl: HTMLElement,
  context: ContentViewContext,
) => ObsidianMarkdownRendererInstance {
  if (contentViewClass) return contentViewClass
  const exported: unknown = MarkdownRenderer
  if (typeof exported !== 'function') {
    throw new ObsidianMarkdownContentViewUnavailableError(
      'Obsidian exports no MarkdownRenderer class',
    )
  }
  const Base = exported as ObsidianMarkdownRendererClass

  class MarkdownContentView extends Base {
    // Assigned after `super()`, so the getter has to tolerate being asked
    // during construction; it is not, today, but a component that reads its
    // own `file` while building would otherwise fail confusingly.
    private context: ContentViewContext | undefined

    constructor(
      app: App,
      containerEl: HTMLElement,
      context: ContentViewContext,
    ) {
      super(app, containerEl, true)
      this.context = context
    }

    /**
     * Read on every render pass, which is why this resolves the path each time
     * rather than capturing a file: a card can outlive a rename, and the next
     * section to be mounted should resolve its links against where the
     * document is now.
     */
    get file(): TFile | null {
      const context = this.context
      if (!context) return null
      const file = context.app.vault.getAbstractFileByPath(context.sourcePath)
      return file instanceof TFile ? file : null
    }
  }

  contentViewClass = MarkdownContentView
  return contentViewClass
}

/**
 * Mounts a windowed Markdown preview into `options.container`.
 *
 * The instance is built against a detached element which is only then inserted
 * into the container: the preview renderer starts its first render when its
 * element enters a document, so building into an already-placed container
 * would race that trigger.
 */
export function createObsidianMarkdownContentView(
  app: App,
  options: ObsidianMarkdownContentViewOptions,
): ObsidianMarkdownContentViewHandle {
  const ViewClass = resolveContentViewClass()
  const doc = options.container.ownerDocument
  const win = getNodeWindow(options.container)

  // Exists only so the instance can be built before it is placed, and so
  // there is one node to take away again on destroy. It generates no box of
  // its own: what the caller styles is Obsidian's preview element, laid out
  // directly inside the container the caller passed.
  const hostEl = doc.createElement('div')
  hostEl.className = 'yolo-markdown-content-view'
  hostEl.setCssProps({ display: 'contents' })

  let instance: ObsidianMarkdownRendererInstance
  try {
    instance = new ViewClass(app, hostEl, {
      app,
      sourcePath: options.sourcePath,
    })
  } catch (error) {
    throw new ObsidianMarkdownContentViewUnavailableError(
      'constructing the Markdown renderer threw',
      error,
    )
  }
  assertMarkdownRendererInstance(instance)
  instance.load()
  instance.renderer.set(options.value)
  options.container.appendChild(hostEl)

  // The window of mounted sections is chosen from the viewport's height and
  // width, and a card is resized by its user at will — so a size change has to
  // re-pick it. Kept inside this module rather than exposed to callers:
  // windowing is what this component *is*, not something its user configures.
  // Coalesced through a frame because a drag-resize emits a size per frame and
  // re-measuring more often than the screen updates buys nothing.
  let destroyed = false
  let framePending = 0
  const observer = new win.ResizeObserver(() => {
    if (destroyed || framePending !== 0) return
    framePending = win.requestAnimationFrame(() => {
      framePending = 0
      if (destroyed) return
      instance.renderer.onResize()
    })
  })
  // The container, not `hostEl`: a box-less element reports no size.
  observer.observe(options.container)

  return {
    setValue: (text: string) => {
      if (destroyed) throw new Error('Markdown content view is destroyed')
      instance.renderer.set(text)
    },
    getScrollLine: () => (destroyed ? 0 : instance.renderer.getScroll()),
    scrollToLine: (line: number, onSettled?: () => void) => {
      if (destroyed) return
      instance.renderer.applyScrollDelayed(line, undefined, () => {
        // A view destroyed while the render it was waiting on was still in
        // flight is not a view that arrived anywhere.
        if (!destroyed) onSettled?.()
      })
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      observer.disconnect()
      if (framePending !== 0) win.cancelAnimationFrame(framePending)
      instance.unload()
      hostEl.remove()
    },
  }
}
