import {
  findLoose,
  looseText,
  resolveTextAnchor,
  textAnchorAt,
} from './textAnchor'

const SOURCE = [
  '# Notes',
  '',
  'The **key idea** is that memory is written for the future.',
  '',
  'A [link](https://example.com) and the key idea again.',
].join('\n')

describe('textAnchorAt / resolveTextAnchor', () => {
  const start = SOURCE.indexOf('memory is written')
  const anchor = textAnchorAt(SOURCE, [
    start,
    start + 'memory is written'.length,
  ])

  it('finds the passage where it was', () => {
    expect(resolveTextAnchor(SOURCE, anchor)).toEqual([
      start,
      start + 'memory is written'.length,
    ])
  })

  it('follows the passage when text before it changes', () => {
    const edited = `Intro line.\n${SOURCE}`
    const at = edited.indexOf('memory is written')
    expect(resolveTextAnchor(edited, anchor)).toEqual([
      at,
      at + 'memory is written'.length,
    ])
  })

  it('tells repeats apart by their context', () => {
    const second = SOURCE.lastIndexOf('key idea')
    const repeated = textAnchorAt(SOURCE, [second, second + 'key idea'.length])
    const edited = `x${SOURCE}`
    expect(resolveTextAnchor(edited, repeated)).toEqual([
      second + 1,
      second + 1 + 'key idea'.length,
    ])
  })

  it('gives up on a passage that was rewritten', () => {
    const edited = SOURCE.replace('memory is written', 'memory gets written')
    expect(resolveTextAnchor(edited, anchor)).toBeNull()
  })
})

describe('findLoose', () => {
  it('matches rendered text to its Markdown source', () => {
    const span = findLoose(SOURCE, 'The key idea is that memory')
    expect(span && SOURCE.slice(span[0], span[1])).toBe(
      'The **key idea** is that memory',
    )
  })

  it('uses context to pick between repeats', () => {
    const span = findLoose(SOURCE, 'key idea', { before: 'and the' })
    expect(span?.[0]).toBe(SOURCE.lastIndexOf('key idea'))
  })

  it('finds nothing for text without letters or digits', () => {
    expect(findLoose(SOURCE, ' ** ')).toBeNull()
  })

  it('maps CJK text back to its source', () => {
    const source = '长期记忆对于**对话智能体**至关重要。'
    const span = findLoose(source, '对话智能体至关')
    expect(span && source.slice(span[0], span[1])).toBe('对话智能体**至关')
  })
})

describe('looseText', () => {
  it('keeps letters and digits, lowercased, with where they came from', () => {
    expect(looseText('A-b 1!')).toEqual({ text: 'ab1', map: [0, 2, 4] })
  })
})
