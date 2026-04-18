import { MentionablePDF } from '../../types/mentionable'
import { createYieldController } from '../common/yield-to-main'
import { loadPdfPages } from '../pdf/pdfPages'

/** Hard cap for uploaded PDF size at the chat input. */
export const PDF_UPLOAD_MAX_BYTES = 50 * 1024 * 1024

/** Hard cap for uploaded PDF page count. */
export const PDF_UPLOAD_MAX_PAGES = 500

export async function fileToMentionablePDF(
  file: File,
  options: { maxBinaryBytes?: number; maxPages?: number } = {},
): Promise<MentionablePDF> {
  const maxBinaryBytes = options.maxBinaryBytes ?? PDF_UPLOAD_MAX_BYTES
  const maxPages = options.maxPages ?? PDF_UPLOAD_MAX_PAGES

  if (file.size > maxBinaryBytes) {
    throw new Error(
      `PDF too large (${file.size} bytes). Limit is ${maxBinaryBytes} bytes.`,
    )
  }

  const buf = await file.arrayBuffer()
  const maybeYield = createYieldController(1)

  const { totalPages, pages } = await loadPdfPages(new Uint8Array(buf), {
    maxPages,
    maybeYield,
  })

  const data = pages
    .map(({ page, text }) => `--- Page ${page} ---\n${text}`)
    .join('\n\n')

  return {
    type: 'pdf',
    name: file.name,
    data,
    pageCount: totalPages,
    truncated: totalPages > maxPages,
  }
}
