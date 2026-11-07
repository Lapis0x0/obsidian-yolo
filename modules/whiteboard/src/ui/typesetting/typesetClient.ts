// The board's side of its typesetting worker (./typesetWorker.ts): one
// worker for everything that typesets a card — the GPU scene's content
// (../gpu/gpuBoard.ts) and the cards' pictures (../pictures/typesetCards.ts)
// — started when first asked for.
//
// Every call is in a look (../pictures/typesetStyle.ts's tokens and their
// hash); the first call in a new one hands the worker that look's fonts
// first. The worker answers in the order it is asked, and waits for the
// fonts it was last handed before it typesets: a call is always set in the
// fonts of the look it names.

import type { TypesetTokens } from '../../typeset/tokens'

import { familiesOf, fontSources } from './fontSources'
import {
  type FontsPayload,
  type PicturePayload,
  TYPESET_WORKER,
  type TypesetCard,
  type TypesetPayload,
  type TypesetResult,
} from './typesetProtocol'

const WORKER_SOURCE = Symbol.for(
  `yolo.module.inline-worker.v1:whiteboard:${TYPESET_WORKER}`,
)

/** The typesetting worker's source, which the module's build puts on the
 * global object (scripts/build-first-party-modules.mjs). */
export function typesetWorkerSource(): string {
  const source = (globalThis as Record<symbol, unknown>)[WORKER_SOURCE]
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('the typesetting worker is not in this build')
  }
  return source
}

/** A look: what cards are set in, and what names it. */
export type Look = Readonly<{ tokens: TypesetTokens; hash: string }>

export type TypesetClientDeps = Readonly<{
  /** Where the fonts are read: the board's document. */
  doc: Document
  start: () => YoloModuleHostWorkerV1
  reportError: (stage: string, error: unknown) => void
}>

export class TypesetClient {
  private worker: YoloModuleHostWorkerV1 | null = null
  /** Set once starting failed: nothing is asked of it after. */
  private broken = false
  private fontsFor: string | null = null

  constructor(private readonly deps: TypesetClientDeps) {}

  /** Whether calls can be made: false once the worker could not start. */
  get usable(): boolean {
    return !this.broken
  }

  typeset(look: Look, cards: readonly TypesetCard[]): Promise<TypesetResult> {
    return this.call<TypesetResult>(look, 'typeset', {
      tokens: look.tokens,
      cards,
    } satisfies TypesetPayload)
  }

  picture(
    look: Look,
    card: TypesetCard,
    scale: number,
    fade: number,
  ): Promise<ImageBitmap> {
    return this.call<ImageBitmap>(look, 'picture', {
      tokens: look.tokens,
      card,
      scale,
      fade,
    } satisfies PicturePayload)
  }

  destroy(): void {
    this.worker?.terminate()
    this.worker = null
  }

  private call<T>(look: Look, method: string, payload: unknown): Promise<T> {
    const worker = this.started()
    if (!worker) return Promise.reject(new Error('no typesetting worker'))
    if (this.fontsFor !== look.hash) {
      this.fontsFor = look.hash
      const faces = fontSources(this.deps.doc, familiesOf(look.tokens))
      worker
        .call('fonts', { faces } satisfies FontsPayload)
        .catch((error: unknown) =>
          this.deps.reportError('typeset fonts', error),
        )
    }
    return worker.call<T>(method, payload)
  }

  private started(): YoloModuleHostWorkerV1 | null {
    if (this.worker || this.broken) return this.worker
    try {
      this.worker = this.deps.start()
    } catch (error) {
      this.broken = true
      this.deps.reportError('typeset worker', error)
    }
    return this.worker
  }
}
