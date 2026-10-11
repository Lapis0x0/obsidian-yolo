// Cards built off the board to have their pictures taken (./cardPictures.ts):
// a card that is not mounted — out of view, or every card, with the board
// zoomed out past where cards are — is given the element and the render the
// board would give it (../canvas/cardContent.ts), on a stage nobody sees
// (styles/canvas/picture-stage.css), for as long as its picture takes.
//
// What is built there is never styled or laid out (picture-stage.css): the
// picture lays the card out itself. The stage is in the board's root all the
// same, so that what a renderer does ask of the layout is answered under the
// rules the board's own cards are.
//
// Popout safety: the stage is the board's own document's.

import type { BoardNode } from '../../domain/fileFormat'
import { fileNodeKind } from '../../domain/naming'
import {
  clippedCardMarkdown,
  createCardBody,
  createNodeElement,
  renderClippedMarkdown,
} from '../canvas/cardContent'

const STAGE_CLASS = 'yolo-whiteboard-picture-stage'

/** What a staged card renders: its markdown, and what its links resolve
 * against. */
export type StagedSource = Readonly<{ markdown: string; sourcePath: string }>

/** A card on the stage: its element, its render, and its taking down. */
export type StagedCard = Readonly<{
  el: HTMLElement
  /** Resolves once its content is rendered: true then, false if it was
   * taken down first. Rejects if the render fails. */
  rendered: Promise<boolean>
  dispose: () => void
}>

export type CardStageDeps = Readonly<{
  host: YoloModuleHostApiV1
  /** The board's root element, where the stage goes. */
  root: HTMLElement
  /** What a text card's links resolve against: the board's own file. */
  boardPath: () => string
}>

export class CardStage {
  private readonly stage: HTMLElement
  /** The cards on the stage, each with its taking down. */
  private readonly staged = new Set<() => void>()

  constructor(private readonly deps: CardStageDeps) {
    this.stage = deps.root.ownerDocument.createElement('div')
    this.stage.className = STAGE_CLASS
    deps.root.appendChild(this.stage)
  }

  /** What `node` shows: a text card's text, a note's file read now; null
   * for any other node, or a note that cannot be read. */
  async source(node: BoardNode): Promise<StagedSource | null> {
    if (node.type === 'text') {
      return { markdown: node.text, sourcePath: this.deps.boardPath() }
    }
    if (node.type !== 'file' || fileNodeKind(node.file) !== 'markdown') {
      return null
    }
    try {
      const markdown = await this.deps.host.vault.readText(node.file)
      return { markdown, sourcePath: node.file }
    } catch {
      // Gone, or not readable: the card shows its missing-file placeholder,
      // which is no picture of a note.
      return null
    }
  }

  /** Builds `node`'s card on the stage with `source` rendered in it. Main-
   * thread work — the card's render — for an idle slice. Throws when the
   * host has no renderer to give. */
  build(node: BoardNode, source: StagedSource): StagedCard {
    const doc = this.stage.ownerDocument
    const el = createNodeElement(doc, node)
    const body = createCardBody(doc)
    el.appendChild(body)
    this.stage.appendChild(el)
    let made: ReturnType<typeof renderClippedMarkdown>
    try {
      made = renderClippedMarkdown(
        this.deps.host,
        body,
        clippedCardMarkdown(node, source.markdown),
        source.sourcePath,
      )
    } catch (error) {
      el.remove()
      throw error
    }
    const { renderer } = made
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      this.staged.delete(dispose)
      renderer.unload()
      el.remove()
    }
    this.staged.add(dispose)
    // A render taken down under way is cancelled, not failed: `unload()`
    // rejects whatever was in flight.
    const rendered = made.rendered.then(
      () => !disposed,
      (error: unknown) => {
        if (disposed) return false
        throw error
      },
    )
    return { el, rendered, dispose }
  }

  destroy(): void {
    for (const dispose of Array.from(this.staged)) dispose()
    this.stage.remove()
  }
}
