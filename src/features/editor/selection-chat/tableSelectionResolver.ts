import { EditorView } from '@codemirror/view'

type EditorRange = {
  from: number
  to: number
}

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

type DebugEntry = {
  time: string
  label: string
  data: unknown
}

type DebugGlobal = typeof globalThis & {
  __yoloTableSelectionDebug?: DebugEntry[]
}

export function resolveMarkdownTableSelection(
  editorView: EditorView,
  sourceRange: EditorRange,
  domRange: Range,
): MarkdownTableSelectionResult | null {
  const rect = getSelectedCellRect(domRange)
  if (!rect) {
    debugTableSelection('no-cell-rect', {
      range: describeRange(domRange),
      sourceLine: editorView.state.doc.lineAt(sourceRange.from).number,
    })
    return null
  }

  const result = resolveMarkdownTableSelectionFromCoordinates(
    editorView.state.doc.toString(),
    editorView.state.doc.lineAt(sourceRange.from).number,
    rect,
  )
  debugTableSelection('resolved', {
    rect,
    sourceLine: editorView.state.doc.lineAt(sourceRange.from).number,
    result: result
      ? {
          startLine: result.startLine,
          endLine: result.endLine,
          preview: result.content.slice(0, 500),
        }
      : null,
  })
  return result
}

export function resolveMarkdownTableSelectionFromTableElement(
  source: string,
  tableIndex: number,
  table: Element,
): MarkdownTableSelectionResult | null {
  const rect = getSelectedCellRectFromTable(table)
  if (!rect) {
    debugTableSelection('no-selected-cell-rect', {
      tableIndex,
      table: describeElement(table),
    })
    return null
  }

  const result = resolveMarkdownTableSelectionFromTableIndex(
    source,
    tableIndex,
    rect,
  )
  debugTableSelection('resolved-from-widget', {
    tableIndex,
    rect,
    result: result
      ? {
          startLine: result.startLine,
          endLine: result.endLine,
          preview: result.content.slice(0, 500),
        }
      : null,
  })
  return result
}

export function resolveMarkdownTableSelectionFromTableIndex(
  source: string,
  tableIndex: number,
  rect: SelectedCellRect,
): MarkdownTableSelectionResult | null {
  const table = findMarkdownTables(source)[tableIndex]
  if (!table) {
    return null
  }

  return serializeMarkdownTableRect(table, rect)
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

function getSelectedCellRect(range: Range): SelectedCellRect | null {
  const startCell = closestTableCell(range.startContainer)
  const endCell = closestTableCell(range.endContainer)
  if (
    startCell &&
    endCell &&
    startCell.closest('table') === endCell.closest('table')
  ) {
    const endpointRect = getCellRect([startCell, endCell])
    if (endpointRect) {
      return endpointRect
    }
  }

  const table = getRangeTable(range)
  if (!table) {
    debugTableSelection('no-table', {
      range: describeRange(range),
      startCell: describeElement(startCell),
      endCell: describeElement(endCell),
    })
    return null
  }

  const selectedCells = Array.from(
    table.querySelectorAll('td.is-selected, th.is-selected'),
  )
  const selectedRect = getCellRect(selectedCells)
  if (selectedRect) {
    debugTableSelection('selected-cells', {
      range: describeRange(range),
      table: describeElement(table),
      cellCount: selectedCells.length,
      cells: selectedCells.slice(0, 40).map(describeElement),
      rect: selectedRect,
    })
    return selectedRect
  }

  const cells = Array.from(table.querySelectorAll('td, th')).filter((cell) =>
    rangeIntersectsElement(range, cell),
  )
  debugTableSelection('intersecting-cells', {
    range: describeRange(range),
    table: describeElement(table),
    startCell: describeElement(startCell),
    endCell: describeElement(endCell),
    cellCount: cells.length,
    cells: cells.slice(0, 20).map(describeElement),
  })
  return getCellRect(cells)
}

function closestTableCell(node: Node): HTMLTableCellElement | null {
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const cell = element?.closest('td, th')
  return isTableCell(cell) ? cell : null
}

function getRangeTable(range: Range): HTMLTableElement | null {
  const nodes = [
    range.commonAncestorContainer,
    range.startContainer,
    range.endContainer,
  ]

  for (const node of nodes) {
    const element =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement
    const table = element?.closest('table')
    if (isTable(table)) {
      return table
    }
  }

  const ownerDocument =
    range.commonAncestorContainer.ownerDocument ?? globalThis.document
  const selectedTables = new Set(
    Array.from(
      ownerDocument.querySelectorAll(
        'table td.is-selected, table th.is-selected',
      ),
    )
      .map((cell) => cell.closest('table'))
      .filter(isTable),
  )
  if (selectedTables.size === 1) {
    return Array.from(selectedTables)[0]
  }

  return null
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

function rangeIntersectsElement(range: Range, element: Element): boolean {
  if (typeof range.intersectsNode === 'function') {
    try {
      return range.intersectsNode(element)
    } catch {
      return false
    }
  }

  return false
}

function isTableCell(
  element: Element | null | undefined,
): element is HTMLTableCellElement {
  return element?.tagName === 'TD' || element?.tagName === 'TH'
}

function isTable(
  element: Element | null | undefined,
): element is HTMLTableElement {
  return element?.tagName === 'TABLE'
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

function debugTableSelection(label: string, data: unknown): void {
  try {
    if (
      globalThis.localStorage?.getItem('yolo-debug-table-selection') !== '1'
    ) {
      return
    }
    const entry: DebugEntry = {
      time: new Date().toISOString(),
      label,
      data,
    }
    const debugGlobal = globalThis as DebugGlobal
    debugGlobal.__yoloTableSelectionDebug ??= []
    debugGlobal.__yoloTableSelectionDebug.push(entry)
    debugGlobal.__yoloTableSelectionDebug.splice(
      0,
      Math.max(0, debugGlobal.__yoloTableSelectionDebug.length - 100),
    )
    console.debug('[YOLO table-selection]', JSON.stringify(entry, null, 2))
  } catch {
    // Ignore debug logging failures.
  }
}

function describeRange(range: Range): Record<string, unknown> {
  return {
    collapsed: range.collapsed,
    text: range.toString().slice(0, 300),
    commonAncestor: describeNode(range.commonAncestorContainer),
    startContainer: describeNode(range.startContainer),
    startOffset: range.startOffset,
    endContainer: describeNode(range.endContainer),
    endOffset: range.endOffset,
  }
}

function describeNode(node: Node | null): Record<string, unknown> | null {
  if (!node) {
    return null
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return {
      type: 'text',
      text: node.textContent?.slice(0, 120) ?? '',
      parent: describeElement(node.parentElement),
    }
  }

  return {
    type: 'element',
    element: describeElement(node as Element),
  }
}

function describeElement(
  element: Element | null | undefined,
): Record<string, unknown> | null {
  if (!element) {
    return null
  }

  const tableCell = isTableCell(element) ? element : null
  const row = tableCell?.parentElement?.closest('tr')
  return {
    tag: element.tagName,
    className: element.className,
    text: element.textContent?.trim().slice(0, 120) ?? '',
    rowIndex: row?.rowIndex,
    cellIndex: tableCell?.cellIndex,
  }
}
