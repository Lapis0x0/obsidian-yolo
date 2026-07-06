import type { ParsedOfficeDocument } from './types'
import {
  decodeXmlEntities,
  getFirstTagContent,
  getTagContents,
  parseAttributes,
  stripXmlTags,
} from './xml'
import { loadOfficeZip, readZipText } from './zip'

type SheetInfo = {
  name: string
  path: string
}

function columnIndexFromCellRef(cellRef: string): number | null {
  const match = /^([A-Z]+)\d+$/i.exec(cellRef)
  const letters = match?.[1]?.toUpperCase()
  if (!letters) return null
  let index = 0
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64)
  }
  return index - 1
}

function markdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

function renderSheetTable(rows: string[][]): string {
  const colCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (colCount === 0) return ''

  const normalizedRows = rows.map((row) =>
    Array.from({ length: colCount }, (_, index) => row[index] ?? ''),
  )
  const [headerRow, ...bodyRows] = normalizedRows
  const header = headerRow ?? Array.from({ length: colCount }, () => '')
  return [
    `| ${header.map(markdownTableCell).join(' | ')} |`,
    `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`,
    ...bodyRows.map((row) => `| ${row.map(markdownTableCell).join(' | ')} |`),
  ].join('\n')
}

function parseWorkbookSheets(workbookXml: string): SheetInfo[] {
  const sheetsXml = getFirstTagContent(workbookXml, 'sheets') ?? ''
  const sheets: SheetInfo[] = []
  const pattern = /<sheet\b([^>]*)\/?\s*>/g
  let match: RegExpExecArray | null
  let index = 1
  while ((match = pattern.exec(sheetsXml)) !== null) {
    const attrs = parseAttributes(match[1] ?? '')
    const name = attrs.name?.trim() || `Sheet${index}`
    sheets.push({ name, path: `xl/worksheets/sheet${index}.xml` })
    index += 1
  }
  return sheets
}

function collectRichText(xml: string): string {
  return getTagContents(xml, 't')
    .map((textXml) => decodeXmlEntities(stripXmlTags(textXml)))
    .join('')
}

function parseSharedStrings(sharedStringsXml: string | null): string[] {
  if (!sharedStringsXml) return []
  return getTagContents(sharedStringsXml, 'si').map((siXml) =>
    collectRichText(siXml),
  )
}

function parseSheetRows(sheetXml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = []
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowPattern.exec(sheetXml)) !== null) {
    const row: string[] = []
    const rowXml = rowMatch[1] ?? ''
    const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>/g
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellPattern.exec(rowXml)) !== null) {
      const attrs = parseAttributes(cellMatch[1] ?? '')
      const columnIndex = attrs.r ? columnIndexFromCellRef(attrs.r) : row.length
      if (columnIndex === null) continue

      const cellInner = cellMatch[2] ?? ''
      if (attrs.t === 'inlineStr') {
        const isXml = getFirstTagContent(cellInner, 'is')
        row[columnIndex] = isXml ? collectRichText(isXml) : ''
        continue
      }

      const valueXml = getFirstTagContent(cellInner, 'v')
      const rawValue = valueXml ? decodeXmlEntities(stripXmlTags(valueXml)) : ''
      row[columnIndex] =
        attrs.t === 's' && rawValue !== ''
          ? (sharedStrings[Number.parseInt(rawValue, 10)] ?? '')
          : rawValue
    }
    rows.push(row)
  }
  return rows
}

export async function parseXlsx(
  data: ArrayBuffer | Uint8Array,
): Promise<ParsedOfficeDocument> {
  const zip = await loadOfficeZip(data)
  const workbookXml = await readZipText(zip, 'xl/workbook.xml')
  const sharedStringsXml = zip.file('xl/sharedStrings.xml')
    ? await readZipText(zip, 'xl/sharedStrings.xml')
    : null
  const sharedStrings = parseSharedStrings(sharedStringsXml)
  const sheets = parseWorkbookSheets(workbookXml)

  const blocks = await Promise.all(
    sheets.map(async (sheet) => {
      const sheetXml = await readZipText(zip, sheet.path)
      const table = renderSheetTable(parseSheetRows(sheetXml, sharedStrings))
      return [`## ${sheet.name}`, table].filter(Boolean).join('\n\n')
    }),
  )

  return {
    markdown: blocks.join('\n\n'),
    metadata: {
      kind: 'xlsx',
      sheetCount: sheets.length,
      sheetNames: sheets.map((sheet) => sheet.name),
    },
  }
}
