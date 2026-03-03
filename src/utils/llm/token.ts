import { getEncoding } from 'js-tiktoken'

// TODO: Replace js-tiktoken with tiktoken library for better performance
// Note: tiktoken uses WebAssembly, requiring esbuild configuration

// Caution: tokenCount is computationally expensive for large inputs.
// Frequent use, especially on large files, may significantly impact performance.
let sharedEncoder: ReturnType<typeof getEncoding> | null = null

function getSharedEncoder(): ReturnType<typeof getEncoding> {
  if (!sharedEncoder) {
    sharedEncoder = getEncoding('cl100k_base')
  }
  return sharedEncoder
}

export function tokenCount(text: string): Promise<number> {
  const encoder = getSharedEncoder()
  const length = encoder.encode(text).length
  return Promise.resolve(length)
}
