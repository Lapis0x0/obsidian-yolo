// eslint-disable-next-line import/no-nodejs-modules -- policy integrity tests use Node's Web Crypto implementation
import { createHash, webcrypto } from 'node:crypto'

import type { RequestUrlParam, RequestUrlResponse } from 'obsidian'

import { authorizeOfficialModuleArtifactRemoval } from './officialModuleArtifactRemovalPolicy'
import { parseOfficialModuleCatalog } from './officialModuleCatalog'
import {
  OFFICIAL_MODULE_RELEASE_REPOSITORIES,
  type OfficialModuleCatalogClient,
} from './officialModuleCatalogClient'

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(
    typeof value === 'string' ? value : `${JSON.stringify(value)}\n`,
  )
const hash = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

function fixture(versions: readonly string[] = ['1.0.0']) {
  const assets = new Map<string, Uint8Array>()
  const catalogVersions = versions.map((version) => {
    const root = `https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv${version}`
    const entryBytes = encode(`entry-${version}`)
    const styleBytes = encode(`style-${version}`)
    const file = (
      role: 'entry' | 'style',
      name: string,
      bytes: Uint8Array,
    ) => ({
      role,
      name,
      path: name,
      byteSize: bytes.byteLength,
      sha256: hash(bytes),
      url: `${root}/${name}`,
      storage: 'module',
    })
    const manifestBytes = encode({
      schemaVersion: 1,
      id: 'learning',
      version,
      hostApi: '>=1.0.0 <2.0.0',
      dataSchemas: { learning: { readMin: 0, readMax: 1, write: 1 } },
      variants: [
        {
          platform: 'desktop',
          entry: 'entry.js',
          files: [
            file('entry', 'entry.js', entryBytes),
            file('style', 'style.css', styleBytes),
          ],
        },
      ],
    })
    const manifestSha256 = hash(manifestBytes)
    const manifestUrl = `${root}/module.json`
    assets.set(manifestUrl, manifestBytes)
    assets.set(`${root}/entry.js`, entryBytes)
    assets.set(`${root}/style.css`, styleBytes)
    return {
      version,
      hostApi: '>=1.0.0 <2.0.0',
      platforms: ['desktop'],
      dataSchemas: { learning: { readMin: 0, readMax: 1, write: 1 } },
      manifestUrl,
      manifest: {
        byteSize: manifestBytes.byteLength,
        sha256: manifestSha256,
      },
    }
  })
  const raw = JSON.stringify({
    schemaVersion: 1,
    modules: [{ id: 'learning', versions: catalogVersions }],
  })
  const catalog = parseOfficialModuleCatalog(raw, {
    allowedRepositories: OFFICIAL_MODULE_RELEASE_REPOSITORIES,
  })
  const loader = {
    loadFresh: async () => catalog,
  } as Pick<OfficialModuleCatalogClient, 'loadFresh'>
  const requestUrl = jest.fn(async ({ url }: RequestUrlParam) => {
    const bytes = assets.get(url)
    return response(bytes ?? new Uint8Array(), bytes ? 200 : 404)
  })
  return { assets, catalog, loader, requestUrl }
}

function response(bytes: Uint8Array, status: number): RequestUrlResponse {
  return {
    status,
    headers: {},
    arrayBuffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
    text: '',
    json: null,
  }
}

function authorize(
  value: ReturnType<typeof fixture>,
  versions: readonly string[],
): Promise<boolean> {
  return authorizeOfficialModuleArtifactRemoval(
    value.loader,
    'learning',
    versions,
    'desktop',
    {
      requestUrl: value.requestUrl,
      subtleCrypto: webcrypto.subtle as unknown as SubtleCrypto,
      timeoutMs: 1_000,
    },
  )
}

describe('authorizeOfficialModuleArtifactRemoval', () => {
  it('rejects when a cataloged asset was deleted after publication', async () => {
    const value = fixture()
    value.assets.delete(
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv1.0.0/style.css',
    )

    await expect(authorize(value, ['1.0.0'])).resolves.toBe(false)
  })

  it('rejects a corrupt manifest', async () => {
    const value = fixture()
    const manifestUrl = value.catalog.modules[0]?.versions[0]?.manifestUrl ?? ''
    const corrupt = value.assets.get(manifestUrl)!.slice()
    corrupt[0] ^= 0xff
    value.assets.set(manifestUrl, corrupt)

    await expect(authorize(value, ['1.0.0'])).resolves.toBe(false)
  })

  it('rejects all removal when one requested old version fails', async () => {
    const value = fixture(['1.0.0', '2.0.0'])
    value.assets.delete(
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv1.0.0/entry.js',
    )

    await expect(authorize(value, ['2.0.0', '1.0.0'])).resolves.toBe(false)
  })

  it('authorizes when every exact version and release asset verifies', async () => {
    const value = fixture(['1.0.0', '2.0.0'])
    let requestsInFlight = 0
    let maximumRequestsInFlight = 0
    value.requestUrl.mockImplementation(async ({ url }: RequestUrlParam) => {
      requestsInFlight += 1
      maximumRequestsInFlight = Math.max(
        maximumRequestsInFlight,
        requestsInFlight,
      )
      await Promise.resolve()
      const bytes = value.assets.get(url)
      requestsInFlight -= 1
      return response(bytes ?? new Uint8Array(), bytes ? 200 : 404)
    })

    await expect(authorize(value, ['1.0.0', '2.0.0'])).resolves.toBe(true)
    expect(value.requestUrl).toHaveBeenCalledTimes(6)
    expect(maximumRequestsInFlight).toBe(1)
  })

  it('rejects a manifest file outside its release parent', async () => {
    const value = fixture()
    const descriptor = value.catalog.modules[0]?.versions[0]
    const manifestBytes = value.assets.get(descriptor?.manifestUrl ?? '')
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
      variants: Array<{ files: Array<{ url: string }> }>
    }
    manifest.variants[0].files[0].url =
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv2.0.0/entry.js'
    const corruptTrustManifest = encode(manifest)
    value.assets.set(descriptor.manifestUrl, corruptTrustManifest)
    const trustDescriptor = {
      ...descriptor,
      manifest: {
        byteSize: corruptTrustManifest.byteLength,
        sha256: hash(corruptTrustManifest),
      },
    }
    value.loader.loadFresh = async () => ({
      schemaVersion: 1,
      modules: [
        {
          ...value.catalog.modules[0],
          versions: [trustDescriptor],
        },
      ],
    })

    await expect(authorize(value, ['1.0.0'])).resolves.toBe(false)
  })

  it('rejects invalid requests before loading the catalog', async () => {
    const value = fixture()
    const loadFresh = jest.spyOn(value.loader, 'loadFresh')

    await expect(authorize(value, [])).resolves.toBe(false)
    await expect(authorize(value, ['1.0.0', '1.0.0'])).resolves.toBe(false)
    expect(loadFresh).not.toHaveBeenCalled()
  })
})
