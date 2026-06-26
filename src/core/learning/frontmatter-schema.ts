import { z } from 'zod'

import { Relation, RelationType } from './types'

/**
 * Frontmatter schemas for learning-mode markdown files.
 *
 * Conventions (agent must respect these):
 * - All IDs are vault-path based ("project/chapter/knowledgePoint") and are
 *   derived at scan time, NOT written into frontmatter. Frontmatter only
 *   stores values the agent / user authored.
 * - Titles are written in frontmatter, NOT derived from filenames. Filenames
 *   are slugs and may be transliterated.
 * - `relations[].target` is a vault-relative path to the target knowledge
 *   point folder (e.g. `chapter-1-slug/kp-3-slug`). Using paths keeps the
 *   markdown human-readable and survives renames as long as we rewrite on
 *   rename.
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
  topic: z.string().min(1),
  status: z
    .enum(['outlining', 'building', 'studying'])
    .default('outlining')
    .optional(),
  /** Optional ordered list of chapter slugs. If omitted, derived from folder order. */
  chapters: z.array(z.string()).optional(),
})

export const knowledgePointFrontmatterSchema = z.object({
  title: z.string().min(1),
  relations: z.array(relationSchema).default([]).optional(),
})

export const chapterFrontmatterSchema = z.object({
  title: z.string().min(1).optional(),
})

export type ProjectFrontmatter = z.infer<typeof projectFrontmatterSchema>
export type KnowledgePointFrontmatter = z.infer<
  typeof knowledgePointFrontmatterSchema
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
