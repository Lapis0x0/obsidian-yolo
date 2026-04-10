import { compareVersions } from './updateChecker'

describe('compareVersions', () => {
  it('returns true when latest is newer (patch)', () => {
    expect(compareVersions('1.5.4.7', '1.5.4.8')).toBe(true)
  })

  it('returns true when latest is newer (minor)', () => {
    expect(compareVersions('1.5.4.7', '1.6.0')).toBe(true)
  })

  it('returns false when equal', () => {
    expect(compareVersions('1.5.4.7', '1.5.4.7')).toBe(false)
  })

  it('returns false when latest is older', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(false)
  })

  it('strips v prefix on tags', () => {
    expect(compareVersions('1.0.0', 'v1.0.1')).toBe(true)
  })
})
