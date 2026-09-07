// Rung one of the board's AI ladder (master.md §5): an empty text card offers
// a few one-click instructions, and clicking one streams a single agent turn
// straight into that card.
//
// Two states of one card, and that is the whole surface:
//
//   - **empty** — the card's body holds its chips. Not an overlay and not a
//     button beside the card: a card with nothing in it is a card asking what
//     goes in it, and the chips are what that looks like. The first character
//     typed into the card takes them away (`syncChips` is called from the same
//     content path that renders every other card state, so "has content" is
//     never asked twice).
//   - **generating** — the body holds a status line and the text as it
//     arrives. Nothing is written to the board while it streams: the card is
//     pinned, the renderer is told to leave it alone, and the accumulated text
//     lands in one `applyBoardChange` when the run settles, so Cmd+Z undoes a
//     generation in one step (Q20).
//
// Stopping keeps what has arrived (Q12), and so does double-clicking into the
// card mid-run (Q35) — the editor and the stream share the card's body, so
// asking to type in it is asking to stop.
//
// The run itself is deliberately small: `host.agent.stream` with a system
// prompt that *replaces* the host's default one (W0), the card's context as
// the prompt (domain/cardContext.ts), and exactly one run-scoped read-only
// tool. No writes, no board tools, no follow-up turn.

import { buildCardContext, cardSourceIds } from '../../domain/cardContext'
import {
  type CardInstruction,
  cardGenerationSystemPrompt,
  cardInstructions,
} from '../../domain/cardInstructions'
import type { Board, BoardNode, NodeId } from '../../domain/fileFormat'
import {
  readCardForModel,
  resolveCardContextNotes,
} from '../../host/cardContext'

const CHIPS_CLASS = 'yolo-whiteboard-card-chips'
const CHIP_CLASS = 'yolo-whiteboard-card-chip'
const STREAM_CLASS = 'yolo-whiteboard-card-stream'
const STREAM_STATUS_CLASS = 'yolo-whiteboard-card-stream-status'
const STREAM_LABEL_CLASS = 'yolo-whiteboard-card-stream-label'
const STREAM_STOP_CLASS = 'yolo-whiteboard-card-stream-stop'
const STREAM_TEXT_CLASS = 'yolo-whiteboard-card-stream-text'

/** A tool that exists only for the duration of one `agent.stream` run. The
 * module SDK exports no alias for it, so it is named off the request type. */
type RunScopedTool = NonNullable<
  Parameters<YoloModuleHostApiV1['agent']['stream']>[0]['tools']
>[number]

export type CardGenerationCallbacks = Readonly<{
  getBoard: () => Board
  getNode: (id: NodeId) => BoardNode | undefined
  getSourcePath: () => string
  /** The card's body element, or null when it is not mounted. */
  getBody: (id: NodeId) => HTMLElement | null
  /** False on a board that cannot be edited or is drawn as an overview. */
  isAvailable: () => boolean
  isEditing: (id: NodeId) => boolean
  /**
   * Hands the card's body over for streaming: pins the card, empties the
   * body, and marks it generating. Null when the card cannot take a run.
   */
  beginGeneration: (id: NodeId) => HTMLElement | null
  /**
   * Gives it back: commits `text` as the card's content in one history step
   * (empty text commits nothing), restores the card's ordinary content, and
   * opens the editor when the run ended because the user asked to type.
   */
  endGeneration: (id: NodeId, text: string, options: { edit: boolean }) => void
  reportError: (stage: string, error: unknown) => void
  notice: (message: string) => void
  t: (key: string, fallback?: string) => string
}>

type Generation = {
  readonly nodeId: NodeId
  readonly controller: AbortController
  readonly labelEl: HTMLElement
  readonly textNode: Text
  /** Ids `read_card` has been called with, for the status line's count. */
  readonly readIds: Set<string>
  text: string
  /** True once the run has been handed back — every path is idempotent. */
  settled: boolean
  /** Set by a stop that means "let me type in this card instead" (Q35). */
  edit: boolean
}

export class CardGeneration {
  private readonly generations = new Map<NodeId, Generation>()

  constructor(
    private readonly host: YoloModuleHostApiV1,
    private readonly callbacks: CardGenerationCallbacks,
  ) {}

  isGenerating(id: NodeId): boolean {
    return this.generations.has(id)
  }

  /**
   * Puts this card's chips where they belong, or takes them away — called
   * from the one content path every card state goes through
   * (`CardRenderer.renderCardPreview`), so a card that has just been
   * rendered, edited, undone or agent-edited all reach it the same way.
   */
  syncChips(id: NodeId): void {
    const body = this.callbacks.getBody(id)
    if (!body) return
    const existing = body.querySelector<HTMLElement>(`:scope > .${CHIPS_CLASS}`)
    if (!this.wantsChips(id)) {
      existing?.remove()
      return
    }
    const instructions = cardInstructions(
      cardSourceIds(this.callbacks.getBoard(), id).length > 0,
    )
    // Which chips a card offers depends on whether anything points into it, so
    // a chip row built before an arrow reached this card is the wrong row —
    // the signature is what notices, without re-reading the DOM's labels.
    const signature = instructions.map((instruction) => instruction.key).join()
    if (existing?.dataset.instructions === signature) return
    existing?.remove()
    body.appendChild(
      this.buildChips(body.ownerDocument, id, instructions, signature),
    )
  }

  /**
   * Ends a run, keeping whatever has arrived. `edit` carries the one reason
   * to stop that is also a request to open the editor.
   */
  stop(id: NodeId, options: { edit?: boolean } = {}): void {
    const generation = this.generations.get(id)
    if (!generation) return
    generation.edit = options.edit === true
    generation.controller.abort()
    this.settle(generation)
  }

  /**
   * Text that has streamed into a card but is not on the board yet — folded
   * into a snapshot taken mid-run (`getViewData`), which is the only thing
   * that keeps a leaf closed during a generation from losing it.
   */
  pendingTexts(): [NodeId, string][] {
    const pending: [NodeId, string][] = []
    for (const [id, generation] of this.generations) {
      const text = generation.text.trim()
      if (text !== '') pending.push([id, text])
    }
    return pending
  }

  /**
   * Drops every run without committing — the board they were writing into is
   * being replaced or destroyed, so there is nothing left to commit *to*.
   */
  abandonAll(): void {
    for (const generation of this.generations.values()) {
      generation.settled = true
      generation.controller.abort()
    }
    this.generations.clear()
  }

  // ---- chips -------------------------------------------------------------

  private wantsChips(id: NodeId): boolean {
    if (!this.callbacks.isAvailable()) return false
    if (this.generations.has(id)) return false
    if (this.callbacks.isEditing(id)) return false
    const node = this.callbacks.getNode(id)
    // A file card is never "empty" in this sense: its content lives in a note,
    // and an empty note is a note to write in, not a card to generate into
    // (Q20).
    return node?.type === 'text' && node.text.trim() === ''
  }

  private buildChips(
    doc: Document,
    id: NodeId,
    instructions: readonly CardInstruction[],
    signature: string,
  ): HTMLElement {
    const chips = doc.createElement('div')
    chips.className = CHIPS_CLASS
    chips.dataset.instructions = signature
    for (const instruction of instructions) {
      const chip = doc.createElement('button')
      chip.type = 'button'
      chip.className = CHIP_CLASS
      chip.textContent = this.callbacks.t(instruction.labelKey)
      chip.addEventListener('click', (event) => {
        event.stopPropagation()
        this.start(id, instruction)
      })
      chips.appendChild(chip)
    }
    return chips
  }

  // ---- the run -----------------------------------------------------------

  private start(id: NodeId, instruction: CardInstruction): void {
    if (this.generations.has(id)) return
    void this.run(id, instruction)
  }

  private async run(
    nodeId: NodeId,
    instruction: CardInstruction,
  ): Promise<void> {
    const body = this.callbacks.beginGeneration(nodeId)
    if (!body) return
    const generation = this.mountStream(body, nodeId)
    this.generations.set(nodeId, generation)

    try {
      const board = this.callbacks.getBoard()
      const noteTexts = await resolveCardContextNotes(this.host, board, nodeId)
      if (generation.settled) return
      const context = buildCardContext({
        board,
        nodeId,
        path: this.callbacks.getSourcePath(),
        noteTexts,
      })
      const locale = this.host.i18n.getSnapshot().locale
      this.setStatus(generation, this.callbacks.t('cardAi.status.writing'))
      for await (const event of this.host.agent.stream({
        systemPrompt: cardGenerationSystemPrompt(locale),
        prompt: `${context}\n\n---\n\n${instruction.prompt}`,
        capability: 'vault-read',
        tools: [this.readCardTool()],
        signal: generation.controller.signal,
      })) {
        if (generation.settled) return
        switch (event.type) {
          case 'text':
            this.appendText(generation, event.text, event.delta)
            break
          case 'tool':
            this.noteToolCall(generation, event.name, event.arguments)
            break
          case 'completed':
            if (event.text) this.appendText(generation, event.text, '')
            this.settle(generation)
            return
          case 'aborted':
            this.settle(generation)
            return
          case 'error':
            throw new Error(event.message)
        }
      }
      this.settle(generation)
    } catch (error) {
      if (generation.settled) return
      this.callbacks.reportError('card generation', error)
      this.callbacks.notice(this.callbacks.t('cardAi.failed'))
      this.settle(generation)
    }
  }

  /**
   * The run's only tool (Q9): one card, read-only. `read_board` is not given —
   * the board's summary is already in the prompt — and nothing that writes is,
   * so the run has nothing to ask approval for.
   */
  private readCardTool(): RunScopedTool {
    return {
      name: 'read_card',
      description:
        'Read one card of this whiteboard in full. Card ids are listed in the board summary you were given. Asking for a group returns every card inside it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The card id, e.g. "c-8f3a".',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (input) => {
        const id = typeof input.id === 'string' ? input.id.trim() : ''
        if (!id) return { content: '"id" is required.', isError: true }
        const content = await readCardForModel(
          this.host,
          this.callbacks.getBoard(),
          id,
        )
        if (content === null) {
          return {
            content: `No card with id "${id}" on this board.`,
            isError: true,
          }
        }
        return { content }
      },
    }
  }

  // ---- the streaming card ------------------------------------------------

  private mountStream(body: HTMLElement, nodeId: NodeId): Generation {
    const doc = body.ownerDocument
    const stream = doc.createElement('div')
    stream.className = STREAM_CLASS

    const status = doc.createElement('div')
    status.className = STREAM_STATUS_CLASS
    const label = doc.createElement('span')
    label.className = STREAM_LABEL_CLASS
    label.textContent = this.callbacks.t('cardAi.status.preparing')
    const stop = doc.createElement('button')
    stop.type = 'button'
    stop.className = STREAM_STOP_CLASS
    stop.textContent = this.callbacks.t('cardAi.stop')
    stop.addEventListener('click', (event) => {
      event.stopPropagation()
      this.stop(nodeId)
    })
    status.append(label, stop)

    const text = doc.createElement('div')
    text.className = STREAM_TEXT_CLASS
    const textNode = doc.createTextNode('')
    text.appendChild(textNode)

    stream.append(status, text)
    body.appendChild(stream)

    return {
      nodeId,
      controller: new AbortController(),
      labelEl: label,
      textNode,
      readIds: new Set(),
      text: '',
      settled: false,
      edit: false,
    }
  }

  /** Grows the card by what just arrived, rather than re-writing all of it. */
  private appendText(
    generation: Generation,
    text: string,
    delta: string,
  ): void {
    const next = text || generation.text + delta
    if (next === generation.text) return
    if (next.startsWith(generation.text)) {
      generation.textNode.appendData(next.slice(generation.text.length))
    } else {
      generation.textNode.data = next
    }
    generation.text = next
    // The status line has said everything it has to say once the card is
    // writing itself (Q11); the stop button stays.
    generation.labelEl.textContent = ''
  }

  private noteToolCall(
    generation: Generation,
    name: string,
    args: Readonly<Record<string, unknown>> | undefined,
  ): void {
    if (name !== 'read_card') return
    if (typeof args?.id === 'string') generation.readIds.add(args.id)
    if (generation.text !== '') return
    this.setStatus(
      generation,
      this.callbacks
        .t('cardAi.status.reading')
        .replace('{count}', String(Math.max(generation.readIds.size, 1))),
    )
  }

  private setStatus(generation: Generation, status: string): void {
    if (generation.text !== '') return
    generation.labelEl.textContent = status
  }

  private settle(generation: Generation): void {
    if (generation.settled) return
    generation.settled = true
    this.generations.delete(generation.nodeId)
    generation.controller.abort()
    this.callbacks.endGeneration(generation.nodeId, generation.text.trim(), {
      edit: generation.edit,
    })
  }
}
