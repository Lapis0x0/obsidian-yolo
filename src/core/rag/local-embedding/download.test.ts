// eslint-disable-next-line import/no-nodejs-modules -- real filesystem/hash round-trip against a temp directory, see file doc below
import { createHash } from 'node:crypto'
// eslint-disable-next-line import/no-nodejs-modules -- real filesystem/hash round-trip against a temp directory, see file doc below
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
// eslint-disable-next-line import/no-nodejs-modules -- real filesystem/hash round-trip against a temp directory, see file doc below
import { tmpdir } from 'node:os'
// eslint-disable-next-line import/no-nodejs-modules -- real filesystem/hash round-trip against a temp directory, see file doc below
import { join } from 'node:path'
// eslint-disable-next-line import/no-nodejs-modules -- fake fetch response bodies are real Node Readables so `.pipe()`/`.destroy()` behave exactly like the real thing
import { Readable } from 'node:stream'

import { DownloadVerificationError, downloadFileResumable } from './download'

/**
 * Exercises `downloadFileResumable` end-to-end against a real OS temp
 * directory and real `node:fs`/`node:crypto` — only `node-fetch` is faked,
 * with a real `stream.Readable` response body so pipe/backpressure/abort
 * behave exactly like production. `manager.test.ts` mocks this whole module
 * out, so this is the only place the resume/verify/cancel contract itself
 * is tested.
 */

const mockFetch = jest.fn()

jest.mock('node-fetch/lib/index.js', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFetch(...args),
}))

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

let dir: string

beforeEach(() => {
  mockFetch.mockReset()
  dir = mkdtempSync(join(tmpdir(), 'yolo-local-embedding-download-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('downloadFileResumable', () => {
  it('appends a 206 resume response onto the existing partial and verifies the combined hash', async () => {
    const destPath = join(dir, 'model.bin')
    const partialPath = `${destPath}.partial`
    writeFileSync(partialPath, 'hello ')
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      body: Readable.from([Buffer.from('world')]),
    }))

    await downloadFileResumable({
      url: 'https://example.test/model.bin',
      destPath,
      partialPath,
      expectedByteSize: 'hello world'.length,
      expectedSha256: sha256('hello world'),
    })

    expect(readFileSync(destPath, 'utf8')).toBe('hello world')
    expect(existsSync(partialPath)).toBe(false)
    const [, init] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ]
    expect(init.headers).toEqual({ Range: 'bytes=6-' })
  })

  it('restarts from byte 0 when the server ignores Range and returns 200', async () => {
    const destPath = join(dir, 'model.bin')
    const partialPath = `${destPath}.partial`
    writeFileSync(partialPath, 'stale-partial-from-a-previous-attempt')
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: Readable.from([Buffer.from('full-content')]),
    }))

    await downloadFileResumable({
      url: 'https://example.test/model.bin',
      destPath,
      partialPath,
      expectedByteSize: 'full-content'.length,
      expectedSha256: sha256('full-content'),
    })

    expect(readFileSync(destPath, 'utf8')).toBe('full-content')
  })

  it('throws DownloadVerificationError and leaves no dest file on a byte-count mismatch', async () => {
    const destPath = join(dir, 'model.bin')
    const partialPath = `${destPath}.partial`
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: Readable.from([Buffer.from('short')]),
    }))

    await expect(
      downloadFileResumable({
        url: 'https://example.test/model.bin',
        destPath,
        partialPath,
        expectedByteSize: 999,
        expectedSha256: sha256('short'),
      }),
    ).rejects.toBeInstanceOf(DownloadVerificationError)
    expect(existsSync(destPath)).toBe(false)
  })

  it('throws DownloadVerificationError and leaves no dest file on a SHA-256 mismatch', async () => {
    const destPath = join(dir, 'model.bin')
    const partialPath = `${destPath}.partial`
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: Readable.from([Buffer.from('actual-content')]),
    }))

    await expect(
      downloadFileResumable({
        url: 'https://example.test/model.bin',
        destPath,
        partialPath,
        expectedByteSize: 'actual-content'.length,
        expectedSha256: sha256('different-content'),
      }),
    ).rejects.toBeInstanceOf(DownloadVerificationError)
    expect(existsSync(destPath)).toBe(false)
  })

  it('keeps the partial file untouched and rejects with AbortError when cancelled mid-stream', async () => {
    const destPath = join(dir, 'model.bin')
    const partialPath = `${destPath}.partial`
    const originalPartialContent = 'already-downloaded-prefix'
    writeFileSync(partialPath, originalPartialContent)
    const controller = new AbortController()
    let readCalled = false
    const body = new Readable({
      read() {
        // Only fires once `body.pipe(writeStream)` runs, which is strictly
        // after the abort listener is attached inside
        // `downloadFileResumable` — so aborting here can never race past a
        // missing listener. Push nothing and abort instead of ending the
        // stream, simulating a cancel before any new bytes arrive.
        if (readCalled) return
        readCalled = true
        queueMicrotask(() => controller.abort())
      },
    })
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      body,
    }))

    await expect(
      downloadFileResumable({
        url: 'https://example.test/model.bin',
        destPath,
        partialPath,
        expectedByteSize: originalPartialContent.length + 100,
        expectedSha256: sha256('irrelevant'),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(existsSync(destPath)).toBe(false)
    expect(existsSync(partialPath)).toBe(true)
    expect(readFileSync(partialPath, 'utf8')).toBe(originalPartialContent)
  })

  it('rejects immediately without touching the filesystem when already aborted', async () => {
    const destPath = join(dir, 'model.bin')
    const partialPath = `${destPath}.partial`
    const controller = new AbortController()
    controller.abort()

    await expect(
      downloadFileResumable({
        url: 'https://example.test/model.bin',
        destPath,
        partialPath,
        expectedByteSize: 10,
        expectedSha256: sha256('irrelevant'),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(existsSync(destPath)).toBe(false)
  })
})
