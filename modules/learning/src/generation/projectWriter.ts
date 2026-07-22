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

export type WriteProjectOptions = {
  writer: LearningVaultWriteApi
  baseDir: string
  topic: string
  goal: string
  chapters: ChapterGenerationResult[]
  level: string
}

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
  chapters,
}: {
  writer: LearningVaultWriteApi
  baseDir: string
  topic: string
  goal: string
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
      buildMarkdown({ title: chapter.title }, ''),
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
      chapters: chapters.map((chapter, index) => ({
        chapterTitle: chapter.title,
        chapterIndex: index,
        knowledgePoints: [],
      })),
    }),
  )
  return { projectPath, projectSlug, indexPath, chapters: targets }
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

export async function writeProject({
  writer,
  baseDir,
  topic,
  goal,
  chapters,
}: WriteProjectOptions): Promise<{ projectPath: string; projectSlug: string }> {
  const normalizedBaseDir = normalizeLearningVaultPath(baseDir)
  await writer.ensureFolder(normalizedBaseDir)
  const projectSlug = createUniqueSlug(
    topic,
    await writer.listChildNames(normalizedBaseDir),
  )
  const projectPath = joinVaultPath(normalizedBaseDir, projectSlug)
  await writer.ensureFolder(projectPath)
  const successful = chapters.filter((chapter) => !chapter.error)
  const chapterSlugs: string[] = []
  for (let i = 0; i < successful.length; i += 1) {
    const chapter = successful[i]
    const chapterNumber = String(i + 1).padStart(2, '0')
    const orderedTitle = `${chapterNumber}-${chapter.chapterTitle}`
    chapterSlugs.push(createUniqueSlug(orderedTitle, chapterSlugs))
  }
  await writer.createText(
    joinVaultPath(projectPath, 'index.md'),
    buildProjectIndexMarkdown({
      topic,
      goal,
      status: 'studying',
      chapterSlugs,
      chapters: successful,
    }),
  )
  for (let i = 0; i < successful.length; i += 1) {
    const chapterPath = joinVaultPath(projectPath, chapterSlugs[i])
    await writer.ensureFolder(chapterPath)
    await writer.createText(
      joinVaultPath(chapterPath, 'knowledge.md'),
      buildMarkdown(
        { title: successful[i].chapterTitle },
        buildKnowledgeBody(successful[i].knowledgePoints),
      ),
    )
  }
  return { projectPath, projectSlug }
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
}: {
  topic: string
  goal: string
  status: 'building' | 'studying'
  chapterSlugs: string[]
  chapters: Array<Pick<ChapterGenerationResult, 'chapterTitle'>>
}): string {
  return buildMarkdown(
    { topic, goal, status, chapters: chapterSlugs },
    chapters
      .map(
        (chapter, index) =>
          `${index + 1}. [[${chapterSlugs[index]}/knowledge|${chapter.chapterTitle}]]`,
      )
      .join('\n'),
  )
}

function buildKnowledgeBody(points: KnowledgePointDraft[]): string {
  return points
    .map(
      (point) =>
        `## ${point.title} <!--kp:${createKnowledgePointUuid()}-->\n\n${point.body.trim()}`,
    )
    .join('\n\n')
}
