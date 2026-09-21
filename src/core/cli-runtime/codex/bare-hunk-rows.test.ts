import { EDIT_DIFF_MAX_CHANGED_LINES } from '../../tools/file-change-rows'

import { parseBareHunkRows } from './bare-hunk-rows'

describe('parseBareHunkRows', () => {
  it('numbers a single hunk from its header', () => {
    expect(parseBareHunkRows('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n')).toEqual({
      rows: [
        {
          type: 'line',
          change: 'unchanged',
          oldLineNumber: 1,
          newLineNumber: 1,
          text: 'a',
        },
        { type: 'line', change: 'removed', oldLineNumber: 2, text: 'b' },
        { type: 'line', change: 'added', newLineNumber: 2, text: 'B' },
        {
          type: 'line',
          change: 'unchanged',
          oldLineNumber: 3,
          newLineNumber: 3,
          text: 'c',
        },
      ],
      hiddenTrailingLines: 0,
    })
  })

  it('opens with a gap when the first hunk starts past line 1', () => {
    const { rows } = parseBareHunkRows('@@ -272,3 +272,3 @@\n x\n-y\n+Y\n z')
    expect(rows[0]).toEqual({ type: 'gap', hiddenLines: 271 })
    expect(rows[1]).toMatchObject({ oldLineNumber: 272, newLineNumber: 272 })
    expect(rows[2]).toMatchObject({ change: 'removed', oldLineNumber: 273 })
    expect(rows[3]).toMatchObject({ change: 'added', newLineNumber: 273 })
  })

  it('puts a gap between hunks and keeps each hunk on its own numbers', () => {
    // Real Codex output: context radius 1, one line inserted by hunk one.
    const { rows } = parseBareHunkRows(
      '@@ -1,3 +1,4 @@\n l1\n-l2\n+L2\n+L2b\n l3\n@@ -10,3 +11,3 @@\n l10\n-l11\n+L11\n l12\n',
    )
    const gapIndex = rows.findIndex((row) => row.type === 'gap')
    expect(gapIndex).toBe(5)
    expect(rows[gapIndex]).toEqual({ type: 'gap', hiddenLines: 6 })
    expect(rows[gapIndex + 1]).toMatchObject({
      change: 'unchanged',
      oldLineNumber: 10,
      newLineNumber: 11,
      text: 'l10',
    })
    expect(rows[gapIndex + 2]).toMatchObject({
      change: 'removed',
      oldLineNumber: 11,
    })
    expect(rows[gapIndex + 3]).toMatchObject({
      change: 'added',
      newLineNumber: 12,
    })
  })

  it('reads a pure-insertion hunk (`-0,0`) as added lines from line 1', () => {
    expect(parseBareHunkRows('@@ -0,0 +1,2 @@\n+a\n+b\n')).toEqual({
      rows: [
        { type: 'line', change: 'added', newLineNumber: 1, text: 'a' },
        { type: 'line', change: 'added', newLineNumber: 2, text: 'b' },
      ],
      hiddenTrailingLines: 0,
    })
  })

  it('places an insertion hunk after the line its zero-count side names', () => {
    const { rows } = parseBareHunkRows('@@ -5,0 +6 @@\n+inserted')
    expect(rows).toEqual([
      { type: 'gap', hiddenLines: 5 },
      { type: 'line', change: 'added', newLineNumber: 6, text: 'inserted' },
    ])
  })

  it('reads a pure-removal hunk as removed lines', () => {
    expect(parseBareHunkRows('@@ -1,2 +0,0 @@\n-a\n-b\n').rows).toEqual([
      { type: 'line', change: 'removed', oldLineNumber: 1, text: 'a' },
      { type: 'line', change: 'removed', oldLineNumber: 2, text: 'b' },
    ])
  })

  it('ignores the no-newline marker and anything after the last hunk body', () => {
    const { rows } = parseBareHunkRows(
      '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n\n\nMoved to: b.md',
    )
    expect(rows).toEqual([
      { type: 'line', change: 'removed', oldLineNumber: 1, text: 'old' },
      { type: 'line', change: 'added', newLineNumber: 1, text: 'new' },
    ])
  })

  it('reads an empty line inside a hunk body as blank context', () => {
    const { rows } = parseBareHunkRows('@@ -1,3 +1,3 @@\n a\n\n-b\n+B')
    expect(rows[1]).toEqual({
      type: 'line',
      change: 'unchanged',
      oldLineNumber: 2,
      newLineNumber: 2,
      text: '',
    })
  })

  it('stops after the shared changed-line budget and counts what it hid', () => {
    const added = Array.from(
      { length: EDIT_DIFF_MAX_CHANGED_LINES + 20 },
      (_, index) => `+line ${index + 1}`,
    )
    const diff = [
      `@@ -0,0 +1,${added.length} @@`,
      ...added,
      '@@ -1,1 +321,1 @@',
      ' tail',
    ].join('\n')
    const { rows, hiddenTrailingLines } = parseBareHunkRows(diff)
    expect(rows).toHaveLength(EDIT_DIFF_MAX_CHANGED_LINES)
    expect(rows[rows.length - 1]).toMatchObject({
      change: 'added',
      newLineNumber: EDIT_DIFF_MAX_CHANGED_LINES,
    })
    expect(hiddenTrailingLines).toBe(21)
  })
})
