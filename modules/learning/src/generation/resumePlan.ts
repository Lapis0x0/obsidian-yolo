import {
  chapterKnowledgeFrontmatterSchema,
  projectFrontmatterSchema,
} from '../domain/frontmatter-schema'
import {
  type LearningVaultReadApi,
  normalizeLearningVaultPath,
} from '../domain/learningVaultReadApi'
import type { LearningVaultWriteApi } from '../domain/learningVaultWriteApi'
import { scanMarkdownEntries } from '../domain/markdownScanner'
import { parseFrontmatterBlock } from '../domain/projectScanner'

import { hasResumableCardsFile } from './cardGenerator'
import type { ChapterWriteTarget } from './projectWriter'
import type { ChapterKnowledgePoint } from './serialChapterEngine'

/**
 * A chapter's generation state as derived from what is actually on disk:
 *
 * - `complete` — nothing to do (knowledge done, and cards done or not needed).
 * - `cards-missing` — knowledge is done (`complete: true` in knowledge.md's
 *   frontmatter) but cards.md is absent or still the empty shell.
 * - `needs-generation` — knowledge never finished. This covers both an
 *   untouched chapter and one interrupted mid-run with partial knowledge
 *   points on disk; either way it must be reset to its baseline and rerun
 *   from scratch, because there is no ground truth for exactly how many
 *   knowledge points a partial run was supposed to produce.
 */
export type ChapterResumeState =
  | 'complete'
  | 'cards-missing'
  | 'needs-generation'

export type ChapterResumePlan = {
  chapterIndex: number
  chapterTitle: string
  chapterContract: string
  target: ChapterWriteTarget
  state: ChapterResumeState
  /** Knowledge points already on disk; populated whenever state !== 'needs-generation'. */
  existingKnowledgePoints: ChapterKnowledgePoint[]
}

export type ProjectResumePlan = {
  projectPath: string
  topic: string
  goal: string
  level: string
  outputLanguage: string
  chapters: ChapterResumePlan[]
  referenceDir?: string
}

/**
 * Thrown when a project cannot be resumed automatically — either it predates
 * resume support (missing persisted level/outputLanguage/contract) or its
 * on-disk shape doesn't match what generation itself would have produced.
 * Callers must surface this as a clear "can't resume" message, not a crash.
 */
export class LearningProjectResumeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LearningProjectResumeUnavailableError'
  }
}

/**
 * Reconstructs everything a resumed generation run needs — the original
 * inputs (level, output language, per-chapter contracts) and each chapter's
 * resume state — purely from what is already written to the vault.
 */
export async function buildProjectResumePlan({
  vault,
  vaultWriter,
  projectPath,
  generateCards,
}: {
  vault: LearningVaultReadApi
  vaultWriter: LearningVaultWriteApi
  projectPath: string
  generateCards: boolean
}): Promise<ProjectResumePlan> {
  const normalizedProjectPath = normalizeLearningVaultPath(projectPath)
  const indexPath = `${normalizedProjectPath}/index.md`
  if (vault.getEntry(indexPath)?.kind !== 'file') {
    throw new LearningProjectResumeUnavailableError(
      `Project index not found: ${indexPath}`,
    )
  }
  const parsedIndex = projectFrontmatterSchema.safeParse(
    parseFrontmatterBlock(await vault.readText(indexPath)),
  )
  if (!parsedIndex.success) {
    throw new LearningProjectResumeUnavailableError(
      `Project index is not a valid Learning project: ${indexPath}`,
    )
  }
  const {
    topic,
    goal,
    level,
    outputLanguage,
    chapters: chapterSlugs,
  } = parsedIndex.data
  if (!level || !outputLanguage || !chapterSlugs?.length) {
    throw new LearningProjectResumeUnavailableError(
      'This project was created before generation resume was supported ' +
        '(missing level, output language, or chapter order) and cannot be ' +
        'resumed automatically.',
    )
  }

  const chapters: ChapterResumePlan[] = []
  for (
    let chapterIndex = 0;
    chapterIndex < chapterSlugs.length;
    chapterIndex += 1
  ) {
    chapters.push(
      await buildChapterResumePlan({
        vault,
        vaultWriter,
        normalizedProjectPath,
        chapterSlug: chapterSlugs[chapterIndex],
        chapterIndex,
        generateCards,
      }),
    )
  }

  const referenceDir = `${normalizedProjectPath}/ref`
  const hasReferenceDir = vault.getEntry(referenceDir)?.kind === 'folder'

  return {
    projectPath: normalizedProjectPath,
    topic,
    goal,
    level,
    outputLanguage,
    chapters,
    ...(hasReferenceDir ? { referenceDir } : {}),
  }
}

async function buildChapterResumePlan({
  vault,
  vaultWriter,
  normalizedProjectPath,
  chapterSlug,
  chapterIndex,
  generateCards,
}: {
  vault: LearningVaultReadApi
  vaultWriter: LearningVaultWriteApi
  normalizedProjectPath: string
  chapterSlug: string
  chapterIndex: number
  generateCards: boolean
}): Promise<ChapterResumePlan> {
  const chapterPath = `${normalizedProjectPath}/${chapterSlug}`
  const knowledgePath = `${chapterPath}/knowledge.md`
  const cardsPath = `${chapterPath}/cards.md`
  if (vault.getEntry(knowledgePath)?.kind !== 'file') {
    throw new LearningProjectResumeUnavailableError(
      `Chapter knowledge file not found, cannot resume: ${knowledgePath}`,
    )
  }
  const knowledgeContent = await vault.readText(knowledgePath)
  const parsedKnowledge = chapterKnowledgeFrontmatterSchema.safeParse(
    parseFrontmatterBlock(knowledgeContent),
  )
  if (!parsedKnowledge.success || parsedKnowledge.data.contract === undefined) {
    throw new LearningProjectResumeUnavailableError(
      `Chapter is missing its persisted generation contract, cannot resume: ${knowledgePath}`,
    )
  }
  const { title: chapterTitle, contract, complete } = parsedKnowledge.data
  const knowledgeComplete = complete === true

  const existingKnowledgePoints: ChapterKnowledgePoint[] = knowledgeComplete
    ? scanMarkdownEntries(knowledgeContent)
        .filter((entry) => entry.type === 'kp' && entry.uuid)
        .map((entry) => ({ uuid: entry.uuid, title: entry.title }))
    : []

  let state: ChapterResumeState
  if (!knowledgeComplete) {
    state = 'needs-generation'
  } else if (!generateCards) {
    state = 'complete'
  } else {
    const hasCards = await hasResumableCardsFile(
      { vault, vaultWriter },
      cardsPath,
      chapterTitle,
    )
    state = hasCards ? 'complete' : 'cards-missing'
  }

  return {
    chapterIndex,
    chapterTitle,
    chapterContract: contract,
    target: {
      chapterIndex,
      chapterTitle,
      chapterSlug,
      chapterPath,
      knowledgePath,
      cardsPath,
    },
    state,
    existingKnowledgePoints,
  }
}

/** True when every chapter in the plan is fully generated — nothing to resume. */
export function isProjectResumePlanFullyGenerated(
  plan: ProjectResumePlan,
): boolean {
  return plan.chapters.every((chapter) => chapter.state === 'complete')
}
