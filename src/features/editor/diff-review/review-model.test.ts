import type { DiffBlock } from '../../../utils/chat/diff'

import { generateReviewContent } from './review-model'

const createModifiedBlock = (
  originalValue: string | undefined,
  modifiedValue: string | undefined,
): Extract<DiffBlock, { type: 'modified' }> => {
  return {
    type: 'modified',
    originalValue,
    modifiedValue,
    inlineLines: [],
    presentation: 'inline',
    blockType: 'paragraph',
  }
}

describe('generateReviewContent', () => {
  it('keeps original text without introducing extra blank lines when rejecting insertion', () => {
    const blocks: DiffBlock[] = [
      { type: 'unchanged', value: 'A' },
      createModifiedBlock(undefined, 'X'),
      { type: 'unchanged', value: 'B' },
    ]

    const result = generateReviewContent(blocks, new Map([[1, 'current']]))

    expect(result).toBe('A\nB')
  })

  it('applies insertion when accepting incoming', () => {
    const blocks: DiffBlock[] = [
      { type: 'unchanged', value: 'A' },
      createModifiedBlock(undefined, 'X'),
      { type: 'unchanged', value: 'B' },
    ]

    const result = generateReviewContent(blocks, new Map([[1, 'incoming']]))

    expect(result).toBe('A\nX\nB')
  })

  it('removes deleted text when accepting incoming deletion', () => {
    const blocks: DiffBlock[] = [
      { type: 'unchanged', value: 'A' },
      createModifiedBlock('X', undefined),
      { type: 'unchanged', value: 'B' },
    ]

    const result = generateReviewContent(blocks, new Map([[1, 'incoming']]))

    expect(result).toBe('A\nB')
  })
})
