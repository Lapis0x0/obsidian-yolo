/** Non-content metadata that is safe to report for a hard card failure. */
type CardFailureDiagnosticsBase = {
  chapterTitle: string
  /** Cards published by the stream parser before validation. */
  publishedCards: number
  /** Blocks dropped by the stream parser and/or written-card validation. */
  discardedBlocks: number
  /** Size of the text this stage inspected. Length only - never the text. */
  inspectedLength: number
  /** What `inspectedLength` measured, so the number is not misread. */
  inspectedSource: 'stream-output' | 'cards-file'
}

export type CardFailureDiagnostics = CardFailureDiagnosticsBase &
  (
    | {
        reason: 'no-usable-drafts'
        /** Completed stream blocks plus the fixed rules that rejected them. */
        parserRejections: ReadonlyArray<{
          blockIndex: number
          errors: readonly string[]
        }>
      }
    | {
        reason: 'no-valid-cards'
        /** Card identifiers plus the fixed validation rules that rejected them. */
        validationRejections: ReadonlyArray<{
          cardUuid: string
          errors: readonly string[]
        }>
      }
  )

/**
 * Report why a chapter produced zero usable cards.
 *
 * This is deliberately limited to non-content metadata - counts, lengths,
 * generated identifiers, and fixed parser/validation labels. Raw model output
 * is emitted separately by the Core module-agent boundary only when the user
 * has enabled the existing host-controlled debug capture.
 *
 * It runs only on the zero-card failure path, so it cannot become log noise
 * during normal generation.
 */
export function emitCardFailureDiagnostics(data: CardFailureDiagnostics): void {
  const summary =
    data.reason === 'no-usable-drafts'
      ? data.parserRejections.length > 0
        ? 'every completed card block was rejected before publishing'
        : 'the stream completed without a complete card block'
      : 'every parsed card failed validation'
  const parts = [
    `published: ${data.publishedCards}`,
    `discarded: ${data.discardedBlocks}`,
    `${data.inspectedSource} length: ${data.inspectedLength}`,
  ]
  console.warn(
    `[yolo-learning] card generation failed for "${data.chapterTitle}": ${summary} (${parts.join(', ')})`,
  )
  if (data.reason === 'no-usable-drafts' && data.parserRejections.length > 0) {
    console.warn(
      'stream parser rejections:',
      data.parserRejections.map((entry) => ({
        blockIndex: entry.blockIndex,
        errors: [...entry.errors],
      })),
    )
  }
  if (
    data.reason === 'no-valid-cards' &&
    data.validationRejections.length > 0
  ) {
    console.warn(
      'written card validation rejections:',
      data.validationRejections.map((entry) => ({
        cardUuid: entry.cardUuid,
        errors: [...entry.errors],
      })),
    )
  }
}
