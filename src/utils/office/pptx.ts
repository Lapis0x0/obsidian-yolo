import type { ParsedOfficeDocument } from './types'
import { decodeXmlEntities, getTagContents, stripXmlTags } from './xml'
import { loadOfficeZip, readZipText } from './zip'

function getSlideNumber(path: string): number | null {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(path)
  return match ? Number.parseInt(match[1] ?? '', 10) : null
}

export async function parsePptx(
  data: ArrayBuffer | Uint8Array,
): Promise<ParsedOfficeDocument> {
  const zip = await loadOfficeZip(data)
  const slideEntries = Object.keys(zip.files)
    .map((path) => ({ path, slideNumber: getSlideNumber(path) }))
    .filter(
      (entry): entry is { path: string; slideNumber: number } =>
        entry.slideNumber !== null,
    )
    .sort((a, b) => a.slideNumber - b.slideNumber)

  const slideBlocks = await Promise.all(
    slideEntries.map(async ({ path, slideNumber }) => {
      const slideXml = await readZipText(zip, path)
      const texts = getTagContents(slideXml, 'a:t')
        .map((textXml) => decodeXmlEntities(stripXmlTags(textXml)).trim())
        .filter((text) => text.length > 0)
      return `<!-- Slide number: ${slideNumber} -->\n${texts.join('\n\n')}`.trim()
    }),
  )

  return {
    markdown: slideBlocks.join('\n\n'),
    metadata: { kind: 'pptx', slideCount: slideEntries.length },
  }
}
