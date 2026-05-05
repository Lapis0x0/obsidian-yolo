/**
 * getPdfPageContextText.ts
 *
 * Read full text of a PDF page via pdfjs-dist (the same path the `read` tool
 * uses) and insert a marker at the selection's position. Used by Quick Ask
 * to inject on-page context analogous to Markdown's surrounding-cursor text.
 *
 * Why pdfjs instead of scraping the rendered .textLayer DOM:
 *   - PDF.js virtualises pages and recycles Text nodes; live Range nodes
 *     captured at selection time can be detached by the time we read them.
 *   - Range.startContainer/endContainer may be span elements, not Text
 *     nodes, breaking node-identity-based offset computation.
 *   - Cross-page selections, hidden helper spans, sub-pixel split nodes —
 *     all complicate DOM extraction.
 *   - pdfjs-dist gives the canonical page text directly from the document.
 */

import type { App, TFile } from 'obsidian'

import { pageItemsToText } from '../../../utils/pdf/pdfPages'

export type PdfPageContextOptions = {
  /** Max characters kept before the selection start (within page bounds). */
  beforeChars: number
  /** Max characters kept after the selection end (within page bounds). */
  afterChars: number
}

export type PdfPageContextResult = {
  /** `<truncated before>[<marker><selected text>]<truncated after>` */
  contextText: string
  /**
   * Selected text exactly as it appears in `contextText`. Caller MUST set
   * mention.content to this value so `editorSnapshotContext`'s in-place
   * marker replacement can match `after.startsWith(selection.content)`.
   * When the selection couldn't be located in pdfjs output, this falls back
   * to the DOM `selection.toString()` value and the model gets page text +
   * appended `<selected_text>` block (still useful, just no inline marker).
   */
  selectedText: string
}

/**
 * Extract the text of a single PDF page using pdfjs-dist. Loads the PDF
 * binary fresh — caller should kick this off as early as possible (e.g.
 * at selection-capture time) so the result is ready by the time the user
 * submits an action in Quick Ask.
 */
export async function getPdfPageContextText(
  app: App,
  file: TFile,
  pageNumber: number,
  selectionText: string,
  marker: string,
  options: PdfPageContextOptions,
): Promise<PdfPageContextResult | null> {
  let pageText: string
  try {
    const buf = await app.vault.adapter.readBinary(file.path)
    await import('pdfjs-dist/build/pdf.worker.mjs')
    const pdfjs = await import('pdfjs-dist')
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buf),
      useWorkerFetch: false,
      isEvalSupported: false,
    })
    const pdf = await loadingTask.promise
    if (pageNumber < 1 || pageNumber > pdf.numPages) return null
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()
    pageText = pageItemsToText(textContent.items as unknown[])
  } catch {
    return null
  }

  if (pageText.length === 0) return null

  const beforeChars = Math.max(0, options.beforeChars)
  const afterChars = Math.max(0, options.afterChars)

  const located = locateSelectionInPageText(pageText, selectionText)
  if (located) {
    const { idx, matchedText } = located
    const beforeStart = Math.max(0, idx - beforeChars)
    const afterEnd = Math.min(
      pageText.length,
      idx + matchedText.length + afterChars,
    )
    const before = pageText.slice(beforeStart, idx)
    const after = pageText.slice(idx + matchedText.length, afterEnd)
    return {
      contextText: `${before}${marker}${matchedText}${after}`,
      // Caller MUST set mention.content to this exact substring — it's what
      // sits between the marker and the rest of the page, so
      // `editorSnapshotContext`'s `after.startsWith(selection.content)`
      // check succeeds and inline replacement produces a single
      // `<selected_text_start>...</selected_text_end>` block.
      selectedText: matchedText,
    }
  }

  // Selection couldn't be located even with whitespace-flexible matching
  // (extremely rare — e.g. PDF text extraction reordered glyphs). Fall back
  // to page text without a marker; editorSnapshotContext will append the
  // wrapped selection after the context.
  const total = beforeChars + afterChars
  if (total > 0 && pageText.length > total) {
    return {
      contextText: pageText.slice(0, total),
      selectedText: selectionText,
    }
  }
  return {
    contextText: pageText,
    selectedText: selectionText,
  }
}

/**
 * Find the user's selection inside pdfjs page text. DOM `selection.toString()`
 * and `pageItemsToText` produce the same non-whitespace character stream but
 * differ in whitespace layout — e.g. pdfjs renders `[   23 ]` where the DOM
 * gives `[ 23]` (the `]` ends up adjacent in DOM but separated by a space in
 * pdfjs). Token-level matching breaks on punctuation glued to digits;
 * character-level whitespace-skipping matching handles it cleanly.
 *
 * Returns the start index AND the substring as it actually appears in
 * pageText — callers use that substring as the canonical "selected text" so
 * `editorSnapshotContext`'s `after.startsWith(selection.content)` check
 * matches byte-for-byte.
 */
function locateSelectionInPageText(
  pageText: string,
  selectionText: string,
): { idx: number; matchedText: string } | null {
  const trimmed = selectionText.trim()
  if (trimmed.length === 0) return null

  // Fast path: exact match.
  const directIdx = pageText.indexOf(trimmed)
  if (directIdx >= 0) {
    return { idx: directIdx, matchedText: trimmed }
  }

  // Slow path: character-level match ignoring whitespace differences. We
  // step through pageText looking for positions where its non-whitespace
  // chars equal the selection's non-whitespace chars in order.
  const isWs = (c: string): boolean =>
    c === ' ' ||
    c === '\t' ||
    c === '\n' ||
    c === '\r' ||
    c === '\f' ||
    c === '\v'
  const selLen = trimmed.length
  const pageLen = pageText.length

  // Find first non-whitespace char of selection to anchor candidates.
  let firstSelIdx = 0
  while (firstSelIdx < selLen && isWs(trimmed[firstSelIdx])) firstSelIdx += 1
  if (firstSelIdx >= selLen) return null
  const firstSelChar = trimmed[firstSelIdx]

  for (let start = 0; start < pageLen; start += 1) {
    if (pageText[start] !== firstSelChar) continue

    let pi = start
    let si = firstSelIdx
    while (pi < pageLen && si < selLen) {
      const pc = pageText[pi]
      const sc = trimmed[si]
      const pIsWs = isWs(pc)
      const sIsWs = isWs(sc)
      if (pIsWs && sIsWs) {
        pi += 1
        si += 1
        continue
      }
      if (pIsWs) {
        pi += 1
        continue
      }
      if (sIsWs) {
        si += 1
        continue
      }
      if (pc !== sc) break
      pi += 1
      si += 1
    }

    // Allow trailing whitespace on either side after consuming all
    // non-whitespace chars of the selection.
    while (si < selLen && isWs(trimmed[si])) si += 1

    if (si >= selLen) {
      return { idx: start, matchedText: pageText.slice(start, pi) }
    }
  }

  return null
}
