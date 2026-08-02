export const MAX_SKILL_PACKAGE_IMPORT_DEPTH = 16

export class SkillPackageImportDepthExceededError extends Error {
  readonly maxDepth: number

  constructor(maxDepth: number = MAX_SKILL_PACKAGE_IMPORT_DEPTH) {
    super(`Skill package exceeds the maximum import depth of ${maxDepth}.`)
    this.name = 'SkillPackageImportDepthExceededError'
    this.maxDepth = maxDepth
  }
}

/** Reject the complete package before silently dropping deep resources. */
export const assertSkillPackageImportDepth = (
  depth: number,
  maxDepth: number = MAX_SKILL_PACKAGE_IMPORT_DEPTH,
): void => {
  if (depth > maxDepth) {
    throw new SkillPackageImportDepthExceededError(maxDepth)
  }
}
