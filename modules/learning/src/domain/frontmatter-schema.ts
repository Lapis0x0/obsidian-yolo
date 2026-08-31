import { z } from 'zod'

import { Relation, RelationType } from './types'

/**
 * Frontmatter schemas for learning-mode markdown files.
 *
 * Conventions (agent must respect these):
 * - Knowledge point IDs are derived from chapter path + UUID comments in
 *   chapter-level markdown files, NOT written into frontmatter.
 * - Titles are written in frontmatter, NOT derived from filenames. Filenames
 *   are slugs and may be transliterated.
 */

export const RELATION_TYPES: ReadonlyArray<RelationType> = [
  'prereq',
  'parent',
  'related',
]

const relationSchema = z.object({
  target: z.string().min(1),
  type: z.enum(['prereq', 'parent', 'related']).default('related'),
  label: z.string().optional(),
})

export const projectFrontmatterSchema = z.object({
  kind: z.enum(['outline', 'cards']).default('outline'),
  topic: z.string().min(1),
  goal: z.string().min(1),
  status: z
    .enum(['outlining', 'building', 'studying'])
    .default('outlining')
    .optional(),
  /** Optional ordered list of chapter slugs. If omitted, derived from folder order. */
  chapters: z.array(z.string()).optional(),
  /**
   * The level and output language the generation run was started with.
   * Persisted so an interrupted generation can be resumed after Obsidian
   * restarts. Absent on projects created before resume support existed —
   * such projects cannot be resumed automatically.
   */
  level: z.string().min(1).optional(),
  outputLanguage: z.string().min(1).optional(),
})

export const chapterKnowledgeFrontmatterSchema = z.object({
  title: z.string().min(1),
  /**
   * The chapter's generation contract, persisted so a resumed generation run
   * can rebuild the full-outline context the knowledge-point prompt needs.
   * Absent on chapters created before resume support existed.
   */
  contract: z.string().optional(),
  /**
   * Whether this chapter's knowledge-point stage has finished. Used by
   * resume to tell "interrupted mid-run" apart from "knowledge done, cards
   * still missing" without guessing from content alone.
   */
  complete: z.boolean().optional(),
})

export const chapterCardsFrontmatterSchema = z.object({
  title: z.string().min(1),
})

export const chapterExercisesFrontmatterSchema = z.object({
  title: z.string().min(1),
})

export const chapterFrontmatterSchema = z.object({
  title: z.string().min(1).optional(),
})

export type ProjectFrontmatter = z.infer<typeof projectFrontmatterSchema>
export type ChapterKnowledgeFrontmatter = z.infer<
  typeof chapterKnowledgeFrontmatterSchema
>
export type ChapterCardsFrontmatter = z.infer<
  typeof chapterCardsFrontmatterSchema
>
export type ChapterExercisesFrontmatter = z.infer<
  typeof chapterExercisesFrontmatterSchema
>
export type ChapterFrontmatter = z.infer<typeof chapterFrontmatterSchema>

export function parseRelationsFromFrontmatter(
  raw: unknown,
  resolveTargetId: (rawTarget: string) => string | null,
): Relation[] {
  if (!Array.isArray(raw)) return []
  const relations: Relation[] = []
  for (const entry of raw) {
    const parsed = relationSchema.safeParse(entry)
    if (!parsed.success) continue
    const targetId = resolveTargetId(parsed.data.target)
    if (!targetId) continue
    relations.push({
      targetId,
      type: parsed.data.type,
      ...(parsed.data.label ? { label: parsed.data.label } : {}),
    })
  }
  return relations
}
