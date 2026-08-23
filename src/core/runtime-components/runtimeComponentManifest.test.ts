// eslint-disable-next-line import/no-nodejs-modules -- registry regression test reads the real build artifact, runs only in Jest/Node
import { readFileSync } from 'node:fs'
// eslint-disable-next-line import/no-nodejs-modules -- registry regression test resolves the repository artifact path
import { join } from 'node:path'

import {
  assertCompleteRuntimeComponentRegistry,
  parseRuntimeComponentRegistry,
  resolveRuntimeComponentArtifactSources,
  resolveRuntimeComponentAssetSources,
  runtimeComponentAssetMirrorUrl,
  runtimeComponentAssetReleaseUrl,
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
    expect(() => assertCompleteRuntimeComponentRegistry(registry)).not.toThrow()
  })

  it('reads a historical schema-v1 registry (no assets field anywhere)', () => {
    const registry = parseRuntimeComponentRegistry({
      schemaVersion: 1,
      components: [descriptor],
    })
    expect(registry.schemaVersion).toBe(2)
    expect(registry.components).toHaveLength(1)
    expect(registry.components[0]?.assets).toBeUndefined()
    // A historical tag's registry legitimately lists fewer components than
    // today's IDS set — that's fine for the generic parse; only the current
    // baked registry is required to be complete.
    expect(() => assertCompleteRuntimeComponentRegistry(registry)).toThrow(
      'incomplete',
    )
  })

  it('rejects a schema-v1 registry that declares assets on a component', () => {
    expect(() =>
      parseRuntimeComponentRegistry({
        schemaVersion: 1,
        components: [
          {
            ...descriptor,
            assets: [
              {
                name: 'x.wasm',
                path: 'runtime-components/tokenizer/dist/assets/x.wasm',
                byteSize: 1,
                sha256: 'a'.repeat(64),
              },
            ],
          },
        ],
      }),
    ).toThrow('schema v1')
  })

  it('flags an incomplete v2 registry only via the explicit completeness check', () => {
    // A single, otherwise well-formed component is a valid *registry* on
    // its own — completeness is a stricter, separate requirement that only
    // applies to the registry the host bakes into its own build.
    const registry = parseRuntimeComponentRegistry({
      schemaVersion: 2,
      components: [descriptor],
    })
    expect(registry.components).toHaveLength(1)
    expect(() => assertCompleteRuntimeComponentRegistry(registry)).toThrow(
      'incomplete',
    )
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

  it('falls back to a GitHub Release attachment for an asset, not Git Raw', () => {
    const embeddingEngine = {
      ...descriptor,
      id: 'embedding-engine',
      entry: 'runtime-components/embedding-engine/dist/entry.js',
    }
    const asset = {
      name: 'ort-wasm-simd-threaded.wasm',
      path: 'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
      byteSize: 1024,
      sha256: 'b'.repeat(64),
    }
    // Unlike entry.js, assets are gitignored build outputs — never
    // committed — so the fallback can't be Git Raw (`{ver}/{asset.path}`
    // would 404 on every tag). It must be a GitHub Release attachment,
    // named `{id}-{name}` so two components can't collide on a shared
    // asset filename (e.g. both shipping `ort-wasm-simd-threaded.wasm`).
    expect(
      runtimeComponentAssetReleaseUrl(
        embeddingEngine as never,
        asset,
        '1.6.1.4',
      ),
    ).toBe(
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/1.6.1.4/embedding-engine-ort-wasm-simd-threaded.wasm',
    )
    expect(
      runtimeComponentAssetMirrorUrl(
        embeddingEngine as never,
        asset,
        '1.6.1.4',
      ),
    ).toBe(
      'https://updates.yoloapp.dev/runtime-components/1.6.1.4/embedding-engine/assets/ort-wasm-simd-threaded.wasm',
    )
    expect(
      resolveRuntimeComponentAssetSources(
        embeddingEngine as never,
        asset,
        '1.6.1.4',
      ),
    ).toEqual([
      'https://updates.yoloapp.dev/runtime-components/1.6.1.4/embedding-engine/assets/ort-wasm-simd-threaded.wasm',
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/1.6.1.4/embedding-engine-ort-wasm-simd-threaded.wasm',
    ])
  })
})
