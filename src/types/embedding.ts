export type EmbeddingModelClient = {
  id: string
  dimension: number
  getEmbedding: (text: string) => Promise<number[]>
}

export type EmbeddingDbStats = {
  model: string
  rowCount: number
  /** `rowCount * dimension * 4` — the on-disk float32 vector payload's estimated size in bytes. */
  vectorBytes: number
}
