type SelectedCellRect = {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

export type MarkdownTableSelectionResult = {
  content: string
  startLine: number
  endLine: number
  rowCount: number
  columnCount: number
}

type ParsedMarkdownTable = {
  header: string[]
  rows: string[][]
  startLine: number
  endLine: number
}

export function resolveMarkdownTableSelectionFromTableElement(
  source: string,
  sourceLine: number,
  table: Element,
): MarkdownTableSelectionResult | null {
  const rect = getSelectedCellRectFromTable(table)
  if (!rect) {
    return null
  }

  return resolveMarkdownTableSelectionFromCoordinates(
    source,
    sourceLine,
    rect,
  )
}

export function resolveMarkdownTableSelectionFromCoordinates(
  source: string,
  sourceLine: number,
  rect: SelectedCellRect,
): MarkdownTableSelectionResult | null {
  const table = findMarkdownTableAtLine(source, sourceLine)
  if (!table) {
    return null
  }

  return serializeMarkdownTableRect(table, rect)
}

function serializeMarkdownTableRect(
  table: ParsedMarkdownTable,
  rect: SelectedCellRect,
): MarkdownTableSelectionResult | null {
  const startColumn = Math.max(0, rect.startColumn)
  const endColumn = Math.min(table.header.length - 1, rect.endColumn)
  if (startColumn > endColumn) {
    return null
  }

  const selectedColumns = buildContextualSelectedColumns(
    table.header.length,
    startColumn,
    endColumn,
  )
  const selectedBodyRows = range(rect.startRow, rect.endRow)
    .filter((row) => row > 0)
    .map((row) => row - 1)
    .filter((row) => row >= 0 && row < table.rows.length)

  const content = serializeMarkdownTableSelection(
    table,
    selectedColumns,
    selectedBodyRows,
  )
  if (!content) {
    return null
  }

  const startLine = selectedBodyRows.length
    ? table.startLine + 2 + Math.min(...selectedBodyRows)
    : table.startLine
  const endLine = selectedBodyRows.length
    ? table.startLine + 2 + Math.max(...selectedBodyRows)
    : table.startLine

  return {
    content,
    startLine,
    endLine,
    rowCount: selectedBodyRows.length,
    columnCount: endColumn - startColumn + 1,
  }
}

function getSelectedCellRectFromTable(table: Element): SelectedCellRect | null {
  const selectedCells = Array.from(
    table.querySelectorAll('td.is-selected, th.is-selected'),
  )
  return getCellRect(selectedCells)
}

function getCellRect(cells: Element[]): SelectedCellRect | null {
  const positions = cells
    .filter(isTableCell)
    .map((cell) => {
      const row = cell.parentElement?.closest('tr')
      return {
        rowIndex: row?.rowIndex ?? -1,
        cellIndex: cell.cellIndex,
      }
    })
    .filter(({ rowIndex, cellIndex }) => rowIndex >= 0 && cellIndex >= 0)

  if (!positions.length) {
    return null
  }

  return {
    startRow: Math.min(...positions.map((position) => position.rowIndex)),
    endRow: Math.max(...positions.map((position) => position.rowIndex)),
    startColumn: Math.min(...positions.map((position) => position.cellIndex)),
    endColumn: Math.max(...positions.map((position) => position.cellIndex)),
  }
}

function isTableCell(
  element: Element | null | undefined,
): element is HTMLTableCellElement {
  return element?.tagName === 'TD' || element?.tagName === 'TH'
}

function findMarkdownTableAtLine(
  source: string,
  sourceLine: number,
): ParsedMarkdownTable | null {
  return (
    findMarkdownTables(source).find(
      (table) => sourceLine >= table.startLine && sourceLine <= table.endLine,
    ) ?? null
  )
}

function findMarkdownTables(source: string): ParsedMarkdownTable[] {
  const lines = source.split('\n')
  const tables: ParsedMarkdownTable[] = []
  let index = 0

  while (index < lines.length) {
    if (
      !isPotentialTableLine(lines[index]) ||
      index + 1 >= lines.length ||
      !isDelimiterLine(lines[index + 1])
    ) {
      index += 1
      continue
    }

    const start = index
    let end = index + 1
    while (end + 1 < lines.length && isPotentialTableLine(lines[end + 1])) {
      end += 1
    }

    const parsed = parseMarkdownTableLines(lines.slice(start, end + 1))
    if (parsed) {
      tables.push({
        ...parsed,
        startLine: start + 1,
        endLine: end + 1,
      })
    }

    index = end + 1
  }

  return tables
}

function parseMarkdownTableLines(
  lines: string[],
): Pick<ParsedMarkdownTable, 'header' | 'rows'> | null {
  if (lines.length < 2 || !isDelimiterLine(lines[1])) {
    return null
  }

  const header = splitMarkdownTableRow(lines[0])
  if (!header.length) {
    return null
  }

  const rows = lines.slice(2).map((line) => splitMarkdownTableRow(line))
  return { header, rows }
}

function serializeMarkdownTableSelection(
  table: ParsedMarkdownTable,
  columns: TableColumnProjection[],
  bodyRows: number[],
): string | null {
  if (!columns.length) {
    return null
  }

  const header = pickCells(table.header, columns)
  const delimiter = columns.map(() => '---')
  const rows = bodyRows.map((row) => pickCells(table.rows[row] ?? [], columns))

  return [header, delimiter, ...rows].map(formatMarkdownTableRow).join('\n')
}

type TableColumnProjection = number | 'ellipsis'

function buildContextualSelectedColumns(
  columnCount: number,
  startColumn: number,
  endColumn: number,
): TableColumnProjection[] {
  const columns: TableColumnProjection[] = []

  if (startColumn > 0) {
    columns.push(0)
    if (startColumn > 1) {
      columns.push('ellipsis')
    }
  }

  for (let column = startColumn; column <= endColumn; column += 1) {
    if (!columns.includes(column)) {
      columns.push(column)
    }
  }

  if (endColumn < columnCount - 1) {
    columns.push('ellipsis')
  }

  return columns
}

function pickCells(row: string[], columns: TableColumnProjection[]): string[] {
  return columns.map((column) =>
    column === 'ellipsis' ? '...' : (row[column]?.trim() ?? ''),
  )
}

function formatMarkdownTableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim()
  const content = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const withoutTrailingPipe = content.endsWith('|')
    ? content.slice(0, -1)
    : content
  const cells: string[] = []
  let current = ''
  let escaping = false

  for (const char of withoutTrailingPipe) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (char === '\\') {
      current += char
      escaping = true
      continue
    }

    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  cells.push(current.trim())
  return cells
}

function isDelimiterLine(line: string): boolean {
  const cells = splitMarkdownTableRow(line)
  return (
    cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
  )
}

function isPotentialTableLine(line: string): boolean {
  return line.trim().includes('|')
}

function range(start: number, end: number): number[] {
  const values: number[] = []
  for (let value = start; value <= end; value += 1) {
    values.push(value)
  }
  return values
}
