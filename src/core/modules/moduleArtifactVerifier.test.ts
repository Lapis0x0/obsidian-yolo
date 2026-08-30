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
    readManifestBytes: async () => manifestBytes,
    readEntryBytes: async (_id: string, _version: string, path: string) => {
      if (path === 'mobile.js') return mobileEntry
      if (path === 'desktop.js') return desktopEntry
      throw new Error('unexpected path')
    },
    listVersionFiles: async () => ['desktop.js', 'mobile.js', 'module.json'],
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

  it('loads a self-consistent artifact whose bytes no longer match the descriptor digest', async () => {
    // The dev install channel rebuilds a version's bytes in place, so an
    // installed manifest legitimately stops matching the SHA-256 the
    // descriptor remembers from install time. At rest only self-consistency
    // is required: every file still has to match the manifest next to it.
    const rebuilt = fixture()
    rebuilt.descriptor.manifest.sha256 = 'a'.repeat(64)
    rebuilt.descriptor.manifest.byteSize = 1

    const artifact = await verifyInstalledModuleArtifact(
      rebuilt.store,
      rebuilt.descriptor,
      webcrypto.subtle as unknown as SubtleCrypto,
    )
    expect(new TextDecoder().decode(artifact.entryBytes)).toBe('mobile')

    const tampered = fixture()
    tampered.store.readEntryBytes = async () => encode('tampered')
    await expect(
      verifyInstalledModuleArtifact(
        tampered.store,
        tampered.descriptor,
        webcrypto.subtle as unknown as SubtleCrypto,
      ),
    ).rejects.toThrow('SHA-256 mismatch')
  })

  it('rejects descriptor metadata and file closure drift', async () => {
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
    device.store.readManifestBytes = async () => manifestBytes

    await expect(
      verifyInstalledModuleArtifact(
        device.store,
        device.descriptor,
        webcrypto.subtle as unknown as SubtleCrypto,
      ),
    ).rejects.toThrow('Device-stored module artifact')
  })
})
