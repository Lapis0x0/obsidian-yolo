// Obsidian's own link to a place in a PDF, written the way the user's link
// settings write links: what "copy link" puts on the clipboard and what an
// excerpt card cites. Displayed the way Obsidian's PDF viewer displays the
// links it copies — the file's name and the page — rather than as the raw
// `#page=…&selection=…` subpath.

import { pdfSubpath } from '../../domain/excerpt'
import { basenameWithoutExtension } from '../../domain/naming'
import type { SelectionTuple } from '../../domain/pdfAnnotations'

export function generatePdfLink(
  host: YoloModuleHostApiV1,
  t: (key: string) => string,
  options: Readonly<{
    pdfPath: string
    /** The document the link is written in. */
    sourcePath: string
    page: number
    selection?: SelectionTuple | null
  }>,
): string | null {
  const alias = pdfLinkAlias(t, options.pdfPath, options.page)
  return host.vault.generateLink(
    options.pdfPath,
    options.sourcePath,
    pdfSubpath(options.page, options.selection ?? undefined),
    alias,
  )
}

/** What such a link shows: the file's name and the page. */
export function pdfLinkAlias(
  t: (key: string) => string,
  pdfPath: string,
  page: number,
): string {
  return t('pdf.linkAlias')
    .replace('{name}', basenameWithoutExtension(pdfPath))
    .replace('{page}', String(page))
}
