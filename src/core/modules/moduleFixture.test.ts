// eslint-disable-next-line import/no-nodejs-modules -- artifact integrity test runs only in Jest/Node
import { createHash } from 'node:crypto'
// eslint-disable-next-line import/no-nodejs-modules -- artifact boundary test reads generated build files
import { existsSync, readFileSync } from 'node:fs'
// eslint-disable-next-line import/no-nodejs-modules -- artifact boundary test resolves repository fixtures
import * as path from 'node:path'

import { parseModuleArtifactManifest } from './moduleStore'

describe('host API conformance artifact boundary', () => {
  const artifactDir = path.resolve('modules/host-api-conformance/1.0.0')

  it('records the exact entry byte size and SHA-256', () => {
    const manifest = parseModuleArtifactManifest(
      JSON.parse(readFileSync(path.join(artifactDir, 'module.json'), 'utf8')),
    )
    const entry = readFileSync(path.join(artifactDir, manifest.entry.path))
    const source = entry.toString('utf8')
    expect(manifest.id).toBe('host-api-conformance')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.entry.byteSize).toBe(entry.byteLength)
    expect(manifest.entry.sha256).toBe(
      createHash('sha256').update(entry).digest('hex'),
    )
    expect(source).toContain('yolo.module.host-runtime.v1')
    expect(source).not.toContain('react.production.min')
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
        input.replace(/\\/g, '/').includes('modules/host-api-conformance'),
      ),
    ).toEqual([])
  })
})
