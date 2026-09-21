import {
  type InlineDiffLine,
  createInlineDiffLines,
} from '../../../utils/chat/diff'

import {
  EDIT_DIFF_MAX_CHANGED_LINES,
  type EditDiffRow,
  buildEditContentRows,
  buildEditDiffRows,
} from './editDiffRows'

const line = (type: InlineDiffLine['type'], text: string): InlineDiffLine => ({
  type,
  tokens: [
    {
      type: type === 'added' ? 'add' : type === 'removed' ? 'del' : 'same',
      text,
    },
  ],
})

const describeRow = (row: EditDiffRow): string =>
  row.type === 'gap'
    ? `gap:${row.hiddenLines}`
    : `${row.change}:${row.oldLineNumber ?? '-'}/${row.newLineNumber ?? '-'}:${row.text}`

describe('buildEditDiffRows', () => {
  it('numbers unchanged, removed and added lines against the right side', () => {
    const { rows, hiddenTrailingLines } = buildEditDiffRows({
      lines: [
        line('unchanged', 'a'),
        line('removed', 'b'),
        line('added', 'B'),
        line('unchanged', 'c'),
      ],
    })

    expect(rows.map(describeRow)).toEqual([
      'unchanged:1/1:a',
      // The removed line keeps its old number and has no new one; the added
      // line is the reverse.
      'removed:2/-:b',
      'added:-/2:B',
      'unchanged:3/3:c',
    ])
    expect(hiddenTrailingLines).toBe(0)
  })

  it('keeps three context lines on each side and collapses the rest into one gap', () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, index) =>
        line('unchanged', `head-${index}`),
      ),
      line('added', 'new'),
      ...Array.from({ length: 10 }, (_, index) =>
        line('unchanged', `tail-${index}`),
      ),
    ]

    expect(buildEditDiffRows({ lines }).rows.map(describeRow)).toEqual([
      'gap:7',
      'unchanged:8/8:head-7',
      'unchanged:9/9:head-8',
      'unchanged:10/10:head-9',
      'added:-/11:new',
      'unchanged:11/12:tail-0',
      'unchanged:12/13:tail-1',
      'unchanged:13/14:tail-2',
      'gap:7',
    ])
  })

  it('merges context when two changed runs are close enough to overlap', () => {
    const lines = [
      line('added', 'x'),
      ...Array.from({ length: 4 }, (_, index) =>
        line('unchanged', `mid-${index}`),
      ),
      line('added', 'y'),
    ]

    // 4 unchanged lines between two changes, each within 3 of one of them:
    // nothing is dropped, so no gap row appears.
    expect(
      buildEditDiffRows({ lines }).rows.filter((row) => row.type === 'gap'),
    ).toEqual([])
  })

  it('stops after the changed-line cap and reports what it cut', () => {
    const lines = Array.from({ length: 400 }, (_, index) =>
      line('added', `line-${index}`),
    )

    const { rows, hiddenTrailingLines } = buildEditDiffRows({ lines })

    expect(rows).toHaveLength(EDIT_DIFF_MAX_CHANGED_LINES)
    expect(describeRow(rows[EDIT_DIFF_MAX_CHANGED_LINES - 1])).toBe(
      'added:-/300:line-299',
    )
    expect(hiddenTrailingLines).toBe(100)
  })

  it('counts the cut in lines, not in changed lines only', () => {
    const lines = [
      line('added', 'a'),
      line('added', 'b'),
      line('unchanged', 'c'),
      line('added', 'd'),
    ]

    const { rows, hiddenTrailingLines } = buildEditDiffRows({
      lines,
      maxChangedLines: 2,
    })

    expect(rows.map(describeRow)).toEqual(['added:-/1:a', 'added:-/2:b'])
    // The unchanged line that follows is dropped along with the third change.
    expect(hiddenTrailingLines).toBe(2)
  })

  it('renders a whole-file creation as all added lines', () => {
    const { rows } = buildEditDiffRows({
      lines: createInlineDiffLines([], ['first', 'second']),
    })

    expect(rows.map(describeRow)).toEqual([
      'added:-/1:first',
      'added:-/2:second',
    ])
  })
})

describe('buildEditContentRows', () => {
  it('numbers every line and collapses nothing', () => {
    expect(
      buildEditContentRows({ text: 'a\nb\nc' }).rows.map(describeRow),
    ).toEqual(['unchanged:-/1:a', 'unchanged:-/2:b', 'unchanged:-/3:c'])
  })

  it('caps long content and reports the remainder', () => {
    const text = Array.from({ length: 12 }, (_, index) => `l${index}`).join(
      '\n',
    )

    const { rows, hiddenTrailingLines } = buildEditContentRows({
      text,
      maxLines: 5,
    })

    expect(rows).toHaveLength(5)
    expect(hiddenTrailingLines).toBe(7)
  })
})
