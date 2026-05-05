import { renderEditorSnapshotInjection } from './editorSnapshotContext'
import type { EditorSnapshotInjection } from './types'

const CURSOR = '<<CURSOR>>'

const baseInjection = (
  overrides: Partial<EditorSnapshotInjection> = {},
): EditorSnapshotInjection => ({
  type: 'editor-snapshot',
  filePath: 'notes/today.md',
  fileTitle: 'today',
  contextText: `Hello world\n${CURSOR}\nrest`,
  cursorMarker: CURSOR,
  ...overrides,
})

const messageText = (msg: { content: string | unknown[] }): string => {
  if (typeof msg.content === 'string') return msg.content
  return (msg.content as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')
}

describe('renderEditorSnapshotInjection — plain (no selection)', () => {
  it('returns null when nothing meaningful is present', () => {
    const result = renderEditorSnapshotInjection({
      type: 'editor-snapshot',
      filePath: '   ',
      fileTitle: '   ',
      contextText: '   ',
      cursorMarker: CURSOR,
    })
    expect(result).toBeNull()
  })

  it('includes file title, file path, and cursor context body', () => {
    const result = renderEditorSnapshotInjection(baseInjection())
    expect(result).not.toBeNull()
    const text = messageText(result!)
    expect(text).toContain('# Editor Snapshot')
    expect(text).toContain('File title: today')
    expect(text).toContain('File path: notes/today.md')
    expect(text).toContain(CURSOR)
    expect(text).toContain('Hello world')
    expect(text).toContain('rest')
  })

  it('omits file path line when path is empty', () => {
    const result = renderEditorSnapshotInjection(
      baseInjection({ filePath: '' }),
    )
    const text = messageText(result!)
    expect(text).toContain('File title: today')
    expect(text).not.toContain('File path:')
  })

  it('omits cursor section when context is empty but title/path remain', () => {
    const result = renderEditorSnapshotInjection(
      baseInjection({ contextText: '' }),
    )
    const text = messageText(result!)
    expect(text).toContain('File title: today')
    expect(text).toContain('File path: notes/today.md')
    expect(text).not.toContain(CURSOR)
    expect(text).not.toContain('text around the cursor')
  })
})

describe('renderEditorSnapshotInjection — selection-scoped', () => {
  it('wraps selection inline at cursor position when selection follows the marker', () => {
    const selection = 'world'
    const injection = baseInjection({
      contextText: `Hello ${CURSOR}${selection}\nrest`,
      selection: { content: selection, filePath: 'notes/today.md' },
    })
    const result = renderEditorSnapshotInjection(injection)
    const text = messageText(result!)
    expect(text).toContain('# Editor Snapshot')
    expect(text).toContain('Scope rules:')
    expect(text).toContain('<selection_context path="notes/today.md">')
    expect(text).toContain(
      `Hello <selected_text_start>\n${selection}\n</selected_text_end>\nrest`,
    )
    expect(text).not.toContain(CURSOR)
  })

  it('falls back to appending wrapped selection when selection is not adjacent to the cursor', () => {
    const selection = 'orphan'
    const injection = baseInjection({
      contextText: `Hello ${CURSOR}\nrest`,
      selection: { content: selection, filePath: 'notes/today.md' },
    })
    const result = renderEditorSnapshotInjection(injection)
    const text = messageText(result!)
    expect(text).toContain('Hello <<CURSOR>>')
    expect(text).toContain(
      `<selected_text_start>\n${selection}\n</selected_text_end>`,
    )
  })

  it('renders File title + File path lines alongside selection', () => {
    const selection = 'world'
    const injection = baseInjection({
      contextText: `Hello ${CURSOR}${selection}\nrest`,
      selection: { content: selection, filePath: 'notes/today.md' },
    })
    const text = messageText(renderEditorSnapshotInjection(injection)!)
    expect(text).toContain('File title: today')
    expect(text).toContain('File path: notes/today.md')
  })

  it('falls back to plain rendering when selection content is whitespace', () => {
    const injection = baseInjection({
      selection: { content: '   ', filePath: 'notes/today.md' },
    })
    const text = messageText(renderEditorSnapshotInjection(injection)!)
    expect(text).not.toContain('Scope rules:')
    expect(text).not.toContain('<selection_context')
    expect(text).toContain('text around the cursor')
  })
})
