import {
  parseRuntimeComponentRegistry,
  resolveRuntimeComponentArtifactSources,
  runtimeComponentReleaseUrl,
} from './runtimeComponentManifest'

const descriptor = {
  id: 'tokenizer',
  platforms: ['desktop', 'mobile'],
  nameKey: 'name',
  descriptionKey: 'description',
  impactKey: 'impact',
  entry: 'runtime-components/tokenizer/dist/entry.js',
  byteSize: 10,
  sha256: 'a'.repeat(64),
}

describe('runtime component manifest', () => {
  it('rejects paths that are not the one fixed entry for the component', () => {
    expect(() =>
      parseRuntimeComponentRegistry({
        schemaVersion: 1,
        components: [
          { ...descriptor, entry: '../entry.js' },
          { ...descriptor, id: 'pdf-engine' },
          { ...descriptor, id: 'pglite-engine' },
        ],
      }),
    ).toThrow('invalid')
  })

  it('builds only immutable numeric-tag URLs', () => {
    expect(runtimeComponentReleaseUrl(descriptor as never, '1.6.1.4')).toBe(
      'https://raw.githubusercontent.com/Lapis0x0/obsidian-yolo/1.6.1.4/runtime-components/tokenizer/dist/entry.js',
    )
    expect(() =>
      runtimeComponentReleaseUrl(descriptor as never, 'main'),
    ).toThrow('numeric Git tag')
    expect(() =>
      runtimeComponentReleaseUrl(descriptor as never, 'latest'),
    ).toThrow('numeric Git tag')
  })

  it('prefers the latest-only Cloudflare mirror and preserves Git Raw fallback', () => {
    expect(
      resolveRuntimeComponentArtifactSources(descriptor as never, '1.6.1.4'),
    ).toEqual([
      'https://updates.yoloapp.dev/runtime-components/1.6.1.4/tokenizer/entry.js',
      'https://raw.githubusercontent.com/Lapis0x0/obsidian-yolo/1.6.1.4/runtime-components/tokenizer/dist/entry.js',
    ])
  })
})
