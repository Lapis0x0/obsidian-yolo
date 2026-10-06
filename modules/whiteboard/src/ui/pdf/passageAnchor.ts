// A passage of a PDF as an edge end reaches it (domain/fileFormat.ts's
// `EdgeAnchor`): made from text selected in a reader, the same way a
// highlight is made from it (./annotationController.ts's `highlight`) — the
// selection's quads in PDF user space, its text with a little context either
// side, and the text layer's tuple as a hint.

import type { EdgeAnchor } from '../../domain/fileFormat'

import { quoteContext } from './annotationGeometry'
import type { PdfReader, ReaderTextSelection } from './pdfReader'

/**
 * The passage a selection names. An anchor is on one page, so a selection
 * running over a page break names the part on its first page — where the
 * passage starts. Null when the selection has nothing in it to place.
 */
export async function passageAnchorFromSelection(
  reader: PdfReader,
  selection: ReaderTextSelection,
): Promise<EdgeAnchor | null> {
  const piece = selection.pieces.find((candidate) => candidate.text.length > 0)
  if (!piece || piece.quadPoints.length === 0) return null
  const items = await reader.getTextItems(piece.pageNumber)
  const context = quoteContext(items, piece.tuple)
  return {
    kind: 'pdf',
    page: piece.pageNumber,
    quadPoints: [...piece.quadPoints],
    quote: {
      exact: piece.text,
      ...(context.prefix ? { prefix: context.prefix } : {}),
      ...(context.suffix ? { suffix: context.suffix } : {}),
    },
    selection: piece.tuple,
  }
}
