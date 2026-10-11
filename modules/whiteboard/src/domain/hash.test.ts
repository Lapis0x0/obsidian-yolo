import { hashText } from './hash'

describe('hashText', () => {
  it('names the same text the same way, in letters and digits', () => {
    expect(hashText('notes/a.pdf')).toBe(hashText('notes/a.pdf'))
    expect(hashText('notes/a.pdf')).toMatch(/^[a-z0-9]+$/)
  })

  it('tells texts apart', () => {
    expect(hashText('a')).not.toBe(hashText('b'))
    expect(hashText('')).not.toBe(hashText(' '))
  })

  it('keeps a seed apart from the text it starts', () => {
    expect(hashText('c', 'ab')).not.toBe(hashText('bc', 'a'))
    expect(hashText('a', 'seed')).not.toBe(hashText('a'))
  })
})
