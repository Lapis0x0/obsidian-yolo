import { normalizeVaultRelativeDir } from './generatedAudioStore'

describe('generated audio store paths', () => {
  it('accepts vault-relative directories', () => {
    expect(normalizeVaultRelativeDir(' Read Aloud/2026 ')).toBe(
      'Read Aloud/2026',
    )
  })

  it('rejects absolute and parent-traversal directories', () => {
    expect(() => normalizeVaultRelativeDir('/tmp/read-aloud')).toThrow(
      /vault-relative/i,
    )
    expect(() => normalizeVaultRelativeDir('C:/tmp/read-aloud')).toThrow(
      /vault-relative/i,
    )
    expect(() => normalizeVaultRelativeDir('../outside')).toThrow(/\.\./)
  })
})
