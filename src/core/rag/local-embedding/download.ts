import { getDesktopProxyAgent } from '../../llm/sdkFetch'

/**
 * Streams one file to disk with resumable download support, verifying its
 * final size and SHA-256 before the caller may treat it as complete. Desktop
 * only — callers must gate on `Platform.isDesktop` before calling this (see
 * `manager.ts`).
 *
 * Bypasses Obsidian's `DataAdapter` (which buffers whole files in memory) and
 * writes directly through `node:fs`: local embedding model weights range from
 * ~25MB to ~570MB (`docs/plans/08-22-local-embedding/00-plan.md` §3.3), too
 * large to buffer twice (once for the download, once for
 * `adapter.writeBinary`) the way the runtime-component installer does for its
 * much smaller entry.js/wasm assets.
 *
 * Resume: if `partialPath` already has bytes, a `Range: bytes=<offset>-`
 * request is sent. A 206 response means the server honored it — this
 * function reads the existing partial bytes once to reseed a running SHA-256
 * (hash state isn't persisted across process restarts, so resuming a
 * partially-hashed file costs one read of what's already on disk, not a
 * re-download) and appends the rest. Any other successful status (e.g. a
 * server that ignores `Range` and returns 200 with the full body) restarts
 * the file from byte 0.
 */
export type DownloadFileOptions = Readonly<{
  url: string
  /** OS-absolute path for the finished, verified file. */
  destPath: string
  /** OS-absolute path for the in-progress `.partial` file. */
  partialPath: string
  expectedByteSize: number
  /** Lowercase hex, 64 chars. */
  expectedSha256: string
  signal?: AbortSignal
  /** Called with cumulative bytes received (including any resumed prefix) as the download progresses. */
  onProgress?: (receivedBytes: number) => void
}>

export class DownloadVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadVerificationError'
  }
}

export async function downloadFileResumable(
  options: DownloadFileOptions,
): Promise<void> {
  const {
    url,
    destPath,
    partialPath,
    expectedByteSize,
    expectedSha256,
    signal,
  } = options
  if (signal?.aborted) {
    throw new DOMException('Download aborted', 'AbortError')
  }

  // eslint-disable-next-line import/no-nodejs-modules -- callers must gate on Platform.isDesktop before calling this (see manager.ts)
  const fs = await import('node:fs')
  const fsp = fs.promises
  // eslint-disable-next-line import/no-nodejs-modules -- callers must gate on Platform.isDesktop before calling this (see manager.ts)
  const path = await import('node:path')
  // eslint-disable-next-line import/no-nodejs-modules -- callers must gate on Platform.isDesktop before calling this (see manager.ts)
  const crypto = await import('node:crypto')
  const nodeFetchModule = await import('node-fetch/lib/index.js')
  const nodeFetch = ((nodeFetchModule as unknown as { default?: typeof fetch })
    .default ?? nodeFetchModule) as unknown as (
    input: string,
    init?: Record<string, unknown>,
  ) => Promise<{
    ok: boolean
    status: number
    statusText: string
    body: (NodeJS.ReadableStream & { destroy?: (error?: Error) => void }) | null
  }>

  await fsp.mkdir(path.dirname(destPath), { recursive: true })

  let startOffset = 0
  try {
    startOffset = (await fsp.stat(partialPath)).size
  } catch {
    startOffset = 0
  }
  if (startOffset >= expectedByteSize) {
    // A stale/corrupt partial at or past the expected size can't be resumed
    // meaningfully — restart clean rather than risk a Range request the
    // server can't satisfy.
    startOffset = 0
  }

  const agent = await getDesktopProxyAgent()
  const sendRange = startOffset > 0
  const response = await nodeFetch(url, {
    headers: sendRange ? { Range: `bytes=${startOffset}-` } : {},
    agent,
    signal,
  })
  if (!response.ok) {
    throw new Error(
      `Download failed: HTTP ${response.status} ${response.statusText}`,
    )
  }
  const resumed = sendRange && response.status === 206
  const effectiveStartOffset = resumed ? startOffset : 0

  const hash = crypto.createHash('sha256')
  if (resumed && effectiveStartOffset > 0) {
    const existing = await fsp.readFile(partialPath)
    hash.update(existing)
  }

  const writeStream = fs.createWriteStream(partialPath, {
    flags: resumed ? 'a' : 'w',
  })

  let received = effectiveStartOffset
  const body = response.body
  if (!body) {
    throw new Error('Download response had no body')
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        body.destroy?.(new DOMException('Download aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const cleanup = () => signal?.removeEventListener('abort', onAbort)

      body.on('data', (chunk: Buffer) => {
        hash.update(chunk)
        received += chunk.length
        options.onProgress?.(received)
      })
      body.on('error', (error: Error) => {
        cleanup()
        reject(error)
      })
      writeStream.on('error', (error: Error) => {
        cleanup()
        reject(error)
      })
      writeStream.on('finish', () => {
        cleanup()
        resolve()
      })
      body.pipe(writeStream)
    })
  } catch (error) {
    writeStream.destroy()
    if (signal?.aborted) {
      throw new DOMException('Download aborted', 'AbortError')
    }
    throw error
  }

  if (received !== expectedByteSize) {
    throw new DownloadVerificationError(
      `Downloaded ${received} bytes, expected ${expectedByteSize}`,
    )
  }
  const digest = hash.digest('hex')
  if (digest !== expectedSha256) {
    throw new DownloadVerificationError(
      `SHA-256 mismatch: expected ${expectedSha256}, got ${digest}`,
    )
  }

  await fsp.rename(partialPath, destPath)
}
