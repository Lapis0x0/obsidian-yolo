/** pgvector HNSW supports at most 2000 dimensions. */
export const supportedDimensionsForIndex = Object.freeze([
  128, 256, 384, 512, 768, 1024, 1280, 1536, 1792,
])
