type EmbeddingResponseShape = Record<string, unknown>

export const extractEmbeddingVector = (response: unknown): number[] => {
  if (Array.isArray(response) && response.length > 0) {
    if (response.every((value) => typeof value === 'number')) {
      return response
    }
    const first = response[0] as EmbeddingResponseShape
    if (Array.isArray(first.embedding)) {
      return first.embedding as number[]
    }
  }

  if (response && typeof response === 'object') {
    const record = response as EmbeddingResponseShape
    const data = record.data

    if (Array.isArray(data) && data.length > 0) {
      const first = data[0] as EmbeddingResponseShape
      if (Array.isArray(first.embedding)) {
        return first.embedding as number[]
      }
    }

    if (data && typeof data === 'object') {
      const dataRecord = data as EmbeddingResponseShape
      if (Array.isArray(dataRecord.embedding)) {
        return dataRecord.embedding as number[]
      }
    }

    if (Array.isArray(record.embedding)) {
      return record.embedding as number[]
    }
  }

  throw new Error('Embedding model returned an invalid result')
}
