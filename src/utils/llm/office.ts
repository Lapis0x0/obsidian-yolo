import { MentionableOffice } from '../../types/mentionable'
import { uint8ArrayToBase64 } from '../base64'
import { OfficeDocumentKind, parseOfficeDocument } from '../office'

export const OFFICE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024

export function getOfficeDocumentKind(file: File): OfficeDocumentKind | null {
  const name = file.name.toLowerCase()
  if (name.endsWith('.docx')) return 'docx'
  if (name.endsWith('.pptx')) return 'pptx'
  if (name.endsWith('.xlsx')) return 'xlsx'
  return null
}

export async function fileToMentionableOffice(
  file: File,
): Promise<MentionableOffice> {
  const kind = getOfficeDocumentKind(file)
  if (!kind) {
    throw new Error(`Unsupported Office file type: ${file.name}`)
  }
  if (file.size > OFFICE_UPLOAD_MAX_BYTES) {
    throw new Error(
      `Office document too large (${file.size} bytes). Limit is ${OFFICE_UPLOAD_MAX_BYTES} bytes.`,
    )
  }

  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  const parsed = await parseOfficeDocument(bytes, kind)

  return {
    type: 'office',
    name: file.name,
    kind,
    rawData: uint8ArrayToBase64(bytes),
    extractedText: parsed.markdown,
  }
}
