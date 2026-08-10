/** Skill Markdown parsing and minimum import validation. */

import { parseYaml } from 'obsidian'

export type ValidationError = {
  field: string
  message: string
}

export function validateSkillName(name: unknown): ValidationError[] {
  if (typeof name !== 'string' || name.trim().length === 0) {
    return [{ field: 'name', message: 'missing' }]
  }
  return []
}

// ---------------------------------------------------------------------------
// Frontmatter 解析(使用 Obsidian parseYaml)
// ---------------------------------------------------------------------------

/**
 * 从 Markdown 内容中解析 YAML frontmatter。
 * closing `---` 必须独占一行,避免 YAML 值中含 `---` 被误截断。
 * 返回 null 表示没有合法 frontmatter(缺失分隔符 / YAML 语法错误 / 非 object 顶层)。
 */
export function parseFrontmatter(
  content: string,
): Record<string, unknown> | null {
  // 用按行切分定位 closing delimiter,确保 `---` 是独立一行
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n') && normalized !== '---') {
    return null
  }
  const lines = normalized.split('\n')
  if (lines[0].trim() !== '---') return null
  const endIdx = lines.findIndex(
    (line, idx) => idx >= 1 && line.trim() === '---',
  )
  if (endIdx === -1) return null
  const yamlText = lines.slice(1, endIdx).join('\n')
  try {
    const parsed: unknown = parseYaml(yamlText)
    if (parsed === null || parsed === undefined) return {}
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 包级别校验
// ---------------------------------------------------------------------------

export type FileEntry = {
  relativePath: string
  /** Text content for SKILL.md and text-only remote inputs. */
  content?: string
  /** Exact bytes for package resources that must not be text-decoded. */
  data?: ArrayBuffer
}

/** Validate only the fields YOLO needs to load a directory skill package. */
export function validateDirectoryPackage(
  _dirName: string,
  files: FileEntry[],
): ValidationError[] {
  const errors: ValidationError[] = []

  // 1. 必须包含 SKILL.md
  const skillMdEntry = files.find((f) => f.relativePath === 'SKILL.md')
  if (!skillMdEntry) {
    errors.push({ field: 'SKILL.md', message: 'missing' })
    return errors
  }
  if (typeof skillMdEntry.content !== 'string') {
    errors.push({ field: 'SKILL.md', message: 'must be text' })
    return errors
  }

  // 2. SKILL.md 必须包含有效的 frontmatter
  const frontmatter = parseFrontmatter(skillMdEntry.content)
  if (!frontmatter) {
    errors.push({ field: 'frontmatter', message: 'missing or invalid' })
    return errors
  }

  return validateSkillName(frontmatter.name)
}

/** Validate only the fields YOLO needs to load a single-file skill. */
export function validateSingleFileSkill(content: string): ValidationError[] {
  const frontmatter = parseFrontmatter(content)
  if (!frontmatter) {
    return [{ field: 'frontmatter', message: 'missing or invalid' }]
  }

  return validateSkillName(frontmatter.name)
}
