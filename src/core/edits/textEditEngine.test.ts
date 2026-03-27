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

    expect(result.newContent).toBe('Intro\nInserted paragraph\n\nBody')
    expect(result.appliedCount).toBe(1)
    expect(result.operationResults[0]?.newRange).toEqual({
      start: 6,
      end: 24,
    })
  })

  it('does not add an extra blank line for list insert_after operations', () => {
    const result = materializeTextEditPlan({
      content: ['- A', '- B', '- C'].join('\n'),
      plan: {
        operations: [
          {
            type: 'insert_after',
            anchor: '- B',
            content: '- B.1',
          },
        ],
      },
    })

    expect(result.newContent).toBe(['- A', '- B', '- B.1', '- C'].join('\n'))
    expect(result.appliedCount).toBe(1)
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

  it('applies replace_lines operations by 1-based inclusive range', () => {
    const result = materializeTextEditPlan({
      content: ['# Title', 'alpha', 'beta', 'gamma'].join('\n'),
      plan: {
        operations: [
          {
            type: 'replace_lines',
            startLine: 2,
            endLine: 3,
            newText: ['delta', 'epsilon'].join('\n'),
          },
        ],
      },
    })

    expect(result.newContent).toBe(
      ['# Title', 'delta', 'epsilon', 'gamma'].join('\n'),
    )
    expect(result.appliedCount).toBe(1)
    expect(result.errors).toEqual([])
    expect(result.operationResults[0]?.matchMode).toBe('lineRange')
    expect(result.operationResults[0]?.matchedRange).toEqual({
      start: 8,
      end: 19,
    })
  })

  it('deletes the requested line range when replace_lines newText is empty', () => {
    const result = materializeTextEditPlan({
      content: ['one', 'two', 'three'].join('\n'),
      plan: {
        operations: [
          {
            type: 'replace_lines',
            startLine: 2,
            endLine: 3,
            newText: '',
          },
        ],
      },
    })

    expect(result.newContent).toBe('one')
    expect(result.appliedCount).toBe(1)
    expect(result.errors).toEqual([])
    expect(result.operationResults[0]?.newRange).toEqual({
      start: 3,
      end: 3,
    })
  })

  it('rejects replace_lines operations when the requested lines are out of bounds', () => {
    const result = materializeTextEditPlan({
      content: ['a', 'b'].join('\n'),
      plan: {
        operations: [
          {
            type: 'replace_lines',
            startLine: 2,
            endLine: 3,
            newText: 'x',
          },
        ],
      },
    })

    expect(result.appliedCount).toBe(0)
    expect(result.errors[0]).toContain('out of bounds')
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

  it('applies fuzzy replacement when a unique paragraph candidate exceeds threshold', () => {
    const content = [
      '# Notes',
      '',
      '### 知识提炼与沉淀 (Knowledge Distillation & Consolidation)',
      '日记的主要功能是学习和反思，不要盲目创建日记，仅当产生有价值的话题，亦或学习到全新知识时记录。',
      '',
      '你的核心竞争力不在于初始设定，而在于对交互数据的结构化沉淀。',
      '',
      '尾部保持不变。',
    ].join('\n')

    const result = materializeTextEditPlan({
      content,
      plan: {
        operations: [
          {
            type: 'replace',
            oldText: [
              '### 知识提炼与沉淀 (Knowledge Distillation & Consolidation)',
              '日记的主要功能是学习与反思，不要盲目创建日记，仅当产生有价值的话题，或学习到全新知识时记录。',
              '',
              '你的核心竞争力不在于初始设定，而在于对交互数据的结构化沉淀。',
            ].join('\n'),
            newText: '### 知识提炼与沉淀\n\n已更新的规范。',
          },
        ],
      },
    })

    expect(result.appliedCount).toBe(1)
    expect(result.errors).toEqual([])
    expect(result.operationResults[0]?.matchMode).toBe('fuzzyUniqueParagraph')
    expect(result.newContent).toContain('已更新的规范。')
    expect(result.newContent).toContain('尾部保持不变。')
  })

  it('rejects fuzzy replacement when multiple paragraph candidates exceed threshold', () => {
    const content = [
      '段落A：保持同样文本用于歧义测试，并确保字数足够长以触发模糊匹配机制。',
      '',
      '段落A：保持同样文本用于歧义测试，并确保字数足够长以触发模糊匹配机制。',
    ].join('\n')

    const result = materializeTextEditPlan({
      content,
      plan: {
        operations: [
          {
            type: 'replace',
            oldText:
              '段落A：保持同样文本用于歧义测试，并确保字数足够长以触发模糊匹配机制！',
            newText: '唯一替换目标。',
          },
        ],
      },
    })

    expect(result.appliedCount).toBe(0)
    expect(result.errors[0]).toContain('fuzzyCandidatesAboveThreshold=2')
  })
})

describe('recoverLikelyEscapedBackslashSequences', () => {
  it('restores likely escaped control characters', () => {
    expect(recoverLikelyEscapedBackslashSequences('foo\bbar')).toBe('foo\\bbar')
  })
})
