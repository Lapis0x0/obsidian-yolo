import { parseDocx } from './docx'
import { parsePptx } from './pptx'
import type { OfficeDocumentKind, ParsedOfficeDocument } from './types'
import { parseXlsx } from './xlsx'

export type {
  OfficeDocumentKind,
  OfficeDocumentMetadata,
  ParsedOfficeDocument,
} from './types'

export async function parseOfficeDocument(
  data: ArrayBuffer | Uint8Array,
  ext: OfficeDocumentKind,
): Promise<ParsedOfficeDocument> {
  switch (ext) {
    case 'docx':
      return parseDocx(data)
    case 'pptx':
      return parsePptx(data)
    case 'xlsx':
      return parseXlsx(data)
  }
}
