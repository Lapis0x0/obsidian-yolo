import { mergeRagQueryResults } from './ragQueryMerge'

type Row = {
  path: string
  similarity: number
  metadata: { page?: number; startLine: number; endLine: number }
}

const row = (overrides: Partial<Row>): Row => ({
  path: 'notes/a.md',
  similarity: 0.5,
  metadata: { startLine: 1, endLine: 5 },
  ...overrides,
})

describe('mergeRagQueryResults', () => {
  it('dedupes identical chunks returned by more than one knowledge base, keeping the highest similarity', () => {
    const chunkA = row({
      similarity: 0.4,
      metadata: { startLine: 1, endLine: 5 },
    })
    const chunkADuplicate = row({
      similarity: 0.9,
      metadata: { startLine: 1, endLine: 5 },
    })
    const chunkB = row({
      path: 'notes/b.md',
      similarity: 0.6,
      metadata: { startLine: 10, endLine: 20 },
    })

    const merged = mergeRagQueryResults(
      [[chunkA, chunkB], [chunkADuplicate]],
      10,
    )

    expect(merged).toHaveLength(2)
    // The higher-similarity duplicate wins, sorted first.
    expect(merged[0]).toBe(chunkADuplicate)
    expect(merged[1]).toBe(chunkB)
  })

  it('truncates to the limit only after dedup, not before', () => {
    const rows = [
      row({ similarity: 0.9, metadata: { startLine: 1, endLine: 5 } }),
      row({ similarity: 0.9, metadata: { startLine: 1, endLine: 5 } }), // duplicate of the above
      row({ similarity: 0.8, metadata: { startLine: 10, endLine: 15 } }),
      row({ similarity: 0.7, metadata: { startLine: 20, endLine: 25 } }),
    ]

    const merged = mergeRagQueryResults([rows], 2)

    // If truncation happened before dedup, the duplicate could have crowded
    // out a genuinely distinct lower-similarity chunk.
    expect(merged).toHaveLength(2)
    expect(merged.map((r) => r.metadata.startLine)).toEqual([1, 10])
  })

  it('does not merge two distinct chunks that share a PDF page number', () => {
    // Two different chunks on the same PDF page share `metadata.page` but
    // have distinct line ranges within that page's synthetic text — they
    // must never collide under the same dedup key.
    const chunk1 = row({
      path: 'doc.pdf',
      similarity: 0.9,
      metadata: { page: 3, startLine: 0, endLine: 40 },
    })
    const chunk2 = row({
      path: 'doc.pdf',
      similarity: 0.85,
      metadata: { page: 3, startLine: 41, endLine: 90 },
    })

    const merged = mergeRagQueryResults([[chunk1, chunk2]], 10)

    expect(merged).toHaveLength(2)
    expect(merged).toEqual(expect.arrayContaining([chunk1, chunk2]))
  })

  it('does treat identical path+page+line-range PDF chunks as duplicates', () => {
    const chunk1 = row({
      path: 'doc.pdf',
      similarity: 0.9,
      metadata: { page: 3, startLine: 0, endLine: 40 },
    })
    const chunk2 = row({
      path: 'doc.pdf',
      similarity: 0.7,
      metadata: { page: 3, startLine: 0, endLine: 40 },
    })

    const merged = mergeRagQueryResults([[chunk1, chunk2]], 10)

    expect(merged).toEqual([chunk1])
  })
})
