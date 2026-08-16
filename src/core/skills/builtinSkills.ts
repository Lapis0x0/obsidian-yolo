import { getSnippetsPathAwareTemplate } from '../snippets/templates'

import obsidianCliSource from './builtin/obsidian-cli/SKILL.md'
import obsidianOutputFormatSource from './builtin/obsidian-output-format/SKILL.md'
import skillCreatorSource from './builtin/skill-creator/SKILL.md'
import snippetCreatorSource from './builtin/snippet-creator/SKILL.md'
import { parseFrontmatter } from './skillValidation'
import { getSkillsPathAwareTemplate } from './templates'

type BuiltinLiteSkill = {
  /** Canonical identifier (kebab-case). Doubles as the human-facing label. */
  name: string
  description: string
  mode: 'always' | 'lazy'
  path: string
  content: string
}

/**
 * Built-in skills are authored as real `SKILL.md` files under `builtin/`, in the
 * same shape as vault and module skills. Their frontmatter is the single source
 * of metadata truth — nothing here re-declares name/description/mode.
 */
const BUILTIN_SKILL_SOURCES: string[] = [
  obsidianOutputFormatSource,
  skillCreatorSource,
  snippetCreatorSource,
  obsidianCliSource,
]

const readStringField = (
  frontmatter: Record<string, unknown>,
  field: string,
): string => {
  const value = frontmatter[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Builtin skill frontmatter is missing "${field}"`)
  }
  return value
}

const parseBuiltinSkill = (content: string): BuiltinLiteSkill => {
  const frontmatter = parseFrontmatter(content)
  if (!frontmatter) {
    throw new Error('Builtin skill is missing valid frontmatter')
  }

  const name = readStringField(frontmatter, 'name')
  const mode = readStringField(frontmatter, 'mode')
  if (mode !== 'always' && mode !== 'lazy') {
    throw new Error(`Builtin skill "${name}" has an invalid mode: ${mode}`)
  }

  return {
    name,
    description: readStringField(frontmatter, 'description'),
    mode,
    path: `builtin://skills/${name}.md`,
    content,
  }
}

/**
 * Throws if two builtins claim the same `name`. Names come from frontmatter,
 * so nothing structural prevents a collision, and every lookup here is a
 * `find` that would silently serve the first match while the other builtin
 * vanished. Same reasoning as `assertNoDuplicates` in `core/tools/registry.ts`
 * — and exported for the same reason: the real sources never collide, so this
 * is the only way to exercise the branch.
 */
export const assertNoDuplicateBuiltinSkillNames = (
  names: readonly string[],
): void => {
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(`Duplicate builtin skill name: "${name}"`)
    }
    seen.add(name)
  }
}

let cachedBuiltinSkills: BuiltinLiteSkill[] | null = null

/**
 * Parsed on first use, not at module load: `parseFrontmatter` calls into
 * Obsidian's YAML API, and importing this module must stay side-effect free.
 */
const getBuiltinSkills = (): BuiltinLiteSkill[] => {
  if (!cachedBuiltinSkills) {
    const skills = BUILTIN_SKILL_SOURCES.map(parseBuiltinSkill)
    assertNoDuplicateBuiltinSkillNames(skills.map((skill) => skill.name))
    cachedBuiltinSkills = skills
  }
  return cachedBuiltinSkills
}

/**
 * Rewrite the host-managed paths a builtin body may reference. Both
 * substitutions apply to every builtin: a body that does not mention the token
 * is left untouched, so adding a builtin never means editing this function.
 */
const renderBuiltinContent = (
  skill: BuiltinLiteSkill,
  options?: { skillsDir?: string; snippetsPath?: string },
): string => {
  return getSnippetsPathAwareTemplate(
    getSkillsPathAwareTemplate(skill.content, options?.skillsDir),
    options?.snippetsPath,
  )
}

export const listBuiltinLiteSkills = (options?: {
  skillsDir?: string
  snippetsPath?: string
}): BuiltinLiteSkill[] => {
  return getBuiltinSkills().map((skill) => ({
    ...skill,
    content: renderBuiltinContent(skill, options),
  }))
}

export const getBuiltinLiteSkillByName = ({
  name,
  skillsDir,
  snippetsPath,
}: {
  name?: string
  skillsDir?: string
  snippetsPath?: string
}): BuiltinLiteSkill | null => {
  const targetName = name?.trim()
  if (!targetName) {
    return null
  }

  // Case-sensitive exact match — consistent with the vault resolver in
  // liteSkills.ts (trim only, no lowercasing/slugify).
  const matched = getBuiltinSkills().find((skill) => skill.name === targetName)

  if (!matched) {
    return null
  }

  return {
    ...matched,
    content: renderBuiltinContent(matched, { skillsDir, snippetsPath }),
  }
}
