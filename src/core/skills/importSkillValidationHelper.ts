import type { ValidationError } from './skillValidation'

type TranslateFn = (key: string, fallback: string) => string

export function formatValidationErrors(
  errors: ValidationError[],
  sourceName: string,
  t: TranslateFn,
): string {
  const reasons = errors.map((err) => {
    const key = `${err.field}:${err.message}`
    switch (key) {
      case 'SKILL.md:missing':
        return t(
          'settings.agent.importSkillErrNoSkillMd',
          'missing SKILL.md file in folder',
        )
      case 'frontmatter:missing or invalid':
        return t(
          'settings.agent.importSkillErrNoFrontmatter',
          'missing metadata header (---) at the top of the file',
        )
      case 'name:missing':
        return t(
          'settings.agent.importSkillErrNoName',
          'missing "name" field in metadata',
        )
      case 'name:exceeds 64 characters':
        return t(
          'settings.agent.importSkillErrNameTooLong',
          '"name" is too long (max 64 characters)',
        )
      case 'name:uppercase not allowed':
        return t(
          'settings.agent.importSkillErrNameUppercase',
          '"name" must be all lowercase',
        )
      case 'name:cannot start or end with hyphen':
        return t(
          'settings.agent.importSkillErrNameHyphenEdge',
          '"name" cannot start or end with a hyphen',
        )
      case 'name:consecutive hyphens not allowed':
        return t(
          'settings.agent.importSkillErrNameDoubleHyphen',
          '"name" cannot contain consecutive hyphens (--)',
        )
      case 'name:only lowercase letters, numbers, and hyphens allowed':
        return t(
          'settings.agent.importSkillErrNameInvalidChars',
          '"name" can only contain lowercase letters, numbers, and hyphens',
        )
      case 'name:must match folder name':
        return t(
          'settings.agent.importSkillErrNameMismatch',
          '"name" must match the folder name',
        )
      case 'description:missing':
        return t(
          'settings.agent.importSkillErrNoDescription',
          'missing "description" field in metadata',
        )
      case 'description:exceeds 1024 characters':
        return t(
          'settings.agent.importSkillErrDescTooLong',
          '"description" is too long (max 1024 characters)',
        )
      case 'compatibility:exceeds 500 characters':
        return t(
          'settings.agent.importSkillErrCompatTooLong',
          '"compatibility" is too long (max 500 characters)',
        )
      default:
        return `${err.field}: ${err.message}`
    }
  })

  const header = t(
    'settings.agent.importSkillErrHeader',
    '"{name}" cannot be imported:',
  ).replace('{name}', sourceName)

  return `${header}\n${reasons.map((r) => `• ${r}`).join('\n')}`
}
