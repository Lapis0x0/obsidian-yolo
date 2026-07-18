import type { VerifiedModuleArtifact } from './moduleArtifactVerifier'
import type { ModuleArtifactManifest } from './moduleStore'
import { VerifiedModuleArtifactRegistry } from './verifiedModuleArtifactRegistry'

function artifact(version: string): VerifiedModuleArtifact {
  const variant = Object.freeze({
    platform: 'desktop' as const,
    entry: 'entry.js',
    files: Object.freeze([]),
  })
  const manifest: ModuleArtifactManifest = Object.freeze({
    schemaVersion: 1,
    id: 'learning',
    version,
    hostApi: '^1.0.0',
    dataSchemas: Object.freeze({}),
    variants: Object.freeze([variant]),
  })
  return Object.freeze({
    manifest,
    variant,
    entryBytes: new Uint8Array(),
  })
}

describe('VerifiedModuleArtifactRegistry', () => {
  it('publishes the exact artifact and replaces it with a new active version', () => {
    const registry = new VerifiedModuleArtifactRegistry()
    const first = artifact('1.0.0')
    const second = artifact('2.0.0')

    registry.publish('learning', '1.0.0', first)
    expect(registry.getVerifiedArtifact('learning')).toBe(first)

    registry.publish('learning', '2.0.0', second)
    expect(registry.getVerifiedArtifact('learning')).toBe(second)
  })

  it('rejects identity, version, and non-manifest variant mismatches', () => {
    const registry = new VerifiedModuleArtifactRegistry()
    const exact = artifact('1.0.0')

    expect(() => registry.publish('other', '1.0.0', exact)).toThrow(
      'does not match active version',
    )
    expect(() => registry.publish('learning', '2.0.0', exact)).toThrow(
      'does not match active version',
    )
    expect(() =>
      registry.publish('learning', '1.0.0', {
        ...exact,
        variant: { ...exact.variant },
      }),
    ).toThrow('does not match active version')
    expect(registry.getVerifiedArtifact('learning')).toBeUndefined()
  })

  it('clears one module or the complete lifecycle', () => {
    const registry = new VerifiedModuleArtifactRegistry()
    const exact = artifact('1.0.0')
    registry.publish('learning', '1.0.0', exact)

    registry.clear('learning')
    expect(registry.getVerifiedArtifact('learning')).toBeUndefined()

    registry.publish('learning', '1.0.0', exact)
    registry.clearAll()
    expect(registry.getVerifiedArtifact('learning')).toBeUndefined()
  })
})
