// eslint-disable-next-line import/no-nodejs-modules -- artifact integrity test runs only in Jest/Node
import { createHash } from 'node:crypto'
// eslint-disable-next-line import/no-nodejs-modules -- artifact boundary test reads generated build files
import { existsSync, readFileSync } from 'node:fs'
// eslint-disable-next-line import/no-nodejs-modules -- artifact boundary test resolves repository fixtures
import * as path from 'node:path'

import {
  parseModuleArtifactManifest,
  parseModuleReadyMarker,
} from './moduleStore'

describe('host API conformance artifact boundary', () => {
  const artifactDir = path.resolve('modules/host-api-conformance/1.0.0')

  it('records the exact entry byte size and SHA-256', () => {
    const manifestBytes = readFileSync(path.join(artifactDir, 'module.json'))
    const manifest = parseModuleArtifactManifest(
      JSON.parse(manifestBytes.toString('utf8')),
    )
    const ready = parseModuleReadyMarker(
      JSON.parse(readFileSync(path.join(artifactDir, 'ready.json'), 'utf8')),
    )
    const entry = readFileSync(path.join(artifactDir, manifest.entry.path))
    const source = entry.toString('utf8')
    expect(manifest.id).toBe('host-api-conformance')
    expect(manifest.version).toBe('1.0.0')
    expect(ready).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    })
    expect(manifest.entry.byteSize).toBe(entry.byteLength)
    expect(manifest.entry.sha256).toBe(
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

  it('ships a separately hashed Learning preview that uses only Host API', () => {
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
    const ready = parseModuleReadyMarker(
      JSON.parse(readFileSync(path.join(learningDir, 'ready.json'), 'utf8')),
    )
    const entry = readFileSync(path.join(learningDir, manifest.entry.path))
    const source = entry.toString('utf8')
    expect(manifest.id).toBe('learning')
    expect(manifest.version).toBe('0.1.0')
    expect(bundled.modules[0]?.manifest).toEqual({
      byteSize: manifestBytes.byteLength,
      sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    })
    expect(ready.manifestSha256).toBe(bundled.modules[0]?.manifest.sha256)
    expect(manifest.entry.byteSize).toBe(entry.byteLength)
    expect(manifest.entry.sha256).toBe(
      createHash('sha256').update(entry).digest('hex'),
    )
    expect(source).toContain('yolo.module.host-runtime.v1')
    expect(source).toContain('yolo-learning-module-preview')
    expect(source).toContain('.paths.getSnapshot')
    expect(source).toContain('.vault.listChildren')
    expect(source).toContain('.vault.subscribe')
    expect(source).not.toContain('react.production.min')
    expect(source).not.toContain('LearningViewAdapter')
    expect(source).not.toContain('YoloPlugin')
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
