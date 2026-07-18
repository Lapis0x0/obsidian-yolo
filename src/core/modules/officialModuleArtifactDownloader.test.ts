import type { RequestUrlParam, RequestUrlResponse } from 'obsidian'

import type { ModuleArtifactInstallerOptions } from './moduleArtifactInstaller'
import {
  MAX_MODULE_ARTIFACT_FILE_BYTES,
  MAX_MODULE_MANIFEST_BYTES,
} from './moduleStore'
import {
  type OfficialModuleArtifactRequest,
  createOfficialModuleArtifactDownloader,
} from './officialModuleArtifactDownloader'

const RELEASE_ROOT =
  'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v1.0.0'
const ARTIFACT_URL = `${RELEASE_ROOT}/entry.js`
const MANIFEST_URL = `${RELEASE_ROOT}/module.json`

function response(
  bytes: Uint8Array,
  status = 200,
  headers: Record<string, string> = {},
): RequestUrlResponse {
  return {
    status,
    headers,
    arrayBuffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
    text: '',
    json: null,
  }
}

function setup(
  result: RequestUrlResponse = response(new Uint8Array([1, 2, 3])),
) {
  const request = jest.fn(async (_options: RequestUrlParam) => result)
  const download: ModuleArtifactInstallerOptions['download'] =
    createOfficialModuleArtifactDownloader({ requestUrl: request })
  return { download, request }
}

describe('createOfficialModuleArtifactDownloader', () => {
  it('downloads a release artifact with GET and throw disabled', async () => {
    const { download, request } = setup()

    await expect(
      download({ kind: 'artifact', url: ARTIFACT_URL, byteSize: 3 }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]))
    expect(request).toHaveBeenCalledWith({
      url: ARTIFACT_URL,
      method: 'GET',
      throw: false,
    })
  })

  it('returns bytes copied from the response buffer', async () => {
    const result = response(new Uint8Array([4, 5, 6]))
    const { download } = setup(result)

    const downloaded = await download({
      kind: 'artifact',
      url: ARTIFACT_URL,
      byteSize: 3,
    })
    new Uint8Array(result.arrayBuffer)[0] = 99

    expect(downloaded).toEqual(new Uint8Array([4, 5, 6]))
    expect(downloaded.buffer).not.toBe(result.arrayBuffer)
  })

  it.each([199, 300, 404, Number.NaN, 200.5])(
    'rejects invalid or unsuccessful status %s',
    async (status) => {
      const { download } = setup(response(new Uint8Array([1]), status))
      await expect(
        download({ kind: 'artifact', url: ARTIFACT_URL, byteSize: 1 }),
      ).rejects.toThrow('not successful')
    },
  )

  it('rejects a Content-Length larger than expected', async () => {
    const { download } = setup(
      response(new Uint8Array([1, 2, 3]), 200, { 'content-length': '4' }),
    )
    await expect(
      download({ kind: 'artifact', url: ARTIFACT_URL, byteSize: 3 }),
    ).rejects.toThrow('exceeds')
  })

  it('rejects a final body size different from expected', async () => {
    const { download } = setup(response(new Uint8Array([1, 2])))
    await expect(
      download({ kind: 'artifact', url: ARTIFACT_URL, byteSize: 3 }),
    ).rejects.toThrow('size mismatch')
  })

  it.each(['-1', '1.5', ' 3', '03', '9007199254740992'])(
    'rejects malformed Content-Length %s',
    async (contentLength) => {
      const { download } = setup(
        response(new Uint8Array([1, 2, 3]), 200, {
          'Content-Length': contentLength,
        }),
      )
      await expect(
        download({ kind: 'artifact', url: ARTIFACT_URL, byteSize: 3 }),
      ).rejects.toThrow('Content-Length')
    },
  )

  it('reads Content-Length case-insensitively', async () => {
    const { download } = setup(
      response(new Uint8Array([1, 2, 3]), 200, { 'CoNtEnT-LeNgTh': '3' }),
    )
    await expect(
      download({ kind: 'artifact', url: ARTIFACT_URL, byteSize: 3 }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it.each([
    null,
    {},
    {
      kind: 'artifact',
      url: 'http://github.com/a/b/releases/download/v1/file.js',
      byteSize: 1,
    },
    {
      kind: 'artifact',
      url: 'https://example.com/a/releases/download/v1/file.js',
      byteSize: 1,
    },
    {
      kind: 'artifact',
      url: 'https://github.com/other/project/releases/download/v1/file.js',
      byteSize: 1,
    },
    { kind: 'artifact', url: `${ARTIFACT_URL}?token=x`, byteSize: 1 },
    { kind: 'unknown', url: ARTIFACT_URL, byteSize: 1 },
    { kind: 'artifact', url: ARTIFACT_URL, byteSize: 0 },
    { kind: 'artifact', url: ARTIFACT_URL, byteSize: 1.5 },
    {
      kind: 'artifact',
      url: ARTIFACT_URL,
      byteSize: Number.MAX_SAFE_INTEGER + 1,
    },
    { kind: 'artifact', url: ARTIFACT_URL, byteSize: 1, extra: true },
    Object.defineProperty(
      { kind: 'artifact', url: ARTIFACT_URL, byteSize: 1 },
      'extra',
      { value: true },
    ),
  ])('rejects malformed download request %#', async (value) => {
    const { download, request } = setup()
    await expect(
      download(value as Parameters<typeof download>[0]),
    ).rejects.toThrow('download request is invalid')
    expect(request).not.toHaveBeenCalled()
  })

  it('enforces manifest and artifact byte limits', async () => {
    const { download, request } = setup()

    await expect(
      download({
        url: MANIFEST_URL,
        kind: 'manifest',
        byteSize: MAX_MODULE_MANIFEST_BYTES + 1,
      }),
    ).rejects.toThrow('download request is invalid')
    await expect(
      download({
        url: ARTIFACT_URL,
        kind: 'artifact',
        byteSize: MAX_MODULE_ARTIFACT_FILE_BYTES + 1,
      }),
    ).rejects.toThrow('download request is invalid')
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects duplicate Content-Length headers with different casing', async () => {
    const { download } = setup(
      response(new Uint8Array([1]), 200, {
        'Content-Length': '1',
        'content-length': '1',
      }),
    )
    await expect(
      download({ kind: 'artifact', url: ARTIFACT_URL, byteSize: 1 }),
    ).rejects.toThrow('Content-Length')
  })

  it('uses explicit request kind instead of guessing from the file name', async () => {
    const { download, request } = setup()

    await expect(
      download({
        kind: 'manifest',
        url: `${RELEASE_ROOT}/learning.json`,
        byteSize: MAX_MODULE_MANIFEST_BYTES + 1,
      }),
    ).rejects.toThrow('download request is invalid')
    await expect(
      download({
        kind: 'artifact',
        url: MANIFEST_URL,
        byteSize: MAX_MODULE_MANIFEST_BYTES + 1,
      }),
    ).rejects.toThrow('size mismatch')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects requests that exceed the configured timeout', async () => {
    const download = createOfficialModuleArtifactDownloader({
      requestUrl: async () => await new Promise<RequestUrlResponse>(() => {}),
      timeoutMs: 1,
    })

    await expect(
      download({ kind: 'artifact', url: ARTIFACT_URL, byteSize: 1 }),
    ).rejects.toThrow('timed out')
  })

  it('does not stack retries while a timed-out transport is still running', async () => {
    let resolveRequest!: (value: RequestUrlResponse) => void
    const pending = new Promise<RequestUrlResponse>((resolve) => {
      resolveRequest = resolve
    })
    const request = jest.fn(() => pending)
    const download = createOfficialModuleArtifactDownloader({
      requestUrl: request,
      timeoutMs: 1,
    })
    const input = { kind: 'artifact' as const, url: ARTIFACT_URL, byteSize: 1 }

    await expect(download(input)).rejects.toThrow('timed out')
    await expect(download(input)).rejects.toThrow('still in progress')
    expect(request).toHaveBeenCalledTimes(1)

    resolveRequest(response(new Uint8Array([1])))
    await pending
    await Promise.resolve()
    await expect(download(input)).resolves.toEqual(new Uint8Array([1]))
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('rejects a non-function injected request', () => {
    expect(() =>
      createOfficialModuleArtifactDownloader({
        requestUrl: null as unknown as OfficialModuleArtifactRequest,
      }),
    ).toThrow('must be a function')
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects invalid timeout %s',
    (timeoutMs) => {
      expect(() =>
        createOfficialModuleArtifactDownloader({ timeoutMs }),
      ).toThrow('timeout is invalid')
    },
  )
})
