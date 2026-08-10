import { dump as dumpYaml } from 'js-yaml'
import { v4 as uuidv4 } from 'uuid'

import {
  type LearningVaultReadApi,
  normalizeLearningVaultPath,
} from '../domain/learningVaultReadApi'
import type { LearningVaultWriteApi } from '../domain/learningVaultWriteApi'

import { createUniqueSlug } from './slug'
import type {
  ChapterGenerationResult,
  KnowledgePointDraft,
  OutlineChapter,
} from './types'

export type ProjectScaffold = {
  projectPath: string
  projectSlug: string
  indexPath: string
  chapters: ChapterWriteTarget[]
}

export type ChapterWriteTarget = {
  chapterIndex: number
  chapterTitle: string
  chapterSlug: string
  chapterPath: string
  knowledgePath: string
  cardsPath: string
}

export type WrittenKnowledgePoint = {
  id: string
  projectId: string
  chapterId: string
  uuid: string
  title: string
  knowledgeFilePath: string
  relations: []
  hasCards: false
  hasExercises: false
  mtime: number
}

export async function createProjectScaffold({
  writer,
  baseDir,
  topic,
  goal,
  level,
  outputLanguage,
  chapters,
}: {
  writer: LearningVaultWriteApi
  baseDir: string
  topic: string
  goal: string
  /** Persisted alongside the project so an interrupted run can be resumed. */
  level: string
  outputLanguage: string
  chapters: OutlineChapter[]
}): Promise<ProjectScaffold> {
  const normalizedBaseDir = normalizeLearningVaultPath(baseDir)
  await writer.ensureFolder(normalizedBaseDir)
  const projectSlug = createUniqueSlug(
    topic,
    await writer.listChildNames(normalizedBaseDir),
  )
  const projectPath = joinVaultPath(normalizedBaseDir, projectSlug)
  await writer.ensureFolder(projectPath)
  const chapterSlugs: string[] = []
  const targets: ChapterWriteTarget[] = []
  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i]
    const chapterSlug = createUniqueSlug(
      `${String(i + 1).padStart(2, '0')}-${chapter.title}`,
      chapterSlugs,
    )
    chapterSlugs.push(chapterSlug)
    const chapterPath = joinVaultPath(projectPath, chapterSlug)
    const knowledgePath = joinVaultPath(chapterPath, 'knowledge.md')
    const cardsPath = joinVaultPath(chapterPath, 'cards.md')
    await writer.ensureFolder(chapterPath)
    await writer.createText(
      knowledgePath,
      buildChapterKnowledgeBaseline({
        title: chapter.title,
        contract: chapter.contract,
      }),
    )
    targets.push({
      chapterIndex: i,
      chapterTitle: chapter.title,
      chapterSlug,
      chapterPath,
      knowledgePath,
      cardsPath,
    })
  }
  const indexPath = joinVaultPath(projectPath, 'index.md')
  await writer.createText(
    indexPath,
    buildProjectIndexMarkdown({
      topic,
      goal,
      status: 'building',
      chapterSlugs,
      level,
      outputLanguage,
      chapters: chapters.map((chapter, index) => ({
        chapterTitle: chapter.title,
        chapterIndex: index,
        knowledgePoints: [],
      })),
    }),
  )
  return { projectPath, projectSlug, indexPath, chapters: targets }
}

/**
 * The pristine content of a chapter's `knowledge.md` before any knowledge
 * point has been emitted: frontmatter only (title, generation contract, and
 * a `complete: false` marker), empty body. Used both to scaffold a new
 * chapter and to reset a chapter with leftover partial content before a
 * resumed generation reruns its knowledge stage from scratch.
 */
export function buildChapterKnowledgeBaseline({
  title,
  contract,
}: {
  title: string
  contract: string
}): string {
  return buildMarkdown({ title, contract, complete: false }, '')
}

/**
 * Marks a chapter's knowledge stage as finished by flipping the `complete`
 * frontmatter flag written by {@link buildChapterKnowledgeBaseline}. This is
 * the ground-truth signal generation resume uses to tell "interrupted
 * mid-run" apart from "knowledge done, cards still missing" — both can leave
 * knowledge.md with knowledge-point content on disk.
 */
export async function markChapterKnowledgeComplete({
  vault,
  writer,
  knowledgePath,
}: {
  vault: LearningVaultReadApi
  writer: LearningVaultWriteApi
  knowledgePath: string
}): Promise<void> {
  if (vault.getEntry(knowledgePath)?.kind !== 'file') {
    throw new Error(`Knowledge file not found: ${knowledgePath}`)
  }
  const existing = await vault.readText(knowledgePath)
  const updated = existing.replace(/^complete: false$/m, 'complete: true')
  if (updated !== existing) await writer.writeText(knowledgePath, updated)
}

export async function appendKnowledgePointDraft({
  vault,
  writer,
  projectPath,
  chapter,
  point,
  uuid = createKnowledgePointUuid(),
}: {
  vault: LearningVaultReadApi
  writer: LearningVaultWriteApi
  projectPath: string
  chapter: ChapterWriteTarget
  point: KnowledgePointDraft
  uuid?: string
}): Promise<WrittenKnowledgePoint> {
  if (vault.getEntry(chapter.knowledgePath)?.kind !== 'file') {
    throw new Error(`Knowledge file not found: ${chapter.knowledgePath}`)
  }
  const existing = await vault.readText(chapter.knowledgePath)
  const block = `## ${point.title} <!--kp:${uuid}-->\n\n${point.body.trim()}`
  const written = await writer.writeText(
    chapter.knowledgePath,
    `${existing.trimEnd()}\n\n${block}\n`,
  )
  return {
    id: `${chapter.chapterPath}/${uuid}`,
    projectId: projectPath,
    chapterId: chapter.chapterPath,
    uuid,
    title: point.title,
    knowledgeFilePath: chapter.knowledgePath,
    relations: [],
    hasCards: false,
    hasExercises: false,
    mtime: written.mtime,
  }
}

export function createKnowledgePointUuid(): string {
  return uuidv4().replace(/-/g, '').slice(0, 8)
}

export async function markProjectStudying({
  vault,
  writer,
  indexPath,
}: {
  vault: LearningVaultReadApi
  writer: LearningVaultWriteApi
  indexPath: string
}): Promise<void> {
  if (vault.getEntry(indexPath)?.kind !== 'file') {
    throw new Error(`Project index not found: ${indexPath}`)
  }
  const existing = await vault.readText(indexPath)
  await writer.writeText(
    indexPath,
    existing.replace(/^status: building$/m, 'status: studying'),
  )
}

const joinVaultPath = (...parts: string[]) =>
  normalizeLearningVaultPath(parts.join('/'))

function buildMarkdown(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yaml = dumpYaml(frontmatter, { lineWidth: -1 }).trimEnd()
  return `---\n${yaml}\n---\n\n${body.trim()}\n`
}

function buildProjectIndexMarkdown({
  topic,
  goal,
  status,
  chapterSlugs,
  chapters,
  level,
  outputLanguage,
}: {
  topic: string
  goal: string
  status: 'building' | 'studying'
  chapterSlugs: string[]
  chapters: Array<Pick<ChapterGenerationResult, 'chapterTitle'>>
  /** Persisted only when known, so a resumed generation can rebuild its inputs. */
  level?: string
  outputLanguage?: string
}): string {
  return buildMarkdown(
    {
      topic,
      goal,
      status,
      chapters: chapterSlugs,
      ...(level ? { level } : {}),
      ...(outputLanguage ? { outputLanguage } : {}),
    },
    chapters
      .map(
        (chapter, index) =>
          `${index + 1}. [[${chapterSlugs[index]}/knowledge|${chapter.chapterTitle}]]`,
      )
      .join('\n'),
  )
}
