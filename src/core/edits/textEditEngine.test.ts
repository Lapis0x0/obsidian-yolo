import {
  materializeTextEditPlan,
  recoverLikelyEscapedBackslashSequences,
} from './textEditEngine'

describe('materializeTextEditPlan', () => {
  it('applies replace operations with exact matching', () => {
    const result = materializeTextEditPlan({
      content: 'Hello world',
      plan: {
        operations: [
          {
            type: 'replace',
            oldText: 'Hello world',
            newText: 'Hello universe',
          },
        ],
      },
    })

    expect(result.newContent).toBe('Hello universe')
    expect(result.appliedCount).toBe(1)
    expect(result.errors).toEqual([])
    expect(result.operationResults[0]?.matchedRange).toEqual({
      start: 0,
      end: 11,
    })
    expect(result.operationResults[0]?.newRange).toEqual({
      start: 0,
      end: 14,
    })
  })

  it('applies insert_after operations', () => {
    const result = materializeTextEditPlan({
      content: 'Intro\n\nBody',
      plan: {
        operations: [
          {
            type: 'insert_after',
            anchor: 'Intro',
            content: 'Inserted paragraph',
          },
        ],
      },
    })

    expect(result.newContent).toBe('Intro\n\nInserted paragraph\n\nBody')
    expect(result.appliedCount).toBe(1)
    expect(result.operationResults[0]?.newRange).toEqual({
      start: 7,
      end: 25,
    })
  })

  it('applies append operations', () => {
    const result = materializeTextEditPlan({
      content: '# Title',
      plan: {
        operations: [
          {
            type: 'append',
            content: 'More text',
          },
        ],
      },
    })

    expect(result.newContent).toBe('# Title\n\nMore text')
    expect(result.appliedCount).toBe(1)
    expect(result.operationResults[0]?.newRange).toEqual({
      start: 9,
      end: 18,
    })
  })

  it('uses loose matching for smart quotes and line endings', () => {
    const result = materializeTextEditPlan({
      content: 'He said “hello”.\r\n',
      plan: {
        operations: [
          {
            type: 'replace',
            oldText: 'He said "hello".\n',
            newText: 'He said "hi".\n',
          },
        ],
      },
    })

    expect(result.newContent).toBe('He said "hi".\n')
    expect(result.operationResults[0]?.matchMode).toBe(
      'lineEndingAndTrimLineEnd',
    )
  })

  it('reports occurrence mismatches as errors', () => {
    const result = materializeTextEditPlan({
      content: 'repeat\nrepeat',
      plan: {
        operations: [
          {
            type: 'replace',
            oldText: 'repeat',
            newText: 'done',
          },
        ],
      },
    })

    expect(result.appliedCount).toBe(0)
    expect(result.errors[0]).toContain('expectedOccurrences mismatch')
  })
})

describe('recoverLikelyEscapedBackslashSequences', () => {
  it('restores likely escaped control characters', () => {
    expect(recoverLikelyEscapedBackslashSequences('foo\bbar')).toBe('foo\\bbar')
  })
})
