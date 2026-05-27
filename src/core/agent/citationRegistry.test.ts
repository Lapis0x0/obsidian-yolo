import { CitationRegistry } from './citationRegistry'

describe('CitationRegistry', () => {
  it('assigns ordinals starting at 1', () => {
    const registry = new CitationRegistry()
    const ordinal = registry.assign('content:a.md:1:2', {
      path: 'a.md',
      startLine: 1,
      endLine: 2,
      snippet: 'hello',
      source: 'rag',
    })
    expect(ordinal).toBe(1)
    expect(registry.size).toBe(1)
  })

  it('dedupes by key and returns the same ordinal', () => {
    const registry = new CitationRegistry()
    const first = registry.assign('content:a.md:1:2', {
      path: 'a.md',
      startLine: 1,
      endLine: 2,
      snippet: 'first',
      source: 'rag',
    })
    const second = registry.assign('content:a.md:1:2', {
      path: 'a.md',
      startLine: 1,
      endLine: 2,
      snippet: 'second',
      source: 'keyword',
    })
    expect(second).toBe(first)
    expect(registry.size).toBe(1)
    expect(registry.toArray()[0].snippet).toBe('first')
  })

  it('assigns distinct ordinals for distinct keys', () => {
    const registry = new CitationRegistry()
    const ord1 = registry.assign('content:a.md:1:2', {
      path: 'a.md',
      startLine: 1,
      endLine: 2,
      snippet: 's1',
      source: 'rag',
    })
    const ord2 = registry.assign('content:b.md:3:4', {
      path: 'b.md',
      startLine: 3,
      endLine: 4,
      snippet: 's2',
      source: 'hybrid',
    })
    const ord3 = registry.assign('content:a.md:5:6', {
      path: 'a.md',
      startLine: 5,
      endLine: 6,
      snippet: 's3',
      source: 'rag',
    })
    expect([ord1, ord2, ord3]).toEqual([1, 2, 3])
    expect(registry.size).toBe(3)
  })

  it('toArray returns entries sorted by ordinal', () => {
    const registry = new CitationRegistry()
    registry.assign('k1', {
      path: 'a.md',
      startLine: 1,
      endLine: 1,
      snippet: 's1',
      source: 'rag',
    })
    registry.assign('k2', {
      path: 'b.md',
      startLine: 2,
      endLine: 2,
      snippet: 's2',
      source: 'keyword',
    })
    registry.assign('k1', {
      path: 'a.md',
      startLine: 1,
      endLine: 1,
      snippet: 's1-dup',
      source: 'rag',
    })
    const arr = registry.toArray()
    expect(arr.map((entry) => entry.ordinal)).toEqual([1, 2])
    expect(arr.map((entry) => entry.snippet)).toEqual(['s1', 's2'])
  })
})
