import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import {
  isOfficialModuleArtifactSourceUrl,
  resolveOfficialModuleArtifactSources,
} from './officialModuleArtifactSources'

const descriptor: ModuleArtifactDescriptor = {
  id: 'learning',
  version: '0.1.1',
  hostApi: '^1.4.0',
  dataSchemas: { settings: { readMin: 0, readMax: 1, write: 1 } },
  platform: 'desktop',
  manifestUrl:
    'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv0.1.1/module.json',
  manifest: { byteSize: 1, sha256: 'a'.repeat(64) },
}

describe('official module artifact sources', () => {
  it('prefers Cloudflare Pages and preserves GitHub Release as fallback', () => {
    expect(
      resolveOfficialModuleArtifactSources({
        descriptor,
        canonicalUrl: descriptor.manifestUrl,
        path: 'module.json',
      }),
    ).toEqual([
      'https://updates.yoloapp.dev/modules/learning/0.1.1/module.json',
      descriptor.manifestUrl,
    ])
  })

  it('keeps non-stable preview tags on their canonical source', () => {
    const canonicalUrl =
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/module-learning-v0.1.1/entry.js'
    expect(
      resolveOfficialModuleArtifactSources({
        descriptor: { ...descriptor, manifestUrl: canonicalUrl },
        canonicalUrl,
        path: 'entry.js',
      }),
    ).toEqual([canonicalUrl])
  })

  it.each([
    'https://updates.yoloapp.dev/modules/learning/0.1.1/entry.js',
    descriptor.manifestUrl,
  ])('accepts an owned artifact source %s', (url) => {
    expect(isOfficialModuleArtifactSourceUrl(url)).toBe(true)
  })

  it.each([
    'http://updates.yoloapp.dev/modules/learning/0.1.1/entry.js',
    'https://other.example/modules/learning/0.1.1/entry.js',
    'https://updates.yoloapp.dev/modules/learning/0.1.1/../entry.js',
  ])('rejects an unowned artifact source %s', (url) => {
    expect(isOfficialModuleArtifactSourceUrl(url)).toBe(false)
  })
})
