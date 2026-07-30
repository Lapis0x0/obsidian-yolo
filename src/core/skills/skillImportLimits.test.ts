import {
  MAX_SKILL_PACKAGE_IMPORT_DEPTH,
  SkillPackageImportDepthExceededError,
  assertSkillPackageImportDepth,
} from './skillImportLimits'

describe('skill package import depth', () => {
  it('allows the configured boundary', () => {
    expect(() =>
      assertSkillPackageImportDepth(MAX_SKILL_PACKAGE_IMPORT_DEPTH),
    ).not.toThrow()
  })

  it('rejects the whole package beyond the configured boundary', () => {
    expect(() =>
      assertSkillPackageImportDepth(MAX_SKILL_PACKAGE_IMPORT_DEPTH + 1),
    ).toThrow(SkillPackageImportDepthExceededError)
  })
})
