import {
  type SearchTextItem,
  buildPageSearchIndex,
  findInPage,
  normalizeQuery,
} from './textSearch'

const item = (text: string, endsLine = false): SearchTextItem => ({
  text,
  endsLine,
})

function find(items: readonly SearchTextItem[], query: string) {
  return findInPage(buildPageSearchIndex(items), normalizeQuery(query))
}

describe('normalizeQuery', () => {
  it('lowercases, collapses whitespace and trims', () => {
    expect(normalizeQuery('  Hello \t  World\n')).toBe('hello world')
  })

  it('is empty for a query of nothing but whitespace', () => {
    expect(normalizeQuery(' \u3000 ')).toBe('')
  })

  it('folds full-width and ligature forms', () => {
    expect(normalizeQuery('ＡＢＣ ﬁle')).toBe('abc file')
  })
})

describe('findInPage', () => {
  it('finds case-insensitively and maps back to item offsets', () => {
    expect(find([item('The Transformer model')], 'transformer')).toEqual([
      [0, 4, 0, 15],
    ])
  })

  it('returns every non-overlapping match in reading order', () => {
    expect(find([item('aaaa'), item('aa')], 'aa')).toEqual([
      [0, 0, 0, 2],
      [0, 2, 0, 4],
      [1, 0, 1, 2],
    ])
  })

  it('matches across items with the tuple spanning them', () => {
    expect(find([item('atten'), item('tion is')], 'attention')).toEqual([
      [0, 0, 1, 4],
    ])
  })

  it('treats runs of whitespace as one space', () => {
    expect(find([item('deep    learning')], 'deep learning')).toEqual([
      [0, 0, 0, 16],
    ])
  })

  it('joins Latin lines with a space', () => {
    const items = [item('neural', true), item('networks')]
    expect(find(items, 'neural networks')).toEqual([[0, 0, 1, 8]])
    expect(find(items, 'neuralnetworks')).toEqual([])
  })

  it('joins CJK lines with nothing', () => {
    const items = [item('注意力机', true), item('制是核心')]
    expect(find(items, '注意力机制')).toEqual([[0, 0, 1, 1]])
  })

  it('does not double a space already at the end of a line', () => {
    const items = [item('neural ', true), item('networks')]
    expect(find(items, 'neural networks')).toEqual([[0, 0, 1, 8]])
  })

  it('matches inside words and CJK runs', () => {
    expect(find([item('我们提出一种新方法')], '一种')).toEqual([[0, 4, 0, 6]])
    expect(find([item('pretraining')], 'train')).toEqual([[0, 3, 0, 8]])
  })

  it('points a folded ligature at its one source character', () => {
    // "ﬁ" is one UTF-16 unit that folds to two characters.
    expect(find([item('ﬁne tuning')], 'fine')).toEqual([[0, 0, 0, 3]])
    expect(find([item('ﬁne tuning')], 'ine')).toEqual([[0, 0, 0, 3]])
  })

  it('counts offsets in UTF-16 units past astral characters', () => {
    expect(find([item('𝑥 equals y')], 'equals')).toEqual([[0, 3, 0, 9]])
  })

  it('finds nothing for an empty query', () => {
    expect(find([item('anything')], '   ')).toEqual([])
  })
})
