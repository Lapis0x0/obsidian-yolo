// eslint-disable-next-line import/no-nodejs-modules -- registry regression test reads the real build artifact, runs only in Jest/Node
import { readFileSync } from 'node:fs'
// eslint-disable-next-line import/no-nodejs-modules -- registry regression test resolves the repository artifact path
import { join } from 'node:path'

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
  it('accepts the real baked registry.json (plugin load depends on this)', () => {
    const raw: unknown = JSON.parse(
      readFileSync(
        join(__dirname, '../../../runtime-components/registry.json'),
        'utf8',
      ),
    )
    const registry = parseRuntimeComponentRegistry(raw)
    expect(registry.components.length).toBeGreaterThan(0)
  })

  it('rejects paths that are not the one fixed entry for the component', () => {
    expect(() =>
      parseRuntimeComponentRegistry({
        schemaVersion: 2,
        components: [
          { ...descriptor, entry: '../entry.js' },
          { ...descriptor, id: 'pdf-engine' },
          { ...descriptor, id: 'bash-engine' },
          { ...descriptor, id: 'embedding-engine' },
        ],
      }),
    ).toThrow('invalid')
  })

  it('accepts an optional assets list and rejects malformed entries', () => {
    const forId = (id: string) => ({
      ...descriptor,
      id,
      entry: `runtime-components/${id}/dist/entry.js`,
    })
    const withAssets = {
      ...forId('embedding-engine'),
      assets: [
        {
          name: 'ort-wasm-simd-threaded.wasm',
          path: 'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
          byteSize: 1024,
          sha256: 'b'.repeat(64),
        },
      ],
    }
    expect(() =>
      parseRuntimeComponentRegistry({
        schemaVersion: 2,
        components: [
          withAssets,
          forId('pdf-engine'),
          forId('bash-engine'),
          forId('tokenizer'),
        ],
      }),
    ).not.toThrow()

    expect(() =>
      parseRuntimeComponentRegistry({
        schemaVersion: 2,
        components: [
          {
            ...withAssets,
            assets: [{ ...withAssets.assets[0], path: 'wrong/path' }],
          },
          forId('pdf-engine'),
          forId('bash-engine'),
          forId('tokenizer'),
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
