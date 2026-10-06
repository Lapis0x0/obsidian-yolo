// The browser's zlib stream as the encoders' `CreateDeflater`
// (domain/imageFiles.ts): what a board export compresses its rows with.

import type { ByteSink, CreateDeflater } from '../../domain/imageFiles'

export const createBrowserDeflater: CreateDeflater = (output: ByteSink) => {
  const stream = new CompressionStream('deflate')
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  let failure: Error | null = null
  // Read as it is written, or the stream's queue fills and a write waits for
  // a reader that never comes.
  const drained = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      await output(value)
    }
  })().catch((error: unknown) => {
    const reason = error instanceof Error ? error : new Error(String(error))
    failure = reason
    void writer.abort(reason).catch(() => undefined)
    throw reason
  })
  return {
    push: async (bytes) => {
      if (failure !== null) throw failure
      await writer.ready
      // A write resolves once the stream has taken the chunk in, so the
      // caller may reuse its buffer after awaiting this.
      await writer.write(bytes)
    },
    finish: async () => {
      if (failure !== null) throw failure
      await writer.close()
      await drained
    },
  }
}

/** `bytes` as one whole zlib stream. */
export async function deflateAll(bytes: Uint8Array): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let length = 0
  const deflater = createBrowserDeflater(async (chunk) => {
    parts.push(chunk)
    length += chunk.length
  })
  await deflater.push(bytes)
  await deflater.finish()
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
