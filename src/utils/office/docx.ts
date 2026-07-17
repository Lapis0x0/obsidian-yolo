import type { ParsedOfficeDocument } from './types'
import { decodeXmlEntities, getTagContents, stripXmlTags } from './xml'
import { loadOfficeZip, readZipText } from './zip'

export async function parseDocx(
  data: ArrayBuffer | Uint8Array,
): Promise<ParsedOfficeDocument> {
  const zip = await loadOfficeZip(data)
  const documentXml = await readZipText(zip, 'word/document.xml')
  const paragraphs = getTagContents(documentXml, 'w:p')
    .map((paragraphXml) =>
      getTagContents(paragraphXml, 'w:t')
        .map((textXml) => decodeXmlEntities(stripXmlTags(textXml)))
        .join('')
        .trim(),
    )
    .filter((paragraph) => paragraph.length > 0)

  return {
    markdown: paragraphs.join('\n\n'),
    metadata: { kind: 'docx', paragraphCount: paragraphs.length },
  }
}
