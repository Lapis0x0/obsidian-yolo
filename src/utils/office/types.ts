export type OfficeDocumentKind = 'docx' | 'pptx' | 'xlsx'

export type OfficeDocumentMetadata =
  | { kind: 'docx'; paragraphCount: number }
  | { kind: 'pptx'; slideCount: number }
  | { kind: 'xlsx'; sheetCount: number; sheetNames: string[] }

export type ParsedOfficeDocument = {
  markdown: string
  metadata: OfficeDocumentMetadata
}
