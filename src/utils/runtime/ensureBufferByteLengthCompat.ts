type BufferLike = {
  byteLength?: (input: string, encoding?: string) => number
  from?: (input: string, encoding?: string) => Uint8Array
}

const UTF8_ENCODER =
  typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

const fallbackUtf8ByteLength = (input: string): number => {
  if (UTF8_ENCODER) {
    return UTF8_ENCODER.encode(input).byteLength
  }
  return input.length
}

export const ensureBufferByteLengthCompat = (): void => {
  const maybeGlobal = globalThis as typeof globalThis & {
    Buffer?: BufferLike
  }

  const buffer = maybeGlobal.Buffer
  if (!buffer || typeof buffer.byteLength === 'function') {
    return
  }

  try {
    buffer.byteLength = (input: string, encoding?: string): number => {
      const normalizedEncoding = encoding?.toLowerCase()
      if (
        normalizedEncoding &&
        normalizedEncoding !== 'utf8' &&
        normalizedEncoding !== 'utf-8' &&
        typeof buffer.from === 'function'
      ) {
        return buffer.from(input, encoding).byteLength
      }
      return fallbackUtf8ByteLength(input)
    }
  } catch {
    // Ignore; if runtime blocks property write, existing behavior remains unchanged.
  }
}
