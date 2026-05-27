export type CitationSource = {
  ordinal: number
  path: string
  startLine: number
  endLine: number
  page?: number
  snippet: string
  similarity?: number
  source: 'rag' | 'keyword' | 'hybrid'
}

export class CitationRegistry {
  private byKey = new Map<string, CitationSource>()
  private nextOrdinal = 1

  assign(dedupKey: string, meta: Omit<CitationSource, 'ordinal'>): number {
    const existing = this.byKey.get(dedupKey)
    if (existing) {
      return existing.ordinal
    }
    const ordinal = this.nextOrdinal
    this.nextOrdinal += 1
    this.byKey.set(dedupKey, { ...meta, ordinal })
    return ordinal
  }

  toArray(): CitationSource[] {
    return [...this.byKey.values()].sort((a, b) => a.ordinal - b.ordinal)
  }

  get size(): number {
    return this.byKey.size
  }
}
