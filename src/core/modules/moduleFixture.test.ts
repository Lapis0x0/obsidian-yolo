// eslint-disable-next-line import/no-nodejs-modules -- artifact integrity test runs only in Jest/Node
import { createHash } from 'node:crypto'
// eslint-disable-next-line import/no-nodejs-modules -- artifact boundary test reads generated build files
import { existsSync, readFileSync, readdirSync } from 'node:fs'
// eslint-disable-next-line import/no-nodejs-modules -- artifact boundary test resolves repository fixtures
import * as path from 'node:path'

import {
  parseModuleArtifactManifest,
  selectModuleManifestVariant,
} from './moduleStore'
import {
  parseOfficialModuleCatalog,
  selectInitialCompatibleVersion,
} from './officialModuleCatalog'

describe('host API conformance artifact boundary', () => {
  const artifactDir = path.resolve('modules/host-api-conformance/1.0.0')

  it('records the exact entry byte size and SHA-256', () => {
    const manifestBytes = readFileSync(path.join(artifactDir, 'module.json'))
    const manifest = parseModuleArtifactManifest(
      JSON.parse(manifestBytes.toString('utf8')),
    )
    const variant = selectModuleManifestVariant(manifest, 'desktop')
    const mobileVariant = selectModuleManifestVariant(manifest, 'mobile')
    const entryFile = variant.files.find((file) => file.role === 'entry')!
    const entry = readFileSync(path.join(artifactDir, entryFile.path))
    const source = entry.toString('utf8')
    expect(manifest.id).toBe('host-api-conformance')
    expect(manifest.version).toBe('1.0.0')
    expect(mobileVariant.files).toEqual(variant.files)
    expect(entryFile.byteSize).toBe(entry.byteLength)
    expect(entryFile.sha256).toBe(
      createHash('sha256').update(entry).digest('hex'),
    )
    expect(source).toContain('yolo.module.host-runtime.v1')
    expect(source).toContain('conformance-status')
    expect(source).toContain('.background.upsert')
    expect(source).toContain('.workspace.openView')
    expect(source).toContain('.vault.listMarkdownFiles')
    expect(source).toContain('.vault.subscribe')
    expect(source).not.toContain('react.production.min')
  })

  it('ships a separately hashed Learning module that uses only Host API', () => {
    const bundled = JSON.parse(
      readFileSync('modules/bundled.json', 'utf8'),
    ) as {
      schemaVersion: number
      modules: Array<{
        id: string
        version: string
        manifest: { byteSize: number; sha256: string }
      }>
    }
    expect(bundled).toEqual({
      schemaVersion: 1,
      modules: [expect.objectContaining({ id: 'learning', version: '0.1.0' })],
    })

    const learningDir = path.resolve('modules/learning/0.1.0')
    const manifestBytes = readFileSync(path.join(learningDir, 'module.json'))
    const manifest = parseModuleArtifactManifest(
      JSON.parse(manifestBytes.toString('utf8')),
    )
    const variant = selectModuleManifestVariant(manifest, 'desktop')
    const entryFile = variant.files.find((file) => file.role === 'entry')!
    const entry = readFileSync(path.join(learningDir, entryFile.path))
    const style = variant.files.find((file) => file.role === 'style')
    const source = entry.toString('utf8')
    expect(manifest.id).toBe('learning')
    expect(manifest.version).toBe('0.1.0')
    expect(bundled.modules[0]?.manifest).toEqual({
      byteSize: manifestBytes.byteLength,
      sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    })
    expect(entryFile.byteSize).toBe(entry.byteLength)
    expect(entryFile.sha256).toBe(
      createHash('sha256').update(entry).digest('hex'),
    )
    expect(variant.files.map(({ role, path }) => ({ role, path }))).toEqual([
      { role: 'entry', path: 'entry.js' },
      { role: 'style', path: 'style.css' },
    ])
    expect(readdirSync(learningDir).sort()).toEqual([
      'entry.js',
      'module.json',
      'style.css',
    ])
    expect(style).toBeDefined()
    expect(manifest.hostApi).toBe('^1.3.0')
    expect(manifest.dataSchemas).toEqual({
      settings: { readMin: 0, readMax: 1, write: 1 },
    })
    expect(manifest.variants.map(({ platform }) => platform)).toEqual([
      'desktop',
      'mobile',
    ])
    expect(variant.files.every((file) => file.storage === 'module')).toBe(true)
    expect(
      variant.files.every((file) =>
        file.url.startsWith(
          'https://github.com/Lapis0x0/obsidian-yolo/releases/download/',
        ),
      ),
    ).toBe(true)
    const styleBytes = readFileSync(path.join(learningDir, style!.path))
    expect(style!.byteSize).toBe(styleBytes.byteLength)
    expect(style!.sha256).toBe(
      createHash('sha256').update(styleBytes).digest('hex'),
    )
    expect(styleBytes.toString('utf8')).toContain('.yolo-learning')
    expect(source).toContain('yolo.module.host-runtime.v1')
    expect(source).toContain('yolo-learning')
    expect(source).toContain('.paths.getSnapshot')
    expect(source).toContain('.vault.listChildren')
    expect(source).toContain('.workspace.registerCommand')
    expect(source).not.toContain('react.production.min')
    expect(source).not.toContain('LearningViewAdapter')
    expect(source).not.toContain('YoloPlugin')
  })

  it('preserves real Learning build schema declarations through the catalog parser', () => {
    const manifestBytes = readFileSync('modules/learning/0.1.0/module.json')
    const manifest = parseModuleArtifactManifest(
      JSON.parse(manifestBytes.toString('utf8')),
    )
    const catalog = parseOfficialModuleCatalog(
      JSON.stringify({
        schemaVersion: 1,
        modules: [
          {
            id: manifest.id,
            versions: [
              {
                version: manifest.version,
                hostApi: manifest.hostApi,
                platforms: manifest.variants.map(({ platform }) => platform),
                dataSchemas: manifest.dataSchemas,
                manifestUrl:
                  'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv0.1.0/module.json',
                manifest: {
                  byteSize: manifestBytes.byteLength,
                  sha256: createHash('sha256')
                    .update(manifestBytes)
                    .digest('hex'),
                },
              },
            ],
          },
        ],
      }),
      {
        allowedRepositories: [{ owner: 'Lapis0x0', repo: 'obsidian-yolo' }],
      },
    )

    expect(catalog.modules[0]?.versions[0]?.hostApi).toBe(manifest.hostApi)
    expect(catalog.modules[0]?.versions[0]?.dataSchemas).toEqual(
      manifest.dataSchemas,
    )
    expect(
      selectInitialCompatibleVersion(catalog.modules[0], {
        hostApi: '1.3.0',
        platform: 'desktop',
      })?.version,
    ).toBe('0.1.0')
  })

  it('keeps fixture source and artifacts out of production main metadata', () => {
    expect(readFileSync('esbuild.config.mjs', 'utf8')).not.toContain(
      'host-api-conformance',
    )
    if (!existsSync('meta.json')) return
    const metafile = JSON.parse(readFileSync('meta.json', 'utf8')) as {
      inputs: Record<string, unknown>
    }
    expect(
      Object.keys(metafile.inputs).filter((input) =>
        input.replace(/\\/g, '/').startsWith('modules/'),
      ),
    ).toEqual([])
  })
})
