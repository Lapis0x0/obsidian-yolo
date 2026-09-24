// Lucide geometry for the PDF reader's own chrome (./pdfReader.ts,
// ./pdfSearch.ts, ./readerPanel.ts, and the comment editor in
// ./annotationController.ts), inlined the way the canvas's other
// chrome does it (../canvasControls.ts, ../cardMenu.ts): the module has no
// icon dependency, and a handful of paths is not worth one. Circles are
// written as two arcs so every icon is a list of paths.

export type ReaderIconName =
  | 'search'
  | 'chevron-up'
  | 'chevron-down'
  | 'x'
  | 'square-dashed'
  | 'ellipsis'
  | 'check'
  | 'trash-2'

const ICONS: Readonly<Record<ReaderIconName, readonly string[]>> = {
  search: ['M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0', 'm21 21-4.3-4.3'],
  'chevron-up': ['m18 15-6-6-6 6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
  'trash-2': [
    'M3 6h18',
    'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6',
    'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2',
    'M10 11v6',
    'M14 11v6',
  ],
  ellipsis: [
    'M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
    'M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
    'M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  ],
  'square-dashed': [
    'M5 3a2 2 0 0 0-2 2',
    'M19 3a2 2 0 0 1 2 2',
    'M21 19a2 2 0 0 1-2 2',
    'M5 21a2 2 0 0 1-2-2',
    'M9 3h1',
    'M9 21h1',
    'M14 3h1',
    'M14 21h1',
    'M3 9v1',
    'M21 9v1',
    'M3 14v1',
    'M21 14v1',
  ],
}

const SVG_NS = 'http://www.w3.org/2000/svg'

export function createReaderIcon(
  doc: Document,
  name: ReaderIconName,
): SVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'svg-icon')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  for (const d of ICONS[name]) {
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

/** An icon-only button in Obsidian's own icon-button treatment. Icon-only,
 * so its name is the `aria-label` — which Obsidian also shows as the
 * tooltip, the one place a tooltip is wanted. */
export function createReaderIconButton(
  doc: Document,
  className: string,
  icon: ReaderIconName,
  label: string,
  onClick: (event: MouseEvent) => void,
): HTMLButtonElement {
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = `clickable-icon ${className}`
  button.setAttribute('aria-label', label)
  button.appendChild(createReaderIcon(doc, icon))
  button.addEventListener('click', (event) => {
    event.preventDefault()
    onClick(event)
  })
  return button
}
