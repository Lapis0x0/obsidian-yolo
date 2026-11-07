import { BoardFind, type FindableCard } from './boardFind'

const card = (id: string, source: string, from = 0): FindableCard => ({
  id,
  source,
  from,
})

/** What each hit covers in its card's source. */
const found = (cards: readonly FindableCard[], query: string): string[] => {
  const byId = new Map(cards.map((c) => [c.id, c.source]))
  return new BoardFind()
    .find(cards, query)
    .map((hit) => `${hit.id}:${byId.get(hit.id)?.slice(hit.start, hit.end)}`)
}

describe('BoardFind', () => {
  test('finds every occurrence, card by card in the order given', () => {
    const cards = [
      card('a', '苹果和香蕉，还有苹果'),
      card('b', 'no fruit'),
      card('c', '苹果'),
    ]
    expect(found(cards, '苹果')).toEqual(['a:苹果', 'a:苹果', 'c:苹果'])
  })

  test('ignores case, width and Markdown marks, and maps back to the source', () => {
    const cards = [card('a', 'Some **Bold** text and ＡＢＣ')]
    expect(found(cards, 'bold text')).toEqual(['a:Bold** text'])
    expect(found(cards, 'abc')).toEqual(['a:ＡＢＣ'])
  })

  test('joins a wrapped Chinese line without a space and a wrapped English one with one', () => {
    const cards = [card('a', '一个句子\n接着写完'), card('b', 'two\nwords')]
    expect(found(cards, '句子接着')).toEqual(['a:句子\n接着'])
    expect(found(cards, 'two words')).toEqual(['b:two\nwords'])
  })

  test('looks only past where a card says its text starts', () => {
    const source = '---\ntitle: 苹果\n---\n正文里的苹果'
    const from = source.indexOf('正文')
    expect(found([card('a', source, from)], '苹果')).toEqual(['a:苹果'])
    const [hit] = new BoardFind().find([card('a', source, from)], '苹果')
    expect(hit.start).toBe(source.lastIndexOf('苹果'))
  })

  test('finds nothing for an empty query, and follows a card whose text changed', () => {
    const find = new BoardFind()
    expect(find.find([card('a', 'abc')], '  ')).toEqual([])
    expect(find.find([card('a', 'abc')], 'b')).toHaveLength(1)
    expect(find.find([card('a', 'xyz')], 'b')).toHaveLength(0)
    expect(find.find([card('a', 'xbz')], 'b')).toHaveLength(1)
  })
})
