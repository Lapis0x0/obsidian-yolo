// eslint-disable-next-line import/no-nodejs-modules -- verifier integrity tests use Node's Web Crypto implementation
import { createHash, webcrypto } from 'node:crypto'

import { verifyInstalledModuleArtifact } from './moduleArtifactVerifier'

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(
    typeof value === 'string' ? value : JSON.stringify(value),
  )
const hash = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

function fixture() {
  const desktopEntry = encode('desktop')
  const mobileEntry = encode('mobile')
  const file = (platform: 'desktop' | 'mobile', bytes: Uint8Array) => ({
    role: 'entry',
    name: `${platform}.js`,
    path: `${platform}.js`,
    byteSize: bytes.byteLength,
    sha256: hash(bytes),
    url: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v1.0.0/${platform}.js`,
    storage: 'module',
  })
  const manifestBytes = encode({
    schemaVersion: 1,
    id: 'learning',
    version: '1.0.0',
    hostApi: '^1.0.0',
    dataSchemas: { learning: { readMin: 0, readMax: 2, write: 2 } },
    variants: [
      {
        platform: 'desktop',
        entry: 'desktop.js',
        files: [file('desktop', desktopEntry)],
      },
      {
        platform: 'mobile',
        entry: 'mobile.js',
        files: [file('mobile', mobileEntry)],
      },
    ],
  })
  const descriptor = {
    id: 'learning',
    version: '1.0.0',
    hostApi: '^1.0.0',
    dataSchemas: { learning: { readMin: 0, readMax: 2, write: 2 } },
    platform: 'mobile' as const,
    manifestUrl:
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v1.0.0/module.json',
    manifest: {
      byteSize: manifestBytes.byteLength,
      sha256: hash(manifestBytes),
    },
  }
  const store = {
    readReadyMarkerBytes: async (
      _id: string,
      _version: string,
      platform: 'desktop' | 'mobile',
    ) =>
      encode({
        schemaVersion: 1,
        id: 'learning',
        version: '1.0.0',
        platform,
        manifestSha256: descriptor.manifest.sha256,
      }),
    readManifestBytes: async () => manifestBytes,
    readEntryBytes: async (_id: string, _version: string, path: string) => {
      if (path === 'mobile.js') return mobileEntry
      if (path === 'desktop.js') return desktopEntry
      throw new Error('unexpected path')
    },
    listVersionFiles: async () => [
      'desktop.js',
      'mobile.js',
      'module.json',
      `ready.desktop.${descriptor.manifest.sha256}.json`,
      `ready.mobile.${descriptor.manifest.sha256}.json`,
    ],
  }
  return { descriptor, store }
}

describe('verifyInstalledModuleArtifact', () => {
  it('verifies the cross-platform union and returns the selected entry', async () => {
    const { descriptor, store } = fixture()
    const readEntryBytes = jest.spyOn(store, 'readEntryBytes')

    const artifact = await verifyInstalledModuleArtifact(
      store,
      descriptor,
      webcrypto.subtle as unknown as SubtleCrypto,
    )

    expect(artifact.variant.platform).toBe('mobile')
    expect(new TextDecoder().decode(artifact.entryBytes)).toBe('mobile')
    expect(readEntryBytes).toHaveBeenCalledTimes(2)
    expect(readEntryBytes).toHaveBeenCalledWith(
      'learning',
      '1.0.0',
      'mobile.js',
    )
  })

  it('rejects marker platform, descriptor metadata, and file closure drift', async () => {
    const markerMismatch = fixture()
    markerMismatch.store.readReadyMarkerBytes = async () =>
      encode({
        schemaVersion: 1,
        id: 'learning',
        version: '1.0.0',
        platform: 'desktop',
        manifestSha256: markerMismatch.descriptor.manifest.sha256,
      })
    await expect(
      verifyInstalledModuleArtifact(
        markerMismatch.store,
        markerMismatch.descriptor,
        webcrypto.subtle as unknown as SubtleCrypto,
      ),
    ).rejects.toThrow('ready marker mismatch')

    const descriptorMismatch = fixture()
    await expect(
      verifyInstalledModuleArtifact(
        descriptorMismatch.store,
        { ...descriptorMismatch.descriptor, hostApi: '^2.0.0' },
        webcrypto.subtle as unknown as SubtleCrypto,
      ),
    ).rejects.toThrow('descriptor mismatch')

    const closureMismatch = fixture()
    closureMismatch.store.listVersionFiles = async () => [
      'desktop.js',
      'extra.js',
      'mobile.js',
      'module.json',
      `ready.desktop.${closureMismatch.descriptor.manifest.sha256}.json`,
      `ready.mobile.${closureMismatch.descriptor.manifest.sha256}.json`,
    ]
    await expect(
      verifyInstalledModuleArtifact(
        closureMismatch.store,
        closureMismatch.descriptor,
        webcrypto.subtle as unknown as SubtleCrypto,
      ),
    ).rejects.toThrow('file closure mismatch')
  })

  it('fails closed for an installed selected device artifact', async () => {
    const device = fixture()
    const manifest = JSON.parse(
      new TextDecoder().decode(await device.store.readManifestBytes()),
    ) as { variants: Array<{ files: Array<{ storage: string }> }> }
    manifest.variants[1].files[0].storage = 'device'
    const manifestBytes = encode(manifest)
    device.descriptor.manifest.byteSize = manifestBytes.byteLength
    device.descriptor.manifest.sha256 = hash(manifestBytes)
    device.store.readManifestBytes = async () => manifestBytes
    device.store.readReadyMarkerBytes = async (
      _id: string,
      _version: string,
      platform: 'desktop' | 'mobile',
    ) =>
      encode({
        schemaVersion: 1,
        id: 'learning',
        version: '1.0.0',
        platform,
        manifestSha256: device.descriptor.manifest.sha256,
      })

    await expect(
      verifyInstalledModuleArtifact(
        device.store,
        device.descriptor,
        webcrypto.subtle as unknown as SubtleCrypto,
      ),
    ).rejects.toThrow('Device-stored module artifact')
  })
})
